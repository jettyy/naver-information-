import { runClaudeJson } from '../ai/claude.js';
import { logger } from '../lib/events.js';

/**
 * 주제의 "모양"을 정하는 모듈.
 *
 * 정보성 글 품질 규칙은 "각 항목마다 상세 설명 / 자격 요건 / 활용 분야 /
 * 장단점 / 준비 팁을 구체적으로 쓸 것" 을 요구한다. 그래서 항목이 몇 개냐에 따라
 * 글의 구조를 다르게 잡아야 한다.
 *
 *   - TOP 5, 7가지 처럼 항목이 적으면  → 항목마다 H2 섹션 하나 + H3 세부 소제목 (items)
 *   - TOP 50, 100가지 처럼 많으면       → 큰 표 하나 + 대표 항목만 상세 (table)
 *   - 개수가 없는 일반 정보성 주제        → 소제목 중심 (general)
 *
 * 표를 100행 받는 일은 한 번의 호출로 안 된다. 모델이 "이하 생략" 하거나
 * 출력 길이에 걸려 잘리기 때문에 구간을 나눠 받아 이어 붙이고,
 * 빠진 순위가 있으면 그 구간만 다시 받는다.
 */

/** 이 개수까지는 항목마다 상세 섹션을 쓴다. 넘어가면 글이 감당이 안 된다. */
export const ITEM_LIMIT = 12;

/** 표 행만 나눠 받을 때 한 번에 요청하는 행 수. */
const CHUNK_SIZE = 50;
export const MAX_COUNT = 300;

/** 빠진 행을 다시 채우는 횟수. 100행짜리는 한 번에 안 채워지는 일이 잦다. */
const FILL_PASSES = 2;

/** 표 행만 뽑는 호출에는 블로그 작법 지시가 필요 없다. 짧을수록 싸고 빠르다. */
const ROW_SYSTEM = '표 데이터를 JSON 으로만 출력합니다. 설명을 붙이지 않습니다.';

/**
 * "순위" 성격이 뚜렷한 말. 개수를 안 썼어도 큰 순위표를 기대하는 주제다.
 * (추천/비교는 여기 넣지 않는다. 그건 항목 몇 개를 깊게 다루는 글이다)
 */
const STRONG_RANK = /(순위|랭킹|랭크|서열|ranking\b|top\s*-?\s*\d|베스트|best\s*\d)/i;

/** "추천/비교" 성격. 항목 몇 개를 상세하게 다루는 글이 어울린다. */
const SOFT_RANK = /(추천|고르는|비교|골라|모음)/;

/** 주제 문자열에서 "몇 개짜리 글인지" 알아낸다. */
export function detectCount(topic) {
  const text = String(topic || '');
  const patterns = [
    /top\s*-?\s*(\d{1,3})/i,
    /best\s*-?\s*(\d{1,3})/i,
    /베스트\s*(\d{1,3})/,
    /(\d{1,3})\s*(?:위|가지|개|선|종|곳|대|강)\b/,
    /(\d{1,3})\s*(?:위|가지|개|선|종|곳|대|강)/,
  ];
  for (const pattern of patterns) {
    const matched = text.match(pattern);
    if (matched) {
      const parsed = Number(matched[1]);
      if (Number.isFinite(parsed) && parsed >= 2 && parsed <= MAX_COUNT) return parsed;
    }
  }
  return null;
}

/**
 * 글의 모양을 정한다.
 *
 * "전국 대학 순위" 처럼 개수를 안 쓴 순위 주제가 문제였다. 예전에는 항목 5개짜리
 * 글로 잡혀서, 정작 원하는 "많이 담긴 순위표" 가 안 나왔다. 이제 그런 주제는
 * 설정한 목표 개수(기본 100)짜리 큰 표로 간다.
 *
 * @param {number} [targetCount]  개수를 안 쓴 순위 주제에 쓸 목표 행 수
 * @returns {{shape: 'items'|'table'|'general', count: number|null, needsChunking: boolean}}
 */
export function detectShape(topic, targetCount = 100) {
  const text = String(topic || '');
  const count = detectCount(text);
  const target = Math.min(MAX_COUNT, Math.max(2, Number(targetCount) || 100));

  if (count) {
    return count <= ITEM_LIMIT
      ? { shape: 'items', count, needsChunking: false }
      : { shape: 'table', count, needsChunking: true };
  }

  // 개수를 안 썼지만 "순위" 성격이면 목표 개수만큼 크게 뽑는다.
  if (STRONG_RANK.test(text)) {
    return target <= ITEM_LIMIT
      ? { shape: 'items', count: target, needsChunking: false }
      : { shape: 'table', count: target, needsChunking: true };
  }

  // "추천/비교" 는 항목 몇 개를 깊게. 개수는 AI 가 정한다.
  if (SOFT_RANK.test(text)) return { shape: 'items', count: null, needsChunking: false };

  return { shape: 'general', count: null, needsChunking: false };
}

function normalizeRows(rawRows, columnCount) {
  if (!Array.isArray(rawRows)) return [];
  return rawRows
    .map((row) => {
      if (Array.isArray(row)) return row.map((cell) => String(cell ?? '').trim());
      if (row && typeof row === 'object') return Object.values(row).map((cell) => String(cell ?? '').trim());
      return null;
    })
    .filter(Boolean)
    .map((cells) => {
      const fixed = cells.slice(0, columnCount);
      while (fixed.length < columnCount) fixed.push('');
      return fixed;
    })
    .filter((cells) => cells.some((cell) => cell));
}

/** 행의 첫 칸에서 순위 숫자를 뽑는다. "1위", "1." 같은 표기도 허용. */
function rankOf(row) {
  const matched = String(row?.[0] ?? '').match(/\d+/);
  return matched ? Number(matched[0]) : null;
}

/**
 * 뒤 구간으로 갈수록 "더 넓게 보라"고 일러준다.
 *
 * 큰 순위표가 실패하는 지점은 늘 뒤쪽이다. 상위권은 누구나 아는 이름으로
 * 금방 채우지만, 50번을 넘어가면 모델이 앞에서 쓴 이름을 다시 쓰거나
 * "이하 생략" 하고 멈춘다. 그래서 구간마다 어디까지 넓혀야 하는지
 * 명시적으로 알려준다. 이것이 100행을 실제로 채우는 핵심이다.
 */
function broadenHint(start, count) {
  const ratio = start / Math.max(1, count);
  if (ratio < 0.25) return '';
  if (ratio < 0.5) {
    return '- 이 구간부터는 상위권에서 이미 다 나왔습니다. '
      + '수도권 밖과 중견 규모까지 범위를 넓혀서 채우세요.';
  }
  if (ratio < 0.75) {
    return '- 이 구간은 **지방과 덜 알려진 곳**까지 넓혀야 채워집니다. '
      + '광역시와 각 도 단위로 고르게 훑으면서 빠짐없이 찾으세요.';
  }
  return '- 이 구간은 **전국을 통틀어 규모가 작거나 특수 목적인 곳**까지 포함해야 합니다. '
    + '지역별로 남은 곳, 전문 분야에 특화된 곳을 찾아서라도 반드시 끝까지 채우세요. '
    + '"더 이상 없습니다" 라고 답하지 말고, 범위를 넓혀 끝까지 채우세요.';
}

function buildChunkPrompt({ topic, headers, start, end, existingNames, count }) {
  const expected = end - start + 1;
  // 예시 행은 반드시 실제 열 개수와 같아야 한다.
  // 3칸짜리 예시를 고정으로 보여주면 열이 4개여도 3칸만 채워서 돌려준다.
  const sampleRow = (rank) => JSON.stringify(
    [String(rank), ...headers.slice(1).map((header) => `${header} 내용`)],
  );
  const broaden = broadenHint(start, count);

  return `주제: "${topic}"
이 주제의 표는 전체 ${count}개 행짜리입니다.
그중 ${start}~${end}번, 정확히 ${expected}개 행을 채우세요.

열: ${headers.join(' | ')}

규칙
- ${expected}개 행 전부 출력. "이하 생략", "...", "(중략)" 금지.
- 첫 칸은 번호 숫자만 (${start}~${end}).
- 각 행은 정확히 ${headers.length}칸, 빈 칸 없이.
- 각 칸 24자 이내. 특수문자와 이모지는 쓰지 마세요.
- 앞에 나온 항목을 다시 쓰지 마세요. 전부 새로운 항목이어야 합니다.
- 공식 조사 결과가 아니라 널리 알려진 정보를 모은 참고용 표입니다. 실제 조사 수치는 지어내지 말고 일반적인 특징으로 채우세요.
${broaden ? `${broaden}\n` : ''}${existingNames.length ? `- 이미 나온 항목 ${existingNames.length}개 (전부 제외): ${existingNames.slice(-90).join(', ')}` : ''}

JSON 만 출력:
{"rows": [${sampleRow(start)}, ${sampleRow(start + 1)}]}`;
}

/**
 * 큰 표를 구간별로 나눠 받아 하나로 이어 붙인다.
 * 빠진 구간은 한 번 더 요청해서 메운다.
 */
export async function generateTableRows({
  topic,
  headers,
  count,
  signal,
  onProgress,
}) {
  const columnCount = headers.length;
  const byRank = new Map();
  let model = '';

  // 이름이 같은 항목이 뒤 구간에서 다시 나오면 버린다.
  // 100행짜리에서 이게 없으면 "서울대"가 3번 들어간 표가 나온다.
  const usedNames = new Set();
  const nameKey = (row) => String(row[1] || '').replace(/\s+/g, '').toLowerCase();

  const fetchRange = async (start, end) => {
    const existingNames = [...byRank.values()].map((row) => row[1]).filter(Boolean);
    const prompt = buildChunkPrompt({ topic, headers, start, end, existingNames, count });
    const reply = await runClaudeJson(prompt, { systemPrompt: ROW_SYSTEM, signal });
    model = reply.model || model;

    let added = 0;
    let duplicates = 0;
    for (const row of normalizeRows(reply.data?.rows, columnCount)) {
      const rank = rankOf(row);
      // 범위 밖이거나 번호를 못 읽은 행은 버린다. 순서가 꼬이는 것보다 낫다.
      if (rank === null || rank < 1 || rank > count) continue;
      if (byRank.has(rank)) continue;

      const key = nameKey(row);
      if (key && usedNames.has(key)) { duplicates += 1; continue; }
      if (key) usedNames.add(key);

      row[0] = String(rank);
      byRank.set(rank, row);
      added += 1;
    }
    return { added, duplicates };
  };

  for (let start = 1; start <= count; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE - 1, count);
    const { duplicates } = await fetchRange(start, end);
    onProgress?.({ filled: byRank.size, total: count });
    logger.info(
      `비교표 ${start}~${end}번 생성 (누적 ${byRank.size}/${count}개`
      + `${duplicates ? `, 중복 ${duplicates}건 제외` : ''})`,
    );
  }

  /** 빠진 번호를 연속 구간으로 묶는다. */
  const missingRanges = () => {
    const missing = [];
    for (let rank = 1; rank <= count; rank += 1) {
      if (!byRank.has(rank)) missing.push(rank);
    }
    if (!missing.length) return [];
    const ranges = [];
    let head = missing[0];
    let prev = missing[0];
    for (const rank of missing.slice(1)) {
      if (rank === prev + 1) { prev = rank; continue; }
      ranges.push([head, prev]);
      head = rank;
      prev = rank;
    }
    ranges.push([head, prev]);
    return ranges;
  };

  // 100행짜리는 한 번 훑어서 다 안 채워진다. 채워질 때까지 몇 번 더 돈다.
  for (let pass = 1; pass <= FILL_PASSES; pass += 1) {
    const ranges = missingRanges();
    if (!ranges.length) break;

    const empty = ranges.reduce((total, [start, end]) => total + (end - start + 1), 0);
    logger.warn(`${empty}개 행이 비어 다시 채웁니다. (${pass}/${FILL_PASSES}차 시도)`);

    let gained = 0;
    for (const [start, end] of ranges) {
      try {
        const { added } = await fetchRange(start, end);
        gained += added;
      } catch (error) {
        logger.warn(`${start}~${end}번 재생성 실패: ${error.message}`);
      }
    }
    onProgress?.({ filled: byRank.size, total: count });

    // 한 바퀴 돌았는데 한 줄도 못 늘었다면 더 돌려도 같다. 호출만 버린다.
    if (!gained) {
      logger.warn('더 채워지지 않아 남은 시도를 건너뜁니다.');
      break;
    }
  }

  const rows = [];
  const stillMissing = [];
  for (let rank = 1; rank <= count; rank += 1) {
    const row = byRank.get(rank);
    if (row) rows.push(row);
    else stillMissing.push(rank);
  }

  // 열을 통째로 비워서 돌려주는 경우가 있어 채움 상태를 짚어둔다.
  const emptyCells = rows.reduce(
    (total, row) => total + row.filter((cell) => !cell).length,
    0,
  );
  if (emptyCells > rows.length * 0.2) {
    logger.warn(`표에 빈 칸이 ${emptyCells}개 있습니다. 열 구성이 복잡하면 줄이는 편이 낫습니다.`);
  }

  return { rows, model, missing: stillMissing, emptyCells };
}
