import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isBinaryPath, isDeniedPath, isIgnoredEntry } from './sandbox.js';

export interface FileEntry {
  /** 仓库内相对路径，统一使用 `/`。 */
  path: string;
  size: number;
}

export interface WalkOptions {
  /** 最多返回多少个文件，防止超大仓库撑爆上下文。 */
  maxFiles?: number;
  /** 是否跳过图片/压缩包等二进制文件，默认跳过。 */
  skipBinary?: boolean;
  /** 只保留这些后缀，例如 ['.ts', '.md']。 */
  extensions?: string[];
}

export interface WalkResult {
  files: FileEntry[];
  truncated: boolean;
  visited: number;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * 广度优先遍历仓库文件。忽略依赖/构建目录与密钥文件，
 * 按路径排序后返回，保证同一仓库多次列举的结果稳定。
 */
export function walkFiles(root: string, options: WalkOptions = {}): WalkResult {
  const maxFiles = options.maxFiles ?? 20_000;
  const skipBinary = options.skipBinary ?? true;
  const extensions = options.extensions?.map((ext) => ext.toLowerCase());

  const files: FileEntry[] = [];
  const queue: string[] = [''];
  let visited = 0;
  let truncated = false;

  while (queue.length > 0) {
    const relDir = queue.shift()!;
    const absDir = relDir ? join(root, relDir) : root;

    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue; // 权限不足或无权限读取的目录直接跳过
    }

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = join(root, relPath);

      if (entry.isSymbolicLink()) continue; // 软链可能逃出仓库或形成环
      if (isDeniedPath(relPath)) continue;

      if (entry.isDirectory()) {
        if (isIgnoredEntry(entry.name, true)) continue;
        if (relPath.split('/').some((part) => part.startsWith('.'))) continue;
        queue.push(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isIgnoredEntry(entry.name, false)) continue;
      if (skipBinary && isBinaryPath(relPath)) continue;
      if (extensions && !extensions.some((ext) => relPath.toLowerCase().endsWith(ext))) continue;

      let size = 0;
      try {
        size = statSync(absPath).size;
      } catch {
        continue;
      }

      visited += 1;
      if (files.length >= maxFiles) {
        truncated = true;
        continue;
      }
      files.push({ path: toPosix(relative(root, absPath)), size });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated, visited };
}
