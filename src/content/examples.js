import fs from 'node:fs';
import path from 'node:path';
import { EXAMPLE_DIR, ensureDirs } from '../lib/paths.js';
import { logger, push } from '../lib/events.js';
import { shortId, nowIso } from '../lib/util.js';

/**
 * 참고용 예시 글 보관함.
 * 사용자가 "이런 식으로 써줘" 하고 올린 글을 저장해 두었다가
 * 프롬프트에 문체·구성 참고자료로 끼워 넣는다.
 */

const INDEX_FILE = path.join(EXAMPLE_DIR, 'index.json');

// 예시가 너무 길면 프롬프트를 다 잡아먹어 정작 준수 규칙이 묻힌다.
export const MAX_EXAMPLE_CHARS = 20000;
export const MAX_TOTAL_CHARS = 24000;

function readIndex() {
  ensureDirs();
  try {
    const list = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeIndex(list) {
  ensureDirs();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(list, null, 2), 'utf8');
  push('examples', list);
  return list;
}

function contentPath(id) {
  return path.join(EXAMPLE_DIR, `${id}.txt`);
}

/** 목록만 (본문은 빼고) 돌려준다. 대시보드 표시는 이걸로 충분하다. */
export function listExamples() {
  return readIndex();
}

export function addExample({ name, content }) {
  const text = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('예시 내용이 비어 있습니다.');

  const trimmed = text.length > MAX_EXAMPLE_CHARS ? text.slice(0, MAX_EXAMPLE_CHARS) : text;
  const id = shortId();
  ensureDirs();
  fs.writeFileSync(contentPath(id), trimmed, 'utf8');

  const entry = {
    id,
    name: String(name || '예시 글').trim().slice(0, 80) || '예시 글',
    chars: trimmed.length,
    truncated: trimmed.length < text.length,
    enabled: true,
    createdAt: nowIso(),
  };
  const list = readIndex();
  list.push(entry);
  writeIndex(list);
  logger.info(
    `참고 예시를 추가했습니다: ${entry.name} (${entry.chars}자` +
    `${entry.truncated ? `, ${MAX_EXAMPLE_CHARS}자까지만 저장` : ''})`,
  );
  return entry;
}

export function removeExample(id) {
  const list = readIndex().filter((entry) => entry.id !== id);
  fs.rmSync(contentPath(id), { force: true });
  return writeIndex(list);
}

export function setExampleEnabled(id, enabled) {
  const list = readIndex();
  const entry = list.find((item) => item.id === id);
  if (!entry) throw new Error('예시를 찾을 수 없습니다.');
  entry.enabled = Boolean(enabled);
  writeIndex(list);
  return entry;
}

export function readExample(id) {
  try {
    return fs.readFileSync(contentPath(id), 'utf8');
  } catch {
    return '';
  }
}

/**
 * 프롬프트에 넣을 예시 묶음.
 * 켜둔 것만, 전체 길이 상한을 넘지 않는 선까지 담는다.
 */
export function collectActiveExamples() {
  const picked = [];
  let total = 0;
  for (const entry of readIndex()) {
    if (!entry.enabled) continue;
    const content = readExample(entry.id);
    if (!content) continue;
    if (total + content.length > MAX_TOTAL_CHARS) {
      const room = MAX_TOTAL_CHARS - total;
      if (room < 500) break;
      picked.push({ name: entry.name, content: content.slice(0, room) });
      break;
    }
    picked.push({ name: entry.name, content });
    total += content.length;
  }
  return picked;
}

/** 예시들을 프롬프트에 넣을 한 덩어리 텍스트로 만든다. */
export function buildExampleBlock() {
  const examples = collectActiveExamples();
  if (!examples.length) return '';

  const body = examples
    .map((example, index) => (
      `--- 예시 ${index + 1}: ${example.name} ---\n${example.content}\n--- 예시 ${index + 1} 끝 ---`
    ))
    .join('\n\n');

  return [
    '[참고 예시]',
    '아래는 사용자가 "이런 식으로 써 달라"며 올린 예시 글입니다.',
    '문체, 문단 길이, 소제목 붙이는 방식, 마무리 짓는 방식을 참고하세요.',
    '내용을 베끼지는 말고 형식과 분위기만 가져오세요. 예시의 사실관계를 그대로 옮기지 마세요.',
    '다만 필수 준수 규칙이 예시와 충돌하면 규칙을 따르세요.',
    '',
    body,
  ].join('\n');
}
