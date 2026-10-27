import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkFiles } from './walk.js';

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchOptions {
  pattern: string;
  /** 只搜索匹配该 glob 的文件，例如 `*.ts` 或 `src/**\/*.ts`。 */
  include?: string;
  maxResults?: number;
  maxFiles?: number;
  maxBytesPerFile?: number;
  ignoreCase?: boolean;
  /** 当作纯文本搜索，不做正则解析。 */
  literal?: boolean;
}

export interface SearchResult {
  hits: SearchHit[];
  scannedFiles: number;
  truncated: boolean;
}

/** 把简化版 glob 转成正则：`**` 匹配任意层级，`*` 匹配单层，`?` 匹配单字符。 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesInclude(path: string, include: string | undefined): boolean {
  if (!include) return true;
  const patterns = include.split(',').map((item) => item.trim()).filter(Boolean);
  return patterns.some((pattern) => {
    const normalised = pattern.replace(/^\.\//, '');
    if (!normalised.includes('/')) {
      // 不含目录的写法只匹配文件名，符合直觉。
      const name = path.split('/').pop() ?? path;
      return globToRegExp(normalised).test(name);
    }
    return globToRegExp(normalised).test(path);
  });
}

/**
 * 在仓库文本文件里逐行搜索，返回带行号的命中。
 * 故意保持字面匹配优先——行号必须准确，引用才能被回读校验。
 */
export function searchCode(root: string, options: SearchOptions): SearchResult {
  const maxResults = options.maxResults ?? 80;
  const maxFiles = options.maxFiles ?? 5_000;
  const maxBytesPerFile = options.maxBytesPerFile ?? 200 * 1024;

  const flags = options.ignoreCase ? 'i' : '';
  let regex: RegExp;
  try {
    regex = new RegExp(options.literal ? escapeRegExp(options.pattern) : options.pattern, flags);
  } catch (error) {
    throw new Error(`搜索模式不是合法正则：${(error as Error).message}`);
  }

  const { files } = walkFiles(root, { maxFiles });
  const hits: SearchHit[] = [];
  let scannedFiles = 0;

  for (const file of files) {
    if (hits.length >= maxResults) break;
    if (file.size > maxBytesPerFile) continue;
    if (!matchesInclude(file.path, options.include)) continue;

    let text: string;
    try {
      text = readFileSync(join(root, file.path), 'utf8');
    } catch {
      continue;
    }
    scannedFiles += 1;

    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!regex.test(line)) continue;
      // 重置 lastIndex，避免带 g 标志的正则在不同行间跳变。
      regex.lastIndex = 0;
      hits.push({ path: file.path, line: index + 1, text: line.trim().slice(0, 300) });
      if (hits.length >= maxResults) break;
    }
  }

  return { hits, scannedFiles, truncated: hits.length >= maxResults };
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
