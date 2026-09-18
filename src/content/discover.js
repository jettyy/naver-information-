import { runClaudeJson, WEB_TOOLS } from '../ai/claude.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';
import { recentTopics, seenKeys, topicKey } from '../lib/history.js';
import { isUsableUrl } from './research.js';

/**
 * 주제 발굴 단계.
 *
 * 원래 이 프로그램은 사람이 붙여넣은 주제 목록을 받아서 썼다.
 * 여기서는 그 앞에 단계가 하나 더 붙는다. **큰 주제 하나**만 받아서
 * 웹 검색으로 최신 정보를 훑고, 그중에서 지금 사람들이 가장 많이
 * 찾아볼 만한 것을 골라 글 주제로 만든다.
 *
 * 글을 쓰는 방식은 바뀌지 않는다. 여기서 고른 주제는 그대로
 * 기존 파이프라인(자료 조사 → 집필 → 준수 검사 → 썸네일 → 임시저장)으로 넘어간다.
 * 이 파일이 하는 일은 "무엇에 대해 쓸지" 를 정하는 것뿐이다.
 *
 * 조사(research.js)와 마찬가지로 **검색과 집필을 섞지 않는다.**
 * 여기서는 주제 목록만 받아 오고, 글에 쓸 사실은 나중에 주제별로 다시 조사한다.
 */

const DISCOVER_SYSTEM = [
  '당신은 블로그 편집자입니다. 지금 사람들이 무엇을 검색하는지 찾아 글감을 고릅니다.',
  '반드시 WebSearch 도구로 실제 검색을 해서 최신 정보를 확인합니다.',
  '검색으로 확인하지 못한 소재는 고르지 않습니다. 없는 제도나 일정을 지어내지 않습니다.',
  '요청받은 JSON 형식만 정확히 출력합니다.',
].join(' ');

function today() {
  const now = new Date();
  return `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;
}

/**
 * 이미 다룬 주제를 프롬프트에 적어 준다.
 *
 * 이게 없으면 같은 큰 주제로 열 번 돌렸을 때 열 번 다 비슷한 글이 나온다.
 * 큰 주제가 좁을수록(예: "전기차 보조금") 금방 소재가 겹치기 때문에
 * "다른 각도로 찾으라" 는 지시를 함께 붙인다.
 */
function buildAvoidBlock(bigTopic) {
  const used = recentTopics(bigTopic, 60);
  if (!used.length) return '';
  return [
    '',
    '[이미 글을 쓴 주제 — 겹치는 것을 고르지 마세요]',
    ...used.map((topic) => `- ${topic}`),
    '',
    '위 목록과 소재가 같으면 제목만 바꿔서 내지 마세요. 다른 소재를 찾거나,',
    '같은 제도라도 **다른 각도**(신청 방법 / 달라진 점 / 대상별 차이 / 흔한 실수)로 잡으세요.',
  ].join('\n');
}

export function buildDiscoverPrompt(bigTopic, settings, want) {
  const { maxSearches, recencyDays, region } = settings.discover;
  const year = new Date().getFullYear();

  return `오늘은 ${today()} 입니다.

큰 주제: "${bigTopic}"

이 큰 주제와 관련된 **최신 정보**를 웹에서 찾아서, 그중 지금 사람들이 가장 많이
찾아보고 클릭할 만한 것으로 블로그 글 주제 ${want}개를 골라 주세요.
**글은 쓰지 마세요.** 주제 목록만 만들면 됩니다.

[찾는 방법]
- WebSearch 로 실제 검색을 ${maxSearches}회 이내로 하세요. 검색 없이 기억으로 답하지 마세요.
- **최근 ${recencyDays}일 이내**에 나온 정보를 우선합니다. 없으면 ${year}년 자료까지 넓히세요.
- 검색어를 **바꿔 가며 여러 각도로** 찾으세요. 한 검색어로는 한 종류의 결과만 나옵니다.
  예: "${bigTopic} 최신 뉴스", "${bigTopic} ${year} 개편", "${bigTopic} 신청 방법",
  "${bigTopic} 달라지는 점", "${bigTopic} 지원금", "${bigTopic} 논란"
- 대상 독자는 ${region} 독자입니다.
- 공식 출처(정부기관, 공공기관, 주관 기관 공지, 주요 언론)를 우선하세요.

[무엇을 고를 것인가 — 조회수가 나오는 주제]
사람들이 많이 눌러 보는 글에는 공통점이 있습니다. 아래 순서로 우선하세요.

1. **지금 막 바뀐 것** — 제도 개편, 새 정책, 요금·금리 변동, 일정 발표, 시행일이 정해진 것
2. **내 돈·시간·자격이 걸린 것** — 신청 방법, 지원 대상, 지급액, 마감일, 자격 요건, 과태료
3. **검색창에 그대로 칠 만한 것** — 사람들이 실제로 입력할 말이 분명한 소재
4. **아직 정리된 글이 적은 것** — 뉴스는 많은데 "그래서 어떻게 하면 되는지" 정리한 글이 없는 소재
5. **기한이 임박한 것** — 이번 달, 이번 분기에 마감되거나 시작되는 것

[고르지 말아야 할 것]
- 하루 지나면 아무도 안 찾는 단발성 가십, 연예인 사생활, 특정 개인 신상
- 정치적 진영 다툼, 자극적인 사건·사고, 확인되지 않은 의혹
- 의료·금융에서 **단정적인 효과나 수익을 약속**하는 소재 (네이버가 광고성 글로 봅니다)
- 검색으로 근거를 못 찾은 소재. 근거가 없으면 글쓰기 단계에서 어차피 거절당합니다
- 성인·도박·무기 등 네이버 블로그에서 제재받는 분야
- 특정 업체·상품을 밀어 주는 소재. 협찬 없이 써도 광고성 글로 분류됩니다
${buildAvoidBlock(bigTopic)}
[주제를 어떤 문장으로 쓸 것인가]
- 그대로 글 제목이 될 수 있는 **한 문장**으로 쓰세요. 짧은 키워드는 안 됩니다.
  (나쁜 예: "전기차 보조금" / 좋은 예: "${year}년 전기차 보조금, 지역별로 얼마나 달라졌을까")
- 항목을 나열하는 글이면 **개수를 문장에 넣으세요** ("TOP 5", "7가지").
  개수가 들어가면 항목마다 상세 설명을 나눠 쓰는 형식으로 작성됩니다.
- 연도나 시점이 중요한 소재면 문장에 넣으세요 ("${year}년", "${new Date().getMonth() + 1}월부터").
- 과장하거나 낚는 표현("충격", "경악", "이것만 알면")은 쓰지 마세요. 네이버 검색에서 불리합니다.

[각 주제마다 적을 것]
- topic: 위 규칙을 지킨 글 제목 한 문장
- why: 지금 왜 이걸 찾는 사람이 많은지 한 줄
- score: 0~100 사이의 관심도 점수. 근거 없이 전부 90점을 주지 마세요.
  최신성·검색 수요·실생활 영향을 함께 보고 서로 다른 점수를 매기세요
- searchTerms: 사람들이 실제로 검색창에 칠 만한 말 2~4개
- freshness: 근거가 된 정보가 언제 것인지 (예: "2026-09 보도자료")
- sources: 이 주제의 근거가 된 실제 URL 1~3개 (검색 결과에 나온 주소만. 지어내지 마세요)

[출력] JSON 객체 하나만. 설명도 코드 펜스도 붙이지 마세요.

{
  "landscape": "이 큰 주제에서 지금 무슨 일이 벌어지고 있는지 2~3문장 요약입니다.",
  "picks": [
    {
      "topic": "글 제목이 될 한 문장",
      "why": "지금 사람들이 이걸 찾는 이유 한 줄",
      "score": 82,
      "searchTerms": ["검색어1", "검색어2"],
      "freshness": "2026-09",
      "sources": ["https://..."]
    }
  ]
}`;
}

/* ------------------------------------------------------------------ */
/* 정규화                                                              */
/* ------------------------------------------------------------------ */

const text = (value, max = 200) => String(value ?? '').trim().slice(0, max);

/** 낚시성·과장 표현. 네이버 검색에 불리해서 제목에서 걷어낸다. */
const CLICKBAIT = /(충격|경악|소름|헉|대박|난리|발칵|이것만|무조건|100%\s*보장|절대\s*실패)/;

export function normalizePick(raw) {
  const topic = text(raw?.topic ?? raw?.title, 120)
    .replace(/^["'\s-]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!topic) return null;

  const score = Number(raw?.score);
  return {
    topic,
    why: text(raw?.why ?? raw?.reason, 300),
    // 점수를 안 주거나 이상한 값을 준 경우에도 순서는 정해져야 한다.
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 50,
    searchTerms: (Array.isArray(raw?.searchTerms) ? raw.searchTerms : [])
      .map((term) => text(term, 60)).filter(Boolean).slice(0, 6),
    freshness: text(raw?.freshness, 60),
    sources: (Array.isArray(raw?.sources) ? raw.sources : [])
      .map((url) => String(url || '').trim())
      .filter(isUsableUrl)
      .slice(0, 3),
  };
}

/**
 * 걸러내기.
 *
 * 모델은 같은 소재를 제목만 바꿔서 여러 번 내놓는다. 한 번에 받은 목록
 * 안에서도 겹치고, 어제 쓴 것과도 겹친다. 두 가지를 모두 본다.
 */
export function screenPicks(picks, { minScore = 0, seen = new Set() } = {}) {
  const kept = [];
  const dropped = { duplicate: 0, lowScore: 0, clickbait: 0, tooShort: 0 };

  for (const pick of picks) {
    if (pick.topic.length < 8) { dropped.tooShort += 1; continue; }
    if (CLICKBAIT.test(pick.topic)) { dropped.clickbait += 1; continue; }
    if (pick.score < minScore) { dropped.lowScore += 1; continue; }

    const key = topicKey(pick.topic);
    if (seen.has(key)) { dropped.duplicate += 1; continue; }
    seen.add(key);
    kept.push(pick);
  }

  kept.sort((a, b) => b.score - a.score);
  return { kept, dropped };
}

/**
 * 검색으로 아무 것도 못 건졌을 때, 큰 주제 자체로 글감을 만든다.
 *
 * 마지막 수단이다. 모델이 후보를 하나도 안 주거나 전부 걸러졌을 때,
 * 빈손으로 돌아가면 그 주문이 중단된다. 관련도가 좀 낮더라도 글이 나오는
 * 편이 낫다는 판단으로, 큰 주제에 각도를 붙여 제목을 만든다.
 *
 * 각도를 여러 개 두는 이유는 같은 제목만 계속 만들어 내지 않기 위해서다.
 * 이미 쓴 제목은 건너뛴다.
 */
export function buildFallbackTopics(bigTopic, want, seen = new Set()) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const angles = [
    '총정리',
    '한눈에 보기',
    '올해 달라진 점 정리',
    '자주 묻는 질문 정리',
    '처음 찾아보는 분들을 위한 정리',
    '알아두면 도움 되는 점 정리',
  ];

  const limit = Math.max(1, want);
  const make = (title) => ({
    topic: title,
    why: '검색으로 새 소재를 찾지 못해 큰 주제로 직접 만든 글감입니다.',
    score: 0,
    searchTerms: [bigTopic],
    freshness: '',
    sources: [],
  });

  const out = [];
  // 연도만 붙인 제목 -> 그것도 다 썼으면 월까지 붙여 다른 제목을 만든다.
  for (const prefix of [`${year}년`, `${year}년 ${month}월`]) {
    for (const angle of angles) {
      if (out.length >= limit) break;
      const title = `${bigTopic} ${angle}`.trim();
      const full = `${prefix} ${title}`;
      if (seen.has(topicKey(full))) continue;
      seen.add(topicKey(full));
      out.push(make(full));
    }
    if (out.length >= limit) break;
  }

  // 그래도 하나도 없으면 겹치는 것을 그대로 쓴다.
  // 여기서 빈손으로 돌아가면 주문이 중단된다. 겹치는 글이 낫다.
  if (!out.length) out.push(make(`${year}년 ${month}월 ${bigTopic} 총정리`));
  return out;
}

/* ------------------------------------------------------------------ */
/* 실행                                                                */
/* ------------------------------------------------------------------ */

/**
 * 큰 주제 하나로 글 주제 여러 개를 발굴한다.
 *
 * 실패하면 예외를 던진다. 조사(research)와 달리 여기서 실패하면
 * 쓸 주제 자체가 없어서 다음 단계로 넘어갈 수가 없다.
 *
 * @param {string} bigTopic  사용자가 입력한 큰 주제
 * @param {object} options
 * @param {number} options.want      몇 개를 받아올지 (기본: 설정의 batchSize)
 * @param {string[]} options.exclude 이번 호출에서만 추가로 제외할 주제
 * @returns {Promise<{picks: object[], landscape: string, searches: number, dropped: object}>}
 */
export async function discoverTopics(bigTopic, { want, exclude = [], signal } = {}) {
  const settings = getSettings();
  const topic = String(bigTopic || '').trim();
  if (!topic) throw new Error('큰 주제가 비어 있습니다. 2번 칸에 주제를 입력해 주세요.');

  // 걸러내는 과정에서 절반 넘게 빠지는 일이 흔하다. 넉넉히 달라고 한다.
  const target = Math.max(1, want || settings.discover.batchSize);
  const ask = Math.min(20, Math.max(target + 2, Math.ceil(target * 1.6)));

  logger.step(`[${topic}] 최신 정보에서 글 주제를 찾는 중... (${ask}개 요청)`);

  const reply = await runClaudeJson(
    buildDiscoverPrompt(topic, settings, ask),
    {
      systemPrompt: DISCOVER_SYSTEM,
      tools: WEB_TOOLS,
      timeoutMs: settings.discover.timeoutMs,
      signal,
    },
  );

  const raw = (Array.isArray(reply.data?.picks) ? reply.data.picks : [])
    .map(normalizePick)
    .filter(Boolean);

  /*
   * 걸러내기 — 다 걸러졌다고 빈손으로 돌아오지 않는다.
   *
   * 예전에는 한 번만 거르고 끝냈다. 그런데 비슷한 큰 주제를 여러 개 걸어두면
   * (대학 순위 / 대학 서열 / 학과 순위 …) 기록이 쌓일수록 "이미 쓴 주제" 에
   * 전부 걸려서 0건이 되고, 두 번 연속 0건이면 그 주문이 통째로 중단됐다.
   * 실제로 주문 20건이 전부 "새 주제를 찾지 못했습니다" 로 멈춘 적이 있다.
   *
   * 같은 소재를 다시 써도 되고, 관련도가 좀 낮아도 글이 나오는 편이 낫다.
   * 그래서 조건을 한 단계씩 풀어 가며 반드시 뭐라도 건져 온다.
   *   1) 원래 조건 (이미 쓴 주제 제외 + 관심도 점수 하한)
   *   2) 이미 쓴 주제 허용 (대기열에 있는 것만 제외 — 그건 어차피 중복이라)
   *   3) 관심도 점수 하한까지 해제
   *   4) 그래도 없으면 큰 주제로 글감을 직접 만든다
   */
  const historyKeys = seenKeys();
  const queueKeys = new Set(exclude.map((item) => topicKey(item)));
  const allSeen = new Set([...historyKeys, ...queueKeys]);
  const { minScore } = settings.discover;

  let { kept, dropped } = screenPicks(raw, { minScore, seen: new Set(allSeen) });
  let relaxed = '';

  if (!kept.length && raw.length) {
    ({ kept, dropped } = screenPicks(raw, { minScore, seen: new Set(queueKeys) }));
    if (kept.length) relaxed = '이미 쓴 주제 허용';
  }
  if (!kept.length && raw.length) {
    ({ kept, dropped } = screenPicks(raw, { minScore: 0, seen: new Set(queueKeys) }));
    if (kept.length) relaxed = '이미 쓴 주제 + 낮은 관심도 허용';
  }
  if (!kept.length) {
    kept = buildFallbackTopics(topic, target, allSeen);
    if (kept.length) relaxed = '큰 주제로 직접 만듦';
  }

  if (relaxed) {
    logger.warn(
      `[${topic}] 조건에 맞는 새 소재가 없어 **${relaxed}** 로 ${kept.length}건을 골랐습니다. `
      + '같은 소재를 다른 각도로 쓰게 됩니다.',
    );
  }

  const picks = kept.slice(0, target).map((pick) => ({
    ...pick,
    bigTopic: topic,
    discoveredAt: new Date().toISOString(),
  }));

  // 검색을 한 번도 안 돌렸다면 "검색했다고 말만 한" 결과다.
  // 최신 정보로 고른 주제가 아니니 그대로 믿으면 안 된다.
  if (!reply.searches) {
    logger.warn(
      `[${topic}] 웹 검색이 실제로 실행되지 않았습니다. `
      + '고른 주제가 최신 정보가 아니라 모델이 아는 내용일 수 있습니다. '
      + '2번 칸의 [주제 찾아보기]로 결과를 먼저 확인해 보세요.',
    );
  }

  const dropText = Object.entries(dropped)
    .filter(([, count]) => count)
    .map(([reason, count]) => `${{
      duplicate: '중복', lowScore: '점수미달', clickbait: '낚시성', tooShort: '너무짧음',
    }[reason]} ${count}건`)
    .join(', ');

  logger.info(
    `[${topic}] 주제 발굴 완료 — 검색 ${reply.searches}회, `
    + `받은 후보 ${raw.length}건 중 ${picks.length}건 채택`
    + `${dropText ? ` (제외: ${dropText})` : ''}`,
  );
  if (reply.data?.landscape) logger.info(`[${topic}] 지금 상황: ${text(reply.data.landscape, 400)}`);
  for (const pick of picks) {
    logger.info(`[${topic}] 채택 (${pick.score}점) ${pick.topic} — ${pick.why}`);
  }

  return {
    picks,
    landscape: text(reply.data?.landscape, 800),
    searches: reply.searches || 0,
    model: reply.model || '',
    received: raw.length,
    dropped,
    relaxed,     // 조건을 풀어서 골랐으면 그 이유. 화면과 로그에 그대로 띄운다.
  };
}
