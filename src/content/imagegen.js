import fs from 'node:fs';
import crypto from 'node:crypto';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';
import { IMAGE_MODEL_FILE, ensureDirs } from '../lib/paths.js';

/**
 * 썸네일 이미지 생성.
 *
 * 두 가지 방식이 있다.
 *   full    — 제목·띠·뱃지까지 그림 안에 통째로 그린다. 포스터형 썸네일이 나온다.
 *   overlay — 글자 없는 배경만 그리고 한글은 HTML 이 얹는다. 한글이 절대 안 깨진다.
 *
 * full 방식은 이미지 모델이 한글을 뭉갤 수 있다. 그래서 만들고 나서
 * 글자를 다시 읽어 확인하고, 깨졌으면 다시 그리거나 HTML 썸네일로 물러선다.
 *
 * 모델은 **언제나 가장 싼 것부터** 쓴다. 다만 구글 API 는 가격을 알려주지 않는다.
 * 그래서 둘을 나눠서 쓴다.
 *   - "지금 쓸 수 있는 모델이 무엇인가" → API 에 물어본다 (실시간)
 *   - "그중 무엇이 싼가"              → 아래 가격표 (사람이 관리)
 *
 * 구글은 이미 한 번 API 를 갈아엎었다. (Imagen 4 의 :predict 엔드포인트는
 * 2026-08-17 에 종료되고 Gemini 의 :generateContent 로 넘어갔다.)
 * 그래서 두 호출 형식을 모두 지원하고, 고른 모델이 죽어 있으면
 * 다음으로 싼 모델로 알아서 넘어간다.
 */

const HOST = 'https://generativelanguage.googleapis.com/v1beta/models';

/** 이 값들만 구글이 받아준다. 다른 값을 넣으면 조용히 기본값(1:1)으로 돌아간다. */
const ASPECT_RATIOS = new Set(['1:1', '3:4', '4:3', '9:16', '16:9']);

/* ------------------------------------------------------------------ */
/* 가격표                                                              */
/* ------------------------------------------------------------------ */

/**
 * 장당 대략 가격(USD, 1K 해상도 기준). 정렬은 이 값으로 한다.
 *
 * ListModels 응답에는 가격이 없어서 여기에 적어 둘 수밖에 없다.
 * 가격이 바뀌면 이 표만 고치면 된다. 표에 없는 새 모델이 나와도
 * 아래 등급 이름 규칙(lite < fast < flash < pro)으로 대략 짐작한다.
 *
 * text 는 "그림 안에 한글을 얼마나 정확히 그려내는가" 짐작값이다.
 * **정렬에는 쓰지 않는다.** 늘 싼 것부터 쓰고, 글자가 실제로 깨졌을 때만
 * 다음 모델로 올라간다. 이 값은 화면에 참고로 보여주는 용도다.
 */
const PRICE_TABLE = [
  { match: /^imagen-[\d.]+-fast/i, usd: 0.02, label: 'Imagen Fast', text: 0 },
  { match: /flash-lite-image/i, usd: 0.034, label: 'Flash Lite', text: 1 },
  { match: /^gemini-2\.5-flash-image/i, usd: 0.039, label: 'Flash (구세대)', text: 1 },
  { match: /^imagen-[\d.]+-ultra/i, usd: 0.06, label: 'Imagen Ultra', text: 1 },
  { match: /^imagen-[\d.]+-generate/i, usd: 0.04, label: 'Imagen Standard', text: 0 },
  { match: /pro-image/i, usd: 0.134, label: 'Pro', text: 3 },
  { match: /flash-image/i, usd: 0.067, label: 'Flash', text: 2 },
];

/** 표에 없는 새 모델의 가격을 등급 이름으로 짐작한다. */
const TIER_GUESS = [
  { match: /lite/i, usd: 0.035, label: '알 수 없음 (lite 추정)', text: 1 },
  { match: /fast/i, usd: 0.03, label: '알 수 없음 (fast 추정)', text: 1 },
  { match: /flash/i, usd: 0.07, label: '알 수 없음 (flash 추정)', text: 2 },
  { match: /pro|ultra/i, usd: 0.15, label: '알 수 없음 (pro 추정)', text: 3 },
];

/** 모델 이름 하나에 가격, 등급 이름, 글자 렌더링 점수를 붙인다. */
export function priceOf(id) {
  for (const row of PRICE_TABLE) {
    if (row.match.test(id)) {
      return { usd: row.usd, label: row.label, text: row.text, known: true };
    }
  }
  for (const row of TIER_GUESS) {
    if (row.match.test(id)) {
      return { usd: row.usd, label: row.label, text: row.text, known: false };
    }
  }
  // 등급도 모르겠으면 비싼 쪽으로 본다. 모르는 모델을 골라 비싸게 쓰는 것보다
  // 아는 모델을 쓰는 편이 안전하기 때문이다.
  return { usd: 0.2, label: '알 수 없음', text: 1, known: false };
}

/* ------------------------------------------------------------------ */
/* 모델 목록 받아오기                                                    */
/* ------------------------------------------------------------------ */

/** 이미지를 만들 수 있는 모델인지. */
export function looksLikeImageModel(model) {
  const id = String(model?.id || '').toLowerCase();
  if (!id) return false;

  // 이미지를 "읽는" 모델과 임베딩 모델을 먼저 걸러낸다.
  if (/embedding|embed|aqa|tts|-live-|vision/i.test(id)) return false;

  const methods = model.methods || [];
  // Imagen 계열은 predict 로 구분된다.
  if (/^imagen/i.test(id) && methods.includes('predict')) return true;

  // Gemini 계열(Nano Banana)은 generateContent 만 표시돼서 이름으로 봐야 한다.
  // supportedGenerationMethods 에 이미지 출력 여부가 안 나온다.
  if (/-image/i.test(id) && methods.includes('generateContent')) return true;

  // 설명에 이미지 생성이라고 적혀 있으면 그것도 본다.
  if (/image generation|generates? images/i.test(model.description || '')
      && methods.includes('generateContent')) return true;

  return false;
}

/** 계정에서 쓸 수 있는 모델 목록을 받아온다. (가격은 안 들어 있다) */
export async function fetchModels(apiKey, { signal, timeoutMs = 30000 } = {}) {
  const models = [];
  let pageToken = '';

  // 목록이 길면 페이지로 나뉘어 온다. 이미지 모델이 뒷장에 있을 수 있다.
  for (let page = 0; page < 10; page += 1) {
    const url = `${HOST}?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const response = await fetch(url, {
      headers: { 'x-goog-api-key': apiKey },
      signal: signal || AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`모델 목록이 JSON 이 아닙니다 (${response.status}). ${text.slice(0, 120)}`);
    }
    if (!response.ok) {
      throw new Error(json?.error?.message || `모델 목록을 받지 못했습니다 (${response.status}).`);
    }

    for (const entry of json.models || []) {
      models.push({
        // 응답의 name 은 "models/gemini-..." 형태다. 앞의 접두사를 뗀다.
        id: String(entry.name || '').replace(/^models\//, ''),
        displayName: entry.displayName || '',
        description: entry.description || '',
        methods: entry.supportedGenerationMethods || [],
      });
    }

    pageToken = json.nextPageToken || '';
    if (!pageToken) break;
  }
  return models;
}

/**
 * 이미지 모델만 골라 **싼 순서로** 정렬한다.
 *
 * 글자까지 그리는 full 모드에서도 싼 것부터 쓴다. 싼 모델이 한글을 뭉갤 수는
 * 있지만 늘 그런 것은 아니고, 안 그래도 되는데 비싼 모델을 쓰는 쪽이 더 큰 손해다.
 * 대신 만들고 나서 글자를 확인해서, **실제로 깨졌을 때만** 한 단계 올라간다.
 * (maybeGenerateImage 참고)
 */
export function rankImageModels(models) {
  return models
    .filter(looksLikeImageModel)
    .map((model) => {
      const price = priceOf(model.id);
      return {
        id: model.id,
        displayName: model.displayName,
        usd: price.usd,
        tier: price.label,
        text: price.text,        // 한글을 얼마나 잘 그리는지 (표시용, 정렬에는 안 씀)
        knownPrice: price.known,
      };
    })
    // 값이 같으면 가격을 아는 쪽을, 그다음엔 글자를 잘 그리는 쪽을 먼저 쓴다.
    .sort((a, b) => (a.usd - b.usd)
      || (Number(b.knownPrice) - Number(a.knownPrice))
      || (b.text - a.text));
}

/** 이미지를 읽을 수 있는 값싼 모델. 글자가 깨졌는지 확인하는 데 쓴다. */
export function pickVisionModel(models) {
  const candidates = models
    .filter((model) => (model.methods || []).includes('generateContent'))
    .filter((model) => !/embedding|embed|aqa|tts|-live-|-image/i.test(model.id))
    .filter((model) => /gemini/i.test(model.id));
  // 글자만 몇 개 뱉는 일이라 가장 값싼 등급으로 충분하다.
  const order = [/flash-lite/i, /flash/i, /pro/i];
  for (const pattern of order) {
    const found = candidates.find((model) => pattern.test(model.id));
    if (found) return found.id;
  }
  return candidates[0]?.id || '';
}

/* ------------------------------------------------------------------ */
/* 목록 캐시                                                            */
/* ------------------------------------------------------------------ */

/** 키 자체는 저장하지 않는다. 키가 바뀌었는지만 알면 된다. */
function keyFingerprint(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(IMAGE_MODEL_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    ensureDirs();
    fs.writeFileSync(IMAGE_MODEL_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    logger.warn(`이미지 모델 목록을 저장하지 못했습니다: ${error.message}`);
  }
  return data;
}

/**
 * 쓸 수 있는 이미지 모델을 싼 순서로 돌려준다.
 *
 * 글 100편을 돌릴 때마다 목록을 받아올 이유는 없다. 하루에 한 번만 받고
 * 나머지는 저장해 둔 것을 쓴다. 키가 바뀌면 다시 받는다.
 *
 * @returns {Promise<{models: Array, at: string, fresh: boolean}>}
 */
export async function getImageModels({ force = false, signal } = {}) {
  const { image } = getSettings();
  const apiKey = String(image.apiKey || '').trim();
  if (!apiKey) throw new Error('이미지 API 키가 비어 있습니다.');

  const fingerprint = keyFingerprint(apiKey);
  const cached = readCache();
  const ttlMs = Math.max(1, Number(image.modelCacheHours) || 24) * 3600 * 1000;

  // 받아온 원본을 저장해 두고 정렬만 그때그때 한다.
  // 모드를 바꿨다고 모델 목록을 다시 받아올 이유는 없다.
  const usable = cached
    && cached.keyFingerprint === fingerprint
    && Array.isArray(cached.raw) && cached.raw.length
    && (Date.now() - new Date(cached.at).getTime()) < ttlMs;

  if (usable && !force) {
    return { models: rankImageModels(cached.raw), at: cached.at, fresh: false };
  }

  const all = await fetchModels(apiKey, { signal });
  const raw = all.filter(looksLikeImageModel);
  if (!raw.length) {
    throw new Error(
      '이 API 키로 쓸 수 있는 이미지 생성 모델이 하나도 없습니다. '
      + 'aistudio.google.com 에서 키가 이미지 생성을 지원하는지 확인해 주세요.',
    );
  }

  const saved = writeCache({
    keyFingerprint: fingerprint,
    at: new Date().toISOString(),
    raw,
    visionModel: pickVisionModel(all),   // 글자가 깨졌는지 확인할 때 쓴다
  });

  const models = rankImageModels(raw);
  logger.info(
    `이미지 모델 ${models.length}개를 찾았습니다. 가장 싼 것: ${models[0].id} `
    + `(${models[0].tier}, 장당 약 $${models[0].usd})`,
  );
  return { models, at: saved.at, fresh: true };
}

/** 쓸 수 없다고 판명된 모델을 캐시에서 빼둔다. 다음 글부터 건너뛴다. */
function dropModel(id) {
  const cached = readCache();
  if (!cached?.raw) return;
  const raw = cached.raw.filter((model) => model.id !== id);
  if (raw.length === cached.raw.length) return;
  writeCache({ ...cached, raw });
  logger.warn(`'${id}' 을(를) 쓸 수 있는 모델 목록에서 뺐습니다.`);
}

/* ------------------------------------------------------------------ */
/* 프롬프트                                                            */
/* ------------------------------------------------------------------ */

/** 썸네일 비율(1200x630 등)에 가장 가까운 허용 비율을 고른다. */
export function pickAspectRatio(width, height) {
  const wanted = Number(width) / Number(height);
  if (!Number.isFinite(wanted) || wanted <= 0) return '16:9';
  let best = '16:9';
  let bestGap = Infinity;
  for (const ratio of ASPECT_RATIOS) {
    const [w, h] = ratio.split(':').map(Number);
    const gap = Math.abs((w / h) - wanted);
    if (gap < bestGap) { bestGap = gap; best = ratio; }
  }
  return best;
}

/**
 * 그림 프롬프트.
 *
 * "글자를 넣지 마라" 를 여러 표현으로 반복한다. 한 번만 말하면 모델이
 * 간판이나 표지판 형태로 글자를 그려 넣는 일이 잦다.
 */
/* ------------------------------------------------------------------ */
/* full 모드 — 글자까지 통째로 그리는 포스터형 썸네일                     */
/* ------------------------------------------------------------------ */

const POSTER_LOOK = {
  bold: 'bold Korean clickbait-style blog thumbnail poster, vivid saturated colors, '
    + 'strong navy and orange and yellow accents, thick white outlines and drop shadows on the text, '
    + 'energetic and eye-catching, high contrast',
  clean: 'clean modern Korean blog thumbnail poster, calm navy and white palette with one accent color, '
    + 'generous spacing, restrained and trustworthy, editorial feel',
  playful: 'friendly Korean blog thumbnail poster, rounded soft shapes, cheerful pastel palette '
    + 'with warm accents, approachable cartoon illustration style',
};

/**
 * 프롬프트에 넣을 한 줄.
 * 따옴표가 섞이면 지시가 끊기고, 줄바꿈이 들어가면 문단이 갈라진다.
 * 둘 다 공백으로 바꾸고 남은 공백을 하나로 줄인다.
 */
const quote = (value) => `"${String(value || '').replace(/["\n]/g, ' ').replace(/\s+/g, ' ').trim()}"`;

/**
 * 글자까지 포함한 완성 썸네일 프롬프트.
 *
 * 핵심은 **어떤 글자가 어디에 들어가는지 한 글자씩 못박는 것**이다.
 * "제목을 넣어줘" 라고 하면 모델이 알아서 문구를 지어내고, 그 과정에서
 * 한글이 뭉개진다. 넣을 글자를 정확히 적어주고 "이 글자 말고는 아무것도
 * 쓰지 마라" 고 해야 그나마 정확히 나온다.
 */
export function buildPosterPrompt(spec, poster) {
  const lines = (Array.isArray(spec.posterLines) && spec.posterLines.length
    ? spec.posterLines
    : [spec.headline]).filter(Boolean).slice(0, 3);

  const look = POSTER_LOOK[poster] || POSTER_LOOK.bold;
  const scene = String(spec.scene || '').trim()
    || 'a bright Korean workplace scene related to the topic';
  const keywords = (Array.isArray(spec.keywords) ? spec.keywords : []).filter(Boolean).slice(0, 5);

  const parts = [
    look,
    `wide banner composition. Background illustration: ${scene}`,

    // 여기부터가 글자 지시. 넣을 문구를 한 줄씩 정확히 적는다.
    'The poster must contain EXACTLY the following Korean text and NOTHING else:',
    `Main headline, stacked on ${lines.length} line(s), the largest text on the poster, `
      + `each line rendered exactly as written: ${lines.map(quote).join(' then ')}`,
  ];

  if (spec.ribbon) {
    parts.push(`A ribbon or banner strip across the lower middle reading exactly ${quote(spec.ribbon)}`);
  }
  if (spec.subline) {
    parts.push(`A smaller supporting line under the headline reading exactly ${quote(spec.subline)}`);
  }
  if (spec.badge) {
    parts.push(`A small rounded badge in a corner reading exactly ${quote(spec.badge)}`);
  }
  if (keywords.length) {
    parts.push(
      'A vertical column of small circular icon badges along one side, each with a simple flat icon '
      + `and a short Korean label under it, the labels being exactly: ${keywords.map(quote).join(', ')}`,
    );
  }

  parts.push(
    // 한글이 깨지는 것을 막는 지시. 여러 번 다르게 반복해야 그나마 듣는다.
    'CRITICAL: every Korean character must be rendered perfectly and legibly, '
    + 'correct Hangul syllable shapes, no broken, garbled, invented, duplicated or misspelled characters',
    'Use a heavy rounded Korean sans-serif typeface (like Noto Sans KR Black) for the headline',
    'Do NOT add any other text, no English words, no lorem ipsum, no watermark, no logo, no signature, '
    + 'no website address, no page numbers, no extra captions beyond the lines listed above',
    'Do not show any real person\'s face, no brand logos, no copyrighted characters',
    'Text must sit on solid or shaded panels so it stays readable against the illustration',
  );

  return parts.join('. ');
}

export function buildImagePrompt(spec, style) {
  const scene = String(spec.scene || '').trim()
    || `a clean conceptual illustration about ${spec.headline || 'an informative article'}`;

  const looks = {
    flat: 'flat vector illustration, simple geometric shapes, soft muted palette, generous negative space',
    soft: 'soft gradient illustration, gentle rounded shapes, calm pastel palette, lots of empty space',
    photo: 'clean minimal photograph, shallow depth of field, soft natural light, uncluttered composition',
    line: 'minimal line art illustration, thin confident strokes, two tone palette, airy composition',
  }[style] || 'flat vector illustration, soft muted palette, generous negative space';

  return [
    scene,
    looks,
    // 글자를 얹을 자리를 비워두게 한다. 안 그러면 가운데가 꽉 차서 문구가 안 보인다.
    'composition keeps the left half and the center visually calm and uncluttered so text can be placed there',
    'no text, no letters, no words, no numbers, no typography, no captions, no labels',
    'no signage, no billboards, no book titles, no watermark, no logo, no signature, no UI elements',
    'blog header background image, wide banner',
  ].join('. ');
}

/* ------------------------------------------------------------------ */
/* 응답에서 이미지 꺼내기                                                */
/* ------------------------------------------------------------------ */

/** Gemini(:generateContent) 응답에서 base64 이미지를 찾는다. */
function fromGenerateContent(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    // SDK 판마다 camelCase 와 snake_case 가 섞여 온다. 둘 다 본다.
    const inline = part?.inlineData || part?.inline_data;
    const data = inline?.data;
    if (data) return { data, mimeType: inline.mimeType || inline.mime_type || 'image/png' };
  }
  return null;
}

/** Imagen(:predict) 응답에서 base64 이미지를 찾는다. */
function fromPredict(json) {
  for (const prediction of json?.predictions || []) {
    const data = prediction?.bytesBase64Encoded || prediction?.bytes_base64_encoded;
    if (data) return { data, mimeType: prediction.mimeType || prediction.mime_type || 'image/png' };
  }
  return null;
}

/** 모델이 글자만 돌려보낸 경우 그 이유를 알려준다. */
function refusalText(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((part) => part?.text).filter(Boolean).join(' ').trim();
  const blocked = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason;
  if (text) return text.slice(0, 200);
  if (blocked) return `모델이 생성을 거부했습니다 (${blocked})`;
  return '';
}

/* ------------------------------------------------------------------ */
/* 호출                                                                */
/* ------------------------------------------------------------------ */

function explain(status, json, model) {
  const message = json?.error?.message || '';
  if (status === 400 && /API key not valid/i.test(message)) {
    return 'API 키가 올바르지 않습니다. aistudio.google.com 에서 키를 다시 확인해 주세요.';
  }
  if (status === 403) return `이 API 키로는 이미지 생성을 쓸 수 없습니다 (403). ${message}`;
  if (status === 404) return `'${model}' 모델을 찾을 수 없습니다 (404). ${message}`;
  if (status === 429) {
    return '이미지 생성 한도에 걸렸습니다 (429). 무료 등급이라면 잠시 뒤에 다시 시도해 주세요.';
  }
  return `이미지 생성에 실패했습니다 (${status}). ${message || '(내용 없음)'}`;
}

/** 이 모델이 이제 없다는 뜻의 오류인가. 그렇다면 다음 모델로 넘어가면 된다. */
function modelIsGone(status, json) {
  if (status === 404) return true;
  const message = String(json?.error?.message || '');
  return status === 400 && /not found|not supported|is not available|deprecat/i.test(message);
}

/** 모델 하나로 한 번 시도한다. */
async function attempt(model, prompt, ratio, apiKey, { signal, timeoutMs }) {
  // Imagen 계열은 :predict, Gemini 계열은 :generateContent 를 쓴다.
  const isImagen = /^imagen/i.test(model);
  const url = `${HOST}/${encodeURIComponent(model)}:${isImagen ? 'predict' : 'generateContent'}`;

  const body = isImagen
    ? { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: ratio } }
    : {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        // 이걸 빼면 그림 대신 "그려드리겠습니다" 같은 글만 돌아온다.
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: ratio },
      },
    };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error('이미지 생성이 제한 시간 안에 끝나지 않았습니다.');
    }
    throw new Error(`이미지 API 에 연결하지 못했습니다: ${error.cause?.message || error.message}`);
  }

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `이미지 API 가 JSON 이 아닌 응답을 보냈습니다 (${response.status}). `
      + `앞부분: ${text.slice(0, 140).replace(/\s+/g, ' ')}`,
    );
  }

  if (!response.ok) {
    const error = new Error(explain(response.status, json, model));
    error.modelGone = modelIsGone(response.status, json);
    throw error;
  }

  const found = isImagen ? fromPredict(json) : fromGenerateContent(json);
  if (!found) {
    const why = refusalText(json);
    throw new Error(`응답에 이미지가 없습니다.${why ? ` ${why}` : ''}`);
  }

  return {
    dataUri: `data:${found.mimeType};base64,${found.data}`,
    model,
    bytes: Math.round((found.data.length * 3) / 4),
  };
}

/**
 * 쓸 모델을 순서대로 정한다.
 * 설정에 모델을 직접 적어 뒀으면 그것만, 비워 뒀으면 순위대로 여러 개.
 */
async function candidates({ signal, exclude }) {
  const { image } = getSettings();
  const manual = String(image.model || '').trim();
  if (manual) return [{ id: manual, tier: '직접 지정', usd: null }];

  const { models } = await getImageModels({ signal });
  // 한글이 깨진다고 판명된 모델은 빼고 그다음으로 싼 것부터 쓴다.
  const usable = exclude?.size ? models.filter((model) => !exclude.has(model.id)) : models;
  // 첫 번째가 죽어 있을 때를 대비해 뒤 후보까지 몇 개 들고 간다.
  return usable.slice(0, 4);
}

/* ------------------------------------------------------------------ */
/* 글자 검사                                                            */
/* ------------------------------------------------------------------ */

/**
 * 그림 안의 한글이 제대로 나왔는지 이미지를 다시 읽어 확인한다.
 *
 * 글자를 이미지에 직접 그리게 하면 한글이 뭉개지는 일이 있다.
 * 100편을 돌린 뒤에 알면 늦으므로 만들자마자 확인한다.
 * 글자 몇 개만 돌려받는 호출이라 값은 거의 안 든다.
 *
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
export async function verifyKoreanText(dataUri, expectedLines, { signal } = {}) {
  const { image } = getSettings();
  const apiKey = String(image.apiKey || '').trim();
  const cached = readCache();
  const model = cached?.visionModel;
  if (!apiKey || !model) return { ok: true, reason: '확인할 모델이 없어 건너뜀' };

  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUri);
  if (!match) return { ok: true, reason: '이미지를 읽지 못해 건너뜀' };

  const wanted = expectedLines.filter(Boolean).map((line) => `"${line}"`).join(', ');
  const prompt = [
    '이 이미지에 있는 한글 글자를 그대로 읽어 주세요.',
    `이 문구들이 오타 없이 정확히 들어 있어야 합니다: ${wanted}`,
    '글자가 뭉개졌거나, 없는 글자가 섞였거나, 문구가 틀렸으면 실패입니다.',
    '아래 JSON 만 출력하세요.',
    '{"readable": true, "matches": true, "found": "이미지에서 읽은 글자", "problem": "문제가 있으면 한 줄"}',
  ].join('\n');

  try {
    const response = await fetch(`${HOST}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: match[1], data: match[2] } },
            { text: prompt },
          ],
        }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      signal: signal || AbortSignal.timeout(60000),
    });

    const json = await response.json();
    if (!response.ok) return { ok: true, reason: `확인 실패, 넘어감 (${response.status})` };

    const text = (json?.candidates?.[0]?.content?.parts || [])
      .map((part) => part?.text).filter(Boolean).join('');
    const verdict = JSON.parse(text);

    if (verdict.readable === false || verdict.matches === false) {
      return {
        ok: false,
        reason: verdict.problem || `읽힌 글자: ${String(verdict.found || '').slice(0, 80)}`,
      };
    }
    return { ok: true, reason: '' };
  } catch (error) {
    // 확인 자체가 실패한 것을 "글자가 깨졌다"로 보면 멀쩡한 그림을 버리게 된다.
    return { ok: true, reason: `확인하지 못해 넘어갑니다 (${error.message})` };
  }
}

/**
 * 배경 그림 한 장을 만든다.
 *
 * 모델을 직접 지정하지 않았으면 가장 싼 것부터 시도하고,
 * 그 모델이 없어졌으면 다음으로 싼 것으로 알아서 넘어간다.
 *
 * @returns {Promise<{dataUri, model, bytes, tier, usd, switched}>}
 * @throws  실패하면 사람이 읽을 수 있는 이유를 담아 던진다. 부르는 쪽에서 잡아 넘긴다.
 */
export async function generateBackground(spec, { signal, aspectRatio, mode, exclude } = {}) {
  const { image } = getSettings();
  const apiKey = String(image.apiKey || '').trim();
  if (!apiKey) throw new Error('이미지 API 키가 비어 있습니다.');

  const ratio = ASPECT_RATIOS.has(aspectRatio) ? aspectRatio : '16:9';
  const useFull = (mode || image.mode) === 'full';
  const prompt = useFull
    ? buildPosterPrompt(spec, image.poster)
    : buildImagePrompt(spec, image.style);
  const timeoutMs = image.timeoutMs || 180000;

  const list = await candidates({ signal, exclude });
  let lastError = null;

  for (const [index, candidate] of list.entries()) {
    try {
      const result = await attempt(candidate.id, prompt, ratio, apiKey, { signal, timeoutMs });
      return { ...result, tier: candidate.tier, usd: candidate.usd, switched: index > 0 };
    } catch (error) {
      lastError = error;
      // 모델이 없어진 경우에만 다음 후보로 넘어간다. 키 오류나 한도 초과는
      // 다른 모델로 바꿔도 똑같이 실패하므로 바로 올린다.
      if (!error.modelGone) throw error;
      dropModel(candidate.id);
      if (index < list.length - 1) {
        logger.warn(`'${candidate.id}' 이(가) 없어졌습니다. 다음으로 싼 모델로 시도합니다.`);
      }
    }
  }

  throw new Error(
    `쓸 수 있는 이미지 모델을 찾지 못했습니다. 마지막 오류: ${lastError?.message || '(없음)'}`,
  );
}

/** full 모드에서 그림 안에 정확히 들어가야 하는 문구들. */
function expectedLines(spec) {
  const lines = Array.isArray(spec.posterLines) && spec.posterLines.length
    ? spec.posterLines
    : [spec.headline];
  return [...lines, spec.ribbon].filter(Boolean);
}

/**
 * 썸네일 이미지를 만든다. 실패해도 글을 막지 않는다.
 * 꺼져 있거나 키가 없으면 조용히 null 을 준다.
 *
 * full 모드는 글자까지 그리게 하고, 글자가 깨졌으면 한 번 다시 그린다.
 * 그래도 깨지면 null 을 돌려 HTML 썸네일로 물러선다.
 *
 * @returns {Promise<{dataUri, model, bytes, mode}|null>}
 */
export async function maybeGenerateImage(spec, { signal, width, height, jobId = '' } = {}) {
  const { image } = getSettings();
  if (!image.enabled) return null;
  if (!String(image.apiKey || '').trim()) {
    logger.warn('이미지 생성이 켜져 있지만 API 키가 없습니다. HTML 썸네일로 만듭니다.', { jobId });
    return null;
  }

  const full = image.mode === 'full';
  const aspectRatio = pickAspectRatio(width, height);
  const what = full ? '썸네일' : '썸네일 배경 그림';
  const checking = full && image.verifyText;

  /**
   * 항상 **가장 싼 모델부터** 쓴다.
   * 글자가 깨졌을 때만 이렇게 올라간다.
   *   1) 같은(가장 싼) 모델로 한 번 더 — 그냥 운이 나빴을 수 있다
   *   2) 그다음으로 싼 모델로 한 번 — 이 모델이 한글을 못 그리는 것일 수 있다
   *   3) 그래도 깨지면 HTML 썸네일 (한글이 절대 안 깨진다)
   * 대부분은 1번에서 끝나므로 값은 가장 싼 모델 한 장 값이다.
   */
  const tries = checking ? 3 : 1;
  const broken = new Set();
  let lastReason = '';

  for (let attempt = 1; attempt <= tries; attempt += 1) {
    // 두 번째까지는 같은(가장 싼) 모델, 세 번째부터 다음으로 싼 모델.
    const exclude = attempt >= 3 ? broken : undefined;

    let result;
    try {
      result = await generateBackground(spec, { signal, aspectRatio, exclude });
    } catch (error) {
      // 그림은 글의 부속물이다. 여기서 실패했다고 1,800자짜리 글을 버리지 않는다.
      logger.warn(`${what} 생성 실패, HTML 썸네일로 만듭니다: ${error.message}`, { jobId });
      return null;
    }

    const cost = result.usd ? `, 장당 약 $${result.usd}` : '';
    const made = `${result.model}${result.tier ? ` · ${result.tier}` : ''}${cost}, `
      + `${Math.round(result.bytes / 1024)}KB`;

    if (!checking) {
      logger.info(`${what}을(를) 만들었습니다. (${made})`, { jobId });
      return { ...result, mode: image.mode };
    }

    const verdict = await verifyKoreanText(result.dataUri, expectedLines(spec), { signal });
    if (verdict.ok) {
      logger.info(
        `${what}을(를) 만들었습니다. (${made}`
        + `${verdict.reason ? ` · ${verdict.reason}` : ' · 글자 확인 통과'}`
        + `${attempt > 1 ? ` · ${attempt}번째 시도` : ''})`,
        { jobId },
      );
      return { ...result, mode: image.mode };
    }

    lastReason = verdict.reason;
    broken.add(result.model);
    logger.warn(
      `썸네일의 한글이 제대로 안 나왔습니다 (${attempt}/${tries}, ${result.model}): ${verdict.reason}`
      + (attempt === 2 ? ' — 다음으로 싼 모델로 바꿔 봅니다.' : ''),
      { jobId },
    );
  }

  logger.warn(
    `한글이 계속 깨져 HTML 썸네일로 만듭니다. 마지막 문제: ${lastReason}`
    + ' (설정에서 "배경만 그리기" 로 바꾸면 한글이 깨질 일이 없습니다)',
    { jobId },
  );
  return null;
}

/** 예전 이름. 부르는 곳이 남아 있을 수 있어 남겨 둔다. */
export const maybeGenerateBackground = maybeGenerateImage;
