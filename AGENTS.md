# AGENTS.md —— 在这个仓库里干活的入口

> 这份文件回答四件事：**门禁怎么跑**、**哪些不变量不能破**、**哪些坑已经踩过**、**什么别动**。
> 目标是让一个新会话不必重新推导这些。文档体系地图见 `docs/README.md`，项目当前状态见 `PROJECT.md`。

## 0. 这是什么项目

Hertz = 本地优先的 AI 内容工作台。Electron 壳 + FastAPI 后端 + React 前端 + `@hertz/mdcore`（排版/渲染内核，pnpm workspace 里的源码包）。

```
backend/     FastAPI（Python 3.12，uv 管理，端口 8787）
frontend/    React + Vite（端口 3000）
packages/mdcore/  排版内核：markdown-it 管线、主题、微信/知乎/小红书产物层
electron/    壳（开发态连 :8787；打包态拉起冻结后端 electron/backend-dist）
tests/       pytest（864）；packages 与 frontend 各有自己的 vitest
data/        用户数据（2.4GB，**别删、别提交**）
```

运行时：Python 3.12（`requires-python >=3.12`）、Node 26、pnpm 10。

## 1. 门禁

```bash
bash scripts/verify.sh            # 全量（含 18 张排版基线，最慢约 10 分钟）
bash scripts/verify.sh --quick    # 跳过基线（约 6-7 分钟）
bash scripts/dev.sh               # 起全栈：后端 8787 / 前端 3000 / Electron
```

八步：ruff → pytest → mdcore tsc → mdcore vitest → frontend tsc → frontend vitest → frontend build → 排版基线（`scripts/typography-baseline.mjs`，0.5% 阈值）。**脚本自带互斥锁**（`$TMPDIR/hertz-verify.lock`）：两个门禁叠着跑会打满内存导致系统卡死，被锁挡住时等它结束或先杀掉那个进程。

单点调试：

```bash
uv run pytest tests/test_xxx.py -q                     # 单个后端测试文件
uv run pytest -k "关键词"
uv run pytest -m "not ffmpeg" -q                       # 快速档：跳过真 ffmpeg 家族（assemble/媒体流/channels，~76 条）
pnpm --filter @hertz/mdcore test                       # mdcore
pnpm --filter hertz-frontend test                      # 前端
```

**改代码前先跑一遍相关的那一步**；提交前跑 `--quick`，发版前跑全量。

## 2. 不变量（破了就是 bug，不是风格问题）

| # | 不变量 | 守住它的判据 |
|---|---|---|
| 1 | **测试不写生产日志、不碰用户数据**：`tests/conftest.py` 必须在 import `backend.*` 之前注入 `HERTZ_DATABASE_URL`（→ `hertz_test`）与 `HERTZ_DATA_DIR`（→ 临时目录） | 跑完全量后 `logs/hertz.log` / `data/` 的 mtime 与大小不变 |
| 2 | **改了 `Settings` 默认值，要确认它真的生效**：`data/runtime.yaml` 经 `_EffectiveSettings` 代理**压过类默认值**，压过去时**不报错** | `tests/test_runtime_path_pinning.py` |
| 3 | **四方版本一致**：`backend/config.py:APP_VERSION`、`pyproject.toml`、`package.json`、`electron/package.json` | `tests/test_version_drift.py` |
| 4 | **API 清单是双向门禁**：路由变了必须重新生成 `docs/API_INVENTORY.md`，且 `scripts/api_inventory.py` 与 `tests/test_api_surface.py:11` 硬编码同一路径 | `test_api_surface.py`（少一条/多一条都红） |
| 5 | **一条坏数据不许连坐整批**：批量循环里的 `try/except` 要在**循环内** | `tests/test_heal_plans.py`（断言"一条 traceback 都没有"） |
| 6 | **凡落盘的外部文本先过脱敏** | `tests/test_redact.py`、`tests/test_download_resilience.py`（signed_url 判据所在） |
| 7 | **判"内容变没变"要判内容**：缓存键是内容哈希时，任何"比数量/长度"的判同都是错的 | `mermaidCacheSignature` + `AsyncRenderWiring.test.tsx` 源码级守卫 |
| 8 | **异步富集（Shiki / Mermaid）接同步渲染管线**：先出 hljs 产物再升级、失败保留旧产物且失败可见 | mdcore `theme/shiki.test.ts`、`theme/mermaid.test.ts` |
| 9 | **机翻不许带解码退化循环**：字幕里出现「正在 正在 正在」是 ct2 解码退化，不是脏素材也不是清洗链拼接 | `tests/test_translate_engine.py`（13 条，五组变异） |

## 3. 已经踩过的坑（每条都有判据了，别踩回去）

1. **"卡死/变慢"先把它变成一个可核对的数**（次数/秒、峰值、单次耗时），不要先改代码。反面教材见 `docs/decisions/D-231-runtime-yaml-stale-pin.md`：一份日志被我读成"2806 次重启风暴"，实际是 pytest 自己造 app——**判据跑在一层看不见失败的位置上，等于没验证**。
2. **日志里的生命周期记录先分清是谁打的**。同一条 lifespan 日志，测试造 app 和真实重启看不出区别。看三样：单次耗时（测试 ≈0.13s）、分布形状（测试是连续数小时平台段）、窗口是否与 pytest 吻合。
3. **注释是最容易骗人的文档**：它写意图，代码写事实。CanvasPanel 上一版注释写着"内容没变就交回同一个引用"，代码比的却是 `size`——没人会发现，因为**注释声称的语义本身值得一条判据**。
4. **富文本编辑器不是浏览器**：粘进公众号后 `---` 右居中、标题被拆行。画布完全正常、结构断言全绿，**只有产物层看得见**。规则统一在 `packages/mdcore/src/platform/editorCompat.ts`，测试单 `docs/MD_STUDIO_TEST_SHEET.md`。
5. **`vi.mock('@hertz/mdcore')` 拦不住页面内部的调用**（workspace 源码包的身份问题）。引擎替身走注入通道：`setCodeHighlighter()`，预置在 `frontend/src/test/setup.ts`。
6. **jsdom 里 mermaid 必失败 → cache 恒为空**，所以"改图之后画布换没换引用"这类状态在组件测试里根本观测不到。这时判据要**守接线本身**（源码级守卫），别去演一个演不出来的状态。
7. **每次写判据都要跑成对变异**：故意改坏实现，确认对应测试变红，再改回来。仓库里每组新判据都留了变异对照（`docs/decisions/README.md` 有清单）。**变异打不红时先怀疑判据测错了对象**——D-233 的 compose 第一版量成片视频流长度，而缺陷撑长的是音频；D-234 的阈值变异一开始只调到 1.0，而样本密度 2.4、门照样开，得调到 10 才咬得住。
8. **别把测试造成的负载当成产品缺陷**：全量 pytest（825+ 用例、每次建 app 都拉起 7 个定时任务与 DB 会话）与 dev 栈 + Postgres 同时跑，足以把 16GB 机器打满。
9. **门禁红了先问"是超时还是逻辑"**：`Unable to find [data-testid=…]` 这类失败多半是**等的时间不够**，不是元素没渲染出来。宿主接线那几条要渲染整页（markdown + 主题 + 异步 mermaid + snapdom），默认 `waitFor` 预算 1000ms 在机器一忙时就必红。放宽预算是正当修法，**放宽断言不是**（2026-10-18 打 0.37.0 时它挡过一次 tag，拦得对但拦错了东西）。等待预算在 `frontend/src/test/setup.ts` 的 `configure({ asyncUtilTimeout })`。
10. **媒体时长要问「哪一条流」**（判据：`tests/test_media_stream_duration.py`）。容器时长取**最长那条流**（通常是音频），素材里出现「音频比画面长」时它会大于视频流真实时长。凡是按时长算 offset / 校验产物的地方都要分开探两条流——`probe_video_duration` / `probe_audio_duration`。教训见 `CHANGELOG` 的「合集成片后半段黑屏」：xfade 在 offset 越过已拼画面时**不报错**，只是停止延长视频，而容器时长校验把这个缺陷判成了成功。已修的四处：`assemble`（offset 与校验）、`cover`（黑封面）、`phash`（哈希静默失效）、`compose`（原声轨没裁，字幕排进无画面的时段）。
11. **配置项写错地方会被静默忽略**：`asyncUtilTimeout` 是 **@testing-library** 的键，第一版误写进 `vite.config.ts` 的 `test` 里——不报错、不生效，超时照旧，于是"看起来改了但没用"。改超时配置时**必须用压测证明它生效了**（8 个 CPU burner 压着跑，之前必红之后必绿才算数）。
12. **报「字幕有重复短语」先剥离定位，别先改清洗链**（判据：`tests/test_translate_engine.py`）：一层层剥——ASR 源文 → 引擎原始返回 → 清洗链，哪层第一次出现重复就修哪层。这次是 `translate_batch_local` 的**原始返回值**已经在复读，而 ct2 的默认参数本身就会退化（11 条源文 10 条超标，连正常句子也中），`max_decoding_length=256` 还会把长输出顶断在半句上。护栏修在引擎出口（两处调用路径一并覆盖），三层各有各的判据——见 D-234。
13. **烧录字幕的缺陷画布上看不见，只有产物层看得见**（判据：`tests/test_producer_assemble.py` 含烧黑场像素级留白 + 非空自检；`tests/test_pipeline_governance.py` retranslate 交 `.srt` 断言）：libass 对**无空格中文不折行**（WrapStyle 0/1/2 实测同一张图），句块叠行、两端被裁；把 ASS 回喂 `srt_to_ass` 会被当 SRT 解析出 0 条 Dialogue、空壳覆写好字幕。折行做在生成侧、SRT 契约不许破——见 D-235。

## 4. 别动

- **`data/`** —— 用户成片、素材、数据库（2.4GB）。测试靠 `HERTZ_DATA_DIR` 隔离，改隔离项前先读 `tests/conftest.py` 顶部注释。
- **`electron/backend-dist/`** —— PyInstaller 冻结后端产物，由 `scripts/build-backend.sh` 重新生成，不要手改。
- **`docs/API_INVENTORY.md`** —— 生成物，改路由后用 `uv run python scripts/api_inventory.py` 重新生成，别手编。
- **`logs/`** —— 运行日志，已被 `.gitignore` 忽略并改道到 `data/logs/`。
- **`docs/archive/`** —— 历史文档，原样保留是为了可追溯；**不要**在归档件里继续更新。

## 5. 文档改动规矩

- **一个事实一个权威**。要写新事实，先问：这件事的权威在哪儿？其余地方只**链**，不抄。
- **新决策** → `docs/decisions/D-<编号>-<短名>.md`，用 `docs/decisions/README.md` 里的模板，编号递增不复用。
- **CHANGELOG 只写"变了什么"**：单条 ≤12 行；**一次交付的多项能力可合成一个批次条目**
  （判据是"它们是否共享同一次验证与验收"），但批次条目里也只列事实、不写推理过程。
  "为什么"写进 ADR 并链过去。**判据写进代码与测试**，别只写在文档里。
- **状态变了要更新 `PROJECT.md`**（里程碑、架构变更、发版、重大风险）。
- 归档用 `git mv` + 顶部三行状态头（已归档 / 被谁取代 / 何时），**不要重写归档内容**——重写历史会制造无法核对的"真相"。

## 6. 提交与发版

- 主干 `main` 保持可用；结构性改动走分支，**验证不过不合并**。
- 提交信息沿用仓库风格：`type(scope): 中文一句话——关键要点`。
- `[Unreleased]` 累积到发版点时收成一个版本号并打 tag；`APP_VERSION` 与 tag 同步（D-202 的教训：版本号漂移会把排查带偏）。
