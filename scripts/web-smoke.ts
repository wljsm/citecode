/**
 * Web 端到端冒烟：没有浏览器也能验证整条链路。
 *
 * 拉起真实 HTTP 服务 → 请求页面 → 查 meta → 取源码片段 →
 * 用 cassette 回放跑一题 → 解析 SSE，确认事件流、回答与引用都对。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { McpHost } from '../src/mcp/host.js';
import { resolveRepoServerSpec } from '../src/mcp/spawn.js';
import { walkFiles } from '../src/repo/walk.js';
import { startWebServer, type WebDeps } from '../src/web/server.js';
import type { GoldenSuite } from '../src/eval/runner.js';

const repoRoot = resolve(process.argv[2] ?? 'examples/sample-repo');
const replayDir = resolve(process.argv[3] ?? 'fixtures/cassettes');
const goldenPath = resolve(process.argv[4] ?? 'eval/golden.json');

const suite = JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenSuite;
const presets = suite.cases.map((item) => ({ id: item.id, question: item.question }));

const host = await McpHost.connect([resolveRepoServerSpec(repoRoot)]);
const { files } = walkFiles(repoRoot);
const tools = host.listTools().map((tool) => tool.name);

const deps: WebDeps = {
  host,
  config: loadConfig(),
  repoRoot,
  repoLabel: repoRoot,
  fileCount: files.length,
  tools,
  presets,
  replayDir,
  maxRepairs: 2,
};

const server = await startWebServer(deps, { port: 0 });
const base = `http://127.0.0.1:${server.port}`;
console.log(`服务已启动：${base}`);

try {
  // 1) 页面本身
  const page = await fetch(base);
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const marker of ['CiteCode', 'id="stream"', '引用校验', 'id="ask"']) {
    assert.ok(html.includes(marker), `页面缺少标记：${marker}`);
  }
  assert.ok(html.includes('__CITECODE_PRESETS__'), '页面应内联预设题库');
  console.log('✓ GET /            页面可访问，标记齐全');

  // 2) 元信息
  const meta = (await (await fetch(`${base}/api/meta`)).json()) as {
    mode: string;
    tools: string[];
    presets: unknown[];
  };
  assert.equal(meta.mode, 'replay');
  assert.equal(meta.tools.length, 5);
  assert.equal(meta.presets.length, presets.length);
  console.log(`✓ GET /api/meta    ${meta.tools.length} 个工具 / ${meta.presets.length} 道预设题`);

  // 3) 源码片段（引用点击后走的就是这个端点）
  const src = (await (
    await fetch(`${base}/api/source?path=src/app.ts&start=27&end=27`)
  ).json()) as { path: string; lines: Array<{ n: number; text: string }>; error?: string };
  assert.equal(src.error, undefined);
  assert.equal(src.path, 'src/app.ts');
  const hit = src.lines.find((line) => line.n === 27);
  assert.ok(hit, '应返回第 27 行');
  assert.match(hit.text, /createServer/);
  console.log(`✓ GET /api/source  第 27 行命中：${hit.text.trim()}`);

  // 4) 越界路径仍被沙箱拦住
  const blocked = (await (
    await fetch(`${base}/api/source?path=${encodeURIComponent('../.env')}&start=1&end=1`)
  ).json()) as { error?: string };
  assert.ok(blocked.error, '越界路径必须被拒绝');
  console.log(`✓ 沙箱拦截          ${blocked.error.split(':')[0]}`);

  // 5) 跑一题，解析 SSE
  const response = await fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: presets[0]!.question, caseId: presets[0]!.id }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const stream = await response.text();

  const events = stream
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const name = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? '';
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      return { name, data };
    });

  const agentEvents = events.filter((event) => event.name === 'agent');
  const done = events.find((event) => event.name === 'done');
  assert.ok(agentEvents.length >= 3, '应至少推送 3 条 agent 事件');
  assert.ok(done, '必须推送 done 事件');

  const run = JSON.parse(done.data) as {
    answer: string;
    citations: { total: number; verified: number };
    stats: { toolCalls: number; stopReason: string };
  };
  assert.equal(run.stats.stopReason, 'final');
  assert.ok(run.citations.total > 0, '回答应带引用');
  assert.equal(run.citations.verified, run.citations.total, '引用应全部通过');
  assert.ok(run.answer.includes('src/app.ts'), '回答应引用 src/app.ts');
  console.log(
    `✓ POST /api/ask    ${agentEvents.length} 条事件 · 引用 ${run.citations.verified}/${run.citations.total} · 工具 ${run.stats.toolCalls} 次`,
  );

  // 6) 回放模式拒绝题库之外的问题
  const rejected = await fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '这道题不在题库里' }),
  });
  const rejectedText = await rejected.text();
  assert.match(rejectedText, /event: error/, '题库外的问题应返回 error 事件');
  console.log('✓ 回放边界          题库外的问题被拒绝');

  console.log('\nWeb 冒烟通过 ✅');
} finally {
  await server.close();
  await host.close();
}