import type { CaseResult, EvalDeps, GoldenSuite, SuiteSummary } from './runner.js';
import { runSuite } from './runner.js';

/**
 * 消融实验：只切换「引用自校正」这一个变量，其余配置完全相同。
 *
 * 意义在于把「我觉得这个机制有用」变成「同一套题、同一个模型，关掉它引用通过率掉 X 个点」。
 * 面试里能拿得出对照数字，比任何形容词都硬。
 */

export interface AblationConfig {
  label: string;
  /** 用于目录/文件名，避免中文路径。 */
  slug: string;
  maxRepairs: number;
}

export interface AblationRun {
  label: string;
  slug: string;
  maxRepairs: number;
  summary: SuiteSummary;
  results: CaseResult[];
}

export interface AblationReport {
  suite: string;
  runs: AblationRun[];
  /** 被自校正救回来的题目。 */
  fixedCases: Array<{ id: string; from: number; to: number; repairs: number }>;
}

export const DEFAULT_ABLATION_CONFIGS: AblationConfig[] = [
  { label: '关闭自校正', slug: 'baseline', maxRepairs: 0 },
  { label: '开启自校正（2 轮）', slug: 'repair', maxRepairs: 2 },
];

export async function runAblation(
  suite: GoldenSuite,
  deps: Omit<EvalDeps, 'maxRepairs'>,
  configs: AblationConfig[] = DEFAULT_ABLATION_CONFIGS,
): Promise<AblationReport> {
  const runs: AblationRun[] = [];

  for (const config of configs) {
    const cassetteDir = deps.cassetteDir ? `${deps.cassetteDir}/${config.slug}` : undefined;
    const { results, summary } = await runSuite(suite, {
      ...deps,
      ...(cassetteDir ? { cassetteDir } : {}),
      maxRepairs: config.maxRepairs,
    });
    runs.push({ label: config.label, slug: config.slug, maxRepairs: config.maxRepairs, summary, results });
  }

  const baseline = runs[0];
  const treated = runs[runs.length - 1];
  const fixedCases: AblationReport['fixedCases'] = [];

  if (baseline && treated && baseline !== treated) {
    const byId = new Map(treated.results.map((result) => [result.id, result]));
    for (const before of baseline.results) {
      const after = byId.get(before.id);
      if (!after) continue;
      if (after.citationRatio > before.citationRatio + 1e-9) {
        fixedCases.push({
          id: before.id,
          from: before.citationRatio,
          to: after.citationRatio,
          repairs: after.repairs,
        });
      }
    }
  }

  return { suite: suite.name, runs, fixedCases };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function delta(from: number, to: number, unit = ''): string {
  const diff = to - from;
  if (Math.abs(diff) < 1e-9) return '持平';
  const sign = diff > 0 ? '+' : '−';
  const body = unit === '%' ? `${Math.abs(diff * 100).toFixed(1)}${unit}` : `${Math.abs(diff).toFixed(1)}${unit}`;
  return `${sign}${body}`;
}

/** Markdown 表格：可直接粘进 README。 */
export function renderAblation(report: AblationReport): string {
  const lines: string[] = [];
  lines.push(`消融实验：${report.suite}`);
  lines.push('');
  lines.push('| 配置 | 通过率 | 引用通过率 | 修正前 | 幻觉引用率 | 平均工具调用 | 平均 token | P50 时延 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const run of report.runs) {
    const s = run.summary;
    lines.push(
      `| ${run.label} | ${s.passed}/${s.cases} | ${percent(s.avgCitationRatio)} | ${percent(s.avgInitialCitationRatio)} | ${percent(s.hallucinatedRate)} | ${s.avgToolCalls.toFixed(1)} | ${Math.round(s.avgTokens)} | ${s.p50LatencyMs} ms |`,
    );
  }

  const baseline = report.runs[0];
  const treated = report.runs[report.runs.length - 1];
  if (baseline && treated && baseline !== treated) {
    const b = baseline.summary;
    const t = treated.summary;
    lines.push('');
    lines.push(
      `结论：只切换自校正这一个变量，引用通过率 ${percent(b.avgCitationRatio)} → ${percent(t.avgCitationRatio)}（${delta(b.avgCitationRatio, t.avgCitationRatio, '%')}），` +
        `幻觉引用率 ${percent(b.hallucinatedRate)} → ${percent(t.hallucinatedRate)}（${delta(b.hallucinatedRate, t.hallucinatedRate, '%')}），` +
        `代价是每题多 ${(t.avgToolCalls - b.avgToolCalls).toFixed(1)} 次工具调用、${Math.round(t.avgTokens - b.avgTokens)} token。`,
    );
  }

  if (report.fixedCases.length > 0) {
    lines.push('');
    lines.push('被修正的题目：');
    for (const item of report.fixedCases) {
      lines.push(
        `- ${item.id}：引用通过率 ${percent(item.from)} → ${percent(item.to)}（${item.repairs} 个修正回合）`,
      );
    }
  } else if (report.runs.length > 1) {
    lines.push('');
    lines.push('被修正的题目：无（本题库里没有题目触发修正，说明基线引用已足够准确）。');
  }

  return lines.join('\n');
}