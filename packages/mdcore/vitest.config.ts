import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 并发上限（见 frontend/vite.config.ts 同名注释）：默认按 CPU 核数开 worker，
    // 10 核机器上就是 10 个 jsdom 进程，叠上浏览器与 swap 直接冻机
    maxWorkers: 4,
    pool: 'threads',
    // node 跑逻辑 + jsdom 提供 DOM（applyTheme / 微信适配器都操作 DOM）
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
