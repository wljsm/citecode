import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from '../config.js';
import type { McpHost } from '../mcp/host.js';
import { createModelClient } from '../model/deepseek.js';
import { loadCassette } from '../model/cassette.js';
import { runAgent, type AgentEvent } from '../agent/loop.js';
import { renderPage, type PageOptions } from './page.js';
import { sourceView } from './source.js';
import type { WebPreset, WebRun } from './types.js';

export interface WebDeps {
  host: McpHost;
  config: Config;
  /** 被测仓库绝对路径。固定由启动参数给出，**不接受**客户端传入。 */
  repoRoot: string;
  repoLabel: string;
  fileCount: number;
  tools: string[];
  presets: WebPreset[];
  /** 有值则进入回放模式：只允许跑题库里的题，用对应 cassette，不联网。 */
  replayDir?: string;
  maxRepairs?: number;
}

const BODY_LIMIT = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function findPreset(deps: WebDeps, caseId: string | null, question: string): WebPreset | undefined {
  if (caseId) return deps.presets.find((preset) => preset.id === caseId);
  return deps.presets.find((preset) => preset.question === question);
}

export interface RunOutcome {
  run: WebRun;
}

/**
 * 跑一次 Agent。SSE 与快照导出共用这一条路径，保证两边看到的东西完全一致。
 */
export async function executeRun(
  deps: WebDeps,
  input: { question: string; caseId?: string | null },
  onEvent?: (event: AgentEvent) => void,
): Promise<RunOutcome> {
  const started = Date.now();
  const question = input.question.trim();
  const preset = findPreset(deps, input.caseId ?? null, question);

  let replay;
  if (deps.replayDir) {
    if (!preset) {
      throw new Error('回放模式只支持预设题目：请点击上方的题目标签，或换用实时模式。');
    }
    const file = resolve(deps.replayDir, `${preset.id}.jsonl`);
    if (!existsSync(file)) {
      throw new Error(`缺少 cassette：${file}`);
    }
    replay = loadCassette(file);
  }

  const client = createModelClient(deps.config, replay ? { replay } : {});

  const events: AgentEvent[] = [];
  const result = await runAgent({
    question,
    repoRoot: deps.repoRoot,
    repoLabel: deps.repoLabel,
    fileCount: deps.fileCount,
    maxRounds: deps.config.maxRounds,
    maxRepairs: deps.maxRepairs ?? 2,
    client,
    host: deps.host,
    onEvent: (event) => {
      events.push(event);
      onEvent?.(event);
    },
  });

  const run: WebRun = {
    question,
    ...(preset ? { caseId: preset.id } : {}),
    repoLabel: deps.repoLabel,
    fileCount: deps.fileCount,
    model: client.label,
    mode: deps.replayDir ? 'replay' : 'live',
    events,
    answer: result.answer,
    citations: {
      total: result.citations.total,
      verified: result.citations.verified,
      ratio: result.citations.ratio,
      items: result.citations.citations.map((item) => ({
        raw: item.raw,
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        status: item.status,
        ...(item.detail ? { detail: item.detail } : {}),
        ...(item.snippet ? { snippet: item.snippet } : {}),
      })),
    },
    stats: {
      rounds: result.rounds,
      toolCalls: result.toolCalls.length,
      tokens: result.usage.totalTokens,
      stopReason: result.stopReason,
      repairs: result.repairs,
      durationMs: Date.now() - started,
    },
    sources: {},
  };

  return { run };
}

function pageOptions(deps: WebDeps, snapshot?: WebRun): PageOptions {
  return {
    model: deps.config.model,
    mode: deps.replayDir ? 'replay' : 'live',
    repoLabel: deps.repoLabel,
    fileCount: deps.fileCount,
    tools: deps.tools,
    presets: deps.presets,
    ...(snapshot ? { snapshot } : {}),
  };
}

/** 导出自包含 HTML 快照：引用源码一并内联，双击即可打开，不需要服务。 */
export async function exportSnapshot(
  deps: WebDeps,
  outFile: string,
  caseId: string | undefined,
  question: string | undefined,
): Promise<WebRun> {
  const preset = caseId ? findPreset(deps, caseId, '') : undefined;
  const finalQuestion = question ?? preset?.question;
  if (!finalQuestion) {
    throw new Error('导出快照需要 --case <题目 id> 或 --question "<问题>"');
  }

  const { run } = await executeRun(deps, { question: finalQuestion, caseId: caseId ?? null });
  for (const item of run.citations.items) {
    run.sources[item.raw] = sourceView(deps.repoRoot, item.path, item.startLine, item.endLine, 3);
  }

  const html = renderPage(pageOptions(deps, run));
  writeFileSync(resolve(outFile), html, 'utf8');
  return run;
}

export interface ServerHandle {
  port: number;
  close: () => Promise<void>;
}

export async function startWebServer(
  deps: WebDeps,
  options: { port: number; host?: string },
): Promise<ServerHandle> {
  const host = options.host ?? '127.0.0.1';

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.writableEnded) return;
      sendJson(res, 500, { message: (error as Error).message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = renderPage(pageOptions(deps));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/meta') {
      sendJson(res, 200, {
        repo: deps.repoLabel,
        fileCount: deps.fileCount,
        model: deps.config.model,
        mode: deps.replayDir ? 'replay' : 'live',
        tools: deps.tools,
        presets: deps.presets,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/source') {
      const path = url.searchParams.get('path');
      const start = Number.parseInt(url.searchParams.get('start') ?? '1', 10);
      const end = Number.parseInt(url.searchParams.get('end') ?? String(start), 10);
      if (!path) {
        sendJson(res, 400, { message: '缺少 path 参数' });
        return;
      }
      if (!Number.isFinite(start) || start < 1) {
        sendJson(res, 400, { message: 'start 必须是正整数' });
        return;
      }
      sendJson(res, 200, sourceView(deps.repoRoot, path, start, Number.isFinite(end) ? end : start));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ask') {
      let parsed: { question?: unknown; caseId?: unknown };
      try {
        parsed = JSON.parse(await readBody(req)) as { question?: unknown; caseId?: unknown };
      } catch (error) {
        sendJson(res, 400, { message: `请求体不是合法 JSON：${(error as Error).message}` });
        return;
      }

      const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
      const caseId = typeof parsed.caseId === 'string' ? parsed.caseId : null;
      if (!question) {
        sendJson(res, 400, { message: '问题不能为空' });
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const send = (name: string, payload: unknown): void => {
        if (res.writableEnded) return;
        res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      try {
        const { run } = await executeRun(deps, { question, caseId }, (event) => send('agent', event));
        send('done', run);
      } catch (error) {
        send('error', { message: (error as Error).message });
      } finally {
        res.end();
      }
      return;
    }

    sendJson(res, 404, { message: `未知路由：${req.method} ${url.pathname}` });
  }

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      server.off('error', reject);
      resolvePromise();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    port,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}