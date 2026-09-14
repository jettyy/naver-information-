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

export function addTopics(topics) {
  const list = load();
  const existing = new Set(list.map((job) => job.topic.toLowerCase()));
  const added = [];
  for (const topic of topics) {
    if (existing.has(topic.toLowerCase())) continue;
    existing.add(topic.toLowerCase());
    const job = {
      id: shortId(),
      topic,
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

export function nextPending() {
  return load().find((job) => job.status === STATUS.PENDING) || null;
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
