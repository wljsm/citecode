import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderPage, type PageOptions } from '../src/web/page.js';
import type { WebRun } from '../src/web/types.js';

function baseOptions(overrides: Partial<PageOptions> = {}): PageOptions {
  return {
    model: 'deepseek-chat',
    mode: 'replay',
    repoLabel: '/tmp/sample',
    fileCount: 7,
    tools: ['repo__read_file', 'repo__search_code'],
    presets: [{ id: 'entry', question: '入口在哪？' }],
    ...overrides,
  };
}

const SAMPLE_RUN: WebRun = {
  question: '入口在哪？',
  caseId: 'entry',
  repoLabel: '/tmp/sample',
  fileCount: 7,
  model: 'deepseek-chat',
  mode: 'replay',
  events: [{ type: 'round', round: 1 }],
  answer: '入口在 `src/app.ts:27`。',
  citations: {
    total: 1,
    verified: 1,
    ratio: 1,
    items: [
      {
        raw: 'src/app.ts:27',
        path: 'src/app.ts',
        startLine: 27,
        endLine: 27,
        status: 'verified',
      },
    ],
  },
  stats: { rounds: 1, toolCalls: 2, tokens: 100, stopReason: 'final', repairs: 0, durationMs: 1200 },
  sources: {},
};

test('实时页面内联预设题库，但不带快照数据', () => {
  const html = renderPage(baseOptions({ mode: 'live' }));
  assert.match(html, /window\.__CITECODE_PRESETS__ = /);
  assert.doesNotMatch(html, /window\.__CITECODE_SNAPSHOT__ = /);
  assert.match(html, /repo__read_file/);
  assert.match(html, /<title>CiteCode/);
  assert.match(html, /id="stream"/);
});

test('快照页面内联运行数据，并禁用重新运行', () => {
  const html = renderPage(baseOptions({ snapshot: SAMPLE_RUN }));
  assert.match(html, /window\.__CITECODE_SNAPSHOT__ = /);
  assert.match(html, /"stopReason":"final"/);
  assert.doesNotMatch(html, /window\.__CITECODE_PRESETS__ = /);
});

test('答案里出现 </script> 也不会截断快照页面', () => {
  const evil: WebRun = {
    ...SAMPLE_RUN,
    answer: '看这里 </script><script>alert(1)</script> 和 `src/app.ts:27`。',
  };
  const html = renderPage(baseOptions({ snapshot: evil }));
  assert.doesNotMatch(html, /<\/script><script>alert\(1\)<\/script>/);
  assert.match(html, /\\u003c\/script>/);
  // 页面结构仍然完整：客户端脚本还在最后
  assert.equal(html.split('<script>').length, html.split('</script>').length);
});

test('未通过校验的引用在页面上被标记为 bad', () => {
  const failing: WebRun = {
    ...SAMPLE_RUN,
    citations: {
      total: 1,
      verified: 0,
      ratio: 0,
      items: [
        {
          raw: 'src/ghost.ts:9',
          path: 'src/ghost.ts',
          startLine: 9,
          endLine: 9,
          status: 'missing_file',
          detail: 'ENOENT',
        },
      ],
    },
  };
  const html = renderPage(baseOptions({ snapshot: failing }));
  assert.match(html, /"status":"missing_file"/);
  assert.match(html, /"detail":"ENOENT"/);
});