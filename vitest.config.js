import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // 用 forks 池：每个测试文件在独立 Node 子进程里跑，原生支持 node:sqlite 等
    // 新内建模块。默认 threads 池走 Vite 转换器，它的 Node 内建列表还没收录 sqlite。
    pool: 'forks',
    // 多个测试文件共用同一个 state.db，并行跑会撞 SQLite 锁
    fileParallelism: false,
    server: {
      deps: {
        external: [/^node:/, 'sqlite'],
      },
    },
  },
});
