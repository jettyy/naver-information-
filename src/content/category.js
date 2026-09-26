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
  const inTags = tags.map((tag) => normalizeName(tag));
  const inSummary = normalizeName(summary);

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

/** 글자 겹침만으로 고른다. 호출이 필요 없다. */
export function pickByKeyword(categories, post) {
  const facts = {
    title: post.title || '',
    tags: Array.isArray(post.tags) ? post.tags : [],
    topic: post.topic || '',
    summary: post.summary || '',
  };

  let best = '';
  let bestScore = 0;
  for (const name of categories) {
    const score = scoreCategory(name, facts);
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return { name: best, score: bestScore };
}

/** AI 에게 물을 때 쓰는 말. 목록 밖의 답을 막는 것이 핵심이다. */
export function buildCategoryPrompt(categories, post) {
  const list = categories.map((name, index) => `${index + 1}. ${name}`).join('\n');
  return `블로그 글 하나를 어느 카테고리에 넣을지 고르세요.

[글]
- 제목: ${post.title || ''}
- 주제: ${post.topic || ''}
- 요약: ${String(post.summary || '').slice(0, 200)}
- 태그: ${(post.tags || []).join(', ')}

[고를 수 있는 카테고리 — 이 목록 밖의 이름을 쓰면 안 됩니다]
${list}

[규칙]
- 위 목록에 **있는 이름을 글자 그대로** 하나만 고르세요.
- 새 카테고리를 만들거나 이름을 바꾸지 마세요.
- 딱 맞는 것이 없으면 그중 **가장 가까운 것**을 고르세요. "없음" 은 답이 아닙니다.
- 이 블로그가 그 분야를 꾸준히 다루는 것으로 보이게, 글의 큰 갈래를 보세요.
  (예: "국가기술자격증 TOP 5" → 자격증 / 교육 / 취업 쪽)

[출력] JSON 객체 하나만.
{"category": "고른 이름", "why": "왜 그 카테고리인지 한 줄"}`;
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

  // 1) 글자 겹침. 확실하면 여기서 끝낸다. 호출을 아낀다.
  const keyword = pickByKeyword(list, post);
  if (keyword.score >= 60) {
    return { name: keyword.name, why: '제목·태그와 이름이 겹칩니다.', how: '이름 겹침' };
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
