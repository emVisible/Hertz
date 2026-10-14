/**
 * 排版基线图的 Electron 主进程（v0.36，CommonJS——Electron 主进程不走 ESM）。
 *
 * 职责四件，刻意不放第五件：
 *   1. 加载构建产物页面（file:// IIFE，无模块加载器）
 *   2. 逐张截图 → PNG
 *   3. **逐像素比对**（比对也在这里做：nativeImage 只在 Electron 运行时存在，
 *      Node 侧 require('electron') 拿到的是可执行文件路径，没有 nativeImage）
 *   4. 量字体探针（字体栈变了基线就不可比，必须记账）
 *
 * 为什么用 Electron 而不是 Playwright：本仓本来就在 Electron 里跑，前端渲染真相源
 * 就是这个 Chromium；再引一个浏览器就多一份"截图环境与用户所见不一致"的风险。
 *
 * 退出码：0 全部完成 / 1 截图或比对失败 / 2 页面缺失。
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const PAGE = process.env.TYPOGRAPHY_PAGE;
const OUT_DIR = process.env.TYPOGRAPHY_OUT;
const BASELINE_DIR = process.env.TYPOGRAPHY_BASELINE;
const REPORT = process.env.TYPOGRAPHY_REPORT;
const UPDATE = process.env.TYPOGRAPHY_UPDATE === '1';
const THRESHOLD = Number(process.env.TYPOGRAPHY_THRESHOLD ?? '0.005');

/** 只截「那张图」而不是整个视口：body.scrollWidth 等于窗口宽，整屏截图图里会带大片白边 */
async function captureShot(win, shot) {
  const rect = await win.webContents.executeJavaScript(
    `(() => {
      document.body.innerHTML = '';
      document.body.style.margin = '0';
      document.body.style.background = '#ffffff';
      const shots = window.__typographyShots();
      const s = shots.find((x) => x.id === ${JSON.stringify(shot.id)}) || shots[0];
      const holder = document.createElement('div');
      holder.style.width = s.width + 'px';
      document.body.appendChild(holder);
      holder.appendChild(s.el);
      const r = s.el.getBoundingClientRect();
      return JSON.stringify({
        id: s.id,
        x: Math.max(0, Math.floor(r.left)),
        y: Math.max(0, Math.floor(r.top)),
        width: Math.min(Math.ceil(r.width), 3000),
        height: Math.min(Math.ceil(r.height), 3000),
      });
    })()`,
  );
  const r = JSON.parse(rect);
  win.setContentSize(Math.min(r.width + 20, 3000), Math.min(r.height + 20, 3000));
  // 等两帧：渲染态 DOM 是 appendChild 进去的，字体也要落位
  await new Promise((done) => setTimeout(done, 150));
  const image = await win.webContents.capturePage({ x: r.x, y: r.y, width: r.width, height: r.height });
  return { id: r.id, png: image.toPNG() };
}

/** 逐像素差异比例（4 字节步长采样；尺寸不同直接判红并说明） */
function diffRatio(basePath, freshPath) {
  const a = nativeImage.createFromPath(basePath);
  const b = nativeImage.createFromPath(freshPath);
  if (a.isEmpty() || b.isEmpty()) return { ratio: 1, note: '无法解码 PNG' };
  const size = a.getSize();
  const sizeB = b.getSize();
  if (size.width !== sizeB.width || size.height !== sizeB.height) {
    return {
      ratio: 1,
      note: `尺寸变化 ${size.width}×${size.height} → ${sizeB.width}×${sizeB.height}`,
    };
  }
  const bufA = a.toBitmap();
  const bufB = b.toBitmap();
  let diff = 0;
  let sampled = 0;
  for (let i = 0; i < bufA.length; i += 4) {
    sampled += 1;
    if (Math.abs(bufA[i] - bufB[i]) > 8) diff += 1;
  }
  return { ratio: diff / Math.max(1, sampled) };
}

app.whenReady().then(async () => {
  if (!PAGE || !fs.existsSync(PAGE)) {
    process.stderr.write(`TYPOGRAPHY_BASELINE: 页面不存在 ${PAGE}\n`);
    app.exit(2);
    return;
  }
  const win = new BrowserWindow({
    width: 1400,
    height: 1000,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  try {
    await win.loadFile(PAGE);
    await win.webContents.executeJavaScript('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 150));

    const info = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
          shots: window.__typographyShots().map((s) => ({ id: s.id, themeId: s.themeId, platform: s.platform, sample: s.sample, width: s.width, height: s.height })),
          fontProbe: window.__fontProbe,
          chrome: navigator.userAgent,
        })`,
      ),
    );

    const rows = [];
    for (const shot of info.shots) {
      const { id, png } = await captureShot(win, shot);
      const fresh = path.join(OUT_DIR, `${id}.png`);
      fs.writeFileSync(fresh, png);
      const base = BASELINE_DIR ? path.join(BASELINE_DIR, `${id}.png`) : null;
      if (UPDATE || !base || !fs.existsSync(base)) {
        if (base) fs.copyFileSync(fresh, base);
        rows.push({ id, status: base && !UPDATE ? '新增基线' : '已重录', ratio: 0 });
        continue;
      }
      const { ratio, note } = diffRatio(base, fresh);
      rows.push({
        id,
        status: ratio <= THRESHOLD ? '一致' : `超阈值 ${(ratio * 100).toFixed(2)}%`,
        ratio,
        note,
      });
    }
    fs.writeFileSync(REPORT, JSON.stringify({ ...info, rows, threshold: THRESHOLD }, null, 2));
    process.stdout.write(`${JSON.stringify({ ok: true, shots: rows.length })}\n`);
    app.exit(0);
  } catch (err) {
    process.stderr.write(`TYPOGRAPHY_BASELINE: ${err && err.stack ? err.stack : err}\n`);
    app.exit(1);
  }
});