/**
 * 같은 글을 마크다운으로도 뽑아 둔다.
 *
 * 네이버 에디터는 마크다운을 모른다. 그래서 이 파일은 에디터용이 아니라
 * **사람과 다른 도구를 위한 보관본**이다. 자동화가 끝내 실패했을 때 내용을
 * 읽거나, 다른 곳(워드프레스·티스토리·문서)으로 옮길 때 쓴다.
 * 네이버에 그대로 붙여넣을 것은 같은 폴더의 preview.html 쪽이다.
 *
 * H1 은 글 제목 하나뿐이고, 소제목은 H2/H3 로만 쓴다.
 */

/** 마크다운 표에서 셀 구분자로 오해받는 문자를 막는다. */
function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

/** <b> 강조는 마크다운 굵게로 바꾼다. */
function inline(text) {
  return String(text ?? '')
    .replace(/<\s*b\s*>/gi, '**')
    .replace(/<\s*\/\s*b\s*>/gi, '**')
    .replace(/<\s*strong\s*>/gi, '**')
    .replace(/<\s*\/\s*strong\s*>/gi, '**')
    .trim();
}

function tableMarkdown(table) {
  if (!table?.headers?.length || !table.rows?.length) return [];
  const lines = [];
  if (table.heading) lines.push(`### ${inline(table.heading)}`, '');
  lines.push(`| ${table.headers.map(cell).join(' | ')} |`);
  lines.push(`| ${table.headers.map(() => '---').join(' | ')} |`);
  for (const row of table.rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
  lines.push('');
  if (table.note) lines.push(`> ${inline(table.note)}`, '');
  return lines;
}

export function buildMarkdown(post, { thumbnailFile = '', sourcesHeading = '참고 자료' } = {}) {
  const lines = [`# ${inline(post.title)}`, ''];

  post.intro.forEach((text) => lines.push(inline(text), ''));

  if (thumbnailFile) lines.push(`![${inline(post.title)}](${thumbnailFile})`, '');

  if (post.criteria) {
    lines.push(`## ${inline(post.criteria.heading)}`, '');
    post.criteria.paragraphs.forEach((text) => lines.push(inline(text), ''));
    if (post.criteria.items?.length) {
      post.criteria.items.forEach((item) => lines.push(`- ${inline(item)}`));
      lines.push('');
    }
  }

  lines.push(...tableMarkdown(post.table));

  for (const section of post.sections) {
    if (section.heading) lines.push(`## ${inline(section.heading)}`, '');
    section.paragraphs.forEach((text) => lines.push(inline(text), ''));
    if (section.list?.length) {
      section.list.forEach((item) => lines.push(`- ${inline(item)}`));
      lines.push('');
    }
    for (const sub of section.subsections || []) {
      lines.push(`### ${inline(sub.heading)}`, '');
      sub.paragraphs.forEach((text) => lines.push(inline(text), ''));
      if (sub.list?.length) {
        sub.list.forEach((item) => lines.push(`- ${inline(item)}`));
        lines.push('');
      }
    }
    if (section.quote) lines.push(`> ${inline(section.quote)}`, '');
  }

  if (post.faq?.length) {
    lines.push('## 자주 묻는 질문', '');
    for (const item of post.faq) {
      lines.push(`### ${inline(item.question)}`, '');
      lines.push(inline(item.answer), '');
    }
  }

  post.outro.forEach((text) => lines.push(inline(text), ''));

  if (post.sources?.length) {
    lines.push(`## ${inline(sourcesHeading)}`, '');
    lines.push(
      '아래 자료를 참고해 정리했습니다. 제도와 일정은 바뀔 수 있으니 '
      + '중요한 내용은 각 기관의 공식 공지에서 다시 확인하시기 바랍니다.',
      '',
    );
    for (const source of post.sources) {
      const meta = [source.publisher, source.date]
        .filter(Boolean)
        .filter((part, index, all) => all.indexOf(part) === index)
        .join(', ');
      // 제목에 든 대괄호는 마크다운 링크 문법을 깨뜨린다.
      const title = inline(source.title || source.url).replace(/[[\]]/g, '');
      lines.push(`- [${title}](${source.url})${meta ? ` (${meta})` : ''}`);
    }
    lines.push('');
  }

  if (post.tags?.length) lines.push(post.tags.map((tag) => `#${tag}`).join(' '), '');

  // 연속된 빈 줄을 하나로 줄여 깔끔하게 끝낸다.
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
