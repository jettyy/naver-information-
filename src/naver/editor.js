import path from 'node:path';
import { SELECTORS, findFirst, clickIfPresent } from './selectors.js';
import { getContext, hasNaverCookies } from './browser.js';
import { getSettings } from '../lib/settings.js';
import { SHOT_DIR, ensureDirs } from '../lib/paths.js';
import { logger } from '../lib/events.js';
import {
  buildIntroHtml, buildBodyPlan, buildTableChunks, htmlToPlainText, BLOCK_GAP,
} from '../content/naver.js';
import { renderTableImages } from '../content/thumbnail.js';

const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * 에디터가 iframe(#mainFrame) 안에 있을 수도, 페이지 자체일 수도 있다.
 * 못 찾으면 null 을 돌려준다 (주소를 바꿔가며 여러 번 시도하기 위해).
 */
async function findEditorScope(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return null;
    for (const frame of page.frames()) {
      for (const selector of SELECTORS.editorReady) {
        const found = await frame
          .locator(selector)
          .first()
          .isVisible({ timeout: 200 })
          .catch(() => false);
        if (found) return frame;
      }
    }
    await page.waitForTimeout(400).catch(() => {});
  }
  return null;
}

/**
 * 글쓰기 화면을 연다.
 *
 * 저장된 블로그 아이디가 지금 로그인한 계정의 것이 아니면 (계정을 바꿨을 때)
 * ?Redirect=Write 주소는 글쓰기로 가지 않고 그냥 그 블로그 홈을 보여준다.
 * 그래서 주소를 여러 개 시도하고, 그래도 안 되면 블로그 화면의 글쓰기 링크를 누른다.
 */
async function openWriteEditor(page, blogId, jobId) {
  const candidates = [
    `https://blog.naver.com/${blogId}/postwrite`,
    `https://blog.naver.com/${blogId}?Redirect=Write&`,
    `https://blog.naver.com/PostWriteForm.naver?blogId=${blogId}`,
  ];

  for (const url of candidates) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const scope = await findEditorScope(page, 12000);
    if (scope) {
      logger.info(`글쓰기 화면 진입: ${url}`, { jobId });
      return { scope, page };
    }
    logger.warn(`글쓰기 화면이 아닙니다 (${page.url()}). 다음 방법을 시도합니다.`, { jobId });
  }

  // 마지막 수단: 블로그 화면에서 글쓰기 링크를 직접 누른다.
  logger.step('블로그 화면에서 글쓰기 버튼을 찾아 누릅니다.', { jobId });
  await page.goto(`https://blog.naver.com/${blogId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  }).catch(() => {});
  await page.waitForTimeout(1500);

  for (const frame of page.frames()) {
    const clicked = await clickIfPresent(frame, SELECTORS.writeLink, 2000);
    if (!clicked) continue;
    logger.info(`글쓰기 링크를 눌렀습니다 (${clicked})`, { jobId });
    await page.waitForTimeout(2500);

    const scope = await findEditorScope(page, 15000);
    if (scope) return { scope, page };

    // 새 창으로 열렸을 수도 있다.
    for (const candidate of page.context().pages()) {
      if (candidate === page || candidate.isClosed()) continue;
      const popupScope = await findEditorScope(candidate, 8000);
      if (popupScope) {
        logger.info('글쓰기가 새 창으로 열렸습니다.', { jobId });
        return { scope: popupScope, page: candidate };
      }
    }
  }

  throw new Error(
    `글쓰기 화면을 열지 못했습니다. 현재 주소: ${page.url()} — `
    + `블로그 아이디(${blogId})가 지금 로그인한 계정의 것이 맞는지 확인해 주세요. `
    + '계정을 바꾸셨다면 대시보드에서 [세션 확인]을 누르거나 설정에서 아이디를 고쳐주세요.',
  );
}

async function dismissPopups(scope) {
  // "작성 중인 글이 있습니다" -> 취소를 눌러 새 글로 시작한다.
  const cancelled = await clickIfPresent(scope, SELECTORS.draftPopupCancel, 3000);
  if (cancelled) logger.info('이어쓰기 팝업을 닫고 새 글로 시작합니다.');
  await clickIfPresent(scope, SELECTORS.helpPanelClose, 1500);
}

async function typeInto(page, locator, text) {
  await locator.click({ timeout: 10000 });
  await page.waitForTimeout(150);
  try {
    await page.keyboard.insertText(text);     // 한글은 insertText 가 가장 안정적이다.
  } catch {
    await page.keyboard.type(text, { delay: 12 });
  }
}

/**
 * 에디터 안에 들어간 표 개수.
 *
 * 붙여넣기 성공 판정은 "글자가 좀 늘었나" 만 보기 때문에, 표가 통째로
 * 잘려나가도 성공으로 친다. 표는 따로 세어서 실제로 들어갔는지 확인한다.
 */
async function tableCount(scope) {
  return scope
    .evaluate(() => {
      const root = document.querySelector('.se-main-container') || document.body;
      return root.querySelectorAll('table').length;
    })
    .catch(() => 0);
}

async function bodyTextLength(scope) {
  return scope
    .evaluate(() => {
      const root = document.querySelector('.se-main-container') || document.body;
      return (root.innerText || '').length;
    })
    .catch(() => 0);
}

/**
 * 서식을 살려 넣는 유일하게 안정적인 방법이 HTML 붙여넣기다.
 * 1) 합성 paste 이벤트 -> 2) 실제 클립보드 + Ctrl+V -> 3) 평문 타이핑 순으로 시도한다.
 */
async function pasteHtml(page, scope, html) {
  const text = htmlToPlainText(html);
  const before = await bodyTextLength(scope);

  const trySynthetic = async () => {
    await scope.evaluate(({ html: source, text: plain }) => {
      const target = document.activeElement && document.activeElement !== document.body
        ? document.activeElement
        : document.querySelector('.se-main-container') || document.body;
      const data = new DataTransfer();
      data.setData('text/html', source);
      data.setData('text/plain', plain);
      target.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }));
    }, { html, text });
    await page.waitForTimeout(700);
    return (await bodyTextLength(scope)) > before + Math.min(20, text.length / 2);
  };

  const tryClipboard = async () => {
    await scope.evaluate(async ({ html: source, text: plain }) => {
      const item = new ClipboardItem({
        'text/html': new Blob([source], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
    }, { html, text });
    await page.keyboard.press(`${MODIFIER}+V`);
    await page.waitForTimeout(900);
    return (await bodyTextLength(scope)) > before + Math.min(20, text.length / 2);
  };

  try {
    if (await trySynthetic()) return 'synthetic-paste';
  } catch (error) {
    logger.warn(`합성 붙여넣기 실패: ${error.message.split('\n')[0]}`);
  }

  try {
    if (await tryClipboard()) return 'clipboard';
  } catch (error) {
    logger.warn(`클립보드 붙여넣기 실패: ${error.message.split('\n')[0]}`);
  }

  // 마지막 수단: 서식 없이 평문으로라도 넣는다.
  logger.warn('서식 붙여넣기에 실패해 평문으로 입력합니다.');
  for (const line of text.split('\n')) {
    if (line.trim()) {
      try {
        await page.keyboard.insertText(line);
      } catch {
        await page.keyboard.type(line, { delay: 8 });
      }
    }
    await page.keyboard.press('Enter');
  }
  return 'plain-text';
}

/** 현재 커서 위치에 이미지를 넣는다. */
async function insertImage(page, scope, imagePath) {
  const { locator } = await findFirst(scope, SELECTORS.imageButton, 10000);

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 20000 }),
    locator.click({ timeout: 10000 }),
  ]);
  await chooser.setFiles(path.resolve(imagePath));

  // 업로드가 끝나 이미지 컴포넌트가 붙을 때까지 기다린다.
  await scope
    .waitForSelector('.se-component.se-image, .se-image-resource', { timeout: 60000 })
    .catch(() => {
      throw new Error('이미지 업로드가 완료되지 않았습니다.');
    });
  await page.waitForTimeout(1200);

  // 이미지 다음 줄로 커서를 옮겨 본문이 이어지게 한다.
  await page.keyboard.press('ArrowDown').catch(() => {});
  await page.keyboard.press('End').catch(() => {});
}

/**
 * 표를 확실하게 넣는다. 앞 단계가 실패하면 다음 단계로 내려간다.
 *
 *   1단계  표 전체를 한 번에 붙여넣기        — 성공하면 글자를 선택할 수 있는 진짜 표
 *   2단계  20행씩 끊어 여러 번 붙여넣기      — 조각이 작으면 에디터가 받아준다
 *   3단계  표를 그림으로 그려 파일로 삽입     — 클립보드를 안 거치므로 거절당하지 않는다
 *
 * 1·2단계는 에디터 안의 table 개수를 직접 세어 확인한다.
 * "글자가 늘었나" 만 보면 표가 통째로 잘려도 성공으로 치기 때문이다.
 */
async function insertTable(page, scope, step, jobId) {
  const rows = step.table?.rows?.length || 0;

  const pasted = async (html) => {
    const before = await tableCount(scope);
    await pasteHtml(page, scope, BLOCK_GAP + html);
    await page.waitForTimeout(400);
    return (await tableCount(scope)) > before;
  };

  if (await pasted(step.html)) {
    logger.info(`표 입력 완료 (${rows}행, 한 번에)`, { jobId });
    return true;
  }

  const chunks = buildTableChunks(step.table, 20);
  if (chunks.length > 1) {
    logger.warn(`표가 한 번에 안 들어가 ${chunks.length}조각으로 나눠 넣습니다.`, { jobId });
    let done = 0;
    for (const chunk of chunks) {
      if (await pasted(chunk)) done += 1;
      await page.waitForTimeout(200);
    }
    if (done === chunks.length) {
      logger.info(`표 입력 완료 (${rows}행, ${chunks.length}조각으로 나눔)`, { jobId });
      return true;
    }
    logger.warn(`나눠 넣기도 ${done}/${chunks.length}조각만 들어갔습니다. 그림으로 넣습니다.`, { jobId });
  }

  // 마지막 수단. 여기까지 오면 반드시 들어간다.
  try {
    const images = await renderTableImages(chunks.length ? chunks : [step.html], { jobId });
    for (const image of images) await insertImage(page, scope, image.filePath);
    logger.info(`표를 그림 ${images.length}장으로 넣었습니다 (${rows}행).`, { jobId });
    return true;
  } catch (error) {
    logger.error(`표를 끝내 넣지 못했습니다 (${rows}행): ${error.message}`, { jobId });
    return false;
  }
}

/**
 * 본문 전체를 왼쪽 정렬로 맞춘다.
 *
 * 에디터는 문단 정렬을 자체 클래스로 관리해서, 붙여넣은 HTML 의 text-align 은
 * 무시된다. 게다가 지난번에 가운데 정렬로 쓴 글이 있으면 그 설정이 남아 있어서
 * 새 글도 가운데로 들어간다. 그래서 에디터 기능으로 직접 걸어줘야 한다.
 */
async function alignBodyLeft(page, scope, jobId) {
  try {
    const { locator } = await findFirst(scope, SELECTORS.body, 8000);
    await locator.first().click({ timeout: 8000 });
    await page.keyboard.press(`${MODIFIER}+A`);
    await page.waitForTimeout(200);

    // 툴바 버튼이 있으면 그걸 쓴다. 메뉴 안에 숨어 있으면 먼저 펼친다.
    let clicked = await clickIfPresent(scope, SELECTORS.alignLeft, 1500);
    if (!clicked) {
      await clickIfPresent(scope, SELECTORS.alignMenu, 1500);
      await page.waitForTimeout(250);
      clicked = await clickIfPresent(scope, SELECTORS.alignLeft, 1500);
    }
    // 버튼을 못 찾으면 단축키로 시도한다.
    if (!clicked) await page.keyboard.press(`${MODIFIER}+Shift+L`);

    await page.waitForTimeout(300);
    // 선택을 풀고 커서를 글 끝으로 보낸다. 선택된 채로 두면 다음 동작이 글을 지운다.
    await page.keyboard.press('ArrowDown').catch(() => {});
    await page.keyboard.press('End').catch(() => {});
    logger.info(`본문을 왼쪽 정렬로 맞췄습니다. (${clicked || '단축키'})`, { jobId });
  } catch (error) {
    // 정렬 하나 때문에 글 전체를 버릴 이유는 없다.
    logger.warn(`왼쪽 정렬을 걸지 못했습니다: ${error.message.split('\n')[0]}`, { jobId });
  }
}

async function saveDraft(page, scope) {
  const { locator, selector } = await findFirst(scope, SELECTORS.saveButton, 15000);
  await locator.click({ timeout: 10000 });
  logger.info(`임시저장 버튼을 눌렀습니다. (${selector})`);

  for (const toast of SELECTORS.saveToast) {
    const seen = await scope
      .locator(toast)
      .first()
      .waitFor({ state: 'visible', timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    if (seen) return true;
  }

  // 토스트를 못 잡아도 저장은 됐을 수 있다. 경고만 남기고 진행한다.
  await page.waitForTimeout(2500);
  logger.warn('저장 완료 표시를 확인하지 못했습니다. 네이버 임시저장 목록에서 확인해 주세요.');
  return false;
}

async function captureFailure(page, jobId) {
  if (!getSettings().run.screenshotOnError) return '';
  try {
    ensureDirs();
    const file = path.join(SHOT_DIR, `${Date.now()}-${jobId || 'error'}.png`);
    await page.screenshot({ path: file, fullPage: false });
    logger.warn(`오류 화면을 저장했습니다: ${file}`);
    return file;
  } catch {
    return '';
  }
}

/**
 * 글 한 편을 네이버 블로그 에디터에 옮겨 적고 임시저장한다.
 *
 * 순서는 워드프레스판과 같다. 제목 → 도입부 → 썸네일 → 본문.
 * 썸네일을 도입부 바로 뒤에 두는 이유는 두 가지다. 이미지가 글 상단 1/3 안에
 * 들어가야 목록에서 보기 좋고, 네이버는 글의 **첫 번째 이미지**를 대표 이미지로
 * 쓰기 때문에 따로 지정할 필요가 없어진다.
 *
 * 발행은 하지 않는다. 임시저장까지만 하고 사실 확인과 발행은 사람이 한다.
 */
export async function publishDraft({ post, thumbnailPath, jobId = '', bodyOptions = {} }) {
  const settings = getSettings();
  const blogId = settings.blogId;
  if (!blogId) throw new Error('블로그 아이디가 없습니다. 로그인하거나 설정에서 입력해 주세요.');

  const context = await getContext();

  // 로그인이 안 된 채로 진행하면 글쓰기 대신 로그인 화면이 떠서
  // 무슨 일이 난 건지 알기 어렵다. 먼저 확인하고 분명하게 알린다.
  if (!(await hasNaverCookies(context).catch(() => false))) {
    throw new Error(
      '브라우저에 네이버 로그인이 되어 있지 않습니다. '
      + '대시보드에서 [세션 삭제] 후 [네이버 로그인 창 열기]로 다시 로그인해 주세요.',
    );
  }

  const opener = await context.newPage();
  opener.setDefaultTimeout(30000);
  let page = opener;

  try {
    logger.step(`에디터 열기: ${post.title}`, { jobId });
    const opened = await openWriteEditor(page, blogId, jobId);
    const scope = opened.scope;
    page = opened.page;        // 새 창으로 열렸으면 그쪽을 쓴다.

    await dismissPopups(scope);

    const { locator: titleField } = await findFirst(scope, SELECTORS.title, 15000);
    await typeInto(page, titleField, post.title);
    logger.info('제목 입력 완료', { jobId });

    const { locator: bodyField } = await findFirst(scope, SELECTORS.body, 15000);
    await bodyField.click({ timeout: 10000 });
    await page.waitForTimeout(200);

    const introMode = await pasteHtml(page, scope, buildIntroHtml(post));
    logger.info(`도입부 입력 완료 (${introMode})`, { jobId });

    let thumbnailInserted = false;
    if (thumbnailPath && settings.thumbnail.insert) {
      await insertImage(page, scope, thumbnailPath);
      thumbnailInserted = true;
      logger.info('썸네일 삽입 완료 (도입부 직후, 대표 이미지가 됩니다)', { jobId });
    }

    // 본문은 조각으로 나눠 붙인다. 조각 앞에 빈 문단을 두는 게 핵심이다.
    // 그게 없으면 조각의 첫 문단이 커서가 있던 문단 뒤에 그대로 이어붙어
    // "구조였습니다.추천 항목을 고른 기준" 처럼 나온다.
    const plan = buildBodyPlan(post, bodyOptions);
    let tables = 0;

    for (const step of plan) {
      if (step.table) {
        if (await insertTable(page, scope, step, jobId)) tables += 1;
        await page.waitForTimeout(250);
        continue;
      }
      const mode = await pasteHtml(page, scope, BLOCK_GAP + step.html);
      if (plan.length > 3) logger.info(`본문 조각 입력 (${mode})`, { jobId });
      await page.waitForTimeout(250);
    }
    logger.info(
      `본문 입력 완료 (텍스트 ${plan.filter((step) => !step.table).length}조각, 표 ${tables}개)`,
      { jobId },
    );

    // 저장 직전에 한 번에 맞춘다. 붙여넣기마다 하면 그때그때 선택을 잡느라 느리고,
    // 어차피 마지막에 전체를 한 번 훑으면 중간에 가운데로 들어온 것까지 다 잡힌다.
    await alignBodyLeft(page, scope, jobId);

    const confirmed = await saveDraft(page, scope);
    return {
      saved: true,
      confirmed,
      blogId,
      thumbnailInserted,
      tables,
      // 임시저장 목록은 글쓰기 화면에서 열린다. 대시보드의 [임시저장 열기] 링크.
      draftListUrl: `https://blog.naver.com/${blogId}/postwrite`,
    };
  } catch (error) {
    error.screenshot = await captureFailure(page, jobId);
    throw error;
  } finally {
    await page.waitForTimeout(800).catch(() => {});
    // 글쓰기가 새 창으로 열렸다면 처음 열었던 창도 같이 닫는다.
    await page.close().catch(() => {});
    if (opener !== page) await opener.close().catch(() => {});
  }
}
