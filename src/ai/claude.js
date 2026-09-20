import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';
import { LOG_DIR, ensureDirs } from '../lib/paths.js';

const IS_WINDOWS = process.platform === 'win32';

/**
 * 윈도우 콘솔은 한국어를 CP949(EUC-KR)로 내보낸다.
 * 그대로 UTF-8 로 읽으면 "모델을 찾을 수 없습니다" 가 "���� ã�� �� �����ϴ�" 로 깨진다.
 */
function decodeOutput(chunks) {
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) return '';

  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return utf8;

  for (const encoding of ['euc-kr', 'cp949', 'windows-1252']) {
    try {
      const alternative = new TextDecoder(encoding).decode(buffer);
      if (!alternative.includes('�')) return alternative;
    } catch {
      // 이 인코딩은 이 런타임에서 지원하지 않는다. 다음 후보로.
    }
  }
  return utf8;
}

/**
 * shell 을 거칠 때는 Node 가 인자를 따옴표로 감싸주지 않는다.
 * 공백이 든 인자를 그냥 넘기면 여러 조각으로 쪼개져 CLI 가 종료 코드 1로 죽는다.
 */
function quoteForShell(value) {
  const text = String(value);
  if (!/[\s"^&|<>()%!]/.test(text)) return text;
  return IS_WINDOWS ? `"${text.replace(/"/g, '""')}"` : `'${text.replace(/'/g, `'\\''`)}'`;
}

/** 사용량/요청 한도에 걸린 오류인지. 이 경우 계속 돌려봐야 전부 실패한다. */
function looksRateLimited(message) {
  return /(rate[ _-]?limit|usage limit|too many requests|429|quota|한도|사용량|제한을 초과)/i.test(String(message));
}

/**
 * claude CLI 로그인이 풀린 오류인지.
 *
 * 한도와 마찬가지로 **계속 돌려봐야 전부 같은 이유로 실패한다.**
 * 다만 한도는 기다리면 풀리고 이건 사람이 다시 로그인해야 풀린다.
 * 둘을 섞으면 "잠시 뒤 다시" 라는 엉뚱한 안내가 나가므로 따로 본다.
 *
 * 실제로 겪은 메시지:
 *   Failed to authenticate: OAuth session expired and could not be refreshed
 */
export function looksAuthExpired(message) {
  return /(failed to authenticate|oauth|session expired|not authenticated|unauthenticated|invalid api key|authentication[_ -]?error|please run \/login|run `?\/login|401|unauthorized)/i
    .test(String(message));
}

/** 로그인이 풀렸을 때 사람이 무엇을 해야 하는지. 한 군데에만 적어 둔다. */
export const AUTH_HINT = 'claude 로그인이 풀렸습니다. 검은 창(터미널)에서 `claude` 를 실행해 '
  + '다시 로그인한 뒤, 대시보드에서 [이어서 실행]을 눌러주세요.';

/** 실패했을 때 원문을 파일로 남긴다. 깨진 메시지만 보고는 원인을 못 찾는다. */
function dumpFailure({ args, stdout, stderr, code }) {
  try {
    ensureDirs();
    const file = path.join(LOG_DIR, `claude-fail-${Date.now()}.log`);
    fs.writeFileSync(file, [
      `exit code: ${code}`,
      `platform: ${process.platform}`,
      `args: ${JSON.stringify(args)}`,
      '',
      '--- stdout ---',
      stdout,
      '',
      '--- stderr ---',
      stderr,
    ].join('\n'), 'utf8');
    return file;
  } catch {
    return '';
  }
}

/**
 * 종료 코드가 0이 아니어도 claude 는 stdout 에 JSON 으로 이유를 적어놓는 경우가 있다.
 * stderr 만 보면 "(stderr 없음)" 으로 끝나 원인을 놓친다.
 */
function errorMessageFrom(stdout, stderr) {
  const trimmedOut = stdout.trim();
  if (trimmedOut) {
    try {
      const envelope = JSON.parse(trimmedOut);
      const detail = envelope.result || envelope.error || envelope.message || envelope.subtype;
      if (detail) return String(detail);
    } catch {
      // JSON 이 아니면 마지막 몇 줄을 그대로 보여준다.
    }
    const tail = trimmedOut.split('\n').filter(Boolean).slice(-3).join(' ');
    if (tail) return tail.slice(0, 400);
  }
  const trimmedErr = stderr.trim();
  if (trimmedErr) return trimmedErr.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);
  return '';
}

/**
 * 응답 봉투에서 실제로 글을 쓴 모델을 뽑아낸다.
 * claude CLI 는 modelUsage 에 { "claude-sonnet-5": {...} } 형태로 알려준다.
 */
function pickModel(envelope) {
  const usage = envelope?.modelUsage;
  if (!usage || typeof usage !== 'object') return '';
  const entries = Object.entries(usage);
  if (!entries.length) return '';
  // 여러 모델이 섞였다면 출력 토큰이 가장 많은 쪽이 본문을 쓴 모델이다.
  // (웹 검색은 별도의 작은 모델이 대신 도는 경우가 있어 출력 토큰이 적다)
  entries.sort((a, b) => (b[1]?.outputTokens || 0) - (a[1]?.outputTokens || 0));
  const [id, info] = entries[0];
  return info?.canonicalModel || id;
}

/**
 * 웹 검색을 실제로 몇 번 돌렸는지 센다.
 *
 * usage.server_tool_use 는 0 으로 남는 경우가 있고, 실제 횟수는
 * modelUsage 안의 모델별 항목에 들어온다. 검색을 대신 돈 모델까지
 * 합쳐야 맞는 숫자가 나온다. 이 숫자가 0 이면 "검색했다고 말만 한 것"이다.
 */
function countWebUse(envelope) {
  let searches = 0;
  let fetches = 0;
  for (const info of Object.values(envelope?.modelUsage || {})) {
    searches += Number(info?.webSearchRequests) || 0;
    fetches += Number(info?.webFetchRequests) || 0;
  }
  const server = envelope?.usage?.server_tool_use;
  searches = Math.max(searches, Number(server?.web_search_requests) || 0);
  fetches = Math.max(fetches, Number(server?.web_fetch_requests) || 0);
  return { searches, fetches };
}

/** 자료 조사에 쓰는 도구. 파일을 읽거나 명령을 실행하는 도구는 넣지 않는다. */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'];

/**
 * Claude Code CLI 를 -p(print) 모드로 호출한다.
 * API 키 종량제가 아니라 CLI 에 이미 로그인된 구독 계정을 그대로 쓴다.
 *
 * 시스템 프롬프트는 --system-prompt 인자가 아니라 stdin 본문 맨 앞에 넣는다.
 * 윈도우에서 공백이 든 인자가 쪼개지는 문제를 원천적으로 피하기 위해서다.
 *
 * @param {object}   options
 * @param {string[]} options.tools  쓰게 할 도구 목록. 비우면 도구 없이 돈다.
 * @returns {Promise<{text, model, costUsd, durationMs, searches, fetches}>}
 */
export function runClaude(prompt, {
  systemPrompt = '', timeoutMs, signal, model, tools = [],
} = {}) {
  const settings = getSettings();
  const command = settings.claude.command || 'claude';
  const limit = timeoutMs || settings.claude.timeoutMs || 420000;
  const wanted = model ?? settings.claude.model;

  const args = [
    '-p',
    '--output-format', 'json',
    // 글쓰기에는 Bash/코드 실행 도구가 필요 없다.
    // --restricted 는 그걸 막으면서 파일 접근도 작업 폴더 안으로 가둔다.
    '--restricted',
    '--no-session-persistence',
    '--strict-mcp-config',
  ];

  if (tools.length) {
    const list = tools.join(',');
    // --tools 만 주면 "쓸 수 있는 도구"만 정해지고 실행 권한은 따로 막힌다.
    // -p 모드에는 권한을 물어볼 사람이 없어서 --allowedTools 로 미리 허용해야
    // 실제로 검색이 돈다. (안 그러면 "권한이 거부되었습니다" 라고만 답한다)
    args.push('--tools', list, '--allowedTools', list, '--permission-mode', 'dontAsk');
  }

  if (wanted) args.push('--model', wanted);

  const fullPrompt = systemPrompt
    ? `${systemPrompt}\n\n============================================================\n\n${prompt}`
    : prompt;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, IS_WINDOWS ? args.map(quoteForShell) : args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: IS_WINDOWS,
        windowsHide: true,
      });
    } catch (error) {
      reject(new Error(`claude CLI 를 실행하지 못했습니다: ${error.message}`));
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`claude 응답이 ${Math.round(limit / 1000)}초 안에 오지 않았습니다.`));
    }, limit);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error('사용자가 중지했습니다.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => outChunks.push(chunk));
    child.stderr.on('data', (chunk) => errChunks.push(chunk));

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error.code === 'ENOENT') {
        reject(new Error(
          `claude CLI 를 찾을 수 없습니다. 'npm install -g @anthropic-ai/claude-code' 로 설치하고 ` +
          `'claude' 로 한 번 로그인한 뒤 다시 시도하세요. (설정의 claude.command 로 경로 지정 가능)`
        ));
      } else {
        reject(error);
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      const stdout = decodeOutput(outChunks);
      const stderr = decodeOutput(errChunks);

      if (code !== 0) {
        const detail = errorMessageFrom(stdout, stderr);
        const dump = dumpFailure({ args, stdout, stderr, code });

        let hint = '';
        if (looksAuthExpired(detail)) {
          hint = ` — ${AUTH_HINT}`;
        } else if (looksRateLimited(detail)) {
          hint = ' — 사용량 한도에 걸린 것 같습니다. 잠시 뒤에 다시 시도하세요.';
        } else if (wanted && /model|모델/i.test(detail)) {
          hint = ` — '${wanted}' 모델을 쓸 수 없는 플랜일 수 있습니다. 설정에서 다른 모델을 골라보세요.`;
        } else if (!detail) {
          hint = dump ? ` — 원문을 ${dump} 에 남겼습니다.` : '';
        }

        const error = new Error(
          `claude CLI 종료 코드 ${code}: ${detail || '(출력 없음)'}${hint}`,
        );
        error.rateLimited = looksRateLimited(detail);
        error.authExpired = looksAuthExpired(detail);
        error.dumpFile = dump;
        reject(error);
        return;
      }

      try {
        const envelope = JSON.parse(stdout);
        if (envelope.is_error) {
          const message = String(envelope.result || envelope.subtype || '알 수 없는 오류');
          const error = new Error(`claude 오류: ${message}`);
          error.rateLimited = looksRateLimited(message);
          error.authExpired = looksAuthExpired(message);
          reject(error);
          return;
        }
        const web = countWebUse(envelope);
        resolve({
          text: String(envelope.result ?? ''),
          model: pickModel(envelope) || wanted || '',
          costUsd: Number(envelope.total_cost_usd) || 0,
          durationMs: Number(envelope.duration_ms) || 0,
          searches: web.searches,
          fetches: web.fetches,
        });
      } catch {
        // --output-format json 이 아닌 형태로 나온 경우 원문을 그대로 쓴다.
        resolve({
          text: stdout.trim(), model: wanted || '', costUsd: 0, durationMs: 0,
          searches: 0, fetches: 0,
        });
      }
    });

    /*
     * 프롬프트를 넘기다 파이프가 끊기는 경우가 있다.
     *
     * claude 가 프롬프트를 다 읽기 전에 끝나 버리면(로그인이 풀려서 곧바로
     * 죽는 경우가 대표적이다) 여기서 write EPIPE 가 난다. 받아주지 않으면
     * 그게 그대로 uncaughtException 이 되어 **서버 전체가 죽는다.**
     *
     * 진짜 원인(종료 코드와 stderr)은 'close' 에서 이미 읽어 알려주므로,
     * 여기서는 삼키고 그쪽 메시지가 나가게 둔다.
     */
    child.stdin.on('error', () => {});
    try {
      child.stdin.end(fullPrompt, 'utf8');
    } catch {
      // 위와 같은 이유. 종료 코드 쪽에서 제대로 된 메시지가 나간다.
    }
  });
}

/** 모델이 앞뒤로 말을 덧붙였어도 JSON 본체만 뽑아낸다. */
export function extractJson(text) {
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // 첫 '{' 부터 마지막 '}' 까지 잘라 한 번 더 시도.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch (error) {
        throw new Error(`AI 응답을 JSON 으로 읽지 못했습니다: ${error.message}`);
      }
    }
    throw new Error('AI 응답에서 JSON 을 찾지 못했습니다.');
  }
}

/**
 * 근거가 부족하다고 거절했을 때 조건을 바꿔 다시 묻는 블록.
 *
 * 핵심은 "지어내라" 가 아니라 **"무엇을 근거로 썼는지 밝히고 쓰라"** 는 것이다.
 * 공식 통계가 없는 주제(대학 순위, 연봉 순위 등)가 이 도구의 주된 소재라
 * 근거가 없다고 매번 접으면 쓸 수 있는 글이 거의 남지 않는다.
 */
export const WRITE_ANYWAY_BLOCK = `============================================================
[다시 요청합니다 — 거절하지 말고 반드시 써 주세요]

이 글은 **공식 발표 자료가 아니라 참고용 정리 글**입니다.
공식 통계나 확정된 근거가 없어도 괜찮습니다. 아래 조건으로 반드시 작성하세요.

- 과거에 알려진 자료, 통념, 일반적으로 통용되는 평가를 근거로 삼아도 됩니다.
- 확실하지 않은 부분은 **"일반적으로 알려진 기준입니다", "해마다 달라질 수 있습니다"**
  처럼 근거 수준을 밝히고 쓰세요. 밝히기만 하면 추정으로 써도 됩니다.
- 순위는 절대적인 우열이 아니라 **정리한 참고 순서**로 다루세요.
- 공식 기관이 발표한 것처럼 **꾸며 쓰지는** 마세요. 기관명과 정확한 수치를
  지어내서 단정하는 것만 하지 않으면 됩니다.
- 개인 신상, 특정 업체 비방, 의료·금융의 단정적 약속은 빼고 쓰세요.

"자료가 없어 쓸 수 없습니다", "정확한 정보를 확인할 수 없습니다" 같은 답변은
하지 마세요. 그 대신 위와 같이 근거 수준을 밝히고 글을 완성하세요.

[출력] 설명 없이 JSON 객체 하나만. '{' 로 시작해 '}' 로 끝나야 합니다.`;

/** 두 번 물어도 거절했을 때 올릴 오류. */
function asRefusal(text) {
  const reason = String(text).trim().replace(/\s+/g, ' ').slice(0, 300);
  const refusal = new Error(`AI가 이 주제로 글쓰기를 거절했습니다: ${reason}`);
  refusal.refusal = true;
  refusal.reason = String(text).trim();
  return refusal;
}

/**
 * JSON 응답을 요구하는 호출. 한 번 실패하면 형식을 다시 일러주고 재시도한다.
 * @returns {Promise<{data: any, model: string, costUsd: number}>}
 */
export async function runClaudeJson(prompt, options = {}) {
  let lastText = '';
  try {
    const reply = await runClaude(prompt, options);
    lastText = reply.text;
    return {
      data: extractJson(reply.text),
      model: reply.model,
      costUsd: reply.costUsd,
      searches: reply.searches,
      fetches: reply.fetches,
    };
  } catch (error) {
    // 파싱이 깨졌을 때 원문이 없으면 왜 깨졌는지 알 방법이 없다.
    if (lastText) {
      const dump = dumpFailure({ args: ['(json parse)'], stdout: lastText, stderr: error.message, code: 0 });
      if (dump) logger.warn(`AI 원문을 ${dump} 에 남겼습니다.`);
    }

    // CLI 자체가 실패한 경우는 형식을 다시 일러줘도 소용없다. 그대로 올린다.
    if (/종료 코드|찾을 수 없습니다|중지했습니다|오지 않았습니다|claude 오류/.test(error.message)) {
      throw error;
    }

    /*
     * JSON 대신 긴 산문이 왔다면 형식 문제가 아니라
     * "근거 자료가 없어서 이 주제로는 못 쓰겠다" 는 거절이다.
     *
     * 예전에는 여기서 바로 포기하고 그 주제를 건너뛰었다. 그런데 이 도구가
     * 다루는 주제는 대부분 공식 통계가 없는 것들이다(대학 순위, 연봉 순위…).
     * 그때마다 건너뛰면 쓸 수 있는 글이 거의 없다.
     *
     * 그래서 한 번 더 부른다. "지어내라" 가 아니라 **"근거 수준을 밝히고
     * 일반적으로 알려진 정보로 쓰라"** 고 조건을 바꿔서 다시 묻는다.
     * 그래도 거절하면 그때 포기한다.
     */
    const refused = lastText.trim().length > 120 && !lastText.includes('{');
    if (refused) {
      logger.warn('AI가 근거 부족으로 거절했습니다. 조건을 바꿔 한 번 더 요청합니다.');
    } else {
      logger.warn(`AI 응답 파싱 실패, 형식을 다시 지정해 재시도합니다. (${error.message})`);
    }

    const retryPrompt = refused
      ? `${prompt}\n\n${WRITE_ANYWAY_BLOCK}`
      : `${prompt}\n\n`
        + `[중요] 설명이나 인사말 없이 JSON 객체 하나만 출력하세요. `
        + `코드 펜스(\`\`\`)도 쓰지 말고 '{' 로 시작해서 '}' 로 끝나야 합니다.`;

    let reply;
    try {
      reply = await runClaude(retryPrompt, options);
    } catch (retryError) {
      if (refused) throw asRefusal(lastText);
      throw retryError;
    }

    // 다시 물어도 산문으로 거절했다면 그때는 접는다.
    if (reply.text.trim().length > 120 && !reply.text.includes('{')) {
      throw asRefusal(reply.text);
    }
    return {
      data: extractJson(reply.text),
      model: reply.model,
      costUsd: reply.costUsd,
      searches: reply.searches,
      fetches: reply.fetches,
    };
  }
}

/** CLI 가 설치·로그인되어 있는지 확인. */
export async function checkClaude() {
  const settings = getSettings();
  const command = settings.claude.command || 'claude';
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
      windowsHide: true,
    });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', () => resolve({ ok: false, version: '', message: 'claude CLI 를 찾을 수 없습니다.' }));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, version: decodeOutput(chunks).trim(), message: '' });
      else resolve({ ok: false, version: '', message: `claude --version 종료 코드 ${code}` });
    });
  });
}
