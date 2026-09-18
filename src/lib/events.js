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

/**
 * 검은 창을 닫아도 서버는 계속 살아 있다.
 * 그 상태에서 화면에 한 줄 쓰려 하면 `write EIO`(맥·리눅스) 나
 * `write EPIPE`(파이프로 넘긴 경우) 가 난다.
 * 그런데 그 오류를 또 로그로 남기려다 같은 곳에서 또 터지기 때문에,
 * 막아두지 않으면 같은 줄이 끝없이 반복된다.
 *
 * 그래서 화면이 한 번 끊기면 **화면 출력만** 영구히 끈다.
 * 파일 기록과 대시보드(SSE)는 그대로 살아 있어서, 웹 화면에서는 계속 볼 수 있다.
 */
let consoleDead = false;

export function isBrokenOutput(error) {
  const code = error?.code || error?.errno;
  return code === 'EIO' || code === 'EPIPE' || code === 'EBADF'
    || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END';
}

export function consoleAlive() {
  return !consoleDead;
}

/** 화면 출력을 끈다. 이미 꺼져 있었으면 false. */
export function markConsoleDead() {
  if (consoleDead) return false;
  consoleDead = true;
  return true;
}

/** 절대 던지지 않는 화면 출력. 창이 사라졌으면 조용히 포기한다. */
export function writeConsole(text, channel = 'log') {
  if (consoleDead) return false;
  try {
    console[channel === 'error' ? 'error' : 'log'](text);
    return true;
  } catch (error) {
    // 창이 사라진 것이면 다시는 쓰지 않는다. 그래야 오류가 오류를 부르지 않는다.
    if (isBrokenOutput(error)) consoleDead = true;
    return false;
  }
}

// 파이프로 넘어간 출력은 오류가 나중에(비동기로) 'error' 로 올라온다.
// 받아주지 않으면 그게 곧 uncaughtException 이 되어 위와 같은 되풀이를 만든다.
for (const out of [process.stdout, process.stderr]) {
  try {
    out?.on?.('error', (error) => {
      if (isBrokenOutput(error)) consoleDead = true;
    });
  } catch {
    // 출력 스트림이 없는 환경이면 그냥 넘어간다.
  }
}

/** 대시보드 로그 콘솔로 흘려보내는 한 줄. */
export function log(level, message, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, message, ...meta };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();

  const tag = level.toUpperCase().padEnd(5);
  writeConsole(`[${tag}] ${message}`);

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
