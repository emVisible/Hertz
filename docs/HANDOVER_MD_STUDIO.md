# MD Studio 接手文档（Handover）

给下一个读这段代码的人（或明天的我）。设计解释在 `docs/MD_STUDIO.md`，批准过的原始设计与验收记录在 `docs/superpowers/specs/2026-10-13-mdcore-design.md`。本文只讲**现在到哪了、怎么跑、别碰什么、接下来做什么**。

---

## 1. 恢复点（2026-10-13 实测）

| 项 | 值 | 怎么重取 |
| --- | --- | --- |
| 分支 / HEAD | `main` / `b87746e`（功能）+ 其后的发版准备提交 | `git log --oneline -2` |
| 本模块提交 | 10 个：`f911f9c` spec → `b9e0a03` 内核 → `4211298` 页面+后端 → `4351335` 切片 E → `4739426` 导出器修复 → `4e23d7c` 分页/剪贴板修复 → `10c58ab` 文档 → `c755458` 门禁 → `37bc677` 设计与接手文档 → `b87746e` 画布内编辑+批量出图 | `git log --oneline -10` |
| 工作树 | 干净 | `git status --short` |
| 门禁 | 源码七步全绿（分两批跑：pytest 796 / mdcore 102 / 前端 219 / 两包 tsc / vite build 2.31s）；**产物级 `release-check.sh` 有一项红**，见 §4 第 11 条 | `bash scripts/verify.sh`、`bash scripts/release-check.sh` |
| 远端 | v0.35.0 已 tag + push（`git tag -l v0.35.0`、`git log origin/main..HEAD`） | — |
| 版本 | `0.35.0`；CHANGELOG 已收版 | `grep -m1 version frontend/package.json` |

## 2. 真相源地图

| 位置 | 职责 | 改动时的连带义务 |
| --- | --- | --- |
| `packages/mdcore/src/ir/types.ts` | LayoutIR 块型定义——所有下游只认它 | 加块型要同步 `parseToIR` 转换 + 一条 IR 测试 |
| `packages/mdcore/src/theme/derive.ts` 头注 | 色盘派生 9 条规则 | 改规则必须同改 `derive.test.ts` 的对应注释与断言 |
| `packages/mdcore/src/theme/themes/*.ts` | 9 套主题（每平台含深色款） | 新主题要注册进 `theme/index.ts` 的 `THEMES`；深色款打 `dark: true` |
| `packages/mdcore/src/paginate/paginate.ts` | 测量式分页（含页壳基线字体） | 判据靠注入 `Measurer`，别依赖 jsdom 排版 |
| `packages/mdcore/src/platform/inline.ts` | 微信/知乎共享的快照内联与降级链 | 改这里同时跑 `wechat.test.ts`（8 条）与 `zhihu.test.ts`（14 条） |
| `packages/mdcore/src/export/exporter.ts` | 闸门 + 降级链 + 游离节点挂载 + DPR 除回 | 新引擎选项保持注入式，否则测不到 |
| `backend/routers/layout.py` | 7 端点，containment 复用 `docs.py:_resolve_doc` | 加端点要跑 `scripts/api_inventory.py`（`test_api_surface` 硬约束） |
| `frontend/src/pages/mdstudio/*` | 三栏宿主；导出按稿参数离屏重建 | 文案必须双语同加（`mdstudio.*`，有 catalog 对齐测试） |
| `packages/mdcore/src/paginate/paginate.ts` 的 `breaks` | 强制分页边界（画布拖出来的断点）；**只增不减**，不裁内容 | 改语义前先看 D-226 的字数守恒论证 |
| `packages/mdcore/src/theme/apply.ts` 的 `data-mdcore-block/-line` | 画布点段落与拖边界的反查通道 | 加新清洗器/导出路径时确认 `data-mdcore-*` 不进产物 |
| `frontend/src/pages/mdstudio/BatchExportModal.tsx` | 批量出图队列（一个批次一个 ZIP） | 平台判定与单篇导出同源，改一处要两处看 |
| `docs/superpowers/specs/2026-10-13-mdcore-design.md` | §1-§8 设计、§9 实现自检、§10 宿主层验收 | 新验收读数追加，不改写历史段 |

## 3. 怎么跑

```bash
# 全量门禁（约 6–8 分钟，退出码要单独取，管道会吞）
bash scripts/verify.sh; echo "EXIT=$?"

# 只跑本模块
pnpm --filter @hertz/mdcore test
pnpm --filter hertz-frontend test src/pages/mdstudio
uv run pytest tests/test_layout.py -q

# 开发态：后端 :8787 + 前端 :3000（前端只绑 [::1]，curl 127.0.0.1 回 000 不代表没起）
bash scripts/dev.sh
```

## 4. 已踩过的坑（每条都有判据了，别再踩回去）

1. **snapdom 对游离节点静默产出 4×4 空 PNG**。`xhsCards` 的页节点不在文档里，导出会整包空图而 jsdom 测试全绿。修在 `withRenderedNode()`，判据是「capture 看到的节点必须 `isConnected`」。
2. **snapdom 的 scale 乘在 devicePixelRatio 之上**。2× 请求出 4× 位图（单卡 880KB）。导出器除回 DPR，"scale 即最终倍率"。
3. **分页页壳没挂主题基线字体**。`applyTheme` 把 font-* 挂在 container，分页页壳没这层 → 卡片正文退回默认 16px，表现为"上半页有字、下半页全空"，且每页塞进约 4 倍内容（同一篇稿 7 页 vs 修后 24 页）。jsdom 用 mock 测量看不出来。
4. **降级链形同虚设**：`ClipboardItem` 写要求文档聚焦，原实现一抛就中断。现在逐级降级并保留**第一个**原因。
5. **Select 谎报主题值**：字号/行距档位不含主题自带值时，界面显示的是"离它最近的那档"（30px 显示成 18px、1.8 显示成 1.5）。`optionsWith()` 并入当前值。
6. **窄窗三栏塌缩**：中栏被挤到 9px、缩放控件浮到右栏上。三栏容器 `overflow-x-auto` + 中栏 `min-w-[360px]`。
7. **文档/门禁数字会腐烂**：verify.sh 曾漏掉整个新包（94 条测试不在闸上）。加包/加域时同步看 `scripts/verify.sh`。
8. **强制分页边界只能"至少在这里断"**：v0.35 的 `breaks` 若改成「只能在这里断」，用户把边界往下拖就会**裁掉放不下的内容**，首版量到的字数守恒当场破掉。改这个语义前先读 D-226。
9. **jsdom 量不出块底边**：`offsetTop/offsetHeight` 全为 0，拖动那条判据靠 `defineProperty` 造高度才跑得起来——它能证"写回了什么"，证不了"吸得准不准"，后者仍属真浏览器。
10. **批量导出不能是"循环点 N 次导出"**：宿主会拦连续下载，用户最后只拿到最后一篇；所以 `zipBlobs` 按命名条目打成一个包，条目名过一遍净化（否则给解压端留 zip slip）。
11. **产物级门禁的红项与本模块无关，但别把它当"环境问题"放过**：`release-check.sh` 唯一红项是 `/api/studio/transcribe` 返回 000（契约要 200 或 502）。实测同一固化包隔离目录下首调 **68.3s 返回 200**、第二次 **1.4s 返回 200**，隔离目录里落了 148MB 模型——`_get_whisper()` 在模型未就绪时走 `ensure_model()` **隐式下载**，而 `sim-newmachine.sh` 只给 60s（它自己的注释就写着"绝不隐式下载模型"）。本模块两个提交对 backend 的全部改动是 `config.py` 一行版本号。**这条红项的真实含义是**：转写端点在"模型未就绪 + 网络慢/不通"时不会快速 502，用户会对着一个几十秒无响应的界面等——修它属于 ASR 线的活，不是本模块的遗留。

**通用教训**：结构层（jsdom + 注入 mock）能证"对不对"，证不了"看起来对不对"。观感与像素只能在产物层判——上面 1/2/3 三条全是真浏览器抓的。

## 5. 别碰

- `mdsea/`：三个参考仓库，**未纳入 git 管理**（`04c5da5` 刚把误收的嵌套仓库撤回并堵了复发）。只读参考，别 `git add`。
- 移植代码的文件头 MIT 致谢（`paginate.ts`、`breaks.ts`、`wechat.ts`），别顺手删。
- 用户正在跑的 `:8787` 后端与 `:3000` 前端 + 开发库：往里写稿/跑迁移前要先问。
- `git push` / 打 tag：需要单独授权，一次授权不代表长期授权。

## 6. 待办（谁手里）

| 事项 | 在谁手里 | 备注 |
| --- | --- | --- |
| Electron 里点一次四个导出按钮（复制/ZIP/长图/文案） | **你** | 自动化浏览器证不到宿主剪贴板权限与另存路径；这是唯一剩下的验收腿 |
| v0.35 的两个新交互在真浏览器里走一遍（点段落改文、拖分页边界、多选批量出图） | **你** | jsdom 证不了吸附手感与截图交互，见 §4 第 9 条 |
| 字体分片 | 已判**不做** | 理由与重启条件见 `docs/MD_STUDIO.md` §9 |
| 候选下一步（违禁词、Shiki、图床、掘金/头条） | 我，等你点单 | 排序与理由见 `docs/MD_STUDIO.md` §10 |

## 7. 一个收口建议

现在这个模块**功能完整、门禁在闸、产物层验过**，最划算的一步不是加功能，而是：你在 Electron 里走一遍四个导出按钮（约 5 分钟），确认无误后把 CHANGELOG 的 `[Unreleased]` 收成一个版本号、打 tag 推上去——把"已落地"变成"已发布"。若发现任何一处产物不对，把现象贴回来，判据层已经铺好，定位会很快。
