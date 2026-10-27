import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgent } from '../src/agent/loop.js';
import type { McpHost } from '../src/mcp/host.js';
import type { ModelClient, ModelReply, ToolSchema } from '../src/model/types.js';

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

const TOOL_SCHEMA: ToolSchema = {
  type: 'function',
  function: { name: 'repo__read_file', description: '读文件', parameters: { type: 'object' } },
};

/** 用鸭子类型构造 Host：Agent 循环只依赖 toModelTools / call 两个方法。 */
function hostStub(reply: string, isError = false): McpHost {
  return {
    toModelTools: () => [TOOL_SCHEMA],
    call: async () => ({ text: reply, isError, durationMs: 1 }),
  } as unknown as McpHost;
}

function scriptedModel(replies: ModelReply[], seenToolCounts: number[] = []): ModelClient {
  let index = 0;
  return {
    label: 'scripted',
    async chat(_messages, tools) {
      seenToolCounts.push(tools.length);
      const reply = replies[index];
      index += 1;
      if (!reply) throw new Error('脚本里的响应不够用了');
      return reply;
    },
  };
}

test('模型调用一次工具后给出最终回答', async () => {
  const model = scriptedModel([
    {
      content: null,
      toolCalls: [{ id: 'c1', name: 'repo__read_file', arguments: '{"path":"src/app.ts"}' }],
      usage: ZERO_USAGE,
    },
    { content: '入口在 `src/app.ts:12`。', toolCalls: [], usage: ZERO_USAGE },
  ]);

  const result = await runAgent({
    question: '入口在哪？',
    repoRoot: '.',
    fileCount: 10,
    maxRounds: 10,
    client: model,
    host: hostStub('1│ const app = createApp();'),
  });

  assert.equal(result.stopReason, 'final');
  assert.equal(result.rounds, 2);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]!.ok, true);
  assert.equal(result.toolCalls[0]!.name, 'repo__read_file');
  assert.match(result.answer, /src\/app\.ts:12/);
  assert.ok(result.messages.some((message) => message.role === 'tool'));
});

test('预算耗尽时强制收尾，最后一次调用不携带工具', async () => {
  const toolRound: ModelReply = {
    content: null,
    toolCalls: [{ id: 'c1', name: 'repo__read_file', arguments: '{}' }],
    usage: ZERO_USAGE,
  };
  const seen: number[] = [];
  const model = scriptedModel([toolRound, toolRound, { content: '基于已读内容：入口在 src/app.ts:3', toolCalls: [], usage: ZERO_USAGE }], seen);

  const result = await runAgent({
    question: '入口在哪？',
    repoRoot: '.',
    maxRounds: 2,
    client: model,
    host: hostStub('内容'),
  });

  assert.equal(result.stopReason, 'budget');
  assert.equal(result.rounds, 2);
  assert.equal(seen.length, 3);
  assert.equal(seen[0], 1);
  assert.equal(seen[2], 0, '收尾调用不应再暴露工具');
  assert.match(result.answer, /src\/app\.ts:3/);
});

test('工具参数不是合法 JSON 时记录失败并继续', async () => {
  const model = scriptedModel([
    {
      content: null,
      toolCalls: [{ id: 'c1', name: 'repo__read_file', arguments: '{不是 JSON' }],
      usage: ZERO_USAGE,
    },
    { content: '改用别的证据回答。', toolCalls: [], usage: ZERO_USAGE },
  ]);

  const result = await runAgent({
    question: '随便问问',
    repoRoot: '.',
    maxRounds: 5,
    client: model,
    host: hostStub('不会被执行'),
  });

  assert.equal(result.stopReason, 'final');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]!.ok, false);
  assert.match(result.toolCalls[0]!.error ?? '', /不是合法 JSON/);
  const toolMessage = result.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage?.content ?? '', /工具参数不是合法 JSON/);
});

test('工具返回错误时被标记为失败但循环继续', async () => {
  const model = scriptedModel([
    {
      content: null,
      toolCalls: [{ id: 'c1', name: 'repo__read_file', arguments: '{"path":"nope.ts"}' }],
      usage: ZERO_USAGE,
    },
    { content: '该文件不存在。', toolCalls: [], usage: ZERO_USAGE },
  ]);

  const result = await runAgent({
    question: '读一个不存在的文件',
    repoRoot: '.',
    maxRounds: 5,
    client: model,
    host: hostStub('文件不存在：nope.ts', true),
  });

  assert.equal(result.stopReason, 'final');
  assert.equal(result.toolCalls[0]!.ok, false);
  assert.match(result.toolCalls[0]!.error ?? '', /文件不存在/);
});

test('模型调用抛错时返回 error 而不是崩溃', async () => {
  const model: ModelClient = {
    label: 'broken',
    async chat() {
      throw new Error('401 鉴权失败');
    },
  };

  const result = await runAgent({
    question: '入口在哪？',
    repoRoot: '.',
    maxRounds: 3,
    client: model,
    host: hostStub('内容'),
  });

  assert.equal(result.stopReason, 'error');
  assert.match(result.answer, /401 鉴权失败/);
  assert.equal(result.rounds, 1);
});

test('累计 usage 会跨轮求和', async () => {
  const model = scriptedModel([
    {
      content: null,
      toolCalls: [{ id: 'c1', name: 'repo__read_file', arguments: '{}' }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    },
    { content: '完成', toolCalls: [], usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 } },
  ]);

  const result = await runAgent({
    question: 'q',
    repoRoot: '.',
    maxRounds: 5,
    client: model,
    host: hostStub('内容'),
  });

  assert.equal(result.usage.totalTokens, 43);
  assert.equal(result.usage.promptTokens, 30);
});
