const $ = (id) => document.getElementById(id);

const STATUS_LABEL = {
  pending: '대기',
  researching: '자료 조사 중',
  writing: '글 작성 중',
  checking: '품질 보정 중',
  thumbnail: '썸네일 생성',
  posting: '네이버에 옮겨 적는 중',
  done: '완료',
  failed: '실패',
  skipped: '건너뜀',
};

const CUSTOM_MODEL = '__custom__';

let state = {
  settings: null, session: null, jobs: [], runner: null,
  models: [], examples: [], rules: [],
  // 마지막으로 [미리 보기만] 으로 받아온 후보들. 목록에 넣기 전까지만 들고 있는다.
  picks: [], history: null,
  // 주문 대기열 (큰 주제 + 개수)
  requests: [],
};

/* ---------- 공통 ---------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, message: '응답을 읽지 못했습니다.' }));
  if (!res.ok || data.ok === false) throw new Error(data.message || `요청 실패 (${res.status})`);
  return data;
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function shortModel(id) {
  if (!id) return '-';
  const known = (state.models || []).find((model) => model.id === id);
  if (known) return known.label.split(' — ')[0];
  return id.replace(/^claude-/, '');
}

/* ---------- 렌더 ---------- */

function renderPills(health) {
  if (health) {
    const claude = $('pill-claude');
    const browser = $('pill-browser');
    claude.textContent = health.claude.ok ? `AI 준비됨 · ${health.claude.version.split(' ')[0]}` : 'claude CLI 없음';
    claude.className = `pill ${health.claude.ok ? 'ok' : 'bad'}`;
    browser.textContent = health.browser.ok ? '브라우저 준비됨' : '브라우저 준비 실패';
    browser.className = `pill ${health.browser.ok ? 'ok' : 'bad'}`;
  }
  renderSession();
  renderModelPill();
}

function renderModelPill() {
  const pill = $('pill-model');
  const id = state.settings?.claude?.model || '';
  pill.textContent = `모델: ${id ? shortModel(id) : '기본값'}`;
  pill.className = `pill ${id ? 'ok' : ''}`.trim();
}

function renderSession() {
  const pill = $('pill-session');
  const session = state.session || {};
  const blogId = session.blogId || state.settings?.blogId || '';

  if (session.loggedIn && blogId) {
    pill.textContent = `로그인됨 · ${blogId}`;
    pill.className = 'pill ok';
  } else if (session.loggedIn) {
    // 로그인은 됐는데 어느 블로그에 쓸지를 모르는 상태다. 실행하면 첫 글에서 막힌다.
    pill.textContent = '블로그 아이디 필요';
    pill.className = 'pill warn';
  } else {
    pill.textContent = '네이버 로그인 필요';
    pill.className = 'pill bad';
  }

  $('session-detail').textContent = session.checkedAt
    ? `마지막 확인 ${new Date(session.checkedAt).toLocaleString('ko-KR')}`
    : '로그인 세션은 이 컴퓨터에만 저장됩니다.';

  // 사용자가 입력 중일 때 덮어쓰면 글자가 지워진다.
  const input = $('s-blog-id');
  if (document.activeElement !== input) input.value = blogId;
}

function renderRules() {
  $('rule-list').innerHTML = (state.rules || [])
    .map((rule) => `<li><span class="rule-dot"></span>${escapeHtml(rule.label)}</li>`)
    .join('');
}

function renderModels() {
  const select = $('s-model');
  const current = state.settings?.claude?.model || '';
  const known = (state.models || []).some((model) => model.id === current);

  select.innerHTML = (state.models || [])
    .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}</option>`)
    .join('') + `<option value="${CUSTOM_MODEL}">직접 입력…</option>`;

  if (current && !known) {
    select.value = CUSTOM_MODEL;
    $('s-model-custom').value = current;
    $('model-custom-wrap').classList.remove('hidden');
  } else {
    select.value = current;
    $('model-custom-wrap').classList.add('hidden');
  }
  updateModelNote();
}

function updateModelNote() {
  const select = $('s-model');
  const model = (state.models || []).find((item) => item.id === select.value);
  $('model-note').textContent = select.value === CUSTOM_MODEL
    ? 'claude CLI 가 아는 모델 이름을 그대로 적으세요.'
    : (model?.note || '');
}

function renderExamples() {
  const list = state.examples || [];
  $('example-count').textContent = `${list.length}개${list.length ? ` (켜짐 ${list.filter((e) => e.enabled).length}개)` : ''}`;
  $('example-list').innerHTML = list.length
    ? list.map((entry) => `
        <li class="${entry.enabled ? '' : 'off'}">
          <label class="ex-toggle">
            <input type="checkbox" data-toggle="${entry.id}" ${entry.enabled ? 'checked' : ''}>
            <span class="ex-name">${escapeHtml(entry.name)}</span>
          </label>
          <span class="ex-meta">${entry.chars.toLocaleString()}자${entry.truncated ? ' · 일부만 저장됨' : ''}</span>
          <button class="btn ghost small danger" data-ex-remove="${entry.id}">삭제</button>
        </li>`).join('')
    : '<li class="empty-row">아직 올린 예시가 없습니다.</li>';
}

/** 품질 점검 결과를 한 칸짜리 배지로. 마우스를 올리면 항목별 내용이 보인다. */
function complianceCell(job) {
  const compliance = job.compliance;
  if (!compliance) return '<span class="hint">-</span>';
  const tooltip = compliance.results
    .map((result) => `${result.ok ? '[통과]' : '[미통과]'} ${result.label} — ${result.detail}`)
    .join('\n');
  const cls = compliance.ok ? 'pass' : 'fail';
  return `<span class="check-badge ${cls}" title="${escapeHtml(tooltip)}">`
    + `${compliance.passed}/${compliance.total}</span>`;
}

/**
 * 검색 횟수와 출처 개수.
 * 검색이 0회면 "검색했다고 말만 한" 결과라 경고로 표시한다.
 */
function sourceCell(job) {
  if (!job.sourceCount && !job.searches) return '<span class="hint">-</span>';
  const cls = job.searches ? 'pass' : 'fail';
  const tip = job.searches
    ? `웹 검색 ${job.searches}회로 모은 출처 ${job.sourceCount}건을 글 끝에 붙였습니다.`
    : '웹 검색이 실제로 실행되지 않았습니다. 내용을 직접 확인하세요.';
  return `<span class="check-badge ${cls}" title="${escapeHtml(tip)}">`
    + `${job.searches}회 / ${job.sourceCount}건</span>`;
}

/**
 * 발굴한 주제의 관심도 점수. 왜 이 주제를 골랐는지가 여기에 담긴다.
 * 직접 적은 주제는 점수가 없으므로 빈 칸으로 둔다.
 */
function scoreCell(job) {
  if (!job.score) return '<span class="hint">-</span>';
  const tip = [
    job.why ? `왜: ${job.why}` : '',
    job.searchTerms?.length ? `검색어: ${job.searchTerms.join(', ')}` : '',
    job.freshness ? `정보 시점: ${job.freshness}` : '',
    job.bigTopic ? `큰 주제: ${job.bigTopic}` : '',
  ].filter(Boolean).join('\n');
  const cls = job.score >= 70 ? 'pass' : '';
  return `<span class="check-badge ${cls}" title="${escapeHtml(tip)}">${job.score}점</span>`;
}

function renderJobs() {
  const body = $('job-body');
  const jobs = state.jobs || [];
  if (!jobs.length) {
    body.innerHTML = '<tr><td colspan="12" class="empty">아직 찾아온 주제가 없습니다. 2번 칸에 큰 주제를 넣고 실행하세요.</td></tr>';
    return;
  }
  const current = state.runner?.currentJobId;
  body.innerHTML = jobs
    .map((job, index) => {
      const label = STATUS_LABEL[job.status] || job.status;
      const thumb = job.thumbnailPath
        ? `<a href="/thumbnails/${encodeURIComponent(job.thumbnailPath)}" target="_blank" rel="noopener">
             <img src="/thumbnails/${encodeURIComponent(job.thumbnailPath)}" alt="썸네일"></a>`
        : '<span class="hint">-</span>';
      const note = job.guidelineCheck
        ? `<span class="check-note" title="${escapeHtml(job.guidelineCheck)}">지침 확인</span>`
        : '';
      const links = [];
      if (job.editUrl) {
        // 네이버 임시저장 목록은 글쓰기 화면 안에서 열린다. 글 하나를 바로 여는 주소는 없다.
        links.push(`<a class="post-link" href="${escapeHtml(job.editUrl)}" target="_blank" rel="noopener">임시저장 목록</a>`);
      }
      if (job.status === 'done' && job.confirmed === false) {
        links.push('<span class="check-badge fail" title="저장 버튼은 눌렀지만 완료 표시를 확인하지 못했습니다. '
          + '네이버 임시저장 목록에서 직접 확인해 주세요.">저장 확인 필요</span>');
      }
      if (job.archiveDir) {
        const dir = encodeURIComponent(job.archiveDir);
        links.push(`<a class="post-link" href="/posts/${dir}/post.md" target="_blank" rel="noopener">마크다운</a>`);
        links.push(`<a class="post-link" href="/posts/${dir}/preview.html" target="_blank" rel="noopener">미리보기</a>`);
        if (job.sourceCount || job.searches) {
          links.push(`<a class="post-link" href="/posts/${dir}/research.json" target="_blank" rel="noopener">조사 자료</a>`);
        }
      }
      const warn = job.unverified
        ? `<span class="check-badge fail" title="조사에서 확인하지 못한 내용이 ${job.unverified}건 있습니다. 발행 전에 확인하세요.">미확인 ${job.unverified}</span>`
        : '';
      return `<tr class="${job.id === current ? 'active' : ''}">
        <td>${index + 1}</td>
        <td class="topic"${job.why ? ` title="${escapeHtml(job.why)}"` : ''}>${escapeHtml(job.topic)}</td>
        <td>${scoreCell(job)}</td>
        <td><span class="badge ${job.status}">${label}</span></td>
        <td class="msg"${job.detail ? ` title="${escapeHtml(job.detail)}"` : ''}>${job.title ? `<b>${escapeHtml(job.title)}</b>` : ''}${escapeHtml(job.message || '')}
          <div class="msg-links">${note} ${warn} ${links.join(' ')}</div></td>
        <td>${job.charCount ? job.charCount.toLocaleString() : '-'}</td>
        <td>${complianceCell(job)}</td>
        <td class="src-cell">${sourceCell(job)}</td>
        <td>${job.tableRows ? `${job.tableRows}행` : '-'}</td>
        <td class="model-cell">${escapeHtml(shortModel(job.model))}</td>
        <td class="thumb-cell">${thumb}</td>
        <td>
          <button class="btn ghost small" data-retry="${job.id}">재시도</button>
          <button class="btn ghost small danger" data-remove="${job.id}">삭제</button>
        </td>
      </tr>`;
    })
    .join('');
}

function renderRunner() {
  const runner = state.runner;
  if (!runner) return;
  const { total, done, failed, skipped = 0, pending } = runner.stats;

  // 진행률의 기준은 "지금 주문에서 몇 건을 임시저장했는가" 다.
  // 주문이 없으면 예전처럼 작업 목록 소진률을 보여준다.
  const finished = done + failed + skipped;
  const percent = runner.goal
    ? Math.round((runner.requestSaved / runner.goal) * 100)
    : (total ? Math.round((finished / total) * 100) : 0);
  $('progress-bar').style.width = `${Math.min(100, percent)}%`;

  // 돌고 있으면 지금 주문을, 아니면 대기열 전체를 보여준다.
  const open = runner.requests?.open || 0;
  let text;
  if (runner.bigTopic) {
    text = `"${runner.bigTopic}" ${runner.requestSaved}/${runner.goal}건`;
    if (open > 1) text += ` · 대기열 ${open - 1}건 더`;
  } else if (open) {
    text = `대기열 ${open}건 · 앞으로 쓸 글 ${runner.requests.remaining}편`;
  } else {
    text = `전체 ${total}`;
  }
  text += ` · 완료 ${done} · 실패 ${failed}`
    + `${skipped ? ` · 건너뜀 ${skipped}` : ''} · 대기 ${pending}`;
  if (runner.running) text += runner.paused ? ' · 일시정지' : ' · 실행 중';
  if (runner.discovering) text += ' · 새 주제를 찾는 중';
  if (runner.waitUntil) {
    const left = Math.max(0, Math.round((runner.waitUntil - Date.now()) / 1000));
    text += ` · 다음 글까지 ${left}초`;
  }
  $('run-stats').textContent = text;

  // 대기열에 주문이 있으면 대기 주제가 0건이어도 시작할 수 있다. 알아서 찾아오기 때문이다.
  const hasOrder = (runner.requests?.open || 0) > 0;
  $('btn-start').disabled = runner.running || (pending === 0 && !hasOrder);
  $('btn-pause').disabled = !runner.running;
  $('btn-pause').textContent = runner.paused ? '이어서 실행' : '일시정지';
  $('btn-stop').disabled = !runner.running;
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;

  // 큰 주제 칸은 화면이 새로 그려져도 건드리지 않는다. 치는 중일 수 있다.
  if (document.activeElement !== $('s-target-count')) {
    $('s-target-count').value = s.discover.targetCount;
  }
  $('s-batch-size').value = s.discover.batchSize;
  $('s-recency').value = s.discover.recencyDays;
  $('s-min-score').value = s.discover.minScore;
  $('s-discover-searches').value = s.discover.maxSearches;
  $('s-auto-refill').checked = Boolean(s.discover.autoRefill);
  renderOrders();
  renderDiscoverState();

  $('s-research').checked = Boolean(s.research.enabled);
  $('s-searches').value = s.research.maxSearches;
  $('s-show-sources').checked = Boolean(s.research.showSources);
  $('s-require-sources').checked = Boolean(s.research.requireSources);
  $('s-sources-heading').value = s.research.sourcesHeading || '';

  $('s-min-chars').value = s.post.minChars;
  $('s-sections').value = s.post.sectionCount;
  $('s-rank-count').value = s.post.rankTargetCount;
  $('s-repairs').value = s.quality.maxRepairs;
  $('s-enforce').checked = Boolean(s.quality.enforce);
  $('s-block').checked = Boolean(s.quality.blockOnFail);
  $('s-criteria').checked = Boolean(s.post.addCriteria);
  $('s-faq').checked = Boolean(s.post.addFaq);

  $('s-tone').value = s.post.tone;
  $('s-audience').value = s.post.audience;
  $('s-tags').checked = Boolean(s.post.appendTags);
  if (document.activeElement !== $('s-guideline')) {
    $('s-guideline').value = s.post.extraGuideline || '';
  }

  $('s-thumb-style').value = s.thumbnail.style;
  $('s-thumb-w').value = s.thumbnail.width;
  $('s-thumb-h').value = s.thumbnail.height;
  $('s-thumb-insert').checked = Boolean(s.thumbnail.insert);
  $('s-thumb-emoji').checked = Boolean(s.thumbnail.emoji);
  $('s-headless').checked = Boolean(s.run.headless);
  $('s-shot').checked = Boolean(s.run.screenshotOnError);

  $('s-image').checked = Boolean(s.image.enabled);
  $('s-image-mode').value = s.image.mode || 'full';
  $('s-image-poster').value = s.image.poster || 'bold';
  $('s-verify-text').checked = Boolean(s.image.verifyText);
  // 비어 있으면 자동. placeholder 가 그렇게 안내한다.
  $('s-image-model').value = s.image.model || '';
  $('s-image-style').value = s.image.style || 'flat';
  $('image-key-state').textContent = s.image.apiKeySet
    ? '저장된 키가 있습니다. 바꿀 때만 새로 입력하세요.'
    : 'aistudio.google.com 에서 무료로 발급됩니다';

  $('s-delay-min').value = s.run.delayMinSec;
  $('s-delay-max').value = s.run.delayMaxSec;
  $('s-retries').value = s.run.maxRetries;
  $('s-stop-after').value = s.run.stopAfterFailures;

  renderModels();
  renderModelPill();
  renderSession();
}

function appendLog(entry) {
  const box = $('console');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const line = document.createElement('div');
  line.className = 'line';
  const time = new Date(entry.ts).toLocaleTimeString('ko-KR', { hour12: false });
  line.innerHTML = `<span class="ts">${time}</span><span class="${entry.level}">${escapeHtml(entry.message)}</span>`;
  box.appendChild(line);
  while (box.childElementCount > 400) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* ---------- 이벤트 스트림 ---------- */

function connectStream() {
  const source = new EventSource('/api/stream');
  source.onmessage = (event) => {
    const { type, payload } = JSON.parse(event.data);
    if (type === 'log') appendLog(payload);
    else if (type === 'jobs') { state.jobs = payload; renderJobs(); }
    else if (type === 'job') {
      const index = state.jobs.findIndex((job) => job.id === payload.id);
      if (index >= 0) state.jobs[index] = payload; else state.jobs.push(payload);
      renderJobs();
    } else if (type === 'runner') { state.runner = payload; renderRunner(); renderJobs(); }
    else if (type === 'requests') {
      state.requests = payload;
      renderOrders();
      renderDiscoverState();
      renderRunner();
    }
    else if (type === 'examples') { state.examples = payload; renderExamples(); }
    else if (type === 'session') { state.session = payload; renderSession(); }
  };
  source.onerror = () => { /* EventSource 가 알아서 재접속한다. */ };
}

/* ---------- 초기화 ---------- */

async function refreshState() {
  const data = await api('/api/state');
  state = {
    ...state,
    settings: data.settings,
    session: data.session,
    jobs: data.jobs,
    runner: data.runner,
    models: data.models || state.models,
    rules: data.rules || state.rules,
    examples: data.examples || [],
    history: data.history || state.history,
    requests: data.requests || [],
  };
  renderRules();
  renderSettings();
  renderSession();
  renderExamples();
  renderJobs();
  renderRunner();
  return data;
}

async function boot() {
  const data = await refreshState();
  $('console').innerHTML = '';
  (data.logs || []).forEach(appendLog);
  connectStream();
  api('/api/health').then(renderPills).catch(() => {});
  setInterval(renderRunner, 1000);
}

/* ---------- 설정 저장 ---------- */

function collectSettings() {
  const select = $('s-model');
  const model = select.value === CUSTOM_MODEL ? $('s-model-custom').value.trim() : select.value;
  return {
    claude: { model },
    post: {
      tone: $('s-tone').value,
      minChars: Number($('s-min-chars').value),
      sectionCount: Number($('s-sections').value),
      audience: $('s-audience').value,
      extraGuideline: $('s-guideline').value,
      addCriteria: $('s-criteria').checked,
      addFaq: $('s-faq').checked,
      appendTags: $('s-tags').checked,
    },
    quality: {
      enforce: $('s-enforce').checked,
      maxRepairs: Number($('s-repairs').value),
      blockOnFail: $('s-block').checked,
    },
    thumbnail: {
      style: $('s-thumb-style').value,
      width: Number($('s-thumb-w').value),
      height: Number($('s-thumb-h').value),
      insert: $('s-thumb-insert').checked,
      emoji: $('s-thumb-emoji').checked,
    },
    image: {
      enabled: $('s-image').checked,
      mode: $('s-image-mode').value,
      poster: $('s-image-poster').value,
      verifyText: $('s-verify-text').checked,
      model: $('s-image-model').value.trim(),
      style: $('s-image-style').value,
    },
    run: {
      delayMinSec: Number($('s-delay-min').value),
      delayMaxSec: Number($('s-delay-max').value),
      maxRetries: Number($('s-retries').value),
      stopAfterFailures: Number($('s-stop-after').value),
      headless: $('s-headless').checked,
      screenshotOnError: $('s-shot').checked,
    },
  };
}

async function patchSettings(patch) {
  const data = await api('/api/settings', { method: 'POST', body: patch });
  state.settings = data.settings;
  renderModelPill();
  return data.settings;
}

/* ---------- 네이버 로그인 ---------- */

$('btn-login').onclick = async () => {
  const button = $('btn-login');
  button.disabled = true;
  try {
    // 서버는 창만 띄우고 바로 응답한다. 로그인이 끝나면 세션 이벤트가 날아온다.
    const data = await api('/api/login', { method: 'POST' });
    toast(data.message || '로그인 창을 띄웁니다.');
  } catch (error) {
    toast(error.message);
  } finally {
    // 창이 뜨는 데 시간이 걸린다. 곧바로 다시 누르면 창이 두 개 뜬다.
    setTimeout(() => { button.disabled = false; }, 5000);
  }
};

$('btn-verify').onclick = async () => {
  const button = $('btn-verify');
  button.disabled = true;
  toast('세션을 확인하는 중...');
  try {
    const data = await api('/api/login/verify', { method: 'POST' });
    state.session = data.session;
    renderSession();
    toast(data.session.loggedIn
      ? `로그인 상태입니다${data.session.blogId ? ` (${data.session.blogId})` : ''}`
      : '로그인이 풀렸습니다. 다시 로그인해 주세요.');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
};

$('btn-logout').onclick = async () => {
  if (!confirm('저장된 네이버 로그인 세션을 지울까요? 다음 실행 전에 다시 로그인해야 합니다.')) return;
  const data = await api('/api/logout', { method: 'POST' });
  state.session = data.session;
  state.settings = data.settings || state.settings;
  renderSession();
  toast('세션을 지웠습니다.');
};

$('btn-blog-id').onclick = async () => {
  const blogId = $('s-blog-id').value.trim();
  if (!blogId) return toast('블로그 아이디를 입력해 주세요.');
  try {
    const data = await api('/api/blog-id', { method: 'POST', body: { blogId } });
    state.settings = data.settings;
    state.session = data.session;
    renderSession();
    toast(`블로그 아이디를 ${data.settings.blogId} 로 저장했습니다.`);
  } catch (error) {
    toast(error.message);
  }
};

/* ---------- 큰 주제 (주제 발굴) ---------- */

const ORDER_LABEL = {
  waiting: '대기',
  running: '진행 중',
  done: '완료',
  failed: '중단',
  stopped: '취소',
};

function renderDiscoverState() {
  const open = (state.requests || []).filter((r) => r.status === 'waiting' || r.status === 'running');
  const remaining = open.reduce((sum, r) => sum + Math.max(0, r.targetCount - r.saved), 0);
  const written = state.history?.total || 0;
  $('discover-state').textContent = open.length
    ? `대기열 ${open.length}건 · 앞으로 쓸 글 ${remaining}편`
    : `큰 주제를 넣고 [확인]을 누르세요${written ? ` · 지금까지 ${written}건 발굴함` : ''}`;
}

/** 대기열. 넣은 순서대로 처리되고, 아직 시작 안 한 것은 취소할 수 있다. */
function renderOrders() {
  const list = $('order-list');
  const orders = state.requests || [];
  if (!orders.length) {
    list.innerHTML = '';
    list.classList.add('hidden');
    return;
  }
  list.classList.remove('hidden');
  list.innerHTML = orders.map((order, index) => {
    const label = ORDER_LABEL[order.status] || order.status;
    const percent = order.targetCount
      ? Math.min(100, Math.round((order.saved / order.targetCount) * 100)) : 0;
    const failed = order.failed ? ` · 실패 ${order.failed}` : '';
    return `<li class="order ${order.status}">
      <span class="order-no">${index + 1}</span>
      <span class="order-name">${escapeHtml(order.bigTopic)}</span>
      <span class="order-badge ${order.status}">${label}</span>
      <span class="order-progress"><span style="width:${percent}%"></span></span>
      <span class="order-count-text">${order.saved}/${order.targetCount}${failed}</span>
      <span class="order-msg" title="${escapeHtml(order.message || '')}">${escapeHtml(order.message || '')}</span>
      <button class="btn ghost small danger" data-order-remove="${order.id}">취소</button>
    </li>`;
  }).join('');
}

/** 발굴 세부 설정은 바뀌는 즉시 저장한다. */
async function saveDiscoverSettings() {
  await patchSettings({
    discover: {
      targetCount: Number($('s-target-count').value) || 1,
      batchSize: Number($('s-batch-size').value) || 5,
      recencyDays: Number($('s-recency').value) || 30,
      minScore: Number($('s-min-score').value) || 0,
      maxSearches: Number($('s-discover-searches').value) || 6,
      autoRefill: $('s-auto-refill').checked,
    },
  });
}
for (const id of ['s-target-count', 's-batch-size', 's-recency', 's-min-score', 's-discover-searches', 's-auto-refill']) {
  $(id).addEventListener('change', () => saveDiscoverSettings().catch((e) => toast(e.message)));
}

/**
 * 큰 주제 하나를 대기열에 넣는다. [확인] 과 여러 줄 붙여넣기가 이 함수를 같이 쓴다.
 *
 * 검색이 끝나기를 기다리지 않는다. 서버는 주문만 받아 두고 즉시 응답하고,
 * 실제 검색은 실행 루프가 차례가 됐을 때 돌린다.
 */
async function queueBigTopic(bigTopic, targetCount) {
  const data = await api('/api/requests', { method: 'POST', body: { bigTopic, targetCount } });
  state.requests = data.requests || [];
  return data;
}

/**
 * [확인] — 대기열에 넣고 바로 입력칸을 비운다.
 *
 * 응답을 기다리는 동안에도 다음 주제를 이어서 넣을 수 있도록 먼저 비운다.
 */
async function submitOrder() {
  const input = $('s-big-topic');
  const bigTopic = input.value.trim();
  if (!bigTopic) return toast('큰 주제를 입력해 주세요.');

  const targetCount = Number($('s-target-count').value) || 1;
  input.value = '';
  input.focus();

  try {
    const data = await queueBigTopic(bigTopic, targetCount);
    renderOrders();
    renderDiscoverState();
    await refreshState();
    toast(data.started
      ? `"${bigTopic}" ${targetCount}건을 대기열에 넣고 시작했습니다.`
      : `"${bigTopic}" 를 대기열에 넣었습니다. ${data.startMessage}`);
  } catch (error) {
    // 실패하면 친 내용을 돌려준다. 다시 타이핑하게 만들지 않는다.
    if (!input.value) input.value = bigTopic;
    toast(error.message);
  }
}

$('btn-order').onclick = submitOrder;
$('s-big-topic').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); submitOrder(); }
});

// 붙여넣을 수 있는 큰 주제 개수의 상한. 이보다 많으면 나눠서 붙여달라고 안내한다.
const MAX_PASTE_TOPICS = 100;

/**
 * 큰 주제 칸에 **여러 줄**을 한꺼번에 붙여넣으면, 한 줄씩 잘라 그 줄마다
 * 따로따로 대기열에 넣는다. (한 줄만 붙여넣을 때는 평소처럼 그 줄이 그대로
 * 입력칸에 들어간다 — 여기서 아무 것도 하지 않고 브라우저 기본 동작에 맡긴다)
 *
 * 엑셀 등에서 여러 칸을 복사해 오면 탭으로 나뉜 경우가 있어 첫 칸만 쓴다.
 */
$('s-big-topic').addEventListener('paste', (event) => {
  const raw = event.clipboardData?.getData('text') || '';
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.split('\t')[0].trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);

  if (lines.length <= 1) return;   // 한 줄이면 그냥 붙여넣게 둔다.
  event.preventDefault();

  const topics = lines.slice(0, MAX_PASTE_TOPICS);
  if (lines.length > MAX_PASTE_TOPICS) {
    toast(`한 번에 ${MAX_PASTE_TOPICS}개까지만 넣습니다. 나머지 ${lines.length - MAX_PASTE_TOPICS}개는 나눠서 다시 붙여넣어 주세요.`);
  }
  queueManyBigTopics(topics);
});

async function queueManyBigTopics(topics) {
  const targetCount = Number($('s-target-count').value) || 1;
  toast(`큰 주제 ${topics.length}개를 대기열에 넣는 중...`);

  let added = 0;
  const failed = [];
  for (const bigTopic of topics) {
    try {
      await queueBigTopic(bigTopic, targetCount);
      added += 1;
    } catch (error) {
      failed.push(`${bigTopic}: ${error.message}`);
    }
  }

  renderOrders();
  renderDiscoverState();
  await refreshState();

  if (!failed.length) {
    toast(`큰 주제 ${added}개를 대기열에 각각 추가했습니다. (각 ${targetCount}건씩)`);
  } else {
    toast(`${added}개 추가, ${failed.length}개 실패 — ${failed[0]}`
      + (failed.length > 1 ? ` 외 ${failed.length - 1}건` : ''));
  }
}

$('order-list').addEventListener('click', async (event) => {
  const id = event.target.dataset.orderRemove;
  if (!id) return;
  const order = (state.requests || []).find((r) => r.id === id);
  if (order?.status === 'running' && !confirm(`진행 중인 "${order.bigTopic}" 주문을 취소할까요?\n아직 쓰지 않은 주제는 건너뜀으로 정리됩니다.`)) return;
  const data = await api(`/api/requests/${id}`, { method: 'DELETE' });
  state.requests = data.requests || [];
  renderOrders();
  await refreshState();
});

$('btn-clear-orders').onclick = async () => {
  const data = await api('/api/requests/clear', { method: 'POST', body: { onlyFinished: true } });
  state.requests = data.requests || [];
  renderOrders();
  renderDiscoverState();
  toast('끝난 주문을 정리했습니다.');
};

/**
 * 대기열을 통째로 비운다. 하나씩 [취소] 를 누르지 않아도 되게.
 *
 * 되돌릴 수 없고 진행 중인 주문까지 멈추므로 몇 건이 지워지는지 보여주고 묻는다.
 */
$('btn-clear-all-orders').onclick = async () => {
  const orders = state.requests || [];
  if (!orders.length) return toast('대기열이 이미 비어 있습니다.');

  const running = orders.filter((order) => order.status === 'running').length;
  const ok = confirm(
    `대기열의 주문 ${orders.length}건을 모두 지울까요?\n`
    + (running ? `진행 중인 주문 ${running}건도 멈춥니다.\n` : '')
    + '아직 쓰지 않은 주제는 건너뜀으로 정리됩니다. (이미 저장된 글은 그대로입니다)',
  );
  if (!ok) return;

  const data = await api('/api/requests/clear', { method: 'POST', body: { onlyFinished: false } });
  state.requests = data.requests || [];
  renderOrders();
  renderDiscoverState();
  await refreshState();
  toast(`주문 ${data.removed || 0}건을 지웠습니다.`
    + (data.cleaned ? ` (대기 주제 ${data.cleaned}건 정리)` : ''));
};

function renderPicks() {
  const list = $('pick-list');
  const actions = $('pick-actions');
  if (!state.picks.length) {
    list.classList.add('hidden');
    actions.classList.add('hidden');
    return;
  }
  list.classList.remove('hidden');
  actions.classList.remove('hidden');
  list.innerHTML = state.picks.map((pick, index) => {
    const terms = pick.searchTerms?.length
      ? `<span class="pick-terms">검색어: ${escapeHtml(pick.searchTerms.join(', '))}</span>` : '';
    const sources = (pick.sources || [])
      .map((url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">근거</a>`)
      .join(' ');
    return `<li>
      <label class="pick-head">
        <input type="checkbox" data-pick="${index}" checked>
        <span class="pick-score">${pick.score}점</span>
        <span class="pick-topic">${escapeHtml(pick.topic)}</span>
      </label>
      <div class="pick-meta">
        <span class="pick-why">${escapeHtml(pick.why || '')}</span>
        ${terms}
        ${pick.freshness ? `<span class="pick-terms">${escapeHtml(pick.freshness)}</span>` : ''}
        ${sources}
      </div>
    </li>`;
  }).join('');
}

function selectedPicks() {
  return [...document.querySelectorAll('#pick-list input[data-pick]')]
    .filter((box) => box.checked)
    .map((box) => state.picks[Number(box.dataset.pick)])
    .filter(Boolean);
}

$('btn-discover').onclick = async () => {
  const button = $('btn-discover');
  const box = $('discover-result');
  const bigTopic = $('s-big-topic').value.trim();
  if (!bigTopic) return toast('먼저 큰 주제를 입력해 주세요.');

  button.disabled = true;
  state.picks = [];
  renderPicks();
  box.classList.remove('hidden', 'bad', 'good');
  box.textContent = `"${bigTopic}" 관련 최신 정보를 검색하는 중... (최대 7분)`;
  try {
    const data = await api('/api/discover/preview', { method: 'POST', body: { bigTopic } });
    state.settings = data.settings || state.settings;
    if (data.failed) {
      box.classList.add('bad');
      box.textContent = `실패: ${data.message}`;
      return;
    }
    if (!data.searches) {
      // 검색 없이 답만 온 경우다. 최신 정보로 고른 주제가 아니다.
      box.classList.add('bad');
      box.textContent =
        '웹 검색이 실제로 실행되지 않았습니다 (검색 0회).\n'
        + '아래 주제는 최신 정보가 아니라 모델이 아는 내용으로 고른 것일 수 있습니다.\n'
        + 'claude CLI 를 최신 버전으로 올리고 구독 플랜에서 웹 검색을 쓸 수 있는지 확인해 보세요.';
    } else {
      box.classList.add('good');
      box.textContent =
        `검색 ${data.searches}회 — 후보 ${data.received}건 중 ${data.picks.length}건을 골랐습니다.\n`
        + (data.landscape ? `\n지금 상황: ${data.landscape}` : '');
    }
    state.picks = data.picks || [];
    renderPicks();
    if (!state.picks.length) {
      box.textContent += '\n\n쓸 만한 주제를 찾지 못했습니다. '
        + '큰 주제를 조금 넓히거나 관심도 점수 하한을 낮춰 보세요.';
    }
  } catch (error) {
    box.classList.add('bad');
    box.textContent = `실패: ${error.message}`;
  } finally {
    button.disabled = false;
  }
};

$('btn-pick-add').onclick = async () => {
  const picks = selectedPicks();
  if (!picks.length) return toast('추가할 주제를 골라 주세요.');
  const data = await api('/api/discover/add', {
    method: 'POST',
    body: { bigTopic: $('s-big-topic').value.trim(), picks },
  });
  state.picks = [];
  renderPicks();
  $('discover-result').classList.add('hidden');
  await refreshState();
  toast(`${data.added}건 추가${data.skipped ? ` (중복 ${data.skipped}건 제외)` : ''}`);
};

const setAllPicks = (checked) => {
  for (const box of document.querySelectorAll('#pick-list input[data-pick]')) box.checked = checked;
};
$('btn-pick-all').onclick = () => setAllPicks(true);
$('btn-pick-none').onclick = () => setAllPicks(false);

$('btn-manual-toggle').onclick = () => {
  const box = $('manual-box');
  box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) $('topics').focus();
};

$('btn-clear-history').onclick = async () => {
  if (!confirm('지금까지 발굴한 주제 기록을 지울까요?\n지우면 예전에 쓴 주제를 다시 고를 수 있게 됩니다.')) return;
  const data = await api('/api/discover/history/clear', { method: 'POST' });
  state.history = data.history;
  renderDiscoverState();
  toast('발굴 기록을 지웠습니다.');
};

/* ---------- 주제 직접 추가 ---------- */

let previewTimer = null;
$('topics').addEventListener('input', () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const data = await api('/api/topics/preview', { method: 'POST', body: { raw: $('topics').value } });
    $('paste-count').textContent = `${data.count}개 인식`;
  }, 250);
});

$('btn-add').onclick = async () => {
  const raw = $('topics').value;
  if (!raw.trim()) return toast('먼저 주제를 붙여넣어 주세요.');
  const data = await api('/api/topics', { method: 'POST', body: { raw } });
  state.jobs = data.jobs;
  renderJobs();
  await refreshState();
  $('topics').value = '';
  $('paste-count').textContent = '0개 인식';
  toast(`${data.added}건 추가${data.skipped ? ` (중복 ${data.skipped}건 제외)` : ''}`);
};

$('btn-clear-text').onclick = () => {
  $('topics').value = '';
  $('paste-count').textContent = '0개 인식';
};

/* 추가 지침 — 저장 버튼을 누르지 않아도 자동으로 저장한다. */
let guidelineTimer = null;
function saveGuideline(immediate = false) {
  clearTimeout(guidelineTimer);
  const run = async () => {
    $('guideline-state').textContent = '저장 중...';
    try {
      await patchSettings({ post: { extraGuideline: $('s-guideline').value } });
      const length = $('s-guideline').value.trim().length;
      $('guideline-state').textContent = length
        ? `저장됨 · ${length}자 (다음 글부터 적용)`
        : '필수 품질 규칙은 자동으로 들어갑니다';
    } catch (error) {
      $('guideline-state').textContent = `저장 실패: ${error.message}`;
    }
  };
  if (immediate) run();
  else guidelineTimer = setTimeout(run, 700);
}
$('s-guideline').addEventListener('input', () => saveGuideline());
$('s-guideline').addEventListener('blur', () => saveGuideline(true));

/* 품질 규칙 칸의 입력은 바로 저장한다. */
for (const id of ['s-min-chars', 's-sections', 's-rank-count', 's-repairs', 's-enforce', 's-block', 's-criteria', 's-faq']) {
  $(id).addEventListener('change', async () => {
    await patchSettings({
      post: {
        minChars: Number($('s-min-chars').value),
        sectionCount: Number($('s-sections').value),
        rankTargetCount: Number($('s-rank-count').value),
        addCriteria: $('s-criteria').checked,
        addFaq: $('s-faq').checked,
      },
      quality: {
        enforce: $('s-enforce').checked,
        maxRepairs: Number($('s-repairs').value),
        blockOnFail: $('s-block').checked,
      },
    });
    toast('품질 규칙 설정을 저장했습니다.');
  });
}

/* ---------- 자료 조사 ---------- */

for (const id of ['s-research', 's-searches', 's-show-sources', 's-require-sources', 's-sources-heading']) {
  $(id).addEventListener('change', async () => {
    await patchSettings({
      research: {
        enabled: $('s-research').checked,
        maxSearches: Number($('s-searches').value),
        showSources: $('s-show-sources').checked,
        requireSources: $('s-require-sources').checked,
        sourcesHeading: $('s-sources-heading').value.trim() || '참고 자료',
      },
    });
    toast($('s-research').checked
      ? '자료 조사 설정을 저장했습니다.'
      : '자료 조사를 껐습니다. 앞으로는 검색 없이 글을 씁니다.');
  });
}

$('btn-test-research').onclick = async () => {
  const box = $('research-test-result');
  const button = $('btn-test-research');
  const topic = (state.jobs || [])[0]?.topic || '';
  button.disabled = true;
  box.classList.remove('hidden', 'bad', 'good');
  box.textContent = '검색하는 중... (최대 7분)';
  try {
    const data = await api('/api/research/test', { method: 'POST', body: { topic } });
    if (data.failed) {
      box.classList.add('bad');
      box.textContent = `실패: ${data.message}`;
    } else if (!data.searches) {
      // 검색을 한 번도 안 돌린 채로 답이 온 경우. 그대로 믿으면 안 된다.
      box.classList.add('bad');
      box.textContent =
        '웹 검색이 실제로 실행되지 않았습니다 (검색 0회).\n'
        + '모아온 내용이 검색 결과가 아니라 모델이 아는 내용일 수 있습니다.\n'
        + 'claude CLI 를 최신 버전으로 올리고 구독 플랜에서 웹 검색을 쓸 수 있는지 확인해 보세요.';
    } else {
      box.classList.add('good');
      box.textContent =
        `성공 — 검색 ${data.searches}회, 사실 ${data.facts}건, 출처 ${data.sources.length}건`
        + `${data.unverified ? `, 미확인 ${data.unverified}건` : ''}\n`
        + (data.freshness ? `최신성: ${data.freshness}\n` : '')
        + '\n찾아온 출처:\n'
        + data.sources.map((s) => `- ${s.title}\n  ${s.url}`).join('\n');
    }
  } catch (error) {
    box.classList.add('bad');
    box.textContent = `실패: ${error.message}`;
  } finally {
    button.disabled = false;
  }
};

/* ---------- 설정 ---------- */

$('btn-toggle-settings').onclick = () => {
  const panel = $('settings');
  panel.classList.toggle('hidden');
  $('btn-toggle-settings').textContent = panel.classList.contains('hidden') ? '펼치기' : '접기';
};

$('s-model').addEventListener('change', async () => {
  const custom = $('s-model').value === CUSTOM_MODEL;
  $('model-custom-wrap').classList.toggle('hidden', !custom);
  updateModelNote();
  if (custom) {
    $('s-model-custom').focus();
    return;
  }
  await patchSettings({ claude: { model: $('s-model').value } });
  toast(`모델을 ${shortModel($('s-model').value) || '기본값'}(으)로 바꿨습니다.`);
});

$('s-model-custom').addEventListener('change', async () => {
  await patchSettings({ claude: { model: $('s-model-custom').value.trim() } });
  toast('모델을 저장했습니다.');
});

$('btn-save-settings').onclick = async () => {
  await patchSettings(collectSettings());
  toast('설정을 저장했습니다.');
};

$('btn-test-ai').onclick = async () => {
  const box = $('ai-test-result');
  const button = $('btn-test-ai');
  button.disabled = true;
  box.classList.remove('hidden', 'bad', 'good');
  box.textContent = '테스트 중... (최대 2분)';
  try {
    const data = await api('/api/ai/test', { method: 'POST' });
    if (data.failed) {
      box.classList.add('bad');
      box.textContent = `실패: ${data.message}` + (data.dumpFile ? `\n원문: ${data.dumpFile}` : '');
    } else {
      box.classList.add('good');
      box.textContent =
        `성공 — 모델 ${shortModel(data.model)} (${data.model})\n` +
        `응답: ${data.answer} · ${Math.round((data.durationMs || 0) / 100) / 10}초`;
    }
  } catch (error) {
    box.classList.add('bad');
    box.textContent = `실패: ${error.message}`;
  } finally {
    button.disabled = false;
  }
};

/* ---------- 썸네일 배경 그림 ---------- */

for (const id of ['s-image', 's-image-mode', 's-image-poster', 's-verify-text', 's-image-model', 's-image-style']) {
  $(id).addEventListener('change', async () => {
    await patchSettings({
      image: {
        enabled: $('s-image').checked,
        mode: $('s-image-mode').value,
        poster: $('s-image-poster').value,
        verifyText: $('s-verify-text').checked,
        model: $('s-image-model').value.trim(),
        style: $('s-image-style').value,
      },
    });
    toast($('s-image').checked
      ? '이미지 생성을 켰습니다. 키가 없으면 HTML 썸네일로 만듭니다.'
      : '이미지 생성을 껐습니다.');
  });
}

// 키는 입력하는 즉시 저장하지 않는다. 테스트 버튼으로 확인하면서 같이 저장한다.
$('s-image-key').addEventListener('change', async () => {
  const apiKey = $('s-image-key').value.trim();
  if (!apiKey) return;
  await patchSettings({ image: { apiKey } });
  $('s-image-key').value = '';
  $('image-key-state').textContent = '저장된 키가 있습니다. 바꿀 때만 새로 입력하세요.';
  toast('이미지 API 키를 저장했습니다.');
});

/** 자동으로 고른 후보 목록을 보기 좋게. 고른 것에 화살표를 붙인다. */
function candidateLines(candidates, picked) {
  if (!candidates?.length) return '';
  const lines = candidates.map((model) => {
    const mark = model.id === picked ? '→ ' : '   ';
    const price = model.knownPrice ? `$${model.usd}` : `$${model.usd} (추정)`;
    return `${mark}${model.id}  ${price}  ${model.tier}`;
  });
  return `\n\n쓸 수 있는 모델 (싼 순서):\n${lines.join('\n')}`;
}

async function runImageTest({ refresh = false } = {}) {
  const box = $('image-test-result');
  const preview = $('image-test-preview');
  const button = $('btn-test-image');
  const refreshButton = $('btn-refresh-models');
  button.disabled = true;
  refreshButton.disabled = true;
  preview.classList.add('hidden');
  box.classList.remove('hidden', 'bad', 'good');
  box.textContent = refresh
    ? '모델 목록을 다시 받고 그림 한 장을 뽑는 중... (최대 2분)'
    : '그림 한 장을 뽑는 중... (최대 2분)';
  try {
    const data = await api('/api/image/test', {
      method: 'POST',
      body: {
        apiKey: $('s-image-key').value.trim(),
        model: $('s-image-model').value.trim(),
        style: $('s-image-style').value,
        mode: $('s-image-mode').value,
        poster: $('s-image-poster').value,
        refresh,
      },
    });
    state.settings = data.settings || state.settings;
    $('s-image-key').value = '';
    renderSettings();
    if (data.failed) {
      box.classList.add('bad');
      box.textContent = `실패: ${data.message}${candidateLines(data.candidates, '')}`;
    } else {
      box.classList.add('good');
      const price = data.usd ? ` · 장당 약 $${data.usd}` : '';
      const full = data.mode === 'full';
      const how = full
        ? (data.auto ? '자동으로 한글을 잘 그리는 모델을 골랐습니다.' : '설정에 적은 모델을 썼습니다.')
        : (data.auto ? '자동으로 가장 싼 모델을 골랐습니다.' : '설정에 적은 모델을 썼습니다.');
      const textNote = data.textOk === false
        ? `\n글자 확인: 깨짐 — ${data.textReason}\n(실제 실행에서는 한 번 더 그려보고, 그래도 깨지면 HTML 썸네일로 물러섭니다)`
        : (data.textOk === true ? '\n글자 확인: 통과' : '');
      box.textContent =
        `성공 — ${data.model}${data.tier ? ` (${data.tier})` : ''}${price} · ${data.kb}KB\n`
        + `${how}\n`
        + (full
          ? '아래 그림에 한글이 제대로 박혔는지 직접 확인해 주세요.'
          : '이 그림 위에 한글 문구가 얹힙니다. 그림 자체에는 글자가 없어야 정상입니다.')
        + textNote
        + candidateLines(data.candidates, data.model);
      preview.src = data.dataUri;
      preview.classList.remove('hidden');
    }
  } catch (error) {
    box.classList.add('bad');
    box.textContent = `실패: ${error.message}`;
  } finally {
    button.disabled = false;
    refreshButton.disabled = false;
  }
}

$('btn-test-image').onclick = () => runImageTest();
$('btn-refresh-models').onclick = () => runImageTest({ refresh: true });

$('btn-preview-thumb').onclick = () => {
  const params = new URLSearchParams({
    headline: '국가기술자격증 TOP 5',
    subline: '취업률과 활용성을 기준으로 정리했습니다',
    badge: '자격증',
    accent: '#16324F',
    style: $('s-thumb-style').value,
  });
  const frame = $('thumb-preview');
  frame.src = `/api/thumbnail/preview?${params}`;
  frame.classList.remove('hidden');
};

/* ---------- 참고 예시 ---------- */

$('example-file').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  for (const file of files) {
    try {
      const content = await file.text();
      await api('/api/examples', { method: 'POST', body: { name: file.name, content } });
    } catch (error) {
      toast(`${file.name}: ${error.message}`);
    }
  }
  await refreshState();
  toast(`예시 ${files.length}개를 올렸습니다.`);
});

$('btn-example-paste').onclick = () => {
  $('example-paste-box').classList.toggle('hidden');
  if (!$('example-paste-box').classList.contains('hidden')) $('example-text').focus();
};

$('btn-example-cancel').onclick = () => {
  $('example-paste-box').classList.add('hidden');
  $('example-text').value = '';
  $('example-name').value = '';
};

$('btn-example-save').onclick = async () => {
  const content = $('example-text').value;
  if (!content.trim()) return toast('예시 내용을 붙여넣어 주세요.');
  await api('/api/examples', {
    method: 'POST',
    body: { name: $('example-name').value || '붙여넣은 예시', content },
  });
  $('example-text').value = '';
  $('example-name').value = '';
  $('example-paste-box').classList.add('hidden');
  await refreshState();
  toast('예시를 저장했습니다.');
};

$('example-list').addEventListener('click', async (event) => {
  const removeId = event.target.dataset.exRemove;
  if (!removeId) return;
  await api(`/api/examples/${removeId}`, { method: 'DELETE' });
  await refreshState();
});

$('example-list').addEventListener('change', async (event) => {
  const toggleId = event.target.dataset.toggle;
  if (!toggleId) return;
  await api(`/api/examples/${toggleId}/toggle`, {
    method: 'POST',
    body: { enabled: event.target.checked },
  });
  await refreshState();
});

/* ---------- 실행 ---------- */

$('btn-start').onclick = async () => {
  try {
    await api('/api/run/start', { method: 'POST' });
    toast('실행을 시작했습니다.');
  } catch (error) { toast(error.message); }
};
$('btn-pause').onclick = () => api('/api/run/pause', { method: 'POST' }).catch((e) => toast(e.message));
$('btn-stop').onclick = () => api('/api/run/stop', { method: 'POST' }).catch((e) => toast(e.message));

$('btn-clear-done').onclick = async () => {
  const data = await api('/api/jobs/clear', { method: 'POST', body: { onlyFinished: true } });
  state.jobs = data.jobs;
  renderJobs();
  await refreshState();
};

$('btn-clear-all').onclick = async () => {
  if (!confirm('작업 목록을 모두 비울까요?')) return;
  const data = await api('/api/jobs/clear', { method: 'POST', body: { onlyFinished: false } });
  state.jobs = data.jobs;
  renderJobs();
  await refreshState();
};

$('btn-clear-log').onclick = () => { $('console').innerHTML = ''; };

$('job-body').addEventListener('click', async (event) => {
  const retry = event.target.dataset.retry;
  const remove = event.target.dataset.remove;
  if (retry) { await api(`/api/jobs/${retry}/retry`, { method: 'POST' }); await refreshState(); }
  if (remove) { await api(`/api/jobs/${remove}`, { method: 'DELETE' }); await refreshState(); }
});

boot().catch((error) => toast(error.message));
