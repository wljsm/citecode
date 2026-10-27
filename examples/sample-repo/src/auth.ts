import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MemoryStore, User } from './store.js';

/** 鉴权失败的统一错误类型，路由层据此返回 401。 */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface Session {
  userId: string;
  email: string;
  issuedAt: number;
}

const TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * 用 sha256 + 随机盐做密码哈希。
 * 生产环境应换成 scrypt/argon2，这里为了零依赖刻意简化。
 */
export function hashPassword(password: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

export function createSalt(): string {
  return randomBytes(16).toString('hex');
}

/** 定长比较，避免把哈希差异泄漏成时间差。 */
export function verifyPassword(user: User, password: string): boolean {
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = Buffer.from(hashPassword(password, user.salt), 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** 登录：查用户 → 校验密码 → 签发 token。失败一律抛 AuthError。 */
export function login(store: MemoryStore, email: string, password: string): { token: string; session: Session } {
  const user = store.findUserByEmail(email);
  if (!user) throw new AuthError('用户不存在');
  if (!verifyPassword(user, password)) throw new AuthError('密码错误');

  const session: Session = { userId: user.id, email: user.email, issuedAt: Date.now() };
  return { token: signToken(session), session };
}

/** token 里只放最小信息，签名用进程级密钥（重启即失效）。 */
const TOKEN_SECRET = process.env.TOKEN_SECRET ?? 'sample-repo-secret';

function sign(payload: string): string {
  return createHash('sha256').update(`${payload}.${TOKEN_SECRET}`).digest('hex').slice(0, 32);
}

export function signToken(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** 校验 token：签名不对、过期、解析失败都返回 null。 */
export function verifyToken(token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  if (sign(payload) !== signature) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session;
    if (Date.now() - session.issuedAt > TOKEN_TTL_MS) return null;
    return session;
  } catch {
    return null;
  }
}
