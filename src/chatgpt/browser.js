import fs from 'node:fs';
import { chromium } from 'playwright';
import { ensureBrowsers, withExecutable } from '../lib/playwright.js';
import {
  CHATGPT_PROFILE_DIR, CHATGPT_SESSION_FILE, CHATGPT_STORAGE_FILE, ensureDirs,
} from '../lib/paths.js';
import { getSettings } from '../lib/settings.js';
import { logger, push } from '../lib/events.js';
import { chatGptUrl, SELECTORS, isTemporaryUrl } from './selectors.js';

/**
 * ChatGPT 세션을 다루는 곳.
 *
 * 네이버와 **똑같은 방식**이다. 아이디와 비밀번호는 이 프로그램이 다루지 않는다.
 * 진짜 브라우저 창을 띄워 사용자가 직접 로그인하게 하고, 세션만 넘겨받는다.
 * 그래서 2단계 인증도 그대로 통과한다.
 *
 * 프로필 폴더는 네이버와 나눠 둔다. 한 프로필에 두 사이트를 같이 두면
 * 한쪽을 다시 로그인할 때 다른 쪽까지 휩쓸려 풀린다.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let context = null;
let contextHeadless = null;

export async function getChatGptContext({ headless } = {}) {
  const settings = getSettings();
  const wantHeadless = headless ?? settings.run.headless;

  if (context && contextHeadless === wantHeadless) return context;
  if (context) await closeChatGptContext();

  await ensureBrowsers();
  ensureDirs();

  context = await chromium.launchPersistentContext(CHATGPT_PROFILE_DIR, withExecutable({
    headless: wantHeadless,
    viewport: { width: 1440, height: 960 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent: UA,
    slowMo: settings.run.slowMoMs || 0,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=ko-KR',
    ],
  }));
  contextHeadless = wantHeadless;

  context.on('close', () => {
    context = null;
    contextHeadless = null;
  });

  if (!(await hasChatGptCookies(context).catch(() => false))) {
    const restored = await restoreCookies(context);
    if (restored) logger.info('저장해둔 ChatGPT 쿠키를 되살렸습니다.');
  }

  return context;
}

export async function closeChatGptContext() {
  if (context) await context.close().catch(() => {});
  context = null;
  contextHeadless = null;
}

export function readChatGptSession() {
  try {
    return JSON.parse(fs.readFileSync(CHATGPT_SESSION_FILE, 'utf8'));
  } catch {
    return { loggedIn: false, checkedAt: null };
  }
}

function writeChatGptSession(info) {
  ensureDirs();
  const next = { ...readChatGptSession(), ...info, checkedAt: new Date().toISOString() };
  fs.writeFileSync(CHATGPT_SESSION_FILE, JSON.stringify(next, null, 2), 'utf8');
  push('chatgptSession', next);
  return next;
}

/** 로그인 쿠키가 살아 있는지. 세션 토큰 이름은 바뀔 수 있어 몇 가지를 본다. */
export async function hasChatGptCookies(ctx) {
  const cookies = await ctx.cookies('https://chatgpt.com');
  return cookies.some((cookie) => (
    /^__Secure-next-auth\.session-token/.test(cookie.name)
    || cookie.name === '__Session-token'
    || /session-token/i.test(cookie.name)
  ) && String(cookie.value || '').length > 20);
}

async function saveCookies(ctx) {
  try {
    const cookies = await ctx.cookies();
    if (!cookies.length) return false;
    ensureDirs();
    fs.writeFileSync(CHATGPT_STORAGE_FILE, JSON.stringify({ cookies }, null, 2), 'utf8');
    // 세션 쿠키가 든 파일이다. 같은 컴퓨터의 다른 계정에서 못 읽게 한다.
    try {
      fs.chmodSync(CHATGPT_STORAGE_FILE, 0o600);
    } catch {
      // 윈도우 등 권한 모델이 다른 환경에서는 넘어간다.
    }
    return true;
  } catch (error) {
    logger.warn(`ChatGPT 쿠키를 저장하지 못했습니다: ${error.message}`);
    return false;
  }
}

async function restoreCookies(ctx) {
  if (!fs.existsSync(CHATGPT_STORAGE_FILE)) return false;
  try {
    const { cookies } = JSON.parse(fs.readFileSync(CHATGPT_STORAGE_FILE, 'utf8'));
    if (!Array.isArray(cookies) || !cookies.length) return false;
    const now = Date.now() / 1000;
    const alive = cookies.filter((c) => !c.expires || c.expires < 0 || c.expires > now);
    if (!alive.length) return false;
    await ctx.addCookies(alive);
    return true;
  } catch (error) {
    logger.warn(`저장해둔 ChatGPT 쿠키를 되살리지 못했습니다: ${error.message}`);
    return false;
  }
}

/** 화면에 로그인 벽이 떠 있는지. 쿠키만으로는 만료를 못 잡을 때가 있다. */
export async function looksLoggedOut(page) {
  for (const selector of SELECTORS.loginWall) {
    const visible = await page.locator(selector).first().isVisible({ timeout: 800 }).catch(() => false);
    if (visible) return true;
  }
  return /\/auth\/login|\/auth\/signin/.test(page.url());
}

/**
 * 새 **일반 대화**를 연다.
 *
 * 임시 채팅으로 만든 그림은 대화 기록에 남지 않는다. 나중에 같은 그림을
 * 다시 꺼내 볼 수도, 무엇으로 만들었는지 확인할 수도 없다. 그래서
 * 임시 채팅이면 반드시 끄고 일반 대화로 다시 연다.
 */
export async function openNormalChat(page, { timeoutMs = 60000 } = {}) {
  await page.goto(chatGptUrl(), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForTimeout(1500);

  // 1) 주소에 임시 채팅 표시가 남아 있으면 그것부터 떼고 다시 연다.
  if (isTemporaryUrl(page.url())) {
    logger.warn('임시 채팅으로 열려 일반 대화로 다시 엽니다.');
    await page.goto(chatGptUrl(), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(1500);
  }

  // 2) 지난번에 켜 둔 토글이 남아 있을 수 있다. 눌러서 끈다.
  for (const selector of SELECTORS.temporaryToggle) {
    const button = page.locator(selector).first();
    const on = await button.getAttribute('aria-pressed').catch(() => null);
    if (on === 'true') {
      logger.warn('임시 채팅 토글이 켜져 있어 끕니다.');
      await button.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
      break;
    }
  }

  // 3) 여기까지 왔는데도 임시 채팅이면 그림이 기록에 안 남는다. 진행하지 않는다.
  if (isTemporaryUrl(page.url())) {
    throw new Error(
      '임시 채팅을 끄지 못했습니다. ChatGPT 창에서 임시 채팅을 직접 끈 뒤 다시 시도해 주세요.',
    );
  }

  if (await looksLoggedOut(page)) {
    throw new Error('ChatGPT 로그인이 풀렸습니다. 설정에서 [ChatGPT 로그인 창 열기]를 눌러 주세요.');
  }
  return page;
}

/** 저장된 세션이 아직 유효한지 확인한다. */
export async function verifyChatGptSession({ headless } = {}) {
  if (!fs.existsSync(CHATGPT_PROFILE_DIR)) {
    return writeChatGptSession({ loggedIn: false });
  }

  const ctx = await getChatGptContext(headless === undefined ? {} : { headless });
  const page = await ctx.newPage();
  try {
    await page.goto(chatGptUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    if (await looksLoggedOut(page)) {
      logger.warn('ChatGPT 로그인이 풀렸습니다. 다시 로그인해 주세요.');
      return writeChatGptSession({ loggedIn: false });
    }
    await saveCookies(ctx);
    return writeChatGptSession({ loggedIn: true });
  } catch (error) {
    // 확인에 실패했다고 멀쩡한 세션을 로그아웃으로 바꾸지 않는다.
    logger.warn(`ChatGPT 세션 확인을 건너뜁니다 (${error.message}). 저장된 상태를 그대로 씁니다.`);
    return readChatGptSession();
  } finally {
    await page.close().catch(() => {});
  }
}

/** 사용자가 직접 로그인할 수 있게 진짜 브라우저 창을 띄운다. */
export async function openChatGptLogin({ timeoutMs = 300000 } = {}) {
  await closeChatGptContext();
  const ctx = await getChatGptContext({ headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());

  logger.step('ChatGPT 로그인 창을 띄웠습니다. 창에서 직접 로그인해 주세요.');
  await page.goto(chatGptUrl(), { waitUntil: 'domcontentloaded' }).catch(() => {});

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) break;
    const ready = await hasChatGptCookies(ctx).catch(() => false)
      && !(await looksLoggedOut(page).catch(() => true));
    if (ready) {
      logger.info('ChatGPT 로그인 성공. 세션을 저장합니다.');
      const info = writeChatGptSession({ loggedIn: true });
      // 정상 종료를 해야 프로필 폴더에도 쿠키가 기록된다.
      await saveCookies(ctx);
      await page.close().catch(() => {});
      await closeChatGptContext();
      logger.info('ChatGPT 로그인 정보를 저장하고 창을 닫았습니다.');
      return info;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  logger.warn('ChatGPT 로그인이 완료되지 않았습니다 (시간 초과 또는 창 닫힘).');
  return writeChatGptSession({ loggedIn: false });
}

/** 저장된 ChatGPT 세션을 지운다. */
export async function chatGptLogout() {
  await closeChatGptContext();
  fs.rmSync(CHATGPT_PROFILE_DIR, { recursive: true, force: true });
  fs.rmSync(CHATGPT_SESSION_FILE, { force: true });
  fs.rmSync(CHATGPT_STORAGE_FILE, { force: true });
  logger.info('저장된 ChatGPT 세션을 삭제했습니다.');
  return push('chatgptSession', { loggedIn: false });
}
