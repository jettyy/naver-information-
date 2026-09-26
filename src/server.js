import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { PUBLIC_DIR, THUMB_DIR, OUTPUT_DIR, SHOT_DIR, ensureDirs } from './lib/paths.js';
import {
  bus, recentLogs, logger, logRaw, logFile, isBrokenOutput, markConsoleDead, writeConsole,
} from './lib/events.js';
import {
  getSettings, saveSettings, publicSettings, DEFAULT_SETTINGS,
} from './lib/settings.js';
import {
  listJobs, addTopics, removeJob, clearJobs, resetJob, stats, STATUS, cancelPendingJobs,
} from './lib/store.js';
import {
  listRequests, addRequest, getRequest, removeRequest, clearRequests,
} from './lib/requests.js';
import { parseTopics, normalizeBlogId } from './lib/util.js';
import {
  openLoginWindow, verifySession, readSessionInfo, logout, closeContext,
} from './naver/browser.js';
import {
  openChatGptLogin, verifyChatGptSession, readChatGptSession, chatGptLogout, closeChatGptContext,
} from './chatgpt/browser.js';
import { testChatGptImage } from './chatgpt/image.js';
import { previewThumbnailHtml } from './content/thumbnail.js';
import { fetchPexelsPhoto } from './content/pexels.js';
import { checkClaude, runClaude } from './ai/claude.js';
import { MODELS } from './ai/models.js';
import { RULES } from './content/quality.js';
import { runResearch, isUsableUrl } from './content/research.js';
import { discoverTopics } from './content/discover.js';
import { recordTopics, historyStats, clearHistory } from './lib/history.js';
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
    chatgptSession: readChatGptSession(),
    jobs: listJobs(),
    requests: listRequests(),
    runner: runner.getRunnerState(),
    logs: recentLogs(),
    statuses: STATUS,
    history: historyStats(getSettings().discover.bigTopic),
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

/* ---------- ChatGPT (썸네일을 구독 계정에서 받아오기) ---------- */

/**
 * 네이버 로그인과 똑같은 방식이다. 아이디·비밀번호는 다루지 않고
 * 진짜 브라우저 창을 띄워 사용자가 직접 로그인하게 한 뒤 세션만 받는다.
 */
app.post('/api/chatgpt/login', wrap(async (req, res) => {
  res.json({ ok: true, message: 'ChatGPT 로그인 창을 띄웁니다. 브라우저에서 직접 로그인해 주세요.' });
  openChatGptLogin().catch((error) => logger.error(`ChatGPT 로그인 실패: ${error.message}`));
}));

app.post('/api/chatgpt/verify', wrap(async (req, res) => {
  res.json({ ok: true, chatgptSession: await verifyChatGptSession() });
}));

app.post('/api/chatgpt/logout', wrap(async (req, res) => {
  await chatGptLogout();
  res.json({ ok: true, chatgptSession: readChatGptSession() });
}));

/** 진짜로 그림이 오는지 한 장 받아본다. 100건을 돌리기 전에 확인하는 용도다. */
app.post('/api/chatgpt/test', wrap(async (req, res) => {
  try {
    const { fileName, bytes } = await testChatGptImage(THUMB_DIR);
    logger.info(`ChatGPT 썸네일 테스트 성공 (${Math.round(bytes / 1024)}KB)`);
    res.json({
      ok: true,
      fileName,
      url: `/thumbnails/${encodeURIComponent(fileName)}`,
      message: `그림 한 장을 받았습니다. (${Math.round(bytes / 1024)}KB)`,
    });
  } catch (error) {
    logger.error(`ChatGPT 썸네일 테스트 실패: ${error.message}`);
    res.json({ ok: false, message: error.message, screenshot: error.screenshot || '' });
  }
}));

/* ---------- 주문 대기열 (큰 주제 + 개수) ---------- */

/**
 * 큰 주제 하나를 대기열에 넣는다.
 *
 * **검색을 기다리지 않고 바로 응답한다.** 실제 검색은 실행 루프가 차례가 됐을 때
 * 돌린다. 그래야 [확인] 을 누른 사람이 곧바로 다음 주제를 입력할 수 있다.
 */
app.post('/api/requests', wrap(async (req, res) => {
  const bigTopic = String(req.body?.bigTopic || '').trim();
  if (!bigTopic) {
    res.status(400).json({ ok: false, message: '큰 주제를 입력해 주세요.' });
    return;
  }
  const targetCount = Number(req.body?.targetCount) || getSettings().discover.targetCount;
  const request = addRequest({ bigTopic, targetCount });

  // 다음에 열었을 때 같은 개수가 그대로 있도록 기본값만 기억해 둔다.
  saveSettings({ discover: { targetCount: request.targetCount } });
  logger.info(`주문 추가 — "${request.bigTopic}" ${request.targetCount}건`);

  // 네이버에 로그인돼 있으면 바로 돌기 시작한다. [실행] 을 또 누를 필요가 없다.
  const started = runner.ensureRunning();
  if (!started.ok) {
    logger.warn(`대기열에 넣었지만 아직 실행하지 못합니다: ${started.message}`);
  }

  res.json({
    ok: true,
    request,
    requests: listRequests(),
    started: started.ok,
    startMessage: started.ok ? '' : started.message,
  });
}));

app.delete('/api/requests/:id', wrap(async (req, res) => {
  const request = getRequest(req.params.id);
  if (request) {
    // 아직 안 쓴 주제까지 같이 걷어낸다. 주문만 지우면 주제가 남아서 계속 써진다.
    const left = cancelPendingJobs(request.id, '주문을 취소해 쓰지 않았습니다.');
    removeRequest(request.id);
    logger.info(
      `주문 취소 — "${request.bigTopic}"${left ? ` (대기 주제 ${left}건 정리)` : ''}`,
    );
  }
  res.json({ ok: true, requests: listRequests(), jobs: listJobs() });
}));

/**
 * 주문 대기열 비우기.
 *
 * `onlyFinished` 가 false 면 아직 안 끝난 주문까지 전부 지운다. 이때
 * **그 주문들이 찾아둔 대기 주제도 같이 걷어내야 한다.** 주문만 지우면
 * 작업 목록에 남은 주제가 계속 써져서, 지웠는데도 글이 올라간다.
 * (주문 하나를 지우는 DELETE 쪽과 같은 이유다)
 */
app.post('/api/requests/clear', wrap(async (req, res) => {
  const onlyFinished = req.body?.onlyFinished !== false;

  let cleaned = 0;
  let removed = 0;
  if (!onlyFinished) {
    for (const request of listRequests()) {
      removed += 1;
      cleaned += cancelPendingJobs(request.id, '대기열을 비워서 쓰지 않았습니다.');
    }
  }

  const requests = clearRequests(onlyFinished);
  if (!onlyFinished) {
    logger.info(
      `대기열을 비웠습니다 — 주문 ${removed}건${cleaned ? `, 대기 주제 ${cleaned}건 정리` : ''}`,
    );
  }
  res.json({ ok: true, requests, jobs: listJobs(), removed, cleaned });
}));

/* ---------- 주제 발굴 (큰 주제 → 최신 정보 → 글 주제) ---------- */

/**
 * 큰 주제로 어떤 글감이 나오는지 **작업 목록에 넣지 않고** 먼저 보여준다.
 *
 * 100건을 자동으로 돌리기 전에 "이 큰 주제로 무슨 글이 나오는지" 를
 * 한 번은 눈으로 봐야 한다. 큰 주제가 너무 넓거나 좁으면 여기서 드러난다.
 */
app.post('/api/discover/preview', wrap(async (req, res) => {
  const bigTopic = String(req.body?.bigTopic || '').trim() || getSettings().discover.bigTopic;
  if (!bigTopic) {
    res.status(400).json({ ok: false, message: '큰 주제를 입력해 주세요.' });
    return;
  }
  // 눌러서 확인한 큰 주제를 그대로 저장한다. 실행할 때 다시 적지 않게.
  saveSettings({ discover: { bigTopic } });

  try {
    const result = await discoverTopics(bigTopic, { want: Number(req.body?.want) || undefined });
    res.json({
      ok: true,
      bigTopic,
      picks: result.picks,
      landscape: result.landscape,
      searches: result.searches,
      received: result.received,
      dropped: result.dropped,
      settings: publicSettings(),
    });
  } catch (error) {
    logger.error(`주제 발굴 실패: ${error.message}`);
    res.json({ ok: true, failed: true, message: error.message, settings: publicSettings() });
  }
}));

/** 미리 본 주제를 작업 목록에 넣는다. 화면에서 고른 것만 받는다. */
app.post('/api/discover/add', wrap(async (req, res) => {
  const picks = Array.isArray(req.body?.picks) ? req.body.picks : [];
  if (!picks.length) {
    res.status(400).json({ ok: false, message: '추가할 주제를 하나 이상 골라 주세요.' });
    return;
  }
  const bigTopic = String(req.body?.bigTopic || '').trim();

  // 화면에서 돌아온 값을 그대로 저장하지 않는다. 길이와 형태를 다시 맞춘다.
  const clean = picks
    .map((pick) => ({
      topic: String(pick?.topic || '').trim().slice(0, 120),
      why: String(pick?.why || '').trim().slice(0, 300),
      score: Math.max(0, Math.min(100, Number(pick?.score) || 0)),
      searchTerms: (Array.isArray(pick?.searchTerms) ? pick.searchTerms : [])
        .map((term) => String(term).trim().slice(0, 60)).filter(Boolean).slice(0, 6),
      freshness: String(pick?.freshness || '').trim().slice(0, 60),
      sources: (Array.isArray(pick?.sources) ? pick.sources : [])
        .map((url) => String(url).trim()).filter(isUsableUrl).slice(0, 3),
      bigTopic,
    }))
    .filter((pick) => pick.topic);

  if (!clean.length) {
    res.status(400).json({ ok: false, message: '추가할 주제를 하나 이상 골라 주세요.' });
    return;
  }

  recordTopics(bigTopic, clean);
  const added = addTopics(clean);
  logger.info(`발굴한 주제 ${added.length}건을 작업 목록에 추가했습니다.`);
  res.json({ ok: true, added: added.length, skipped: clean.length - added.length, jobs: listJobs() });
}));

/** 이미 다룬 주제 기록을 지운다. 같은 소재를 처음부터 다시 쓰고 싶을 때. */
app.post('/api/discover/history/clear', wrap(async (req, res) => {
  clearHistory();
  logger.info('발굴 기록을 지웠습니다. 앞으로는 예전에 쓴 주제도 다시 고를 수 있습니다.');
  res.json({ ok: true, history: historyStats(getSettings().discover.bigTopic) });
}));

/* ---------- 주제 ---------- */

app.post('/api/topics/preview', wrap(async (req, res) => {
  const topics = parseTopics(req.body?.raw || '');
  res.json({ ok: true, count: topics.length, topics: topics.slice(0, 200) });
}));

/**
 * 주제(또는 제목)를 직접 넣는 통로.
 *
 * `fixedTitle` 이 true 면 **적어준 문장을 글 제목으로 그대로 쓴다.**
 * 평소에는 AI 가 주제를 보고 제목을 새로 지어내는데, 제목까지 정해 두고
 * 거기에 맞춰 쓰게 하고 싶을 때가 있어서 나눠 둔다.
 */
app.post('/api/topics', wrap(async (req, res) => {
  const topics = parseTopics(req.body?.raw || '');
  const fixedTitle = req.body?.fixedTitle === true;
  const what = fixedTitle ? '제목' : '주제';
  if (!topics.length) {
    res.status(400).json({ ok: false, message: `${what}을 한 줄에 하나씩 붙여넣어 주세요.` });
    return;
  }
  const added = addTopics(topics.map((topic) => ({ topic, fixedTitle })));
  logger.info(
    `${fixedTitle ? '정해진 제목' : '주제'} ${added.length}건을 추가했습니다. `
    + `(붙여넣기 ${topics.length}건, 중복 제외)`,
  );

  // 넣었으면 바로 돌기 시작한다. [실행] 을 또 누르게 하지 않는다.
  const started = runner.ensureRunning();
  if (!started.ok) logger.warn(`목록에 넣었지만 아직 실행하지 못합니다: ${started.message}`);

  res.json({
    ok: true,
    added: added.length,
    skipped: topics.length - added.length,
    jobs: listJobs(),
    started: started.ok,
    startMessage: started.ok ? '' : started.message,
  });
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
/** Pexels 키가 맞는지, 진짜로 사진이 오는지 한 장 받아본다. */
app.post('/api/pexels/test', wrap(async (req, res) => {
  const apiKey = String(req.body?.apiKey || '').trim();
  if (apiKey) saveSettings({ image: { pexels: { apiKey } } });

  const settings = getSettings();
  try {
    const photo = await fetchPexelsPhoto(
      { scene: 'a bright modern office desk with a notebook and coffee' },
      { width: settings.thumbnail.width, height: settings.thumbnail.height },
    );
    const match = /^data:image\/([a-z0-9+.-]+);base64,(.+)$/i.exec(photo.dataUri);
    if (!match) throw new Error('받은 사진을 읽지 못했습니다.');
    const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    const fileName = `pexels-test-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(THUMB_DIR, fileName), Buffer.from(match[2], 'base64'));

    logger.info(`Pexels 테스트 성공 (${Math.round(photo.bytes / 1024)}KB)`);
    res.json({
      ok: true,
      settings: publicSettings(),
      url: `/thumbnails/${encodeURIComponent(fileName)}`,
      message: `사진 한 장을 받았습니다. ("${photo.query}"`
        + `${photo.credit ? ` · ${photo.credit}` : ''} · ${Math.round(photo.bytes / 1024)}KB)`,
    });
  } catch (error) {
    logger.error(`Pexels 테스트 실패: ${error.message}`);
    res.json({ ok: true, failed: true, settings: publicSettings(), message: error.message });
  }
}));

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
let inFatal = false;

function fatal(label, error) {
  // 이 함수 안에서 또 오류가 나면 여기로 다시 들어온다. 한 번만 처리한다.
  if (inFatal) return;
  inFatal = true;
  try {
    // 검은 창을 닫았을 때 나는 오류다. 서버 자체는 멀쩡하다.
    // 이걸 평소처럼 로그로 남기면 그 로그가 또 같은 오류를 내서 끝없이 돈다.
    // (화면에 `예기치 못한 오류: write EIO` 가 수십 줄 쌓이던 원인)
    if (isBrokenOutput(error)) {
      const first = markConsoleDead();
      logRaw(`${new Date().toISOString()} [WARN ] 검은 창이 닫혀 화면 출력이 끊겼습니다(${error?.code || error?.errno}). 화면 출력만 끄고 계속 진행합니다.`);
      if (first) {
        // 대시보드에는 한 번만 알린다. 웹 화면과 기록 파일은 그대로 돌아간다.
        logger.warn('검은 창이 닫혀 화면 출력이 끊겼습니다. 대시보드는 그대로 씁니다.');
      }
      return;
    }

    logger.error(`${label}: ${error?.message || error}`);
    if (error?.stack) {
      writeConsole(error.stack, 'error');
      logRaw(error.stack);
    }
    writeConsole(`\n기록: ${logFile()}\n창을 닫지 말고 위 내용을 그대로 알려주세요.\n`, 'error');
  } finally {
    inFatal = false;
  }
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
  await Promise.allSettled([closeContext(), closeChatGptContext(), closeRenderBrowser()]);
  server?.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
