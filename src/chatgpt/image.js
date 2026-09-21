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
 * 답변에 붙은 **생성된 그림**의 주소를 찾는다.
 *
 * 말풍선 안에는 아바타와 아이콘도 <img> 로 들어 있다. 그것까지 집으면
 * 엉뚱한 그림이 썸네일로 올라가므로 주소로 한 번 거른다.
 */
export async function findImageUrl(page) {
  const sources = await page.evaluate((selectors) => {
    const out = [];
    for (const selector of selectors) {
      for (const turn of document.querySelectorAll(selector)) {
        for (const img of turn.querySelectorAll('img')) {
          const src = img.currentSrc || img.src || '';
          const big = (img.naturalWidth || 0) >= 256 && (img.naturalHeight || 0) >= 256;
          if (src) out.push({ src, big });
        }
      }
    }
    return out;
  }, SELECTORS.assistantTurn);

  /*
   * 뒤에서부터 본다. 마지막 답변에 붙은 것이 방금 만든 그림이다.
   *
   * 뒤집은 목록은 **한 번만** 만든다. reverse() 는 원본을 뒤집어 버리기 때문에,
   * 두 번 부르면 두 번째 훑기는 도로 원래 순서가 된다. 그러면 답변 맨 앞의
   * 작은 아이콘을 썸네일로 집어 온다. (실제로 그랬다)
   */
  const newestFirst = [...sources].reverse();

  // 큰 그림을 먼저 찾는다. 아이콘은 작아서 여기서 걸러진다.
  for (const { src, big } of newestFirst) {
    if (looksLikeGeneratedImage(src) && big) return src;
  }
  // 아직 다 안 불러온 그림은 크기를 알 수 없다. 그때는 주소만 보고 고른다.
  for (const { src } of newestFirst) {
    if (looksLikeGeneratedImage(src)) return src;
  }
  return '';
}

/** 찾은 주소에서 실제 그림 바이트를 받아온다. 로그인 쿠키가 필요하다. */
export async function downloadImage(page, url) {
  // blob: 주소는 서버가 아니라 브라우저 안에만 있다. 페이지 안에서 읽어야 한다.
  if (/^blob:/i.test(url)) {
    const dataUri = await page.evaluate(async (src) => {
      const response = await fetch(src);
      const blob = await response.blob();
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result || ''));
        reader.readAsDataURL(blob);
      });
    }, url);
    if (!/^data:image\//i.test(dataUri)) throw new Error('그림을 읽지 못했습니다.');
    return dataUri;
  }

  // 일반 주소는 브라우저의 세션으로 받는다. 쿠키가 없으면 403 이 온다.
  const response = await page.context().request.get(url, { timeout: 60000 });
  if (!response.ok()) throw new Error(`그림을 내려받지 못했습니다 (HTTP ${response.status()}).`);
  const buffer = await response.body();
  const type = (response.headers()['content-type'] || 'image/png').split(';')[0].trim();
  if (!/^image\//i.test(type)) throw new Error(`그림이 아닌 응답이 왔습니다 (${type}).`);
  return `data:${type};base64,${buffer.toString('base64')}`;
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
    await typePrompt(page, prompt);

    /*
     * 그림이 뜰 때까지 기다린다. 30초에서 몇 분까지 걸린다.
     * "정지 버튼이 사라졌는가" 만 보면 글만 답하고 끝난 경우까지 통과해 버리므로,
     * **그림 주소가 실제로 잡힐 때까지** 본다.
     */
    const deadline = Date.now() + waitMs;
    let url = '';
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('사용자가 중지했습니다.');
      url = await findImageUrl(page).catch(() => '');
      if (url) break;
      await page.waitForTimeout(2500);
    }

    if (!url) {
      const shot = await snap(page, jobId, 'no-image');
      const error = new Error(
        `ChatGPT 가 ${Math.round(waitMs / 1000)}초 안에 그림을 내놓지 않았습니다.`
        + ' (사용량 한도이거나 화면이 바뀌었을 수 있습니다)',
      );
      error.screenshot = shot;
      throw error;
    }

    const dataUri = await downloadImage(page, url);
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
