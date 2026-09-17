import { escapeHtml } from '../lib/util.js';

/**
 * 글 데이터를 **네이버 스마트에디터 ONE 에 붙여넣을 HTML** 로 바꾼다.
 *
 * 워드프레스판은 구텐베르크 블록 마크업(`<!-- wp:paragraph -->`)을 만들어
 * REST API 로 한 번에 보냈다. 네이버에는 그런 통로가 없다. 실제 브라우저를 띄워
 * 에디터에 붙여넣어야 하고, 에디터는 자기 방식대로 서식을 다시 칠한다.
 * 그래서 워드프레스판과 반대로 움직인다.
 *
 *   - 인라인 style 을 **모든 요소에 박는다.** 색을 비워두면 에디터가 바로 앞
 *     블록의 색을 물려받아서, 표 아래 회색 안내문 다음부터 본문이 전부 회색이 된다.
 *   - h2/h3 를 쓰지 않는다. 에디터가 제목 스타일을 자기 것으로 갈아끼우면서
 *     크기가 들쭉날쭉해진다. 굵고 큰 문단으로 직접 그리는 편이 결과가 일정하다.
 *   - 본문을 **조각으로 쪼갠다.** 100행짜리 표까지 한 번에 밀어 넣으면 에디터가
 *     덩어리를 감당하지 못하고 표만 통째로 흘려버린다.
 */

/**
 * 본문 글자에서 주소(https://...)를 걷어내고 호스트만 남긴다.
 *
 * 네이버 에디터는 본문 글자 안의 주소를 스스로 찾아내 **링크 카드로 갈아끼운다.**
 * 그러면 그 문단에 적어둔 글이 통째로 사라지고 기사 카드만 남는다.
 * 프롬프트에서 "본문에 URL 을 적지 마라" 고 지시하지만 모델이 어길 때가 있어서,
 * 에디터로 나가는 마지막 길목인 여기서 한 번 더 막는다.
 *
 *   https://www.q-net.or.kr/notice/1234  ->  q-net.or.kr
 */
export function stripUrls(text) {
  return String(text ?? '').replace(
    /\bhttps?:\/\/(?:www\.)?([^\s<>"']+)/gi,
    (match, rest) => String(rest).split(/[/?#]/)[0] || match,
  );
}

/**
 * AI 는 문단 안에서 <b> 만 쓰도록 지시받는다.
 * 그래서 전부 이스케이프한 뒤 <b> 만 되살려 태그 주입을 막는다.
 */
function inline(text) {
  return escapeHtml(stripUrls(text))
    .replace(/&lt;b&gt;/gi, '<b>')
    .replace(/&lt;\/b&gt;/gi, '</b>')
    .replace(/&lt;strong&gt;/gi, '<b>')
    .replace(/&lt;\/strong&gt;/gi, '</b>');
}

const BLACK = '#000000';
const GREEN = '#03c75a';          // 네이버 초록. 소제목 띠와 인용 줄에 쓴다.
const P = `margin:0 0 14px 0; line-height:1.9; font-size:16px; color:${BLACK}; text-align:left;`;
const SPACER = `<p style="color:${BLACK}; text-align:left;"><br></p>`;

/**
 * 붙여넣기 블록 사이에 넣는 빈 문단.
 *
 * 에디터는 붙여넣은 HTML 의 첫 문단을 커서가 있던 문단에 합쳐버린다.
 * 그래서 블록 맨 앞에 빈 문단을 하나 두어 그게 대신 합쳐지게 하고,
 * 진짜 내용은 제 서식을 지닌 새 문단으로 들어가게 한다.
 */
export const BLOCK_GAP = SPACER;

function paragraph(text) {
  return `<p style="${P}">${inline(text)}</p>`;
}

/** 큰 소제목. 워드프레스판의 H2 자리다. */
function heading(text) {
  return (
    `<p style="margin:34px 0 14px 0; line-height:1.6; font-size:19px; font-weight:700; `
    + `color:${BLACK}; text-align:left;">${inline(text)}</p>`
  );
}

/** 세부 소제목. 워드프레스판의 H3 자리. 한 단계 작고 왼쪽에 색 띠를 둔다. */
function subheading(text) {
  return (
    `<p style="margin:22px 0 10px 0; padding-left:10px; border-left:3px solid ${GREEN}; `
    + `line-height:1.5; font-size:16.5px; font-weight:700; color:${BLACK}; text-align:left;">`
    + `${inline(text)}</p>`
  );
}

function quote(text) {
  return (
    `<blockquote style="margin:20px 0; padding:12px 18px; border-left:4px solid ${GREEN}; `
    + `background:#f7f9f8; line-height:1.8; font-size:16px; color:${BLACK}; `
    + `text-align:left;">${inline(text)}</blockquote>`
  );
}

function list(items) {
  const li = items
    .map((item) => (
      `<li style="margin:0 0 8px 0; line-height:1.8; font-size:16px; color:${BLACK}; `
      + `text-align:left;">${inline(item)}</li>`
    ))
    .join('');
  return `<ul style="margin:16px 0 20px 0; padding-left:22px; color:${BLACK};">${li}</ul>`;
}

const divider = () => '<p style="text-align:center; margin:26px 0; color:#c0c6cc;">• • •</p>';

/**
 * 비교표. 네이버 에디터는 붙여넣은 <table> 을 자기 표 컴포넌트로 바꿔준다.
 *
 * 셀마다 테두리·여백·글자크기를 박으면 100행짜리 표가 50KB 를 넘고,
 * 그 덩치를 에디터가 감당하지 못해 표를 통째로 흘려버린다.
 * 테두리와 여백은 table 의 border/cellpadding 속성이, 글자 크기는 상속이 해준다.
 * 셀에는 색만 남긴다 (비워두면 앞 블록의 회색을 물려받는다).
 */
export function buildTableHtml(table) {
  if (!table?.headers?.length || !table.rows?.length) return '';

  const th = table.headers
    .map((header) => `<th style="background:#f3f6f8; color:${BLACK};">${inline(header)}</th>`)
    .join('');

  const trs = table.rows
    .map((row) => {
      const tds = row
        .map((cell, column) => (
          `<td style="color:${BLACK};${column === 0 ? 'text-align:center;font-weight:600;' : ''}">`
          + `${inline(cell)}</td>`
        ))
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');

  const parts = [];
  if (table.heading) parts.push(heading(table.heading));
  parts.push(
    '<table border="1" cellspacing="0" cellpadding="6" '
    + 'style="border-collapse:collapse; width:100%; margin:16px 0; '
    + `font-size:15px; line-height:1.6; color:${BLACK};">`
    + `<thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`,
  );
  if (table.note) {
    parts.push(
      `<p style="margin:10px 0 0 0; font-size:14px; color:#7a8590; line-height:1.7; `
      + `text-align:left;">${inline(table.note)}</p>`,
    );
    // 회색 안내문 뒤에 검정 문단을 하나 둬서 다음 블록이 회색을 물려받지 않게 한다.
    parts.push(SPACER);
  }
  return parts.join('');
}

/**
 * 표를 몇 행씩 끊어 여러 개의 작은 표로 만든다.
 *
 * 한 덩어리로 붙여넣다 실패했을 때 쓴다. 조각이 작으면 에디터가 받아준다.
 * 조각마다 머리글을 다시 넣어 따로 떼어 봐도 읽히게 하고,
 * 소제목은 첫 조각에만, 표 아래 안내문은 마지막 조각에만 붙인다.
 */
export function buildTableChunks(table, rowsPerChunk = 20) {
  if (!table?.headers?.length || !table.rows?.length) return [];

  const chunks = [];
  for (let start = 0; start < table.rows.length; start += rowsPerChunk) {
    const rows = table.rows.slice(start, start + rowsPerChunk);
    const last = start + rowsPerChunk >= table.rows.length;
    chunks.push(buildTableHtml({
      heading: start === 0 ? table.heading : '',
      headers: table.headers,
      rows,
      note: last ? table.note : '',
    }));
  }
  return chunks;
}

/** 서두의 "선정 기준" 단락. */
function criteriaHtml(criteria) {
  if (!criteria) return '';
  const blocks = [heading(criteria.heading || '추천 항목을 고른 기준')];
  criteria.paragraphs.forEach((text) => blocks.push(paragraph(text)));
  if (criteria.items?.length) blocks.push(list(criteria.items));
  return blocks.join('');
}

function subsectionHtml(sub) {
  const blocks = [subheading(sub.heading)];
  sub.paragraphs.forEach((text) => blocks.push(paragraph(text)));
  if (sub.list?.length) blocks.push(list(sub.list));
  return blocks.join('');
}

function sectionHtml(section) {
  const blocks = [];
  if (section.heading) blocks.push(heading(section.heading));
  section.paragraphs.forEach((text) => blocks.push(paragraph(text)));
  if (section.list?.length) blocks.push(list(section.list));
  for (const sub of section.subsections || []) blocks.push(subsectionHtml(sub));
  if (section.quote) blocks.push(quote(section.quote));
  return blocks.join('');
}

function faqHtml(faq) {
  if (!faq?.length) return '';
  const blocks = [heading('자주 묻는 질문')];
  for (const item of faq) {
    blocks.push(subheading(item.question));
    blocks.push(paragraph(item.answer));
  }
  return blocks.join('');
}

/**
 * 주소에서 사람이 알아볼 만한 이름만 뽑는다. (news.naver.com/foo -> news.naver.com)
 *
 * 스킴(https://)과 경로를 떼어내는 것이 핵심이다. 아래 sourcesHtml 의 설명 참고.
 */
function sourceLabel(source) {
  const url = String(source?.url || '');
  const host = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0];
  return host || '출처 미상';
}

/**
 * 글 끝의 참고 자료 목록.
 *
 * 워드프레스판은 <a> 링크 목록으로 넣었지만 여기서는 **글자로만** 적는다.
 * 네이버 에디터는 링크를 링크 카드로 부풀려 넣고, 외부 링크가 여러 개 붙은
 * 글은 검색에서 불리하게 볼 수 있기 때문이다.
 *
 * 그런데 `<a>` 태그를 안 쓰는 것만으로는 부족했다. **네이버는 본문 글자 안의
 * 주소(https://...)를 스스로 찾아내 링크 카드로 바꾼다.** 특히 문단 끝에 주소가
 * 오면 그 문단을 통째로 카드로 갈아끼운다. 그래서 출처 줄이 카드 하나로
 * 바뀌고, 앞에 적어둔 제목과 발행처는 사라진 채 기사 카드만 남는 사고가 났다.
 * (제목 + 기사 카드 하나만 있는 글이 임시저장되던 원인이다)
 *
 * 그래서 **본문에는 주소를 아예 넣지 않는다.** 제목과 발행처, 날짜만 적는다.
 * 전체 주소는 `research.json` 과 `preview.html` 에 그대로 남아 있어서
 * 발행 전에 원문을 대조하는 데는 아무 지장이 없다.
 */
function sourcesHtml(sources, headingText) {
  if (!sources?.length) return '';

  const lines = sources
    .map((source) => {
      const title = source.title || sourceLabel(source);
      const meta = [source.publisher, source.date]
        .filter(Boolean)
        .filter((part, index, all) => all.indexOf(part) === index)
        .join(', ');
      const text = `${title}${meta ? ` (${meta})` : ''}`;
      return (
        `<p style="margin:0 0 5px 0; line-height:1.7; font-size:13.5px; `
        + `color:#5b6773; text-align:left;">${inline(text)}</p>`
      );
    })
    .join('');

  return [
    heading(headingText || '참고 자료'),
    paragraph('아래 자료를 참고해 정리했습니다. 제도와 일정은 바뀔 수 있으니 '
      + '중요한 내용은 각 기관의 공식 공지에서 다시 확인하시기 바랍니다.'),
    lines,
  ].join('');
}

/** 글 끝의 태그 줄. 네이버 검색 유입의 실제 통로다. */
function tagsHtml(tags) {
  if (!tags?.length) return '';
  return (
    `<p style="margin:22px 0 0 0; line-height:1.8; font-size:15px; color:#4a5d70; `
    + `text-align:left;">${inline(tags.map((tag) => `#${tag}`).join(' '))}</p>`
  );
}

/** 썸네일 앞에 들어갈 도입부. */
export function buildIntroHtml(post) {
  return post.intro.map(paragraph).join(SPACER);
}

/**
 * 본문을 "조각" 단위로 쪼갠 배열.
 * (선정 기준 → 비교표 → 섹션들 → 자주 묻는 질문 → 마무리 → 참고 자료 → 태그)
 *
 * 조각 하나는 붙여넣기 경계로 쪼개도 안전한 단위다.
 * 표 조각은 원본 table 을 같이 들고 다닌다. 붙여넣기가 실패하면 그 자료로
 * 잘게 쪼개거나 그림으로 그려 넣어야 하기 때문이다.
 */
function bodyPieces(post, { sourcesHeading = '참고 자료', appendTags = true } = {}) {
  const pieces = [];
  const text = (html) => (html ? { html } : null);
  const tablePiece = (table) => {
    const html = buildTableHtml(table);
    return html ? { html, table } : null;
  };

  if (post.criteria) pieces.push(text(criteriaHtml(post.criteria)));
  pieces.push(tablePiece(post.table));

  post.sections.forEach((section, index) => {
    if (index > 0) pieces.push(text(divider()));
    pieces.push(text(sectionHtml(section)));
  });

  const faq = faqHtml(post.faq);
  if (faq) {
    pieces.push(text(divider()));
    pieces.push(text(faq));
  }

  if (post.outro.length) {
    pieces.push(text(divider()));
    pieces.push(text(post.outro.map(paragraph).join(SPACER)));
  }

  const sources = sourcesHtml(post.sources, sourcesHeading);
  if (sources) pieces.push(text(sources));
  if (appendTags) pieces.push(text(tagsHtml(post.tags)));

  return pieces.filter(Boolean);
}

/** 썸네일 뒤에 들어갈 본문 전체 (미리보기·백업용, 이미지 없이). */
export function buildBodyHtml(post, options = {}) {
  return bodyPieces(post, options).map((piece) => piece.html).join(SPACER);
}

/**
 * 본문을 붙여넣기 단계 목록으로 만든다. 표는 따로 떼어 한 번에 하나씩 붙인다.
 *
 * 100행짜리 표는 HTML 만 수십 KB 다. 다른 본문과 묶어서 한 번에 붙이면
 * 에디터가 덩어리를 감당하지 못하고 표만 통째로 흘려버린다.
 * 표를 따로 붙이면 payload 가 작아지고, 실패해도 어느 표가 빠졌는지 알 수 있다.
 *
 * @returns {Array<{html: string, table?: object}>}
 */
export function buildBodyPlan(post, options = {}) {
  const plan = [];
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    plan.push({ html: buffer.join(SPACER) });
    buffer = [];
  };

  for (const piece of bodyPieces(post, options)) {
    if (piece.table) {
      flush();
      plan.push({ html: piece.html, table: piece.table });
      continue;
    }
    buffer.push(piece.html);
  }
  flush();
  return plan;
}

/** 클립보드에는 text/html 과 text/plain 을 같이 넣어야 붙여넣기가 안정적이다. */
export function htmlToPlainText(html) {
  return html
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\t\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 미리보기·백업용 단일 HTML 문서.
 *
 * 네이버 저장이 실패해도 이 파일을 브라우저로 열어 전체를 복사하면
 * 에디터에 그대로 붙여넣을 수 있다. 그래서 본문은 실제로 보내는 것과 같은
 * HTML 을 쓰고, 확인용 정보만 맨 위에 상자로 얹는다.
 */
export function buildPreviewHtml(post, { thumbnailSrc = '', sourcesHeading = '참고 자료', appendTags = true } = {}) {
  const image = thumbnailSrc
    ? `<p style="margin:24px 0;"><img src="${escapeHtml(thumbnailSrc)}" style="max-width:100%;" `
      + `alt="${escapeHtml(post.title)}"></p>`
    : '';

  const meta = [];
  if (post.guideline) {
    meta.push(`<b>적용된 추가 지침</b><br>${escapeHtml(post.guideline).replace(/\n/g, '<br>')}`);
  }
  if (post.guidelineCheck) meta.push(`<b>AI 자체 확인</b><br>${escapeHtml(post.guidelineCheck)}`);
  if (post.model) meta.push(`<b>사용 모델</b> ${escapeHtml(post.model)}`);
  if (post.tags?.length) meta.push(`<b>태그</b> ${escapeHtml(post.tags.join(', '))}`);

  // 발행 전에 사람이 확인해야 하는 부분이라 미리보기 맨 위에 올린다.
  if (post.research) {
    const research = post.research;
    const rows = [
      `검색 ${research.searches}회 · 사실 ${research.facts.length}건 · 출처 ${research.sources.length}건`,
    ];
    if (!research.searches) {
      rows.push('<b style="color:#b3302a;">웹 검색이 실제로 실행되지 않았습니다. '
        + '아래 내용은 검색 결과가 아닐 수 있으니 반드시 직접 확인하세요.</b>');
    }
    if (research.freshness) rows.push(`최신성: ${escapeHtml(research.freshness)}`);
    if (research.unverified?.length) {
      rows.push(`<b>확인하지 못한 내용</b><br>${research.unverified
        .map((item) => `- ${escapeHtml(item)}`).join('<br>')}`);
    }
    meta.push(`<b>자료 조사</b><br>${rows.join('<br>')}`);
  }
  if (post.compliance) {
    const rows = post.compliance.results
      .map((result) => `${result.ok ? '통과' : '미통과'} · ${escapeHtml(result.label)} — ${escapeHtml(result.detail)}`)
      .join('<br>');
    meta.push(`<b>품질 점검 (${post.compliance.passed}/${post.compliance.total})</b><br>${rows}`);
  }

  const metaBox = meta.length
    ? '<div style="margin:0 0 24px 0; padding:12px 16px; background:#f3f6f8; border-radius:8px; '
      + `font-size:13px; color:#5b6773; line-height:1.8;">${meta.join('<br><br>')}</div>`
    : '';

  return [
    '<!doctype html><meta charset="utf-8">',
    `<title>${escapeHtml(post.title)}</title>`,
    '<div style="max-width:760px; margin:40px auto; padding:0 20px; '
    + "font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif; color:#1a1a1a;\">",
    `<h1 style="font-size:28px; line-height:1.4; margin:0 0 24px 0;">${escapeHtml(post.title)}</h1>`,
    metaBox,
    buildIntroHtml(post),
    image,
    buildBodyHtml(post, { sourcesHeading, appendTags }),
    '</div>',
  ].join('\n');
}
