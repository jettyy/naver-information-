import { escapeHtml } from '../../lib/util.js';

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(((n >> 16) & 255) + amount);
  const g = clamp(((n >> 8) & 255) + amount);
  const b = clamp((n & 255) + amount);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

const FONT = `'Pretendard','Pretendard Variable','Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic','Nanum Gothic',sans-serif`;

function shell(width, height, body, extraCss = '') {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${width}px; height:${height}px; overflow:hidden; }
  body { font-family:${FONT}; -webkit-font-smoothing:antialiased; }
  .card { width:${width}px; height:${height}px; display:flex; position:relative; overflow:hidden; }
  .badge { display:inline-block; font-size:${Math.round(height * 0.036)}px; font-weight:700;
           letter-spacing:0.02em; padding:${Math.round(height * 0.018)}px ${Math.round(height * 0.038)}px;
           border-radius:999px; }
  .headline { font-weight:900; letter-spacing:-0.03em; word-break:keep-all; }
  .subline { font-weight:500; word-break:keep-all; }
  ${extraCss}
</style></head><body>${body}</body></html>`;
}

/** 진한 단색 배경 + 큰 글씨. 정보성 글에 무난하다. */
function bold({ headline, subline, badge, emoji, accent, width, height }) {
  return shell(width, height, `
  <div class="card" style="background:${accent}; flex-direction:column; justify-content:center; padding:${height * 0.11}px;">
    <div style="position:absolute; right:${-height * 0.12}px; top:${-height * 0.18}px;
                width:${height * 0.62}px; height:${height * 0.62}px; border-radius:50%;
                background:${shade(accent, 26)};"></div>
    <div style="position:absolute; right:${height * 0.16}px; bottom:${-height * 0.22}px;
                width:${height * 0.46}px; height:${height * 0.46}px; border-radius:50%;
                background:${shade(accent, 16)};"></div>
    <div style="position:relative;">
      ${badge ? `<div class="badge" style="background:rgba(255,255,255,0.18); color:#fff; margin-bottom:${height * 0.055}px;">${escapeHtml(badge)}</div>` : ''}
      <div class="headline" style="font-size:${height * 0.135}px; line-height:1.24; color:#fff;">
        ${emoji ? `<span style="margin-right:0.2em;">${escapeHtml(emoji)}</span>` : ''}${escapeHtml(headline)}
      </div>
      ${subline ? `<div class="subline" style="margin-top:${height * 0.045}px; font-size:${height * 0.052}px; line-height:1.6; color:rgba(255,255,255,0.82);">${escapeHtml(subline)}</div>` : ''}
    </div>
  </div>`);
}

/** 사선 그라데이션. 감성적인 주제나 후기성 글에 어울린다. */
function gradient({ headline, subline, badge, emoji, accent, width, height }) {
  return shell(width, height, `
  <div class="card" style="background:linear-gradient(135deg, ${shade(accent, -28)} 0%, ${accent} 48%, ${shade(accent, 62)} 100%);
       flex-direction:column; justify-content:flex-end; padding:${height * 0.1}px;">
    <div style="position:absolute; inset:0; background:
         radial-gradient(circle at 78% 22%, rgba(255,255,255,0.24) 0%, rgba(255,255,255,0) 46%);"></div>
    <div style="position:relative;">
      ${emoji ? `<div style="font-size:${height * 0.11}px; margin-bottom:${height * 0.03}px;">${escapeHtml(emoji)}</div>` : ''}
      ${badge ? `<div class="badge" style="background:#fff; color:${shade(accent, -30)}; margin-bottom:${height * 0.04}px;">${escapeHtml(badge)}</div>` : ''}
      <div class="headline" style="font-size:${height * 0.128}px; line-height:1.26; color:#fff; text-shadow:0 2px 18px rgba(0,0,0,0.18);">
        ${escapeHtml(headline)}
      </div>
      ${subline ? `<div class="subline" style="margin-top:${height * 0.04}px; font-size:${height * 0.05}px; line-height:1.6; color:rgba(255,255,255,0.9);">${escapeHtml(subline)}</div>` : ''}
    </div>
  </div>`);
}

/** 흰 배경 + 얇은 테두리. 정보성 글에 가장 잘 어울린다. */
function minimal({ headline, subline, badge, emoji, accent, width, height }) {
  return shell(width, height, `
  <div class="card" style="background:#fff; padding:${height * 0.06}px;">
    <div style="flex:1; border:${Math.max(2, height * 0.004)}px solid ${accent}; border-radius:${height * 0.03}px;
                display:flex; flex-direction:column; justify-content:center; padding:${height * 0.085}px; position:relative;">
      <div style="position:absolute; left:0; top:${height * 0.12}px; bottom:${height * 0.12}px;
                  width:${height * 0.014}px; background:${accent};"></div>
      ${badge ? `<div class="badge" style="background:${accent}; color:#fff; align-self:flex-start; margin-bottom:${height * 0.05}px;">${escapeHtml(badge)}</div>` : ''}
      <div class="headline" style="font-size:${height * 0.125}px; line-height:1.28; color:#14171a;">
        ${escapeHtml(headline)}${emoji ? `<span style="margin-left:0.2em;">${escapeHtml(emoji)}</span>` : ''}
      </div>
      ${subline ? `<div class="subline" style="margin-top:${height * 0.045}px; font-size:${height * 0.05}px; line-height:1.6; color:#5b6570;">${escapeHtml(subline)}</div>` : ''}
    </div>
  </div>`);
}

/** 잡지 표지풍. 좌측 컬러 블록 + 우측 큰 제목. */
function editorial({ headline, subline, badge, emoji, accent, width, height }) {
  return shell(width, height, `
  <div class="card" style="background:#f4f1ec;">
    <div style="width:${width * 0.3}px; background:${accent}; display:flex; align-items:center; justify-content:center;">
      <div style="font-size:${height * 0.2}px; color:#fff; font-weight:900;">${escapeHtml(emoji || (badge || headline).slice(0, 2))}</div>
    </div>
    <div style="flex:1; display:flex; flex-direction:column; justify-content:center; padding:${height * 0.09}px;">
      ${badge ? `<div style="font-size:${height * 0.04}px; font-weight:700; letter-spacing:0.18em; color:${accent}; margin-bottom:${height * 0.035}px;">${escapeHtml(badge.toUpperCase())}</div>` : ''}
      <div class="headline" style="font-size:${height * 0.115}px; line-height:1.3; color:#1b1a17;">${escapeHtml(headline)}</div>
      <div style="width:${height * 0.16}px; height:${Math.max(3, height * 0.006)}px; background:${accent}; margin:${height * 0.045}px 0;"></div>
      ${subline ? `<div class="subline" style="font-size:${height * 0.048}px; line-height:1.6; color:#565049;">${escapeHtml(subline)}</div>` : ''}
    </div>
  </div>`);
}

/**
 * 배경 그림 위에 한글을 얹는 레이아웃.
 *
 * 이미지 생성 모델은 한글을 자주 뭉갠다. 그래서 그림에는 글자를 넣지 않게 하고,
 * 문구는 여기서 브라우저가 그린다. 그러면 글자가 절대 깨지지 않는다.
 *
 * 배경이 밝을지 어두울지 알 수 없으므로, 왼쪽에서 오른쪽으로 어두워지는
 * 가림막(scrim)을 깔고 그 위에 흰 글씨를 올린다. 어떤 그림이 와도 읽힌다.
 */
function illustrated({ headline, subline, badge, emoji, accent, background, width, height }) {
  const pad = height * 0.095;
  return shell(width, height, `
  <div class="card" style="background:${accent}; flex-direction:column; justify-content:flex-end; padding:${pad}px;">
    <img src="${background}" alt=""
         style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover;">
    <div style="position:absolute; inset:0; background:
         linear-gradient(100deg, rgba(8,12,18,0.86) 0%, rgba(8,12,18,0.70) 46%, rgba(8,12,18,0.08) 100%);"></div>
    <div style="position:absolute; left:0; top:${pad}px; bottom:${pad}px;
                width:${Math.max(4, height * 0.012)}px; background:${shade(accent, 70)};"></div>
    <div style="position:relative; max-width:78%;">
      ${badge ? `<div class="badge" style="background:rgba(255,255,255,0.94); color:#14171a; margin-bottom:${height * 0.042}px;">${escapeHtml(badge)}</div>` : ''}
      <div class="headline" style="font-size:${height * 0.132}px; line-height:1.24; color:#fff;
           text-shadow:0 2px 20px rgba(0,0,0,0.45);">
        ${emoji ? `<span style="margin-right:0.2em;">${escapeHtml(emoji)}</span>` : ''}${escapeHtml(headline)}
      </div>
      ${subline ? `<div class="subline" style="margin-top:${height * 0.04}px; font-size:${height * 0.05}px;
           line-height:1.6; color:rgba(255,255,255,0.93); text-shadow:0 1px 12px rgba(0,0,0,0.5);">${escapeHtml(subline)}</div>` : ''}
    </div>
  </div>`);
}

export const TEMPLATES = { bold, gradient, minimal, editorial, illustrated };

/**
 * 배경 그림이 있으면 illustrated 레이아웃으로 간다.
 * minimal(흰 배경)이나 editorial(2단 분할)에 그림을 억지로 끼우면
 * 문구가 그림에 묻히거나 잘린다. 아예 전용 레이아웃을 쓰는 편이 안전하다.
 */
export function renderTemplate(spec) {
  if (spec.background) return illustrated(spec);
  const build = TEMPLATES[spec.style] || TEMPLATES.bold;
  return build(spec);
}
