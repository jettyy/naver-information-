import fs from 'node:fs';
import { REQUESTS_FILE, ensureDirs } from './paths.js';
import { push } from './events.js';
import { shortId, nowIso } from './util.js';

/**
 * 주문 목록 (큰 주제 1개 + 임시저장할 개수 = 주문 1건).
 *
 * 예전에는 큰 주제를 설정에 하나만 담아 두고 실행할 때 읽었다. 그러면
 * 한 주제가 끝날 때까지 다음 주제를 넣을 수 없다. 검색만 몇 분씩 걸리는데
 * 그동안 화면 앞에 앉아 기다려야 한다.
 *
 * 그래서 주문을 **줄 세우는** 방식으로 바꿨다. [확인] 을 누르면 주문이
 * 이 목록 맨 뒤에 붙고 바로 화면이 비워진다. 실행기는 앞에서부터
 * 하나씩 가져다 쓴다. 넣는 쪽과 쓰는 쪽이 떨어져 있어서 서로 기다리지 않는다.
 */

export const REQUEST_STATUS = {
  WAITING: 'waiting',     // 차례를 기다리는 중
  RUNNING: 'running',     // 지금 이 주문을 처리하는 중
  DONE: 'done',           // 정한 개수를 다 채움
  FAILED: 'failed',       // 주제를 못 찾았거나 계속 실패해서 포기
  STOPPED: 'stopped',     // 사람이 취소함
};

/** 아직 끝나지 않은 주문인지. */
export const isOpen = (request) => request.status === REQUEST_STATUS.WAITING
  || request.status === REQUEST_STATUS.RUNNING;

let requests = null;

function load() {
  if (requests) return requests;
  ensureDirs();
  try {
    requests = JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8'));
    if (!Array.isArray(requests)) requests = [];
  } catch {
    requests = [];
  }
  // 이전 실행이 중간에 끊겼다면 처리 중이던 주문은 대기로 되돌린다.
  for (const request of requests) {
    if (request.status === REQUEST_STATUS.RUNNING) {
      request.status = REQUEST_STATUS.WAITING;
      request.message = '이전 실행이 중단되어 대기 상태로 되돌렸습니다.';
    }
  }
  return requests;
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    ensureDirs();
    fs.writeFileSync(REQUESTS_FILE, JSON.stringify(load(), null, 2), 'utf8');
  }, 120);
}

function broadcast() {
  push('requests', load());
}

export function listRequests() {
  return load();
}

export function getRequest(id) {
  return load().find((request) => request.id === id) || null;
}

export function addRequest({ bigTopic, targetCount }) {
  const topic = String(bigTopic || '').trim();
  if (!topic) throw new Error('큰 주제를 입력해 주세요.');

  const count = Math.max(1, Math.min(200, Number(targetCount) || 1));
  const request = {
    id: shortId(),
    bigTopic: topic,
    targetCount: count,
    saved: 0,            // 이 주문으로 실제 임시저장한 건수
    discovered: 0,       // 이 주문으로 찾아온 주제 수 (헛도는 것을 막는 기준)
    failed: 0,           // 실패하거나 건너뛴 건수
    status: REQUEST_STATUS.WAITING,
    message: '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    finishedAt: '',
  };
  load().push(request);
  persist();
  broadcast();
  return request;
}

export function updateRequest(id, patch) {
  const request = getRequest(id);
  if (!request) return null;
  Object.assign(request, patch, { updatedAt: nowIso() });
  persist();
  broadcast();
  return request;
}

export function finishRequest(id, status, message = '') {
  return updateRequest(id, { status, message, finishedAt: nowIso() });
}

/** 다음에 처리할 주문. 넣은 순서대로 하나씩. */
export function nextRequest() {
  return load().find(isOpen) || null;
}

export function removeRequest(id) {
  requests = load().filter((request) => request.id !== id);
  persist();
  broadcast();
  return requests;
}

export function clearRequests(onlyFinished = true) {
  requests = onlyFinished ? load().filter(isOpen) : [];
  persist();
  broadcast();
  return requests;
}

export function requestStats() {
  const list = load();
  const open = list.filter(isOpen);
  return {
    total: list.length,
    open: open.length,
    // 대기열에 남은 글 수. "앞으로 몇 편이 더 나오는가" 를 보여주는 숫자다.
    remaining: open.reduce(
      (sum, request) => sum + Math.max(0, request.targetCount - request.saved),
      0,
    ),
  };
}
