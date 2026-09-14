import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { logger } from './events.js';
import { getSettings } from './settings.js';

/**
 * 브라우저는 두 가지 일에 쓰인다.
 *
 *   1. 네이버 로그인과 글쓰기 — 창을 띄우는 영구 프로필 (src/naver/browser.js)
 *   2. 썸네일·표 그림 렌더링 — 헤드리스 스크린샷 전용 (아래 getRenderBrowser)
 *
 * 둘을 같은 브라우저로 돌리면 스크린샷 때문에 네이버 세션이 끊긴다.
 * 그래서 프로필은 하나만 두고, 렌더링용은 따로 띄운다.
 */

let installPromise = null;

/** 이미 설치된 크롬/크로미움을 쓰고 싶을 때의 탈출구. */
export function chromiumOverride() {
  const configured = getSettings().run?.chromiumPath || process.env.CHROMIUM_PATH || '';
  if (configured && fs.existsSync(configured)) return configured;
  if (configured) logger.warn(`지정한 크로미움 경로를 찾을 수 없습니다: ${configured}`);
  return '';
}

/** launch 옵션에 실행 파일 경로를 얹어준다. */
export function withExecutable(options = {}) {
  const executablePath = chromiumOverride();
  return executablePath ? { ...options, executablePath } : options;
}

/**
 * 크로미움이 없으면 자동으로 받아온다. (사용자가 따로 명령을 칠 필요 없게)
 * 이미 설치돼 있으면 아무 것도 하지 않는다.
 */
export function ensureBrowsers() {
  if (installPromise) return installPromise;

  installPromise = (async () => {
    const override = chromiumOverride();
    if (override) {
      logger.info(`지정된 크로미움을 사용합니다: ${override}`);
      return true;
    }

    let executable = '';
    try {
      executable = chromium.executablePath();
    } catch {
      executable = '';
    }
    if (executable && fs.existsSync(executable)) {
      logger.info('Playwright 크로미움 확인 완료.');
      return true;
    }

    logger.info('크로미움이 없어 자동으로 설치합니다. 처음 한 번은 몇 분 걸릴 수 있습니다...');
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.platform === 'win32' ? 'npx.cmd' : 'npx',
        ['--yes', 'playwright', 'install', 'chromium'],
        { stdio: 'inherit', shell: process.platform === 'win32' },
      );
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`playwright install chromium 실패 (종료 코드 ${code})`));
      });
    });
    logger.info('크로미움 설치 완료.');
    return true;
  })().catch((error) => {
    installPromise = null;
    throw error;
  });

  return installPromise;
}

/** 브라우저를 쓸 수 있는 상태인지 확인한다. */
export async function prepareBrowser() {
  const override = chromiumOverride();
  if (override) return { using: override, label: '지정한 브라우저' };
  await ensureBrowsers();
  return { using: 'chromium', label: 'Playwright 크로미움' };
}

let renderBrowser = null;

/** 썸네일·표 그림 전용 헤드리스 브라우저 (네이버 세션과 분리). */
export async function getRenderBrowser() {
  if (renderBrowser?.isConnected()) return renderBrowser;
  await ensureBrowsers();
  renderBrowser = await chromium.launch(withExecutable({ headless: true }));
  return renderBrowser;
}

export async function closeRenderBrowser() {
  if (renderBrowser?.isConnected()) await renderBrowser.close();
  renderBrowser = null;
}
