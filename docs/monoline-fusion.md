# Monoline → Hertz 融合方案（执行域独立菜单）

> 状态：执行中。参照实现：`monoline/`（完工验收后归档删除）。
> 决策（2026-09-26）：前端原生移植 / 保留 Kokoro TTS / 作业表迁入 Postgres / Sidecar 先做复用评估。
> 相关决策编号：D-205~D-211 见本文 §8（已迁入 docs/DECISIONS.md）。

## 1. 背景与目标

Monoline：纯本地文稿转解说视频工具（贴稿→大纲审阅→九阶段管线→MP4→Studio 精修），
28 种场景类型、确定性渲染（HyperFrames HTML→MP4）、Kokoro 本地 TTS、单色视觉体系。

融合目标（按优先级）：

1. **功能全量融合**：monoline 全部能力进入 Hertz，成为执行域下的独立一级菜单 `/monoline`
  （与 `/execution` 平级 sibling，不塞进现有 studio/pipeline 双 Tab）。
2. **技术栈对齐与反哺**：以 Hertz 地基为准（py3.12 / PG / 单航班+EventHub / SPA+API_BASE），
   同时把 monoline 的优秀机制回哺 Hertz（§7）。

非目标：monoline 独立进程/独立端口/独立 DB 文件/独立前端站点的任何保留。

## 2. 融合总架构

```
Hertz（单进程：8787 后端 + 3000 前端 dev / Electron file:// 打包）
├── backend/routers/monoline.py      # prefix="/monoline" → /api/monoline/*
├── backend/monoline/                # 子域包：service(单航班) + pipeline九阶段 + compose + tts
├── backend/models/monoline.py       # monoline_* 前缀 8 张表（PG + JSONB）
├── backend/ai/providers/kokoro.py   # tts角色新 protocol 分支（与 edge-tts 并存）
└── frontend/src/pages/monoline/     # /monoline/* 原生页面（New/Outline/Studio/History/Modes/Setup）
```

- **D-205 单进程单端口**：废弃 monoline 的 8787/8790 独立进程、`/` SPA 吞噬挂载、
  vite proxy 硬编码、`instance.json` 排他锁、`start.sh` 杀端口逻辑。
- **D-206 菜单位置**：`AppShell.tsx` 加 `{to:'/monoline', group:'produce'}`（紧随 `/plans`），
  不复用 `/execution?mode=`（现有 studio/pipeline 单航班状态机 + 全局徽标逻辑不可再添第三态）。
- **D-207 LLM 统一**：删除 monoline 自带的 LLM 环境探测与 `/chat/completions` 直调
  （`llm/client.py` 思想），写稿走 TaskRouter `main`、分镜/评分走 `fast`；
  规则回退链保留（无 LLM 也可出片是 monoline 的核心优点）。

## 3. 技术栈对比与对齐结论

| 维度 | Hertz（基准） | Monoline | 对齐结论 |
|---|---|---|---|
| Python | `>=3.12` | pin `3.11`（kokoro-onnx 无 3.14 wheel 的旧约束） | 以 3.12 为准。已实测 `kokoro-onnx 0.6.1` 为 `py3-none-any` 纯包、`onnxruntime 1.30` 有 cp312 arm64 wheel；Phase 0 在 3.12 下安装验证，通过则删 pin（待验证项：`misaki[zh]`） |
| 后端框架 | FastAPI + SQLAlchemy async + Alembic（42 版本，多 heads） | FastAPI + SQLite raw SQL + `001_init.sql` | 全量迁 PG，表名 `monoline_` 前缀；只加表不改旧表；保持 `upgrade heads` 可用 |
| 并发 | 单航班 asyncio.Task + 进程内 EventHub + SSE | 单 worker queue + 全内存 SSE fan-out + instance.json 排他锁 | 采用 Hertz 单航班；EventHub 新增 `monoline` / `monoline:{job_id}` 主题；排他锁删除 |
| 前端 | React 19 + Vite 6 + BrowserRouter + api/client + Query+zustand + Tailwind + i18n | React 19 + Vite 6 + hash 路由 + 裸 fetch + monochrome CSS + 自带中英 strings | 同代，直接搬：hash→BrowserRouter 子路由；裸 fetch→`api/monoline.ts`；`monoline.lang` 改名防撞；样式改 Tailwind（影片主题色以 API 投影保留为"影片主题"而非 UI 主题） |
| TTS | edge-tts（远端） | Kokoro 本地（tts_zh 声调路径 + hyperframes 回退） | 保留 Kokoro，新增 protocol 分支（§5.4）；权重/音色走 `data_dir/models/kokoro`（收敛 Hertz 本地模型目录习惯，不用 `~/.cache/hyperframes`） |
| 渲染 | produce/compose 链 | HyperFrames producer sidecar（Node+Chrome）+ player 前端 | Phase 3 做复用评估后再定（§6）；player（纯前端包）首期即用，sidecar 待定 |

## 4. 后端移植清单（Phase 1）

### 4.1 模型层 `backend/models/monoline.py`（新建）

`monoline_jobs / monoline_job_stages / monoline_segments / monoline_scene_plans /
monoline_artifacts / monoline_events / monoline_presets`（`schema_version` 不需要，Alembic 接管）。
`input_hash/output_json/plan_json/config_json` 用 JSONB；`models/__init__.py` 导出；
`alembic revision --autogenerate` + `upgrade heads` 验证。

### 4.2 纯逻辑层（与框架无关，近乎原样搬入 `backend/monoline/`）

`segment`（切分）/ `markdown`（块解析）/ `display_text`（GB/T 15834 标点单一 owner，
中文排版核心资产，整模块搬）/ `rotation`（版式轮换）/ `timings` / `sceneplan` /
`viz`（确定性数据可视化）/ `icons`（158 图标 + icons.json）/ `templates/`（28 kinds
jinja2 模板）/ `themes`（design tokens 解析）/ `subtitles` / `audio_mix`（BGM 侧链 ducking）。

### 4.3 服务层 `backend/monoline/service.py`（新建，仿 `orchestration/studio.py` 单航班）

- `JobManager`：`queue/manager.py` 思想（draft→queued→running→succeeded/failed/cancelled，
  重启 reconcile 续跑），内存 fan-out 改 EventHub，`cancel Event` 保留。
- 九阶段调度：`runner.py` 的 `stage()` 语义（`input_hash` 相等 + `ready()` 即 skipped，
  `force=1` 重画不重写 manual）+ `outline.py` 大纲审阅 + `recompose.py` 秒级重组，
  DB 访问全部改 `session_factory`。
- 产物目录：`workspaces/{job}` → `FileStore` 下 `output/monoline/{job}`；
  `/w/{job}/{rel}` → `/api/monoline/jobs/{id}/files/{rel}`（containment 检查保留）。

### 4.4 路由层 `backend/routers/monoline.py`（新建，`prefix="/monoline"`）

分两批：首批 jobs CRUD + outline + run/cancel/stream + config/themes/voices/brand/presets/script；
第二批逐拍编辑 7 路径；render/deliver 类（download/render/poster）等 Phase 3 结论。
SSE 仿 `routers/studio.py:70-82`。

### 4.5 AI 接线

- 删 `llm/client.py`；`llm/planner.py` 的 kind 白名单/升格策略保留，
  调用改 `TaskRouter.chat_messages(role="fast", caller="monoline")`，写稿走 `main`。
- Kokoro：新增 `backend/ai/providers/kokoro.py` + `templates.py` 加 `protocol="kokoro"` 模板 +
  `router.synthesize` 按 protocol 分发；25 音色注册为 `capability="tts"` 模型。

## 5. 前端移植清单（Phase 2）

`frontend/src/pages/monoline/`：`MonolinePage`（路由壳）+ New（贴稿+AI写稿+参数）+
OutlinePanel（合并/拆分/删/排/改写/挂图）+ Studio（三栏：beats/预览/inspector，快捷键与拖拽保留）+
History + Modes（28 种模式库）+ Setup（九项自检→`/api/monoline/health`）。
接线：`AppShell` 菜单+路由、`i18n/zh|en.json`（合并 monoline 自带 strings，不留两套）、
`api/monoline.ts` + `api/index.ts` 导出、`CommandPalette` 入口、全局运行徽标并入 monoline 运行态。
改写点：hash→BrowserRouter 嵌套路由；裸 fetch→API_BASE；EventSource→useEventSource；
`<hyperframes-player src>`→files 接口 URL。

## 6. Sidecar 复用评估（Phase 3，先评估后动手）

**结论（2026-09-27 实测，已决策）：CLI 优先，sidecar 接口预留，凭实测再定。**

评估证据：
- Hertz `compose_video` 是"文件进、文件出"（需已有 raw 视频），无法消费 scene_plan；
  scene_plan→像素唯一路径是无头 Chrome 逐帧捕获（`hf/cli.py` render），Hertz 全仓
  无浏览器渲染能力（playwright/puppeteer 零命中）——复用不可行，必须引入 HyperFrames。
- 本机就绪：npm 可达、`@hyperframes/producer 0.8.63` 在册、Chrome headless shell
  已缓存、nvm 有 v22.14.0（monoline 硬性 Node 版本）；`monoline/sidecar` 从未
  bootstrap，直接走 npx 按需拉，不提交 node_modules。
- 上游自带逃生语义（sidecar 连不上回退 CLI；渲染失败不退），CLI 优先有依据。

执行路线（CLI 优先）：
1. `hf/cli.py` → `backend/monoline/hf.py`（显式参数，保留三级错误 taxonomy）；
2. 二进制 `data/vendor/hyperframes` 预留位 → `npx --yes hyperframes@0.8.63`；
   Node 解析 `HERTZ_NODE22_BIN` → nvm v22.14.0 → 系统 node（验 major）；
3. `_write_hf_project` 脚手架 + `RENDER_WORKERS=1`；
4. runner 接入 fonts→compose→gate（lint）→render（CLI）→deliver；
5. Chrome 运行时下载到 `data/models/browser`，缺失 render 置灰；
6. 测试分层：argv/scaffold/lint 判定单测，真渲染标集成（缺 Chrome skip）；
7. 前端：`index.html` 经 files 接口 + `@hyperframes/player` 预览，MP4 挂下载。

## 7. 地基回哺 Hertz（Phase 4，不阻塞上线）

1. `docs/CONFIG.md` 式**接口双向比对测试**推广到 Hertz 全路由（文档↔openapi 双向断言）。
2. `PhaseEngine` 引入 `input_hash + ready()` **续跑语义**（重跑不再全量烧 token）。
3. `display_text.py` 中文排版单一 owner 推广到 Hertz 字幕/标题链。
4. `warmup` fixture 思想：monoline 一键冷启动验收（2 拍中文样例）。

## 8. 决策记录（D-205~D-211，仓库 DECISIONS.md 为准）

- **D-205 单进程单端口**：monoline 独立进程/端口/锁/杀端口脚本全部废弃，以 Hertz 进程为准。
- **D-206 一级菜单 sibling**：`/monoline` 与 `/execution` 平级，不污染现有双 Tab 状态机。
- **D-207 LLM 统一走 TaskRouter**：monoline 自带 LLM 客户端删除，规则回退保留。
- **D-208 作业数据迁 PG**：`monoline_` 前缀，只加表；SQLite 文件方案否决（双 DB 运维 + 跨库不可查）。
- **D-209 Kokoro 以 protocol 分支保留**：与 edge-tts 并存，权重目录收敛到 `data_dir/models`。
- **D-210 原目录只读参照**：`monoline/` 完工前不动，验收后归档删除；移植按文件重写，不整目录复制。

## 9. 风险与回滚

| 风险 | 等级 | 对策 |
|---|---|---|
| `misaki[zh]` 在 py3.12 无 wheel / espeak 缺失 | 高 | Phase 0 最先验证；失败则 Kokoro 降二期、edge-tts 顶，绝不阻塞 Phase 1 |
| Alembic 多 head 冲突 | 中 | 只加表不改旧表；CI 跑 `upgrade heads` |
| 28 kinds 模板 + Tailwind 统一膨胀 | 中 | 逻辑与样式分离：先全量可用（monochrome 原样），统一收尾 |
| Electron 打包体积 | 低 | 模型运行时下载（仿 whisper），不进包 |

回滚：全程 Hertz 主链路零改（仅 4 处新增挂载点），任何一期可独立停。

## 10. 里程碑

Phase 0（0.5天）→ Phase 1（3~5天）→ Phase 2（3~4天）→ Phase 3（1~2天）→ Phase 4（1~2天）。
每期结束给可运行验收点，见各 Phase 验收行。

## 11. Phase 0 验证结论（2026-09-27 实测）

- Python 3.12.11 独立 venv（`/tmp/ml-verify`，未污染 Hertz 主 venv）：
  `kokoro-onnx 0.6.1` / `misaki 0.9.4` / `onnxruntime 1.30.0` /
  `espeakng-loader 0.2.4` / `jieba 0.42.1` / `soundfile 0.14.0` 安装+导入全过。
- `monoline.tts_zh` + `monoline.narration` 在 3.12 下导入正常（仅 jieba  benign SyntaxWarning）。
- 中文 G2P 实测：`你好，世界` → `ni↓xau↓ , ʂɨ↘ʨje↘`，声调标记正常；英文经 espeak 路径正常。
- 端到端合成实测：`zf_xiaoxiao` 音色输出 4.52s / 217KB wav（权重来自
  `kokoro-onnx/model-files-v1.0`，已缓存于 `~/.cache/hyperframes/tts/`）。
- **结论：3.11 pin 可删**（D-209 成立条件满足）；`@hyperframes/player 0.8.63` 在 npm 存在，
  前端安装留待 Phase 2。

## 12. Phase 3 执行记录（2026-09-27 实测）

- CLI-first 落地：`backend/monoline/hf.py`（显式参数 + 三级错误 taxonomy），
  二进制 `data/vendor/hyperframes/node_modules/.bin/hyperframes`（npm 一次性安装，
  npx 冷下载又慢又不可靠）→ `npx --yes hyperframes@0.8.63` 兜底。
- 实测修掉 3 个真 bug：`lint`/`render` 调 `run()` 旧参数名；本地预留位路径假设错误；
  **cwd 与绝对路径叠加致双倍路径**（`cwd=None` 修复）。
- Node 经 nvm v22.14.0 解析注入 PATH；Chrome 经系统 `/Applications/Google Chrome.app`
  自动发现——`scripts/monoline_warmup.py` 两次 **`PASS（九阶段全链）`**，
  首条真成片：1920x1080 h264+aac，6.9s，1.4MB。
- `render_via_sidecar` 保留待二期；`data/models/browser` 为空时走系统 Chrome，
  health 的 `chrome_available` 已覆盖该路径。

## 13. Phase 4 地基回哺记录（2026-09-27）

- **4.1 接口清单防漂移**：`docs/API_INVENTORY.md`（204 操作）+ `tests/test_api_surface.py`
  双向比对（ghost/missing 任一方向失败）+ `scripts/api_inventory.py` 同步脚本。
- **4.2 排版 owner 推广**：`TaskRouter.title_and_tags` 的标题/描述/备选过
  `display_text.tidy`（比较去重改用 tidy 后标题，避免"备选与主标题差一个句号"漏剔）。
- **4.3 warmup 验收**：`scripts/monoline_warmup.py`（2 拍中文 fixture，真 Kokoro），
  两次 `PASS（九阶段全链）`，首条真成片 1920x1080 h264+aac 6.9s。
- **4.4 阶段指纹**：`PhaseResult.input_hash/reused` + `phase_input_hash()` 落库
  `phase_runs.output_json`（run 详情 API 自动透出）。**诚实边界**：只做同 run 内防重放，
  不做跨 run 自动复用——Hertz 每次运行是新 run_dir 且 LLM 非确定，直接复用会偷换
  "重新跑一次"的语义；实测还确认 prior excerpt 本来就是指纹的有效输入（写盘后
  第二次输入真变，指纹变化是正确的）。

## 14. 归档（D-210，2026-09-27）

- `monoline/` 原目录已归档并删除：归档包 `~/monoline-archive-20260927.tgz`
  （25MB / 244 文件，含其独立 .git 历史），Hertz 树内零引用残留（全仓 grep 确认）。
- 融合终态：后端 `backend/monoline/`（25 模块）+ 模型 8 表 + 路由 30 路径
  （API 清单 225 操作）+ 前端 `/monoline` 五视图 + 精修/交付/资产/写稿；
  上游 32 路径中 29 有 Hertz 对应实现（3 条 CLI 专属在单进程架构下 N/A）。
