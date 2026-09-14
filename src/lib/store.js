import fs from 'node:fs';
import { JOBS_FILE, ensureDirs } from './paths.js';
import { push } from './events.js';
import { shortId, nowIso } from './util.js';

/**
 * 작업(주제 1개 = 작업 1개) 목록. 파일에 그대로 남겨서
 * 대시보드를 껐다 켜도 어디까지 했는지 잃지 않는다.
 */
export const STATUS = {
  PENDING: 'pending',
  RESEARCHING: 'researching',
  WRITING: 'writing',
  CHECKING: 'checking',
  THUMBNAIL: 'thumbnail',
  POSTING: 'posting',
  DONE: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

const RUNNING_STATUSES = [
  STATUS.RESEARCHING, STATUS.WRITING, STATUS.CHECKING, STATUS.THUMBNAIL, STATUS.POSTING,
];

let jobs = null;

function load() {
  if (jobs) return jobs;
  ensureDirs();
  try {
    jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    if (!Array.isArray(jobs)) jobs = [];
  } catch {
    jobs = [];
  }
  // 이전 실행이 중간에 끊겼다면 진행 중이던 작업은 대기로 되돌린다.
  for (const job of jobs) {
    if (RUNNING_STATUSES.includes(job.status)) {
      job.status = STATUS.PENDING;
      job.message = '이전 실행이 중단되어 대기 상태로 되돌렸습니다.';
    }
  }
  return jobs;
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    ensureDirs();
    fs.writeFileSync(JOBS_FILE, JSON.stringify(load(), null, 2), 'utf8');
  }, 120);
}

export function listJobs() {
  return load();
}

export function getJob(id) {
  return load().find((job) => job.id === id) || null;
}

/**
 * 주제를 작업 목록에 넣는다.
 *
 * 문자열을 주면 사람이 직접 적은 주제로, 객체를 주면 발굴해 온 주제로 본다.
 * 발굴해 온 것은 왜 골랐는지(why)와 관심도 점수를 함께 남겨서,
 * 작업표에서 "이 주제는 왜 여기 있나" 를 바로 확인할 수 있게 한다.
 *
 * requestId 는 이 주제를 데려온 주문의 번호다. 이게 있어야 글 하나가
 * 저장됐을 때 어느 주문의 몫인지 셀 수 있다. 직접 적은 주제는 비어 있다.
 */
export function addTopics(topics, requestId = '') {
  const list = load();
  const existing = new Set(list.map((job) => job.topic.toLowerCase()));
  const added = [];
  for (const entry of topics) {
    const pick = typeof entry === 'string' ? { topic: entry } : (entry || {});
    const topic = String(pick.topic || '').trim();
    if (!topic) continue;
    if (existing.has(topic.toLowerCase())) continue;
    existing.add(topic.toLowerCase());
    const job = {
      id: shortId(),
      topic,
      requestId,
      // 발굴로 들어온 주제에만 채워진다. 직접 적은 주제는 빈 값이다.
      bigTopic: pick.bigTopic || '',
      why: pick.why || '',
      score: Number(pick.score) || 0,
      searchTerms: pick.searchTerms || [],
      freshness: pick.freshness || '',
      seedSources: pick.sources || [],
      status: STATUS.PENDING,
      message: '',
      detail: '',            // 오류 전문 (표에는 줄여서 띄우고 여기에 원문을 담는다)
      attempts: 0,
      title: '',
      thumbnailPath: '',
      charCount: 0,          // 공백 제외
      model: '',
      guidelineCheck: '',
      tableRows: 0,
      compliance: null,      // { ok, passed, total, issues: [] }
      repairs: 0,
      searches: 0,           // 실제로 돈 웹 검색 횟수
      sourceCount: 0,        // 글에 붙인 출처 개수
      unverified: 0,         // 조사에서 확인하지 못한 항목 수
      editUrl: '',
      postUrl: '',
      archiveDir: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    list.push(job);
    added.push(job);
  }
  persist();
  push('jobs', list);
  return added;
}

export function updateJob(id, patch) {
  const job = getJob(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: nowIso() });
  persist();
  push('job', job);
  return job;
}

export function removeJob(id) {
  jobs = load().filter((job) => job.id !== id);
  persist();
  push('jobs', jobs);
}

export function clearJobs(onlyFinished = false) {
  jobs = onlyFinished
    ? load().filter((job) => ![STATUS.DONE, STATUS.SKIPPED].includes(job.status))
    : [];
  persist();
  push('jobs', jobs);
  return jobs;
}

export function resetJob(id) {
  return updateJob(id, { status: STATUS.PENDING, message: '', detail: '', attempts: 0 });
}

/**
 * 다음에 쓸 주제.
 *
 * 직접 적은 주제(주문에 딸리지 않은 것)를 먼저 본다. 꼭 쓰고 싶어서
 * 손으로 넣은 것이라, 발굴해 온 주제 뒤에서 기다리게 두면 안 된다.
 */
export function nextPending() {
  const list = load();
  const pending = (job) => job.status === STATUS.PENDING;
  return list.find((job) => pending(job) && !job.requestId)
    || list.find(pending)
    || null;
}

/**
 * 한 주문에 딸린 대기 주제를 걷어낸다.
 *
 * 발굴할 때 목표보다 조금 넉넉히 받아 오기 때문에, 목표를 채우고 나면
 * 쓰지 않을 주제가 남는다. 그대로 두면 다음 주문으로 넘어가지 못하고
 * 남은 것부터 계속 쓰게 된다. 지우지 않고 건너뜀으로 남겨서,
 * 무엇이 왜 안 쓰였는지 작업표에서 보이게 한다.
 */
export function cancelPendingJobs(requestId, message) {
  if (!requestId) return 0;
  let count = 0;
  for (const job of load()) {
    if (job.requestId !== requestId || job.status !== STATUS.PENDING) continue;
    Object.assign(job, { status: STATUS.SKIPPED, message, updatedAt: nowIso() });
    count += 1;
  }
  if (count) {
    persist();
    push('jobs', load());
  }
  return count;
}

export function stats() {
  const list = load();
  const by = (status) => list.filter((job) => job.status === status).length;
  return {
    total: list.length,
    pending: by(STATUS.PENDING),
    done: by(STATUS.DONE),
    failed: by(STATUS.FAILED),
    skipped: by(STATUS.SKIPPED),
    running: list.filter((job) => RUNNING_STATUSES.includes(job.status)).length,
  };
}
