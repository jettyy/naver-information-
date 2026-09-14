/**
 * 정보성 글 품질 규칙 모듈.
 *
 * 규칙 자체는 워드프레스판(워프러시)의 애드센스 승인 기준을 그대로 가져왔습니다.
 * "깊이 있고 구조화된 정보성 글" 을 만드는 조건이라서 네이버에서도 똑같이 유효하고,
 * 네이버 검색(C-Rank·DIA)도 같은 것을 봅니다. 여기에 네이버에서만 의미 있는
 * 태그 규칙을 하나 더 붙였습니다.
 *
 * 여기 한 곳에 "무엇을 지켜야 하는가" 를 적어 두고
 *   - 프롬프트에 넣을 지시문   (buildRuleBlock)
 *   - 결과물을 실제로 검사     (checkCompliance)
 * 두 가지를 같은 정의에서 만들어 낸다. 지시와 검사가 따로 놀면
 * "규칙은 넣었는데 안 지켜진 글" 이 그대로 저장되기 때문이다.
 *
 * 검사에서 걸린 항목은 generator 가 그 항목만 짚어 한 번 더 고쳐 쓰게 한다.
 */

/* ------------------------------------------------------------------ */
/* 본문에서 글자 뽑아내기                                                */
/* ------------------------------------------------------------------ */

/** 문단/목록처럼 '문장'으로 판단할 부분만 모은다. (제목·표는 제외) */
export function sentenceSources(post) {
  const out = [];
  const pushAll = (list) => (list || []).forEach((text) => out.push(String(text)));

  pushAll(post.intro);
  if (post.criteria) {
    pushAll(post.criteria.paragraphs);
    pushAll(post.criteria.items);
  }
  for (const section of post.sections || []) {
    pushAll(section.paragraphs);
    pushAll(section.list);
    if (section.quote) out.push(section.quote);
    for (const sub of section.subsections || []) {
      pushAll(sub.paragraphs);
      pushAll(sub.list);
    }
  }
  for (const item of post.faq || []) out.push(item.answer);
  pushAll(post.outro);
  return out.filter((text) => text.trim());
}

/** 표·제목까지 포함한 글 전체 텍스트. 분량과 기호 검사에 쓴다. */
export function allText(post) {
  const out = [...sentenceSources(post)];
  out.push(post.title || '');
  if (post.criteria?.heading) out.push(post.criteria.heading);
  for (const section of post.sections || []) {
    out.push(section.heading || '');
    for (const sub of section.subsections || []) out.push(sub.heading || '');
  }
  for (const item of post.faq || []) out.push(item.question || '');
  if (post.table) {
    out.push(post.table.heading || '', post.table.note || '');
    for (const row of post.table.rows || []) out.push(...row);
  }
  return out.join('\n');
}

/** 규칙의 "공백 제외 1,800자" 를 그대로 센다. */
export function countChars(post) {
  return allText(post)
    .replace(/<\/?(b|strong|em|i)>/gi, '')
    .replace(/\s+/gu, '')
    .length;
}

/** 문장 단위로 자른다. 한국어 종결어미 검사용. */
function splitSentences(texts) {
  const sentences = [];
  for (const text of texts) {
    for (const piece of String(text).split(/(?<=[.!?])\s+|\n+/)) {
      const trimmed = piece.replace(/<\/?(b|strong|em|i)>/gi, '').trim();
      if (trimmed.length >= 6) sentences.push(trimmed);
    }
  }
  return sentences;
}

/* ------------------------------------------------------------------ */
/* 금지 기호                                                            */
/* ------------------------------------------------------------------ */

// 글을 "정돈되지 않은 글" 로 보이게 만드는 장식 기호들.
// 물결표(~)는 "40~60%" 처럼 정상적으로 쓰이므로 넣지 않는다.
const BANNED_SYMBOLS = /[★☆◆◇■□▣▶▷◀◁●◎※♥♡♣♠✓✔✗✘✦✧✨➡⇒→←↑↓＊]/u;
const EMOJI = /\p{Extended_Pictographic}/u;

// 서론 맨 앞에 오면 안 되는 인사말·메타 안내 문장.
const GREETING = /^(안녕하세요|반갑습니다|여러분|오늘은|이번\s*(포스팅|글|시간)|금일|본\s*포스팅|이\s*글에서는|지난\s*시간에)/;
const META_SENTENCE = /(알아보(겠습니다|도록 하겠습니다)|살펴보(겠습니다|도록 하겠습니다)|정리해\s*보(겠습니다|았습니다)|준비했습니다)\s*[.!]?\s*$/;

/**
 * 규칙이 요구하는 '하십시오체' 종결어미.
 *
 * "습니다 / 입니다" 만 찾으면 "바랍니다", "드립니다", "만듭니다" 처럼
 * 모음으로 끝나는 어간에 -ㅂ니다 가 붙은 정상적인 문장을 전부 위반으로 잡는다.
 * 그래서 받침 형태를 따지지 않고 '니다 / 니까 / 십시오' 로 끝나는지만 본다.
 * '~해요체'(해요, 예요)와 '~다' 반말은 여기에 걸리지 않는다.
 */
const FORMAL_ENDING = /(니다|니까|십시오)\s*[.!?"'」』)\]]*$/;

// "~함 / ~임 / ~됨" 개조식(메모식). 규칙에서 명시적으로 금지한다.
const MEMO_TAIL = /([가-힣]{2,12})(함|됨|임)\s*[.!]?$/;
// 문장 끝에 올 수 있는 평범한 명사들. 개조식으로 오해하지 않게 빼둔다.
const MEMO_EXCEPTIONS = new Set(['모임', '쓰임', '다짐', '조임', '놀림', '가짐']);

function looksMemoStyle(sentence) {
  if (FORMAL_ENDING.test(sentence)) return false;
  const matched = sentence.match(MEMO_TAIL);
  if (!matched) return false;
  const word = `${matched[1].slice(-1)}${matched[2]}`;
  return !MEMO_EXCEPTIONS.has(word);
}

/* ------------------------------------------------------------------ */
/* 규칙 정의                                                            */
/* ------------------------------------------------------------------ */

/**
 * 각 규칙은 그대로 프롬프트 문장이 되고, 그대로 검사기가 된다.
 * check() 는 { ok, detail } 을 돌려준다. detail 은 보정 요청에 그대로 실린다.
 */
export const RULES = [
  {
    id: 'length',
    label: '분량',
    prompt: (s) => `공백을 제외하고 ${s.post.minChars.toLocaleString()}자 이상. `
      + '각 항목을 짧게 훑고 끝내지 말고, 근거와 사례를 붙여 충분히 길게 쓰세요.',
    check: (post, settings) => {
      const count = countChars(post);
      const need = settings.post.minChars;
      return {
        ok: count >= need,
        detail: `공백 제외 ${count.toLocaleString()}자 / 필요 ${need.toLocaleString()}자`
          + (count >= need ? '' : ` — ${(need - count).toLocaleString()}자가 부족합니다. `
            + '문단을 더 늘리거나 항목별 설명을 더 구체적으로 채우세요.'),
        value: count,
      };
    },
  },
  {
    id: 'ending',
    label: '종결어미',
    prompt: () => '모든 문장을 "~습니다", "~입니다" 형태의 완전한 종결어미로 끝낼 것. '
      + '"~함", "~임", "~음" 같은 개조식·메모식 표현은 목록 항목에서도 절대 쓰지 마세요.',
    check: (post) => {
      const sentences = splitSentences(sentenceSources(post));
      if (!sentences.length) return { ok: false, detail: '검사할 문장이 없습니다.' };

      const memo = sentences.filter(looksMemoStyle);
      const formal = sentences.filter((s) => FORMAL_ENDING.test(s));
      const ratio = formal.length / sentences.length;

      if (memo.length) {
        return {
          ok: false,
          detail: `개조식("~함/~임") 문장이 ${memo.length}개 있습니다: `
            + memo.slice(0, 3).map((s) => `"${s.slice(0, 40)}"`).join(', '),
        };
      }
      return {
        ok: ratio >= 0.85,
        detail: `"~습니다/~입니다" 종결 ${Math.round(ratio * 100)}% (기준 85%)`
          + (ratio >= 0.85 ? '' : ` — 고쳐야 할 문장: ${sentences.filter((s) => !FORMAL_ENDING.test(s))
            .slice(0, 3).map((s) => `"${s.slice(0, 40)}"`).join(', ')}`),
      };
    },
  },
  {
    id: 'headings',
    label: '소제목 구조',
    prompt: (s) => `큰 소제목 ${s.post.sectionCount}개(3~4개 권장)와 그 아래 세부 소제목을 적극 활용할 것. `
      + '네이버 블로그는 글 제목이 따로 있으므로 본문 맨 앞에 제목을 다시 쓰지 않습니다.',
    check: (post) => {
      const h2 = (post.sections || []).filter((s) => s.heading).length
        + (post.criteria?.heading ? 1 : 0)
        + (post.faq?.length ? 1 : 0);
      const h3 = (post.sections || []).reduce(
        (total, section) => total + (section.subsections || []).filter((sub) => sub.heading).length, 0,
      );
      const problems = [];
      if (h2 < 3) problems.push(`큰 소제목이 ${h2}개뿐입니다 (3개 이상 필요)`);
      if (h3 < 1) problems.push('세부 소제목이 하나도 없습니다');
      return {
        ok: problems.length === 0,
        detail: problems.length ? problems.join(' / ') : `소제목 ${h2}개 · 세부 소제목 ${h3}개`,
      };
    },
  },
  {
    id: 'criteria',
    label: '선정 기준',
    prompt: () => '서두에 "순위·추천을 어떤 기준으로 골랐는지"(예: 취업률, 활용성, 난이도)를 '
      + '반드시 밝히는 단락을 넣을 것.',
    enabledWhen: (settings) => settings.post.addCriteria,
    check: (post) => {
      const items = post.criteria?.items || [];
      const body = (post.criteria?.paragraphs || []).join('');
      return {
        ok: items.length >= 2 && body.length >= 40,
        detail: items.length >= 2 && body.length >= 40
          ? `기준 ${items.length}개를 서두에 밝혔습니다`
          : '선정 기준 단락이 비었거나 너무 짧습니다. criteria.items 에 기준 2개 이상, '
            + 'criteria.paragraphs 에 왜 그 기준을 골랐는지 설명을 넣으세요.',
      };
    },
  },
  {
    id: 'table',
    label: '비교 표',
    prompt: () => '본문에 데이터 비교용 표(Table)를 최소 1개 반드시 포함할 것. '
      + '표는 항목들을 한눈에 견줄 수 있는 열로 구성하세요.',
    check: (post) => {
      const rows = post.table?.rows?.length || 0;
      const cols = post.table?.headers?.length || 0;
      return {
        ok: rows >= 2 && cols >= 2,
        detail: rows >= 2 && cols >= 2
          ? `표 ${rows}행 × ${cols}열`
          : '비교 표가 없습니다. table.headers 와 table.rows 를 2행 이상 채우세요.',
      };
    },
  },
  {
    id: 'bullets',
    label: '불렛 포인트',
    prompt: () => '주요 포인트는 불렛 포인트(목록)로 가독성 있게 정리할 것. '
      + '목록 항목도 "~습니다" 로 끝나는 완전한 문장으로 쓰세요.',
    check: (post) => {
      const lists = (post.sections || []).reduce((total, section) => {
        const own = section.list?.length ? 1 : 0;
        const subs = (section.subsections || []).filter((sub) => sub.list?.length).length;
        return total + own + subs;
      }, 0);
      return {
        ok: lists >= 1,
        detail: lists >= 1 ? `목록 ${lists}개` : '불렛 포인트 목록이 하나도 없습니다.',
      };
    },
  },
  {
    id: 'detail',
    label: '항목별 상세',
    prompt: () => '단순 나열에 그치지 말고 각 항목마다 상세 설명, 자격/요건, 실제 활용(취업) 분야, '
      + '장단점, 준비 팁을 H3 세부 소제목으로 나눠 구체적으로 쓸 것.',
    enabledWhen: (settings, post) => post?.shape === 'items',
    check: (post) => {
      const itemSections = (post.sections || []).filter((section) => section.isItem);
      if (!itemSections.length) {
        return { ok: false, detail: '항목별 섹션이 없습니다.' };
      }
      const thin = itemSections.filter((section) => (section.subsections || []).length < 3);
      return {
        ok: thin.length === 0,
        detail: thin.length === 0
          ? `항목 ${itemSections.length}개에 각각 세부 소제목을 붙였습니다`
          : `세부 소제목이 3개 미만인 항목: ${thin.map((s) => s.heading).slice(0, 4).join(', ')}`
            + ' — 상세 설명 / 자격 요건 / 활용 분야 / 장단점 / 준비 팁 중 최소 3가지를 넣으세요.',
      };
    },
  },
  {
    id: 'opening',
    label: '서두 인사말 금지',
    prompt: () => '"안녕하세요", "이번 포스팅에서는" 같은 인사말이나 메타 안내 문장 없이 '
      + '바로 독자의 문제 상황에 공감하는 본론으로 시작할 것.',
    check: (post) => {
      const first = String((post.intro || [])[0] || '').trim();
      if (!first) return { ok: false, detail: '도입부가 비어 있습니다.' };
      if (GREETING.test(first)) {
        return { ok: false, detail: `인사말로 시작합니다: "${first.slice(0, 40)}"` };
      }
      if (META_SENTENCE.test(first)) {
        return { ok: false, detail: `메타 안내 문장으로 시작합니다: "${first.slice(0, 40)}"` };
      }
      return { ok: true, detail: '바로 본론으로 시작합니다' };
    },
  },
  {
    id: 'symbols',
    label: '기호·이모지',
    prompt: () => '특수문자(★, ※, ▶ 등)나 이모지를 본문에 쓰지 말고 깔끔한 텍스트 위주로 쓸 것.',
    check: (post) => {
      const text = allText(post);
      const bad = [...new Set(text.match(new RegExp(BANNED_SYMBOLS, 'gu')) || [])];
      const emoji = [...new Set(text.match(new RegExp(EMOJI, 'gu')) || [])];
      const found = [...bad, ...emoji];
      return {
        ok: found.length === 0,
        detail: found.length === 0
          ? '장식 기호 없음'
          : `본문에서 제거해야 할 기호: ${found.slice(0, 10).join(' ')}`,
      };
    },
  },
  {
    id: 'tags',
    // 네이버판에서 새로 붙인 규칙. 태그는 네이버 검색 유입의 실제 통로다.
    label: '태그',
    prompt: () => 'tags 에 이 글로 검색해 들어올 만한 검색어 3~6개를 넣을 것. '
      + '네이버 태그에는 공백을 넣을 수 없으니 "국가기술자격증" 처럼 붙여 쓰고, '
      + '한두 단어짜리 일반적인 검색어로 쓰세요.',
    enabledWhen: (settings) => settings.post.appendTags,
    check: (post) => {
      const tags = (post.tags || []).filter(Boolean);
      return {
        ok: tags.length >= 3,
        detail: tags.length >= 3
          ? `태그 ${tags.length}개 (${tags.slice(0, 6).join(', ')})`
          : `태그가 ${tags.length}개뿐입니다. tags 에 검색어 3개 이상을 넣으세요.`,
      };
    },
  },
  {
    id: 'closing',
    label: '마무리',
    prompt: () => '결론에서는 글 전체 내용을 요약하고 독자를 따뜻하게 독려하며 마무리할 것.',
    check: (post) => {
      const outro = (post.outro || []).join('');
      return {
        ok: outro.replace(/\s+/g, '').length >= 120,
        detail: outro.replace(/\s+/g, '').length >= 120
          ? '요약과 독려로 마무리했습니다'
          : '마무리 단락이 너무 짧습니다. 글 전체를 요약하고 독자를 격려하는 내용을 2문단 이상 쓰세요.',
      };
    },
  },
];

/** 이 설정/글 모양에서 실제로 적용되는 규칙만 고른다. */
function activeRules(settings, post) {
  return RULES.filter((rule) => !rule.enabledWhen || rule.enabledWhen(settings, post));
}

/* ------------------------------------------------------------------ */
/* 프롬프트용 문장                                                      */
/* ------------------------------------------------------------------ */

/** 글을 쓰기 전에 넣을 "필수 준수 규칙" 블록. */
export function buildRuleBlock(settings, shape) {
  const rules = activeRules(settings, { shape });
  const lines = rules.map((rule, index) => `${index + 1}. [${rule.label}] ${rule.prompt(settings)}`);
  return [
    '[필수 준수 규칙 — 정보성 글 품질 기준]',
    '아래는 이 글이 "검색에 걸리는 정보성 글" 이 되기 위한 조건입니다.',
    '하나라도 어기면 자동 검사에서 걸러져 다시 쓰게 됩니다.',
    '',
    ...lines,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 검사                                                                */
/* ------------------------------------------------------------------ */

/**
 * 완성된 글이 규칙을 지켰는지 본다.
 * @returns {{ok: boolean, passed: number, total: number, charCount: number,
 *            results: Array<{id,label,ok,detail}>, issues: Array<{id,label,detail}>}}
 */
export function checkCompliance(post, settings) {
  const results = activeRules(settings, post).map((rule) => {
    let outcome;
    try {
      outcome = rule.check(post, settings);
    } catch (error) {
      outcome = { ok: false, detail: `검사 중 오류: ${error.message}` };
    }
    return { id: rule.id, label: rule.label, ok: Boolean(outcome.ok), detail: outcome.detail || '' };
  });

  const issues = results.filter((result) => !result.ok);
  return {
    ok: issues.length === 0,
    passed: results.length - issues.length,
    total: results.length,
    charCount: countChars(post),
    results,
    issues: issues.map(({ id, label, detail }) => ({ id, label, detail })),
  };
}

/** 검사에서 걸린 항목만 짚어 다시 쓰게 하는 지시문. */
export function buildRepairBlock(compliance) {
  const lines = compliance.issues.map(
    (issue, index) => `${index + 1}. [${issue.label}] ${issue.detail}`,
  );
  return [
    '[수정 요청 — 아래 항목이 품질 검사에서 걸렸습니다]',
    '',
    ...lines,
    '',
    '위 문제만 정확히 고치세요. 통과한 부분은 그대로 두고,',
    '고친 결과를 같은 JSON 구조로 **전체** 출력하세요. 일부만 보내면 안 됩니다.',
  ].join('\n');
}

/** 대시보드 배지에 쓸 짧은 요약. */
export function summarize(compliance) {
  if (!compliance) return '';
  return compliance.ok
    ? `준수 ${compliance.passed}/${compliance.total}`
    : `미준수 ${compliance.issues.map((issue) => issue.label).join(', ')}`;
}
