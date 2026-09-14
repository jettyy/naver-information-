import fs from 'node:fs';
import { HISTORY_FILE, ensureDirs } from './paths.js';
import { nowIso } from './util.js';

/**
 * 지금까지 발굴한 주제의 기록.
 *
 * 작업 목록(jobs.json)만으로는 부족하다. 완료한 항목을 정리하거나
 * 목록을 비우면 어제 쓴 주제를 오늘 다시 골라 온다. 큰 주제 하나로
 * 며칠씩 계속 돌리는 도구라서, 무엇을 이미 다뤘는지는 따로 남겨야 한다.
 *
 * 발굴한 시점에 기록한다. 글쓰기가 실패한 주제까지 남겨 두어야
 * 매번 같은 주제를 다시 골라 오고 다시 실패하는 일이 없다.
 */

const MAX_ENTRIES = 2000;

let entries = null;

function load() {
  if (entries) return entries;
  ensureDirs();
  try {
    entries = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!Array.isArray(entries)) entries = [];
  } catch {
    entries = [];
  }
  return entries;
}

function persist() {
  ensureDirs();
  // 오래된 것부터 버린다. 최근 것이 중복 판정에 훨씬 중요하다.
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2), 'utf8');
}

/** 대소문자·공백·기호를 지운 비교용 열쇠. "TOP 5" 와 "top5" 를 같게 본다. */
export function topicKey(topic) {
  return String(topic || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 80);
}

export function recordTopics(bigTopic, topics) {
  const list = load();
  const at = nowIso();
  for (const topic of topics) {
    const text = typeof topic === 'string' ? topic : topic?.topic;
    if (!text) continue;
    list.push({ topic: text, key: topicKey(text), bigTopic, at });
  }
  persist();
  return list.length;
}

/**
 * 프롬프트에 넣을 "이미 다룬 주제" 목록.
 *
 * 큰 주제가 같은 것을 먼저 채우고 남는 자리를 다른 큰 주제로 채운다.
 * 큰 주제를 바꿔 가며 쓰더라도 소재가 겹치는 경우가 있기 때문이다.
 */
export function recentTopics(bigTopic, limit = 80) {
  const list = load();
  const mine = [];
  const others = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    (list[i].bigTopic === bigTopic ? mine : others).push(list[i].topic);
    if (mine.length >= limit) break;
  }
  return [...mine, ...others.slice(0, Math.max(0, limit - mine.length))];
}

/** 이미 다룬 주제인지. 발굴 결과를 걸러낼 때 쓴다. */
export function seenKeys() {
  return new Set(load().map((entry) => entry.key));
}

export function historyStats(bigTopic) {
  const list = load();
  return {
    total: list.length,
    forTopic: bigTopic ? list.filter((entry) => entry.bigTopic === bigTopic).length : 0,
  };
}

export function clearHistory() {
  entries = [];
  persist();
}
