import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerSpec } from './host.js';

/**
 * 决定用哪种方式拉起 MCP Server：
 * 有构建产物就 `node dist/mcp/repo-server.js`，开发态（tsx 直跑）退回 TS 入口 + tsx 加载器。
 */
export function resolveRepoServerSpec(root: string): ServerSpec {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, 'repo-server.js');
  if (existsSync(built)) {
    return { name: 'repo', command: process.execPath, args: [built, root] };
  }
  const source = join(here, 'repo-server.ts');
  return { name: 'repo', command: process.execPath, args: ['--import', 'tsx', source, root] };
}
