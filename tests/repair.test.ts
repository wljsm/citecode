import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRepairPrompt, failedCitations, needsRepair } from '../src/agent/repair.js';
import type { CitationCheck, CitationReport, CitationStatus } from '../src/verify/citations.js';

function check(raw: string, status: CitationStatus, detail?: string): CitationCheck {
  return { raw, path: raw.split(':')[0]!, startLine: 1, endLine: 1, status, ...(detail ? { detail } : {}) };
}

function report(citations: CitationCheck[]): CitationReport {
  const verified = citations.filter((item) => item.status === 'verified').length;
  return {
    citations,
    total: citations.length,
    verified,
    ratio: citations.length === 0 ? 0 : verified / citations.length,
    files: [],
  };
}

test('全部引用通过时不需要修正', () => {
  const value = report([check('src/a.ts:3', 'verified'), check('src/b.ts:5', 'verified')]);
  assert.equal(buildRepairPrompt(value, '引用都在这里：src/a.ts:3 与 src/b.ts:5'), null);
  assert.equal(needsRepair(value, '随便什么'), false);
  assert.deepEqual(failedCitations(value), []);
});

test('没有引用且有实质内容时需要补充引用', () => {
  const value = report([]);
  assert.equal(needsRepair(value, '短答案'), false, '过短的答案不强制补引用');
  const longAnswer = '这个项目用内存存储数据。'.repeat(20);
  const prompt = buildRepairPrompt(value, longAnswer);
  assert.ok(prompt);
  assert.match(prompt, /没有任何/);
  assert.match(prompt, /完整的新回答/);
});

test('失败引用会被逐条列出并带上原因', () => {
  const value = report([
    check('src/a.ts:3', 'verified'),
    check('src/auth.ts:99', 'out_of_range', '起始行 99 超出文件总行数 84'),
    check('src/ghost.ts:12', 'missing_file', 'ENOENT'),
  ]);
  const prompt = buildRepairPrompt(value, '有证据的回答');
  assert.ok(prompt);
  assert.match(prompt, /3 条引用里有 2 条没有通过/);
  assert.match(prompt, /`src\/auth\.ts:99`.*行号越界/);
  assert.match(prompt, /`src\/ghost\.ts:12`.*文件不存在/);
  assert.doesNotMatch(prompt, /`src\/a\.ts:3`/, '已通过的引用不应出现在失败清单里');
  assert.match(prompt, /原来已通过的引用要保留/);
});

test('失败引用过多时截断，避免撑爆上下文', () => {
  const many = Array.from({ length: 12 }, (_, index) => check(`src/f${index}.ts:1`, 'missing_file'));
  const prompt = buildRepairPrompt(report(many), '回答');
  assert.ok(prompt);
  assert.match(prompt, /另有 4 条未列出/);
  assert.match(prompt, /有 12 条没有通过/);
  assert.equal(prompt.split('\n').filter((line) => line.startsWith('- `src/')).length, 8);
});