import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // node 跑逻辑 + jsdom 提供 DOM（applyTheme / 微信适配器都操作 DOM）
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
