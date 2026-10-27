import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, login, signToken, verifyPassword, verifyToken, AuthError } from '../src/auth.js';
import { seedStore } from '../src/store.js';
import { validateNote, ValidationError } from '../src/routes/notes.js';

test('密码哈希带盐，同密码不同盐结果不同', () => {
  const a = hashPassword('secret', 'salt-a');
  const b = hashPassword('secret', 'salt-b');
  assert.notEqual(a, b);
  assert.equal(hashPassword('secret', 'salt-a'), a);
});

test('登录成功返回 token，密码错误抛 AuthError', () => {
  const store = seedStore();
  const result = login(store, 'demo@example.com', 'demo-password');
  assert.ok(result.token.includes('.'));
  assert.throws(() => login(store, 'demo@example.com', 'wrong'), AuthError);
});

test('token 被篡改后校验失败', () => {
  const store = seedStore();
  const user = store.findUserByEmail('demo@example.com')!;
  assert.ok(verifyPassword(user, 'demo-password'));

  const token = signToken({ userId: user.id, email: user.email, issuedAt: Date.now() });
  assert.ok(verifyToken(token));
  assert.equal(verifyToken(`${token}tampered`), null);
  assert.equal(verifyToken(undefined), null);
});

test('笔记标题为空或过长会被拒绝', () => {
  assert.throws(() => validateNote({ title: '  ' }), ValidationError);
  assert.throws(() => validateNote({ title: 'x'.repeat(81) }), ValidationError);
  assert.deepEqual(validateNote({ title: ' 标题 ', body: ' 正文 ' }), { title: '标题', body: '正文' });
});
