import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { LOG_DIR, ensureDirs } from './paths.js';

export const bus = new EventEmitter();
bus.setMaxListeners(200);

const RING_SIZE = 400;
const ring = [];

/**
 * 창이 닫히거나 프로세스가 죽어도 무슨 일이 있었는지 남아 있어야 한다.
 * 화면 로그와 같은 내용을 날짜별 파일에도 적는다.
 */
let logStream = null;
let logFilePath = '';

function stream() {
  if (logStream) return logStream;
  try {
    ensureDirs();
    const day = new Date().toISOString().slice(0, 10);
    logFilePath = path.join(LOG_DIR, `server-${day}.log`);
    logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
    logStream.on('error', () => { logStream = null; });
  } catch {
    logStream = null;
  }
  return logStream;
}

export function logFile() {
  stream();
  return logFilePath;
}

/** 대시보드 로그 콘솔로 흘려보내는 한 줄. */
export function log(level, message, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, message, ...meta };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();

  const tag = level.toUpperCase().padEnd(5);
  console.log(`[${tag}] ${message}`);

  try {
    stream()?.write(`${entry.ts} [${tag}] ${message}\n`);
  } catch {
    // 로그 파일에 못 써도 프로그램은 계속 돌아야 한다.
  }

  bus.emit('event', { type: 'log', payload: entry });
  return entry;
}

export const logger = {
  info: (m, meta) => log('info', m, meta),
  warn: (m, meta) => log('warn', m, meta),
  error: (m, meta) => log('error', m, meta),
  step: (m, meta) => log('step', m, meta),
};

/** 스택 트레이스처럼 여러 줄짜리 원문을 파일에만 남긴다. */
export function logRaw(text) {
  try {
    stream()?.write(`${text}\n`);
  } catch {
    // 무시
  }
}

/** 상태 변화(작업 목록, 연결 상태 등)를 SSE 로 밀어준다. */
export function push(type, payload) {
  bus.emit('event', { type, payload });
}

export function recentLogs() {
  return ring.slice(-120);
}
