import { realpathSync, statSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type RepoErrorCode =
  | 'outside_root'
  | 'not_found'
  | 'not_a_file'
  | 'denied'
  | 'too_large'
  | 'not_text';

/** 带错误码的仓库访问异常，便于 MCP 层把失败原因原样交给模型。 */
export class RepoAccessError extends Error {
  constructor(
    readonly code: RepoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RepoAccessError';
  }
}

/** 任何情况下都不读取的文件名（密钥、证书、凭据）。 */
const DENY_NAMES = [
  '.env',
  '.env.local',
  '.npmrc',
  'secrets.toml',
  'id_rsa',
  'id_ed25519',
  'id_dsa',
  '.netrc',
  '.pgpass',
];

const DENY_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks'];

/** 永不遍历的目录（依赖、构建产物、缓存、虚拟环境）。 */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'target',
  'vendor',
  '.idea',
  '.vscode',
  'tmp',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);

/** 体积大且对阅读没有帮助的文本文件。 */
const IGNORED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'uv.lock',
  'poetry.lock',
  'Cargo.lock',
  'composer.lock',
  'go.sum',
  'Gemfile.lock',
  'bun.lockb',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif', '.bmp',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.bin', '.class', '.jar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.webm',
  '.pyc', '.pyo', '.wasm', '.sqlite', '.db',
]);

export function extensionOf(path: string): string {
  const idx = path.lastIndexOf('.');
  if (idx <= 0) return '';
  return path.slice(idx).toLowerCase();
}

export function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(path));
}

export function isIgnoredEntry(name: string, isDir: boolean): boolean {
  if (isDir) return IGNORED_DIRS.has(name);
  return IGNORED_FILES.has(name);
}

export function isDeniedPath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (DENY_NAMES.includes(name)) return true;
  if (name.startsWith('.env.')) return true;
  return DENY_EXTENSIONS.includes(extensionOf(name));
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * 仓库只读沙箱：所有工具调用都必须经过它。
 * 三层防护——拒绝绝对路径、拒绝 `..` 逃逸、解析软链后再次校验真实路径。
 */
export class RepoSandbox {
  readonly root: string;
  private readonly realRoot: string;

  constructor(root: string) {
    let stat;
    try {
      stat = statSync(root);
    } catch {
      throw new RepoAccessError('not_found', `仓库路径不存在：${root}`);
    }
    if (!stat.isDirectory()) {
      throw new RepoAccessError('not_a_file', `仓库路径不是目录：${root}`);
    }
    this.root = resolve(root);
    this.realRoot = realpathSync(this.root);
  }

  /** 把用户/模型给的相对路径解析为绝对路径，并确认它仍在仓库内。 */
  resolve(input: string): { abs: string; rel: string } {
    const cleaned = (input ?? '').trim().replace(/^\.\/+/, '');
    if (!cleaned) throw new RepoAccessError('outside_root', '路径为空');
    if (isAbsolute(cleaned) || /^[A-Za-z]:/.test(cleaned)) {
      throw new RepoAccessError('outside_root', `只接受仓库内相对路径，收到绝对路径：${cleaned}`);
    }
    if (cleaned.split(/[\\/]/).includes('..')) {
      throw new RepoAccessError('outside_root', `路径不允许包含 ..：${cleaned}`);
    }
    if (isDeniedPath(cleaned)) {
      throw new RepoAccessError('denied', `该文件属于密钥/凭据类，禁止读取：${cleaned}`);
    }

    const abs = resolve(this.root, cleaned);
    const relToRoot = relative(this.root, abs);
    if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) {
      throw new RepoAccessError('outside_root', `路径越出仓库范围：${cleaned}`);
    }

    // 软链可能指向仓库之外，必须按真实路径再查一次。
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      // 不存在时保留原路径，交给调用方报 not_found。
    }
    const realRel = relative(this.realRoot, real);
    if (real !== abs && (realRel.startsWith('..') || isAbsolute(realRel))) {
      throw new RepoAccessError('outside_root', `软链指向了仓库之外：${cleaned}`);
    }

    return { abs, rel: toPosix(relToRoot) };
  }

  /** 读取文本文件；超过 maxBytes 抛 too_large，避免把整个仓库塞进上下文。 */
  readText(input: string, maxBytes: number): { rel: string; text: string; bytes: number } {
    const { abs, rel } = this.resolve(input);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      throw new RepoAccessError('not_found', `文件不存在：${rel}`);
    }
    if (!stat.isFile()) throw new RepoAccessError('not_a_file', `不是普通文件：${rel}`);
    if (isBinaryPath(rel)) throw new RepoAccessError('not_text', `二进制文件不参与阅读：${rel}`);
    if (stat.size > maxBytes) {
      throw new RepoAccessError(
        'too_large',
        `文件 ${rel} 有 ${(stat.size / 1024).toFixed(1)} KB，超过 ${(maxBytes / 1024).toFixed(0)} KB 上限，请用 startLine/endLine 分段读取`,
      );
    }
    const buffer = readFileSync(abs);
    const text = buffer.toString('utf8');
    // UTF-8 解码出现替换符，说明大概率是二进制。
    if (text.includes('\uFFFD') && buffer.subarray(0, 512).includes(0)) {
      throw new RepoAccessError('not_text', `文件看起来是二进制：${rel}`);
    }
    return { rel, text, bytes: stat.size };
  }
}
