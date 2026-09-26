import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';

/**
 * Pexels 에서 썸네일 배경으로 쓸 사진을 받아온다.
 *
 * 무료다. 계정을 만들고 키를 받으면 시간당 200장, 월 2만 장까지 쓸 수 있다.
 * 이미지 생성 API 처럼 장당 요금이 붙지 않고, ChatGPT 처럼 브라우저를
 * 띄울 필요도 없다. 그냥 HTTP 한 번이다.
 *
 * **대신 글자를 그릴 수는 없다.** 이미 찍혀 있는 사진을 가져오는 것이라
 * 제목을 그림 안에 넣어 달라고 할 수가 없다. 그래서 Pexels 로 받은 사진은
 * 언제나 **배경으로만** 쓰고, 한글은 HTML 이 위에 얹는다.
 * (그래서 한글이 깨질 일이 아예 없다는 장점도 같이 온다)
 */

// 점검용으로만 주소를 바꿀 수 있게 열어 둔다. 평소에는 건드리지 않는다.
const HOST = process.env.PEXELS_HOST || 'https://api.pexels.com/v1/search';

/** Pexels 는 영어로 찾아야 결과가 제대로 나온다. */
const FALLBACK_QUERY = 'clean minimal office desk workspace';

/**
 * 검색어를 만든다.
 *
 * 글을 쓸 때 AI 가 이미 `scene` 에 **영어 한 문장**으로 배경 장면을 적어 둔다.
 * (이미지 생성 API 에 보내려고 만든 값이다) 그걸 그대로 쓰면 된다.
 * Pexels 는 긴 문장보다 낱말 몇 개를 훨씬 잘 찾으므로 짧게 줄인다.
 */
export function buildPexelsQuery(spec) {
  const scene = String(spec?.scene || '').trim();

  const words = scene
    .toLowerCase()
    // 검색에 도움이 안 되는 말은 버린다.
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

  if (words.length >= 2) return words.slice(0, 5).join(' ');

  // scene 이 비었거나 한글뿐이면 영어 낱말을 못 만든다. 무난한 것으로 간다.
  return FALLBACK_QUERY;
}

const STOP_WORDS = new Set([
  'the', 'and', 'with', 'for', 'from', 'into', 'that', 'this', 'their', 'they',
  'are', 'was', 'were', 'who', 'what', 'when', 'where', 'over', 'under', 'about',
  'photo', 'photograph', 'image', 'picture', 'illustration', 'scene', 'background',
  'showing', 'shows', 'featuring', 'style', 'shot', 'view', 'korean', 'korea',
]);

/**
 * 응답에서 쓸 사진 하나를 고른다.
 *
 * 가로로 넓은 것을 고른다. 썸네일이 1200x630 이라 세로 사진을 쓰면
 * 위아래가 잘려서 무엇을 찍은 사진인지 알 수 없게 된다.
 *
 * @param {object} json Pexels 응답
 * @param {number} want 원하는 가로세로 비 (예: 1200/630)
 */
export function pickPhoto(json, want = 1200 / 630) {
  const photos = Array.isArray(json?.photos) ? json.photos : [];
  let best = null;
  let bestGap = Infinity;

  for (const photo of photos) {
    const width = Number(photo?.width) || 0;
    const height = Number(photo?.height) || 0;
    if (width < 800 || height < 400) continue;        // 너무 작으면 흐려진다
    const ratio = width / height;
    if (ratio < 1) continue;                          // 세로 사진은 쓰지 않는다

    const gap = Math.abs(ratio - want);
    if (gap < bestGap) {
      bestGap = gap;
      best = photo;
    }
  }
  if (best) return best;

  // 조건에 맞는 것이 없으면 그냥 첫 장이라도 쓴다. 없는 것보다 낫다.
  return photos[0] || null;
}

/** 사진 한 장에서 내려받을 주소를 고른다. 큰 쪽을 먼저 본다. */
export function pickPhotoUrl(photo) {
  const src = photo?.src || {};
  return src.landscape || src.large2x || src.large || src.original || src.medium || '';
}

/**
 * Pexels 에서 배경 사진을 받아온다.
 *
 * @returns {Promise<{dataUri, model, bytes, credit, url}>}
 */
export async function fetchPexelsPhoto(spec, { width = 1200, height = 630, signal } = {}) {
  const { image } = getSettings();
  const apiKey = String(image.pexels?.apiKey || '').trim();
  if (!apiKey) throw new Error('Pexels API 키가 비어 있습니다. pexels.com/api 에서 무료로 발급됩니다.');

  const query = buildPexelsQuery(spec);
  const params = new URLSearchParams({
    query,
    orientation: 'landscape',
    per_page: '15',
    size: 'large',
  });

  const response = await fetch(`${HOST}?${params}`, {
    headers: { Authorization: apiKey },
    signal: signal || AbortSignal.timeout(Number(image.timeoutMs) || 60000),
  });

  if (response.status === 401) {
    throw new Error('Pexels API 키가 올바르지 않습니다. 설정에서 다시 넣어 주세요.');
  }
  if (response.status === 429) {
    const error = new Error('Pexels 사용량 한도에 걸렸습니다. 잠시 뒤 다시 시도하세요.');
    error.rateLimited = true;
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Pexels 검색이 실패했습니다 (HTTP ${response.status}).`);
  }

  const json = await response.json();
  const photo = pickPhoto(json, width / height);
  if (!photo) throw new Error(`"${query}" 로 찾은 사진이 없습니다.`);

  const photoUrl = pickPhotoUrl(photo);
  if (!photoUrl) throw new Error('사진 주소를 찾지 못했습니다.');

  const file = await fetch(photoUrl, {
    signal: signal || AbortSignal.timeout(Number(image.timeoutMs) || 60000),
  });
  if (!file.ok) throw new Error(`사진을 내려받지 못했습니다 (HTTP ${file.status}).`);

  const type = (file.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!/^image\//i.test(type)) throw new Error(`그림이 아닌 응답이 왔습니다 (${type}).`);

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length < 1000) throw new Error(`받은 사진이 너무 작습니다 (${bytes.length}바이트).`);

  // Pexels 는 출처를 안 밝혀도 되지만, 찍은 사람을 로그에 남겨 둔다.
  const credit = String(photo.photographer || '').trim();
  logger.info(
    `Pexels 에서 사진을 받았습니다. ("${query}" · ${photo.width}x${photo.height}`
    + `${credit ? ` · ${credit}` : ''} · ${Math.round(bytes.length / 1024)}KB)`,
  );

  return {
    dataUri: `data:${type};base64,${bytes.toString('base64')}`,
    model: 'pexels',
    bytes: bytes.length,
    usd: 0,
    credit,
    url: String(photo.url || ''),
    query,
  };
}
