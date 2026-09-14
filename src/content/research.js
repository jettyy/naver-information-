import { runClaudeJson, WEB_TOOLS } from '../ai/claude.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';

/**
 * 자료 조사 단계.
 *
 * 글쓰기와 조사를 **한 번의 호출로 같이 시키지 않는다.** 도구를 쓰면서
 * 동시에 엄격한 JSON 을 뱉게 하면, 모델이 검색 결과를 설명하는 산문을
 * 앞뒤로 붙여서 JSON 파싱이 자주 깨진다.
 *
 * 그래서 두 단계로 나눈다.
 *   1) 조사: 도구를 켜고 사실과 출처만 모은다 (이 파일)
 *   2) 집필: 도구를 끄고 그 자료만 보고 글을 쓴다 (generator.js)
 *
 * 나눠서 얻는 것이 하나 더 있다. 조사 결과가 파일로 남아서,
 * 발행 전에 "이 글이 무엇을 근거로 썼는지" 사람이 직접 확인할 수 있다.
 */

const RESEARCH_SYSTEM = [
  '당신은 블로그 글을 쓰기 위한 사실 조사를 맡은 리서처입니다.',
  '반드시 WebSearch 도구로 실제 검색을 해서 최신 정보를 확인합니다.',
  '검색으로 확인하지 못한 내용은 사실로 적지 않고 unverified 에 따로 적습니다.',
  '각 사실에는 그 내용을 실제로 본 출처 URL 을 정확히 붙입니다. URL 을 지어내지 않습니다.',
  '요청받은 JSON 형식만 정확히 출력합니다.',
].join(' ');

/** 오늘 날짜를 알려줘야 "최신" 의 기준이 생긴다. */
function today() {
  const now = new Date();
  return `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;
}

function buildResearchPrompt(topic, settings, { count, shape }) {
  const { maxSearches } = settings.research;

  const itemHint = shape === 'items'
    ? `\n- items: 이 주제에서 실제로 다룰 항목 ${count ? `${count}개` : '5개 내외'}를 검색으로 확인해 고르세요. `
      + '각 항목에 대해 검색으로 확인한 사실을 facts 에 최소 1개씩 넣으세요.'
    : '';

  return `오늘은 ${today()} 입니다.

주제: "${topic}"

이 주제로 블로그 글을 쓰려고 합니다. **글을 쓰지 마세요.**
글쓴이가 참고할 **사실 자료**만 검색해서 모아 주세요.

[조사 방법]
- WebSearch 로 실제 검색을 ${maxSearches}회 이내로 하세요. 검색 없이 기억으로 답하지 마세요.
- 최신 정보를 우선합니다. ${new Date().getFullYear()}년과 ${new Date().getFullYear() - 1}년 자료를 먼저 찾으세요.
- 공식 출처(정부기관, 공공기관, 공식 통계, 주관 기관 공지)를 민간 블로그보다 우선하세요.
- 중요한 수치는 가능하면 두 곳 이상에서 확인하세요.
- 원문을 더 봐야 할 때만 WebFetch 로 그 페이지를 여세요.${itemHint}

[적을 것]
- facts: 글에 쓸 수 있는 구체적 사실. 수치, 기준, 일정, 제도 내용 위주로.
  각 사실에 그 내용을 실제로 확인한 출처 URL 과 자료 날짜를 붙이세요.
- sources: 참고한 출처 목록. 실제로 검색 결과에 나온 URL 만 적으세요.
- unverified: 찾아봤지만 확실하지 않거나 출처가 엇갈린 내용. 글쓴이가 조심하도록.
- freshness: 이 주제의 정보가 얼마나 최신인지 한 줄 평가.

[중요]
- **URL 을 지어내지 마세요.** 검색 결과에 실제로 나온 주소만 적습니다.
- 검색으로 확인하지 못했으면 facts 에 넣지 말고 unverified 로 보내세요.
- 사실만 적고 의견이나 홍보 문구는 적지 마세요.

[출력] JSON 객체 하나만. 설명도 코드 펜스도 붙이지 마세요.

{
  "summary": "조사해 보니 어떤 상황인지 2~3문장 요약입니다.",
  "freshness": "최신 정보 상태 한 줄 평가입니다.",
  "items": ["검색으로 확인해 고른 항목 이름"],
  "facts": [
    {"claim":"핵심 사실 한 문장","detail":"수치와 조건 등 구체적인 내용","source":"출처 이름","url":"https://...","date":"2026-03"}
  ],
  "sources": [
    {"title":"자료 제목","publisher":"발행처","url":"https://...","date":"2026-03"}
  ],
  "unverified": ["확인하지 못한 내용과 그 이유"]
}`;
}

/* ------------------------------------------------------------------ */
/* 정규화                                                              */
/* ------------------------------------------------------------------ */

/** 실제로 열어볼 수 있는 http(s) 주소인지. 모델이 지어낸 가짜 주소를 거른다. */
export function isUsableUrl(value) {
  const text = String(value || '').trim();
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const url = new URL(text);
    // 점 없는 호스트(example, localhost)나 자리표시자 주소는 버린다.
    if (!url.hostname.includes('.')) return false;
    if (/^(example|test|sample)\.(com|org|net)$/i.test(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

const text = (value, max = 400) => String(value ?? '').trim().slice(0, max);

function normalizeFacts(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((fact) => ({
      claim: text(fact?.claim ?? fact?.fact, 300),
      detail: text(fact?.detail ?? fact?.note, 600),
      source: text(fact?.source ?? fact?.publisher, 120),
      url: isUsableUrl(fact?.url) ? String(fact.url).trim() : '',
      date: text(fact?.date, 40),
    }))
    .filter((fact) => fact.claim)
    .slice(0, 40);
}

function normalizeSources(raw, facts) {
  const seen = new Set();
  const list = [];

  const add = (entry) => {
    if (!isUsableUrl(entry.url)) return;
    const key = entry.url.replace(/[?#].*$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push(entry);
  };

  for (const source of Array.isArray(raw) ? raw : []) {
    add({
      title: text(source?.title, 160) || text(source?.publisher, 160) || '참고 자료',
      publisher: text(source?.publisher, 80),
      url: String(source?.url || '').trim(),
      date: text(source?.date, 40),
    });
  }
  // sources 를 비우고 facts 에만 URL 을 적어 보내는 경우가 있어 주워 담는다.
  for (const fact of facts) {
    add({ title: fact.source || '참고 자료', publisher: fact.source, url: fact.url, date: fact.date });
  }
  return list.slice(0, 20);
}

function normalize(raw) {
  const facts = normalizeFacts(raw?.facts);
  return {
    summary: text(raw?.summary, 800),
    freshness: text(raw?.freshness, 300),
    items: (Array.isArray(raw?.items) ? raw.items : []).map((item) => text(item, 120)).filter(Boolean).slice(0, 30),
    facts,
    sources: normalizeSources(raw?.sources, facts),
    unverified: (Array.isArray(raw?.unverified) ? raw.unverified : [])
      .map((item) => text(item, 300)).filter(Boolean).slice(0, 15),
    searches: 0,
    model: '',
    costUsd: 0,
  };
}

/* ------------------------------------------------------------------ */
/* 프롬프트에 넣을 자료 블록                                             */
/* ------------------------------------------------------------------ */

/** 집필 단계 프롬프트에 끼워 넣을 조사 자료. */
export function buildResearchBlock(research) {
  if (!research?.facts?.length && !research?.summary) return '';

  const lines = [
    '[조사 자료 — 웹 검색으로 확인한 내용입니다]',
    '아래는 이 글을 쓰기 직전에 실제로 검색해서 모은 자료입니다.',
    '**구체적인 수치, 일정, 기준, 제도 내용은 반드시 이 자료에 있는 것만 쓰세요.**',
    '자료에 없는 수치는 지어내지 말고 "지역과 시기에 따라 다릅니다" 처럼 여지를 두고 쓰세요.',
    '',
  ];

  if (research.summary) lines.push(`상황 요약: ${research.summary}`, '');
  if (research.freshness) lines.push(`정보 최신성: ${research.freshness}`, '');

  if (research.items.length) {
    lines.push('검색으로 확인한 항목:', research.items.map((item) => `- ${item}`).join('\n'), '');
  }

  if (research.facts.length) {
    lines.push('확인된 사실:');
    research.facts.forEach((fact, index) => {
      const meta = [fact.source, fact.date].filter(Boolean).join(', ');
      lines.push(
        `${index + 1}. ${fact.claim}`
        + (fact.detail ? `\n   내용: ${fact.detail}` : '')
        + (meta ? `\n   출처: ${meta}` : ''),
      );
    });
    lines.push('');
  }

  if (research.unverified.length) {
    lines.push(
      '확인하지 못한 내용 (단정해서 쓰지 마세요):',
      research.unverified.map((item) => `- ${item}`).join('\n'),
      '',
    );
  }

  if (research.sources.length) {
    lines.push(
      `참고 출처 ${research.sources.length}건은 글 끝에 자동으로 붙습니다. `
      + '본문에 URL 을 직접 적지 마세요.',
      '',
    );
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 실행                                                                */
/* ------------------------------------------------------------------ */

/**
 * 주제 하나에 대해 웹 검색으로 자료를 모은다.
 *
 * 실패해도 예외를 던지지 않는다. 조사는 글의 품질을 높이는 장치이지
 * 글을 못 쓰게 만드는 관문이 아니다. 실패하면 빈 자료를 돌려주고,
 * 글쓰기는 검색 없이 이어간다. (설정에서 requireSources 를 켜면 그때만 막는다)
 *
 * @returns {Promise<object|null>}
 */
export async function runResearch(topic, { shape, count, signal } = {}) {
  const settings = getSettings();
  if (!settings.research.enabled) return null;

  logger.step(`[${topic}] 웹 검색으로 자료를 모으는 중...`);

  let reply;
  try {
    reply = await runClaudeJson(
      buildResearchPrompt(topic, settings, { shape, count }),
      {
        systemPrompt: RESEARCH_SYSTEM,
        tools: WEB_TOOLS,
        timeoutMs: settings.research.timeoutMs,
        signal,
      },
    );
  } catch (error) {
    if (error.rateLimited || /중지했습니다/.test(error.message)) throw error;
    logger.warn(`[${topic}] 자료 조사에 실패해 검색 없이 글을 씁니다: ${error.message}`);
    return null;
  }

  const research = normalize(reply.data);
  research.searches = reply.searches || 0;
  research.model = reply.model || '';
  research.costUsd = reply.costUsd || 0;
  research.at = new Date().toISOString();

  // 검색을 한 번도 안 돌렸다면 "검색했다고 말만 한" 결과다. 그대로 믿으면 안 된다.
  if (!research.searches) {
    logger.warn(
      `[${topic}] 웹 검색이 실제로 실행되지 않았습니다. `
      + '모아온 내용은 검색 결과가 아니라 모델이 아는 내용일 수 있으니 발행 전에 꼭 확인하세요.',
    );
  }

  logger.info(
    `[${topic}] 자료 조사 완료 — 검색 ${research.searches}회, `
    + `사실 ${research.facts.length}건, 출처 ${research.sources.length}건`
    + `${research.unverified.length ? `, 미확인 ${research.unverified.length}건` : ''}`,
  );
  if (research.freshness) logger.info(`[${topic}] 정보 최신성: ${research.freshness}`);

  return research;
}
