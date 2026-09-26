import fs from 'node:fs';
import { SETTINGS_FILE, ensureDirs } from './paths.js';

export const DEFAULT_SETTINGS = {
  // 네이버 블로그 아이디. 로그인하면 자동으로 채워진다.
  blogId: '',

  // AI (claude CLI, 구독 요금제)
  claude: {
    command: 'claude',
    model: '',                   // 비우면 CLI 기본 모델
    timeoutMs: 420000,           // 정보성 글은 길어서 넉넉히 잡는다.
  },

  // 글 설정
  post: {
    // 정보성 글 규칙이 요구하는 문체다. 바꾸면 품질 점검에서 걸린다.
    tone: '정중한 존댓말 (~습니다 / ~입니다)',
    minChars: 1800,              // 공백 제외 최소 글자 수 (품질 규칙)
    sectionCount: 4,             // 소제목 개수 (규칙: 3~4개)
    audience: '해당 주제의 정보를 처음 찾아보는 일반 독자',
    extraGuideline: '',
    // "전국 대학 순위" 처럼 개수를 안 쓴 순위 주제에 쓸 목표 행 수.
    // 개수를 쓴 주제(TOP 50)는 그 숫자를 그대로 따른다.
    rankTargetCount: 100,
    addCriteria: true,           // 서두에 '선정 기준' 밝히기 (필수 규칙)
    addFaq: true,                // 마지막에 자주 묻는 질문 (정보성 강화)
    appendTags: true,            // 글 끝에 #태그 줄을 붙일지 (네이버 검색 유입)

    // 글에 맞는 카테고리를 **블로그에 이미 있는 것 중에서** 알아서 고른다.
    // 네이버는 카테고리를 발행 패널 안에 두어서, 고르려면 그 패널을 한 번
    // 열었다 닫아야 한다. 발행 버튼은 건드리지 않는다. (editor.js applyCategory)
    autoCategory: true,
    // 여기에 이름을 적으면 **늘 그 카테고리**로 넣는다. 비우면 알아서 고른다.
    category: '',
  },

  // 주제 발굴 (큰 주제 → 웹 검색 → 글 주제)
  discover: {
    bigTopic: '',                // 사용자가 입력하는 큰 주제. 예: "2026년 부동산 정책"
    targetCount: 5,              // 이 주문으로 몇 건을 임시저장하고 끝낼지
    batchSize: 5,                // 한 번 발굴할 때 받아올 주제 개수
    maxSearches: 6,              // 발굴 한 번당 검색 횟수 상한
    recencyDays: 30,             // 며칠 이내 정보를 "최신" 으로 볼지
    minScore: 40,                // 관심도 점수가 이보다 낮으면 버린다 (0~100)
    region: '한국',              // 어느 지역 독자 기준으로 찾을지
    timeoutMs: 420000,           // 검색이 여러 번 돈다. 넉넉히.
    // 대기열이 비면 지금까지 쓴 큰 주제와 결이 이어지는 분야를 **알아서 만들어**
    // 계속 쓴다. 켜 두면 사람이 주제를 넣어 주지 않아도 멈추지 않는다.
    // 그만큼 계속 돌아가니 기본은 꺼 둔다.
    autoRefill: false,
    refillCount: 3,              // 한 번 이어 붙일 때 만들 큰 주제 수
  },

  // 자료 조사 (웹 검색)
  research: {
    enabled: true,               // 글을 쓰기 전에 웹 검색으로 사실을 모은다
    maxSearches: 5,              // 한 주제당 검색 횟수 상한 (프롬프트로 제한)
    timeoutMs: 420000,           // 검색은 오래 걸린다. 넉넉히.
    requireSources: false,       // 출처를 못 구하면 글을 쓰지 않을지
    showSources: true,           // 글 끝에 출처 목록을 붙일지
    sourcesHeading: '참고 자료',
  },

  // 정보성 글 품질 점검
  quality: {
    enforce: true,               // 어기면 자동으로 고쳐 쓰게 한다
    maxRepairs: 1,               // 보정 재요청 횟수 (호출이 늘어나므로 1회 권장)
    blockOnFail: false,          // 끝내 못 고치면 저장하지 않고 실패로 둘지
  },

  // 썸네일 이미지 생성
  image: {
    enabled: false,              // 기본은 꺼짐 (HTML 썸네일).

    // google  — Gemini 이미지 API. 장당 요금이 든다. API 키가 필요하다.
    // chatgpt — **구독 중인 ChatGPT** 에서 그리게 하고 그림만 가져온다.
    //           추가 요금이 없는 대신, 네이버처럼 브라우저로 한 번 로그인해 둬야 한다.
    // pexels  — 무료 사진 사이트에서 **찍혀 있는 사진**을 받아온다.
    //           공짜이고 빠르지만 글자는 못 그린다. 그래서 늘 배경으로만 쓰고
    //           제목은 HTML 이 위에 얹는다 (한글이 깨질 일이 없다).
    provider: 'google',
    apiKey: '',                  // google 용. aistudio.google.com 에서 발급

    // Pexels (무료 사진)
    pexels: {
      apiKey: '',                // pexels.com/api 에서 무료로 발급
    },

    // ChatGPT 에서 받아올 때의 설정
    chatgpt: {
      // 그림 한 장을 기다리는 시간. 몇 분 걸리는 일도 있어 넉넉히 잡는다.
      waitMs: 300000,
      // "요청이 너무 많습니다" 알림창이 떴을 때 기다릴 시간.
      // 창에 "몇 분 후 다시 시도해 주세요" 라고 적혀 있어 넉넉히 잡는다.
      rateLimitWaitMs: 120000,
      // 같은 이유로 다시 보낼 횟수. 끝없이 되풀이하지 않는다.
      rateLimitRetries: 2,
    },

    // full    — 글자까지 포함한 완성 썸네일을 API 가 통째로 그린다
    // overlay — 글자 없는 배경만 API 가 그리고 한글은 HTML 이 얹는다 (싸고 안전)
    mode: 'full',

    // 비워두면 **자동**. 계정에서 쓸 수 있는 이미지 모델 중 언제나 가장 싼 것부터 쓴다.
    model: '',
    modelCacheHours: 24,         // 모델 목록을 다시 받아오는 주기

    // full 모드에서 글자가 깨졌는지 이미지를 다시 읽어 확인한다.
    // 한 번 더 호출하지만 글자 출력이라 값이 거의 안 든다.
    // 깨졌으면 한 번 다시 그리고, 그래도 깨지면 HTML 썸네일로 물러선다.
    verifyText: true,

    style: 'flat',               // flat | soft | photo | line (overlay 모드용)
    poster: 'bold',              // bold | clean | playful (full 모드용)
    timeoutMs: 180000,
  },

  // 썸네일
  thumbnail: {
    width: 1200,
    height: 630,
    style: 'auto',               // auto | bold | gradient | minimal | editorial
    insert: true,                // 도입부 뒤에 그림으로 넣기 (네이버가 이걸 대표 이미지로 씀)
    emoji: false,                // 정보성 글은 기호를 자제하는 편이 안전하다
  },

  // 실행
  run: {
    // 네이버는 연속 자동화에 민감해서 워드프레스보다 길게 잡는다.
    delayMinSec: 30,
    delayMaxSec: 90,
    maxRetries: 1,
    // 연속으로 이만큼 실패하면 실행을 멈춘다. 0 이면 **멈추지 않고 끝까지** 간다.
    // 기본은 0 이다. 한두 주제가 안 된다고 나머지를 세워두는 것보다,
    // 끝까지 돌려놓고 실패한 것만 다시 보는 편이 낫다.
    stopAfterFailures: 0,
    headless: false,             // 네이버는 창을 띄우는 편이 더 안전하다.
    slowMoMs: 0,                 // 동작 사이 지연 (자동화를 눈으로 따라가며 고칠 때)
    screenshotOnError: true,     // 자동화가 실패하면 화면을 찍어 둔다
    chromiumPath: '',            // 쓸 크로미움 경로 (비우면 자동)
  },
};

/** 대시보드로 내보내면 안 되는 값. 화면에는 채워졌는지만 알려준다. */
const SECRET_PATHS = [
  ['image', 'apiKey'],
  ['image', 'pexels', 'apiKey'],
];

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return patch;
  if (typeof patch !== 'object') return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

let cache = null;

export function getSettings() {
  if (cache) return cache;
  ensureDirs();
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    stored = {};
  }
  cache = deepMerge(DEFAULT_SETTINGS, stored);
  return cache;
}

export function saveSettings(patch) {
  const clean = structuredClone(patch || {});
  // 화면에서 되돌아온 마스킹 값(●●●●)으로 진짜 키를 덮어쓰지 않는다.
  for (const keys of SECRET_PATHS) {
    // 마지막 한 칸 앞까지 따라 들어간다. (image.pexels.apiKey 처럼 깊은 것도 있다)
    let node = clean;
    for (const key of keys.slice(0, -1)) node = node?.[key];
    const last = keys[keys.length - 1];
    const value = node?.[last];
    if (typeof value === 'string' && /^[●•*]+$/.test(value.trim())) delete node[last];
  }

  const next = deepMerge(getSettings(), clean);
  ensureDirs();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  // 이미지 API 키가 들어 있는 파일이다. 같은 컴퓨터의 다른 계정에서 못 읽게 한다.
  try {
    fs.chmodSync(SETTINGS_FILE, 0o600);
  } catch {
    // 윈도우 등 권한 모델이 다른 환경에서는 넘어간다.
  }
  cache = next;
  return next;
}

/** 브라우저로 내려보낼 설정. API 키는 값을 빼고 "채워짐" 여부만 남긴다. */
export function publicSettings() {
  const stored = getSettings();
  const settings = structuredClone(stored);
  settings.image.apiKeySet = Boolean(stored.image.apiKey);
  settings.image.apiKey = '';
  settings.image.pexels.apiKeySet = Boolean(stored.image.pexels?.apiKey);
  settings.image.pexels.apiKey = '';
  return settings;
}
