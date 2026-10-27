#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RepoAccessError, RepoSandbox, type RepoErrorCode } from '../repo/sandbox.js';
import { walkFiles } from '../repo/walk.js';
import { searchCode, globToRegExp } from '../repo/search.js';
import { outlineText, supportsOutline } from '../repo/outline.js';

const SERVER_NAME = 'citecode-repo';
const SERVER_VERSION = '0.1.0';

/** 单次 read_file 最多返回多少行，避免一次工具结果吃掉整个上下文。 */
const MAX_LINES_PER_READ = 400;
const DEFAULT_READ_LINES = 200;

/** 带索引签名，才能满足 MCP SDK 对 CallToolResult 的可扩展要求。 */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

const HINTS: Record<RepoErrorCode, string> = {
  outside_root: '只能访问仓库内相对路径，请去掉绝对路径与 ..',
  not_found: '文件或目录不存在，请先用 list_files 或 search_code 确认路径',
  not_a_file: '目标不是普通文件',
  denied: '该路径属于密钥/凭据，工具拒绝读取',
  too_large: '文件过大，请改用 startLine/endLine 分段读取',
  not_text: '二进制文件不参与阅读',
};

function failed(error: unknown): ToolResult {
  if (error instanceof RepoAccessError) {
    return {
      content: [{ type: 'text', text: `工具调用失败（${error.code}）：${error.message}\n提示：${HINTS[error.code]}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `工具调用失败：${(error as Error).message}` }],
    isError: true,
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 生成带行号的代码片段——行号是引用可验证的前提。 */
export function numberLines(rel: string, lines: string[], from: number, to: number, total: number): string {
  const width = String(to).length;
  const body = lines
    .map((line, index) => {
      const number = String(from + index).padStart(width, ' ');
      return `${number}│ ${line}`;
    })
    .join('\n');
  return [
    `${rel}（第 ${from}-${to} 行，共 ${total} 行）`,
    '引用格式：`路径:起始行-结束行`',
    '',
    body,
  ].join('\n');
}

export function createRepoServer(root: string): McpServer {
  const sandbox = new RepoSandbox(root);
  const maxFileBytes = Math.max(4, Number(process.env.CITECODE_MAX_FILE_KB ?? 100)) * 1024;

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        '这是一个只读代码仓库检索引擎。先用 list_files/outline 了解结构，用 search_code 定位，再用 read_file 读具体行段。回答必须引用「路径:行号」。',
    },
  );

  server.registerTool(
    'list_files',
    {
      title: '列出文件',
      description:
        '按目录或通配符列出仓库文件（含大小）。用于了解项目结构，比 read_file 更快得到全局。自动忽略 node_modules/.git/dist 等目录。',
      inputSchema: {
        dir: z.string().optional().describe('只看某个子目录，例如 src/agent'),
        pattern: z.string().optional().describe('文件名通配符，例如 *.ts 或 src/**/*.md'),
        limit: z.number().int().min(1).max(2000).optional().describe('最多返回多少条，默认 200'),
      },
    },
    async ({ dir, pattern, limit }) => {
      try {
        let files = walkFiles(sandbox.root).files;
        if (dir) {
          const prefix = dir.replace(/^\.\/+/, '').replace(/\/+$/, '');
          files = files.filter((file) => file.path === prefix || file.path.startsWith(`${prefix}/`));
        }
        if (pattern) {
          const regex = globToRegExp(pattern);
          files = files.filter((file) => regex.test(file.path) || regex.test(file.path.split('/').pop() ?? ''));
        }
        const cap = limit ?? 200;
        const shown = files.slice(0, cap);
        const lines = shown.map((file) => `${file.path}  (${formatSize(file.size)})`);
        const tail = files.length > shown.length ? `\n…还有 ${files.length - shown.length} 个文件未列出，请缩小 dir/pattern 范围` : '';
        return ok([`共 ${files.length} 个文件：`, ...lines, tail].join('\n'));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'read_file',
    {
      title: '读取文件片段',
      description: `读取仓库内文本文件并返回带行号的内容。大文件必须用 startLine/endLine 分段（单次最多 ${MAX_LINES_PER_READ} 行）。返回内容可直接用于引用。`,
      inputSchema: {
        path: z.string().describe('仓库内相对路径，例如 src/agent/loop.ts'),
        startLine: z.number().int().min(1).optional().describe('起始行（含），默认 1'),
        endLine: z.number().int().min(1).optional().describe('结束行（含），默认起始行 + 200'),
      },
    },
    async ({ path, startLine, endLine }) => {
      try {
        const { rel, text, bytes } = sandbox.readText(path, maxFileBytes);
        const lines = text.split(/\r?\n/);
        const total = lines.length;
        const from = Math.min(Math.max(1, startLine ?? 1), total);
        const requestedTo = endLine ?? from + DEFAULT_READ_LINES - 1;
        const to = Math.min(Math.max(from, requestedTo), total, from + MAX_LINES_PER_READ - 1);
        const slice = lines.slice(from - 1, to);
        const header = `${rel} · ${formatSize(bytes)} · 共 ${total} 行`;
        const notice =
          to < total ? `（还有 ${total - to} 行未读，可用 startLine=${to + 1} 继续）` : '';
        return ok([header, notice, numberLines(rel, slice, from, to, total)].filter(Boolean).join('\n'));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'search_code',
    {
      title: '搜索代码',
      description:
        '用正则或字面量在仓库文本文件中搜索，返回 `路径:行号: 内容`。定位函数定义、字符串、配置项的首选工具；找不到时换关键词或加宽 include。',
      inputSchema: {
        pattern: z.string().min(1).describe('搜索内容，默认按正则处理，例如 "async function \\w+"'),
        include: z.string().optional().describe('限定文件类型，例如 *.ts 或 src/**/*.py'),
        maxResults: z.number().int().min(1).max(300).optional().describe('最多返回多少条命中，默认 80'),
        ignoreCase: z.boolean().optional().describe('是否忽略大小写'),
        literal: z.boolean().optional().describe('true 表示按纯文本搜索，不解析正则'),
      },
    },
    async ({ pattern, include, maxResults, ignoreCase, literal }) => {
      try {
        const result = searchCode(sandbox.root, {
          pattern,
          include,
          maxResults: maxResults ?? 80,
          ignoreCase,
          literal,
        });
        if (result.hits.length === 0) {
          return ok(`没有命中（扫描 ${result.scannedFiles} 个文件）。建议：换同义词、放宽 include、或用 literal=true 按字面量搜索。`);
        }
        const lines = result.hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`);
        const tail = result.truncated ? `\n（已截断到 ${result.hits.length} 条，请收窄条件）` : '';
        return ok([`命中 ${result.hits.length} 条（扫描 ${result.scannedFiles} 个文件）：`, ...lines, tail].join('\n'));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'outline',
    {
      title: '文件结构大纲',
      description:
        '提取单个文件的顶层结构（函数/类/接口/标题）及其行号，适合在通读前快速定位。基于正则的轻量实现，不解析嵌套作用域。',
      inputSchema: { path: z.string().describe('仓库内相对路径') },
    },
    async ({ path }) => {
      try {
        const { rel, text } = sandbox.readText(path, maxFileBytes);
        if (!supportsOutline(rel)) {
          return ok(`${rel} 的类型不在大纲支持范围内（支持 ts/js/py/go/rs/java/kt/cs/md 等）。可直接用 read_file 阅读。`);
        }
        const symbols = outlineText(rel, text);
        if (symbols.length === 0) return ok(`${rel} 未识别出顶层符号，可用 read_file 直接阅读。`);
        const lines = symbols.map((symbol) => `${symbol.line}: [${symbol.kind}] ${symbol.name} — ${symbol.signature}`);
        return ok([`${rel} 共 ${symbols.length} 个顶层符号：`, ...lines].join('\n'));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'repo_stats',
    {
      title: '仓库统计',
      description: '统计文件数、总大小、各语言文件分布与最大的若干文件，用于判断代码规模与主语言。',
      inputSchema: {
        top: z.number().int().min(1).max(20).optional().describe('返回前 N 个最大文件，默认 8'),
      },
    },
    async ({ top }) => {
      try {
        const { files, truncated } = walkFiles(sandbox.root);
        const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        const byExt = new Map<string, { count: number; bytes: number }>();
        for (const file of files) {
          const name = file.path.split('/').pop() ?? file.path;
          const index = name.lastIndexOf('.');
          const ext = index > 0 ? name.slice(index).toLowerCase() : '(无后缀)';
          const entry = byExt.get(ext) ?? { count: 0, bytes: 0 };
          entry.count += 1;
          entry.bytes += file.size;
          byExt.set(ext, entry);
        }
        const extLines = [...byExt.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 12)
          .map(([ext, entry]) => `  ${ext.padEnd(12)} ${String(entry.count).padStart(5)} 个文件  ${formatSize(entry.bytes)}`);
        const largest = [...files]
          .sort((a, b) => b.size - a.size)
          .slice(0, top ?? 8)
          .map((file) => `  ${formatSize(file.size).padStart(9)}  ${file.path}`);

        return ok(
          [
            `文件总数：${files.length}${truncated ? '（已达上限，结果可能不完整）' : ''}`,
            `总大小：${formatSize(totalBytes)}`,
            '',
            '按后缀分布（前 12）：',
            ...extLines,
            '',
            `最大的 ${Math.min(top ?? 8, files.length)} 个文件：`,
            ...largest,
          ].join('\n'),
        );
      } catch (error) {
        return failed(error);
      }
    },
  );

  // 资源：把 README 作为可挂载上下文，展示 MCP 除工具外的能力面。
  server.registerResource(
    'readme',
    'repo://readme',
    { title: '仓库 README', mimeType: 'text/markdown', description: '仓库根目录的 README 原文（若存在）' },
    async (uri) => {
      try {
        const readme = ['README.md', 'readme.md', 'Readme.md', 'README.rst'].find((name) => {
          try {
            sandbox.readText(name, maxFileBytes);
            return true;
          } catch {
            return false;
          }
        });
        if (!readme) return { contents: [{ uri: uri.href, text: '该仓库没有 README 文件。' }] };
        return { contents: [{ uri: uri.href, text: sandbox.readText(readme, maxFileBytes).text }] };
      } catch {
        return { contents: [{ uri: uri.href, text: 'README 读取失败。' }] };
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const cliRoot = process.argv[2];
  const root = cliRoot ?? process.env.CITECODE_REPO_ROOT ?? process.cwd();
  const server = createRepoServer(root);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 注意：stdio 传输占用了 stdout，日志只能走 stderr。
  console.error(`[${SERVER_NAME}] 已启动，仓库根目录：${root}`);
}

const invokedDirectly = process.argv[1]?.endsWith('repo-server.js') || process.argv[1]?.endsWith('repo-server.ts');
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[${SERVER_NAME}] 启动失败：`, error);
    process.exit(1);
  });
}
