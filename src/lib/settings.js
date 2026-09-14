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

  // 썸네일 이미지 생성 API
  image: {
    enabled: false,              // 켜려면 API 키가 필요하다. 기본은 꺼짐.
    provider: 'google',          // 현재는 구글(Gemini API)만
    apiKey: '',                  // aistudio.google.com 에서 발급

    // full    — 글자까지 포함한 완성 썸네일을 API 가 통째로 그린다
    // overlay — 글자 없는 배경만 API 가 그리고 한글은 HTML 이 얹는다 (싸고 안전)
    mode: 'full',

    // 비워두면 **자동**. 계정에서 쓸 수 있는 이미지 모델 중 언제나 가장 싼 것부터 쓴다.
    model: '',
    modelCacheHours: 24,         // 모델 목록을 다시 받아오는 주기

    // full 모드에서 글자가 깨졌는지 이미지를 다시 읽어 확인한다.
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
    insert: true,                // 도입부 뒤에 그림으로 넣기
    emoji: false,                // 정보성 글은 기호를 자제하는 편이 안전하다
  },

  // 실행
  run: {
    delayMinSec: 30,             // 네이버는 연속 자동화에 민감해서 워드프레스보다 길게 잡는다.
    delayMaxSec: 90,
    maxRetries: 1,
    // 연속으로 이만큼 실패하면 실행을 멈춘다. 0 이면 **멈추지 않고 끝까지** 간다.
    stopAfterFailures: 0,
    headless: false,             // 네이버는 창을 띄우는 편이 더 안전하다.
    slowMoMs: 0,                 // 동작 사이 지연 (디버깅용)
    screenshotOnError: true,     // 자동화가 실패하면 화면을 찍어 둔다
    chromiumPath: '',            // 쓸 크로미움 경로 (비우면 자동)
  },
};

/** 대시보드로 내보내면 안 되는 값. 화면에는 채워졌는지만 알려준다. */
const SECRET_PATHS = [['image', 'apiKey']];

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
  for (const [group, key] of SECRET_PATHS) {
    const value = clean?.[group]?.[key];
    if (typeof value === 'string' && /^[●•*]+$/.test(value.trim())) delete clean[group][key];
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
  return settings;
}
