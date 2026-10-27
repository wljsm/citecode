import type { CitationCheck, CitationReport, CitationStatus } from '../verify/citations.js';

/**
 * 引用自校正。
 *
 * 这里的核心假设：模型不是"不会写引用"，而是"没核对过"。把校验失败的具体理由
 * 回灌给它，并允许它重新调用工具，多数错误引用可以自愈——而且这个过程是可测量的。
 */

const STATUS_HINT: Record<CitationStatus, string> = {
  verified: '通过',
  missing_file: '文件不存在或不在仓库内',
  out_of_range: '行号越界',
  empty: '行段为空',
};

/** 单次修正提示里最多列多少条失败，避免把上下文撑爆。 */
const MAX_LISTED_FAILURES = 8;

export function failedCitations(report: CitationReport): CitationCheck[] {
  return report.citations.filter((citation) => citation.status !== 'verified');
}

/** 回答里一条引用都没有时，也需要修正——「没有证据」和「证据是错的」一样不可用。 */
export function needsRepair(report: CitationReport, answer: string): boolean {
  if (failedCitations(report).length > 0) return true;
  return report.total === 0 && answer.trim().length >= 120;
}

function describeFailure(citation: CitationCheck): string {
  const hint = STATUS_HINT[citation.status];
  const detail = citation.detail ? `：${citation.detail}` : '';
  return `- \`${citation.raw}\` —— ${hint}${detail}`;
}

/**
 * 构造回灌给模型的修正指令。返回 null 表示无需修正。
 */
export function buildRepairPrompt(report: CitationReport, answer: string): string | null {
  if (!needsRepair(report, answer)) return null;

  const failures = failedCitations(report);

  if (failures.length === 0) {
    return [
      '系统校验发现：你的回答里没有任何 `路径:行号` 形式的引用。',
      '',
      '请输出一份**完整的新回答**（覆盖原回答，不要只给补丁）：',
      '1. 对每个结论，先用 search_code 或 read_file 确认位置，再用 `路径:行号` 标注来源；',
      '2. 无法确认的内容单独写成「未能确认：…」，不要用常识补全；',
      '3. 不要编造任何路径或行号——它们会被逐条回读校验。',
    ].join('\n');
  }

  const listed = failures.slice(0, MAX_LISTED_FAILURES).map(describeFailure);
  const omitted = failures.length > MAX_LISTED_FAILURES ? `\n- …另有 ${failures.length - MAX_LISTED_FAILURES} 条未列出` : '';

  return [
    `系统对你的回答做了引用回读校验：${report.total} 条引用里有 ${failures.length} 条没有通过。`,
    '',
    '未通过的引用：',
    ...listed,
    omitted,
    '',
    '请输出一份**完整的新回答**（覆盖原回答，不要只给补丁），并按以下步骤修正：',
    '1. 对每条未通过的引用，用 search_code 找到真实位置，或用 read_file 确认行号范围；',
    '2. 找不到就删掉这条引用；若该结论因此失去证据，改写为「未能确认：…」；',
    '3. 原来已通过的引用要保留，不要为了省事删光所有引用；',
    '4. 修正时不要引入新的、未经验证的路径或行号。',
  ].join('\n');
}