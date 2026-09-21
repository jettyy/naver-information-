import fs from 'node:fs';
import path from 'node:path';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';
import { SHOT_DIR, ensureDirs } from '../lib/paths.js';
import { getChatGptContext, openNormalChat } from './browser.js';
import { SELECTORS, looksLikeGeneratedImage } from './selectors.js';

/**
 * 구독 중인 ChatGPT 에서 썸네일 그림을 받아온다.
 *
 * 이미지 생성 API 를 따로 붙이면 장당 돈이 든다. 이미 ChatGPT 를 구독하고
 * 있다면 그 안에서 그리게 하고 그림만 가져오는 편이 낫다. 네이버에 글을
 * 올릴 때와 같은 방식이다 — 사람이 한 번 로그인해 두면 그 세션으로 브라우저가
 * 대신 눌러 준다.
 *
 * **임시 채팅이 아니라 일반 대화에서 만든다.** 임시 채팅으로 만든 그림은
 * 대화 기록에 남지 않아 나중에 다시 꺼내 볼 수 없다. 이 모듈은 항상
 * 새 일반 대화를 열고, 임시 채팅이면 끄고 다시 연다. (browser.js 의
 * openNormalChat 참고)
 */

/** 한 줄로 만든다. 여러 줄을 그대로 넣으면 중간에 전송되는 일이 있다. */
export function flattenPrompt(text) {
  return String(text ?? '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 그림을 그려 달라고 시키는 말.
 *
 * 프롬프트 본문(영어)은 구글 API 에 보내던 것을 그대로 쓴다. 앞에 붙는
 * 한국어 지시는 ChatGPT 가 그림 대신 설명을 늘어놓지 않게 하는 용도다.
 */
export function buildChatPrompt(imagePrompt, aspectRatio) {
  const ratio = /^\d+:\d+$/.test(String(aspectRatio || '')) ? aspectRatio : '16:9';
  return flattenPrompt(
    `다음 설명대로 이미지를 ${ratio} 가로 비율로 한 장만 그려 주세요. `
    + '설명이나 질문은 하지 말고 그림만 만들어 주세요. '
    + `--- ${imagePrompt}`,
  );
}

/** 화면을 찍어 둔다. 자동화가 깨졌을 때 이게 유일한 단서다. */
async function snap(page, jobId, tag) {
  if (!getSettings().run.screenshotOnError) return '';
  try {
    ensureDirs();
    const file = path.join(SHOT_DIR, `chatgpt-${tag}-${jobId || 'x'}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return '';
  }
}

/** 입력창에 글을 넣는다. contenteditable 이라 fill 이 안 먹는다. */
export async function typePrompt(page, text) {
  let composer = null;
  for (const selector of SELECTORS.composer) {
    const candidate = page.locator(selector).first();
    if (await candidate.isVisible({ timeout: 3000 }).catch(() => false)) {
      composer = candidate;
      break;
    }
  }
  if (!composer) throw new Error('ChatGPT 입력창을 찾지 못했습니다.');

  await composer.click({ timeout: 10000 });
  // insertText 는 키 이벤트를 만들지 않아서 중간에 전송되지 않는다.
  await page.keyboard.insertText(text);
  await page.waitForTimeout(400);

  for (const selector of SELECTORS.send) {
    const button = page.locator(selector).first();
    if (await button.isEnabled({ timeout: 1500 }).catch(() => false)) {
      await button.click({ timeout: 5000 }).catch(() => {});
      return;
    }
  }
  // 보내기 버튼을 못 잡으면 엔터로 보낸다.
  await page.keyboard.press('Enter');
}

/**
 * 화면에 있는 모든 <img> 를 재 본다.
 *
 * 처음에는 "주소가 oaiusercontent 면 생성된 그림" 이라고 **주소만 보고** 골랐다.
 * 그런데 ChatGPT 가 그림을 어느 주소로 내려주는지는 수시로 바뀐다. 목록에 없는
 * 주소가 오면 그림이 화면에 멀쩡히 떠 있는데도 "못 찾았다" 로 끝나서, 결국
 * HTML 썸네일이 올라갔다. 실제로 그 일이 있었다.
 *
 * 그래서 기준을 바꿨다. **크기가 진짜 신호다.**
 * 생성된 그림은 크고(보통 1024px 이상), 아바타와 아이콘은 작다(16~80px).
 * 주소는 이제 "확실하면 가산점" 정도로만 쓴다.
 */
function scoreImage(img) {
  const { src, naturalWidth: nw, naturalHeight: nh, width: rw, height: rh } = img;
  if (!src) return null;

  // 자리표시자와 1px 추적 픽셀.
  if (/^data:image\/(gif|svg)/i.test(src)) return null;

  /*
   * 아직 다 안 불러온 그림은 natural 크기가 0 이다. 그때는 화면에 그려진
   * 크기로 본다. 둘 다 작으면 아이콘이다.
   */
  const bigNatural = nw >= 256 && nh >= 200;
  const bigRendered = rw >= 200 && rh >= 150;

  if (!bigNatural && !bigRendered) {
    /*
     * 아직 아무 것도 안 불러온 그림은 크기가 전부 0 이다. 크기로는 판단할 수
     * 없으니 여기서만 주소를 믿는다. 아이콘은 보통 width/height 가 정해져 있어
     * 화면 크기가 0 이 아니라서 여기까지 오지 않는다.
     */
    const sizeUnknown = nw === 0 && nh === 0 && rw < 20 && rh < 20;
    if (!sizeUnknown || !looksLikeGeneratedImage(src)) return null;
    return 100 + (img.inAssistantTurn ? 200 : 0) + img.order;
  }

  let score = 0;
  if (img.inAssistantTurn) score += 1000;        // 답변 안에 있는 그림이 우선
  if (looksLikeGeneratedImage(src)) score += 500; // 아는 주소면 가산점
  if (bigNatural) score += 200;
  score += Math.min(200, Math.round(Math.max(nw, rw) / 10));
  score += img.order;                             // 뒤에 있을수록(최신) 우선
  return score;
}

/** 화면의 모든 <img> 를 크기·위치와 함께 걷어 온다. 진단 로그에도 쓴다. */
export async function collectImages(page) {
  return page.evaluate((selectors) => {
    const assistants = [];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) assistants.push(node);
    }
    const out = [];
    let order = 0;
    for (const img of document.querySelectorAll('img')) {
      const box = img.getBoundingClientRect();
      out.push({
        src: img.currentSrc || img.src || '',
        alt: (img.getAttribute('alt') || '').slice(0, 40),
        naturalWidth: img.naturalWidth || 0,
        naturalHeight: img.naturalHeight || 0,
        width: Math.round(box.width),
        height: Math.round(box.height),
        inAssistantTurn: assistants.some((turn) => turn.contains(img)),
        order: (order += 1),
      });
    }
    return out;
  }, SELECTORS.assistantTurn);
}

/**
 * 방금 만든 그림의 주소를 고른다. 없으면 빈 문자열.
 *
 * @returns {Promise<string>}
 */
export async function findImageUrl(page, { ignore } = {}) {
  const images = await collectImages(page);
  let best = null;
  let bestScore = -1;
  for (const img of images) {
    // 요청을 보내기 **전부터** 화면에 있던 그림은 방금 만든 것이 아니다.
    // (ChatGPT 첫 화면의 큰 장식 그림을 집어 오던 것을 막는다)
    if (ignore?.has(img.src)) continue;
    const score = scoreImage(img);
    if (score === null || score <= bestScore) continue;
    best = img;
    bestScore = score;
  }
  return best?.src || '';
}

/** 못 찾았을 때 로그에 남길 한 줄. 무엇이 화면에 있었는지 보여준다. */
export function describeImages(images) {
  if (!images.length) return '화면에 <img> 가 하나도 없습니다.';
  return images
    .slice(-8)
    .map((img) => `${img.naturalWidth}x${img.naturalHeight}`
      + `(화면 ${img.width}x${img.height})`
      + `${img.inAssistantTurn ? ' 답변안' : ''} ${String(img.src).slice(0, 80)}`)
    .join(' | ');
}

/**
 * 찾은 주소에서 실제 그림 바이트를 받아온다.
 *
 * 한 가지 방법만 쓰면 그 하나가 막혔을 때 그림을 통째로 놓친다.
 * (그러면 HTML 썸네일로 물러서는데, 정작 그림은 화면에 떠 있다)
 * 그래서 세 가지를 차례로 시도한다.
 *
 *   1) 브라우저 세션으로 그 주소를 직접 받는다      — 원본 화질 그대로
 *   2) 페이지 안에서 fetch 로 읽는다                 — 쿠키·CORS 가 필요한 경우
 *   3) 화면에 그려진 그 <img> 를 통째로 찍는다       — 위 둘이 다 막혀도 된다
 *
 * 3번은 화질이 화면에 그려진 크기만큼이라 조금 떨어진다. 그래도 **글자 없는
 * HTML 썸네일로 물러서는 것보다는 낫다.**
 */
export async function downloadImage(page, url) {
  const problems = [];

  // blob: 주소는 서버가 아니라 브라우저 안에만 있다. 페이지 안에서만 읽힌다.
  const isBlob = /^blob:/i.test(url);

  if (!isBlob) {
    try {
      const response = await page.context().request.get(url, { timeout: 60000 });
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      const type = (response.headers()['content-type'] || '').split(';')[0].trim();
      // 로그인이 풀리면 그림 주소로 HTML 로그인 페이지가 온다. 그걸 저장하면 안 된다.
      if (type && !/^image\//i.test(type)) throw new Error(`그림이 아닌 응답 (${type})`);
      const buffer = await response.body();
      // 빈 응답이나 오류 쪽지를 그림으로 착각하지 않을 만큼만 본다.
      // 여기를 높게 잡으면 멀쩡한 그림까지 버리게 된다.
      if (buffer.length < 200) throw new Error(`너무 작습니다 (${buffer.length}바이트)`);
      return `data:${type || 'image/png'};base64,${buffer.toString('base64')}`;
    } catch (error) {
      problems.push(`직접 받기: ${error.message}`);
    }
  }

  try {
    const dataUri = await page.evaluate(async (src) => {
      const response = await fetch(src, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!/^image\//i.test(blob.type || 'image/png')) throw new Error(`그림이 아님 (${blob.type})`);
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result || ''));
        reader.readAsDataURL(blob);
      });
    }, url);
    if (!/^data:image\//i.test(dataUri)) throw new Error('그림 데이터가 아닙니다');
    return dataUri;
  } catch (error) {
    problems.push(`페이지에서 읽기: ${String(error.message).split('\n')[0]}`);
  }

  // 마지막 수단 — 화면에 떠 있는 그 그림을 그대로 찍는다.
  try {
    /*
     * src 속성으로 바로 찾으면 안 되는 경우가 있다. srcset 이 걸려 있으면
     * 실제로 보이는 주소(currentSrc)와 src 속성이 다르기 때문이다.
     * 그래서 페이지 안에서 둘 다 비교해 찾아 표시를 붙이고, 그걸로 집는다.
     */
    const tagged = await page.evaluate((target) => {
      for (const img of document.querySelectorAll('img')) {
        if ((img.currentSrc || img.src) !== target) continue;
        img.setAttribute('data-inforush-shot', '1');
        return true;
      }
      return false;
    }, url);
    if (!tagged) throw new Error('화면에서 그 그림을 못 찾았습니다');

    const shot = await page.locator('img[data-inforush-shot="1"]').first()
      .screenshot({ timeout: 20000 });
    if (shot.length < 1024) throw new Error('찍힌 그림이 너무 작습니다');
    logger.warn('그림을 내려받지 못해 화면에 그려진 것을 찍어서 씁니다. (화질이 조금 떨어집니다)');
    return `data:image/png;base64,${shot.toString('base64')}`;
  } catch (error) {
    problems.push(`화면 찍기: ${String(error.message).split('\n')[0]}`);
  }

  throw new Error(`그림을 가져오지 못했습니다 — ${problems.join(' / ')}`);
}

/**
 * 그림이 다 그려질 때까지 기다린다.
 *
 * ChatGPT 는 그리는 동안 흐릿한 중간 그림을 먼저 보여준다. 그걸 집으면
 * 뭉개진 썸네일이 올라간다. 정지 버튼이 사라지면 다 그린 것이다.
 */
async function waitUntilSettled(page, { timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let running = false;
    for (const selector of SELECTORS.stop) {
      if (await page.locator(selector).first().isVisible({ timeout: 500 }).catch(() => false)) {
        running = true;
        break;
      }
    }
    if (!running) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

/**
 * ChatGPT 에서 그림 한 장을 받아온다.
 *
 * @param {string} imagePrompt 구글 API 에 보내던 것과 같은 영어 프롬프트
 * @returns {Promise<{dataUri: string, model: string, bytes: number}>}
 */
export async function generateViaChatGpt(imagePrompt, {
  aspectRatio = '16:9', jobId = '', signal,
} = {}) {
  const { image } = getSettings();
  const waitMs = Math.max(30000, Number(image.chatgpt?.waitMs) || 300000);

  const ctx = await getChatGptContext();
  const page = await ctx.newPage();

  try {
    await openNormalChat(page);
    const prompt = buildChatPrompt(imagePrompt, aspectRatio);
    logger.step('ChatGPT 에 썸네일 그림을 요청합니다. (새 일반 대화)', { jobId });

    // 보내기 전에 화면에 있던 그림들을 적어 둔다. 이 뒤에 새로 생긴 것이
    // 방금 만든 그림이다. 첫 화면의 장식 그림을 집어 오지 않게 한다.
    const before = new Set((await collectImages(page).catch(() => [])).map((img) => img.src));

    await typePrompt(page, prompt);

    /*
     * 그림이 뜰 때까지 기다린다. 30초에서 몇 분까지 걸린다.
     * "정지 버튼이 사라졌는가" 만 보면 글만 답하고 끝난 경우까지 통과해 버리므로,
     * **그림 주소가 실제로 잡힐 때까지** 본다.
     */
    const deadline = Date.now() + waitMs;
    let url = '';
    let waited = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('사용자가 중지했습니다.');
      url = await findImageUrl(page, { ignore: before }).catch(() => '');
      if (url) break;
      await page.waitForTimeout(2500);
      waited += 2500;
      // 오래 걸릴 때 화면만 보고 있으면 멈춘 건지 그리는 중인지 알 수 없다.
      if (waited % 30000 === 0) {
        logger.info(`ChatGPT 가 아직 그리는 중입니다... (${waited / 1000}초)`, { jobId });
      }
    }

    if (!url) {
      const images = await collectImages(page).catch(() => []);
      const shot = await snap(page, jobId, 'no-image');
      const error = new Error(
        `ChatGPT 가 ${Math.round(waitMs / 1000)}초 안에 그림을 내놓지 않았습니다.`
        + ' (사용량 한도이거나 화면이 바뀌었을 수 있습니다)',
      );
      error.screenshot = shot;
      // 화면에 무엇이 있었는지 남긴다. 이게 없으면 왜 못 찾았는지 알 방법이 없다.
      logger.warn(`그때 화면에 있던 그림들: ${describeImages(images)}`, { jobId });
      throw error;
    }

    // 다 그릴 때까지 기다렸다가 **주소를 다시 본다.**
    // 그리는 중에는 흐릿한 중간 그림이 걸리고, 다 그리면 주소가 바뀐다.
    if (await waitUntilSettled(page)) {
      const settled = await findImageUrl(page, { ignore: before }).catch(() => '');
      if (settled && settled !== url) url = settled;
    }

    let dataUri;
    try {
      dataUri = await downloadImage(page, url);
    } catch (error) {
      error.screenshot = await snap(page, jobId, 'download-failed');
      logger.warn(`그림 주소: ${String(url).slice(0, 120)}`, { jobId });
      throw error;
    }
    const bytes = Math.round((dataUri.length - dataUri.indexOf(',') - 1) * 0.75);
    logger.info(`ChatGPT 에서 썸네일을 받았습니다. (${Math.round(bytes / 1024)}KB)`, { jobId });

    return { dataUri, model: 'chatgpt', bytes, usd: 0 };
  } finally {
    // 대화는 계정에 그대로 남는다. 창만 닫는다.
    await page.close().catch(() => {});
  }
}

/** 설정 화면의 [ChatGPT 썸네일 테스트] 용. 받은 그림을 파일로도 남긴다. */
export async function testChatGptImage(outDir) {
  const result = await generateViaChatGpt(
    'a simple flat vector illustration of a bright desk with a notebook and a coffee cup, '
    + 'soft muted palette, no text, no letters, no words',
    { aspectRatio: '16:9' },
  );
  const match = /^data:image\/([a-z]+);base64,(.+)$/i.exec(result.dataUri);
  if (!match) throw new Error('받은 그림을 읽지 못했습니다.');
  ensureDirs();
  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const fileName = `chatgpt-test-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(outDir, fileName), Buffer.from(match[2], 'base64'));
  return { fileName, bytes: result.bytes };
}
