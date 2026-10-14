# MD Studio（图文工坊）设计文档

超级 Markdown 模块：把 agent 已生成的 Markdown，按目标平台重排、导出成能直接发的形状。

- 状态：首版已落地（2026-10-13），顶级功能，路由 `/mdstudio`，侧边栏「生产」组
- 批准过的设计记录：`docs/superpowers/specs/2026-10-13-mdcore-design.md`（含 §9-§10 验收读数）
- 本文是**给读者的解释文档**：为什么这么设计、规则住在哪个文件、哪些是刻意不做的

---

## 1. 定位与非目标

**定位**：排版导出工作站。输入是已经写好的 Markdown（Studio 产物、docs 空间文档、粘贴、本地文件），产出的不是"更漂亮的编辑器"，而是**各平台可直接使用的形状**：微信的可粘贴富文本、小红书的 3:4 卡片图组、知乎的可粘贴内容。

**非目标**（明确不做，理由见 §9）：

| 不做 | 为什么 |
| --- | --- |
| 写作 IDE（双栏编辑器、大纲、专注模式） | 写作发生在 agent 与 docs 空间；这里只吃成品 |
| 平台直发 | 小红书无面向普通开发者的发布 API；微信直发要公众号后台凭证。产品形态是"导出 + 复制" |
| 可视化主题设计器 | 逐元素调样式的工作量换不回使用率；色盘 + overrides 已覆盖真实需求 |
| 服务端渲染/批量出图 | 见 §3 方案裁决 |

---

## 2. 调研：三个参考仓库的原理

三者皆 MIT，代码在 `mdsea/`（未纳入 git 管理，只作参考）。

### WeMD —— 微信公众号排版编辑器（约 4.3 万行 TS，最成熟）

- 解析：markdown-it + 约 20 个插件（含 10 个自研：span / table-container / linkfoot / imageflow / multiquote / github-alert 等），highlight.js 高亮，Mermaid 前端渲染成 PNG 内嵌
- **核心资产是 `ThemeProcessor`**：用 juice 把主题 CSS 全量内联（含 `::before/::after`），再叠一串针对微信清洗器的硬修复——代码块空格转 `&nbsp;` 防吞、`pre` 强制 `overflow-x:auto`、`code` 强制左对齐、MathJax 的 `mjx-container` 换成 `section`；外层包 `<section id="wemd" data-tool>`
- 复制走 `ClipboardItem('text/html')`，降级 `execCommand`
- 长图用 html-to-image；另有 771 行的微信官方深色模式算法移植（市面少见）

**借鉴**：微信清洗器对抗清单被完整移植成本项目的规则集（§4.4）。**没借鉴** juice——它是 Node 库，浏览器里要靠 polyfill 硬撑。

### mdshot —— Markdown 转长图/分页图（约 3.2 千行，最干净）

- marked + DOMPurify + Shiki + KaTeX（含 `$` 才动态 import）
- **导出器骨架**（330 行）：modern-screenshot；缩放自动降级 2×→1.5→1（16384px 与 1.2 亿像素双上限）；离屏容器双 rAF + `fonts.ready` + 图片 eager 等待防白屏；jszip 打包多页
- 分页是**字符串估算**（按 Heading 分段，超高按约 60 字/行 × 27px 粗切）——这条被否掉了，见下

**借鉴**：降级链与就绪闸门的设计意图被移植，引擎换成 snapdom。

### xiaohongshu-text-layout —— 小红书卡片分页引擎（约 8.5 千行原生 JS）

- **核心资产是 `paginate.js`（241 行测量式分页）**：隐藏测量台用与导出**完全相同**的 DOM 真实排版，`getBoundingClientRect` 判溢出；放不下的段落/列表/代码用 `Range.cloneContents` 二分找断点（拆分后行内格式自动保留）；表格按行拆且**下页自动重复表头**；标题不留页尾；`adjustBreak` 做中文避头尾（闭标点不开行首）且不拆英文单词
- 导出侧两个精细节：**中文字体按需分片嵌入**（解析 unicode-range，否则 30 秒/张）；**重绘直到连续两帧像素 checksum 一致**（等 SVG 内字体异步解码）
- 平台形态：固定 3:4、18 页上限提醒、自动封面（首标题放大）、发现页/笔记页手机预览模拟

**借鉴**：分页引擎整体重写为 TS 移植（`packages/mdcore/src/paginate/`），文件头保留原作者版权与许可声明；像素 checksum 稳定等待被采纳；字体分片**未采纳**（§9）。

### 能力矩阵

| 维度 | WeMD | mdshot | xhs-text-layout | 本项目取谁 |
| --- | --- | --- | --- | --- |
| MD 解析 | markdown-it + 20 插件 | marked | 自研 | markdown-it（WeMD 路线） |
| 主题 | CSS 模板 + TS 变量 + 设计器 | tokens 两套 | 14 套 `.theme-*` | TS 对象 + 色盘派生 |
| 导出 | html-to-image | modern-screenshot + 降级 | modern-screenshot + 字体分片 | snapdom 主 + modern-screenshot 兜底 + 降级链 |
| 分页 | 无 | 字符串估算 | **DOM 真实测量** | xhs 路线（重写） |
| 平台适配 | **juice 内联 + 清洗器对抗** | 通用 | **画幅/封面/预览** | 两路都要，内联改渲染态快照 |

---

## 3. 调研：同类产品全景与技术选型裁决

### 同类产品给的功能边界

- **doocs/md**（GitHub 10k+ star）：AI 助手润色/起标题、**色盘一键换色**、10+ 图床、草稿自动保存
- **mdnice 墨滴**：一份内容多处粘贴（微信/知乎/掘金/头条）、**微信外链转脚注**、中英文自动加空格、20+ 主题 + 7 代码主题
- **lyricat/wechat-format**：鼻祖，贡献了"公众号不会被吃样式的特制 HTML"（尤其 `ul/ol` 被吃样式）与外链转脚注 + 角标
- **Reditor（红薯编辑器）**：**违禁词检测**（小红书发布前刚需）、爆款模板、自动 emoji
- **流光卡片 / Cardify / DS Card**：长文智能拆分多卡、批量生成（CSV/JSON 导入出数百张）、品牌模板与水印二维码
- **ray.so / Carbon**：截图美化的标准控制项（边距/圆角/阴影/渐变/行号）
- **知乎编辑器实测**：粘 Typora 会把标题全变一级、表格全乱（知乎不支持表格）、公式消失、列表里放图会被拆散 ⇒ 知乎需要的是**降级渲染器**，不是通用富文本

**核心洞察**（也是本模块的立足点）：微信拼 inline 样式兼容与主题生态，小红书拼分页卡片 + 合规，知乎拼向下兼容的降级渲染——**三者共用一颗"主题化渲染内核 + 平台适配器"**。

### 技术选型裁决（2026）

| 议题 | 裁决 | 依据 |
| --- | --- | --- |
| DOM→图片 | **snapdom** 主，modern-screenshot 兜底 | snapdom 比 html2canvas 快 10–100 倍、比 foreignObject 同类快 3–10 倍，自动内嵌用到的字体、支持伪元素；html2canvas 是"在浏览器里重写渲染引擎"，新 CSS 必然失真 |
| CSS 内联 | **渲染态快照法**（`getComputedStyle` 逐节点写回），不用 juice | juice 依赖 cheerio/Node API，官方 README 明说浏览器打包失败；快照法天然解决继承/优先级/变量解析，且与截图共用同一渲染态 |
| 解析 | markdown-it + 插件矩阵 | 脚注/公式/容器/TOC/attrs 全有成熟插件；token 流便于做平台后处理；remark 太重、marked 生态薄 |
| 高亮 | highlight.js（同步），Shiki 留作后续 | Shiki 异步 API 与 markdown-it 同步 highlight 回调不兼容（实现时选定，代码注释有理由） |
| 避头尾 | CSS `line-break: strict` + 分页断点自检 | `hanging-punctuation` 至今不可用于生产 |
| 中英文间距 | 画布用 `text-autospace`，进剪贴板前 pangu 插真实空格 | 第三方编辑器不认 CSS |
| 长图 | 按 ≤8192px 切片渲染再拼总 canvas | Chromium canvas 单边 16384 且总面积受限；WebP 超限被静默裁剪，PNG 最安全 |
| 架构方案 | 前端独立内核包 + 后端薄持久化 | 备选「后端 Playwright 渲染」被否：PyInstaller 要再带一个浏览器、预览与导出成两个渲染真相源、三个参考仓库的导出代码一行都用不上，而手动分发场景自动化收益为零 |

---

## 4. 架构

```
packages/mdcore (@hertz/mdcore)  纯 TS，零 React，可在 node+jsdom 测试
  parse/ → ir/ → theme/ → paginate/ → platform/ → export/ → fonts 由系统栈提供
        ▲
frontend/src/pages/mdstudio/     React 宿主页（三栏工作站）
        ▲ api/layout.ts
backend layout 域                models/layout.py + routers/layout.py + wave33 迁移
```

**三条铁律**（破坏任何一条都会立刻损失可测性或一致性）：

1. **后端零渲染**。解析/排版/分页/截图全在前端（Electron 即 Chromium）。后端只做排版稿 CRUD 与导入。
2. **mdcore 不 import React、不 import frontend 任何模块**。输入 md + 配置，输出挂好样式的 DOM 或 Blob/剪贴板 payload。
3. **预览与导出共用同一渲染态 DOM**。画布那棵 DOM 就是内联快照源、就是截图源。导出动作在页面里按稿参数**离屏重建**（画布节点带预览缩放/深色滤镜，不能直接进剪贴板）。

### 4.1 数据流

```
md 字符串
  → parseToIR()            LayoutIR（10 种块型 + 源码行号）
  → applyTheme(ir, theme, overrides)      渲染态 DOM（预览 = 导出源）
  ├─ wechatPayload / zhihuPayload         { html, text } → ClipboardItem 双写
  ├─ xhsCards(ir, {theme, footer, qr, breaks})  3:4 页 DOM[]（测量分页 + 封面 + 页脚）
  │    └─ exportCards / exportZip         PNG[] / ZIP
  └─ renderLongImage(el)                  单张长图 Blob

块定位标记：applyTheme 给每个顶层块挂 `data-mdcore-block`（IR 序号）与
`data-mdcore-line`（token.map 行区间）。画布的两条内联编辑（点段落改文本、拖分页边界）
全靠这两个属性反查——**不改 mdcore 的产物结构**，且它们在微信/知乎清洗时被剥掉
（`stripUnsafe` 剥 `data-mdcore-*`），产物里不留编辑器状态。
```

**语法层落点**：Phase 2 的插件矩阵一律实现在 **IR 层**（`parseToIR`），不写 markdown-it 插件——整条渲染链已经是 parse → IR → applyTheme（没有人渲染 markdown-it 的 HTML 了），写在插件层就等于同一份规则有两个作者。当前支持：

| 语法 | 落点 | 说明 |
| --- | --- | --- |
| `==荧光笔==` | `markdown-it-mark` + IR `mark` 节点 | 中文正文最地道的强调；底色走 `hl` 槽，配 `box-decoration-break` 跨行不断 |
| `> [!NOTE/TIP/IMPORTANT/WARNING/CAUTION]` | `parseToIR.parseGitHubAlert` | 转成 callout 变体（`:::note` 容器的等价物，但写法是引用） |
| `- [x]` / `- [ ]` | `markdown-it-task-lists` + `checkboxToEmoji` 核心规则 | **必须换成 ✅/⬜ 字符**：微信清洗器整类剥掉 `<input>`。任务项正文裹在 `<label>` 里（对 markdown-it 不透明），IR 层拆开重解析，否则项内的 emoji/强调全留在原文里 |
| `H~2~O` / `E=mc^2^` / `<ruby>` | sub / sup / ruby IR 节点 | 注音同理：html_inline 抢先，要在 IR 层自己认 |
| `:sunny:` 等短码 | `markdown-it-emoji`（full） | |
| `#话题` | `parse/markdown.ts` 行内扩展核心规则 | 切 `text` token 内部（`今天聊 #AI 与 #设计` 一段里有几个话题），前后必须是非标签字符，否则 `C#` 误伤 |
| `[color:#xxx]文字[/color]` | 同上 | 落成**受控 span**——产物里不出现用户可写的标签，只有颜色这一个自由维度 |
| `{70% left}` | `parseImageSizeSpec` | 图宽与对齐，宽度夹在 10%~100% |
| `[toc]` | `fillToc` + `toc` 块 | 目录要"整篇标题"才能填，而 `[toc]` 通常在开头——所以解析时只放占位块，收尾统一回填；锚点 `h2-序号-slug`，重名不撞车 |
| 定义列表 | `markdown-it-deflist` + IR `deflist` 块 | 一个术语可带多条释义 |
| `[^1]` 脚注 | `markdown-it-footnote` + IR `footnotes` 块 | 正文是可回跳的上标角标，文末是脚注区；两边的内容都要在产物里 |
| 任意未建模语法 | `parseToIRDetailed()` 的 `diagnostics` | **保内容 + 记账**，不静默丢弃；见下 |

**卡片比例与预览可读性**：`XHS_RATIOS` 五档（3:4 / 2:3 / 9:16 / 1:1 / 4:3），统一 **1080 宽坐标系**（1242 是 v0.35 的历史值；1080 才是小红书官方与参考实现共同在用的导出宽）。比例、封面副标题/角标、页眉、页码开关全部存在 `cover` JSON 槽——加键不需要迁移。

画布从"横向排一排卡片"改成**单页展示**：早先每张只有 310px 宽，正文 30px 缩到约 7.5px，用户实际在盲操作。现在一次铺一页（约 420px 宽），配翻页条 + 缩略图条；卡片本体仍保持 1080 导出坐标系，导出与预览同规格。

**封面是独立的一页**（`platform/xhs.ts`）：封面页 = 角标 + 自适应字号标题 + 副标题 + 水印，正文页整体后移，页码从 `1 / N` 重新起算（封面不排页码）。标题摘不摘看封面标题的**来源**——取自正文第一个 H1 就摘掉（否则同一句话出现两次），用户自定义了封面标题则正文 H1 留在正文流里（那是作者写的内容，删了是丢内容）。

封面字号是**测量台上二分**出来的"尽量大但仍放得下"，不是固定倍数。量的是**整页克隆件**：只把封面内容丢进没有宽度约束的测量台，标题换行更少、显得更矮，二分就会选一个过大的字号，角标与副标题在真卡片里被裁掉（这个坑基线图第一眼就看见了）。

**卡片页壳五层**（`paginate/card-shell.test.ts`）：`bg 底纹 / deco 装饰 / header 页眉 / body 正文 / footer 页脚`，**只有 body 进测量流**，装饰件一律绝对定位。判据是「装饰层撑到 999px，分页结果一字不变」。之前页壳只有 body 一层，所以卡片既没有底纹也没有装饰位。

**`---` 强制分页**：IR 的 `hr` 带 `kind`（`---` → pagebreak，`***`/`___` → rule）。卡片平台把它翻成收页；微信/知乎是连续长文，同一行**仍然画成横线**（不能为了卡片平台改掉长文的既有行为）。这里有个只有小红书会中的坑：三套 xhs 主题的 `hrStyle` 都是 `dots`，而分页标记早先只加在 `<hr>` 分支上，于是 `---` 在小红书上静默失效。

**语法守卫（切片 1）**：解析层遇到不认识的 token 只有两个选择——丢，或者原样带出来。v0.36 之前选的是「丢」，于是 `~~删除线~~` 的样式没了、定义列表和脚注正文**整段从成品里消失**，而 190 条结构断言一条都不红：它们压根不知道存在这些语法。现在 `parseToIRDetailed()` 除 blocks 外还给一份 `diagnostics`（token 类型 / 次数 / 首次出现行号），判据用一份「厨房水槽」样例把未建模集合守成**空集**——加一种新语法而忘了建模，那条会立刻红。

守卫同时把「未知内容不许消失」变成契约：未建模 token 一律按 content 抢救成文字/代码/HTML，无内容的纯结构 token 才静默跳过（不在正文里插空段）。

**IR 是心脏层**：markdown-it 之后所有环节只认 `LayoutIR`，不回读 token。于是平台适配器不懂 markdown、分页器不懂平台、主题不懂分页，每一环可独立替换与单测。

**强制分页边界**（`paginate(ir, { breaks })` / `xhsCards(ir, { breaks })`）：IR 块序号集合，命中即「在此块之前另起一页」。语义是**「至少在这里断」而不是「只能在这里断」**——强制收页后若剩余内容仍放不下，照常拆分到后续页。这条约束是为了守住字数守恒：手动调边界永远不会裁内容，往上拖只会让本页变少，往下拖最多多出几页。

### 4.2 分页引擎（`paginate/paginate.ts` + `paginate/breaks.ts`）

- 测量抽象成可注入的 `Measurer`：浏览器默认 `domMeasurer`（`getBoundingClientRect`），测试注入合成块高的 mock——**这是分页器能在 node 下测的根本原因**
- 溢出时 `Range.cloneContents` 二分找断点，行内格式（strong/em/code/link）随拆分保留
- 表格按行拆，下一页自动重复表头
- 标题与后一块绑定，标题不落页尾
- `adjustBreak`：闭标点（，。！？；：、）】》”）不开行首、开标点不留行尾、英文不拆词；`codeBreak` 在换行处断

### 4.3 导出器（`export/exporter.ts` + `export/longimage.ts`）

- 就绪闸门四道：`document.fonts.ready` → 容器内 img 全 complete → 双 rAF → 像素 checksum 连续两帧一致（jsdom 自动跳过，可注入或传 null）
- 缩放降级链 `SCALE_LADDER = [2, 1.5, 1]`：只有 canvas 超限错误才降档重试，其它错误不切引擎不降档
- **scale 语义**：snapdom 的 scale 乘在 devicePixelRatio 之上，导出器除回 DPR，使"scale 即最终位图倍率"（否则 2× 请求出 4× 位图，单卡 880KB）
- **游离节点保护**：`withRenderedNode()` 在截图前把未挂载节点临时挂到屏外宿主、出图后摘净。snapdom 对游离节点会**静默产出 4×4 空图**（真浏览器实测）
- 长图：固定高度壳 + `overflow:hidden` + 克隆 `translateY(-offset)` 逐片截（片高 ≤8192），再 `drawImage` 拼总 canvas；逐元素下发 `box-decoration-break: clone` 防行内元素跨片截断；面积预检走降档

### 4.4 平台规则

**微信**（`platform/wechat.ts` + 共享层 `platform/inline.ts`）

| 规则 | 为什么 |
| --- | --- |
| 白名单属性 `getComputedStyle` 写回 inline style，剥 class/id/`<style>`/CSS 变量 | 微信只认 inline 白名单，其余全清洗 |
| `<pre>` 内空格/Tab → `\u00a0`，`pre` 强制 `overflow-x:auto`，`code` 左对齐 | 清洗器吞缩进、代码块横向溢出不可滚 |
| `mjx-container` → `section` | MathJax 容器被吃 |
| 块级一律扁平为 `section/p/span/strong/em/img`，`ul/li` → `section/p` 带 `• ` / `1. ` 前缀 | 微信对列表样式还原差 |
| http(s) 外链 → 上角标 + 文末 References | 公众号正文禁外链 |
| pangu 插真实中英文空格 | 第三方编辑器不认 `text-autospace` |
| `ClipboardItem` 双写 `text/html` + `text/plain`，失焦等瞬时错误**逐级降级**（async 写 → execCommand → writeText），全失败抛**第一个**原因 | 报"窗口未聚焦"比报末端权限错更可行动 |

**知乎**（`platform/zhihu.ts`）：降级渲染器。表格 → 浏览器端 snapdom 转 dataURL img，失败/无画布环境退化为带边框逐行文本容器；公式 → 从 `<annotation>`/alttext 取 LaTeX 源码，块级 `$$…$$`、行内 `$…$`；有序列表 → `1. ` 文本编号 p 序列；嵌套列表递归拍平；外链**保留**（知乎支持）。

**小红书**（`platform/xhs.ts`）：`XHS_CARD = 1242×1656`（3:4 导出坐标系），`XHS_MAX_PAGES = 18`，超出返回 `overflow: true` + 精简/拆分建议（不静默截断）；首块是 heading 时第一页做封面（标题放大）；页脚 = 署名 + 页码 +（可选）二维码位（带二维码时页脚预留区自动加宽）；`xhsCaption()` 出纯文本（标题 + 正文 + `#` 话题占位）。

---

## 5.1 编辑器（Phase 4）

源文区是 **CodeMirror 6**（`editor/MarkdownEditor.tsx`，自己封而不用 wrapper 库：联动要 `EditorView` 实例，wrapper 只会把它藏进 ref 再加一层版本对齐）。自带行号 / `Cmd+F` 搜索面板 / 撤销重做 / Markdown 高亮 / 括号配对 / 自动换行。

两条工程约定：
- **受控值只在外部值 ≠ 编辑器当前值时写回**。否则每敲一个字就走一圈 `setState → 写回 → 重置选区`，光标会被往前拽。
- **挂载失败要看得见**：CM 抛错时降级成 textarea 并显示原因，不静默（空白会被当成"编辑器没了"）。`setup.ts` 里补了 `Range.getClientRects` 垫片——CM 在 rAF 里量字宽，jsdom 没这个 API，不补就是"测试全绿但整轮 EXIT=1"。

**大纲与双向联动**（`editor/outline.ts`，纯函数）：
- 大纲只收 1~3 级，行号取自 **IR**（`token.map` 是解析产物）——再扫一遍 Markdown 就有了第二套行号，两套迟早漂。
- 光标行 → 画布高亮：取「含该行且最窄」的块；落在所有区间之外就回落到最近的上一块。
- 画布点段落 → 编辑器选中该段（旧的块编辑框仍在）。
- 高亮是**独立 effect**，只翻一个 DOM 属性 + 一次 `scrollIntoView`：挂在渲染 effect 的分支里会让"每动一行光标就重排整篇画布"。

**分栏可拖**：240~640px，pointer 事件跟窗口走，localStorage 记住；方向键也能调。

## 5. 主题与色盘

主题 = `{ id, name, platform, dark?, tokens{color,fontFamily,fontSize,lineHeight,radius}, styles{元素→CSS} }`。

| id | 名称 | 平台 | 深色 |
| --- | --- | --- | --- |
| modi | 墨滴 | wechat | |
| wanfeng | 晚风 | wechat | ✓ |
| taoyao | 桃夭 | xhs | |
| qingning | 青柠 | xhs | |
| mucheng | 暮橙 | xhs | |
| yehang | 夜航 | xhs | ✓ |
| xueshu | 学术 | zhihu | |
| qingjian | 清简 | zhihu | |
| moan | 墨案 | zhihu | ✓ |

**色盘一键换色**：`deriveTheme(base, primary)` 由单一主色派生整套，9 条规则写在 `theme/derive.ts` 头注，与 `theme/derive.test.ts` 的注释**一对一钉住**（改规则必须同步改测试）。`overrides.color` 是**单一通道**：合法 hex 自动走派生，非法值按普通 token 覆盖（不派生、不炸）。

**预览深色开关**切的是该平台真深色主题（`darkThemeFor(platform)`），不是反色滤镜——滤镜会把图片一起反色。

---

## 6. UI 与交互

三栏工作站（`frontend/src/pages/mdstudio/`）：

- **左栏 `LayoutListPanel`**：排版稿列表（选中态 primary 高亮、平台·主题副行、hover 出删除 → Modal 确认）；导入菜单四路（docs 空间文件列表点选 / Studio run slug / 粘贴 / 本地 .md 上传）；底部源文轻编辑（裸 textarea + 字数）。**没复用 `MarkdownEditor`**：它自带右侧预览，与中栏画布职责重复。表头有「批量」开关，打开后每行换成勾选框、底部出计数与批量出图入口。
- **中栏 `CanvasPanel`**：平台感知画布——微信 375px、知乎 690px、小红书 1242×1656 卡片横滑带（缩放槽 > 缩放层 > 卡片三层结构，transform 落中间层，卡片节点保持导出坐标系；hover 浮起 150ms）。缩放 Select（50/75/100%，CSS `zoom`，仅预览）+ 深色开关。mdcore 产物是原生 DOM，直接 `appendChild`，不经 React、不用 `dangerouslySetInnerHTML`。
- **画布内联编辑**（两条都在 `CanvasPanel`，只读渲染态、不改 mdcore 结构）：
  - **点段落改文本**：事件委托把 `data-mdcore-block/-line` 反查成「哪一块 + 它的源码行区间」，中栏下方开出块编辑器。保存时**按行区间回写 `source_md`**——不做 IR→markdown 反序列化，markdown 始终是唯一真相源（左栏源文、自动保存、导出三条路都不改道）。没有行号的块（少数内联产物）提示回左栏改。
  - **拖分页边界**：小红书每页（除末页）底部一条可拖的边界线，拖动时吸到最近块的下沿，松手写一条强制断点；落回本页最后一块下沿 = 取消这条边界，回到自然分页。用指针捕获保证拖出卡片松手也收得到事件。
- **右栏 `InspectorPanel`**：平台 TabBar（切换即把 `platform` + 该平台默认主题落稿）→ 主题卡（色块 + 名字 + 深色徽标）→ 色盘（8 预设 + 取色器）→ 字号/行距（**选项并入主题自带值**，否则 30px 会被显示成 18px）→ 小红书专有（页数/18 上限、署名、二维码上传）→ 导出按钮组。
- **批量出图**（`BatchExportModal`）：勾选多篇 → 逐篇出图 → **打成一个 ZIP**（每篇一个子目录 `序号-稿名/page-01.png`）。小红书出卡片组、其余平台出长图，与单篇导出同一套平台判定。队列带逐篇状态、失败原因、取消；单篇失败不掐断整批，取消也会把已出的那几篇打包交付（为一次取消丢掉几十 MB 渲染结果是产品缺陷）。顺序触发 N 次浏览器下载会被宿主拦、用户最后只拿到最后一篇——这是「批量」必须是一个包而不是一个循环的根因。
- **顶栏**：稿名行内改名、保存状态点（未保存 warning / 保存中 primary 脉冲 / 已保存 success）、主导出按钮随平台变。
- **自动保存**：内容/平台/主题/overrides/footer/qr/breaks 变更 debounce 800ms PUT 全稿；画布重排 debounce 150ms。
- 视觉约束：只用 `theme/tokens.ts` 的 `--hz-*` 与 `components/ui/` 组件库；i18n 双语同步（`mdstudio.*` 96 个 key）。

---

## 7. 数据与接口

**表 `layouts`**（`backend/models/layout.py`，迁移 `alembic/versions/wave33_layout.py`）：
`title` / `source_md`(Text) / `source_ref`(可空，docs 相对路径或 `studio:<run>`) / `platform`(wechat·xhs·zhihu) / `theme_id` / `overrides`(JSONB) / `cover`(JSONB，装 `footer`、`qr` dataURL 与 `breaks` 强制分页边界)。

`cover` 是自由 JSON 槽：三个平台专有位都落在它里面（小红书占两席：品牌页脚与手动分页边界），加键**不需要迁移**。

**端点**（`backend/routers/layout.py`，前缀 `/api`）：

| 端点 | 说明 |
| --- | --- |
| `GET /layout` | 列表，**不含 source_md**，按 updated_at 倒序 |
| `POST /layout` | 新建，platform 由 pydantic `Literal` 拦非法值 |
| `GET/PUT/DELETE /layout/{id}` | 单稿；PUT 是局部更新（未给字段不动） |
| `GET /layout/import/docs?path=` | 复用 `routers/docs.py` 的 `_resolve_doc` containment：越界 403、绝对路径/非 .md 422、缺失 404 |
| `GET /layout/import/studio?run=` | 读 `data/output/studio/<run>/final.md`；slug 含 `..` `/` `\` fail-closed 422 |

导入返回 `{…, content, suggested_title}`，`suggested_title` = 正文第一个 `# ` 一级标题，否则文件名 stem / run slug。

导出产物**不落库**。二维码刻意走前端 FileReader → dataURL 存 `cover.qr`（200KB 上限），**不建后端 assets 端点**：导出截图时 dataURL 天然同源，省掉文件存储 + 白名单 + 清理三套逻辑。

---

## 8. 质量保障

**门禁**：`bash scripts/verify.sh` 八步（backend lint → pytest → mdcore typecheck → mdcore test → frontend typecheck → frontend test → vite build → **排版基线图**）。mdcore 是 v0.35 才补进闸的——新包 94 条测试一度不在闸上；基线图是 v0.36 加的第八步。

**测试分布**（数字由命令产生，见 §11）：mdcore 232 条 vitest（node+jsdom，测试与源码同目录）、前端 290 条、后端 796 条（其中 `tests/test_layout.py` 17 条）。

### 排版基线图（产物层判据，`packages/mdcore/tests/baselines/typography/`）

结构层能证"标题有两个 span"，证不了"改完还好看"——而排版恰恰是观感问题。所以每套主题 × 每份样例各有一张基准图：`scripts/typography-baseline.mjs` 用 Electron 无头把 mdcore 的渲染态拍成 PNG，与基准图逐像素比（阈值 0.5%，4 字节采样步长）。

- **用法**：`node scripts/typography-baseline.mjs` 比对 / `--update` 重录；退出码 0/1/2 = 通过/超阈值/环境跑不起来
- **可比性**：只保证同机同 Chromium 同字体可比。`manifest.json` 记 platform、userAgent 与**字体探针**（固定字符串的测量宽度）；探针变了会提示"本轮读数不可比，请 --update 重录"——而不是把阈值放大
- **内容必须像素稳定**：不用远程图片（网络抖动会让基线永久飘）、不用随机内容、示例图用内联 SVG data URL

**它已经抓到的东西**（三条结构层 158 条断言一条都没红）：

| 缺陷 | 现象 | 修在哪 |
| --- | --- | --- |
| `data:image/svg+xml` 被 markdown-it 默认 `validateLink` 拒掉 | 配图在画布上**原样打印成一行 data URL** | `parse/markdown.ts` 白名单只放行 `data:image/<子类型>`；平台层再加一道 `sanitizeImageSources` |
| `applyCover` 把 em 当 px 乘 | 封面标题变成 **2.55px**，整张卡片最该抢眼的标题缩成一个点 | `scaleFontSize()` 保留单位 |
| 30px 卡片上的中文着重号 | 加粗变成**一排悬空的点** | 暮橙改用主色底高亮；`dot` 样式保留可用 |

**判据纪律**：

- 每条规则配一条断言，且**新判据必须被"拿掉修复"的成对变异打红过**才算有牙。本项目已见过红的变异：外链转脚注、跨页重复表头、避头尾、色盘派生规则 9、游离节点挂载、强制分页边界、块编辑回写 source_md、拖边界写回 breaks。
- 分页判据靠注入式 `Measurer` 驱动，导出判据靠注入式 `CaptureEngine`/`ReadyGate`，**不打真 canvas、不依赖 jsdom 排版**。
- 观感与像素只能在产物层判：jsdom 能证"结构对"，证不了"看起来对"——§10 的五个缺陷里三个只有真浏览器能抓到。

---

## 9. 刻意不做的决定（附重启条件）

| 决定 | 理由 | 重启条件 |
| --- | --- | --- |
| 中文字体分片（cn-font-split） | 微信清洗器剥 `@font-face`，对富文本零收益；只有图片导出受益，而 macOS 上 PingFang 已保证同机一致；24 页 ZIP 已 14.3MB，再叠思源宋体全量（10MB+）顶图集体积与安装包大小 | 要跨机一致的招牌字体，或要发 Windows/Linux 包时 |
| 平台直发 | 小红书无面向普通开发者的发布 API（社区逆向有封号风险）；微信直发需公众号后台凭证 | 拿到官方凭证/服务商资格 |
| 后端渲染（Playwright） | 打包体积、双渲染真相源、参考代码零复用，手动分发场景自动化收益为零 | 出现"无人值守批量出图"的真实日常需求 |
| 可视化主题设计器 | 工作量换不回使用率 | 主题 overrides 通道不够用时 |
| 违禁词检测 / AI 润色 / 批量生成 | 属另一条能力线（写作与合规），与排版内核正交；已列入 §10 候选而非本期 | 见候选切片 |

---

## 10. 候选下一步（未开工，按收益/成本排）

1. **Electron 内人工走通四个导出按钮**（唯一剩下的验收腿：自动化浏览器证不到宿主剪贴板权限与另存路径）
2. **违禁词/敏感词检测**（小红书发布前刚需，Reditor 验证过的差异化卖点；纯前端词表可做第一版）
3. **Shiki 二次 pass 高亮**（换掉 highlight.js 的 token 色映射，代码卡观感更好）
4. **图床**：微信要求图片必须在微信图床，现在图片走 dataURL/同源；要发带图长文得接图床
5. **掘金/头条适配器**：mdnice 证明"一份内容多处粘贴"是真需求，适配器形状已就位

**已于 v0.35 落地**（原候选第 2、4 条）：

| 能力 | 落点 | 已知限度 |
| --- | --- | --- |
| 画布内联编辑：点段落改文本 + 拖分页边界 | `CanvasPanel.tsx` + `paginate(ir,{breaks})` | 边界按 **IR 块序号**记（存在 `cover.breaks`）；改了源文导致块数变化后，旧边界可能落到别的块上——要严格对齐就得存行号并做重定位，暂不做 |
| 批量出图 | `BatchExportModal.tsx` + `zipBlobs()` | 一次性把整批 PNG 装进内存（24 页/篇 ≈ 14MB）；上百篇的量级要改成流式或落盘 |

---

## 11. 事实与再生成命令

本文引用的数字会腐烂。当前读数取于 2026-10-13（HEAD 见 git log），重取命令：

```bash
# 全部门禁（七步，含真实退出码）
bash scripts/verify.sh

# 各层规模与测试条数
find packages/mdcore/src -name '*.ts' ! -name '*.test.ts' | xargs wc -l | tail -1
for f in $(find packages/mdcore/src -name '*.test.ts'); do echo "$f $(grep -c '  it(' $f)"; done
node -e "const z=require('./frontend/src/i18n/zh.json'),e=require('./frontend/src/i18n/en.json');\
const f=(o,p='')=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==='object'?f(v,p+k+'.'):[p+k]);\
console.log('zh',f(z).length,'en',f(e).length,'mdstudio',f(z).filter(k=>k.startsWith('mdstudio.')).length)"

# 主题清单与端点
grep -n "export const" packages/mdcore/src/theme/themes/*.ts
grep -n "@router\." backend/routers/layout.py
```

真浏览器验收方法（产物层取证，探针页验完即删）：在 `frontend/public/` 放一个临时 html 引 `src/tmp-*/entry.ts`，直接调 mdcore 的导出函数断言**字节**（PNG 魔数、`createImageBitmap` 尺寸、ZIP 头、耗时），用 browser-use 打开 `http://localhost:3000/<probe>.html` 读报告并截图。**不要**把导出验收只留在 jsdom 层——`docs/HANDOVER_MD_STUDIO.md` §4 记的 7 个坑里有 3 个只有真浏览器抓得到。
