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
import { renderAblation, runAblation } from './eval/ablation.js';
import { exportSnapshot, startWebServer, type WebDeps } from './web/server.js';

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
    case 'verify': {
      const ok = event.total > 0 && event.verified === event.total;
      const body = event.total === 0 ? '没有引用' : `${event.verified}/${event.total} 通过`;
      console.log(`  ${ok ? green('✓') : red('✗')} 回读校验 ${dim(body)}`);
      break;
    }
    case 'repair':
      console.log(
        yellow(
          `  ↻ 自校正第 ${event.attempt} 次：${event.failed}/${event.total} 条引用未通过，已把失败清单回灌给模型`,
        ),
      );
      break;
    case 'hint':
      console.log(yellow(`⚠ ${event.message}`));
      break;
  }
}

function printRunStats(result: Awaited<ReturnType<typeof runAgent>>): void {
  const toolOk = result.toolCalls.filter((call) => call.ok).length;
  const repairs = result.repairs > 0 ? ` · 自校正 ${result.repairs} 次` : '';
  console.log(
    dim(
      `轮次 ${result.rounds} · 工具 ${result.toolCalls.length} 次（成功 ${toolOk}）· ` +
        `token ${result.usage.totalTokens} · 结束方式 ${result.stopReason}${repairs}`,
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
      repairs: { type: 'string' },
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
  const maxRepairs = values.repairs === undefined ? 2 : Number.parseInt(values.repairs, 10);
  if (!Number.isFinite(maxRepairs) || maxRepairs < 0) fail('--repairs 必须是非负整数（0 表示关闭自校正）');

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
      console.log(`${bold('模型')} ${client.label} ${dim(`· 预算 ${maxRounds} 轮 · 自校正 ${maxRepairs} 轮`)}\n`);
    }

    const result = await runAgent({
      question,
      repoRoot: root,
      repoLabel: root,
      fileCount: files.length,
      maxRounds,
      maxRepairs,
      client,
      host,
      ...(values.quiet ? {} : { onEvent: printEvent }),
    });

    if (recorder && values.record) {
      recorder.save(resolve(values.record));
      if (!values.json) console.log(dim(`\n已录制 ${recorder.count} 轮模型响应 → ${resolve(values.record)}`));
    }

    const report =
      values.verify && result.answer && result.stopReason !== 'error' ? result.citations : undefined;

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
            repairs: result.repairs,
            initialRatio: result.initialCitations.ratio,
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
      repairs: { type: 'string' },
      faults: { type: 'string' },
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

  if (mode === 'replay' && !existsSync(cassetteDir!)) {
    fail(`cassette 目录不存在：${cassetteDir}`);
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
      ...(values.repairs ? { maxRepairs: Number.parseInt(values.repairs, 10) } : {}),
      ...(values.faults ? { faults: Number.parseInt(values.faults, 10) } : {}),
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

async function commandAblation(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      golden: { type: 'string', default: join(process.cwd(), 'eval', 'golden.json') },
      replay: { type: 'string' },
      record: { type: 'string' },
      rounds: { type: 'string' },
      faults: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });

  const goldenPath = resolve(values.golden);
  if (!existsSync(goldenPath)) fail(`找不到基准文件：${goldenPath}`);
  const suite = JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenSuite;
  const repoRoot = resolve(dirname(goldenPath), suite.repo ?? '.');
  if (!existsSync(repoRoot)) fail(`基准里的仓库路径不存在：${repoRoot}`);

  const config = loadConfig();
  const mode = values.replay ? 'replay' : values.record ? 'record' : 'live';
  const cassetteDir = values.replay
    ? resolve(values.replay)
    : values.record
      ? resolve(values.record)
      : undefined;

  const host = await McpHost.connect([resolveRepoServerSpec(repoRoot)]);
  try {
    const { files } = walkFiles(repoRoot);
    if (!values.json) {
      console.log(
        `${bold('消融实验')} ${suite.name} ${dim(`· ${suite.cases.length} 题 × 2 组配置 · ${mode} 模式`)}`,
      );
      console.log(`${bold('仓库')} ${repoRoot} ${dim(`(${files.length} 个文件)`)}\n`);
    }

    const report = await runAblation(suite, {
      host,
      config,
      repoRoot,
      repoLabel: repoRoot,
      fileCount: files.length,
      mode,
      ...(cassetteDir ? { cassetteDir } : {}),
      ...(values.rounds ? { maxRounds: Number.parseInt(values.rounds, 10) } : {}),
      ...(values.faults ? { faults: Number.parseInt(values.faults, 10) } : {}),
    });

    if (values.json) {
      console.log(
        JSON.stringify(
          {
            suite: report.suite,
            runs: report.runs.map((run) => ({
              label: run.label,
              slug: run.slug,
              maxRepairs: run.maxRepairs,
              summary: run.summary,
            })),
            fixedCases: report.fixedCases,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(renderAblation(report));
    }
  } finally {
    await host.close();
  }
}

async function commandWeb(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      repo: { type: 'string' },
      golden: { type: 'string' },
      replay: { type: 'string' },
      repairs: { type: 'string' },
      export: { type: 'string' },
      case: { type: 'string' },
      question: { type: 'string' },
    },
  });

  const goldenPath = resolve(values.golden ?? join(process.cwd(), 'eval', 'golden.json'));
  let suite: GoldenSuite | undefined;
  if (existsSync(goldenPath)) {
    try {
      suite = JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenSuite;
    } catch (error) {
      fail(`基准文件解析失败：${(error as Error).message}`);
    }
  } else if (!values.repo) {
    fail(`找不到基准文件：${goldenPath}（可用 --repo 直接指定仓库）`);
  }

  const repoRoot = values.repo
    ? requireRepo(values.repo)
    : requireRepo(resolve(dirname(goldenPath), suite?.repo ?? '../examples/sample-repo'));

  const replayDir = values.replay ? resolve(values.replay) : undefined;
  if (replayDir && !existsSync(replayDir)) fail(`cassette 目录不存在：${replayDir}`);

  const config = loadConfig();
  const host = await McpHost.connect([resolveRepoServerSpec(repoRoot)]);

  try {
    const { files } = walkFiles(repoRoot);
    const tools = host.listTools().map((tool) => tool.name);

    let presets = (suite?.cases ?? []).map((item) => ({ id: item.id, question: item.question }));
    if (replayDir) {
      presets = presets.filter((preset) => existsSync(resolve(replayDir, `${preset.id}.jsonl`)));
      if (presets.length === 0) fail(`回放目录里没有可用的 cassette：${replayDir}`);
    }

    const maxRepairs = values.repairs === undefined ? 2 : Number.parseInt(values.repairs, 10);
    if (!Number.isFinite(maxRepairs) || maxRepairs < 0) fail('--repairs 必须是非负整数');

    const deps: WebDeps = {
      host,
      config,
      repoRoot,
      repoLabel: repoRoot,
      fileCount: files.length,
      tools,
      presets,
      ...(replayDir ? { replayDir } : {}),
      maxRepairs,
    };

    if (values.export) {
      const out = resolve(values.export);
      const run = await exportSnapshot(deps, out, values.case, values.question);
      console.log(`${green('已导出快照')} ${out}`);
      console.log(
        dim(
          `引用 ${run.citations.verified}/${run.citations.total} · 工具 ${run.stats.toolCalls} 次 · ` +
            `token ${run.stats.tokens} · 结束方式 ${run.stats.stopReason}`,
        ),
      );
      return;
    }

    const port = values.port ? Number.parseInt(values.port, 10) : 4173;
    if (!Number.isFinite(port) || port < 1) fail('--port 必须是正整数');

    const handle = await startWebServer(deps, { port });
    const url = `http://127.0.0.1:${handle.port}`;
    console.log(`${bold('CiteCode Web')} ${url}`);
    console.log(
      dim(
        `仓库 ${repoRoot}（${files.length} 个文件）· ${presets.length} 道预设题 · ` +
          `${replayDir ? '回放模式（无需密钥）' : '实时模式（需要 API Key）'}`,
      ),
    );
    console.log(dim('按 Ctrl+C 停止'));

    await new Promise<void>((resolvePromise) => {
      const stop = (): void => {
        void handle.close().then(() => resolvePromise());
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
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
  citecode ablation [--golden eval/golden.json] 关掉/开启自校正各跑一遍，输出对照组
  citecode web    [选项]                        启动 Web 界面（流式 + 引用可点击）

${bold('ask 选项')}
  --rounds <n>     探索预算轮数，默认取 CITECODE_MAX_ROUNDS（24）
  --repairs <n>    引用自校正回合数，默认 2；0 表示关闭
  --replay <file>  回放 cassette，不联网
  --record <file>  把本次模型响应录制成 cassette
  --no-verify      跳过引用校验
  --json           输出机器可读 JSON
  --quiet          不打印过程

${bold('eval 选项')}
  --replay <dir>   用录制的 cassette 跑分（CI 常用，无需密钥）
  --record <dir>   录制本次跑分
  --repairs <n>    引用自校正回合数，默认 2；0 表示关闭（消融对照用）
  --faults <n>     故障注入：把每题首答的最多 n 条引用行号改错，验证自校正闭环
  --fail-under <n> 通过率门槛，默认 0.8

${bold('ablation 选项')}
  --golden <file>  基准文件，默认 eval/golden.json
  --record <dir>   按 baseline/ 与 repair/ 两个子目录分别录制
  --replay <dir>   从上述两个子目录回放，无需密钥
  --faults <n>     两组配置都注入故障，用来对比「有修复」与「没修复」的差距

${bold('web 选项')}
  --port <n>       监听端口，默认 4173（只绑定 127.0.0.1）
  --repo <路径>    被测仓库，默认取基准文件里的 repo
  --golden <file>  用哪份基准生成预设题目
  --replay <dir>   回放模式：只跑题库里的题，用 cassette，不联网也无需密钥
  --export <file>  不启动服务，导出自包含 HTML 快照（配合 --case 或 --question）
  --case <id>      快照要用的题目 id
  --question <文本> 快照要问的问题（实时模式）
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
    case 'ablation':
      await commandAblation(rest);
      break;
    case 'web':
      await commandWeb(rest);
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      fail(`未知命令：${command}（可用：tools / ask / verify / eval / ablation / web）`);
  }
}

main().catch((error: unknown) => {
  console.error(red(`未捕获错误：${(error as Error).message}`));
  process.exit(1);
});
