import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 排版基线图的构建配置（v0.36）：把 fixtures/typography.ts 打成浏览器可直接加载的
 * 一次性包，供 scripts/typography-baseline.mjs 用 Electron 无头截图。
 *
 * 单独一份配置而不是复用测试配置：产物要的是「能进 <script> 的 IIFE」，
 * 跟测试运行环境无关（ESM 在 file:// 下会被 CORS 挡，所以必须 IIFE）。
 * 刻意不 import vite —— 配置文件自己是从临时目录被 require 的，解析不到依赖。
 */
const here = dirname(fileURLToPath(import.meta.url));

export default {
  build: {
    target: 'es2022',
    outDir: 'dist-typography',
    emptyOutDir: true,
    lib: {
      entry: resolve(here, 'fixtures/typography.ts'),
      name: 'MdTypography',
      formats: ['iife'],
      fileName: () => 'typography.js',
    },
    minify: false,
    sourcemap: false,
  },
  logLevel: 'warn',
};
