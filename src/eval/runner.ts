import type { Config } from '../config.js';
import type { McpHost } from '../mcp/host.js';
import { createModelClient } from '../model/deepseek.js';
import { CassetteRecorder, loadCassette } from '../model/cassette.js';
import { runAgent, type AgentEvent } from '../agent/loop.js';
import { verifyCitations, type CitationReport } from '../verify/citations.js';

export interface GoldenCase {
  id: string;
  question: string;
  /** 期望被引用到的文件（相对仓库根）。命中率是本题的核心指标。 */
  expectFiles: string[];
  /** 答案里应当出现的关键词（大小写不敏感）。 */
  expectKeywords?: string[];
  /** 允许的工具调用次数上限，用于约束「乱翻文件」。 */
  maxToolCalls?: number;
}

export interface GoldenSuite {
  name: string;
  description?: string;
  /** 被测仓库路径，相对 golden 文件所在目录；默认 '.'。 */
  repo?: string;
  defaultMaxToolCalls?: number;
  cases: GoldenCase[];
}

export interface CaseResult {
  id: string;
  question: string;
  stopReason: string;
  citationRatio: number;
  totalCitations: number;
  verifiedCitations: number;
  /** expectFiles 中被真实引用命中的比例。 */
  fileHit: number;
  /** 期望关键词命中比例。 */
  keywordHit: number;
  toolCalls: number;
  rounds: number;
  totalTokens: number;
  durationMs: number;
  pass: boolean;
  failures: string[];
  answer: string;
  citations: CitationReport;
}

export interface SuiteSummary {
  name: string;
  cases: number;
  passed: number;
  passRate: number;
  avgCitationRatio: number;
  avgFileHit: number;
  avgToolCalls: number;
  avgTokens: number;
  p50LatencyMs: number;
}

export interface EvalDeps {
  host: McpHost;
  config: Config;
  /** 被测仓库的绝对路径。 */
  repoRoot: string;
  repoLabel: string;
  fileCount: number;
  /** 每道题一个 cassette 文件的目录（录制或回放）。 */
  cassetteDir?: string;
  mode: 'live' | 'record' | 'replay';
  maxRounds?: number;
  onEvent?: (caseId: string, event: AgentEvent) => void;
}

function keywordHit(answer: string, keywords: string[] | undefined): number {
  if (!keywords || keywords.length === 0) return 1;
  const lower = answer.toLowerCase();
  const hit = keywords.filter((keyword) => lower.includes(keyword.toLowerCase())).length;
  return hit / keywords.length;
}

function fileHit(report: CitationReport, expectFiles: string[]): number {
  if (expectFiles.length === 0) return 1;
  const verifiedFiles = report.files.map((item) => item.path);
  const hit = expectFiles.filter((file) =>
    verifiedFiles.some((candidate) => candidate === file || candidate.endsWith(`/${file}`)),
  ).length;
  return hit / expectFiles.length;
}

function average(results: CaseResult[], pick: (result: CaseResult) => number): number {
  if (results.length === 0) return 0;
  return results.reduce((sum, result) => sum + pick(result), 0) / results.length;
}

/**
 * 跑一组基准题：每题独立执行 Agent，再用同一套引用校验器打分。
 * 录制模式下每题的响应按 id 落盘，回放模式完全不联网。
 */
export async function runSuite(
  suite: GoldenSuite,
  deps: EvalDeps,
): Promise<{ results: CaseResult[]; summary: SuiteSummary }> {
  const results: CaseResult[] = [];
  const defaultMaxToolCalls = suite.defaultMaxToolCalls ?? 12;

  for (const testCase of suite.cases) {
    const started = Date.now();
    const cassetteFile = deps.cassetteDir ? `${deps.cassetteDir}/${testCase.id}.jsonl` : undefined;

    const recorder = deps.mode === 'record' ? new CassetteRecorder() : undefined;
    const replay =
      deps.mode === 'replay' && cassetteFile ? loadCassette(cassetteFile) : undefined;

    const client = createModelClient(deps.config, {
      ...(recorder ? { recorder } : {}),
      ...(replay ? { replay } : {}),
    });

    const run = await runAgent({
      question: testCase.question,
      repoRoot: deps.repoRoot,
      repoLabel: deps.repoLabel,
      fileCount: deps.fileCount,
      maxRounds: deps.maxRounds ?? deps.config.maxRounds,
      client,
      host: deps.host,
      ...(deps.onEvent ? { onEvent: (event: AgentEvent) => deps.onEvent!(testCase.id, event) } : {}),
    });

    if (recorder && cassetteFile) recorder.save(cassetteFile);

    const report = verifyCitations(deps.repoRoot, run.answer);
    const hitRate = fileHit(report, testCase.expectFiles);
    const keywordRate = keywordHit(run.answer, testCase.expectKeywords);
    const maxToolCalls = testCase.maxToolCalls ?? defaultMaxToolCalls;

    const failures: string[] = [];
    if (run.stopReason === 'error') failures.push(`执行错误：${run.error ?? '未知'}`);
    if (report.total === 0) failures.push('没有任何引用');
    if (report.ratio < 0.8) failures.push(`引用通过率 ${(report.ratio * 100).toFixed(0)}% < 80%`);
    if (hitRate < 1) failures.push(`期望文件未全部命中（${(hitRate * 100).toFixed(0)}%）`);
    if (keywordRate < 1) failures.push('答案缺少期望关键词');
    if (run.toolCalls.length > maxToolCalls) {
      failures.push(`工具调用 ${run.toolCalls.length} 次 > 上限 ${maxToolCalls}`);
    }

    results.push({
      id: testCase.id,
      question: testCase.question,
      stopReason: run.stopReason,
      citationRatio: report.ratio,
      totalCitations: report.total,
      verifiedCitations: report.verified,
      fileHit: hitRate,
      keywordHit: keywordRate,
      toolCalls: run.toolCalls.length,
      rounds: run.rounds,
      totalTokens: run.usage.totalTokens,
      durationMs: Date.now() - started,
      pass: failures.length === 0,
      failures,
      answer: run.answer,
      citations: report,
    });
  }

  const passed = results.filter((result) => result.pass).length;
  const latencies = results.map((result) => result.durationMs).sort((a, b) => a - b);

  return {
    results,
    summary: {
      name: suite.name,
      cases: results.length,
      passed,
      passRate: results.length === 0 ? 0 : passed / results.length,
      avgCitationRatio: average(results, (result) => result.citationRatio),
      avgFileHit: average(results, (result) => result.fileHit),
      avgToolCalls: average(results, (result) => result.toolCalls),
      avgTokens: average(results, (result) => result.totalTokens),
      p50LatencyMs: latencies[Math.floor((latencies.length - 1) / 2)] ?? 0,
    },
  };
}

export function renderSummary(summary: SuiteSummary): string {
  const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;
  return [
    `基准：${summary.name}`,
    `通过：${summary.passed}/${summary.cases}（${percent(summary.passRate)}）`,
    `平均引用通过率：${percent(summary.avgCitationRatio)}`,
    `平均期望文件命中：${percent(summary.avgFileHit)}`,
    `平均工具调用：${summary.avgToolCalls.toFixed(1)} 次`,
    `平均 token：${Math.round(summary.avgTokens)}`,
    `P50 时延：${summary.p50LatencyMs} ms`,
  ].join('\n');
}

export function renderCaseLine(result: CaseResult): string {
  const mark = result.pass ? '✓' : '✗';
  const ratio = `${(result.citationRatio * 100).toFixed(0)}%`;
  const tail = result.failures.length > 0 ? `  ← ${result.failures.join('；')}` : '';
  return `  ${mark} ${result.id.padEnd(18)} 引用 ${ratio.padStart(4)}  工具 ${String(result.toolCalls).padStart(2)} 次  ${String(result.durationMs).padStart(6)} ms${tail}`;
}
