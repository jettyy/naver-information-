/**
 * ChatGPT 화면의 선택자 후보들.
 *
 * 네이버 에디터와 같은 이유로 여기 모아 둔다. 화면이 수시로 바뀌기 때문에
 * 후보를 여러 개 두고 먼저 잡히는 것을 쓴다. 자동화가 깨지면 대부분
 * 이 파일만 손보면 된다. (`data/screenshots/` 의 캡처를 같이 보세요)
 */
/**
 * ChatGPT 주소.
 *
 * 환경변수로 바꿀 수 있게 열어 둔 것은 **점검용**이다. 가짜 화면을 띄워
 * 전체 흐름(요청 → 그림 찾기 → 내려받기 → 썸네일 저장)을 실제로 돌려 보려면
 * 주소를 갈아끼울 구멍이 하나 필요하다. 평소에는 건드리지 않는다.
 */
export function chatGptUrl() {
  return process.env.CHATGPT_URL || 'https://chatgpt.com/';
}

export const SELECTORS = {
  // 입력창이 떴는지 = 로그인이 되어 있고 새 대화가 열렸다는 뜻
  composer: [
    '#prompt-textarea',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'form div[contenteditable="true"]',
    'textarea[data-testid="prompt-textarea"]',
  ],

  // 보내기 버튼. Enter 로도 되지만 버튼이 잡히면 그쪽이 확실하다.
  send: [
    'button[data-testid="send-button"]',
    'button[aria-label*="보내기"]',
    'button[aria-label*="Send"]',
    'form button[type="submit"]',
  ],

  // 생성이 도는 동안 나타나는 정지 버튼. 이게 사라지면 답이 끝난 것이다.
  stop: [
    'button[data-testid="stop-button"]',
    'button[aria-label*="중지"]',
    'button[aria-label*="Stop"]',
  ],

  /*
   * 화면을 가로막는 알림창.
   *
   * "요청이 너무 많습니다 ... 몇 분 후 다시 시도해 주세요" 처럼 버튼 하나짜리
   * 알림이 떠서 입력창을 덮는 일이 있다. 그냥 두면 아무 것도 못 하고
   * 5분을 기다리다 끝난다. 찾으면 눌러서 닫는다.
   */
  dialog: [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[data-testid*="modal"]',
  ],

  // 알림창 안의 닫기 버튼. 창 안에서만 찾는다 (본문의 같은 글자를 누르지 않게).
  dialogConfirm: [
    'button:has-text("알겠습니다")',
    'button:has-text("확인")',
    'button:has-text("닫기")',
    'button:has-text("Got it")',
    'button:has-text("Okay")',
    'button:has-text("OK")',
    'button:has-text("Dismiss")',
    'button',
  ],

  // 로그인 화면임을 알려주는 것들
  loginWall: [
    'button[data-testid="login-button"]',
    'a[href*="/auth/login"]',
    'button[data-testid="mobile-login-button"]',
  ],

  // 답변 말풍선
  assistantTurn: [
    '[data-message-author-role="assistant"]',
    'article[data-testid^="conversation-turn"]',
  ],

  /*
   * 임시 채팅 토글.
   *
   * 임시 채팅으로 만든 그림은 대화 기록에 남지 않아서 나중에 다시 꺼낼 수가 없다.
   * 그래서 켜져 있으면 반드시 끈다. 가장 확실한 신호는 주소의
   * temporary-chat=true 이고, 아래 버튼은 그것을 끄는 용도다.
   */
  temporaryToggle: [
    'button[aria-label*="임시 채팅"]',
    'button[aria-label*="Temporary"]',
    'button[data-testid="temporary-chat-toggle"]',
    '[data-testid="temporary-chat-button"]',
  ],
};

/** 주소만 보고도 임시 채팅인지 알 수 있다. 가장 믿을 만한 신호다. */
export function isTemporaryUrl(url) {
  return /[?&]temporary-chat=true/i.test(String(url || ''));
}

/**
 * 알림창 내용이 "너무 빨리 보냈다" 는 뜻인지.
 *
 * 이건 그냥 닫고 바로 다시 보내면 안 된다. 창에 적힌 대로 **몇 분 기다렸다가**
 * 다시 보내야 한다. 닫자마자 또 보내면 같은 창이 또 뜬다.
 */
export function isRateLimitDialog(text) {
  return /요청이 너무 많|너무 빠르게|잠시 후 다시|몇 분 후 다시|too many requests|rate limit|slow down|try again in/i
    .test(String(text || ''));
}

/**
 * ChatGPT 가 만든 그림인지 주소로 가린다.
 *
 * 답변 말풍선 안에는 프로필 사진과 아이콘도 <img> 로 들어 있다.
 * 그것들까지 집으면 엉뚱한 그림이 썸네일로 올라간다.
 */
export function looksLikeGeneratedImage(src) {
  const url = String(src || '');
  if (!url) return false;
  if (/^blob:/i.test(url)) return true;
  if (!/^https?:/i.test(url)) return false;
  // 실제 생성 이미지는 이 호스트들로 내려온다.
  if (/oaiusercontent\.com|\/backend-api\/(files|estuary)|sdmntpr|blob\.core\.windows\.net/i.test(url)) {
    return true;
  }
  // 아바타·아이콘·스프라이트는 제외한다.
  return false;
}
