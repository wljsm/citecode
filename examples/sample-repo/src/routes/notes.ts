import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Session } from '../auth.js';
import type { MemoryStore } from '../store.js';

/** 请求体校验失败，路由层据此返回 400。 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface NoteInput {
  title: string;
  body: string;
}

/** 标题 1–80 字、正文最多 2000 字，超限直接拒绝。 */
export function validateNote(input: { title?: unknown; body?: unknown }): NoteInput {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (title.length === 0) throw new ValidationError('标题不能为空');
  if (title.length > 80) throw new ValidationError('标题不能超过 80 字');
  if (body.length > 2000) throw new ValidationError('正文不能超过 2000 字');
  return { title, body };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new ValidationError('请求体不是合法 JSON');
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

/**
 * 处理 /notes 相关路由，返回 true 表示已应答。
 * 调用方保证 session 已经通过鉴权。
 */
export async function handleNotes(
  store: MemoryStore,
  session: Session,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/notes' && req.method === 'GET') {
    send(res, 200, { notes: store.listNotes(session.userId) });
    return true;
  }

  if (url.pathname === '/notes' && req.method === 'POST') {
    const input = validateNote(await readJson(req));
    const note = store.createNote(session.userId, input.title, input.body);
    send(res, 201, { note });
    return true;
  }

  const match = /^\/notes\/([A-Za-z0-9_]+)$/.exec(url.pathname);
  if (match && req.method === 'DELETE') {
    const deleted = store.deleteNote(match[1]!, session.userId);
    send(res, deleted ? 200 : 404, { deleted });
    return true;
  }

  return false;
}
