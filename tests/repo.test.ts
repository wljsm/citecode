import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RepoAccessError, RepoSandbox } from '../src/repo/sandbox.js';
import { walkFiles } from '../src/repo/walk.js';
import { globToRegExp, searchCode } from '../src/repo/search.js';
import { outlineText } from '../src/repo/outline.js';
import { namespacedToolName } from '../src/mcp/host.js';

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'citecode-repo-'));
}

test('沙箱拒绝路径逃逸与绝对路径', () => {
  const root = tempRepo();
  const sandbox = new RepoSandbox(root);
  assert.throws(() => sandbox.resolve('../outside.txt'), RepoAccessError);
  assert.throws(() => sandbox.resolve('src/../../etc/passwd'), RepoAccessError);
  assert.throws(() => sandbox.resolve('C:\\Windows\\win.ini'), RepoAccessError);
  assert.throws(() => sandbox.resolve('/etc/passwd'), RepoAccessError);
});

test('沙箱拒绝密钥文件', () => {
  const root = tempRepo();
  writeFileSync(join(root, '.env'), 'DEEPSEEK_API_KEY=sk-real');
  const sandbox = new RepoSandbox(root);
  assert.throws(() => sandbox.readText('.env', 1024), /禁止读取/);
});

test('读取超过上限的文件会报 too_large 并提示分段', () => {
  const root = tempRepo();
  writeFileSync(join(root, 'big.ts'), 'x'.repeat(2048));
  const sandbox = new RepoSandbox(root);
  assert.throws(
    () => sandbox.readText('big.ts', 1024),
    (error: unknown) => error instanceof RepoAccessError && error.code === 'too_large',
  );
});

test('归一化路径可以正常读取', () => {
  const root = tempRepo();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const x = 1;');
  const sandbox = new RepoSandbox(root);
  const result = sandbox.readText('./src/a.ts', 1024);
  assert.equal(result.rel, 'src/a.ts');
  assert.match(result.text, /export const x/);
});

test('遍历时忽略 node_modules 与构建产物', () => {
  const root = tempRepo();
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules', 'lib'), { recursive: true });
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;');
  writeFileSync(join(root, 'node_modules', 'lib', 'index.js'), 'module.exports = 1;');
  writeFileSync(join(root, 'dist', 'a.js'), 'var a = 1;');

  const { files } = walkFiles(root);
  assert.deepEqual(files.map((file) => file.path), ['src/a.ts']);
});

test('搜索返回准确行号，并支持 include 过滤', () => {
  const root = tempRepo();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), ['const one = 1;', 'function target() {', '  return 1;', '}'].join('\n'));
  writeFileSync(join(root, 'src', 'b.md'), 'target 出现在文档里');

  const all = searchCode(root, { pattern: 'target' });
  assert.equal(all.hits.length, 2);

  const onlyTs = searchCode(root, { pattern: 'target', include: '*.ts' });
  assert.equal(onlyTs.hits.length, 1);
  assert.equal(onlyTs.hits[0]!.path, 'src/a.ts');
  assert.equal(onlyTs.hits[0]!.line, 2);

  const literal = searchCode(root, { pattern: 'target()', literal: true });
  assert.equal(literal.hits.length, 1);
});

test('glob 转换支持 ** 与 *', () => {
  assert.ok(globToRegExp('*.ts').test('a.ts'));
  assert.ok(!globToRegExp('*.ts').test('src/a.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/deep/nested/a.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a.ts'));
});

test('大纲提取 TS 与 Python 顶层符号', () => {
  const ts = ['export function boot() {', '}', 'export class Server {', '  method() {', '  }', '}', 'const PORT = 1;'].join('\n');
  const tsSymbols = outlineText('a.ts', ts);
  const tsNames = tsSymbols.map((symbol) => `${symbol.kind}:${symbol.name}:${symbol.line}`);
  assert.ok(tsNames.includes('function:boot:1'));
  assert.ok(tsNames.includes('class:Server:3'));

  const py = ['import os', '', 'def login(x):', '    return x', '', 'class Store:', '    pass'].join('\n');
  const pySymbols = outlineText('b.py', py);
  assert.deepEqual(pySymbols.map((symbol) => symbol.name), ['login', 'Store']);
  assert.equal(pySymbols[0]!.line, 3);
});

test('工具名带 Server 前缀且长度受控', () => {
  assert.equal(namespacedToolName('repo', 'read_file'), 'repo__read_file');
  const long = namespacedToolName('a'.repeat(40), 'b'.repeat(40));
  assert.ok(long.length <= 64);
});
