import { createSalt, hashPassword } from './auth.js';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  salt: string;
}

export interface Note {
  id: string;
  ownerId: string;
  title: string;
  body: string;
  createdAt: number;
}

/**
 * 全内存存储：进程重启即清空。
 * 之所以不用数据库，是为了让样例仓库保持零依赖、便于阅读。
 */
export class MemoryStore {
  readonly users = new Map<string, User>();
  readonly notes = new Map<string, Note>();
  private sequence = 0;

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence.toString().padStart(4, '0')}`;
  }

  createUser(email: string, password: string): User {
    const salt = createSalt();
    const user: User = {
      id: this.nextId('user'),
      email: email.toLowerCase(),
      passwordHash: hashPassword(password, salt),
      salt,
    };
    this.users.set(user.id, user);
    return user;
  }

  findUserByEmail(email: string): User | undefined {
    const target = email.toLowerCase();
    for (const user of this.users.values()) {
      if (user.email === target) return user;
    }
    return undefined;
  }

  createNote(ownerId: string, title: string, body: string): Note {
    const note: Note = { id: this.nextId('note'), ownerId, title, body, createdAt: Date.now() };
    this.notes.set(note.id, note);
    return note;
  }

  /** 只返回属于该用户的笔记，越权访问在存储层就挡掉。 */
  listNotes(ownerId: string): Note[] {
    return [...this.notes.values()]
      .filter((note) => note.ownerId === ownerId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getNote(id: string, ownerId: string): Note | undefined {
    const note = this.notes.get(id);
    if (!note || note.ownerId !== ownerId) return undefined;
    return note;
  }

  deleteNote(id: string, ownerId: string): boolean {
    const note = this.notes.get(id);
    if (!note || note.ownerId !== ownerId) return false;
    return this.notes.delete(id);
  }
}

/** 预置一个演示账号与两条笔记，方便本地起服务后直接调接口。 */
export function seedStore(): MemoryStore {
  const store = new MemoryStore();
  const demo = store.createUser('demo@example.com', 'demo-password');
  store.createNote(demo.id, '第一条笔记', '记在内存里的内容');
  store.createNote(demo.id, '第二条笔记', '重启就会消失');
  return store;
}
