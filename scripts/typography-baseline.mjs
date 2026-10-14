#!/usr/bin/env node
/**
 * 排版基线图回归（v0.36）。
 *
 * 判据形态：**产物层**。每套主题 × 每份样例一张 PNG，改动后重拍并逐像素比对，
 * 超过阈值即红。为什么不能只靠结构断言——mdcore 的 151 条测试能证"标题有两个
 * span"，证不了"改完还好看"；而排版恰恰是观感问题。
 *
 * 用法：
 *   node scripts/typography-baseline.mjs            # 比对（门禁用这个）
 *   node scripts/typography-baseline.mjs --update   # 重录基线（确认改动是对的之后）
 *
 * 退出码：
 *   0 = 全部在阈值内（或刚重录）
 *   1 = 有图超阈值 / 尺寸变化 → 门禁红
 *   2 = 环境问题（Electron 起不来、构建失败、页面没接口）→ 门禁打印警告但**不算通过**
 *
 * 可比性：基线只保证"同机同 Chromium 同字体"可比。manifest 记 platform/Chromium
 * 版本/字体探针；换机器或字体后应当 `--update` 重录，而不是把阈值放大——那样判据
 * 就只剩"没报错"了。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MDCORE = path.join(ROOT, 'packages/mdcore');
const BASELINE_DIR = path.join(MDCORE, 'tests/baselines/typography');
const BUILD_DIR = path.join(MDCORE, 'dist-typography');
const MANIFEST = path.join(BASELINE_DIR, 'manifest.json');

/** 允许的像素差异比例。参考仓库的 e2e 用 0.3%；我们取 0.5% 留一点抗锯齿余量 */
const THRESHOLD = 0.005;

const update = process.argv.includes('--update');

function fail(message) {
  process.stderr.write(`TYPOGRAPHY_BASELINE: ${message}\n`);
  process.exit(2);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// ---------- 1. 构建基线页面 ----------
let buildFailed = false;
try {
  run('pnpm', ['exec', 'vite', 'build', '--config', 'vite.typography.config.mjs'], { cwd: MDCORE });
} catch (err) {
  buildFailed = true;
  process.stderr.write(`${err.stdout ?? ''}${err.stderr ?? ''}\n`);
  fail('基线页面构建失败（vite build）');
}
void buildFailed;

const bundle = path.join(BUILD_DIR, 'typography.js');
if (!fs.existsSync(bundle)) fail(`构建产物缺失：${bundle}`);

const page = path.join(BUILD_DIR, 'index.html');
fs.writeFileSync(
  page,
  `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>typography baseline</title>
<style>html,body{margin:0;padding:0;background:#fff}</style></head>
<body><script src="./typography.js"></script></body></html>`,
  'utf-8',
);

/**
 * 定位 Electron 包。
 *
 * pnpm 工作区下根 node_modules **没有** electron 的软链（它在 .pnpm 里），
 * 所以查找要走两条链；而且 Node 侧只能拿到"可执行文件路径"（`nativeImage` 只在
 * Electron 运行时存在）——像素比对因此也放在 Electron 主进程里做。
 */
function resolveElectron() {
  try {
    return require(path.join(ROOT, 'node_modules/electron'));
  } catch {
    /* 继续走 .pnpm 兜底 */
  }
  try {
    const store = path.join(ROOT, 'node_modules/.pnpm');
    const dir = fs.readdirSync(store).find((d) => d.startsWith('electron@'));
    if (!dir) return null;
    return require(path.join(store, dir, 'node_modules/electron'));
  } catch {
    return null;
  }
}

// ---------- 2. 无头截图 + 比对（都在 Electron 里做） ----------
fs.mkdirSync(BASELINE_DIR, { recursive: true });
const tmpOut = path.join(BUILD_DIR, 'shots');
fs.rmSync(tmpOut, { recursive: true, force: true });
fs.mkdirSync(tmpOut, { recursive: true });
const reportPath = path.join(tmpOut, 'report.json');

const electron = resolveElectron();
if (!electron) fail('找不到 Electron（node_modules/electron）');

const result = spawnSync(electron, [path.join(ROOT, 'scripts/typography-electron-main.cjs')], {
  encoding: 'utf-8',
  env: {
    ...process.env,
    TYPOGRAPHY_PAGE: page,
    TYPOGRAPHY_OUT: tmpOut,
    TYPOGRAPHY_BASELINE: BASELINE_DIR,
    TYPOGRAPHY_REPORT: reportPath,
    TYPOGRAPHY_UPDATE: update ? '1' : '0',
    TYPOGRAPHY_THRESHOLD: String(THRESHOLD),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
});
if (result.status !== 0) {
  process.stderr.write(`${result.stderr ?? ''}`);
  fail(`Electron 截图/比对失败（exit ${result.status}）——环境问题，不算通过`);
}
if (!fs.existsSync(reportPath)) fail('截图进程没有留下 report');

// ---------- 3. 比对与报告（比对在 Electron 侧做：nativeImage 只在运行时存在） ----------
const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
let red = 0;
const rows = report.rows.map((row) => {
  if (row.status !== '一致' && row.status !== '已重录' && row.status !== '新增基线') red += 1;
  return row;
});

const manifest = { shots: report.shots, fontProbe: report.fontProbe, chrome: report.chrome };
if (update) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf-8');

let old = null;
try {
  old = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
} catch {
  old = null;
}
const envChanged = old ? old.fontProbe !== manifest.fontProbe || old.chrome !== manifest.chrome : false;

process.stdout.write('\n  排版基线图（产物层判据）\n');
for (const row of rows) {
  const ok = row.status === '一致' || row.status === '已重录' || row.status === '新增基线';
  process.stdout.write(
    `    ${ok ? '✓' : '✗'} ${row.id.padEnd(26)} ${row.status}${row.note ? ` (${row.note})` : ''}\n`,
  );
}
process.stdout.write(
  `    阈值 ${(THRESHOLD * 100).toFixed(1)}% · ${rows.length} 张 · 字体探针 ${manifest.fontProbe}px\n`,
);
if (envChanged) {
  process.stdout.write(
    '    ⚠ 字体探针或 Chromium 版本与基线不同 → 本轮读数不可比，确认无误后请 --update 重录\n',
  );
}
if (red > 0) {
  process.stderr.write(`TYPOGRAPHY_BASELINE: FAIL —— ${red} 张超阈值\n`);
  process.exit(1);
}
process.stdout.write('    TYPOGRAPHY_BASELINE: PASS\n');
