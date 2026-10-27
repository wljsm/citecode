import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CassetteRecorder, loadCassette, parseCassette } from '../src/model/cassette.js';
import { parseEnv } from '../src/config.js';
import { explainModelError } from '../src/model/deepseek.js';

const USAGE = { promptTokens: 3, completionTokens: 4, totalTokens: 7 };

test('录制后可以回放出相同的响应序列', () => {
  const dir = mkdtempSync(join(tmpdir(), 'citecode-cassette-'));
  const file = join(dir, 'demo.jsonl');
  const recorder = new CassetteRecorder();

  recorder.record(0, 'deepseek-chat', 2, {
    content: null,
    toolCalls: [{ id: 'c1', name: 'repo__read_file', arguments: '{"path":"a.ts"}' }],
    usage: USAGE,
  });
  recorder.record(1, 'deepseek-chat', 4, { content: '答案在 a.ts:1', toolCalls: [], usage: USAGE });
  recorder.save(file);

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);

  const replay = loadCassette(file);
  const first = replay.next(2);
  assert.equal(first.toolCalls[0]!.name, 'repo__read_file');
  const second = replay.next(4);
  assert.match(second.content ?? '', /a\.ts:1/);
});

test('请求规模不一致时给出可操作的报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'citecode-cassette-'));
  const file = join(dir, 'mismatch.jsonl');
  const recorder = new CassetteRecorder();
  recorder.record(0, 'deepseek-chat', 2, { content: 'ok', toolCalls: [], usage: USAGE });
  recorder.save(file);

  const replay = loadCassette(file);
  assert.throws(() => replay.next(5), /请求了 5 条消息/);
});

test('cassette 耗尽时报错而不是静默返回空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'citecode-cassette-'));
  const file = join(dir, 'short.jsonl');
  const recorder = new CassetteRecorder();
  recorder.record(0, 'deepseek-chat', 2, { content: 'ok', toolCalls: [], usage: USAGE });
  recorder.save(file);

  const replay = loadCassette(file);
  replay.next(2);
  assert.throws(() => replay.next(2), /只有 1 条记录/);
});

test('非法 JSONL 会指出具体行号', () => {
  const valid = JSON.stringify({
    turn: 0,
    model: 'deepseek-chat',
    requestMessages: 2,
    reply: { content: 'ok', toolCalls: [], usage: USAGE },
  });
  assert.throws(() => parseCassette(`${valid}\n不是JSON`), /第 2 行/);
  assert.throws(() => parseCassette('{"turn":0}'), /缺少 turn\/reply/);
});

test('.env 解析支持注释、引号与 export', () => {
  const parsed = parseEnv(['# 注释', 'A=1', 'export B="two words"', "C='x=1'", ''] .join('\n'));
  assert.equal(parsed.A, '1');
  assert.equal(parsed.B, 'two words');
  assert.equal(parsed.C, 'x=1');
});

test('常见 HTTP 错误被翻译成可读提示', () => {
  assert.match(explainModelError({ status: 401, message: 'bad key' }, 'https://api.deepseek.com', 'm'), /鉴权失败/);
  assert.match(explainModelError({ status: 402 }, 'https://api.deepseek.com', 'm'), /余额不足/);
  assert.match(explainModelError({ status: 429 }, 'https://api.deepseek.com', 'm'), /频繁/);
});
