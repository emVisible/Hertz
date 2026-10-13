# 超级 Markdown 模块（MD Studio）设计

日期：2026-10-13
状态：已批准（架构方案一，用户确认 §1-§8）
定位：**顶级核心功能**，排版导出工作站（非写作 IDE），三平台齐上（微信/小红书/知乎），精调主题+轻自定义，排版稿入库。

## 1. 总体架构

```
packages/mdcore (@hertz/mdcore)   纯 TS 零 React 内核
frontend/src/pages/mdstudio/      React 宿主页（三栏工作站）
backend layout 域                 models/layout.py + routers/layout.py + wave33
```

三条边界铁律：

1. **后端零渲染**。解析/排版/分页/截图全部在前端（Electron 即 Chromium）。后端只做排版稿 CRUD 与导入（docs 空间 / Studio 产物，复用 `backend/routers/docs.py` 的 containment 模式）。
2. **mdcore 不 import React、不 import frontend 任何模块**。输入 md 字符串 + 配置，输出挂好样式的 DOM 容器 / Blob / 剪贴板 payload。可在 node+jsdom 下跑 vitest。
3. **预览与导出共用同一渲染态 DOM**。画布 DOM 即微信内联快照源、即 snapdom 截图源。「所见即所得」由结构保证。

pnpm-workspace.yaml 增加 `packages/*`。

## 2. mdcore 内核管线

```
parse/      markdown-it + footnote + katex(@traptitech) + container(callout) + toc + attrs
            代码高亮 Shiki
ir/         LayoutIR 块序列（heading/para/list/code/table/quote/image/callout/formula），
            带源码行号。平台适配与分页只认 IR，不认 markdown-it token —— 心脏层
theme/      主题 = {tokens, styles}；applyTheme(ir, theme, overrides) → 带样式 DOM
paginate/   测量式分页（移植 mdsea/xiaohongshu-text-layout paginate.js 重写为 TS）
            隐藏测量台与导出同样式；Range 二分断点；表格按行拆+跨页重复表头；
            标题孤行控制；中文避头尾（标点不开头）；英文不拆词
platform/   平台适配器（见 §3）
export/     snapdom 主 + modern-screenshot 兜底
            就绪闸门：document.fonts.ready + 图片 eager + 双 rAF + 像素 checksum 两帧一致
            缩放降级 2×→1.5→1（16384px / 1.2 亿像素双上限）
            长图 ≤8192px 切片渲染再拼总 canvas
            产物：PNG Blob / 多页 ZIP(jszip) / 剪贴板 payload
fonts/      cn-font-split 构建期中文分片 + unicode-range CSS；
            导出前仅对本文用到的字符分片 FontFace.load()
```

性能预算：重排 150ms debounce；单页 3:4 PNG <500ms；20 页+ZIP <5s。

三方资产（皆 MIT，保留版权头）：xhs paginate.js→分页器；WeMD 微信清洗器对抗清单→微信适配器硬修复规则集；mdshot exporter 降级策略→导出器骨架。

## 3. 平台适配器

### 3.1 微信 wechat
- 渲染态快照内联：遍历画布 DOM，`getComputedStyle` 逐节点写回 `style`（不用 juice——浏览器跑不动）。
- 清洗器对抗：代码块空格/Tab→`&nbsp;`；pre 强制 `overflow-x:auto`；code 左对齐；mjx-container→section；禁 grid/float/position/CSS 变量/class/id/`<style>`；结构扁平化为 `<section>/<p>/<span>`。
- 外链自动转脚注（References 文末 + 角标）。
- 复制：`ClipboardItem` 双写 `text/html` + `text/plain`，降级 execCommand。

### 3.2 知乎 zhihu（降级渲染器）
- 表格→图片；公式→知乎 MathJax 或图片；有序列表→文本编号；图片须在线链接或 base64。
- 输出同微信规格的 inline HTML。

### 3.3 小红书 xhs
- 3:4（1242×1656）测量分页卡片；自动封面（首标题放大）；品牌页脚（署名/二维码位）；18 页上限提示。
- 导出：PNG 组 ZIP + 复制文案（正文+话题标签位）。**不做直发**（无官方发布 API）。

### 3.4 通用
- 画布内用 CSS `text-autospace: ideograph-alpha ideograph-numeric`；进剪贴板前 pangu 预处理插真实空格（第三方编辑器不认 CSS）。
- 中文避头尾 `line-break: strict` + `word-break: break-all`。

## 4. 主题系统

- 主题 = TS 对象 `{ id, name, platform 调优, dark?, tokens{主色/字体/字号/行距/圆角}, styles{元素→CSS} }`。
- 内置 **9 套**：微信 2（墨滴 / 晚风·深色）、小红书 4（桃夭 / 青柠 / 暮橙 / 夜航·深色）、知乎 3（学术 / 清简 / 墨案·深色）。每平台至少一套真深色，预览深色开关 = 切真深色主题（不是反色滤镜）。
- 色盘一键换色：`deriveTheme(base, primary)` 由主色派生整套（9 条规则见 `packages/mdcore/src/theme/derive.ts` 头注，与 `derive.test.ts` 一对一钉住）；`overrides.color` 是**单一通道**——合法 hex 自动走派生，非法值按普通 token 覆盖不炸。右栏 8 个预设色块 + 自定义取色器。
- 微调 overrides（主色/字号/行距）随排版稿入库 = 「我的主题」。字号/行距下拉必须并入主题自带值，否则会把「1.8」显示成最近档「1.5」。
- 品牌位：页脚署名文本 + 二维码。**决策变更（实现时定）**：二维码走前端 FileReader → dataURL 存 `cover.qr`（200KB 上限），**不建后端 assets 端点、不落 data/assets**。理由：导出截图时 dataURL 天然同源、无跨域污染 canvas 风险，且省掉一整套文件存储/白名单/清理逻辑；代价是二维码体积进 DB 行（≤200KB，可接受）。

## 5. 前端页面 pages/mdstudio/

- 路由 `/mdstudio`；侧边导航 produce 组、「执行」之后；i18n `nav.mdstudio`（图文工坊 / MD Studio）。
- 三栏：
  - 左栏：排版稿列表（新建/删除/切换）+ 源文轻编辑（复用 components/ui/MarkdownEditor）+ 导入（docs 空间 / Studio run final.md / 粘贴 / 本地 .md 上传）。
  - 中栏：平台感知画布——微信=手机图文流宽度；小红书=3:4 卡片横向滑动+封面；知乎=文章页。缩放、深色预览开关。
  - 右栏：平台 Tab（微信/小红书/知乎）→ 主题选择 → 色盘 → token 微调 → 分页控制（小红书）→ 导出按钮组。
- 顶栏：稿名、保存状态（自动保存 debounce）、主导出按钮。
- 视觉遵循 theme/tokens.ts `--hz-*` 与 components/ui/ 组件库；TabBar/Modal/Toast 复用。

## 6. 后端 layout 域

- `backend/models/layout.py`：`Layout(BaseModel)` — title, source_md(Text), source_ref(可空，docs 相对路径或 `studio:<run>`), platform, theme_id, overrides(JSON), cover(JSON)。
- `backend/routers/layout.py`：`GET /layout` 列表、`POST /layout`、`GET/PUT/DELETE /layout/{id}`、`GET /layout/import/docs?path=`（containment 复用 docs 逻辑）、`GET /layout/import/studio?run=`。
- 聚合注册进 `backend/routers/__init__.py`。
- 迁移 `alembic/versions/wave33_layout.py`。
- 前端 `api/layout.ts` 对接。导出产物不落库。

## 7. 测试策略

- **mdcore**（vitest, node+jsdom）：
  - IR 快照：代表样例 md → IR 结构断言；
  - 分页：合成 DOM mock `getBoundingClientRect`，钉断点选择、表格跨页表头、孤行标题推下页、避头尾（标点不开行首）；
  - 微信内联：产物无 class/id/`<style>`/CSS 变量，代码块含 `&nbsp;`，外链进 References；
  - 降级链：mock canvas 超限 → scale 降档断言；
  - 成对变异：拿掉避头尾/表头重复 → 对应断言必须红。
- **后端**：`tests/test_layout.py` CRUD + 导入路径越界 403/422 + 非 .md 拒绝。
- **前端**：页面 smoke（渲染+切平台 Tab）、`api/layout.ts` mock 层。
- 门禁：现有 607 pytest + 117 vitest 全绿 + 新增；`pnpm typecheck`。

## 8. 实施切片（按序）

- **A 内核+微信**：mdcore 骨架（parse/IR/theme）+ 微信适配器 + 复制；最小页面能粘贴 md → 复制到公众号。
- **B 小红书**：分页引擎 + 3:4 卡片 + ZIP 导出。
- **C 长图+知乎**：长图切片拼接导出；知乎降级渲染器。
- **D 后端域+页面整合**：layout CRUD/导入/迁移；三栏工作站完整化；导航/i18n。
- **E 打磨**：色盘、品牌位、深色预览、性能预算核验。

每片验收 = 对应测试绿 + 在 Electron dev 里人工走通该平台导出。

## 9. 实现后自检（2026-10-13，切片 E）

门禁读数（本机，串行复跑）：`@hertz/mdcore` 88 条 vitest、`hertz-frontend` 210 条 vitest、后端 796 条 pytest，两包 `tsc --noEmit` 干净。成对变异各跑过一次：拿掉 `deriveTheme` 规则 9 → 2 条派生断言精确红；拿掉跨页重复表头 / 避头尾 → 对应分页断言红。

真浏览器观感核验（临时探针页 `frontend/public/mdcore-preview.html` + `src/tmp-preview/entry.ts`，看完即删）：微信墨滴、色盘派生（#7c3aed 整套跟随）、晚风深色、知乎墨案深色、小红书桃夭 3:4 卡片组全部在 Chromium 里渲染正常，控制台零报错。**代价：探针取的是渲染态，不是导出产物。**

产品层量矩形时抓出并修掉的两个真缺陷：
1. 窄窗下中栏塌缩到 ~9px、缩放控件浮到右栏上——三栏容器改 `overflow-x-auto` + 中栏 `min-w-[360px]`（修后量得 canvas x=320 w=360、容器 scrollWidth 904 > clientWidth 810，即改为横向滚动而非压塌）；
2. 字号/行距下拉不含主题自带值，导致小红书主题 30px 被显示成 18px、墨滴行距 1.8 被显示成 1.5——`optionsWith()` 把当前值并进档位，并补一条断言钉住。

**导出产物真浏览器验收（第二次探针 `export-probe.html`，验完已删）**：直接调 mdcore 导出管线量**真实字节**——xhs 卡片 PNG 魔数正确、位图 2484×3312、292KB；ZIP 头 `PK`；长图 750×3651、67KB；微信 payload 无 `class=`、全内联、text 1094 字。性能实测：单页 91–100ms（预算 500ms）、图组打包 97ms/页（预算 20 页 <5s）。

这一轮抓出并修掉两个 jsdom 永远发现不了的缺陷：
1. **游离节点静默出空图**——`xhsCards` 的页节点从未进文档，snapdom 对它算不出布局，静默产出 **4×4、107 字节**的空 PNG（页面 ZIP 导出会整包空图而测试全绿）。修在导出器：`withRenderedNode()` 截图前临时挂屏外宿主、出图后原样摘掉，并补一条断言钉「capture 看到的节点必须 isConnected」（变异验证：去掉挂载 → 该断言红，读数 [false,false]）。
2. **scale 被 devicePixelRatio 二次放大**——snapdom 的 scale 乘在 DPR 之上，scale=2 + DPR=2 实际出 4× 位图（单卡 880KB）。除回 DPR 后「scale 即最终倍率」，产物尺寸可预测、降级链的像素预算才对得上。

已知限度（未做/未证，接手者按需处理）：
- **中文字体分片（cn-font-split）未接**：现在依赖系统字体栈（PingFang 等），导出走系统字体没问题，但要内置跨机一致的中文衬线就得补构建期分片。
- **真实剪贴板写入与浏览器下载动作未点过**：探针验的是 payload 与 Blob 字节，`ClipboardItem` 写入和 `a[download]` 落盘仍是宿主行为，需在 Electron 里人工各点一次。
- 性能数字取自单页样例（1 页卡片）；多页（18 页）总耗时按 97ms/页线性外推约 1.8s，未实测。

