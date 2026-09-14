import express from 'express';
import { PUBLIC_DIR, THUMB_DIR, OUTPUT_DIR, SHOT_DIR, ensureDirs } from './lib/paths.js';
import { bus, recentLogs, logger, logRaw, logFile } from './lib/events.js';
import {
  getSettings, saveSettings, publicSettings, DEFAULT_SETTINGS,
} from './lib/settings.js';
import { listJobs, addTopics, removeJob, clearJobs, resetJob, stats, STATUS } from './lib/store.js';
import { parseTopics, normalizeBlogId } from './lib/util.js';
import {
  openLoginWindow, verifySession, readSessionInfo, logout, closeContext,
} from './naver/browser.js';
import { previewThumbnailHtml } from './content/thumbnail.js';
import { checkClaude, runClaude } from './ai/claude.js';
import { MODELS } from './ai/models.js';
import { RULES } from './content/quality.js';
import { runResearch } from './content/research.js';
import {
  generateBackground, pickAspectRatio, getImageModels, verifyKoreanText,
} from './content/imagegen.js';
import { listExamples, addExample, removeExample, setExampleEnabled, MAX_EXAMPLE_CHARS } from './content/examples.js';
import { prepareBrowser, closeRenderBrowser } from './lib/playwright.js';
import * as runner from './queue/runner.js';

ensureDirs();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/thumbnails', express.static(THUMB_DIR));
app.use('/posts', express.static(OUTPUT_DIR));
app.use('/screenshots', express.static(SHOT_DIR));

const wrap = (handler) => (req, res) => {
  Promise.resolve(handler(req, res)).catch((error) => {
    logger.error(error.message);
    res.status(500).json({ ok: false, message: error.message });
  });
};

/** 대시보드에 띄울 준수 규칙 목록 (설명만, 검사 함수는 서버에만 둔다). */
const RULE_SUMMARY = RULES.map((rule) => ({ id: rule.id, label: rule.label }));

/* ---------- 상태 ---------- */

app.get('/api/state', wrap(async (req, res) => {
  res.json({
    ok: true,
    settings: publicSettings(),      // 응용 프로그램 비밀번호는 빼고 내려보낸다.
    defaults: DEFAULT_SETTINGS,
    models: MODELS,
    rules: RULE_SUMMARY,
    examples: listExamples(),
    session: readSessionInfo(),
    jobs: listJobs(),
    runner: runner.getRunnerState(),
    logs: recentLogs(),
    statuses: STATUS,
  });
}));

app.get('/api/health', wrap(async (req, res) => {
  const claude = await checkClaude();
  let browser = { ok: true, message: '', label: '' };
  try {
    browser.label = (await prepareBrowser()).label;
  } catch (error) {
    browser = { ok: false, message: error.message, label: '' };
  }
  res.json({ ok: true, claude, browser, session: readSessionInfo() });
}));

/* 대시보드 실시간 갱신 (SSE) */
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  bus.on('event', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', send);
  });
});

/* ---------- 네이버 로그인 ---------- */

/**
 * 아이디와 비밀번호는 이 프로그램이 다루지 않는다.
 * 진짜 브라우저 창을 띄워 사용자가 직접 로그인하게 하고, 세션만 넘겨받는다.
 * 2단계 인증도 그래서 그대로 통과한다.
 */
app.post('/api/login', wrap(async (req, res) => {
  res.json({ ok: true, message: '로그인 창을 띄웁니다. 브라우저에서 직접 로그인해 주세요.' });
  openLoginWindow().catch((error) => logger.error(`로그인 실패: ${error.message}`));
}));

app.post('/api/login/verify', wrap(async (req, res) => {
  // headless 를 지정하지 않아야 로그인할 때와 같은 모드로 확인한다.
  res.json({ ok: true, session: await verifySession() });
}));

app.post('/api/logout', wrap(async (req, res) => {
  await logout();
  res.json({ ok: true, session: readSessionInfo(), settings: publicSettings() });
}));

/** 블로그 아이디를 자동으로 못 찾았을 때 직접 넣는 통로. */
app.post('/api/blog-id', wrap(async (req, res) => {
  const blogId = normalizeBlogId(req.body?.blogId || '');
  if (!blogId) {
    res.status(400).json({ ok: false, message: '블로그 아이디를 입력해 주세요.' });
    return;
  }
  saveSettings({ blogId });
  logger.info(`블로그 아이디를 ${blogId} 로 설정했습니다.`);
  res.json({ ok: true, settings: publicSettings(), session: readSessionInfo() });
}));

/* ---------- 주제 ---------- */

app.post('/api/topics/preview', wrap(async (req, res) => {
  const topics = parseTopics(req.body?.raw || '');
  res.json({ ok: true, count: topics.length, topics: topics.slice(0, 200) });
}));

app.post('/api/topics', wrap(async (req, res) => {
  const topics = parseTopics(req.body?.raw || '');
  if (!topics.length) {
    res.status(400).json({ ok: false, message: '주제를 한 줄에 하나씩 붙여넣어 주세요.' });
    return;
  }
  const added = addTopics(topics);
  logger.info(`주제 ${added.length}건을 추가했습니다. (붙여넣기 ${topics.length}건, 중복 제외)`);
  res.json({ ok: true, added: added.length, skipped: topics.length - added.length, jobs: listJobs() });
}));

app.delete('/api/jobs/:id', wrap(async (req, res) => {
  removeJob(req.params.id);
  res.json({ ok: true, jobs: listJobs() });
}));

app.post('/api/jobs/:id/retry', wrap(async (req, res) => {
  res.json({ ok: true, job: resetJob(req.params.id) });
}));

app.post('/api/jobs/clear', wrap(async (req, res) => {
  const jobs = clearJobs(Boolean(req.body?.onlyFinished));
  res.json({ ok: true, jobs });
}));

/* ---------- 실행 ---------- */

app.post('/api/run/start', wrap(async (req, res) => res.json(runner.start())));
app.post('/api/run/pause', wrap(async (req, res) => res.json(runner.pause())));
app.post('/api/run/stop', wrap(async (req, res) => res.json(runner.stop())));

/* ---------- AI 연결 테스트 ---------- */

/**
 * 100개를 돌리기 전에 지금 고른 모델로 실제 호출이 되는지 한 번 확인한다.
 * 모델을 못 쓰거나 로그인이 풀렸으면 여기서 바로 드러난다.
 */
app.post('/api/ai/test', wrap(async (req, res) => {
  const model = getSettings().claude.model;
  logger.step(`AI 연결 테스트 시작${model ? ` (${model})` : ''}`);
  try {
    const reply = await runClaude('"준비완료" 라고만 답하세요. 다른 말은 하지 마세요.', {
      systemPrompt: '당신은 짧게 답하는 도우미입니다.',
      timeoutMs: 120000,
    });
    logger.info(`AI 연결 테스트 성공 — 모델 ${reply.model}, 응답: ${reply.text.trim().slice(0, 40)}`);
    res.json({
      ok: true,
      model: reply.model,
      answer: reply.text.trim().slice(0, 100),
      durationMs: reply.durationMs,
    });
  } catch (error) {
    logger.error(`AI 연결 테스트 실패: ${error.message}`);
    res.json({ ok: true, failed: true, message: error.message, dumpFile: error.dumpFile || '' });
  }
}));

/**
 * 웹 검색이 실제로 도는지 한 주제로 시험해 본다.
 *
 * 검색은 "했다고 말만 하고 안 하는" 경우가 있어서, 실제 검색 횟수와
 * 받아온 출처 URL 을 눈으로 확인할 수 있어야 한다.
 */
app.post('/api/research/test', wrap(async (req, res) => {
  const topic = String(req.body?.topic || '').trim() || '2026년 산업안전기사 시험일정';
  logger.step(`웹 검색 테스트 시작 — "${topic}"`);
  try {
    const research = await runResearch(topic, { shape: 'general' });
    if (!research) {
      res.json({ ok: true, failed: true, message: '자료 조사가 꺼져 있거나 실패했습니다. 진행 로그를 확인하세요.' });
      return;
    }
    res.json({
      ok: true,
      searches: research.searches,
      facts: research.facts.length,
      unverified: research.unverified.length,
      freshness: research.freshness,
      sources: research.sources.slice(0, 8),
    });
  } catch (error) {
    logger.error(`웹 검색 테스트 실패: ${error.message}`);
    res.json({ ok: true, failed: true, message: error.message });
  }
}));

/**
 * 이미지 API 키가 실제로 되는지 한 장 뽑아 본다.
 * 그림을 화면에 바로 띄워서 품질까지 눈으로 확인할 수 있게 한다.
 */
app.post('/api/image/test', wrap(async (req, res) => {
  const settings = getSettings();
  const apiKey = String(req.body?.apiKey || '').trim();
  const model = String(req.body?.model || '').trim();
  const style = String(req.body?.style || '').trim();

  // 테스트 버튼으로 새 키를 넣었다면 먼저 저장한다. 한 번에 확인하고 쓰게.
  const patch = { image: {} };
  if (apiKey) patch.image.apiKey = apiKey;
  if (model) patch.image.model = model;
  if (style) patch.image.style = style;
  if (req.body?.mode) patch.image.mode = String(req.body.mode);
  if (req.body?.poster) patch.image.poster = String(req.body.poster);
  if (Object.keys(patch.image).length) saveSettings(patch);

  const { width, height } = getSettings().thumbnail;
  const wanted = getSettings().image.model;
  logger.step(`이미지 생성 테스트 시작 (${wanted || '자동 - 가장 싼 모델'})`);

  // 자동 모드면 어떤 후보들이 있는지도 함께 보여준다. 무엇이 골라졌는지
  // 눈으로 확인할 수 있어야 "왜 이 모델이지?" 를 묻지 않아도 된다.
  let ranked = [];
  if (!wanted) {
    try {
      ranked = (await getImageModels({ force: Boolean(req.body?.refresh) })).models;
    } catch (error) {
      logger.error(`이미지 모델 목록을 받지 못했습니다: ${error.message}`);
      res.json({ ok: true, failed: true, message: error.message, settings: publicSettings() });
      return;
    }
  }

  // 실제 글에서 오는 것과 같은 모양의 예시 문구로 뽑아야 품질을 판단할 수 있다.
  const sample = {
    posterLines: ['4년제만 답이 아니다', '취업 최강 전문대'],
    ribbon: 'TOP 50 대공개 (2026 최신)',
    subline: '실무, 자격증, 현장 경험으로 골랐습니다',
    badge: '전문대',
    keywords: ['간호보건', '반도체', '자동차', '항공', 'IT'],
    headline: '취업 최강 전문대',
    scene: 'students in a bright technical college workshop with machines, computers and lab benches',
  };

  try {
    const result = await generateBackground(sample, { aspectRatio: pickAspectRatio(width, height) });

    // full 모드면 한글이 제대로 나왔는지도 함께 확인해서 보여준다.
    let verdict = null;
    if (getSettings().image.mode === 'full' && getSettings().image.verifyText) {
      verdict = await verifyKoreanText(
        result.dataUri,
        [...sample.posterLines, sample.ribbon],
      );
    }

    logger.info(`이미지 생성 테스트 성공 — ${result.model}, ${Math.round(result.bytes / 1024)}KB`);
    res.json({
      ok: true,
      model: result.model,
      tier: result.tier || '',
      usd: result.usd,
      auto: !wanted,
      mode: getSettings().image.mode,
      textOk: verdict ? verdict.ok : null,
      textReason: verdict?.reason || '',
      candidates: ranked.slice(0, 8),
      kb: Math.round(result.bytes / 1024),
      dataUri: result.dataUri,
      settings: publicSettings(),
    });
  } catch (error) {
    logger.error(`이미지 생성 테스트 실패: ${error.message}`);
    res.json({
      ok: true, failed: true, message: error.message,
      candidates: ranked.slice(0, 8), settings: publicSettings(),
    });
  }
}));

/* ---------- 참고 예시 ---------- */

app.get('/api/examples', wrap(async (req, res) => {
  res.json({ ok: true, examples: listExamples(), maxChars: MAX_EXAMPLE_CHARS });
}));

app.post('/api/examples', wrap(async (req, res) => {
  const { name, content } = req.body || {};
  if (!String(content || '').trim()) {
    res.status(400).json({ ok: false, message: '예시 내용이 비어 있습니다.' });
    return;
  }
  const entry = addExample({ name, content });
  res.json({ ok: true, entry, examples: listExamples() });
}));

app.post('/api/examples/:id/toggle', wrap(async (req, res) => {
  setExampleEnabled(req.params.id, req.body?.enabled);
  res.json({ ok: true, examples: listExamples() });
}));

app.delete('/api/examples/:id', wrap(async (req, res) => {
  removeExample(req.params.id);
  res.json({ ok: true, examples: listExamples() });
}));

/* ---------- 설정 / 미리보기 ---------- */

app.post('/api/settings', wrap(async (req, res) => {
  saveSettings(req.body || {});
  res.json({ ok: true, settings: publicSettings() });
}));

app.get('/api/thumbnail/preview', wrap(async (req, res) => {
  res.type('html').send(previewThumbnailHtml({
    headline: req.query.headline,
    subline: req.query.subline,
    badge: req.query.badge,
    emoji: req.query.emoji,
    accent: req.query.accent,
    style: req.query.style,
  }));
}));

/* ---------- 시작 ---------- */

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';   // IPv4 로 확실히 열어둔다.

// 서버가 조용히 죽으면 브라우저에는 "연결 거부"만 뜨고 이유를 알 수 없다.
// 무슨 일이 있었는지 창에 남기고, 창이 바로 닫히지 않게 붙잡아 둔다.
function fatal(label, error) {
  logger.error(`${label}: ${error?.message || error}`);
  if (error?.stack) {
    console.error(error.stack);
    logRaw(error.stack);
  }
  console.error(`\n기록: ${logFile()}\n창을 닫지 말고 위 내용을 그대로 알려주세요.\n`);
}

// 여기서 잡지 않으면 프로세스가 아무 말 없이 종료되고,
// 브라우저에는 "연결할 수 없음" 만 남는다.
process.on('uncaughtException', (error) => fatal('예기치 못한 오류', error));
process.on('unhandledRejection', (error) => fatal('처리되지 않은 오류', error));

process.on('exit', (code) => {
  if (code !== 0) logRaw(`${new Date().toISOString()} [EXIT ] 종료 코드 ${code}`);
});

// 포트가 막혀 있을 때 그냥 죽어버리면, 쓰는 사람은 검은 창에 뜬 오류를 보고
// 환경변수 지정하는 법부터 찾아야 한다. 그냥 옆 포트로 옮겨 열고 주소를 알려준다.
const PORT_RETRIES = 10;

let server = null;

function onReady(port) {
  logger.info(`대시보드가 열렸습니다 → http://localhost:${port}`);
  logger.info(`열리지 않으면 이 주소로 접속해 보세요 → http://127.0.0.1:${port}`);
  logger.info(`이 창의 기록은 ${logFile()} 에도 남습니다.`);
  const { total, pending } = stats();
  logger.info(`저장된 주제 ${total}건 (대기 ${pending}건)`);

  prepareBrowser()
    .then(({ label }) => logger.info(`브라우저 준비 완료 — ${label}`))
    .catch((error) => logger.error(`브라우저 준비 실패: ${error.message}`));

  // 시작할 때 브라우저를 띄워 세션을 확인하지 않는다.
  // 로그인할 때와 모드가 달라 프로필을 다시 여는 과정에서 세션이 끊긴 적이 있다.
  // 저장된 상태를 그대로 보여주고, 확인은 [세션 확인] 과 실행 시작 때만 한다.
  const session = readSessionInfo();
  logger.info(session.loggedIn
    ? `저장된 네이버 세션 있음${session.blogId ? ` · ${session.blogId}` : ''}`
    : '네이버 로그인이 필요합니다. 대시보드 1번 칸에서 로그인해 주세요.');
}

function listen(port, retriesLeft) {
  const attempt = app.listen(port, HOST);
  server = attempt;

  attempt.once('listening', () => onReady(port));

  attempt.on('error', (error) => {
    // 여기서 잡지 않으면 "이미 쓰는 중" 오류가 그대로 튀어나가 프로세스가 죽는다.
    const busy = error.code === 'EADDRINUSE' || error.code === 'EACCES';
    if (busy && retriesLeft > 0) {
      const reason = error.code === 'EADDRINUSE'
        ? '이미 다른 프로그램이 쓰고 있습니다'
        : '열 권한이 없습니다';
      logger.warn(`${port}번 포트는 ${reason}. ${port + 1}번으로 다시 시도합니다.`);
      attempt.close();
      listen(port + 1, retriesLeft - 1);
      return;
    }

    if (busy) {
      logger.error(
        `${PORT}번부터 ${port}번까지 모두 쓸 수 없어 대시보드를 열지 못했습니다. `
        + '열려 있는 다른 검은 창을 닫고 다시 실행해 보세요. '
        + '(원하는 포트를 직접 정하려면 윈도우는 $env:PORT=8080 그다음 npm start, '
        + '맥·리눅스는 PORT=8080 npm start)',
      );
    } else {
      fatal('서버를 열지 못했습니다', error);
    }
    process.exitCode = 1;
  });
}

listen(PORT, PORT_RETRIES);

async function shutdown() {
  logger.info('종료합니다...');
  runner.stop();
  await Promise.allSettled([closeContext(), closeRenderBrowser()]);
  server?.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
