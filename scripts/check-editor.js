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
import { focusBodyEnd, pasteHtml, pasteThreshold } from '../src/naver/editor.js';

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
function test(name, fn) {
  try {
    fn();
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

console.log('\n[3] 붙여넣기 성공 문턱');

test('넣으려던 분량의 60% 는 들어가야 성공으로 본다', () => {
  const text = '가'.repeat(1000);
  const threshold = pasteThreshold(text);
  if (threshold < 600) throw new Error(`1,000자 글의 문턱이 ${threshold}자뿐입니다`);
});

await browser.close();
console.log(failures ? `\n실패 ${failures}건\n` : '\n모두 통과했습니다.\n');
process.exit(failures ? 1 : 0);
