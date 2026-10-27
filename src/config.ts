import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 运行时配置。优先读真实环境变量，其次读仓库根目录的 .env，
 * 最后落回默认值。这里不引入 dotenv：依赖越少，安装越可靠。
 */
export interface Config {
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
  maxRounds: number;
  maxTokens: number;
  temperature: number;
  maxFileKb: number;
  maxSearchHits: number;
  cassetteDir: string | undefined;
  replayFile: string | undefined;
}

/** 解析 .env 文本，支持 `KEY=value`、`export KEY=value`、引号包裹与 # 注释。 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    out[key] = value;
  }
  return out;
}

/** 读取 .env 并注入 process.env，但绝不覆盖已存在的真实环境变量。 */
export function loadEnvFile(file = resolve(process.cwd(), '.env')): void {
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat(raw ?? '');
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function loadConfig(): Config {
  loadEnvFile();
  return {
    apiKey: process.env.DEEPSEEK_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || undefined,
    baseUrl: (process.env.CITECODE_BASE_URL?.trim() || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: process.env.CITECODE_MODEL?.trim() || 'deepseek-chat',
    maxRounds: Math.round(num(process.env.CITECODE_MAX_ROUNDS, 24, 1, 80)),
    maxTokens: Math.round(num(process.env.CITECODE_MAX_TOKENS, 2048, 256, 8192)),
    temperature: num(process.env.CITECODE_TEMPERATURE, 0.2, 0, 1.5),
    maxFileKb: Math.round(num(process.env.CITECODE_MAX_FILE_KB, 100, 4, 4096)),
    maxSearchHits: Math.round(num(process.env.CITECODE_MAX_SEARCH_HITS, 80, 1, 500)),
    cassetteDir: process.env.CITECODE_CASSETTE_DIR?.trim() || undefined,
    replayFile: process.env.CITECODE_REPLAY?.trim() || undefined,
  };
}
