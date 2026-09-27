import { runClaudeJson } from '../ai/claude.js';
import { logger } from '../lib/events.js';

/**
 * 글에 맞는 블로그 카테고리를 고른다.
 *
 * 네이버는 카테고리를 발행 패널에서 사람이 고르게 되어 있다. 100편을 자동으로
 * 올리면서 그걸 매번 손으로 고르는 것은 말이 안 되므로, 글 내용을 보고
 * **있는 카테고리 중에서** 가장 맞는 것을 고른다.
 *
 * 새로 만들지는 않는다. 블로그에 이미 있는 목록에서만 고른다. 없는 이름을
 * 지어내면 그 이름을 누를 수가 없어서 어차피 실패한다.
 *
 * 고르는 방법은 두 가지다.
 *   1) 글자 겹침으로 점수 매기기 — 호출이 필요 없고 즉시 끝난다
 *   2) AI 에게 묻기            — 1번이 애매할 때만
 * 대부분 1번에서 끝난다. "대학 순위" 글에 "교육" 카테고리가 있으면 바로 잡힌다.
 */

/** 비교용으로 다듬는다. 공백과 기호를 없애고 소문자로. */
export function normalizeName(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s·・,./\-_()[\]{}'"!?]/g, '');
}

/**
 * 카테고리 이름과 글이 얼마나 겹치는지 점수를 낸다.
 *
 * 카테고리 이름은 보통 짧다("교육", "재테크", "IT"). 그 짧은 말이 제목이나
 * 태그에 그대로 나오면 그게 가장 강한 신호다.
 */
export function scoreCategory(name, { title = '', tags = [], topic = '', summary = '' }) {
  const clean = normalizeName(name);
  if (!clean) return 0;

  const inTitle = normalizeName(title);
  const inTopic = normalizeName(topic);
  const inSummary = normalizeName(summary);

  /*
   * 태그는 **두 글자 이상 남는 것만** 본다.
   *
   * 이게 없어서 카테고리가 한 곳으로 고정되는 사고가 났다. 기호만 든 태그
   * ("·", "#") 는 다듬으면 빈 문자열이 되는데, `clean.includes('')` 은 언제나
   * 참이라서 **모든 카테고리가 똑같이 60점**을 받았다. 점수가 다 같으니
   * 목록의 첫 번째 카테고리가 늘 뽑혔고, 글마다 다른 곳에 들어가야 할 것이
   * 전부 한 곳으로 갔다.
   */
  const inTags = tags.map((tag) => normalizeName(tag)).filter((tag) => tag.length >= 2);

  let score = 0;
  // 제목에 카테고리 이름이 통째로 들어 있으면 거의 확실하다.
  if (inTitle.includes(clean)) score += 100;
  if (inTopic.includes(clean)) score += 80;
  if (inTags.some((tag) => tag.includes(clean) || clean.includes(tag))) score += 60;
  if (inSummary.includes(clean)) score += 30;

  /*
   * 두 글자 이상 겹치는 부분이 있는지도 본다.
   * "국가기술자격증" 글과 "자격증" 카테고리를 이어 주는 것이 이 부분이다.
   */
  const haystack = `${inTitle} ${inTopic} ${inTags.join(' ')} ${inSummary}`;
  for (let size = clean.length; size >= 2; size -= 1) {
    for (let start = 0; start + size <= clean.length; start += 1) {
      if (haystack.includes(clean.slice(start, start + size))) {
        score += size * 4;
        return score;          // 가장 긴 조각 하나만 센다
      }
    }
  }
  return score;
}

/**
 * 글자 겹침만으로 고른다. 호출이 필요 없다.
 *
 * 1등이 여럿이면 **아무도 고르지 않는다.** 점수가 같은데 하나를 집으면 늘
 * 목록의 첫 번째가 뽑히고, 글마다 달라야 할 카테고리가 한 곳으로 고정된다.
 * 그럴 때는 AI 에게 넘기는 것이 맞다.
 *
 * @returns {{name: string, score: number, tied: number, scores: object[]}}
 */
export function pickByKeyword(categories, post) {
  const facts = {
    title: post.title || '',
    tags: Array.isArray(post.tags) ? post.tags : [],
    topic: post.topic || '',
    summary: post.summary || '',
  };

  const scores = categories
    .map((name) => ({ name, score: scoreCategory(name, facts) }))
    .sort((a, b) => b.score - a.score);

  const top = scores[0];
  if (!top || top.score <= 0) return { name: '', score: 0, tied: 0, scores };

  const tied = scores.filter((item) => item.score === top.score).length;
  // 공동 1등이면 이름만으로는 못 정한다. 빈손으로 돌려 AI 가 고르게 한다.
  if (tied > 1) return { name: '', score: top.score, tied, scores };

  return { name: top.name, score: top.score, tied: 1, scores };
}

/** AI 에게 물을 때 쓰는 말. 목록 밖의 답을 막는 것이 핵심이다. */
export function buildCategoryPrompt(categories, post) {
  const list = categories.map((name, index) => `${index + 1}. ${name}`).join('\n');
  // 소제목까지 보여준다. 제목만으로는 무엇에 대한 글인지 덜 드러난다.
  const headings = (post.sections || [])
    .map((section) => section?.heading)
    .filter(Boolean)
    .slice(0, 6)
    .join(' / ');

  return `블로그 글 하나를 어느 카테고리에 넣을지 고르세요.

[글]
- 제목: ${post.title || ''}
- 주제: ${post.topic || ''}
- 요약: ${String(post.summary || '').slice(0, 200)}
- 태그: ${(post.tags || []).join(', ')}
${headings ? `- 소제목: ${headings}` : ''}

[고를 수 있는 카테고리 — 이 목록 밖의 이름을 쓰면 안 됩니다]
${list}

[규칙]
- 위 목록에 **있는 이름을 글자 그대로** 하나만 고르세요.
- 새 카테고리를 만들거나 이름을 바꾸지 마세요.
- 딱 맞는 것이 없으면 그중 **가장 가까운 것**을 고르세요. "없음" 은 답이 아닙니다.

[무엇을 보고 고를 것인가]
- **이 글이 실제로 무엇에 대한 글인지**를 보세요. 제목에 든 낱말 하나가 아니라
  글 전체가 다루는 대상입니다.
- 매번 무난한 한 곳으로 몰아넣지 마세요. 글이 다르면 카테고리도 달라야 합니다.
  (예: "대학 순위" → 교육 쪽 / "대기업 연봉 순위" → 취업·직장 쪽 /
   "연말정산 환급" → 재테크 쪽. 셋 다 "순위" 글이지만 갈래가 다릅니다)
- 고민되면 **읽는 사람이 어느 칸에서 이 글을 찾을지**로 판단하세요.

[출력] JSON 객체 하나만.
{"category": "고른 이름", "why": "이 글이 무엇에 대한 글이라서 그 카테고리인지 한 줄"}`;
}

/**
 * 카테고리를 고른다.
 *
 * @param {string[]} categories 블로그에 실제로 있는 카테고리 이름들
 * @param {object} post         제목·태그·요약이 든 글
 * @returns {Promise<{name: string, why: string, how: string}>} 못 고르면 name 이 빈 값
 */
export async function chooseCategory(categories, post, { signal } = {}) {
  const list = (categories || []).map((name) => String(name || '').trim()).filter(Boolean);
  if (!list.length) return { name: '', why: '', how: '' };
  if (list.length === 1) return { name: list[0], why: '카테고리가 하나뿐입니다.', how: '유일' };

  // 1) 글자 겹침. **혼자 1등일 때만** 여기서 끝낸다. 호출을 아낀다.
  const keyword = pickByKeyword(list, post);
  if (keyword.name && keyword.score >= 60) {
    return { name: keyword.name, why: '제목·태그와 이름이 겹칩니다.', how: '이름 겹침' };
  }
  if (keyword.tied > 1) {
    logger.info(`카테고리 ${keyword.tied}개가 같은 점수라 AI 에게 고르게 합니다.`);
  }

  // 2) 애매하면 AI 에게 묻는다.
  try {
    const reply = await runClaudeJson(buildCategoryPrompt(list, post), {
      systemPrompt: '당신은 블로그 편집자입니다. 주어진 목록에서만 고르고 JSON 만 출력합니다.',
      signal,
    });
    const picked = String(reply.data?.category || '').trim();

    // 목록에 없는 이름을 지어냈을 수 있다. 반드시 목록과 맞춰 본다.
    const exact = list.find((name) => normalizeName(name) === normalizeName(picked));
    if (exact) {
      return { name: exact, why: String(reply.data?.why || '').slice(0, 120), how: 'AI' };
    }
    // 목록에 없는 이름이다. 무엇을 골랐는지 남겨야 다음에 원인을 찾을 수 있다.
    logger.warn(`AI 가 목록에 없는 카테고리를 골랐습니다: "${picked}"`);
  } catch (error) {
    // 카테고리 하나 때문에 다 쓴 글을 버리지 않는다.
    if (error?.rateLimited || error?.authExpired) throw error;
    logger.warn(`카테고리를 AI 로 고르지 못했습니다: ${String(error.message).split('\n')[0]}`);
  }

  // 3) 그래도 안 되면 겹침 점수가 조금이라도 있는 것을 쓴다.
  if (keyword.name) {
    return { name: keyword.name, why: '가장 가까워 보이는 이름입니다.', how: '이름 겹침(약함)' };
  }
  return { name: '', why: '', how: '' };
}
