#!/usr/bin/env node
/**
 * 不调用任何大模型的端到端冒烟：
 * 拉起 MCP Server → 列举工具 → 依次调用 5 个工具 → 打印结果摘要。
 * 用于验证「MCP 链路本身」是通的，CI 与本地都能跑，不需要 API Key。
 *
 * 用法：tsx scripts/smoke.ts [仓库路径]
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpHost } from '../src/mcp/host.js';
import { resolveRepoServerSpec } from '../src/mcp/spawn.js';
import { verifyCitations } from '../src/verify/citations.js';

const repo = resolve(process.argv[2] ?? 'examples/sample-repo');
if (!existsSync(repo) || !statSync(repo).isDirectory()) {
  console.error(`仓库不存在：${repo}`);
  process.exit(1);
}

const host = await McpHost.connect([resolveRepoServerSpec(repo)]);
let failed = 0;

try {
  const tools = host.listTools();
  console.log(`仓库：${repo}`);
  console.log(`工具：${tools.map((tool) => tool.name).join(', ')}\n`);

  const checks: Array<[string, Record<string, unknown>]> = [
    ['repo__repo_stats', {}],
    ['repo__list_files', { dir: 'src' }],
    ['repo__search_code', { pattern: 'export', include: '*.ts', maxResults: 5 }],
    ['repo__outline', { path: 'src/app.ts' }],
    ['repo__read_file', { path: 'src/app.ts', startLine: 1, endLine: 8 }],
  ];

  for (const [name, args] of checks) {
    const outcome = await host.call(name, args);
    const firstLine = outcome.text.split('\n')[0] ?? '';
    const status = outcome.isError ? '✗' : '✓';
    if (outcome.isError) failed += 1;
    console.log(`${status} ${name.padEnd(20)} ${outcome.durationMs}ms  ${firstLine.slice(0, 90)}`);
  }

  // 引用校验器对真实文件的自检：用工具读到的行号构造一条引用。
  const read = await host.call('repo__read_file', { path: 'src/app.ts', startLine: 1, endLine: 3 });
  const match = /^(\d+)│/m.exec(read.text);
  if (match) {
    const line = Number.parseInt(match[1]!, 10);
    const report = verifyCitations(repo, `自检引用：\`src/app.ts:${line}\``);
    console.log(`\n引用校验自检：${report.verified}/${report.total} 通过`);
    if (report.verified !== 1) failed += 1;
  } else {
    console.log('\n未能从 read_file 输出解析行号，跳过引用自检');
    failed += 1;
  }
} finally {
  await host.close();
}

console.log(failed === 0 ? '\n冒烟通过 ✅' : `\n冒烟失败：${failed} 项 ❌`);
process.exit(failed === 0 ? 0 : 1);
