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


## 10. 宿主层验收（2026-10-13 补，探针 `host-probe.html`，验完已删）

24 页真实压测读数（60 段长文，含列表/引用/表格/代码）：分页 17ms、图组 ZIP **14.3MB / 2425ms / 101ms 每页**（预算 20 页 <5s ⇒ 实测 24 页 2.4s）、长图 1.1MB / 294ms、**字数守恒 源 22189 / 页内 22346 / 差 −0.7%**（多出的是每页页脚，分页不吞字）。

抓出并修掉第 5 个真缺陷：**分页页壳没挂主题基线字体**。`applyTheme` 把 fontFamily/fontSize/lineHeight 挂在 container 上，而分页页壳没有这一层——卡片正文因此退回浏览器默认 16px。真浏览器截图表现为「上半页有字、下半页全空」，同时让每页塞进约 4 倍内容（同一篇稿先前只分 7 页，修后 24 页——页数与观感同时失真，且 jsdom 用 mock 测量时完全看不出来）。修：页壳挂基线（含 overrides 字号），补两条判据钉「30px 基线」与「overrides 生效」。

剪贴板：真浏览器实测 `ClipboardItem` 写要求文档聚焦，失焦即抛；原实现第一级抛错就直接中断，**降级链形同虚设**。改为逐级降级（async 写 → execCommand → writeText），并在全部失败时抛出**第一个**原因（「窗口未聚焦」比末端的权限报错更可行动）；页面失败 toast 现在带原因。自动化浏览器里 `writeText` 被权限策略拒（Write permission denied），Electron 聚焦窗口不受此限。

**字体分片（cn-font-split）判为不做**，理由三条：微信清洗器会剥掉 `@font-face`，分片对微信/知乎富文本零收益；只有图片导出受益，而 macOS 上 PingFang 已保证同机一致；24 页 ZIP 已 14.3MB，再叠思源宋体全量（10MB+）会顶到小红书图集体积与安装包大小。等到「要跨机一致的招牌字体」成为真需求再启，届时只需在 `fonts/` 挂构建期分片 + 导出前按需 `FontFace.load()`。

剩余未证：真实 Electron 窗口里的剪贴板写入与下载落盘各点一次（自动化浏览器只能证到「管线产出了合法字节」，证不到宿主的剪贴板权限与另存为路径）。

---

## 11. v0.36.0 验收读数（2026-10-15 追加）

> **追加而非改写**：§9/§10 是当时的原始读数，保留不动。这里记本轮（v0.36.0）的新读数。

### 11.1 门禁

| 项 | 2026-10-13 | 2026-10-15 |
| --- | --- | --- |
| mdcore | 102 条 | **366 条** |
| 前端 | 219 条 | **357 条**（51 文件） |
| 后端 | 796 条 | 796 条（`tests/test_layout.py` 25 条） |
| 排版基线 | 13 张 / 0.5% 阈值 | 13 张（本轮重录 6 张） |

### 11.2 产物层抓到的缺陷（结构层一条都没红）

- `data:image/svg+xml` 被静默降级成文本 / 封面标题被缩成 2.55px / 30px 卡片上的中文着重号变成一排点
- 列表项里的代码块**整段从成品里消失**（`InlineNode[][]` 装不下块级内容）
- 长文页面凭空多 **20px**（代码块双重缩小：`pre` 与 `code` 都挂了 `0.86em`）
- 小红书 9:16 卡片下半截被切（展示高度写死比例，不看窗口）
- 拼音 `汉字{拼音|…}` 整段降级（`case 'ruby'` vs 令牌名 `ruby_open`，**一处的字符之差**）

### 11.3 三次"判据全绿但线上是错的"（本轮最有价值的记录）

| 现象 | 根子 | 教训 |
| --- | --- | --- |
| 卡片一路缩到下限 | 判据给挂载 div 造了 `clientHeight`，而真实浏览器里那个数是**卡片自己的高度** | **判据造的数必须与浏览器里真实存在的元素对上，否则验的是幻觉** |
| 长文页面多 174px | 断言报「本该 1 个节点却有 2 个」，被改松成 `.toContain()` 放行 | **看到断言值变了，先问为什么**；把 bug 写进判据比没判据更糟 |
| 本地草稿快照不生效 | 只测了纯函数，接线变异全绿；mock 立即 resolve，中间态看不见 | **纯函数对了不等于接线对了**；要验中间态就得让 mock 可挂起 |

### 11.4 与本 spec 相关的设计补记

- **一次解析多处复用**（§4 架构铁律的延伸）：输入路径上曾叠三段解析，且光标回调身份每键变化
  导致每键重排重分页。现在全页一份 IR + 依赖清空 + 走 ref。
- **降级必须可见**：解析层与渲染层各有一本「没支持」的账，此前**都在内核里没有出口**。
  现由画布顶部的可折叠横幅承载（`data-mdcore-fallback` 兜底产出可见节点，不静默消失）。
- **装饰是真元素**（§4）在本轮被反复验证：微信清洗器读不到伪元素，所有装饰一律物化。

### 11.5 未在本轮解决

- 输入延迟仍非秒开（万字稿分页是真排版）；W0 已消除结构性开销，剩余是量的问题
- 列表项里的标题渲染成标题样式（内容不丢，已保住；IR 仍只允许块进顶层）
- `release-check.sh` 唯一红项属 ASR 线（见 handover §4 第 11 条），与本模块无关
