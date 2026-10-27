import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withCitationFaults } from '../src/eval/fault.js';
import type { ChatMessage, ModelClient, ModelReply, ToolSchema } from '../src/model/types.js';

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function scripted(replies: ModelReply[]): ModelClient {
  let index = 0;
  return {
    label: 'scripted',
    async chat() {
      const reply = replies[index];
      index += 1;
      if (!reply) throw new Error('响应不够用');
      return reply;
    },
  };
}

test('故障注入会把最终回答里的行号改到越界', async () => {
  const client = withCitationFaults(
    scripted([{ content: '入口在 `src/app.ts:27`，监听在 `src/app.ts:61-63`。', toolCalls: [], usage: USAGE }]),
    { maxFaults: 1, shift: 1000 },
  );

  const reply = await client.chat([], [] as ToolSchema[]);
  assert.match(reply.content ?? '', /src\/app\.ts:1027/);
  assert.doesNotMatch(reply.content ?? '', /:27\b/);
  assert.equal(client.injected(), 1, '只改一条，第二条保持原样');
  assert.match(reply.content ?? '', /src\/app\.ts:61-63/);
});

test('只有第一次最终回答被改错，之后的回答原样放行', async () => {
  const client = withCitationFaults(
    scripted([
      { content: '第一次：`a.ts:5`。', toolCalls: [], usage: USAGE },
      { content: '修正后：`a.ts:5`。', toolCalls: [], usage: USAGE },
    ]),
    { maxFaults: 1, shift: 100 },
  );

  const first = await client.chat([] as ChatMessage[], [] as ToolSchema[]);
  const second = await client.chat([] as ChatMessage[], [] as ToolSchema[]);
  assert.match(first.content ?? '', /a\.ts:105/);
  assert.match(second.content ?? '', /a\.ts:5\b/, '第二次不再注入');
  assert.equal(client.injected(), 1);
});

test('带工具调用的回合不会被注入', async () => {
  const client = withCitationFaults(
    scripted([
      {
        content: null,
        toolCalls: [{ id: 'c1', name: 'repo__read_file', arguments: '{}' }],
        usage: USAGE,
      },
      { content: '最终：`a.ts:5`。', toolCalls: [], usage: USAGE },
    ]),
    { maxFaults: 1, shift: 10 },
  );

  const toolRound = await client.chat([], [] as ToolSchema[]);
  assert.equal(toolRound.content, null, '工具回合不应被改写');
  assert.equal(client.injected(), 0);

  const final = await client.chat([], [] as ToolSchema[]);
  assert.match(final.content ?? '', /a\.ts:15/);
  assert.equal(client.injected(), 1);
});