import { prepareBrowser } from '../src/lib/playwright.js';
import { checkClaude } from '../src/ai/claude.js';
import { readSessionInfo } from '../src/naver/browser.js';

console.log('인포러시 준비 상태를 확인합니다.\n');

const claude = await checkClaude();
console.log(claude.ok
  ? `[확인] claude CLI: ${claude.version}`
  : `[실패] claude CLI: ${claude.message}\n`
    + "       npm install -g @anthropic-ai/claude-code 로 설치한 뒤 'claude' 를 한 번 실행해 로그인하세요.");

try {
  const { label } = await prepareBrowser();
  console.log(`[확인] 브라우저: ${label}`);
} catch (error) {
  console.log(`[실패] 브라우저 준비 실패: ${error.message}`);
}

// 여기서 브라우저를 띄워 세션을 확인하지는 않는다.
// 로그인할 때와 다른 모드로 프로필을 다시 열면 네이버 세션이 끊기는 일이 있다.
const session = readSessionInfo();
console.log(session.loggedIn
  ? `[확인] 네이버 세션 있음${session.blogId ? ` · ${session.blogId}` : ' (블로그 아이디 미확인)'}`
  : '[대기] 네이버 로그인이 아직 없습니다. 대시보드 1번 칸에서 로그인하세요.');

console.log('\n준비가 끝났으면 npm start 로 대시보드를 실행하고, 2번 칸에 큰 주제와 개수를 넣으세요.');
