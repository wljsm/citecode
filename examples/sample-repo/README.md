# Sample Notes API

一个只有几十行的内存版笔记服务，用来给 CiteCode 做真实的「读代码」靶子：
有 HTTP 入口、鉴权、路由、存储和测试，足够回答调用链类问题，又不至于太大。

```bash
node --experimental-strip-types src/app.ts   # Node 22+ 可直接跑
```

| 文件 | 职责 |
| --- | --- |
| `src/app.ts` | HTTP 入口与鉴权中间层 |
| `src/auth.ts` | 密码哈希、登录、token 签发与校验 |
| `src/routes/notes.ts` | 笔记的增删查接口 |
| `src/store.ts` | 内存存储与种子数据 |
| `tests/app.test.ts` | 针对鉴权与路由的测试 |
