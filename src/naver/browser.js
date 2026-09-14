import fs from 'node:fs';
import { chromium } from 'playwright';
import { ensureBrowsers, withExecutable } from '../lib/playwright.js';
import { PROFILE_DIR, SESSION_FILE, STORAGE_FILE, ensureDirs } from '../lib/paths.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { logger, push } from '../lib/events.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let context = null;
let contextHeadless = null;

/**
 * 로그인 세션은 persistent context(프로필 폴더)에 그대로 남는다.
 * data/browser-profile 을 지우지 않는 한 재로그인할 필요가 없다.
 */
export async function getContext({ headless } = {}) {
  const settings = getSettings();
  const wantHeadless = headless ?? settings.run.headless;

  if (context && contextHeadless === wantHeadless) return context;
  if (context) {
    // 모드를 바꾸면 같은 프로필로 브라우저를 다시 띄운다.
    // 흔한 일은 아니어야 하므로 로그에 남겨둔다. 세션이 끊기면 여기가 단서다.
    logger.warn(
      `브라우저를 ${contextHeadless ? '숨김' : '창 보임'} → ${wantHeadless ? '숨김' : '창 보임'} ` +
      `모드로 다시 엽니다.`,
    );
    await closeContext();
  }

  await ensureBrowsers();
  ensureDirs();

  context = await chromium.launchPersistentContext(PROFILE_DIR, withExecutable({
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

  // 붙여넣기로 서식을 넣기 때문에 클립보드 권한이 필요하다.
  await context
    .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://blog.naver.com' })
    .catch(() => {});

  context.on('close', () => {
    context = null;
    contextHeadless = null;
  });

  // 프로필에 로그인 쿠키가 없으면 따로 보관해둔 것을 넣어준다.
  if (!(await hasNaverCookies(context).catch(() => false))) {
    const restored = await restoreCookies(context);
    if (restored) logger.info('저장해둔 네이버 쿠키를 되살렸습니다.');
  }

  return context;
}

export async function closeContext() {
  if (context) {
    await context.close().catch(() => {});
  }
  context = null;
  contextHeadless = null;
}

export function readSessionInfo() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return { loggedIn: false, blogId: '', nickname: '', checkedAt: null };
  }
}

function writeSessionInfo(info) {
  ensureDirs();
  const next = { ...readSessionInfo(), ...info, checkedAt: new Date().toISOString() };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(next, null, 2), 'utf8');
  push('session', next);
  return next;
}

/** 네이버 로그인 쿠키가 살아 있는지 확인. */
export async function hasNaverCookies(ctx) {
  const cookies = await ctx.cookies('https://www.naver.com');
  const names = new Set(cookies.map((c) => c.name));
  return names.has('NID_AUT') && names.has('NID_SES');
}

/**
 * 쿠키를 파일로 따로 보관한다.
 *
 * 크로미움은 프로필 폴더에 쿠키를 곧바로 쓰지 않는다. 브라우저가 정상적으로
 * 닫혀야 기록되는데, 사용자가 로그인 창을 X 로 닫으면 그 과정이 생략돼
 * 다음에 띄웠을 때 로그인이 풀린 창이 뜬다. 그래서 따로 받아 두었다가
 * 프로필에 없으면 되살린다.
 */
async function saveCookies(ctx) {
  try {
    const cookies = await ctx.cookies();
    if (!cookies.length) return false;
    ensureDirs();
    fs.writeFileSync(STORAGE_FILE, JSON.stringify({ cookies }, null, 2), 'utf8');
    return true;
  } catch (error) {
    logger.warn(`쿠키를 저장하지 못했습니다: ${error.message}`);
    return false;
  }
}

async function restoreCookies(ctx) {
  if (!fs.existsSync(STORAGE_FILE)) return false;
  try {
    const { cookies } = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
    if (!Array.isArray(cookies) || !cookies.length) return false;

    const now = Date.now() / 1000;
    const alive = cookies.filter((cookie) => !cookie.expires || cookie.expires < 0 || cookie.expires > now);
    if (!alive.length) return false;

    await ctx.addCookies(alive);
    return true;
  } catch (error) {
    logger.warn(`저장해둔 쿠키를 되살리지 못했습니다: ${error.message}`);
    return false;
  }
}

/** 로그인한 계정의 블로그 아이디를 알아낸다. */
export async function detectBlogId(page) {
  const attempts = [
    'https://blog.naver.com/MyBlog.naver',
    'https://section.blog.naver.com/BlogHome.naver',
  ];

  for (const url of attempts) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1200);

      const fromUrl = page.url().match(/blog\.naver\.com\/([A-Za-z0-9_-]{3,})/);
      if (fromUrl && !/^(MyBlog|PostList|section|BlogHome)/i.test(fromUrl[1])) {
        return fromUrl[1];
      }

      const fromLink = await page.evaluate(() => {
        const anchor = document.querySelector('a[href*="blog.naver.com/"][class*="my"], .item_my_blog a, a.link_my');
        return anchor?.getAttribute('href') || '';
      });
      const matched = String(fromLink).match(/blog\.naver\.com\/([A-Za-z0-9_-]{3,})/);
      if (matched) return matched[1];
    } catch {
      // 다음 후보로 넘어간다.
    }
  }
  return '';
}

/** 저장된 세션이 아직 유효한지 확인하고 상태를 갱신한다. */
export async function verifySession({ headless } = {}) {
  if (!fs.existsSync(PROFILE_DIR)) {
    return writeSessionInfo({ loggedIn: false, blogId: '' });
  }

  // headless 를 지정하지 않는다. 설정에 저장된 모드를 그대로 쓴다.
  // 모드가 다르면 getContext 가 브라우저를 닫고 같은 프로필로 다시 띄우는데,
  // 그 과정에서 네이버 세션이 끊기는 일이 있었다.
  const ctx = await getContext(headless === undefined ? {} : { headless });
  const page = await ctx.newPage();
  try {
    await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 20000 });

    // 쿠키는 화면이 뜬 직후 잠깐 비어 보일 수 있다. 한 번 어긋났다고
    // 로그아웃으로 단정하면 실행 버튼까지 막히므로 몇 번 더 확인한다.
    let loggedIn = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      loggedIn = await hasNaverCookies(ctx).catch(() => false);
      if (loggedIn) break;
      await page.waitForTimeout(1200);
    }
    if (!loggedIn) {
      logger.warn('네이버 로그인 쿠키를 찾지 못했습니다. 다시 로그인해 주세요.');
      return writeSessionInfo({ loggedIn: false });
    }

    // 블로그 아이디는 항상 다시 확인한다.
    // 저장된 값을 그대로 쓰면 다른 계정으로 로그인했을 때 이전 계정의
    // 블로그로 글쓰기를 시도하게 되고, 남의 블로그에는 쓸 수 없으니
    // 글쓰기 화면 대신 그냥 블로그 홈이 뜬다.
    const saved = getSettings().blogId || '';
    const detected = await detectBlogId(page).catch(() => '');
    const blogId = detected || saved;

    if (detected && detected !== saved) {
      saveSettings({ blogId: detected });
      logger.info(
        saved
          ? `블로그 아이디가 바뀌었습니다: ${saved} → ${detected}`
          : `블로그 아이디를 확인했습니다: ${detected}`,
      );
    }
    await saveCookies(ctx);
    return writeSessionInfo({ loggedIn: true, blogId });
  } catch (error) {
    // 확인에 실패했다고 멀쩡한 세션을 로그아웃으로 바꾸지 않는다.
    logger.warn(`세션 확인을 건너뜁니다 (${error.message}). 저장된 상태를 그대로 씁니다.`);
    return readSessionInfo();
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * 사용자가 직접 로그인할 수 있게 실제 브라우저 창을 띄운다.
 * 아이디/비밀번호는 프로그램이 다루지 않는다 - 2단계 인증도 그대로 통과한다.
 */
export async function openLoginWindow({ timeoutMs = 300000 } = {}) {
  await closeContext();                        // 로그인은 항상 창을 띄워서 한다.
  const ctx = await getContext({ headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());

  logger.step('네이버 로그인 창을 띄웠습니다. 창에서 직접 로그인해 주세요.');
  await page.goto('https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fwww.naver.com',
    { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) break;
    if (await hasNaverCookies(ctx).catch(() => false)) {
      logger.info('로그인 성공. 세션을 저장합니다.');

      // 계정을 바꿔 로그인했을 수 있으니 블로그 아이디를 항상 새로 확인한다.
      const saved = getSettings().blogId || '';
      const detected = await detectBlogId(page).catch(() => '');

      if (detected) {
        saveSettings({ blogId: detected });
        logger.info(
          saved && saved !== detected
            ? `블로그 아이디가 바뀌었습니다: ${saved} → ${detected}`
            : `블로그 아이디를 확인했습니다: ${detected}`,
        );
      } else if (saved) {
        logger.warn(
          `블로그 아이디를 자동으로 찾지 못해 이전 값(${saved})을 그대로 씁니다. ` +
          `계정을 바꾸셨다면 설정에서 직접 고쳐주세요.`,
        );
      } else {
        logger.warn('블로그 아이디를 자동으로 찾지 못했습니다. 설정에서 직접 입력해 주세요.');
      }

      const info = writeSessionInfo({ loggedIn: true, blogId: detected || saved });

      // 쿠키를 따로 받아두고 브라우저를 정상적으로 닫는다.
      // 정상 종료를 해야 프로필 폴더에도 쿠키가 기록된다. 창을 그냥 띄워두면
      // 나중에 실행할 때 로그인이 풀린 창이 뜬다.
      await saveCookies(ctx);
      await page.close().catch(() => {});
      await closeContext();
      logger.info('로그인 정보를 저장하고 창을 닫았습니다.');
      return info;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  logger.warn('로그인이 완료되지 않았습니다 (시간 초과 또는 창 닫힘).');
  return writeSessionInfo({ loggedIn: false });
}

/** 저장된 로그인 세션을 지운다. */
export async function logout() {
  await closeContext();
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.rmSync(SESSION_FILE, { force: true });
  fs.rmSync(STORAGE_FILE, { force: true });
  // 블로그 아이디도 같이 비운다. 남겨두면 다음에 다른 계정으로 로그인했을 때
  // 이전 계정의 블로그로 글쓰기를 시도하게 된다.
  saveSettings({ blogId: '' });
  logger.info('저장된 네이버 세션과 블로그 아이디를 삭제했습니다.');
  return push('session', { loggedIn: false, blogId: '' });
}
