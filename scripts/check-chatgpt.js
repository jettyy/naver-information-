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
import http from 'node:http';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { withExecutable, ensureBrowsers } from '../src/lib/playwright.js';
import {
  typePrompt, findImageUrl, downloadImage, flattenPrompt, buildChatPrompt,
} from '../src/chatgpt/image.js';

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

/** 한 가지 색으로 채운 PNG. naturalWidth 검사를 위해 크기를 정확히 만든다. */
function solidPng(width, height, [r, g, b]) {
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
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BIG_PNG = solidPng(320, 180, [20, 120, 220]);     // "생성된 그림"
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
<script>
  window.__sends = 0;
  window.__sent = [];
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
  if (req.url.startsWith('/backend-api/files/')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(BIG_PNG);
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
  server.close();
}

console.log(failures ? `\n실패 ${failures}건\n` : '\n모두 통과했습니다.\n');
process.exit(failures ? 1 : 0);
