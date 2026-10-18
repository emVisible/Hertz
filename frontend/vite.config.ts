/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  base: './', // 相对路径：支持 Electron file:// 加载打包产物（Wave 6）
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 3000,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    // 并发上限（原来用默认值 = CPU 核数，10 核机器上就是 10 个 jsdom worker）。
    //
    // 为什么卡：每个 jsdom worker 是独立 node 进程（100–200MB），10 个就是 1.5–2GB。
    // 而这台机器上 Chrome 常驻 6–8GB、swap 已经用掉 4GB——测试再叠上去，
    // 系统会直接卡死只能重启，而那种卡很难归罪到某一条测试头上。
    // 留 4 个 worker：并发还在，速度差得有限，内存峰值少一半。
    maxWorkers: 4,
    pool: 'threads',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    // 单个用例的整体预算（默认 5000ms）。宿主接线那几条渲染整页、链路长，
    // 放宽是为了不把「机器忙」判成「功能坏」。
    // 等待预算在 src/test/setup.ts 的 configure({ asyncUtilTimeout }) ——
    // **那个键属于 @testing-library，不是 vitest 配置项**，写在这里会被忽略。
    testTimeout: 30000,
  },
})
