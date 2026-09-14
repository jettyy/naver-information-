import { runClaudeJson } from '../ai/claude.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';
import { normalizeTag } from '../lib/util.js';
import { buildExampleBlock } from './examples.js';
import { detectShape, generateTableRows, ITEM_LIMIT } from './ranking.js';
import { runResearch, buildResearchBlock } from './research.js';
import {
  buildRuleBlock, buildRepairBlock, checkCompliance, countChars, summarize,
} from './quality.js';

const BASE_SYSTEM = [
  '당신은 네이버 블로그 정보성 포스팅 전문 에디터이자 전문 카피라이터입니다.',
  '구글 알고리즘이 "고품질의 정보성 글"로 인식할 만큼 깊이 있고 구조화된 한국어 포스팅을 씁니다.',
  '모든 문장은 "~습니다", "~입니다" 형태의 완전한 종결어미로 끝냅니다.',
  '단순 나열 대신 근거와 맥락을 붙이고, 확실하지 않은 수치나 고유명사는 지어내지 않습니다.',
  '특수문자와 이모지를 쓰지 않고 깔끔한 텍스트로만 씁니다.',
  '요청받은 JSON 형식만 정확히 출력합니다.',
].join(' ');

/**
 * 사용자 지침을 프롬프트 맨 앞에 놓는 블록.
 * 고정 규칙 목록 끝에 한 줄로 붙으면 묻히기 때문에 별도 최상위 섹션으로 올린다.
 *
 * 다만 필수 품질 규칙보다는 아래에 둔다. 이 프로그램의 목적 자체가
 * "검색에 걸리는 정보성 글" 이라서, 규칙을 깨는 지침까지 이기게 하면 프로그램이 무의미해진다.
 */
export function buildGuidelineBlock(guideline) {
  const text = String(guideline || '').trim();
  if (!text) return '';
  return `[사용자 지침 — 반드시 반영할 것]
아래는 사용자가 이 글에 직접 요구한 내용입니다.
일반적인 작성 요령과 충돌하면 이 지침을 우선하세요.
(단, 뒤에 나오는 "필수 준수 규칙"만은 어길 수 없습니다. 둘 다 만족시키세요.)

${text.split('\n').map((line) => (line.trim() ? `- ${line.trim()}` : '')).filter(Boolean).join('\n')}

============================================================

`;
}

/** 프롬프트 맨 끝에서 한 번 더 짚어준다. 마지막에 읽은 지시를 더 잘 따른다. */
function buildGuidelineReminder(guideline) {
  const text = String(guideline || '').trim();
  if (!text) return '';
  return `

============================================================
[마지막 확인 — 사용자 지침을 지켰습니까?]
${text}

출력하기 전에 위 지침을 하나씩 다시 확인하세요.
지키지 못한 항목이 있으면 고쳐서 출력하고, guidelineCheck 필드에
각 지침을 어떻게 반영했는지 한 줄로 적으세요.`;
}

function buildSystemPrompt(guideline) {
  const text = String(guideline || '').trim();
  if (!text) return BASE_SYSTEM;
  return (
    `${BASE_SYSTEM} 사용자가 직접 준 지침이 있으면 그것을 반영하되, ` +
    `필수 준수 규칙은 어떤 경우에도 지킵니다. ` +
    `이번 사용자 지침: ${text.replace(/\s+/g, ' ').slice(0, 500)}`
  );
}

/* ------------------------------------------------------------------ */
/* 프롬프트 조각                                                        */
/* ------------------------------------------------------------------ */

function basicsBlock(settings, topic) {
  const { tone, audience, sectionCount, minChars } = settings.post;
  return [
    '[포스팅 기본 정보]',
    `- 주제: ${topic}`,
    `- 타겟 독자: ${audience}`,
    `- 어조: ${tone}`,
    `- 목표 분량: 공백 제외 ${minChars.toLocaleString()}자 이상 (넘겨도 좋습니다)`,
    `- H2 소제목: ${sectionCount}개 내외`,
  ].join('\n');
}

const THUMBNAIL_BLOCK = `[썸네일]
썸네일은 이미지 생성 AI 가 **글자까지 통째로 그립니다.** 그래서 그림 안에 들어갈
문구를 정확히 정해 주셔야 합니다. 짧고 굵을수록 잘 나옵니다.

- posterLines: 썸네일에 가장 크게 박힐 제목을 **1~3줄로 끊어서** 배열로. 한 줄 12자 이내.
  클릭하고 싶게 쓰되 낚시는 금물입니다.
  예) ["4년제만 답이 아니다", "취업 최강 전문대"]
- ribbon: 제목 아래 띠에 들어갈 한 줄. 12자 이내. 개수와 연도를 넣으면 좋습니다.
  예) "TOP 50 대공개 (2026 최신)"
- subline: 맨 아래 한 줄 요약. 24자 이내. 예) "실무, 자격증, 현장 경험으로 골랐습니다"
- badge: 구석 뱃지에 들어갈 짧은 말. 6자 이내. 예) "전문대"
- keywords: 아이콘 뱃지에 붙일 짧은 분류어 3~5개. 각 5자 이내.
  예) ["간호보건", "반도체", "자동차", "항공", "IT"]
- scene: 배경 그림으로 그릴 장면을 **영어 한 문장**으로. 주제를 상징하는 공간이나 사물.
  사람 얼굴이 크게 나오는 구도와 상표는 피하세요.
  예) "students in a bright technical college workshop with machines and computers"
- accent: 어두운 계열 HEX / style: bold, gradient, minimal, editorial 중 하나
  (이미지 생성이 꺼져 있을 때 쓰는 값입니다)

썸네일 문구에는 특수문자와 이모지를 쓰지 마세요. 느낌표는 한 개까지 허용합니다.
**본문 규칙과 달리 썸네일 문구는 "~습니다" 로 끝내지 않아도 됩니다.** 짧은 것이 우선입니다.`;

function metaBlock() {
  return `[검색 최적화 필드]
- summary: 검색 결과에 뜰 한 줄 요약 (80~120자, "~습니다" 로 끝낼 것)
- tags: 3~6개. 글 맨 끝에 #태그 로 붙습니다. 네이버 태그에는 공백을 넣을 수 없으니
  "국가기술자격증" 처럼 붙여 쓰고, 사람들이 실제로 검색할 만한 말을 고르세요.
- 제목은 검색어가 앞쪽에 오도록 쓰되, 낚시성 표현은 쓰지 마세요.`;
}

/** 표를 한 번에 받아도 되는 글용 JSON 형식 안내. */
function jsonShape({ withItems, withFaq, withCriteria, withTableRows }) {
  const criteria = withCriteria
    ? `\n  "criteria": {
    "heading": "추천 항목을 고른 세 가지 기준",
    "paragraphs": ["기준을 왜 이렇게 잡았는지 설명하는 완전한 문장 2~3개입니다."],
    "items": ["취업률: 최근 채용 공고 수를 기준으로 삼았습니다.", "활용성: 여러 산업에서 통용되는지를 보았습니다."]
  },`
    : '';

  const table = withTableRows
    ? `\n  "table": {"heading":"한눈에 보는 비교표","headers":["구분","항목","핵심 특징","난이도"],"rows":[["1","항목 이름","특징","보통"]],"note":"표 아래 안내 한 줄입니다."},`
    : `\n  "table": {"heading":"한눈에 보는 비교표","headers":["구분","항목","핵심 특징","난이도"],"note":"표 아래 안내 한 줄입니다."},`;

  const section = withItems
    ? `{
      "heading": "1위. 항목 이름",
      "isItem": true,
      "paragraphs": ["이 항목을 왜 먼저 다루는지 설명하는 문단입니다."],
      "subsections": [
        {"heading":"상세 설명","paragraphs":["..."]},
        {"heading":"자격 요건과 난이도","paragraphs":["..."]},
        {"heading":"실제 활용 분야","paragraphs":["..."], "list":["완전한 문장으로 쓴 항목입니다."]},
        {"heading":"장점과 단점","paragraphs":["..."], "list":["장점을 문장으로 씁니다.","단점도 솔직하게 적습니다."]},
        {"heading":"준비 팁","paragraphs":["..."]}
      ]
    }`
    : `{
      "heading": "소제목",
      "paragraphs": ["문단1","문단2"],
      "list": ["핵심 포인트를 완전한 문장으로 정리합니다."],
      "quote": "",
      "subsections": [{"heading":"세부 소제목","paragraphs":["..."]}]
    }`;

  const faq = withFaq
    ? `\n  "faq": [{"question":"자주 묻는 질문입니다.","answer":"두세 문장으로 답합니다."}],`
    : '';

  return `{
  "title": "제목 (낚시성 없이 명확하게, 40자 이내)",
  "summary": "한 줄 요약입니다.",
  "tags": ["태그1","태그2","태그3"],
  "guidelineCheck": "사용자 지침을 어떻게 반영했는지 한 줄 (지침 없으면 \\"\\")",
  "thumbnail": {"posterLines":["큰 제목 1줄","큰 제목 2줄"],"ribbon":"TOP 50 (2026 최신)","headline":"...","subline":"...","badge":"...","keywords":["분류1","분류2","분류3"],"scene":"english scene description","style":"minimal","accent":"#1F3A93"},
  "intro": ["도입 문단1", "도입 문단2", "도입 문단3"],${criteria}${table}
  "sections": [
    ${section}
  ],${faq}
  "outro": ["글 전체를 요약하는 마무리 문단입니다.", "독자를 격려하는 문단입니다."]
}`;
}

function structureGuide(shape, settings, count) {
  const lines = ['[글의 구조]'];
  lines.push('- intro: 독자의 문제 상황에 공감하는 도입부 2~3문단. 인사말 없이 바로 본론으로 들어가세요.');
  if (settings.post.addCriteria) {
    lines.push('- criteria: 어떤 기준으로 골랐는지 밝히는 단락. 이 글의 신뢰도를 만드는 부분이라 반드시 채웁니다.');
  }
  lines.push('- table: 항목을 한눈에 비교하는 표. 열 3~5개.');

  if (shape === 'items') {
    lines.push(
      `- sections: 항목 ${count ? `${count}개` : `${Math.min(5, settings.post.sectionCount + 1)}개 내외`}를 `
      + '각각 하나의 H2 섹션으로 다룹니다. isItem 을 true 로 두세요.',
    );
    lines.push('- 각 항목 섹션에는 H3 세부 소제목을 최소 3개 넣습니다: '
      + '상세 설명 / 자격 요건과 난이도 / 실제 활용(취업) 분야 / 장점과 단점 / 준비 팁');
    lines.push('- 항목마다 단점과 주의점도 솔직하게 적으세요. 장점만 나열하면 광고성 글로 보입니다.');
  } else if (shape === 'table') {
    lines.push(
      `- 이 글의 표는 ${count}개 행짜리로 꽤 큽니다. 본문은 그 표를 읽는 법을 안내하는 역할입니다.`,
    );
    lines.push('- sections: 표를 읽을 때 주의할 점, 항목을 고르는 기준, '
      + '대표 항목 3~4개의 상세 설명으로 나눕니다.');
    lines.push('- 대표 항목 섹션에는 H3 세부 소제목(상세 설명 / 장단점 / 준비 팁)을 붙이세요.');
    lines.push(
      '- 표의 한계를 반드시 짚으세요. 예를 들어 "24위와 25위가 실제로 한 단계 차이라고 '
      + '받아들이면 안 됩니다" 처럼, 순위를 그대로 믿으면 안 되는 이유를 한 문단 이상 쓰세요.',
    );
  } else {
    lines.push(`- sections: H2 소제목 ${settings.post.sectionCount}개. `
      + '각 섹션에 H3 세부 소제목을 1개 이상 붙여 내용을 나눕니다.');
    lines.push('- 최소 한 섹션에는 불렛 포인트 목록(list)을 넣으세요.');
  }

  if (settings.post.addFaq) {
    lines.push('- faq: 독자가 실제로 궁금해할 질문 3개와 답변. 답변도 "~습니다" 로 끝냅니다.');
  }
  lines.push('- outro: 글 전체 내용을 요약하고 독자를 따뜻하게 독려하는 마무리 2문단.');
  return lines.join('\n');
}

/**
 * 사실관계 지침. 조사 자료가 있느냐에 따라 말이 달라져야 한다.
 *
 * 검색 자료를 붙여 놓고 "너는 검색을 못 하니 수치를 쓰지 마라" 라고 하면
 * 모델이 애써 찾아온 수치를 다 버리고 두루뭉술하게 쓴다. 반대로 자료가
 * 없는데 수치를 쓰라고 하면 지어낸다. 그래서 두 경우를 나눈다.
 */
function honestyBlock(hasResearch) {
  const lines = ['[사실관계]'];
  if (hasResearch) {
    lines.push(
      '- 구체적인 수치, 일정, 기준, 제도 내용은 **위 조사 자료에 있는 것만** 쓰세요.',
      '- 조사 자료에 없는 수치는 지어내지 말고 "지역과 시기에 따라 다릅니다" 처럼 여지를 두세요.',
      '- 조사 자료의 "확인하지 못한 내용" 은 단정하지 말고, 확인이 필요하다고 밝히세요.',
      '- 수치를 쓸 때는 기준 시점을 함께 밝히세요. (예: 2026년 기준)',
      '- 본문에 URL 이나 링크를 직접 적지 마세요. 출처 목록은 글 끝에 자동으로 붙습니다.',
    );
  } else {
    lines.push(
      '- 실시간 검색을 하지 못했으므로, 공식 조사 수치나 연도별 통계를 지어내지 마세요.',
      '- 모르는 제도나 금액은 "지역과 시기에 따라 다릅니다" 처럼 정직하게 여지를 두고 쓰세요.',
    );
  }
  const basis = hasResearch ? '공개된 자료' : '일반적으로 알려진 정보';
  lines.push(
    '- 순위는 절대적인 우열이 아니라 "정리한 참고 순서" 로 다루세요.',
    `- table.note 에는 "공식 순위가 아니라 ${basis}를 정리한 참고 자료이며 `
    + '최신 정보는 직접 확인이 필요하다"는 안내를 완전한 문장으로 넣으세요.',
  );
  return lines.join('\n');
}

const FORMAT_BLOCK = [
  '[서식]',
  '- 문단 안에서 핵심 표현 한둘만 <b>강조</b>로 감쌀 수 있습니다. 그 외 HTML 태그는 쓰지 마세요.',
  '- 마크다운 기호(#, *, -, |)를 문자열 안에 직접 넣지 마세요. 구조는 JSON 필드로만 표현합니다.',
  '- 목록 항목과 표 칸도 특수문자 없이 씁니다.',
].join('\n');

/* ------------------------------------------------------------------ */
/* 프롬프트 조립                                                        */
/* ------------------------------------------------------------------ */

function buildMainPrompt(topic, settings, {
  guidelineBlock, exampleBlock, researchBlock, shape, count,
}) {
  const withTableRows = shape !== 'table';   // 큰 표는 뒤에서 따로 채운다.
  const tableHint = withTableRows
    ? `- table.rows 를 ${count ? `${count}개` : '항목 수만큼'} 빠짐없이 채우세요. "이하 생략" 금지.`
    : `- 이 글에는 ${count}개 항목이 들어간 큰 표가 하나 들어갑니다. `
      + '표의 행은 뒤에서 따로 채우므로 지금은 headers 와 heading, note 만 잡고 rows 는 넣지 마세요.';

  return `${guidelineBlock}${basicsBlock(settings, topic)}

위 주제로 네이버 블로그에 올릴 정보성 포스팅 한 편을 써주세요.
${researchBlock ? `\n${researchBlock}` : ''}
${buildRuleBlock(settings, shape)}

${structureGuide(shape, settings, count)}
${tableHint}

${honestyBlock(Boolean(researchBlock))}

${FORMAT_BLOCK}

${metaBlock()}

${THUMBNAIL_BLOCK}
${exampleBlock ? `\n${exampleBlock}\n` : ''}
[출력] JSON 객체 하나만. 설명도 코드 펜스도 붙이지 마세요.

${jsonShape({
    withItems: shape === 'items',
    withFaq: settings.post.addFaq,
    withCriteria: settings.post.addCriteria,
    withTableRows,
  })}

필요 없는 키는 빼도 되지만 title, intro, sections, outro, table 은 반드시 채우세요.${buildGuidelineReminder(settings.post.extraGuideline)}`;
}

/* ------------------------------------------------------------------ */
/* 응답 정규화                                                          */
/* ------------------------------------------------------------------ */

const STYLES = new Set(['bold', 'gradient', 'minimal', 'editorial']);

function toParagraphList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function normalizeTable(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const headers = (Array.isArray(raw.headers) ? raw.headers : [])
    .map((header) => String(header ?? '').trim())
    .filter(Boolean);
  if (headers.length < 2) return null;

  const rows = (Array.isArray(raw.rows) ? raw.rows : [])
    .map((row) => {
      const cells = Array.isArray(row)
        ? row.map((cell) => String(cell ?? '').trim())
        : (row && typeof row === 'object' ? Object.values(row).map((cell) => String(cell ?? '').trim()) : null);
      if (!cells) return null;
      const fixed = cells.slice(0, headers.length);
      while (fixed.length < headers.length) fixed.push('');
      return fixed;
    })
    .filter((row) => row && row.some((cell) => cell));

  return {
    heading: String(raw.heading || '').trim(),
    headers,
    rows,
    note: String(raw.note || '').trim(),
  };
}

function normalizeSubsections(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((sub) => ({
      heading: String(sub?.heading || '').trim(),
      paragraphs: toParagraphList(sub?.paragraphs ?? sub?.body ?? sub?.content),
      list: toParagraphList(sub?.list ?? sub?.items),
    }))
    .filter((sub) => sub.heading && (sub.paragraphs.length || sub.list.length));
}

function normalizeCriteria(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const criteria = {
    heading: String(raw.heading || '추천 항목을 고른 기준').trim(),
    paragraphs: toParagraphList(raw.paragraphs ?? raw.body),
    items: toParagraphList(raw.items ?? raw.list),
  };
  if (!criteria.paragraphs.length && !criteria.items.length) return null;
  return criteria;
}

function normalizeFaq(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((item) => ({
      question: String(item?.question ?? item?.q ?? '').trim(),
      answer: String(item?.answer ?? item?.a ?? '').trim(),
    }))
    .filter((item) => item.question && item.answer)
    .slice(0, 8);
}

export function normalize(raw, topic, settings, shape = 'general') {
  const title = String(raw.title || topic).trim().slice(0, 100);

  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .map((section) => ({
      heading: String(section?.heading || '').trim(),
      isItem: Boolean(section?.isItem),
      paragraphs: toParagraphList(section?.paragraphs ?? section?.body ?? section?.content),
      list: toParagraphList(section?.list ?? section?.items),
      quote: String(section?.quote || '').trim(),
      subsections: normalizeSubsections(section?.subsections ?? section?.sub),
    }))
    .filter((section) => section.heading || section.paragraphs.length);

  const thumb = raw.thumbnail && typeof raw.thumbnail === 'object' ? raw.thumbnail : {};
  const requested = settings.thumbnail.style;
  const style = requested !== 'auto' && STYLES.has(requested)
    ? requested
    : (STYLES.has(thumb.style) ? thumb.style : 'minimal');
  const accent = /^#[0-9a-f]{6}$/i.test(String(thumb.accent || '')) ? thumb.accent : '#16324F';

  const post = {
    topic,
    shape,
    title,
    summary: String(raw.summary || '').trim(),
    guideline: String(settings.post.extraGuideline || '').trim(),
    guidelineCheck: String(raw.guidelineCheck || '').trim(),
    // 네이버 태그에는 공백과 특수문자를 넣을 수 없다. 붙여 쓰고 중복을 걸러낸다.
    tags: [...new Set(
      (Array.isArray(raw.tags) ? raw.tags : [])
        .map((tag) => normalizeTag(tag))
        .filter(Boolean),
    )].slice(0, 8),
    thumbnail: {
      headline: String(thumb.headline || title).trim().slice(0, 40),
      subline: String(thumb.subline || raw.summary || '').trim().slice(0, 60),
      badge: String(thumb.badge || '').trim().slice(0, 12),
      emoji: String(thumb.emoji || '').trim().slice(0, 4),
      // 썸네일에 통째로 그려 넣을 문구들. 이미지 API 를 껐으면 안 쓰인다.
      // 한 줄이 길면 이미지 모델이 글자를 뭉개므로 여기서 잘라 둔다.
      posterLines: (Array.isArray(thumb.posterLines) ? thumb.posterLines : [])
        .map((line) => String(line).trim().slice(0, 20))
        .filter(Boolean)
        .slice(0, 3),
      ribbon: String(thumb.ribbon || '').trim().slice(0, 24),
      keywords: (Array.isArray(thumb.keywords) ? thumb.keywords : [])
        .map((word) => String(word).trim().slice(0, 8))
        .filter(Boolean)
        .slice(0, 5),
      // 배경 그림 생성 프롬프트에 들어갈 장면 설명.
      scene: String(thumb.scene || '').trim().slice(0, 300),
      style,
      accent,
    },
    intro: toParagraphList(raw.intro),
    criteria: settings.post.addCriteria ? normalizeCriteria(raw.criteria) : null,
    table: normalizeTable(raw.table),
    sections,
    faq: settings.post.addFaq ? normalizeFaq(raw.faq) : [],
    outro: toParagraphList(raw.outro),
    // 조사 단계에서 채운다. 글 끝의 출처 목록이 된다.
    sources: [],
    research: null,
    model: '',
    costUsd: 0,
    compliance: null,
    repairs: 0,
  };

  if (!post.intro.length && post.sections.length) {
    // 도입부가 비면 썸네일과 more 태그가 들어갈 자리가 없어진다. 첫 문단을 끌어올린다.
    post.intro = post.sections[0].paragraphs.splice(0, 1);
  }
  if (!post.sections.length) {
    throw new Error('AI 응답에 본문 섹션이 없습니다.');
  }
  return post;
}

/** 보정 요청에 되돌려 보낼 JSON. 내부 관리용 필드는 뺀다. */
function toAiJson(post) {
  const out = {
    title: post.title,
    summary: post.summary,
    tags: post.tags,
    guidelineCheck: post.guidelineCheck,
    thumbnail: post.thumbnail,
    intro: post.intro,
    sections: post.sections.map((section) => ({
      heading: section.heading,
      ...(section.isItem ? { isItem: true } : {}),
      paragraphs: section.paragraphs,
      ...(section.list.length ? { list: section.list } : {}),
      ...(section.quote ? { quote: section.quote } : {}),
      ...(section.subsections.length ? { subsections: section.subsections } : {}),
    })),
    outro: post.outro,
  };
  if (post.criteria) out.criteria = post.criteria;
  if (post.table) out.table = post.table;
  if (post.faq.length) out.faq = post.faq;
  return out;
}

export { countChars };

/* ------------------------------------------------------------------ */
/* 생성                                                                */
/* ------------------------------------------------------------------ */

/**
 * 준수 검사에서 걸린 항목만 짚어 다시 쓰게 한다.
 * 규칙이 통과할 때까지 최대 maxRepairs 번 돈다.
 */
async function repairUntilCompliant(post, { topic, settings, systemPrompt, signal, onProgress }) {
  let current = post;
  current.compliance = checkCompliance(current, settings);

  if (current.compliance.ok || !settings.quality.enforce) return current;

  const limit = Math.max(0, Number(settings.quality.maxRepairs) || 0);
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    logger.warn(
      `[${topic}] 품질 검사 미통과 (${attempt}/${limit} 보정 시도) — `
      + current.compliance.issues.map((issue) => `${issue.label}: ${issue.detail}`).join(' / '),
    );
    onProgress?.(current.compliance);

    const prompt = [
      buildRepairBlock(current.compliance),
      '',
      '============================================================',
      `주제: "${topic}"`,
      '',
      '[현재 글 — 이것을 고쳐서 전체를 다시 출력하세요]',
      JSON.stringify(toAiJson(current), null, 2),
      '',
      buildRuleBlock(settings, current.shape),
      '',
      FORMAT_BLOCK,
      '',
      '[출력] 고친 글 전체를 같은 구조의 JSON 객체 하나로만 출력하세요.',
    ].join('\n');

    let reply;
    try {
      reply = await runClaudeJson(prompt, { systemPrompt, signal });
    } catch (error) {
      logger.warn(`[${topic}] 보정 요청 실패, 원래 글을 그대로 씁니다: ${error.message}`);
      break;
    }

    let repaired;
    try {
      repaired = normalize(reply.data, topic, settings, current.shape);
    } catch (error) {
      logger.warn(`[${topic}] 보정 결과를 읽지 못했습니다: ${error.message}`);
      break;
    }

    repaired.model = reply.model || current.model;
    repaired.costUsd = (current.costUsd || 0) + (reply.costUsd || 0);
    repaired.repairs = attempt;
    // 조사 결과는 글을 고쳐 쓴다고 달라지지 않는다. 그대로 물려준다.
    repaired.sources = current.sources;
    repaired.research = current.research;
    repaired.tableExpected = current.tableExpected;
    repaired.tableMissing = current.tableMissing;
    repaired.compliance = checkCompliance(repaired, settings);

    // 고친 결과가 더 나빠졌다면 되돌린다. (규칙 통과 개수로 판단)
    if (repaired.compliance.passed < current.compliance.passed) {
      logger.warn(`[${topic}] 보정 결과가 오히려 나빠져 이전 글을 유지합니다.`);
      break;
    }
    current = repaired;
    if (current.compliance.ok) {
      logger.info(`[${topic}] 보정 후 준수 검사를 통과했습니다. (${summarize(current.compliance)})`);
      break;
    }
  }

  return current;
}

export async function generatePost(topic, options = {}) {
  const settings = getSettings();
  const guideline = String(settings.post.extraGuideline || '').trim();
  const guidelineBlock = buildGuidelineBlock(guideline);
  const exampleBlock = buildExampleBlock();
  const systemPrompt = buildSystemPrompt(guideline);
  const { shape, count, needsChunking } = detectShape(topic, settings.post.rankTargetCount);

  logger.step(
    `[${topic}] 글 모양: ${
      { items: '항목별 상세형', table: '대형 비교표형', general: '정보 정리형' }[shape]
    }${count ? ` (${count}개 항목)` : ''}`,
  );
  if (guideline) logger.info(`추가 지침 적용: ${guideline.replace(/\s+/g, ' ').slice(0, 120)}`);
  if (exampleBlock) logger.info('참고 예시를 프롬프트에 함께 넣었습니다.');
  if (count && count > ITEM_LIMIT) {
    logger.info(`항목이 ${count}개라 표를 나눠 받고 대표 항목만 상세하게 씁니다.`);
  }

  /* 1단계 — 웹 검색으로 자료를 모은다. (설정에서 끄면 건너뛴다) */
  options.onResearch?.();
  const research = await runResearch(topic, { shape, count, signal: options.signal });
  const researchBlock = research ? buildResearchBlock(research) : '';

  if (settings.research.enabled && settings.research.requireSources
      && !(research?.sources?.length)) {
    throw new Error(
      '웹 검색으로 출처를 구하지 못해 글을 쓰지 않았습니다. '
      + '(설정에서 "출처를 못 구하면 글을 쓰지 않기" 를 끄면 검색 없이도 씁니다)',
    );
  }

  /* 2단계 — 도구를 끄고, 모아온 자료만 보고 글을 쓴다. */
  const reply = await runClaudeJson(
    buildMainPrompt(topic, settings, { guidelineBlock, exampleBlock, researchBlock, shape, count }),
    { systemPrompt, signal: options.signal },
  );

  let post = normalize(reply.data, topic, settings, shape);
  post.model = reply.model || '';
  post.costUsd = (reply.costUsd || 0) + (research?.costUsd || 0);
  post.research = research;
  post.sources = settings.research.showSources ? (research?.sources || []) : [];

  // 큰 표는 본문과 따로, 구간을 나눠 받는다.
  if (needsChunking) {
    const headers = post.table?.headers?.length >= 2
      ? post.table.headers
      : ['순위', '항목', '핵심 특징'];

    const { rows, model, missing } = await generateTableRows({
      topic,
      headers,
      count,
      signal: options.signal,
      onProgress: options.onProgress,
    });

    post.table = {
      heading: post.table?.heading || `${topic} 전체 정리`,
      headers,
      rows,
      note: post.table?.note
        || '이 표는 공식 순위가 아니라 일반적으로 알려진 정보를 정리한 참고 자료이며, '
          + '최신 정보는 직접 확인하시기 바랍니다.',
    };
    post.model = post.model || model || '';
    post.tableExpected = count;
    post.tableMissing = missing;

    if (missing.length) {
      logger.warn(`표에서 ${missing.length}개 행을 끝내 채우지 못했습니다: ${missing.slice(0, 20).join(', ')}`);
    } else {
      logger.info(`표 ${rows.length}개 행을 빠짐없이 채웠습니다.`);
    }
  }

  post = await repairUntilCompliant(post, {
    topic,
    settings,
    systemPrompt,
    signal: options.signal,
    onProgress: options.onCompliance,
  });

  return post;
}
