import fs from 'node:fs';
import path from 'node:path';
import {
  STATUS, updateJob, nextPending, stats, addTopics, listJobs, cancelPendingJobs,
} from '../lib/store.js';
import {
  REQUEST_STATUS, nextRequest, updateRequest, finishRequest, getRequest, requestStats,
} from '../lib/requests.js';
import { getSettings } from '../lib/settings.js';
import { discoverTopics, discoverBigTopics } from '../content/discover.js';
import { AUTH_HINT } from '../ai/claude.js';
import { recordTopics } from '../lib/history.js';
import { addRequest, listRequests } from '../lib/requests.js';
import { generatePost, countChars } from '../content/generator.js';
import { summarize } from '../content/quality.js';
import { renderThumbnail } from '../content/thumbnail.js';
import { buildBodyHtml, buildIntroHtml, buildPreviewHtml } from '../content/naver.js';
import { buildMarkdown } from '../content/markdown.js';
import { publishDraft } from '../naver/editor.js';
import { readSessionInfo, verifySession } from '../naver/browser.js';
import { OUTPUT_DIR, ensureDirs } from '../lib/paths.js';
import { logger, push } from '../lib/events.js';
import { sleep, randomBetween, slugify } from '../lib/util.js';

const state = {
  running: false,
  paused: false,
  currentJobId: null,
  abort: null,
  waitUntil: null,

  // 지금 처리 중인 주문. 목표와 진행 건수는 주문 자체에 들어 있다.
  currentRequestId: null,
  // 이번 실행에서 임시저장에 성공한 총 건수 (주문에 상관없이).
  saved: 0,
  discovering: false,
};

export function getRunnerState() {
  const request = state.currentRequestId ? getRequest(state.currentRequestId) : null;
  return {
    running: state.running,
    paused: state.paused,
    currentJobId: state.currentJobId,
    waitUntil: state.waitUntil,
    saved: state.saved,
    discovering: state.discovering,
    // 화면 맨 위에 "지금 무엇을 하고 있는지" 한 줄로 띄우기 위한 값들.
    currentRequestId: state.currentRequestId,
    bigTopic: request?.bigTopic || '',
    goal: request?.targetCount || 0,
    requestSaved: request?.saved || 0,
    stats: stats(),
    requests: requestStats(),
  };
}

function broadcast() {
  push('runner', getRunnerState());
}

/**
 * 결과물을 파일로도 남겨둔다. 네이버 자동화가 실패해도 글은 살아 있게.
 *
 * preview.html 을 브라우저로 열어 전체를 복사하면 에디터에 그대로 붙여넣을 수 있고,
 * post.md 는 내용을 읽거나 다른 곳으로 옮길 때 쓰는 보관본이다.
 */
/** 본문을 조립할 때 쓰는 설정. 보관본과 실제 저장이 같은 값을 쓰게 한 곳에 둔다. */
function bodyOptionsFor() {
  const settings = getSettings();
  return {
    sourcesHeading: settings.research.sourcesHeading,
    appendTags: settings.post.appendTags,
  };
}

function archivePost(job, post, thumbnailPath) {
  ensureDirs();
  const base = `${slugify(job.topic, 30)}-${job.id}`;
  const dir = path.join(OUTPUT_DIR, base);
  fs.mkdirSync(dir, { recursive: true });

  const thumbName = thumbnailPath ? path.basename(thumbnailPath) : '';
  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    fs.copyFileSync(thumbnailPath, path.join(dir, thumbName));
  }

  const bodyOptions = bodyOptionsFor();
  // 실제로 에디터에 붙여넣는 것과 같은 HTML.
  const content = buildIntroHtml(post) + buildBodyHtml(post, bodyOptions);

  fs.writeFileSync(path.join(dir, 'post.json'), JSON.stringify(post, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'post.md'),
    buildMarkdown(post, { thumbnailFile: thumbName, sourcesHeading: bodyOptions.sourcesHeading }),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'content.html'), content, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'preview.html'),
    buildPreviewHtml(post, { thumbnailSrc: thumbName, ...bodyOptions }),
    'utf8',
  );

  // 조사 원자료를 따로 남긴다. 발행 전에 "무엇을 근거로 썼는지" 확인하는 용도다.
  if (post.research) {
    fs.writeFileSync(path.join(dir, 'research.json'), JSON.stringify(post.research, null, 2), 'utf8');
  }
  return dir;
}

async function processJob(job) {
  state.currentJobId = job.id;
  broadcast();

  const settings = getSettings();

  updateJob(job.id, {
    status: settings.research.enabled ? STATUS.RESEARCHING : STATUS.WRITING,
    message: settings.research.enabled
      ? '웹에서 최신 자료를 찾는 중...'
      : 'AI가 품질 기준에 맞춰 글을 쓰는 중...',
    attempts: job.attempts + 1,
  });
  logger.step(`[${job.topic}] 글 생성 시작`, { jobId: job.id });

  const post = await generatePost(job.topic, {
    // 제목을 정해 넣은 주제면 그 문장을 글 제목으로 그대로 쓴다.
    fixedTitle: job.fixedTitle ? job.topic : '',
    signal: state.abort?.signal,
    onResearch: () => {
      if (!settings.research.enabled) return;
      updateJob(job.id, { status: STATUS.RESEARCHING, message: '웹에서 최신 자료를 찾는 중...' });
    },
    onCompliance: () => {
      updateJob(job.id, { status: STATUS.CHECKING, message: '품질 검사에서 걸린 부분을 고쳐 쓰는 중...' });
    },
  });

  const charCount = countChars(post);
  const tableRows = post.table?.rows?.length || 0;
  const compliance = post.compliance;
  const research = post.research;

  const notes = [`공백 제외 ${charCount.toLocaleString()}자`];
  if (research) notes.push(`검색 ${research.searches}회 · 출처 ${post.sources.length}건`);
  if (tableRows) {
    notes.push(post.tableExpected ? `표 ${tableRows}/${post.tableExpected}행` : `표 ${tableRows}행`);
  }
  if (post.tableMissing?.length) notes.push(`누락 ${post.tableMissing.length}건`);
  if (post.repairs) notes.push(`보정 ${post.repairs}회`);
  if (compliance) notes.push(summarize(compliance));

  updateJob(job.id, {
    title: post.title,
    charCount,
    tableRows,
    model: post.model,
    guidelineCheck: post.guidelineCheck,
    compliance,
    repairs: post.repairs || 0,
    searches: research?.searches || 0,
    sourceCount: post.sources?.length || 0,
    unverified: research?.unverified?.length || 0,
    message: `초안 완성 (${notes.join(', ')})`,
  });
  logger.info(
    `[${job.topic}] 초안 완성: "${post.title}" — ${notes.join(', ')}`
    + `${post.model ? ` / 모델 ${post.model}` : ''}`,
    { jobId: job.id },
  );
  if (post.guidelineCheck) {
    logger.info(`[${job.topic}] 지침 반영: ${post.guidelineCheck}`, { jobId: job.id });
  }
  if (research?.unverified?.length) {
    logger.warn(
      `[${job.topic}] 조사에서 확인하지 못한 내용 ${research.unverified.length}건이 있습니다. `
      + `발행 전에 확인하세요: ${research.unverified.slice(0, 3).join(' / ')}`,
      { jobId: job.id },
    );
  }

  // 끝내 규칙을 못 지킨 글을 올리지 않도록 막을 수 있다. 기본값은 "올리되 표시만".
  if (compliance && !compliance.ok) {
    const detail = compliance.issues.map((issue) => `${issue.label}(${issue.detail})`).join(' / ');
    if (settings.quality.blockOnFail) {
      throw new Error(`품질 검사 미통과로 저장하지 않았습니다: ${detail}`);
    }
    logger.warn(`[${job.topic}] 품질 미통과 항목이 남아 있습니다: ${detail}`, { jobId: job.id });
  }

  updateJob(job.id, { status: STATUS.THUMBNAIL, message: '썸네일 만드는 중...' });
  let thumb = { filePath: '', fileName: '', style: '' };
  try {
    thumb = await renderThumbnail(post, { jobId: job.id });
    updateJob(job.id, { thumbnailPath: thumb.fileName, message: `썸네일 완성 (${thumb.style})` });
  } catch (error) {
    // 썸네일은 글의 부속물이다. 여기서 실패했다고 글을 버리지 않는다.
    logger.warn(`[${job.topic}] 썸네일 생성 실패, 글만 저장합니다: ${error.message}`, { jobId: job.id });
  }

  const dir = archivePost(job, post, thumb.filePath);

  updateJob(job.id, { status: STATUS.POSTING, message: '네이버 블로그에 옮겨 적는 중...' });
  const result = await publishDraft({
    post,
    thumbnailPath: thumb.filePath,
    jobId: job.id,
    bodyOptions: bodyOptionsFor(),
  });

  // 저장 완료 표시(토스트)를 못 잡았어도 저장은 됐을 수 있다.
  // 확인하지 못했다는 사실을 감추지 않고 그대로 알린다.
  const saveNote = result.confirmed ? '임시저장 완료' : '임시저장 (저장 표시 확인 못 함)';
  updateJob(job.id, {
    status: STATUS.DONE,
    message: compliance?.ok
      ? `${saveNote} (품질 검사 통과)`
      : `${saveNote} (${summarize(compliance)})`,
    archiveDir: path.basename(dir),
    editUrl: result.draftListUrl || '',
    confirmed: result.confirmed,
  });
  logger.info(
    `[${job.topic}] ${saveNote}. 네이버 글쓰기 화면의 [저장] 목록에서 확인하세요 `
    + `→ ${result.draftListUrl}`,
    { jobId: job.id },
  );
}

// 같은 이유로 계속 실패할 때 남은 주제를 전부 태우지 않도록 하는 한계선.
/**
 * 실패 메시지가 길면 작업표가 글로 뒤덮인다.
 * (AI 가 주제를 거절하면 이유를 몇 문단씩 적어 보낸다)
 * 표에는 짧게 띄우고 전체 내용은 따로 담아 마우스를 올렸을 때 보이게 한다.
 */
function shorten(message, max = 160) {
  const text = String(message).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * 대기 중인 주제가 떨어졌을 때 큰 주제로 다시 발굴해 채운다.
 *
 * 목표까지 남은 건수보다 조금 넉넉히 받아 온다. 주제 하나가 거절당하거나
 * 실패할 수 있어서, 딱 맞춰 받아 오면 매번 다시 발굴하러 나가야 한다.
 * 발굴은 검색이 여러 번 도는 비싼 호출이라 횟수를 줄이는 편이 낫다.
 *
 * @returns {Promise<number>} 실제로 작업 목록에 들어간 건수
 */
async function refillQueue(request) {
  const settings = getSettings();
  const remaining = Math.max(1, request.targetCount - request.saved);
  const want = Math.min(
    Math.max(settings.discover.batchSize, remaining),
    remaining + 2,
  );

  state.discovering = true;
  broadcast();
  try {
    // 아직 안 쓴 대기 주제도 제외 목록에 넣는다. 목록에 있는데 또 골라 오면
    // addTopics 가 걸러내긴 하지만, 애초에 다른 주제를 골라 오는 편이 낫다.
    const exclude = listJobs().map((job) => job.topic);
    const result = await discoverTopics(request.bigTopic, {
      want,
      exclude,
      signal: state.abort?.signal,
    });

    // discoverTopics 는 조건을 풀어 가며 반드시 뭐라도 건져 온다. 그래도 0건이면
    // 모델이 응답을 제대로 못 준 경우다. 다음 판에서 다시 시도한다.
    if (!result.picks.length) {
      logger.warn(
        `[${request.bigTopic}] 이번 발굴에서 아무 것도 받지 못했습니다 `
        + `(모델이 준 후보 ${result.received}건). 잠시 뒤 다시 시도합니다.`,
      );
      return 0;
    }

    // 실제로 글을 썼는지와 무관하게 발굴한 시점에 기록한다.
    // 실패한 주제를 다음 발굴에서 또 골라 와 또 실패하는 일을 막는다.
    recordTopics(request.bigTopic, result.picks);
    const added = addTopics(result.picks, request.id);
    updateRequest(request.id, {
      discovered: request.discovered + added.length,
      // 조건을 풀어서 고른 경우 그 사실을 화면에도 남긴다.
      message: `주제 ${added.length}건을 찾았습니다.`
        + (result.relaxed ? ` (${result.relaxed})` : ''),
    });
    logger.info(`[${request.bigTopic}] 주제 ${added.length}건을 작업 목록에 추가했습니다.`);
    return added.length;
  } finally {
    state.discovering = false;
    broadcast();
  }
}

/**
 * 대기열이 비었을 때 이어서 쓸 **큰 주제**를 만들어 주문으로 넣는다.
 *
 * 사용자가 큰 주제를 계속 넣어 주지 않아도 멈추지 않게 하는 장치다.
 * 지금까지 쓴 큰 주제를 씨앗으로 결이 이어지는 분야를 받아 온다.
 *
 * 받아 온 것이 하나도 없으면 0을 돌려준다. 여기서 억지로 만들어 내지는
 * 않는다. 아무 분야나 골라 쓰면 블로그 색이 흐려지기 때문이다.
 * (같은 큰 주제 안에서 소재가 떨어지는 것은 discoverTopics 가 알아서 푼다)
 *
 * @returns {Promise<number>} 새로 넣은 주문 수
 */
async function refillOrders() {
  const settings = getSettings();
  const want = Math.max(1, Number(settings.discover.refillCount) || 3);
  const targetCount = Math.max(1, Number(settings.discover.targetCount) || 5);

  state.discovering = true;
  broadcast();
  try {
    logger.step(`대기열이 비었습니다. 이어서 쓸 큰 주제 ${want}건을 찾는 중...`);
    const topics = await discoverBigTopics({
      want,
      // 아직 안 끝난 주문에 있는 분야는 빼고 받는다.
      avoid: listRequests().map((request) => request.bigTopic),
      signal: state.abort?.signal,
    });

    for (const item of topics) addRequest({ bigTopic: item.topic, targetCount });

    if (topics.length) {
      logger.info(
        `큰 주제 ${topics.length}건을 대기열에 이어 붙였습니다 — `
        + `${topics.map((item) => item.topic).join(', ')} (각 ${targetCount}건)`,
      );
    }
    return topics.length;
  } catch (error) {
    if (error.rateLimited || error.authExpired) throw error;
    logger.error(`큰 주제를 이어 붙이지 못했습니다: ${error.message}`);
    return 0;
  } finally {
    state.discovering = false;
    broadcast();
  }
}

/**
 * 한 주문이 주제를 몇 건까지 찾아올 수 있는지.
 *
 * 목표를 채울 때까지 도는 구조라, 글이 전부 실패하면(네이버 로그인이 풀렸다든지)
 * "찾아오고 → 실패하고 → 다시 찾아오고" 를 끝없이 반복하게 된다. 주제는 계속
 * 늘어나는데 저장된 글은 하나도 안 늘어나는 상태다. 그럴 때 멈출 선이다.
 */
export const discoverCapFor = (request) => Math.max(10, (request?.targetCount || 0) * 2 + 5);

/**
 * 다음에 무엇을 할지 정한다.
 *
 * 이 판단이 틀리면 두 가지 중 하나가 난다. 목표를 못 채우고 일찍 끝나거나,
 * 아니면 끝없이 돌면서 검색 호출만 태운다. 둘 다 자는 동안 벌어지는 일이라
 * 판단만 따로 떼어 놓고 자체 점검에서 확인한다.
 *
 * @param {object|null} request   지금 처리 중인 주문 (없으면 null)
 * @param {boolean} autoRefill     대기열이 비면 큰 주제를 알아서 이어 붙일지
 * @returns {'process'|'discover'|'finish-request'|'give-up-request'|'refill-orders'|'stop-empty'}
 */
export function planNextStep({ hasPending, request, autoRefill = false }) {
  // 주문이 없을 때. 손으로 넣은 주제가 남아 있으면 그것부터 쓴다.
  if (!request) {
    if (hasPending) return 'process';
    // 자동 이어가기를 켰으면 여기서 끝내지 않고 큰 주제를 새로 만들어 온다.
    return autoRefill ? 'refill-orders' : 'stop-empty';
  }

  // 목표를 채웠다. 넉넉히 받아 둔 주제가 남아 있어도 여기서 이 주문을 닫는다.
  // 그래야 다음 주문으로 넘어간다.
  if (request.saved >= request.targetCount) return 'finish-request';

  if (hasPending) return 'process';

  // 계속 찾아오는데 저장이 안 된다. 이 주문은 포기하고 다음으로 간다.
  if (request.discovered >= discoverCapFor(request)) return 'give-up-request';

  return 'discover';
}

/** 글 하나가 저장됐을 때 그 주제를 데려온 주문의 몫으로 센다. */
function countForRequest(job, field) {
  const request = job.requestId ? getRequest(job.requestId) : null;
  if (!request) return null;
  return updateRequest(request.id, { [field]: (request[field] || 0) + 1 });
}

async function loop() {
  let processed = 0;
  let consecutiveFailures = 0;
  // 발굴을 나갔는데 한 건도 못 건진 횟수. 주문이 바뀌면 다시 0부터 센다.
  let emptyDiscoveries = 0;
  // 마지막으로 발굴이 실패한 이유. 주문을 접을 때 화면에 같이 띄운다.
  // 이게 없으면 "새 주제를 찾지 못했습니다" 만 남아서 왜 그런지 알 수가 없다.
  let lastDiscoverError = '';
  // 큰 주제를 이어 붙이러 나갔는데 빈손으로 온 횟수.
  let emptyRefills = 0;

  while (state.running) {
    if (state.paused) {
      await sleep(700);
      continue;
    }

    // 주문 대기열의 맨 앞을 가져온다. 처리하는 동안에도 뒤에 계속 쌓일 수 있다.
    const request = nextRequest();
    if (request?.id !== state.currentRequestId) {
      state.currentRequestId = request?.id || null;
      emptyDiscoveries = 0;
      lastDiscoverError = '';
      if (request && request.status !== REQUEST_STATUS.RUNNING) {
        updateRequest(request.id, {
          status: REQUEST_STATUS.RUNNING,
          message: '주제를 찾는 중...',
        });
        logger.step(
          `[${request.bigTopic}] 주문을 시작합니다 — ${request.targetCount}건 임시저장 목표`,
        );
      }
      broadcast();
    }

    const job = nextPending();
    const autoRefill = Boolean(getSettings().discover.autoRefill);
    const step = planNextStep({ hasPending: Boolean(job), request, autoRefill });

    if (step === 'stop-empty') {
      logger.info('대기 중인 주문과 주제가 모두 없습니다. 실행을 마칩니다.');
      break;
    }

    /*
     * 대기열이 비었는데 자동 이어가기가 켜져 있다. 지금까지 쓴 큰 주제를
     * 씨앗으로 결이 이어지는 분야를 새로 받아 와 주문으로 넣는다.
     * 사용자가 큰 주제를 계속 넣어 주지 않아도 멈추지 않게 하는 장치다.
     */
    if (step === 'refill-orders') {
      let made = 0;
      try {
        made = await refillOrders();
      } catch (error) {
        // 로그인 만료와 사용량 한도는 여기서 실행을 끝내면 안 된다.
        // 끝내 버리면 [이어서 실행]을 눌러도 대기열이 비어 있어서 다시 못 돈다.
        if (error.authExpired) {
          state.paused = true;
          logger.error(AUTH_HINT);
          broadcast();
          continue;
        }
        if (error.rateLimited) {
          state.paused = true;
          logger.error(`큰 주제를 찾는 중 사용량 한도에 걸려 일시정지했습니다. ${error.message}`);
          broadcast();
          continue;
        }
        if (/중지했습니다/.test(error.message)) break;
        logger.error(`큰 주제를 이어 붙이지 못했습니다: ${error.message}`);
      }
      if (!made) {
        emptyRefills += 1;
        // 두 번 연달아 빈손이면 더 돌려도 같다. 호출만 태우지 말고 멈춘다.
        if (emptyRefills >= 2) {
          logger.error(
            '이어서 쓸 큰 주제를 두 번 연속으로 받지 못해 실행을 멈춥니다. '
            + '설정에서 [선택한 모델로 연결 테스트]를 눌러 보세요.',
          );
          break;
        }
        await sleep(5000);
      } else {
        emptyRefills = 0;
      }
      continue;
    }

    // 목표를 채웠다. 넉넉히 받아 둔 주제가 남아 있으면 건너뜀으로 정리하고
    // 다음 주문으로 넘어간다.
    if (step === 'finish-request') {
      const left = cancelPendingJobs(
        request.id,
        `목표 ${request.targetCount}건을 채워 이 주제는 쓰지 않았습니다.`,
      );
      finishRequest(
        request.id,
        REQUEST_STATUS.DONE,
        `${request.saved}건 임시저장 완료${left ? ` (남은 주제 ${left}건은 건너뜀)` : ''}`,
      );
      logger.info(
        `[${request.bigTopic}] 목표한 ${request.targetCount}건을 모두 임시저장했습니다.`
        + `${left ? ` 남은 주제 ${left}건은 쓰지 않습니다.` : ''}`,
      );
      continue;
    }

    if (step === 'give-up-request') {
      const left = cancelPendingJobs(request.id, '이 주문을 멈춰서 쓰지 않았습니다.');
      finishRequest(
        request.id,
        REQUEST_STATUS.FAILED,
        `주제 ${request.discovered}건을 찾았지만 ${request.saved}건만 저장됐습니다.`,
      );
      logger.error(
        `[${request.bigTopic}] 주제를 ${request.discovered}건이나 찾았는데 `
        + `임시저장된 글은 ${request.saved}건뿐이라 이 주문을 멈춥니다. `
        + '네이버 로그인이 풀렸거나 품질 검사 설정에 문제가 있을 수 있습니다. '
        + `작업표의 실패 메시지를 확인해 주세요.${left ? ` (남은 주제 ${left}건 정리)` : ''}`,
      );
      continue;
    }

    // 대기 주제가 떨어졌다. 이 주문의 큰 주제로 웹 검색을 돌려 새로 찾아온다.
    if (step === 'discover') {
      let added = 0;
      try {
        added = await refillQueue(request);
      } catch (error) {
        // 로그인이 풀린 채로 계속 찾아봐야 전부 실패한다. 주문을 접지 말고 세워 둔다.
        if (error.authExpired) {
          state.paused = true;
          updateRequest(request.id, { message: 'claude 로그인이 풀려 대기 중입니다.' });
          logger.error(AUTH_HINT);
          broadcast();
          continue;
        }
        if (error.rateLimited) {
          state.paused = true;
          logger.error(`주제를 찾는 중 사용량 한도에 걸려 일시정지했습니다. ${error.message}`);
          broadcast();
          continue;
        }
        if (/중지했습니다/.test(error.message)) break;
        lastDiscoverError = shorten(error.message, 120);
        logger.error(`주제 발굴에 실패했습니다: ${error.message}`);
      }

      if (!added) {
        emptyDiscoveries += 1;
        // 두 번 연달아 빈손이면 더 돌려도 같다. 이 주문은 접고 다음으로 간다.
        if (emptyDiscoveries >= 2) {
          finishRequest(
            request.id,
            REQUEST_STATUS.FAILED,
            `새 주제를 찾지 못했습니다. (${request.saved}/${request.targetCount}건 저장)`
            + (lastDiscoverError ? ` — ${lastDiscoverError}` : ''),
          );
          logger.warn(
            `[${request.bigTopic}] 두 번 연속으로 주제를 하나도 받지 못해 이 주문을 접습니다. `
            + '조건을 풀어도 빈손이면 AI 응답 자체가 안 오는 것이니, '
            + '설정에서 [선택한 모델로 연결 테스트]와 2번 칸의 [미리 보기만]을 눌러 보세요.',
          );
          continue;
        }
        await sleep(3000);
      }
      // 방금 넣은 주제를 집으러 위로 돌아간다.
      continue;
    }

    try {
      await processJob(job);
      consecutiveFailures = 0;
      state.saved += 1;
      const owner = countForRequest(job, 'saved');
      broadcast();
      if (owner) {
        logger.info(
          `[${owner.bigTopic}] 진행 ${owner.saved}/${owner.targetCount}건 임시저장 완료.`,
        );
      }
    } catch (error) {
      const message = error.message || String(error);

      /*
       * claude 로그인이 풀렸다. 계속 돌리면 남은 주제가 **전부** 같은 이유로
       * 실패해서 대기열이 통째로 타 버린다. 실제로 그렇게 3건이 실패하고
       * 실행이 멈춘 적이 있다. 사람이 다시 로그인하기 전에는 무엇도 못 한다.
       *
       * 그래서 실패로 두지 않고 **대기로 되돌린 뒤 일시정지**한다.
       * 다시 로그인하고 [이어서 실행]을 누르면 이 주제부터 그대로 이어진다.
       */
      if (error.authExpired) {
        updateJob(job.id, {
          status: STATUS.PENDING,
          message: 'claude 로그인이 풀려 대기 중입니다.',
          detail: message,
          // 이 실패로 재시도 횟수를 까먹지 않게 되돌린다. 주제 탓이 아니다.
          // (processJob 이 시작할 때 1 을 올려 뒀다. job 은 그 전의 값이다)
          attempts: job.attempts,
        });
        state.paused = true;
        logger.error(AUTH_HINT);
        broadcast();
        continue;
      }

      // 사용량 한도는 계속 돌려도 전부 실패한다. 멈추고 사람이 판단하게 둔다.
      if (error.rateLimited) {
        updateJob(job.id, { status: STATUS.PENDING, message: `사용량 한도로 대기: ${message}` });
        state.paused = true;
        logger.error(`사용량 한도에 걸려 일시정지했습니다. 잠시 뒤 [이어서 실행]을 눌러주세요. ${message}`);
        broadcast();
        continue;
      }

      // AI 가 "이 주제로는 못 쓰겠다" 고 거절한 경우다.
      // 같은 주제로 다시 물어봐야 같은 대답이 온다. 재시도는 호출만 버리는 짓이고,
      // 설정이 잘못된 것도 아니니 연속 실패로 세지도 않는다. 바로 다음 주제로 간다.
      if (error.refusal) {
        updateJob(job.id, {
          status: STATUS.SKIPPED,
          message: `AI가 이 주제를 거절했습니다: ${shorten(error.reason || message)}`,
          detail: String(error.reason || message),
        });
        logger.warn(
          `[${job.topic}] 조건을 바꿔 한 번 더 요청했는데도 AI가 거절해 건너뜁니다. `
          + `${shorten(error.reason || message, 200)}`,
          { jobId: job.id },
        );
        countForRequest(job, 'failed');
        continue;
      }

      consecutiveFailures += 1;
      // 네이버 자동화가 깨졌을 때는 그 순간의 화면이 유일한 단서다.
      // 파일 경로를 작업표에 같이 남겨 어디를 봐야 하는지 알 수 있게 한다.
      const detail = error.screenshot
        ? `${message}\n오류 화면: ${error.screenshot}`
        : message;

      const canRetry = job.attempts <= getSettings().run.maxRetries;
      if (canRetry && state.running) {
        updateJob(job.id, {
          status: STATUS.PENDING,
          message: `실패, 재시도 예정: ${shorten(message)}`,
          detail,
        });
        logger.warn(`[${job.topic}] 실패 - 재시도합니다. ${shorten(message, 200)}`, { jobId: job.id });
        await sleep(5000);
      } else {
        updateJob(job.id, { status: STATUS.FAILED, message: shorten(message), detail });
        logger.error(`[${job.topic}] 실패: ${shorten(message, 200)}`, { jobId: job.id });
        countForRequest(job, 'failed');
      }

      // 설정이 잘못됐거나 연결이 끊긴 상태라면 남은 주제도 전부 같은 이유로 실패한다.
      // 그래도 기본값은 "멈추지 않고 계속" 이다. 한두 주제가 안 된다고 나머지
      // 아흔 몇 건을 세워두는 것보다, 끝까지 돌려놓고 실패한 것만 다시 보는 편이 낫다.
      // 설정에서 0 이 아닌 값을 주면 그 횟수만큼 연속 실패했을 때 멈춘다.
      const stopAfter = Number(getSettings().run.stopAfterFailures) || 0;
      if (stopAfter > 0 && consecutiveFailures >= stopAfter) {
        logger.error(
          `연속 ${consecutiveFailures}건이 실패해 실행을 멈춥니다. `
          + `마지막 오류: ${shorten(message, 200)}`,
        );
        state.running = false;
      }
    } finally {
      state.currentJobId = null;
      broadcast();
    }

    processed += 1;
    if (!state.running) break;
    // 끝낼 때가 됐는지는 위에서 한 곳에서만 판단한다. 여기서는 더 쓸 글이
    // 남았는지만 보고, 남았으면 다음 글까지 사이를 띄운다.
    const next = planNextStep({
      hasPending: Boolean(nextPending()),
      request: nextRequest(),
      autoRefill: Boolean(getSettings().discover.autoRefill),
    });
    if (next !== 'process' && next !== 'discover' && next !== 'refill-orders') continue;

    // 짧은 시간에 몰아서 올리면 네이버가 연속 자동화로 볼 수 있다. 사이를 띄운다.
    const { delayMinSec, delayMaxSec } = getSettings().run;
    const wait = randomBetween(
      Math.max(0, delayMinSec) * 1000,
      Math.max(delayMinSec, delayMaxSec) * 1000,
    );
    state.waitUntil = Date.now() + wait;
    broadcast();
    logger.info(`다음 글까지 ${Math.round(wait / 1000)}초 대기합니다.`);

    const until = Date.now() + wait;
    while (Date.now() < until && state.running) await sleep(500);
    state.waitUntil = null;
  }

  state.running = false;
  state.paused = false;
  state.currentJobId = null;
  state.currentRequestId = null;
  state.waitUntil = null;
  state.discovering = false;
  broadcast();
  logger.info(
    `실행 종료. 이번 실행에서 ${processed}건 처리했고 ${state.saved}건을 임시저장했습니다.`,
  );
}

export function start() {
  if (state.running) return { ok: false, message: '이미 실행 중입니다.' };

  // 주문도 없고 손으로 넣은 주제도 없으면 할 일이 없다.
  // 단, [대기열이 비면 큰 주제를 알아서 이어 붙이기] 를 켜 뒀다면 얘기가 다르다.
  // 그건 "빈 대기열에서 시작해도 알아서 만들어 쓰라" 는 뜻이다.
  // 여기서 막아 버리면 체크해 놔도 실행이 안 돼서, 켜 둔 뜻이 없어진다.
  if (!nextRequest() && !nextPending() && !getSettings().discover.autoRefill) {
    return {
      ok: false,
      message: '2번 칸에 큰 주제를 넣고 [확인]을 누르거나, 직접 주제를 추가한 뒤에 실행해 주세요. '
        + '(주제를 넣지 않고 돌리려면 3번 칸의 [대기열이 비면 큰 주제를 알아서 이어 붙이기]를 켜세요)',
    };
  }

  const session = readSessionInfo();
  if (!session.loggedIn) {
    return { ok: false, message: '먼저 네이버에 로그인해 주세요. (1번 칸의 [네이버 로그인 창 열기])' };
  }
  if (!session.blogId && !getSettings().blogId) {
    return { ok: false, message: '블로그 아이디를 찾지 못했습니다. 1번 칸에 직접 입력해 주세요.' };
  }

  // 저장된 세션이 아직 살아 있는지는 실제로 열어봐야 안다.
  // 여기서 막지는 않는다. 확인이 실패했다고 멀쩡한 세션까지 세워둘 이유는 없고,
  // 정말 풀렸다면 첫 글에서 분명한 메시지와 함께 걸린다.
  verifySession().catch((error) => logger.warn(`세션 확인을 건너뜁니다: ${error.message}`));

  state.running = true;
  state.paused = false;
  state.abort = new AbortController();
  state.saved = 0;
  broadcast();

  const { remaining, open } = requestStats();
  logger.info(
    open
      ? `실행 시작 - 주문 ${open}건, 앞으로 쓸 글 ${remaining}편 (대기 주제 ${stats().pending}건)`
      : `실행 시작 - 대기 주제 ${stats().pending}건`,
  );
  loop().catch((error) => {
    logger.error(`실행 루프 오류: ${error.message}`);
    state.running = false;
    state.discovering = false;
    broadcast();
  });
  return { ok: true };
}

/**
 * 주문을 넣었을 때 알아서 돌기 시작하게 한다.
 *
 * [확인] 을 누른 사람이 [실행] 을 또 눌러야 한다면 대기열을 만든 뜻이 없다.
 * 이미 돌고 있으면 아무 것도 하지 않는다. 새 주문은 지금 도는 루프가
 * 차례가 됐을 때 알아서 집어 간다.
 */
export function ensureRunning() {
  if (state.running) return { ok: true, already: true };
  return start();
}

export function pause() {
  if (!state.running) return { ok: false, message: '실행 중이 아닙니다.' };
  state.paused = !state.paused;
  broadcast();
  logger.info(state.paused ? '일시정지했습니다.' : '다시 시작합니다.');
  return { ok: true, paused: state.paused };
}

export function stop() {
  if (!state.running) return { ok: false, message: '실행 중이 아닙니다.' };
  state.running = false;
  state.paused = false;
  state.abort?.abort();
  broadcast();
  logger.info('중지 요청을 받았습니다. 진행 중인 글을 마치고 멈춥니다.');
  return { ok: true };
}
