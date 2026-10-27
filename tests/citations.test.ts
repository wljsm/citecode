import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractCitations, verifyCitations } from '../src/verify/citations.js';

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'citecode-cite-'));
}

test('提取单行引用与行段引用', () => {
  const text = '入口在 `src/app.ts:12`，登录逻辑见 src/auth.ts:30-42。';
  const found = extractCitations(text);
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], { raw: 'src/app.ts:12', path: 'src/app.ts', startLine: 12, endLine: 12 });
  assert.deepEqual(found[1], { raw: 'src/auth.ts:30-42', path: 'src/auth.ts', startLine: 30, endLine: 42 });
});

test('忽略 URL 与重复引用', () => {
  const text = '参考 https://example.com/a.ts:10 与 src/a.ts:5，重复一次 src/a.ts:5。';
  const found = extractCitations(text);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.path, 'src/a.ts');
});

test('校验通过的引用会带上源码片段', () => {
  const root = tempRepo();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), ['const a = 1;', 'const b = 2;', 'export function boot() {}'].join('\n'));

  const report = verifyCitations(root, '启动函数在 `src/app.ts:3`。');
  assert.equal(report.total, 1);
  assert.equal(report.verified, 1);
  assert.equal(report.ratio, 1);
  assert.match(report.citations[0]!.snippet ?? '', /export function boot/);
});

test('文件不存在与行号越界分别归类', () => {
  const root = tempRepo();
  writeFileSync(join(root, 'a.ts'), 'line1\nline2\n');

  const report = verifyCitations(root, '见 a.ts:1 与 ghost.ts:3 与 a.ts:99。');
  assert.equal(report.total, 3);
  assert.equal(report.verified, 1);

  const byRaw = new Map(report.citations.map((item) => [item.raw, item.status]));
  assert.equal(byRaw.get('a.ts:1'), 'verified');
  assert.equal(byRaw.get('ghost.ts:3'), 'missing_file');
  assert.equal(byRaw.get('a.ts:99'), 'out_of_range');

  const outOfRange = report.citations.find((item) => item.status === 'out_of_range');
  assert.match(outOfRange!.detail ?? '', /超出文件总行数/);
});

test('没有任何引用时 ratio 为 0', () => {
  const root = tempRepo();
  const report = verifyCitations(root, '这个项目写得不错。');
  assert.equal(report.total, 0);
  assert.equal(report.ratio, 0);
  assert.deepEqual(report.files, []);
});

test('结束行超过文件长度时截断而不是判失败', () => {
  const root = tempRepo();
  writeFileSync(join(root, 'b.ts'), 'one\ntwo\n');
  const report = verifyCitations(root, '见 `b.ts:2-99`。');
  assert.equal(report.citations[0]!.status, 'verified');
  assert.equal(report.citations[0]!.endLine, 2);
});
