/**
 * 자체 점검 스크립트 (npm run check).
 *
 * AI 호출도, 브라우저도 없이 글 처리 파이프라인만 돌려본다.
 *   - 품질 검사기가 통과할 글을 통과시키고, 어긋난 글을 정확히 잡아내는지
 *   - 네이버에 붙여넣을 HTML 이 제대로 나오는지 (색 상속, 표, 붙여넣기 조각)
 *   - 마크다운 표가 제대로 나오는지
 *   - 주제 발굴과 자동 실행 루프의 판단이 맞는지
 *
 * 코드를 고친 뒤 여기부터 돌려보면 주제 100개를 태우기 전에 문제가 드러난다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkCompliance, countChars, buildRuleBlock } from '../src/content/quality.js';
import {
  buildIntroHtml, buildBodyHtml, buildBodyPlan, buildTableChunks,
  buildTableHtml, htmlToPlainText, buildPreviewHtml, stripUrls,
} from '../src/content/naver.js';
import { buildMarkdown } from '../src/content/markdown.js';
import { normalize, fixedTitleBlock } from '../src/content/generator.js';
import { DEFAULT_SETTINGS, saveSettings, getSettings, publicSettings } from '../src/lib/settings.js';
import { detectShape, compactRanking } from '../src/content/ranking.js';
import {
  buildImagePrompt, buildPosterPrompt, pickAspectRatio,
  looksLikeImageModel, rankImageModels, pickVisionModel, priceOf,
} from '../src/content/imagegen.js';
import { renderTemplate } from '../src/content/templates/index.js';
import { buildResearchBlock, isUsableUrl } from '../src/content/research.js';
import {
  buildDiscoverPrompt, normalizePick, screenPicks, buildFallbackTopics, buildBigTopicPrompt,
  buildFallbackBigTopics,
} from '../src/content/discover.js';
import { isBrokenOutput, writeConsole, consoleAlive, log } from '../src/lib/events.js';
import { looksAuthExpired, AUTH_HINT, runClaude, WRITE_ANYWAY_BLOCK } from '../src/ai/claude.js';
import { topicKey } from '../src/lib/history.js';
import { planNextStep, discoverCapFor } from '../src/queue/runner.js';
import {
  REQUEST_STATUS, addRequest, nextRequest, finishRequest, updateRequest,
  requestStats, clearRequests,
} from '../src/lib/requests.js';
import {
  addTopics, nextPending, cancelPendingJobs, listJobs, clearJobs,
} from '../src/lib/store.js';
import { normalizeBlogId, normalizeTag, parseTopics } from '../src/lib/util.js';
import { pasteThreshold } from '../src/naver/editor.js';

const settings = structuredClone(DEFAULT_SETTINGS);

/**
 * 먼저 모든 모듈을 한 번씩 불러 본다.
 *
 * 아래 검사들은 일부 모듈만 import 하기 때문에, 손대지 않은 파일에
 * 오타나 문법 오류가 있어도 "모두 통과" 가 뜰 수 있다. 실제로 그런 적이 있다.
 * (server.js 는 부르면 서버가 떠버리므로 뺀다)
 */
async function loadEveryModule() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = path.join(here, '..', 'src');
  const files = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && entry.name !== 'server.js') files.push(full);
    }
  };
  walk(srcDir);

  const broken = [];
  for (const file of files.sort()) {
    try {
      await import(pathToFileURL(file).href);
    } catch (error) {
      broken.push(`${path.relative(srcDir, file)}: ${error.message.split('\n')[0]}`);
    }
  }
  return { count: files.length, broken };
}

/** 규칙을 모두 지킨 글. 분량은 문단을 늘려 채운다. */
function buildSamplePost() {
  const long = (seed) => [
    `${seed}에 대해 알아두면 실제로 도움이 되는 내용을 정리했습니다.`,
    '준비 기간과 비용은 개인의 상황에 따라 달라지므로 범위로만 이해하시는 편이 좋습니다.',
    '실제로 준비해 본 사람들의 이야기를 모아 보면 공통적으로 언급되는 지점이 있습니다.',
    '무턱대고 시작하기보다 본인의 목표와 일정에 맞는지 먼저 따져 보시기 바랍니다.',
  ].join(' ');

  const subsection = (heading, seed) => ({
    heading,
    paragraphs: [long(seed), long(`${seed} 추가 설명`)],
    list: heading === '실제 활용 분야'
      ? ['제조와 건설 현장에서 꾸준히 수요가 있습니다.', '공공기관 채용에서도 가점 요소로 쓰입니다.']
      : [],
  });

  const item = (rank, name) => ({
    heading: `${rank}위. ${name}`,
    isItem: true,
    paragraphs: [long(name)],
    list: [],
    quote: '',
    subsections: [
      subsection('상세 설명', name),
      subsection('자격 요건과 난이도', name),
      subsection('실제 활용 분야', name),
      subsection('장점과 단점', name),
      subsection('준비 팁', name),
    ],
  });

  return {
    topic: '2026년 취업률 높은 국가기술자격증 TOP 3',
    shape: 'items',
    title: '2026년 취업률 높은 국가기술자격증 TOP 3 정리',
    summary: '취업률과 활용성을 기준으로 자격증 세 가지를 정리했습니다.',
    guideline: '',
    guidelineCheck: '',
    tags: ['자격증', '취업준비', '국가기술자격'],
    thumbnail: {
      headline: '국가기술자격증 TOP 3', subline: '취업률 기준으로 정리했습니다',
      badge: '자격증', emoji: '', style: 'minimal', accent: '#16324F',
    },
    intro: [
      '자격증을 하나 따려고 마음먹었는데 무엇부터 봐야 할지 막막하신 분이 많습니다.',
      long('자격증 선택'),
    ],
    criteria: {
      heading: '추천 자격증을 고른 세 가지 기준',
      paragraphs: [long('선정 기준'), long('기준을 정한 이유')],
      items: [
        '취업률: 최근 채용 공고에서 얼마나 자주 요구되는지를 보았습니다.',
        '활용성: 특정 업종에만 쓰이는지, 여러 산업에서 통용되는지를 따졌습니다.',
        '난이도: 비전공자가 현실적으로 도전할 수 있는 수준인지 확인했습니다.',
      ],
    },
    table: {
      heading: '한눈에 보는 비교표',
      headers: ['구분', '자격증', '핵심 활용 분야', '난이도'],
      rows: [
        ['1', '전기기사', '전력 설비와 시공 관리', '높음'],
        ['2', '산업안전기사', '안전 관리자 선임', '보통'],
        ['3', '정보처리기사', '소프트웨어 개발과 공공 입찰', '보통'],
      ],
      note: '이 표는 공식 순위가 아니라 일반적으로 알려진 정보를 정리한 참고 자료이며, 최신 정보는 직접 확인하시기 바랍니다.',
    },
    sections: [item(1, '전기기사'), item(2, '산업안전기사'), item(3, '정보처리기사')],
    faq: [
      { question: '비전공자도 응시할 수 있습니까?', answer: long('응시 자격') },
      { question: '준비 기간은 얼마나 걸립니까?', answer: long('준비 기간') },
    ],
    outro: [long('마무리 요약'), '오늘 정리한 기준을 참고해 본인에게 맞는 자격증부터 차근차근 준비해 보시기 바랍니다.'],
    model: 'claude-sonnet-5',
    costUsd: 0,
    compliance: null,
    repairs: 0,
  };
}

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

/** test 와 같지만 기다려 준다. 안 기다리면 무조건 통과로 찍힌다. */
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  통과  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  실패  ${name}\n        ${error.message}`);
  }
}

console.log('\n[0] 모듈 불러오기');

const modules = await loadEveryModule();
test(`src 아래 ${modules.count}개 모듈이 모두 열린다`, () => {
  assert.equal(modules.broken.length, 0, `\n        ${modules.broken.join('\n        ')}`);
});

console.log('\n[1] 품질 검사기');

test('규칙을 지킨 글은 모든 항목을 통과한다', () => {
  const result = checkCompliance(buildSamplePost(), settings);
  assert.equal(result.ok, true, `미통과: ${result.issues.map((i) => `${i.label}(${i.detail})`).join(', ')}`);
  assert.ok(result.charCount >= settings.post.minChars, `분량 ${result.charCount}자`);
});

test('분량이 모자라면 length 규칙이 걸린다', () => {
  const post = buildSamplePost();
  post.sections = post.sections.slice(0, 1);
  post.sections[0].subsections = post.sections[0].subsections.slice(0, 3);
  post.criteria.paragraphs = ['짧습니다.'];
  post.faq = [];
  post.intro = ['짧은 도입입니다.'];
  post.outro = ['짧은 마무리입니다. 그래도 두 문장은 씁니다.'];
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'length'), '분량 미달을 못 잡았습니다');
});

test('개조식("~함") 문장을 잡아낸다', () => {
  const post = buildSamplePost();
  post.sections[0].paragraphs = ['전기기사는 전력 설비를 다루는 자격증임. 수요가 꾸준함.'];
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'ending'), '개조식을 못 잡았습니다');
});

test('해요체만 쓰면 종결어미 규칙이 걸린다', () => {
  const post = buildSamplePost();
  const rewrite = (list) => list.map(() => '이런 부분은 꼭 확인해 보세요. 생각보다 중요해요. 놓치면 손해예요.');
  post.intro = rewrite(post.intro);
  post.outro = rewrite(post.outro);
  post.criteria.paragraphs = rewrite(post.criteria.paragraphs);
  for (const section of post.sections) {
    section.paragraphs = rewrite(section.paragraphs);
    for (const sub of section.subsections) sub.paragraphs = rewrite(sub.paragraphs);
  }
  post.faq = post.faq.map((item) => ({ ...item, answer: '이렇게 하면 돼요. 어렵지 않아요.' }));
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'ending'), '해요체를 못 잡았습니다');
});

test('표가 없으면 table 규칙이 걸린다', () => {
  const post = buildSamplePost();
  post.table = null;
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'table'), '표 누락을 못 잡았습니다');
});

test('인사말로 시작하면 opening 규칙이 걸린다', () => {
  const post = buildSamplePost();
  post.intro[0] = '안녕하세요. 이번 포스팅에서는 자격증에 대해 알아보겠습니다.';
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'opening'), '인사말을 못 잡았습니다');
});

test('특수문자와 이모지를 잡아낸다', () => {
  const post = buildSamplePost();
  post.sections[0].heading = '1위. 전기기사 ★ 강력 추천';
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'symbols'), '특수문자를 못 잡았습니다');

  const emojiPost = buildSamplePost();
  emojiPost.intro[0] = '자격증을 고르기가 막막하신가요 🙂 함께 정리해 보겠습니다.';
  assert.ok(
    checkCompliance(emojiPost, settings).issues.some((issue) => issue.id === 'symbols'),
    '이모지를 못 잡았습니다',
  );
});

test('선정 기준이 비면 criteria 규칙이 걸린다', () => {
  const post = buildSamplePost();
  post.criteria = null;
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'criteria'), '선정 기준 누락을 못 잡았습니다');
});

test('항목 섹션의 세부 소제목이 부족하면 detail 규칙이 걸린다', () => {
  const post = buildSamplePost();
  post.sections[1].subsections = post.sections[1].subsections.slice(0, 1);
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'detail'), '얕은 항목을 못 잡았습니다');
});

test('불렛 포인트가 없으면 bullets 규칙이 걸린다', () => {
  const post = buildSamplePost();
  for (const section of post.sections) {
    section.list = [];
    for (const sub of section.subsections) sub.list = [];
  }
  const result = checkCompliance(post, settings);
  assert.ok(result.issues.some((issue) => issue.id === 'bullets'), '목록 누락을 못 잡았습니다');
});

test('규칙 지시문에 모든 규칙이 들어간다', () => {
  const block = buildRuleBlock(settings, 'items');
  for (const label of ['분량', '종결어미', '소제목 구조', '선정 기준', '비교 표', '불렛 포인트', '항목별 상세', '태그']) {
    assert.ok(block.includes(label), `"${label}" 규칙이 프롬프트에 없습니다`);
  }
});

console.log('\n[2] 네이버 붙여넣기 HTML');

const bodyOptions = { sourcesHeading: '참고 자료', appendTags: true };

test('모든 문단과 셀에 글자색이 박혀 있다', () => {
  // 색을 비워두면 에디터가 바로 앞 블록의 색을 물려받는다.
  // 표 아래 회색 안내문 뒤부터 본문 전체가 회색으로 나오던 문제다.
  const html = buildIntroHtml(buildSamplePost()) + buildBodyHtml(buildSamplePost(), bodyOptions);
  const paragraphs = html.match(/<p [^>]*>/g) || [];
  assert.ok(paragraphs.length > 10, `문단이 ${paragraphs.length}개뿐입니다`);
  const colourless = paragraphs.filter((tag) => !/color:/.test(tag));
  assert.equal(colourless.length, 0, `색이 없는 문단 ${colourless.length}개: ${colourless[0]}`);
  for (const cell of html.match(/<t[dh] [^>]*>/g) || []) {
    assert.ok(/color:/.test(cell), `색이 없는 셀: ${cell}`);
  }
});

test('소제목이 본문 문단보다 크고 굵게 들어간다', () => {
  // 네이버 에디터는 h2/h3 를 자기 스타일로 갈아끼운다. 그래서 문단으로 직접 그린다.
  const html = buildBodyHtml(buildSamplePost(), bodyOptions);
  assert.ok(!/<h[1-6][ >]/.test(html), '제목 태그가 들어갔습니다');
  assert.ok(html.includes('font-size:19px; font-weight:700'), '큰 소제목 서식이 없습니다');
  assert.ok(html.includes('border-left:3px solid #03c75a'), '세부 소제목 서식이 없습니다');
});

test('본문이 순서대로 조립된다', () => {
  const html = buildBodyHtml(buildSamplePost(), bodyOptions);
  const at = (text) => {
    const index = html.indexOf(text);
    assert.notEqual(index, -1, `"${text}" 가 본문에 없습니다`);
    return index;
  };
  assert.ok(at('추천 자격증을 고른 세 가지 기준') < at('한눈에 보는 비교표'), '선정 기준이 표 뒤에 있습니다');
  assert.ok(at('한눈에 보는 비교표') < at('1위. 전기기사'), '표가 본문 섹션 뒤에 있습니다');
  assert.ok(at('1위. 전기기사') < at('자주 묻는 질문'), 'FAQ 가 본문 앞에 있습니다');
  assert.ok(at('자주 묻는 질문') < at('#자격증'), '태그 줄이 맨 끝이 아닙니다');
});

test('표는 붙여넣기 조각으로 따로 떨어진다', () => {
  // 100행짜리 표를 다른 본문과 묶어 한 번에 붙이면 에디터가 표를 통째로 흘린다.
  const plan = buildBodyPlan(buildSamplePost(), bodyOptions);
  const tableSteps = plan.filter((step) => step.table);
  assert.equal(tableSteps.length, 1, `표 조각이 ${tableSteps.length}개입니다`);
  assert.equal(tableSteps[0].table.rows.length, 3, '조각이 원본 표를 안 들고 있습니다');
  assert.ok(!/<table/.test(plan.filter((step) => !step.table).map((step) => step.html).join('')),
    '글 조각 안에 표가 섞였습니다');
  for (const piece of ['추천 자격증을 고른 세 가지 기준', '1위. 전기기사', '자주 묻는 질문', '#자격증']) {
    assert.ok(plan.some((step) => step.html.includes(piece)), `"${piece}" 조각이 사라졌습니다`);
  }
});

test('큰 표는 머리글을 붙여 조각으로 나뉜다', () => {
  const table = {
    heading: '전국 대학교 순위',
    headers: ['순위', '학교', '지역'],
    rows: Array.from({ length: 100 }, (_, i) => [`${i + 1}`, `학교${i + 1}`, '서울']),
    note: '참고 자료입니다.',
  };
  const chunks = buildTableChunks(table, 20);
  assert.equal(chunks.length, 5, `조각이 ${chunks.length}개입니다`);
  for (const chunk of chunks) assert.ok(chunk.includes('<th'), '조각에 머리글이 없습니다');
  // 소제목은 첫 조각에만, 안내문은 마지막 조각에만.
  assert.equal(chunks.filter((c) => c.includes('전국 대학교 순위')).length, 1);
  assert.ok(chunks[4].includes('참고 자료입니다.'), '안내문이 마지막 조각에 없습니다');
  // 100행이 하나도 빠지지 않아야 한다.
  const joined = chunks.join('');
  for (const rank of [1, 21, 50, 99, 100]) {
    assert.ok(joined.includes(`학교${rank}<`), `${rank}행이 빠졌습니다`);
  }
  assert.deepEqual(buildTableChunks(null), [], '표가 없으면 빈 배열이어야 합니다');
});

test('<b> 강조는 살고 다른 태그는 막힌다', () => {
  const post = buildSamplePost();
  post.intro[0] = '이 부분은 <b>정말 중요합니다</b>. <script>alert(1)</script> 는 들어가면 안 됩니다.';
  const html = buildIntroHtml(post);
  assert.ok(html.includes('<b>정말 중요합니다</b>'), '강조가 사라졌습니다');
  assert.ok(!html.includes('<script>'), '스크립트 태그가 그대로 들어갔습니다');
});

test('클립보드에 같이 넣을 평문이 표를 살려서 나온다', () => {
  // text/html 만 넣으면 에디터가 붙여넣기를 거절하는 경우가 있다.
  const plain = htmlToPlainText(buildTableHtml(buildSamplePost().table));
  assert.ok(plain.includes('전기기사'), '표 내용이 평문에 없습니다');
  assert.ok(plain.includes('\t'), '칸 구분이 탭으로 안 바뀌었습니다');
  assert.ok(!/<[a-z]/i.test(plain), '태그가 남아 있습니다');
});

test('설정에서 태그를 끄면 태그 줄이 빠진다', () => {
  const html = buildBodyHtml(buildSamplePost(), { ...bodyOptions, appendTags: false });
  assert.ok(!html.includes('#자격증'), '태그를 껐는데 그대로 붙었습니다');
});

test('미리보기 HTML 에 품질 점검 결과가 들어간다', () => {
  const post = buildSamplePost();
  post.compliance = checkCompliance(post, settings);
  const html = buildPreviewHtml(post, bodyOptions);
  assert.ok(html.includes('품질 점검'), '점검 결과가 미리보기에 없습니다');
  assert.ok(html.includes(post.title), '제목이 없습니다');
});

console.log('\n[3] 마크다운');

test('H1 하나, H2/H3 소제목, 표가 들어간다', () => {
  const markdown = buildMarkdown(buildSamplePost());
  const h1 = markdown.split('\n').filter((line) => /^# /.test(line));
  assert.equal(h1.length, 1, `H1 이 ${h1.length}개입니다`);
  assert.ok(markdown.includes('\n## '), 'H2 가 없습니다');
  assert.ok(markdown.includes('\n### '), 'H3 가 없습니다');
  assert.ok(/\n\| 구분 \| 자격증 \|/.test(markdown), '표가 없습니다');
  assert.ok(markdown.includes('\n- '), '불렛 포인트가 없습니다');
});

console.log('\n[4] 자료 조사 · 출처');

const sampleSources = [
  { title: '국가기술자격 시행계획 공고', publisher: '한국산업인력공단', url: 'https://www.q-net.or.kr/notice/1234', date: '2026-01' },
  { title: '산업안전기사 응시 자격 안내', publisher: 'Q-net', url: 'https://www.q-net.or.kr/guide/safety', date: '2026-02' },
];

test('지어낸 주소와 자리표시자 주소를 걸러낸다', () => {
  assert.equal(isUsableUrl('https://www.q-net.or.kr/notice/1234'), true);
  assert.equal(isUsableUrl('http://localhost:8080/x'), false, 'localhost 를 통과시켰습니다');
  assert.equal(isUsableUrl('https://example.com/a'), false, '자리표시자 주소를 통과시켰습니다');
  assert.equal(isUsableUrl('출처: 한국산업인력공단'), false);
  assert.equal(isUsableUrl(''), false);
});

test('조사 자료 블록에 사실과 미확인 항목이 들어간다', () => {
  const block = buildResearchBlock({
    summary: '2026년 시행계획이 공고되었습니다.',
    freshness: '2026년 1월 공고 기준입니다.',
    items: ['산업안전기사'],
    facts: [{ claim: '제1회 필기시험은 1월 30일에 시작합니다.', detail: 'CBT 방식입니다.', source: 'Q-net', url: 'https://www.q-net.or.kr/notice/1234', date: '2026-01' }],
    sources: sampleSources,
    unverified: ['실기 합격률은 출처마다 달랐습니다.'],
  });
  assert.ok(block.includes('제1회 필기시험은 1월 30일에 시작합니다.'), '사실이 안 들어갔습니다');
  assert.ok(block.includes('확인하지 못한 내용'), '미확인 항목이 안 들어갔습니다');
  assert.ok(block.includes('본문에 URL 을 직접 적지 마세요'), 'URL 금지 안내가 없습니다');
  assert.equal(buildResearchBlock(null), '', '자료가 없으면 빈 문자열이어야 합니다');
});

test('출처는 제목과 발행처만 남고 주소는 본문에 들어가지 않는다', () => {
  // 네이버는 본문 글자 안의 주소를 찾아내 **링크 카드로 갈아끼운다.**
  // 그러면 그 문단의 글이 사라지고 기사 카드만 남는다. 실제로 제목 + 기사
  // 카드 하나만 있는 글이 임시저장되던 원인이라, 본문에는 주소를 안 넣는다.
  const post = buildSamplePost();
  post.sources = sampleSources;
  const html = buildBodyHtml(post, bodyOptions);
  assert.ok(html.includes('국가기술자격 시행계획 공고'), '출처 제목이 없습니다');
  assert.ok(html.includes('한국산업인력공단'), '발행처가 없습니다');
  assert.ok(!html.includes('<a '), '링크 태그가 들어갔습니다');
  assert.ok(!/https?:\/\//.test(html), `본문에 주소가 남아 있습니다: ${html.match(/https?:\/\/\S+/)}`);
  // 출처는 마무리 문단보다 뒤에 와야 읽는 흐름이 끊기지 않는다.
  assert.ok(html.indexOf('국가기술자격 시행계획 공고') > html.indexOf('자주 묻는 질문'),
    '출처가 본문 앞에 있습니다');
});

test('AI가 본문에 주소를 적어도 에디터로 나가기 전에 걷어낸다', () => {
  // 프롬프트로 막지만 모델이 어길 때가 있다. 마지막 길목에서 한 번 더 막는다.
  const post = buildSamplePost();
  post.intro[0] = '자세한 내용은 https://www.q-net.or.kr/notice/1234 에서 확인하세요.';
  post.sections[0].paragraphs[0] = 'http://example.go.kr/a/b?c=1 를 참고했습니다.';
  const html = buildIntroHtml(post) + buildBodyHtml(post, bodyOptions);
  assert.ok(!/https?:\/\//.test(html), '본문에 주소가 그대로 남았습니다');
  // 지우지 말고 호스트만 남겨야 읽는 사람이 어디 자료인지 알 수 있다.
  assert.ok(html.includes('q-net.or.kr'), '호스트까지 사라졌습니다');
  assert.ok(html.includes('example.go.kr'), '호스트까지 사라졌습니다');
});

test('stripUrls 는 주소만 호스트로 줄이고 나머지 글자는 건드리지 않는다', () => {
  assert.equal(stripUrls('https://www.q-net.or.kr/notice/1234'), 'q-net.or.kr');
  assert.equal(stripUrls('출처: http://news.naver.com/a?b=1 입니다'), '출처: news.naver.com 입니다');
  assert.equal(stripUrls('주소가 없는 평범한 문장입니다.'), '주소가 없는 평범한 문장입니다.');
  assert.equal(stripUrls(''), '');
});

test('출처 제목에 든 HTML 은 이스케이프된다', () => {
  const post = buildSamplePost();
  post.sources = [{ title: '<script>alert(1)</script> 공고', publisher: '', url: 'https://www.q-net.or.kr/x', date: '' }];
  assert.ok(!buildBodyHtml(post, bodyOptions).includes('<script>'), '스크립트 태그가 그대로 들어갔습니다');
});

test('출처가 없으면 목록을 붙이지 않는다', () => {
  // "참고 자료" 라는 말은 표 아래 안내문에도 들어간다.
  // 소제목 문단으로 끝나는 형태를 찾아야 엉뚱한 곳을 짚지 않는다.
  const heading = '>참고 자료</p>';
  const html = buildBodyHtml(buildSamplePost(), bodyOptions);
  assert.ok(html.includes('참고 자료이며'), '표 안내문이 사라졌습니다 (검사 전제가 깨졌습니다)');
  assert.ok(!html.includes(heading), '출처가 없는데 목록이 붙었습니다');

  const withSources = buildSamplePost();
  withSources.sources = sampleSources;
  assert.ok(buildBodyHtml(withSources, bodyOptions).includes(heading), '출처 소제목이 없습니다');
});

test('마크다운에는 출처 링크가 들어간다', () => {
  // 마크다운은 에디터용이 아니라 보관·이전용이라 링크 형식이 낫다.
  const post = buildSamplePost();
  post.sources = sampleSources;
  const markdown = buildMarkdown(post, { sourcesHeading: '참고 자료' });
  assert.ok(markdown.includes('## 참고 자료'), '출처 소제목이 없습니다');
  assert.ok(
    markdown.includes('[국가기술자격 시행계획 공고](https://www.q-net.or.kr/notice/1234)'),
    '마크다운 링크 형식이 아닙니다',
  );
});

test('출처를 붙여도 품질 검사를 통과한다', () => {
  const post = buildSamplePost();
  post.sources = sampleSources;
  const result = checkCompliance(post, settings);
  assert.equal(result.ok, true, `미통과: ${result.issues.map((i) => i.label).join(', ')}`);
});

test('검색을 못 돌린 조사 결과는 미리보기에 경고로 남는다', () => {
  const post = buildSamplePost();
  post.research = { searches: 0, facts: [], sources: [], unverified: ['확인 못 함'], freshness: '' };
  const html = buildPreviewHtml(post, bodyOptions);
  assert.ok(html.includes('웹 검색이 실제로 실행되지 않았습니다'), '경고가 없습니다');
  assert.ok(html.includes('확인하지 못한 내용'), '미확인 목록이 없습니다');
});

console.log('\n[5] 보조 함수');

test('주제 문자열에서 글의 모양을 알아낸다', () => {
  assert.equal(detectShape('국가기술자격증 TOP 5').shape, 'items');
  assert.equal(detectShape('자격증 7가지 추천').count, 7);
  assert.equal(detectShape('유튜브 구독자 TOP100 순위').shape, 'table');
  assert.equal(detectShape('유튜브 구독자 TOP100 순위').needsChunking, true);
  assert.equal(detectShape('전세 계약 전 확인할 서류').shape, 'general');
});

test('목표만큼 못 채워도 채운 만큼 1위부터 순위를 매긴다', () => {
  // "TOP 50" 인데 31개밖에 못 받는 일은 흔하다. 그때 빈 번호를 남기면
  // "1~20위, 그리고 35~45위" 같은 고장 난 표가 나온다.
  const byRank = new Map();
  for (const rank of [1, 2, 3, 17, 18, 40]) {
    byRank.set(rank, [String(rank), `항목 ${rank}`, '특징']);
  }

  const { rows, missing } = compactRanking(byRank, 50);

  assert.equal(rows.length, 6, '받은 행을 다 안 실었습니다');
  // 번호가 1부터 빈틈없이 이어져야 한다. 이게 이 검사의 핵심이다.
  assert.deepEqual(rows.map((row) => row[0]), ['1', '2', '3', '4', '5', '6']);
  // 순서는 원래 번호 순서를 지켜야 한다. 내용이 섞이면 안 된다.
  assert.deepEqual(
    rows.map((row) => row[1]),
    ['항목 1', '항목 2', '항목 3', '항목 17', '항목 18', '항목 40'],
  );
  // 몇 개가 모자랐는지는 기록으로 남아야 한다. 글에 그 사실을 밝혀야 하므로.
  assert.equal(missing.length, 44);
});

test('목표를 다 채우면 번호가 그대로다', () => {
  const byRank = new Map();
  for (let rank = 1; rank <= 5; rank += 1) byRank.set(rank, [String(rank), `항목 ${rank}`]);
  const { rows, missing } = compactRanking(byRank, 5);
  assert.deepEqual(rows.map((row) => row[0]), ['1', '2', '3', '4', '5']);
  assert.equal(missing.length, 0);
});

test('한 건도 못 받으면 빈 표로 돌아온다', () => {
  // 여기서 터지면 글 전체가 실패한다. 품질 검사가 잡도록 빈 채로 넘긴다.
  const { rows, missing } = compactRanking(new Map(), 50);
  assert.equal(rows.length, 0);
  assert.equal(missing.length, 50);
});

test('근거가 부족해도 쓰라는 지시가 프롬프트에 들어 있다', () => {
  // 이 도구가 다루는 주제는 대부분 공식 통계가 없다. 거절하면 쓸 글이 없다.
  assert.ok(WRITE_ANYWAY_BLOCK.includes('거절하지'), '거절 금지 지시가 없습니다');
  assert.ok(WRITE_ANYWAY_BLOCK.includes('통념'), '통념으로 써도 된다는 말이 없습니다');
  // 다만 "지어내라" 가 되면 안 된다. 근거 수준을 밝히라는 조건이 핵심이다.
  assert.ok(WRITE_ANYWAY_BLOCK.includes('근거 수준'), '근거 수준을 밝히라는 조건이 없습니다');
  assert.ok(WRITE_ANYWAY_BLOCK.includes('지어내'), '수치를 지어내지 말라는 선이 없습니다');
});

test('개수를 안 쓴 순위 주제는 목표 개수만큼 크게 뽑는다', () => {
  // 예전에는 항목 5개짜리 글로 잡혀서 "많이 담긴 순위표" 가 안 나왔다.
  const big = detectShape('전국 대학교 순위', 100);
  assert.equal(big.shape, 'table', '큰 표로 안 잡혔습니다');
  assert.equal(big.count, 100);
  assert.equal(big.needsChunking, true);

  assert.equal(detectShape('수도권 대학 서열', 150).count, 150, '설정값을 안 따랐습니다');
  // 주제에 숫자가 있으면 설정값보다 주제의 숫자가 우선이다.
  assert.equal(detectShape('대학 순위 TOP 30', 100).count, 30, '주제의 숫자를 무시했습니다');
  // "추천/비교" 는 항목 몇 개를 깊게 다루는 글이다. 100행 표로 가면 안 된다.
  assert.equal(detectShape('겨울 캠핑 장비 추천', 100).shape, 'items');
  assert.equal(detectShape('겨울 캠핑 장비 추천', 100).count, null);
  // 순위와 무관한 주제는 그대로 정보 정리형.
  assert.equal(detectShape('전세 계약 전 확인할 서류', 100).shape, 'general');
});

console.log('\n[6] 네이버 붙여넣기 성공 판정');

test('큰 문단일수록 문턱이 낮아지지 않는다', () => {
  // 예전 버그: Math.min(20, text.length / 2) 는 40자가 넘는 글이면
  // 항상 20자로 고정된다. 3,000자짜리 문단이 20자만 들어가도 "성공" 판정을
  // 받아 나머지가 통째로 사라지는데도 다음 조각으로 넘어갔다.
  // 그 결과 제목 + 썸네일만 있고 본문은 텅 빈 글이 그대로 저장됐다.
  const short = pasteThreshold('가'.repeat(10));
  const long = pasteThreshold('가'.repeat(3000));
  assert.ok(long > short * 100, `짧은 글 문턱 ${short}, 긴 글 문턱 ${long} — 긴 글이 더 엄격해야 합니다`);
  assert.ok(long >= 1500, `3,000자 글의 문턱이 ${long}자뿐입니다. 절반도 안 됩니다.`);
});

test('아주 짧은 조각도 최소 바닥값은 요구한다', () => {
  assert.ok(pasteThreshold('') >= 1, '빈 문자열도 0보다 큰 문턱이 있어야 합니다');
  assert.ok(pasteThreshold('짧다') >= 5, '짧은 글의 문턱이 너무 낮습니다');
});

console.log('\n[7] 썸네일 배경 그림');

test('썸네일 비율에 가장 가까운 허용 비율을 고른다', () => {
  assert.equal(pickAspectRatio(1200, 630), '16:9');
  assert.equal(pickAspectRatio(1080, 1080), '1:1');
  assert.equal(pickAspectRatio(1080, 1920), '9:16');
  assert.equal(pickAspectRatio(0, 0), '16:9', '잘못된 값에도 기본값이 나와야 합니다');
});

test('그림 프롬프트가 글자를 넣지 말라고 여러 번 못박는다', () => {
  const prompt = buildImagePrompt(
    { scene: 'a safety helmet on a desk', headline: '자격증 정리' },
    'flat',
  );
  assert.ok(prompt.includes('a safety helmet on a desk'), '장면 설명이 안 들어갔습니다');
  for (const ban of ['no text', 'no letters', 'no words', 'no watermark']) {
    assert.ok(prompt.includes(ban), `"${ban}" 금지 문구가 없습니다`);
  }
  // scene 이 비어도 제목으로 프롬프트를 만들 수 있어야 한다.
  assert.ok(buildImagePrompt({ headline: '겨울 캠핑' }, 'flat').includes('no text'));
});

test('배경 그림이 있으면 글자를 얹는 전용 레이아웃으로 간다', () => {
  const spec = {
    headline: '국가기술자격증 TOP 100', subline: '전국을 다 묶었습니다', badge: '자격증',
    emoji: '', accent: '#16324F', width: 1200, height: 630,
  };
  const plain = renderTemplate({ ...spec, style: 'minimal' });
  assert.ok(!plain.includes('<img src='), '배경이 없는데 이미지가 들어갔습니다');

  const withBg = renderTemplate({ ...spec, style: 'minimal', background: 'data:image/png;base64,AAA' });
  assert.ok(withBg.includes('<img src="data:image/png;base64,AAA"'), '배경 그림이 안 들어갔습니다');
  assert.ok(withBg.includes('object-fit:cover'), '배경이 꽉 차게 깔리지 않았습니다');
  // 그림이 밝든 어둡든 흰 글씨가 읽히려면 가림막이 있어야 한다.
  assert.ok(withBg.includes('linear-gradient'), '가림막이 없습니다');
  assert.ok(withBg.includes('국가기술자격증 TOP 100'), '문구가 안 얹혔습니다');
});

test('이미지 생성 모델만 골라낸다', () => {
  const model = (id, methods, description = '') => ({ id, methods, description });
  // Gemini 계열은 generateContent 만 표시돼서 이름으로 봐야 한다.
  assert.equal(looksLikeImageModel(model('gemini-3.1-flash-image', ['generateContent'])), true);
  assert.equal(looksLikeImageModel(model('gemini-3.1-flash-lite-image', ['generateContent'])), true);
  assert.equal(looksLikeImageModel(model('gemini-3-pro-image', ['generateContent'])), true);
  // Imagen 계열은 predict 로 구분된다.
  assert.equal(looksLikeImageModel(model('imagen-4.0-fast-generate-001', ['predict'])), true);
  // 글만 쓰는 모델, 임베딩, 이미지를 "읽는" 모델은 빠져야 한다.
  assert.equal(looksLikeImageModel(model('gemini-3-pro', ['generateContent'])), false);
  assert.equal(looksLikeImageModel(model('text-embedding-004', ['embedContent'])), false);
  assert.equal(looksLikeImageModel(model('gemini-pro-vision', ['generateContent'])), false);
  assert.equal(looksLikeImageModel(model('gemini-2.5-flash-tts', ['generateContent'])), false);
  // 설명에 이미지 생성이라고 적혀 있으면 그것도 본다.
  assert.equal(
    looksLikeImageModel(model('gemini-4-canvas', ['generateContent'], 'Generates images from text')),
    true,
  );
});

const imageModelPool = [
  { id: 'gemini-3-pro-image', methods: ['generateContent'] },
  { id: 'gemini-3.1-flash-image', methods: ['generateContent'] },
  { id: 'gemini-3.1-flash-lite-image', methods: ['generateContent'] },
  { id: 'gemini-3-pro', methods: ['generateContent'] },          // 이미지 모델 아님
  { id: 'text-embedding-004', methods: ['embedContent'] },       // 이미지 모델 아님
];

test('언제나 가장 싼 모델부터 쓴다', () => {
  const ranked = rankImageModels(imageModelPool);
  assert.deepEqual(
    ranked.map((m) => m.id),
    ['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image'],
    '싼 순서가 아닙니다',
  );
  assert.equal(ranked[0].tier, 'Flash Lite');
  assert.ok(ranked[0].usd < ranked[2].usd, '가격이 오름차순이 아닙니다');
  // 글자 렌더링 점수는 참고용일 뿐, 순서를 바꾸면 안 된다.
  assert.ok(ranked[0].text < ranked[2].text, '이 표본은 싼 쪽이 글자에 약한 것이 맞습니다');
});

test('글자 확인에 쓸 값싼 모델을 고른다', () => {
  const picked = pickVisionModel([
    { id: 'gemini-3-pro', methods: ['generateContent'] },
    { id: 'gemini-3.1-flash-lite', methods: ['generateContent'] },
    { id: 'gemini-3.1-flash-image', methods: ['generateContent'] },
    { id: 'text-embedding-004', methods: ['embedContent'] },
  ]);
  assert.equal(picked, 'gemini-3.1-flash-lite', '가장 값싼 텍스트 모델이 아닙니다');
  // 이미지 생성 모델은 글자를 읽는 용도로 고르면 안 된다.
  assert.ok(!picked.includes('-image'));
});

test('포스터 프롬프트에 넣을 문구를 한 줄씩 못박는다', () => {
  const prompt = buildPosterPrompt({
    posterLines: ['4년제만 답이 아니다', '취업 최강 전문대'],
    ribbon: 'TOP 50 대공개 (2026 최신)',
    subline: '실무, 자격증, 현장 경험으로 골랐습니다',
    badge: '전문대',
    keywords: ['간호보건', '반도체', '항공'],
    scene: 'a bright technical college workshop',
  }, 'bold');

  for (const line of ['4년제만 답이 아니다', '취업 최강 전문대', 'TOP 50 대공개 (2026 최신)', '전문대', '간호보건']) {
    assert.ok(prompt.includes(line), `"${line}" 이 프롬프트에 없습니다`);
  }
  assert.ok(prompt.includes('a bright technical college workshop'), '장면 설명이 없습니다');
  // 한글이 깨지지 않게 하는 지시가 들어 있어야 한다.
  assert.ok(/every Korean character must be rendered perfectly/i.test(prompt), '한글 정확도 지시가 없습니다');
  assert.ok(/Do NOT add any other text/i.test(prompt), '다른 글자 금지 지시가 없습니다');
  // 배경 전용 프롬프트와 달리 여기서는 글자를 넣어야 한다.
  assert.ok(!/^no text/m.test(prompt), '포스터인데 글자 금지가 들어갔습니다');
});

test('posterLines 가 없으면 headline 으로 대신한다', () => {
  const prompt = buildPosterPrompt({ headline: '겨울 캠핑 장비 정리' }, 'clean');
  assert.ok(prompt.includes('겨울 캠핑 장비 정리'), '제목이 안 들어갔습니다');
});

test('문구에 든 따옴표와 줄바꿈이 프롬프트를 깨뜨리지 않는다', () => {
  const prompt = buildPosterPrompt({ posterLines: ['이건 "인용" 이다\n두 줄'] }, 'bold');
  assert.ok(!prompt.includes('\n'), '줄바꿈이 그대로 들어갔습니다');
  assert.ok(prompt.includes('이건 인용 이다 두 줄'), '따옴표 정리가 안 됐습니다');
});

test('가격표에 없는 새 모델도 등급 이름으로 짐작한다', () => {
  // 구글이 새 모델을 내놔도 프로그램이 멈추면 안 된다.
  const lite = priceOf('gemini-9-flash-lite-image');
  const pro = priceOf('gemini-9-pro-image');
  assert.ok(lite.usd < pro.usd, 'lite 가 pro 보다 비싸게 잡혔습니다');

  const unknown = priceOf('gemini-9-mystery-image');
  assert.equal(unknown.known, false);
  // 모르는 모델은 비싼 쪽으로 본다. 아는 모델을 우선 쓰게 하기 위해서다.
  assert.ok(unknown.usd > priceOf('gemini-3.1-flash-image').usd, '모르는 모델이 먼저 골라집니다');
});

test('값이 같으면 가격을 아는 모델을 먼저 쓴다', () => {
  const ranked = rankImageModels([
    { id: 'gemini-9-fast-image', methods: ['generateContent'] },   // 추정 $0.03
    { id: 'imagen-4.0-fast-generate-001', methods: ['predict'] },  // 확실 $0.02
  ]);
  assert.equal(ranked[0].id, 'imagen-4.0-fast-generate-001');
  assert.equal(ranked[0].knownPrice, true);
});

test('API 키는 대시보드로 내려보내지 않는다', () => {
  const saved = saveSettings({ image: { apiKey: 'AIzaSECRETKEY' } });
  assert.equal(saved.image.apiKey, 'AIzaSECRETKEY', '설정에는 저장되어야 합니다');
  const shown = publicSettings();
  assert.equal(shown.image.apiKey, '', 'API 키가 화면으로 새어나갔습니다');
  assert.equal(shown.image.apiKeySet, true, '키가 있다는 표시가 없습니다');
  // 화면의 마스킹 값이 되돌아와도 진짜 키를 덮어쓰면 안 된다.
  saveSettings({ image: { apiKey: '●●●●●●' } });
  assert.equal(getSettings().image.apiKey, 'AIzaSECRETKEY', '마스킹 값이 키를 덮어썼습니다');
  saveSettings({ image: { apiKey: '' } });
});

test('붙여넣은 블로그 주소에서 아이디만 뽑아낸다', () => {
  assert.equal(normalizeBlogId('https://blog.naver.com/myblogid/223'), 'myblogid');
  assert.equal(normalizeBlogId('blog.naver.com/myblogid'), 'myblogid');
  assert.equal(normalizeBlogId('  myblogid  '), 'myblogid');
  assert.equal(normalizeBlogId(''), '');
});

test('네이버 태그에서 공백과 특수문자를 걷어낸다', () => {
  // 네이버 태그에는 공백을 넣을 수 없다. 붙여 쓰지 않으면 태그가 잘린다.
  assert.equal(normalizeTag('#국가 기술 자격증'), '국가기술자격증');
  assert.equal(normalizeTag('취업준비!'), '취업준비');
  assert.equal(normalizeTag('###'), '');
});

test('엑셀에서 붙여넣은 주제를 줄 단위로 읽는다', () => {
  const topics = parseTopics('주제\n자격증 TOP 5\t비고\n자격증 TOP 5\n\n전세 계약 서류');
  assert.deepEqual(topics, ['자격증 TOP 5', '전세 계약 서류']);
});

/* ---------- 주제 발굴 ---------- */

test('발굴 프롬프트에 큰 주제와 검색 지시가 들어간다', () => {
  const prompt = buildDiscoverPrompt('전기차 보조금', settings, 5);
  assert.match(prompt, /전기차 보조금/, '큰 주제가 프롬프트에 없습니다');
  assert.match(prompt, /WebSearch/, '검색 도구를 쓰라는 지시가 없습니다');
  assert.match(prompt, /글은 쓰지 마세요/, '주제만 고르라는 지시가 없습니다');
  assert.match(prompt, /5개/, '요청 개수가 들어가지 않았습니다');
  assert.match(prompt, new RegExp(`최근 ${settings.discover.recencyDays}일`), '최신 기준이 빠졌습니다');
  // 네이버에서 문제되는 소재를 고르지 않게 막는 부분이 반드시 있어야 한다.
  assert.match(prompt, /고르지 말아야 할 것/, '제외 지시가 빠졌습니다');
});

test('발굴 프롬프트는 검색 횟수 상한을 조사 설정이 아니라 발굴 설정에서 가져온다', () => {
  const tweaked = structuredClone(settings);
  tweaked.discover.maxSearches = 9;
  tweaked.research.maxSearches = 3;
  assert.match(buildDiscoverPrompt('부동산', tweaked, 4), /9회 이내/);
});

test('점수를 안 주거나 이상한 값을 줘도 순서를 정할 수 있다', () => {
  assert.equal(normalizePick({ topic: '2026년 전기차 보조금 개편 내용 정리' }).score, 50);
  assert.equal(normalizePick({ topic: '2026년 전기차 보조금 개편 내용 정리', score: 999 }).score, 100);
  assert.equal(normalizePick({ topic: '2026년 전기차 보조금 개편 내용 정리', score: -5 }).score, 0);
  assert.equal(normalizePick({ topic: '   ' }), null, '빈 주제를 걸러내지 않았습니다');
});

test('지어낸 근거 주소는 버린다', () => {
  const pick = normalizePick({
    topic: '2026년 전기차 보조금 개편 내용 정리',
    sources: ['https://www.molit.go.kr/notice/1', 'https://example.com/a', 'not-a-url'],
  });
  assert.deepEqual(pick.sources, ['https://www.molit.go.kr/notice/1']);
});

test('이미 쓴 주제와 낚시성 제목을 걸러낸다', () => {
  const picks = [
    { topic: '2026년 전기차 보조금, 지역별로 얼마나 달라졌을까', score: 85 },
    { topic: '2026년 전기차 보조금 지역별로 얼마나 달라졌을까!!', score: 80 },  // 기호만 다른 중복
    { topic: '충격! 전기차 보조금 이것만 알면 끝', score: 95 },                  // 낚시성
    { topic: '전기차 충전 요금 인상, 언제부터 얼마나 오르나', score: 30 },        // 점수 미달
    { topic: '짧다', score: 90 },                                                // 너무 짧음
    { topic: '전기차 보조금 신청 방법과 준비 서류 정리', score: 70 },
  ].map(normalizePick);

  const seen = new Set([topicKey('전기차 보조금 신청 방법과 준비 서류 정리')]);
  const { kept, dropped } = screenPicks(picks, { minScore: 40, seen });

  assert.deepEqual(kept.map((pick) => pick.topic), [
    '2026년 전기차 보조금, 지역별로 얼마나 달라졌을까',
  ]);
  assert.equal(dropped.duplicate, 2, '중복(목록 안 + 기록)을 다 잡지 못했습니다');
  assert.equal(dropped.clickbait, 1);
  assert.equal(dropped.lowScore, 1);
  assert.equal(dropped.tooShort, 1);
});

test('채택한 주제는 관심도 점수가 높은 순으로 나온다', () => {
  const picks = [
    { topic: '전기차 충전 요금 인상 시기와 인상폭 정리', score: 62 },
    { topic: '2026년 전기차 보조금 개편으로 달라지는 점', score: 91 },
    { topic: '전기차 보조금 신청 방법과 준비 서류 정리', score: 75 },
  ].map(normalizePick);
  const { kept } = screenPicks(picks, { minScore: 0 });
  assert.deepEqual(kept.map((pick) => pick.score), [91, 75, 62]);
});

test('이미 다 쓴 주제여도 큰 주제로 글감을 만들어 낸다', () => {
  // 비슷한 큰 주제를 여러 개 걸어두면 기록이 쌓여 전부 "이미 쓴 주제" 에 걸린다.
  // 그때 빈손으로 돌아가면 그 주문이 통째로 중단된다. 실제로 주문 20건이
  // 전부 "새 주제를 찾지 못했습니다" 로 멈춘 적이 있다.
  const picks = buildFallbackTopics('대학 순위', 3);
  assert.equal(picks.length, 3, `${picks.length}건만 만들었습니다`);
  for (const pick of picks) {
    assert.ok(pick.topic.includes('대학 순위'), `큰 주제가 빠졌습니다: ${pick.topic}`);
    assert.ok(pick.topic.length >= 8, `제목이 너무 짧습니다: ${pick.topic}`);
  }
  // 제목이 서로 달라야 같은 글이 여러 번 써지지 않는다.
  assert.equal(new Set(picks.map((p) => p.topic)).size, picks.length, '제목이 겹칩니다');
});

test('만든 글감이 이미 쓴 것이어도 빈손으로 돌아가지 않는다', () => {
  // 각도를 전부 써 버린 상황. 겹치더라도 하나는 내놓아야 진행이 멈추지 않는다.
  const first = buildFallbackTopics('대학 순위', 20);
  const seen = new Set(first.map((pick) => topicKey(pick.topic)));
  const again = buildFallbackTopics('대학 순위', 5, seen);
  assert.ok(again.length >= 1, '하나도 못 만들었습니다. 이러면 주문이 중단됩니다.');
});

test('각도를 다 써도 이미 있는 제목을 그대로 내지 않는다', () => {
  // 겹치는 제목을 내면 작업 목록에 넣는 단계에서 중복으로 걸러져 결국 0건이 되고,
  // 주문은 "새 주제를 찾지 못했습니다" 로 똑같이 멈춘다. 제목이 달라야 한다.
  const seen = new Set(buildFallbackTopics('대학 순위', 30).map((p) => topicKey(p.topic)));
  const before = seen.size;
  for (let round = 0; round < 5; round += 1) {
    const [pick] = buildFallbackTopics('대학 순위', 1, seen);
    assert.ok(pick, '하나도 못 만들었습니다');
    assert.ok(pick.topic.length >= 8, `제목이 너무 짧습니다: ${pick.topic}`);
  }
  assert.equal(seen.size, before + 5, '같은 제목을 다시 냈습니다');
});

test('이어서 쓸 분야를 못 받으면 쓰던 분야로 이어 간다', () => {
  // AI 호출이 어긋났다고 멈추면 "끊김 없이 계속 쓰기" 를 켜 둔 뜻이 없다.
  const seeds = ['전기차 보조금', '청년 지원금'];
  const topics = buildFallbackBigTopics(3, new Set([topicKey('청년 지원금')]), seeds);
  assert.ok(topics.length >= 1, '하나도 못 만들었습니다. 이러면 실행이 멈춥니다.');
  // 지금 대기열에 있는 분야는 또 넣지 않는다. 넣어봐야 중복이다.
  assert.ok(!topics.some((item) => topicKey(item.topic) === topicKey('청년 지원금')));
  assert.ok(topics.some((item) => item.topic === '전기차 보조금'), '쓰던 분야를 안 썼습니다');
});

test('기록이 하나도 없어도 이어서 쓸 분야가 나온다', () => {
  // 처음 켠 사람이 주제를 안 넣고 자동 이어가기만 켠 경우다.
  const topics = buildFallbackBigTopics(3, new Set(), []);
  assert.equal(topics.length, 3, `${topics.length}건만 만들었습니다`);
  assert.equal(new Set(topics.map((item) => item.topic)).size, 3, '분야가 겹칩니다');
});

test('이어서 쓸 큰 주제 프롬프트에 지금까지 쓴 분야가 들어간다', () => {
  const prompt = buildBigTopicPrompt(['전기차 보조금', '청년 지원금'], 3);
  assert.ok(prompt.includes('전기차 보조금'), '씨앗 주제가 안 들어갔습니다');
  assert.ok(prompt.includes('청년 지원금'), '씨앗 주제가 안 들어갔습니다');
  assert.ok(prompt.includes('3개'), '요청 개수가 안 들어갔습니다');
  // 개별 글 제목이 아니라 넓은 분야를 달라는 지시가 핵심이다.
  assert.ok(prompt.includes('넓은 분야'), '무엇을 달라는 건지 안 적혀 있습니다');
  assert.ok(prompt.includes('이미 있는 것과 같은 분야는 빼세요'), '중복 제외 지시가 없습니다');
});

test('씨앗이 하나도 없어도 프롬프트가 만들어진다', () => {
  // 처음 켠 사람은 기록이 비어 있다. 거기서 깨지면 안 된다.
  const prompt = buildBigTopicPrompt([], 3);
  assert.ok(prompt.includes('아직 없습니다'), '빈 목록 안내가 없습니다');
});

test('만든 글감은 낚시성·길이 검사를 통과한다', () => {
  // 걸러내기를 다시 통과하지 못하면 만들어 봐야 소용이 없다.
  const picks = buildFallbackTopics('대기업 연봉', 3).map(normalizePick);
  const { kept } = screenPicks(picks, { minScore: 0 });
  assert.equal(kept.length, picks.length, '만든 글감이 걸러내기에서 떨어졌습니다');
});

test('주제 비교 열쇠는 공백과 기호를 무시한다', () => {
  assert.equal(topicKey('국가기술자격증 TOP 5!'), topicKey('국가기술자격증top5'));
  assert.notEqual(topicKey('전기차 보조금'), topicKey('전기차 충전요금'));
});

/* ---------- 자동 실행 루프의 판단 ---------- */

const order = (patch = {}) => ({
  id: 'r1', bigTopic: '전기차', targetCount: 5, saved: 0, discovered: 0, ...patch,
});
const plan = (hasPending, request) => planNextStep({ hasPending, request });

test('대기 주제가 있으면 그것부터 쓴다', () => {
  assert.equal(plan(true, order()), 'process');
});

test('목표를 채우면 남은 주제가 있어도 그 주문을 닫는다', () => {
  // 닫아야 다음 주문으로 넘어간다. 넉넉히 받아 둔 주제를 마저 쓰면 안 된다.
  assert.equal(plan(true, order({ saved: 5 })), 'finish-request');
  assert.equal(plan(false, order({ saved: 7 })), 'finish-request', '넘겨도 닫아야 합니다');
});

test('대기가 떨어지면 그 주문의 큰 주제로 새로 찾아온다', () => {
  assert.equal(plan(false, order({ saved: 2 })), 'discover');
});

test('주문이 없으면 손으로 넣은 주제만 쓰고 끝낸다', () => {
  assert.equal(plan(true, null), 'process');
  assert.equal(plan(false, null), 'stop-empty');
});

test('자동 이어가기를 켜면 대기열이 비어도 끝내지 않는다', () => {
  // 사용자가 큰 주제를 계속 넣어 주지 않아도 멈추지 않게 하는 장치.
  assert.equal(planNextStep({ hasPending: false, request: null, autoRefill: true }), 'refill-orders');
  // 아직 쓸 주제가 남아 있으면 그것부터 쓴다. 굳이 새로 만들지 않는다.
  assert.equal(planNextStep({ hasPending: true, request: null, autoRefill: true }), 'process');
  // 진행 중인 주문이 있으면 그 주문을 먼저 끝낸다.
  assert.equal(
    planNextStep({ hasPending: false, request: order({ saved: 2 }), autoRefill: true }),
    'discover',
  );
});

test('계속 찾아오는데 저장이 안 되면 그 주문을 포기한다', () => {
  // 네이버 로그인이 풀려 전부 실패하는 상황. 이게 없으면 끝없이 검색만 돈다.
  const cap = discoverCapFor(order());
  assert.equal(cap, 15);
  assert.equal(plan(false, order({ discovered: cap })), 'give-up-request');
  assert.equal(plan(false, order({ discovered: cap - 1 })), 'discover');
  // 상한에 닿아도 이미 찾아온 주제는 마저 쓴다. 버릴 이유가 없다.
  assert.equal(plan(true, order({ discovered: 99 })), 'process');
});

test('개수가 적은 주문도 발굴 상한이 너무 빡빡하지 않다', () => {
  // 1건짜리 주문에 상한이 7이면 한 번 실패하고 두 번째 발굴에서 바로 포기한다.
  assert.equal(discoverCapFor(order({ targetCount: 1 })), 10);
  assert.equal(discoverCapFor(order({ targetCount: 20 })), 45);
});

/* ---------- 주문 대기열 ---------- */

test('주문을 넣은 순서대로 하나씩 꺼낸다', () => {
  clearRequests(false);
  const first = addRequest({ bigTopic: '전기차', targetCount: 3 });
  const second = addRequest({ bigTopic: '부동산', targetCount: 2 });

  assert.equal(nextRequest().id, first.id, '먼저 넣은 주문이 먼저 나와야 합니다');

  // 앞 주문을 끝내면 다음 주문이 올라온다.
  finishRequest(first.id, REQUEST_STATUS.DONE);
  assert.equal(nextRequest().id, second.id);

  finishRequest(second.id, REQUEST_STATUS.DONE);
  assert.equal(nextRequest(), null, '다 끝나면 꺼낼 주문이 없어야 합니다');
  clearRequests(false);
});

test('개수는 1 이상으로 맞춰 들어간다', () => {
  clearRequests(false);
  assert.equal(addRequest({ bigTopic: '전기차', targetCount: 0 }).targetCount, 1);
  assert.equal(addRequest({ bigTopic: '전기차', targetCount: -3 }).targetCount, 1);
  assert.equal(addRequest({ bigTopic: '전기차', targetCount: 9999 }).targetCount, 200);
  assert.throws(() => addRequest({ bigTopic: '  ' }), /큰 주제/);
  clearRequests(false);
});

test('대기열에 남은 글 편수를 센다', () => {
  clearRequests(false);
  addRequest({ bigTopic: '전기차', targetCount: 5 });
  const second = addRequest({ bigTopic: '부동산', targetCount: 3 });
  updateRequest(second.id, { saved: 2 });
  assert.deepEqual(requestStats(), { total: 2, open: 2, remaining: 6 });
  clearRequests(false);
});

test('같은 큰 주제를 두 번 넣을 수 있다', () => {
  // "5편 더 뽑아줘" 는 정상적인 요구다. 중복으로 막으면 안 된다.
  clearRequests(false);
  addRequest({ bigTopic: '전기차', targetCount: 5 });
  addRequest({ bigTopic: '전기차', targetCount: 5 });
  assert.equal(requestStats().open, 2);
  clearRequests(false);
});

test('발굴한 주제는 그 주문의 몫으로 붙는다', () => {
  clearJobs(false);
  const added = addTopics([{ topic: '전기차 보조금 2026년 개편 내용 정리', score: 80 }], 'req-1');
  assert.equal(added[0].requestId, 'req-1');
  // 손으로 넣은 주제는 주문에 딸리지 않는다.
  assert.equal(addTopics(['직접 적은 주제입니다'])[0].requestId, '');
  clearJobs(false);
});

test('손으로 넣은 주제를 발굴한 주제보다 먼저 쓴다', () => {
  clearJobs(false);
  addTopics([{ topic: '발굴해 온 주제 하나입니다' }], 'req-1');
  addTopics(['직접 적은 주제입니다']);
  assert.equal(nextPending().topic, '직접 적은 주제입니다');
  clearJobs(false);
});

test('제목을 정해 넣으면 AI 가 지은 제목을 무시한다', () => {
  // 프롬프트로도 못 박지만 모델이 제목을 다듬어 보내는 일이 잦다.
  // 여기서 한 번 더 막지 않으면 "제목 그대로 쓰기" 가 제목 추천이 되어버린다.
  const fixed = '2026년 수도권 대학 순위 TOP 50 총정리';
  const post = normalize(
    {
      title: 'AI가 멋대로 다듬은 제목입니다',
      intro: ['도입 문단입니다.'],
      sections: [{ heading: '소제목', paragraphs: ['본문입니다.'] }],
      outro: ['마무리입니다.'],
    },
    '아무 주제',
    settings,
    'table',
    fixed,
  );
  assert.equal(post.title, fixed, '정해준 제목이 안 쓰였습니다');
});

test('제목을 안 정하면 AI 가 지은 제목을 쓴다', () => {
  const post = normalize(
    {
      title: 'AI가 지은 제목입니다',
      intro: ['도입 문단입니다.'],
      sections: [{ heading: '소제목', paragraphs: ['본문입니다.'] }],
      outro: ['마무리입니다.'],
    },
    '아무 주제',
    settings,
    'general',
  );
  assert.equal(post.title, 'AI가 지은 제목입니다');
});

test('정해진 제목은 프롬프트에 그대로 들어간다', () => {
  const fixed = '대기업 평균 연봉 순위 TOP 30, 어디가 가장 높을까';
  const block = fixedTitleBlock(fixed);
  assert.ok(block.includes(fixed), '제목이 프롬프트에 안 들어갔습니다');
  assert.ok(block.includes('그대로'), '바꾸지 말라는 지시가 없습니다');
  // 제목만 따르고 내용이 딴 데로 가면 소용이 없다.
  assert.ok(block.includes('개수를 채우세요'), '제목의 약속을 지키라는 지시가 없습니다');
  // 제목을 안 정했으면 이 블록이 통째로 빠져야 한다.
  assert.equal(fixedTitleBlock(''), '');
  assert.equal(fixedTitleBlock('   '), '');
});

test('제목 고정 표시가 주제와 함께 저장된다', () => {
  clearJobs(false);
  addTopics([
    { topic: '제목을 정해 넣은 글입니다', fixedTitle: true },
    { topic: '평범하게 넣은 주제입니다' },
  ]);
  const jobs = listJobs();
  assert.equal(jobs.find((job) => job.topic.startsWith('제목을')).fixedTitle, true);
  assert.equal(jobs.find((job) => job.topic.startsWith('평범하게')).fixedTitle, false);
  clearJobs(false);
});

test('여러 제목을 줄바꿈으로 한 번에 넣는다', () => {
  // 한 줄에 하나씩 쭉 붙여넣는 것이 이 칸의 핵심이다.
  const topics = parseTopics([
    '2026년 수도권 대학 순위 TOP 50 총정리',
    '',
    '  대기업 평균 연봉 순위 TOP 30  ',
    '2026년 수도권 대학 순위 TOP 50 총정리',
    '전세 계약 전에 확인할 서류 7가지',
  ].join('\n'));
  // 빈 줄은 건너뛰고, 앞뒤 공백은 떼고, 같은 제목은 한 번만 들어간다.
  assert.deepEqual(topics, [
    '2026년 수도권 대학 순위 TOP 50 총정리',
    '대기업 평균 연봉 순위 TOP 30',
    '전세 계약 전에 확인할 서류 7가지',
  ]);
});

test('주문을 닫으면 남은 대기 주제가 건너뜀으로 정리된다', () => {
  clearJobs(false);
  addTopics([
    { topic: '발굴 주제 하나입니다 아주 길게' },
    { topic: '발굴 주제 둘입니다 아주 길게' },
  ], 'req-1');
  addTopics([{ topic: '다른 주문의 주제입니다' }], 'req-2');

  assert.equal(cancelPendingJobs('req-1', '목표를 채워 쓰지 않았습니다.'), 2);
  const jobs = listJobs();
  assert.equal(jobs.filter((job) => job.status === 'skipped').length, 2);
  // 다른 주문 것은 건드리지 않아야 한다.
  assert.equal(jobs.find((job) => job.requestId === 'req-2').status, 'pending');
  clearJobs(false);
});

test('발굴 설정은 대시보드로 그대로 내려간다', () => {
  const saved = saveSettings({ discover: { bigTopic: '부동산 정책', targetCount: 12 } });
  assert.equal(saved.discover.bigTopic, '부동산 정책');
  assert.equal(publicSettings().discover.targetCount, 12);
  saveSettings({ discover: { bigTopic: '', targetCount: DEFAULT_SETTINGS.discover.targetCount } });
});

test('claude 로그인이 풀린 오류를 알아본다', () => {
  // 실제로 겪은 메시지. 이걸 못 알아보면 남은 주제가 전부 같은 이유로 실패한다.
  assert.ok(looksAuthExpired('Failed to authenticate: OAuth session expired and could not be refreshed'));
  assert.ok(looksAuthExpired('Invalid API key · Please run /login'));
  assert.ok(looksAuthExpired('authentication_error'));
  assert.ok(looksAuthExpired('401 Unauthorized'));
  // 다른 실패까지 로그인 문제로 보면 멀쩡한 대기열이 세워진다.
  assert.ok(!looksAuthExpired('claude CLI 를 찾을 수 없습니다'));
  assert.ok(!looksAuthExpired('Request timed out'));
  assert.ok(!looksAuthExpired('rate limit exceeded'));
  // 사람이 무엇을 해야 하는지가 안내에 들어 있어야 한다.
  assert.ok(AUTH_HINT.includes('claude'), '무엇을 실행하라는 건지 안 적혀 있습니다');
  assert.ok(AUTH_HINT.includes('이어서 실행'), '그다음에 뭘 누르라는 건지 안 적혀 있습니다');
});

await testAsync('claude 가 프롬프트를 읽기 전에 죽어도 프로그램이 안 죽는다', async () => {
  /*
   * 로그인이 풀린 claude 는 프롬프트를 다 읽기도 전에 끝나 버린다.
   * 그때 나는 write EPIPE 를 받아주지 않으면 그대로 uncaughtException 이 되어
   * **서버 전체가 죽는다.** 대시보드에는 "연결할 수 없음" 만 뜬다.
   */
  const win = process.platform === 'win32';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naver-check-'));
  const fake = path.join(dir, win ? 'fake.cmd' : 'fake.sh');
  fs.writeFileSync(fake, win
    ? '@echo off\r\necho Failed to authenticate: OAuth session expired 1>&2\r\nexit /b 1\r\n'
    : '#!/bin/sh\necho "Failed to authenticate: OAuth session expired" >&2\nexit 1\n');
  if (!win) fs.chmodSync(fake, 0o755);

  const before = getSettings().claude.command;
  saveSettings({ claude: { command: fake, timeoutMs: 20000 } });

  let caught = null;
  try {
    // 프롬프트가 길어야 파이프에 한 번에 안 들어가서 EPIPE 가 제대로 재현된다.
    await runClaude('가'.repeat(200000), { timeoutMs: 20000 });
  } catch (error) {
    caught = error;
  } finally {
    saveSettings({
      claude: { command: before, timeoutMs: DEFAULT_SETTINGS.claude.timeoutMs },
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.ok(caught, '실패해야 하는데 성공으로 끝났습니다');
  // 죽지 않고, 진짜 원인(로그인 만료)까지 제대로 알아봐야 한다.
  assert.equal(caught.authExpired, true, `로그인 만료로 못 알아봤습니다: ${caught.message}`);
});

test('countChars 는 공백을 빼고 센다', () => {
  assert.equal(countChars({ intro: ['가 나 다'], sections: [], outro: [] }), 3);
});

// 이 검사는 console.log 를 잠시 망가뜨리고 다시는 화면에 못 쓰게 만든다.
// 뒤에 오는 검사에 영향이 가지 않도록 맨 마지막에 둔다.
test('검은 창이 닫혀도 로그가 프로그램을 멈추지 않는다', () => {
  assert.ok(isBrokenOutput({ code: 'EIO' }), 'EIO 를 못 알아봤습니다');
  assert.ok(isBrokenOutput({ code: 'EPIPE' }), 'EPIPE 를 못 알아봤습니다');
  assert.ok(!isBrokenOutput({ code: 'ENOENT' }), '엉뚱한 오류까지 출력 문제로 봤습니다');

  // 검은 창을 닫은 상황을 흉내 낸다. 그 뒤로 화면에 쓰면 write EIO 가 난다.
  const real = console.log;
  let writes = 0;
  console.log = () => {
    writes += 1;
    const error = new Error('write EIO');
    error.code = 'EIO';
    throw error;
  };
  try {
    assert.doesNotThrow(() => log('info', '창이 닫힌 뒤의 한 줄'), '로그가 예외를 던졌습니다');
    assert.doesNotThrow(() => log('info', '그다음 한 줄'), '로그가 예외를 던졌습니다');
  } finally {
    console.log = real;
  }

  // 한 번 막히면 다시는 쓰지 않아야 한다. 계속 쓰려 들면 그 오류가 또 로그로 들어와
  // `예기치 못한 오류: write EIO` 가 끝없이 반복된다. 실제로 그랬다.
  assert.equal(writes, 1, `화면에 ${writes}번 썼습니다. 한 번이면 충분합니다.`);
  assert.equal(consoleAlive(), false, '화면 출력이 아직 살아 있다고 봅니다');
  assert.equal(writeConsole('이건 나가면 안 된다'), false, '막힌 뒤에도 또 썼습니다');
});

console.log(failures ? `\n실패 ${failures}건\n` : '\n모두 통과했습니다.\n');
process.exit(failures ? 1 : 0);
