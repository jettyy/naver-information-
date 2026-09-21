/**
 * 에디터 자동화 점검 (npm run check:editor).
 *
 * `npm run check` 는 브라우저를 안 띄우는 대신, 에디터에 실제로 글을 넣는
 * 부분은 하나도 검사하지 못한다. 그래서 **가짜 스마트에디터**를 띄워
 * 붙여넣기 경로를 진짜 브라우저로 돌려 본다. 네이버에 접속하지는 않는다.
 *
 * 이 파일이 생긴 이유:
 *   커서를 잡는 코드가 `.se-main-container` 안에 `[contenteditable="true"]` 가
 *   있다고 **가정**하고, 못 찾으면 실패로 던졌다. 실제 에디터 구조가 그 가정과
 *   달라서 글은 멀쩡히 써 놓고 한 건도 저장하지 못했다.
 *   구조를 바꿔 가며 돌려 보면 그런 가정이 바로 드러난다.
 */
import { chromium } from 'playwright';
import { chromiumOverride, ensureBrowsers } from '../src/lib/playwright.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  focusBodyEnd, pasteHtml, pasteThreshold, bodyImageCount, insertThumbnailAtTop,
} from '../src/naver/editor.js';

/**
 * 붙여넣기를 받아 문단으로 쌓는 최소 에디터.
 * 컨테이너 이름과 contenteditable 여부를 바꿔 가며 만든다.
 */
function fakeEditor(rootClass, editableAttr) {
  return `<!doctype html><meta charset="utf-8">
<div class="se-documentTitle"><div class="se-text-paragraph" ${editableAttr}>제목 칸</div></div>
<div class="${rootClass}"><div class="se-component se-text">
  <div class="se-text-paragraph" ${editableAttr}>첫 문단</div>
</div></div>
<script>
  const root = document.querySelector('.${rootClass}');
  document.addEventListener('paste', (event) => {
    const html = event.clipboardData.getData('text/html');
    if (!html) return;
    event.preventDefault();
    const box = document.createElement('div');
    box.className = 'se-component se-text';
    box.innerHTML = html;
    for (const p of box.querySelectorAll('p')) p.classList.add('se-text-paragraph');
    root.appendChild(box);
  }, true);
</script>`;
}

const CASES = [
  ['정상 구조 (.se-main-container + contenteditable)', 'se-main-container', 'contenteditable="true"'],
  ['컨테이너 이름이 다름 (.se-content)', 'se-content', 'contenteditable="true"'],
  ['contenteditable 속성이 없음', 'se-main-container', ''],
];

const BODY = '<p style="color:#000">붙여넣은 본문입니다. 이 글자가 에디터에 들어가야 합니다.</p>';

let failures = 0;
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  통과  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  실패  ${name}\n        ${error.message}`);
  }
}

function test(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      throw new Error('async 검사는 testAsync 를 쓰세요');
    }
    console.log(`  통과  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  실패  ${name}\n        ${error.message}`);
  }
}

const override = chromiumOverride();
if (!override) await ensureBrowsers();
const browser = await chromium.launch(override ? { headless: true, executablePath: override } : { headless: true });

console.log('\n[1] 에디터 구조가 달라도 본문이 들어간다');

for (const [label, rootClass, attr] of CASES) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.setContent(fakeEditor(rootClass, attr));

  let thrown = '';
  try {
    await pasteHtml(page, page.mainFrame(), BODY);
  } catch (error) {
    thrown = error.message.split('\n')[0];
  }
  const landed = await page.evaluate(
    (cls) => (document.querySelector(`.${cls}`)?.innerText || '').includes('붙여넣은 본문입니다'),
    rootClass,
  );

  test(label, () => {
    // 구조를 못 알아봤다고 던지면 안 된다. 그 순간 그 글은 통째로 버려진다.
    if (thrown) throw new Error(`예외를 던졌습니다: ${thrown}`);
    if (!landed) throw new Error('본문이 에디터에 들어가지 않았습니다');
  });
  await context.close();
}

console.log('\n[2] 커서 잡기는 실패해도 던지지 않는다');

{
  const context = await browser.newContext();
  const page = await context.newPage();
  // 에디터라고 볼 만한 것이 아무 것도 없는 화면.
  await page.setContent('<!doctype html><meta charset="utf-8"><p>여기엔 에디터가 없습니다</p>');

  let thrown = '';
  let result = null;
  try {
    result = await focusBodyEnd(page, page.mainFrame());
  } catch (error) {
    thrown = error.message.split('\n')[0];
  }
  test('편집 영역이 아예 없어도 false 만 돌려준다', () => {
    if (thrown) throw new Error(`예외를 던졌습니다: ${thrown}`);
    if (result !== false) throw new Error(`false 가 아니라 ${result} 를 돌려줬습니다`);
  });
  await context.close();
}

/* ------------------------------------------------------------------ */
/* [3] 썸네일이 살아남는가                                              */
/* ------------------------------------------------------------------ */

/*
 * 실제로 있었던 사고: 썸네일을 도입부 뒤에 넣었더니, 그 뒤에 이어지는
 * 본문 붙여넣기와 **Ctrl+A 전체 선택 정렬**에 휩쓸려 지워진 채로 저장됐다.
 * 글자 수만 재는 검사로는 그림이 사라진 것을 전혀 못 잡았다.
 *
 * 그래서 썸네일을 맨 마지막에, 글 맨 위에 넣도록 순서를 바꿨다.
 * 여기서는 그 두 가지를 진짜 브라우저로 확인한다.
 *   - 넣으면 글 **맨 위**에 오는가
 *   - 전체 선택 뒤 붙여넣기에 그림이 지워지는가 (= 예전 순서가 왜 위험했는가)
 */
console.log('\n[3] 썸네일이 살아남는가');

/** 사진 버튼을 누르면 파일을 받아 이미지 컴포넌트를 커서 자리에 넣는 가짜 에디터. */
function fakeEditorWithImage() {
  return `<!doctype html><meta charset="utf-8">
<button class="se-image-toolbar-button" onclick="document.getElementById('pick').click()">사진</button>
<input id="pick" type="file" style="display:none">
<div class="se-main-container">
  <div class="se-component se-text">
    <div class="se-text-paragraph" contenteditable="true">첫 문단입니다</div>
  </div>
  <div class="se-component se-text">
    <div class="se-text-paragraph" contenteditable="true">둘째 문단입니다</div>
  </div>
</div>
<script>
  const root = document.querySelector('.se-main-container');

  // 커서가 있는 문단 **앞**에 그림을 넣는다. 진짜 에디터와 같은 자리다.
  document.getElementById('pick').addEventListener('change', () => {
    const box = document.createElement('div');
    box.className = 'se-component se-image';
    // 진짜 이미지 컴포넌트에는 글자가 없다. 그래서 지워져도 글자 수가 그대로다.
    box.style.cssText = 'height:40px;background:#ddd';
    const caret = document.getSelection();
    const here = caret && caret.anchorNode
      ? (caret.anchorNode.nodeType === 1 ? caret.anchorNode : caret.anchorNode.parentElement)
      : null;
    const comp = here && here.closest ? here.closest('.se-component') : null;
    if (comp) root.insertBefore(box, comp);
    else root.appendChild(box);
  });

  // 붙여넣기: 선택된 것이 있으면 **지우고** 그 자리에 넣는다 (진짜 에디터와 같다).
  document.addEventListener('paste', (event) => {
    const html = event.clipboardData.getData('text/html');
    if (!html) return;
    event.preventDefault();
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) {
      // 전체 선택 상태에서 붙여넣으면 선택된 그림까지 날아간다.
      for (const node of [...root.children]) node.remove();
    }
    const box = document.createElement('div');
    box.className = 'se-component se-text';
    box.innerHTML = html;
    for (const p of box.querySelectorAll('p')) p.classList.add('se-text-paragraph');
    root.appendChild(box);
  }, true);
</script>`;
}

{
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.setContent(fakeEditorWithImage());

  // 올릴 파일 하나를 만들어 둔다. 내용은 중요하지 않다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naver-thumb-'));
  const file = path.join(dir, 'thumb.png');
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));

  let inserted = null;
  let thrown = '';
  try {
    inserted = await insertThumbnailAtTop(page, page.mainFrame(), file, 'check');
  } catch (error) {
    thrown = error.message.split('\n')[0];
  }

  const firstIsImage = await page.evaluate(() =>
    document.querySelector('.se-main-container')?.firstElementChild?.classList.contains('se-image'));

  test('썸네일이 글 맨 위에 들어간다', () => {
    if (thrown) throw new Error(`예외를 던졌습니다: ${thrown}`);
    if (inserted !== true) throw new Error(`들어갔다고 하지 않았습니다 (${inserted})`);
    // 네이버는 글에서 처음 나오는 그림을 대표 이미지로 쓴다. 맨 위여야 한다.
    if (!firstIsImage) throw new Error('그림이 맨 위가 아닙니다');
  });

  await testAsync('그림 개수를 셀 수 있다', async () => {
    const count = await bodyImageCount(page.mainFrame());
    if (count !== 1) throw new Error(`${count}개로 셌습니다`);
  });

  /*
   * 왜 순서를 바꿨는가 — 저장 직전의 왼쪽 정렬은 Ctrl+A 로 본문을 통째로
   * 선택한다. 사용자가 보내온 화면에서도 본문이 파랗게 선택된 채였고 그때
   * 그림이 지워져 있었다. 그래서 썸네일을 그 **뒤에** 넣도록 바꿨다.
   *
   * 선택 상태에서 에디터가 정확히 어떻게 동작하는지는 가짜 화면으로 흉내 낼 수
   * 없다. 대신 **그림이 사라지면 우리가 알아챌 수 있는지**를 확인한다.
   * 예전에는 글자 수만 재서, 그림이 통째로 없어져도 전혀 몰랐다.
   */
  const textBefore = await page.evaluate(
    () => (document.querySelector('.se-main-container').innerText || '').length,
  );
  await page.evaluate(() => document.querySelector('.se-component.se-image').remove());
  const goneCount = await bodyImageCount(page.mainFrame());
  const textAfter = await page.evaluate(
    () => (document.querySelector('.se-main-container').innerText || '').length,
  );

  await testAsync('그림이 지워지면 알아챈다 (글자 수로는 못 잡는다)', async () => {
    if (goneCount !== 0) throw new Error(`아직 ${goneCount}개로 셉니다`);
    // 이것이 예전에 못 잡았던 이유다. 그림에는 글자가 없어서 글자 수가 그대로다.
    if (textAfter !== textBefore) {
      throw new Error(`글자 수가 ${textBefore} → ${textAfter} 로 바뀌었습니다. 검사 전제가 틀렸습니다.`);
    }
  });

  fs.rmSync(dir, { recursive: true, force: true });
  await context.close();
}

console.log('\n[4] 붙여넣기 성공 문턱');

test('넣으려던 분량의 60% 는 들어가야 성공으로 본다', () => {
  const text = '가'.repeat(1000);
  const threshold = pasteThreshold(text);
  if (threshold < 600) throw new Error(`1,000자 글의 문턱이 ${threshold}자뿐입니다`);
});

await browser.close();
console.log(failures ? `\n실패 ${failures}건\n` : '\n모두 통과했습니다.\n');
process.exit(failures ? 1 : 0);
