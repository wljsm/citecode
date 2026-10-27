import { readFileSync, statSync } from 'node:fs';
import { RepoAccessError, RepoSandbox } from '../repo/sandbox.js';

export type CitationStatus = 'verified' | 'missing_file' | 'out_of_range' | 'empty';

export interface CitationCheck {
  /** 回答里出现的原始写法，例如 `src/cli.ts:12-18` */
  raw: string;
  path: string;
  startLine: number;
  endLine: number;
  status: CitationStatus;
  detail?: string;
  /** 命中行的前几行内容，方便人工复核。 */
  snippet?: string;
}

export interface CitationReport {
  citations: CitationCheck[];
  total: number;
  verified: number;
  ratio: number;
  /** 被引用到的文件及次数，按次数降序。 */
  files: Array<{ path: string; count: number }>;
}

interface RawCitation {
  raw: string;
  path: string;
  startLine: number;
  endLine: number;
}

/**
 * 提取 `路径:行号` / `路径:起始-结束`。要求路径带扩展名，
 * 并排除 URL（`https://a.com/x.ts:1`）与时间（`12:30`）这类误伤。
 */
export function extractCitations(text: string): RawCitation[] {
  const pattern =
    /(?<![A-Za-z0-9_\-./])([A-Za-z0-9_][A-Za-z0-9_.\-]*(?:\/[A-Za-z0-9_.\-]+)*\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;
  const found: RawCitation[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(pattern)) {
    const raw = match[0]!;
    const path = match[1]!;
    const startLine = Number.parseInt(match[2]!, 10);
    const endLine = match[3] ? Number.parseInt(match[3], 10) : startLine;

    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;
    // URL 里的端口/路径不是代码引用。
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 12), match.index ?? 0);
    if (prefix.includes('://') || prefix.includes('www.')) continue;

    const key = `${path}:${startLine}-${endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ raw, path, startLine, endLine });
  }
  return found;
}

function lineCountOf(text: string): number {
  if (text === '') return 0;
  const lines = text.split(/\r?\n/);
  // 以换行结尾时 split 会多出一个空串，不应算作一行。
  if (lines.length > 0 && lines[lines.length - 1] === '') return lines.length - 1;
  return lines.length;
}

/** 回读仓库，逐条校验引用是否真实存在。这是与「仅要求模型引用」的本质区别。 */
export function verifyCitations(root: string, answer: string): CitationReport {
  const sandbox = new RepoSandbox(root);
  const raw = extractCitations(answer);
  const citations: CitationCheck[] = raw.map((item) => {
    const base = { raw: item.raw, path: item.path, startLine: item.startLine, endLine: item.endLine };
    try {
      const { rel, text } = sandbox.readText(item.path, 4 * 1024 * 1024);
      const total = lineCountOf(text);
      if (item.startLine < 1 || item.startLine > total) {
        return {
          ...base,
          path: rel,
          status: 'out_of_range',
          detail: `起始行 ${item.startLine} 超出文件总行数 ${total}`,
        };
      }
      const endLine = Math.min(Math.max(item.endLine, item.startLine), total);
      const lines = text.split(/\r?\n/).slice(item.startLine - 1, endLine);
      const snippet = lines.join('\n').trim();
      if (!snippet) {
        return { ...base, path: rel, endLine, status: 'empty', detail: '引用的行段为空' };
      }
      return {
        ...base,
        path: rel,
        endLine,
        status: 'verified',
        snippet: snippet.slice(0, 240),
        ...(endLine !== item.endLine ? { detail: `结束行已截断到 ${total}` } : {}),
      };
    } catch (error) {
      const detail =
        error instanceof RepoAccessError ? `${error.code}: ${error.message}` : (error as Error).message;
      return { ...base, status: 'missing_file', detail };
    }
  });

  const verified = citations.filter((item) => item.status === 'verified').length;
  const byFile = new Map<string, number>();
  for (const item of citations) {
    if (item.status !== 'verified') continue;
    byFile.set(item.path, (byFile.get(item.path) ?? 0) + 1);
  }
  const files = [...byFile.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

  return {
    citations,
    total: citations.length,
    verified,
    ratio: citations.length === 0 ? 0 : verified / citations.length,
    files,
  };
}

const STATUS_LABEL: Record<CitationStatus, string> = {
  verified: '通过',
  missing_file: '文件不存在',
  out_of_range: '行号越界',
  empty: '行段为空',
};

/** 终端的逐条校验视图。 */
export function renderCitationReport(report: CitationReport): string {
  if (report.total === 0) {
    return '引用校验：回答中没有任何 `路径:行号` 引用（0 条）。';
  }
  const percent = (report.ratio * 100).toFixed(0);
  const lines = [`引用校验：${report.verified}/${report.total} 通过（${percent}%）`];
  for (const item of report.citations) {
    const icon = item.status === 'verified' ? '✓' : '✗';
    const label = STATUS_LABEL[item.status];
    lines.push(`  ${icon} ${item.raw}  — ${label}${item.detail ? `（${item.detail}）` : ''}`);
  }
  return lines.join('\n');
}
