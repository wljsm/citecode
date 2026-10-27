import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AuthError, login, verifyToken, type Session } from './auth.js';
import { handleNotes, ValidationError } from './routes/notes.js';
import { seedStore } from './store.js';

const PORT = Number(process.env.PORT ?? 3000);

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

const store = seedStore();

/**
 * 唯一入口：所有请求先进这里，再做「登录」或「带 token 的鉴权」分流。
 * 返回 401 的分支共有三处：缺 token、token 非法、登录信息不完整。
 */
export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const header = req.headers.authorization;
    const session: Session | null = verifyToken(header?.replace(/^Bearer\s+/i, ''));

    // 登录不需要 token。
    if (url.pathname === '/login' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const result = login(store, String(body.email ?? ''), String(body.password ?? ''));
        send(res, 200, { token: result.token });
      } catch (error) {
        if (error instanceof AuthError) return send(res, 401, { error: error.message });
        throw error;
      }
      return;
    }

    // 其余接口一律要求有效 token。
    if (!session) {
      send(res, 401, { error: '缺少或无效的 token' });
      return;
    }

    try {
      const handled = await handleNotes(store, session, req, res);
      if (!handled) send(res, 404, { error: '路由不存在' });
    } catch (error) {
      if (error instanceof ValidationError) return send(res, 400, { error: error.message });
      send(res, 500, { error: '服务内部错误' });
    }
  });
}

createApp().listen(PORT, () => {
  console.log(`sample-notes-api 已启动：http://localhost:${PORT}`);
});
