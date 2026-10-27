#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { McpHost } from './mcp/host.js';
import { resolveRepoServerSpec } from './mcp/spawn.js';
import { createModelClient } from './model/deepseek.js';
import { CassetteRecorder, loadCassette } from './model/cassette.js';
import { runAgent, type AgentEvent } from './agent/loop.js';
import { renderCitationReport, verifyCitations } from './verify/citations.js';
import { walkFiles } from './repo/walk.js';
import { renderCaseLine, renderSummary, runSuite, type GoldenSuite } from './eval/runner.js';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint =
  (code: number) =>
  (text: string): string =>
    useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
const dim = paint(2);
const bold = paint(1);
const green = paint(32);
const red = paint(31);
const cyan = paint(36);
const yellow = paint(33);

function requireRepo(input: string): string {
  const root = resolve(input);
  if (!existsSync(root)) {
    fail(`仓库路径不存在：${root}`);
  }
  if (!statSync(root).isDirectory()) {
    fail(`不是目录：${root}`);
  }
  return root;
}

function fail(message: string): never {
  console.error(red(`错误：${message}`));
  process.exit(1);
}

function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'round':
      console.log(dim(`─ 第 ${event.round} 轮`));
      break;
    case 'tool':
      console.log(
        `  ${event.ok ? '⚙' : '✗'} ${cyan(event.name)} ${dim(`${event.durationMs} ms`)} ${dim(event.preview)}`,
      );
      break;
    case 'assistant':
      if (event.content) console.log(`  ${bold('💭')} ${dim(event.content.replace(/\s+/g, ' ').slice(0, 200))}`);
      if (event.toolCallCount > 0) console.log(dim(`  → 请求 ${event.toolCallCount} 个工具`));
      break;
    case 'hint':
      console.log(yellow(`⚠ ${event.message}`));
      break;
  }
}

function printRunStats(result: Awaited<ReturnType<typeof runAgent>>): void {
  const toolOk = result.toolCalls.filter((call) => call.ok).length;
  console.log(
    dim(
      `轮次 ${result.rounds} · 工具 ${result.toolCalls.length} 次（成功 ${toolOk}）· ` +
        `token ${result.usage.totalTokens} · 结束方式 ${result.stopReason}`,
    ),
  );
}

async function commandTools(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const repo = positionals[0];
  if (!repo) fail('用法：citecode tools <仓库路径>');
  const root = requireRepo(repo);

  const host = await McpHost.connect([resolveRepoServerSpec(root)]);
  try {
    const tools = host.listTools();
    const { files } = walkFiles(root);
    console.log(`${bold('仓库')} ${root}`);
    console.log(`${bold('可读文件')} ${files.length} 个`);
    console.log(`${bold('工具')} ${tools.length} 个\n`);
    for (const tool of tools) {
      console.log(`  ${cyan(tool.name)}`);
      console.log(`    ${dim(tool.description.split('\n')[0] ?? '')}`);
    }
  } finally {
    await host.close();
  }
}

async function commandAsk(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      rounds: { type: 'string' },
      json: { type: 'boolean', default: false },
      verify: { type: 'boolean', default: true },
      quiet: { type: 'boolean', default: false },
      replay: { type: 'string' },
      record: { type: 'string' },
    },
  });

  const [repo, ...rest] = positionals;
  const question = rest.join(' ').trim();
  if (!repo || !question) fail('用法：citecode ask <仓库路径> <问题>');

  const root = requireRepo(repo);
  const config = loadConfig();
  const maxRounds = values.rounds ? Number.parseInt(values.rounds, 10) : config.maxRounds;
  if (!Number.isFinite(maxRounds) || maxRounds < 1) fail('--rounds 必须是正整数');

  const recorder = values.record ? new CassetteRecorder() : undefined;
  const replay = values.replay ? loadCassette(resolve(values.replay)) : undefined;
  const client = createModelClient(config, {
    ...(recorder ? { recorder } : {}),
    ...(replay ? { replay } : {}),
  });

  const host = await McpHost.connect([resolveRepoServerSpec(root)]);
  const started = Date.now();
  try {
    const { files } = walkFiles(root);
    if (!values.quiet) {
      console.log(`${bold('仓库')} ${root} ${dim(`(${files.length} 个文件)`)}`);
      console.log(`${bold('问题')} ${question}`);
      console.log(`${bold('模型')} ${client.label} ${dim(`· 预算 ${maxRounds} 轮`)}\n`);
    }

    const result = await runAgent({
      question,
      repoRoot: root,
      repoLabel: root,
      fileCount: files.length,
      maxRounds,
      client,
      host,
      ...(values.quiet ? {} : { onEvent: printEvent }),
    });

    if (recorder && values.record) {
      recorder.save(resolve(values.record));
      if (!values.json) console.log(dim(`\n已录制 ${recorder.count} 轮模型响应 → ${resolve(values.record)}`));
    }

    const report =
      values.verify && result.answer && result.stopReason !== 'error'
        ? verifyCitations(root, result.answer)
        : undefined;

    if (values.json) {
      console.log(
        JSON.stringify(
          {
            question,
            repo: root,
            answer: result.answer,
            stopReason: result.stopReason,
            rounds: result.rounds,
            usage: result.usage,
            toolCalls: result.toolCalls,
            citations: report
              ? {
                  total: report.total,
                  verified: report.verified,
                  ratio: report.ratio,
                  items: report.citations,
                  files: report.files,
                }
              : null,
            elapsedMs: Date.now() - started,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`\n${bold('回答')}\n`);
      console.log(result.answer || dim('（空回答）'));
      console.log('');
      if (report) {
        console.log(report.total > 0 && report.ratio === 1 ? green(renderCitationReport(report)) : renderCitationReport(report));
        console.log('');
      }
      printRunStats(result);
    }

    process.exitCode = result.stopReason === 'error' ? 1 : 0;
  } finally {
    await host.close();
  }
}

async function commandVerify(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      strict: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const repo = positionals[0];
  if (!repo) fail('用法：citecode verify <仓库路径> [--file 回答.md] [--strict]');
  const root = requireRepo(repo);

  const answer = values.file ? readFileSync(resolve(values.file), 'utf8') : readFileSync(0, 'utf8');
  const report = verifyCitations(root, answer);

  if (values.json) {
    console.log(JSON.stringify({ total: report.total, verified: report.verified, ratio: report.ratio, citations: report.citations }, null, 2));
  } else {
    console.log(renderCitationReport(report));
  }

  if (values.strict && report.verified !== report.total) process.exitCode = 1;
}

async function commandEval(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      golden: { type: 'string', default: join(process.cwd(), 'eval', 'golden.json') },
      replay: { type: 'string' },
      record: { type: 'string' },
      rounds: { type: 'string' },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      'fail-under': { type: 'string', default: '0.8' },
    },
  });

  const goldenPath = resolve(values.golden);
  if (!existsSync(goldenPath)) fail(`找不到基准文件：${goldenPath}`);
  const suite = JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenSuite;
  const repoRoot = resolve(dirname(goldenPath), suite.repo ?? '.');
  if (!existsSync(repoRoot)) fail(`基准里的仓库路径不存在：${repoRoot}`);

  const config = loadConfig();
  const mode = values.replay ? 'replay' : values.record ? 'record' : 'live';
  const cassetteDir = values.replay ? resolve(values.replay) : values.record ? resolve(values.record) : undefined;

  if (mode !== 'live' && !existsSync(cassetteDir!)) {
    fail(`cassette 目录不存在：${cassetteDir}（录制模式下会自动创建）`);
  }

  const host = await McpHost.connect([resolveRepoServerSpec(repoRoot)]);
  try {
    const { files } = walkFiles(repoRoot);
    if (!values.json) {
      console.log(`${bold('基准')} ${suite.name} ${dim(`· ${suite.cases.length} 题 · ${mode} 模式`)}`);
      console.log(`${bold('仓库')} ${repoRoot} ${dim(`(${files.length} 个文件)`)}\n`);
    }

    const { results, summary } = await runSuite(suite, {
      host,
      config,
      repoRoot,
      repoLabel: repoRoot,
      fileCount: files.length,
      mode,
      ...(cassetteDir ? { cassetteDir } : {}),
      ...(values.rounds ? { maxRounds: Number.parseInt(values.rounds, 10) } : {}),
      ...(values.verbose
        ? {
            onEvent: (caseId: string, event: AgentEvent) => {
              if (event.type === 'tool' || event.type === 'hint') {
                console.log(dim(`  [${caseId}] ${event.type === 'tool' ? event.name : event.message}`));
              }
            },
          }
        : {}),
    });

    if (values.json) {
      console.log(JSON.stringify({ summary, results: results.map(({ citations, ...rest }) => ({ ...rest, citations: { total: citations.total, verified: citations.verified } })) }, null, 2));
    } else {
      for (const result of results) console.log(renderCaseLine(result));
      console.log(`\n${renderSummary(summary)}`);
    }

    const threshold = Number.parseFloat(values['fail-under']);
    if (Number.isFinite(threshold) && summary.passRate < threshold) {
      if (!values.json) console.error(red(`\n通过率 ${(summary.passRate * 100).toFixed(0)}% 低于门槛 ${(threshold * 100).toFixed(0)}%`));
      process.exitCode = 1;
    }
  } finally {
    await host.close();
  }
}

function printHelp(): void {
  console.log(`${bold('citecode')} — 引用可验证的代码阅读 Agent

${bold('用法')}
  citecode tools  <仓库>                        列出 MCP 工具（不需要模型密钥）
  citecode ask    <仓库> <问题> [选项]           问一个关于代码库的问题
  citecode verify <仓库> [--file 回答.md]        校验一段文本里的引用是否真实
  citecode eval   [--golden eval/golden.json]   跑基准并输出指标

${bold('ask 选项')}
  --rounds <n>     探索预算轮数，默认取 CITECODE_MAX_ROUNDS（24）
  --replay <file>  回放 cassette，不联网
  --record <file>  把本次模型响应录制成 cassette
  --no-verify      跳过引用校验
  --json           输出机器可读 JSON
  --quiet          不打印过程

${bold('eval 选项')}
  --replay <dir>   用录制的 cassette 跑分（CI 常用，无需密钥）
  --record <dir>   录制本次跑分
  --fail-under <n> 通过率门槛，默认 0.8
`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'tools':
      await commandTools(rest);
      break;
    case 'ask':
      await commandAsk(rest);
      break;
    case 'verify':
      await commandVerify(rest);
      break;
    case 'eval':
      await commandEval(rest);
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      fail(`未知命令：${command}（可用：tools / ask / verify / eval）`);
  }
}

main().catch((error: unknown) => {
  console.error(red(`未捕获错误：${(error as Error).message}`));
  process.exit(1);
});
