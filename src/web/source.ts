import { RepoSandbox, RepoAccessError } from '../repo/sandbox.js';
import type { SourceView } from './types.js';

/**
 * 取一段带行号的源码，供右栏定位引用。
 *
 * 上下文由调用方给：Web 端点引用时只带 2 行上下文，导出快照时可以带更多。
 * 读取一律走 RepoSandbox，所以超出仓库、软链逃逸、密钥文件依然会被拦下。
 */
export function sourceView(
  root: string,
  path: string,
  start: number,
  end: number,
  context = 2,
): SourceView {
  try {
    const sandbox = new RepoSandbox(root);
    const { rel, text } = sandbox.readText(path, 4 * 1024 * 1024);
    const all = text.split(/\r?\n/);
    if (all.length > 0 && all[all.length - 1] === '') all.pop();

    const total = all.length;
    const from = Math.max(1, Math.min(start, total) - context);
    const to = Math.max(from, Math.min(end, total) + context);

    const lines = [];
    for (let n = from; n <= to; n += 1) {
      lines.push({ n, text: all[n - 1] ?? '' });
    }

    return { path: rel, start: from, end: to, lines };
  } catch (error) {
    const detail =
      error instanceof RepoAccessError ? `${error.code}: ${error.message}` : (error as Error).message;
    return { path, start, end, lines: [], error: detail };
  }
}

export { RepoSandbox };