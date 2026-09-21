/**
 * ChatGPT 썸네일 자동화 점검 (npm run check:chatgpt).
 *
 * `npm run check` 는 브라우저를 안 띄우니, 입력창에 글을 넣고 답변에서 그림을
 * 찾아 내려받는 부분은 하나도 검사하지 못한다. 그래서 **가짜 ChatGPT 화면**을
 * 진짜 크로미움에 띄워 그 경로를 돌려 본다. chatgpt.com 에 접속하지 않고,
 * 로그인도 필요 없다.
 *
 * 여기서 잡으려는 것:
 *   - 여러 줄짜리 프롬프트를 넣다가 **중간에 전송**되지 않는가
 *     (엔터가 곧 전송이라, 줄바꿈을 그대로 넣으면 반쪽짜리 요청이 나간다)
 *   - 답변 안의 **아바타·아이콘을 그림으로 착각**하지 않는가
 *   - http 주소와 blob: 주소 **둘 다** 실제로 내려받아지는가
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { withExecutable, ensureBrowsers } from '../src/lib/playwright.js';
import {
  typePrompt, findImageUrl, downloadImage, flattenPrompt, buildChatPrompt,
  collectImages, describeImages,
} from '../src/chatgpt/image.js';
import { dismissDialog } from '../src/chatgpt/browser.js';
import { isRateLimitDialog } from '../src/chatgpt/selectors.js';

/* ------------------------------------------------------------------ */
/* 가짜 PNG                                                            */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * PNG 한 장을 만든다.
 *
 * `noise` 를 주면 픽셀마다 값을 흔들어 **압축이 잘 안 되게** 한다.
 * 단색으로 만들면 수백 바이트로 줄어들어서, 받아온 그림이 원본인지
 * 화면을 찍은 것인지 크기로 구별할 수가 없다.
 */
function solidPng(width, height, [r, g, b], noise = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;            // bit depth
  ihdr[9] = 2;            // color type: truecolor
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;         // filter: none
    for (let x = 0; x < width; x += 1) {
      const jitter = noise ? ((x * 2654435761 + y * 40503) % noise) : 0;
      raw[row + 1 + x * 3] = (r + jitter) & 0xff;
      raw[row + 2 + x * 3] = (g + jitter) & 0xff;
      raw[row + 3 + x * 3] = (b + jitter) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BIG_PNG = solidPng(320, 180, [20, 120, 220], 97);  // "생성된 그림" (압축이 잘 안 되게)
const ICON_PNG = solidPng(32, 32, [200, 200, 200]);     // 아이콘 (작다)

/* ------------------------------------------------------------------ */
/* 가짜 ChatGPT 화면                                                   */
/* ------------------------------------------------------------------ */

/**
 * 진짜 화면의 핵심만 흉내 낸다.
 *   - contenteditable 입력창 (#prompt-textarea)
 *   - 엔터를 누르면 **그 자리에서 전송**된다 (진짜와 같은 함정)
 *   - 보내면 답변 말풍선이 생기고, 그 안에 아이콘 + 그림이 들어간다
 */
function fakePage(imagePath) {
  return `<!doctype html><meta charset="utf-8">
<title>가짜 ChatGPT</title>
<style>body{font-family:sans-serif;margin:24px}
#prompt-textarea{border:1px solid #ccc;min-height:60px;padding:8px}</style>
<div id="thread"></div>
<form onsubmit="return false">
  <div id="prompt-textarea" contenteditable="true"></div>
  <button data-testid="send-button" type="button" onclick="send()">보내기</button>
</form>
<!-- 진짜 화면의 "요청이 너무 많습니다" 알림창. 뜨면 입력창을 덮는다. -->
<div id="limit" role="dialog" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4)">
  <div style="background:#fff;margin:20vh auto;padding:24px;width:420px">
    <h2>요청이 너무 많습니다</h2>
    <p>요청을 너무 빠르게 보내고 있습니다. 데이터를 보호하기 위해 대화에 대한
       액세스가 일시적으로 제한되었습니다. 몇 분 후 다시 시도해 주세요.</p>
    <button type="button" onclick="document.getElementById('limit').style.display='none'">알겠습니다</button>
  </div>
</div>
<script>
  window.__sends = 0;
  window.__sent = [];
  window.__showLimit = () => { document.getElementById('limit').style.display = 'block'; };
  function send() {
    const box = document.getElementById('prompt-textarea');
    const text = box.innerText.trim();
    if (!text) return;
    window.__sends += 1;
    window.__sent.push(text);
    box.innerHTML = '';

    const turn = document.createElement('div');
    turn.setAttribute('data-message-author-role', 'assistant');
    // 아바타/아이콘도 <img> 다. 이걸 그림으로 착각하면 안 된다.
    turn.innerHTML =
      '<img alt="avatar" src="https://cdn.example.com/avatar.png">' +
      '<img alt="icon" src="https://files.oaiusercontent.com/icon-16.png">' +
      '<img alt="made" src="${imagePath}">';
    document.getElementById('thread').appendChild(turn);
  }
  // 진짜 화면처럼 엔터가 곧 전송이다.
  document.getElementById('prompt-textarea').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
  });
</script>`;
}

/* ------------------------------------------------------------------ */

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  통과  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  실패  ${name}\n        ${error.message}`);
  }
}

// 그림을 진짜 http 로 내려받아 보려면 서버가 하나 필요하다.
let pageHtml = '';
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml);
    return;
  }
  if (req.url.startsWith('/backend-api/files/') || req.url.startsWith('/brand-new-host/')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(BIG_PNG);
    return;
  }
  // 로그인이 풀렸을 때처럼 그림 주소로 HTML 이 오는 경우.
  if (req.url.startsWith('/login-wall.png')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>로그인이 필요합니다</h1>');
    return;
  }
  if (req.url.startsWith('/icon')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(ICON_PNG);
    return;
  }
  if (req.url.startsWith('/not-an-image')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>그림이 아닙니다</h1>');
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

console.log('\n[0] 말 만들기 (브라우저 없이)');

await test('여러 줄 프롬프트를 한 줄로 만든다', () => {
  // 엔터가 곧 전송이라, 줄바꿈이 남아 있으면 반쪽짜리 요청이 나간다.
  assert.equal(flattenPrompt('첫 줄\n\n  둘째 줄  \n셋째'), '첫 줄 둘째 줄 셋째');
  assert.equal(flattenPrompt(''), '');
  assert.equal(flattenPrompt(null), '');
});

await test('"요청이 너무 많습니다" 를 알아본다', () => {
  // 이건 그냥 닫고 바로 다시 보내면 안 된다. 기다렸다 보내야 한다.
  assert.ok(isRateLimitDialog('요청이 너무 많습니다 요청을 너무 빠르게 보내고 있습니다'));
  assert.ok(isRateLimitDialog('몇 분 후 다시 시도해 주세요'));
  assert.ok(isRateLimitDialog('Too many requests'));
  // 다른 알림창까지 한도로 보면 멀쩡한 흐름이 2분씩 늦어진다.
  assert.ok(!isRateLimitDialog('새 기능을 확인해 보세요'));
  assert.ok(!isRateLimitDialog(''));
});

await test('비율과 "그림만 그려라" 지시가 들어간다', () => {
  const prompt = buildChatPrompt('a flat illustration of a desk', '16:9');
  assert.ok(prompt.includes('16:9'), '비율이 안 들어갔습니다');
  assert.ok(prompt.includes('a flat illustration of a desk'), '원래 프롬프트가 빠졌습니다');
  assert.ok(prompt.includes('그림만'), '그림만 만들라는 지시가 없습니다');
  assert.ok(!prompt.includes('\n'), '줄바꿈이 남아 있습니다');
  // 이상한 값을 주면 기본값으로 돌아가야 한다.
  assert.ok(buildChatPrompt('x', 'ㅁㄴㅇ').includes('16:9'));
});

console.log('\n[1] 진짜 크로미움으로 가짜 ChatGPT 몰아보기');

await ensureBrowsers();
const browser = await chromium.launch(withExecutable({ headless: true }));
const context = await browser.newContext({ locale: 'ko-KR' });
const page = await context.newPage();

try {
  pageHtml = fakePage(`${base}/backend-api/files/made.png`);
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  const longPrompt = buildChatPrompt(
    'a flat vector illustration of a bright desk\nwith a notebook\nand a coffee cup',
    '16:9',
  );

  await test('여러 줄이어도 중간에 전송되지 않는다', async () => {
    await typePrompt(page, longPrompt);
    await page.waitForTimeout(300);
    const sends = await page.evaluate(() => window.__sends);
    assert.equal(sends, 1, `${sends}번 전송됐습니다. 한 번이어야 합니다.`);
    const sent = await page.evaluate(() => window.__sent[0]);
    assert.equal(sent, longPrompt, '보낸 글이 잘렸습니다');
  });

  await test('"요청이 너무 많습니다" 창을 눌러 닫는다', async () => {
    await page.evaluate(() => window.__showLimit());
    await page.waitForTimeout(300);

    const result = await dismissDialog(page);
    assert.equal(result.closed, true, '창을 못 닫았습니다');
    assert.equal(result.rateLimited, true, '요청 한도 알림인 줄 몰랐습니다');
    assert.ok(result.text.includes('요청이 너무 많습니다'), `엉뚱한 글을 읽었습니다: ${result.text}`);
    // 정말 닫혔는지 화면으로 확인한다.
    assert.equal(await page.isHidden('#limit'), true, '창이 아직 떠 있습니다');
  });

  await test('알림창이 없으면 아무 것도 누르지 않는다', async () => {
    // 창이 없는데 엉뚱한 버튼을 누르면(예: 보내기) 요청이 한 번 더 나간다.
    const sendsBefore = await page.evaluate(() => window.__sends);
    const result = await dismissDialog(page);
    assert.equal(result.closed, false);
    assert.equal(result.rateLimited, false);
    assert.equal(await page.evaluate(() => window.__sends), sendsBefore, '뭔가를 눌렀습니다');
  });

  await test('알림창을 닫은 뒤 다시 보낼 수 있다', async () => {
    // 한도 창이 뜨면 요청이 아예 안 들어간 것이라, 닫고 **다시 보내야** 한다.
    await page.evaluate(() => window.__showLimit());
    await dismissDialog(page);
    const sendsBefore = await page.evaluate(() => window.__sends);
    await typePrompt(page, '다시 보내는 요청입니다');
    assert.equal(await page.evaluate(() => window.__sends), sendsBefore + 1, '다시 못 보냈습니다');
  });

  await test('아바타와 아이콘을 그림으로 착각하지 않는다', async () => {
    // 그림이 다 뜬 뒤에 본다. 실제 흐름도 뜰 때까지 되풀이해서 본다.
    await page.waitForFunction(() => {
      const img = document.querySelector('img[alt="made"]');
      return img && img.complete && img.naturalWidth > 0;
    }, null, { timeout: 10000 });
    const url = await findImageUrl(page);
    assert.ok(url, '그림을 하나도 못 찾았습니다');
    assert.ok(!url.includes('avatar'), `아바타를 집었습니다: ${url}`);
    assert.ok(!url.includes('icon'), `아이콘을 집었습니다: ${url}`);
    assert.ok(url.endsWith('/made.png'), `엉뚱한 그림을 집었습니다: ${url}`);
  });

  await test('http 주소에서 그림을 내려받는다', async () => {
    const dataUri = await downloadImage(page, `${base}/backend-api/files/made.png`);
    assert.ok(dataUri.startsWith('data:image/png;base64,'), `이상한 값: ${dataUri.slice(0, 40)}`);
    const bytes = Buffer.from(dataUri.split(',')[1], 'base64');
    assert.equal(bytes.length, BIG_PNG.length, '받은 그림이 원본과 다릅니다');
  });

  await test('blob: 주소에서도 그림을 읽는다', async () => {
    // ChatGPT 는 그림을 blob: 으로 걸어 둘 때가 있다. 서버에서 못 받는 주소다.
    const blobUrl = await page.evaluate(async (src) => {
      const blob = await (await fetch(src)).blob();
      return URL.createObjectURL(blob);
    }, `${base}/backend-api/files/made.png`);
    assert.ok(blobUrl.startsWith('blob:'), '테스트 준비가 잘못됐습니다');

    const dataUri = await downloadImage(page, blobUrl);
    assert.ok(dataUri.startsWith('data:image/png;base64,'), `이상한 값: ${dataUri.slice(0, 40)}`);
  });

  await test('그림이 아닌 응답은 그림으로 받지 않는다', async () => {
    // 로그인이 풀리면 그림 주소로 HTML 로그인 페이지가 온다.
    // 그걸 그대로 저장하면 깨진 썸네일이 네이버에 올라간다.
    await assert.rejects(
      () => downloadImage(page, `${base}/not-an-image`),
      /그림이 아닌 응답/,
    );
  });

  await test('아직 안 불러온 그림도 주소로 알아본다', async () => {
    // 그림이 막 뜨는 중이면 크기를 알 수 없다. 그래도 아이콘을 집으면 안 된다.
    await page.evaluate(() => {
      document.getElementById('thread').innerHTML =
        '<div data-message-author-role="assistant">'
        + '<img src="https://files.oaiusercontent.com/icon-16.png">'
        + '<img src="https://files.oaiusercontent.com/aaaa-made.png">'
        + '</div>';
    });
    const url = await findImageUrl(page);
    assert.ok(url.endsWith('aaaa-made.png'), `엉뚱한 그림을 집었습니다: ${url}`);
  });

  await test('처음 보는 주소로 와도 크기만 맞으면 찾아낸다', async () => {
    /*
     * 이것 때문에 실제로 실패했다. 주소 목록에만 기대면, ChatGPT 가 주소를
     * 바꾸는 순간 그림이 화면에 멀쩡히 떠 있는데도 못 찾고 HTML 썸네일이 올라간다.
     */
    await page.evaluate((src) => {
      document.getElementById('thread').innerHTML =
        '<div data-message-author-role="assistant">'
        + '<img alt="avatar" src="https://cdn.example.com/avatar.png" width="32" height="32">'
        + `<img alt="made" src="${src}">`
        + '</div>';
    }, `${base}/brand-new-host/thumb.png`);
    await page.waitForFunction(() => {
      const img = document.querySelector('img[alt="made"]');
      return img && img.complete && img.naturalWidth > 0;
    }, null, { timeout: 10000 });

    const url = await findImageUrl(page);
    assert.ok(url.includes('brand-new-host'), `못 찾았거나 엉뚱한 것을 집었습니다: ${url}`);
  });

  await test('내려받기가 막히면 화면에 그려진 그림을 찍어서라도 쓴다', async () => {
    /*
     * 그림 주소로 HTML 이 와도(로그인 만료 등) 화면에는 그림이 떠 있다.
     * 거기서 포기하면 HTML 썸네일이 올라간다. 찍어서라도 쓰는 편이 낫다.
     */
    await page.evaluate((src) => {
      document.getElementById('thread').innerHTML =
        '<div data-message-author-role="assistant">'
        + `<img alt="made" src="${src}" width="400" height="220">`
        + '</div>';
    }, `${base}/brand-new-host/shot.png`);
    await page.waitForTimeout(500);

    /*
     * 내려받으면 HTML 이 오는 주소를 **srcset** 에 건다. 그러면 실제로 보이는
     * 주소(currentSrc)와 src 속성이 서로 달라진다. src 속성만 보고 화면에서
     * 그림을 집는 코드는 여기서 못 찾는다.
     */
    await page.evaluate(([bad, good]) => {
      const img = document.querySelector('img[alt="made"]');
      img.setAttribute('src', good);
      img.setAttribute('srcset', `${bad} 1x`);
    }, [`${base}/login-wall.png`, `${base}/brand-new-host/shot.png`]);
    await page.waitForTimeout(800);

    const shown = await page.evaluate(() => document.querySelector('img[alt="made"]').currentSrc);
    assert.ok(shown.includes('login-wall'), `테스트 준비가 잘못됐습니다: ${shown}`);

    const dataUri = await downloadImage(page, shown);
    assert.ok(dataUri.startsWith('data:image/png;base64,'), `이상한 값: ${dataUri.slice(0, 40)}`);
  });

  await test('못 찾았을 때 화면에 뭐가 있었는지 남긴다', async () => {
    // 이 한 줄이 없으면 왜 실패했는지 알 방법이 없다.
    const images = await collectImages(page);
    const text = describeImages(images);
    assert.ok(text.length > 0);
    assert.ok(/x\d+/.test(text) || text.includes('하나도 없습니다'), `쓸모없는 설명: ${text}`);
    assert.equal(describeImages([]), '화면에 <img> 가 하나도 없습니다.');
  });

  await test('답변에 그림이 없으면 빈 값을 준다', async () => {
    await page.evaluate(() => {
      document.getElementById('thread').innerHTML =
        '<div data-message-author-role="assistant">글로만 답했습니다.</div>';
    });
    assert.equal(await findImageUrl(page), '');
  });
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

/* ------------------------------------------------------------------ */
/* [2] 처음부터 끝까지                                                  */
/* ------------------------------------------------------------------ */

/*
 * 조각마다 통과해도 이어 붙였을 때 안 될 수 있다. 실제로 그랬다.
 * ChatGPT 에서 그림은 잘 만들어졌는데 그걸 가져오지 못하고, 조용히
 * HTML 썸네일이 대신 올라갔다.
 *
 * 그래서 가짜 ChatGPT 를 진짜 주소인 척 세워 두고
 * **renderThumbnail 까지 통째로** 돌려서, 나온 썸네일이 정말로
 * ChatGPT 에서 받아온 그림인지 확인한다.
 */
console.log('\n[2] 썸네일이 실제로 ChatGPT 그림으로 저장되는가');

process.env.CHATGPT_URL = `${base}/`;
const { saveSettings, DEFAULT_SETTINGS } = await import('../src/lib/settings.js');
const { renderThumbnail } = await import('../src/content/thumbnail.js');
const { closeChatGptContext } = await import('../src/chatgpt/browser.js');
const { closeRenderBrowser } = await import('../src/lib/playwright.js');

const SPEC = {
  headline: '국가기술자격증 TOP 5',
  posterLines: ['취업에 바로 쓰는', '국가기술자격증 TOP 5'],
  ribbon: '2026 최신',
  subline: '취업률과 활용성으로 골랐습니다',
  badge: '자격증',
  keywords: ['전기', '용접', '정보처리'],
  scene: 'a bright technical college workshop',
  style: 'minimal',
  accent: '#16324F',
};

const before = saveSettings({});
try {
  pageHtml = fakePage(`${base}/brand-new-host/thumb.png`);
  saveSettings({
    image: { enabled: true, provider: 'chatgpt', mode: 'full', chatgpt: { waitMs: 60000 } },
    run: { headless: true },
  });

  await test('ChatGPT 그림이 그대로 썸네일 파일이 된다', async () => {
    const result = await renderThumbnail({ title: '점검용 글', thumbnail: SPEC }, { jobId: 'check' });
    // HTML 썸네일로 물러섰으면 여기서 걸린다. 그게 이 검사의 전부다.
    assert.equal(result.generated, true, 'HTML 썸네일로 물러섰습니다');
    assert.equal(result.mode, 'full', `mode 가 ${result.mode} 입니다`);

    // 받아온 그림이 우리가 내려준 **바로 그 PNG** 여야 한다.
    // (화면을 찍은 것이면 바이트가 다르다)
    const saved = fs.readFileSync(result.filePath);
    assert.ok(saved.equals(BIG_PNG), `ChatGPT 에서 받은 그림이 아닙니다 (${saved.length}바이트)`);
    fs.rmSync(result.filePath, { force: true });
  });

  await test('그림을 못 찾으면 HTML 썸네일로 물러선다', async () => {
    // 그림 없이 글로만 답하는 화면. 여기서 글이 막히면 안 된다.
    pageHtml = fakePage('').replace(/<img[^>]*>/g, '');
    saveSettings({ image: { chatgpt: { waitMs: 30000 } } });

    const result = await renderThumbnail({ title: '점검용 글2', thumbnail: SPEC }, { jobId: 'check2' });
    assert.equal(result.generated, false, 'HTML 썸네일로 안 물러섰습니다');
    assert.ok(fs.existsSync(result.filePath), '썸네일이 아예 안 만들어졌습니다');
    fs.rmSync(result.filePath, { force: true });
  });
} finally {
  saveSettings({
    image: {
      enabled: before.image.enabled,
      provider: before.image.provider,
      mode: before.image.mode,
      chatgpt: { waitMs: DEFAULT_SETTINGS.image.chatgpt.waitMs },
    },
    run: { headless: before.run.headless },
  });
  await closeChatGptContext().catch(() => {});
  await closeRenderBrowser().catch(() => {});
}

server.close();
console.log(failures ? `\n실패 ${failures}건\n` : '\n모두 통과했습니다.\n');
process.exit(failures ? 1 : 0);
