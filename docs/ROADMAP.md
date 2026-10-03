# Hertz 路线图

> 各波次进度与验收详见 [HERTZ_RECONSTRUCTION.md](./HERTZ_RECONSTRUCTION.md)（九、实施波次）。

## 已交付

- **Wave 0-3**：骨架、基础设施（配置/日志/存储/迁移）、AI 接口层（DeepSeek/ComfyUI/TTS）、Factory 装配、下载引擎、资源管理、编排域（多阶段工作流 + SSE）
- **Wave 4**：内容流水线（采集/评分/下载/生产/审核/发布）与 Console 控制台
- **Wave 5**：灵感画布（相似度/聚类/低语/粉笔渲染）与对话流（SSE 持久化）
- **Wave 6**：健康检查（工具/磁盘/AI）、错误边界与全局异常处理、Electron 打包（backend 随包 + 自动更新）
- **Wave 6.5**：Axiom 全局审计——SSRF/路径穿越/密钥配置加固、media_url 落库、i18n 全量、SSE 重连、ChatPage 单源、persist 节流（详见 HERTZ_RECONSTRUCTION.md §9）
- **v0.11.2-0.11.6**：字幕标点清洗强化 → 句首逗号根因修复（ASS Format 缺 Name）→ 发布流程重构（立即发布/原文简介/当天高峰排期/随机封面）→ 情感垂直频道（源池勾选 UI + emotion 加权评分 + 情感标题/分区）→ 健康看板 UI（设置页，v0.11.6 清偿本表「健康检查 UI」项）→ 版本单一真相源（backend.config.APP_VERSION）
- **v0.11.7**：文字故事产线主体（text_only 采集存储 + 下载跳过 + LLM 中文故事旁白 + 固定中文 TTS + 渐变背景/标题卡图文合成 + 敏感词 SAFETY/MARKETING 分层 + 故事源入池）——已端到端验证（真实条目 29s 成片，OCR 确认字幕无前导逗号）；**待数据通道修复后全量启用**（Reddit 匿名 JSON/RSS 403 Blocked，cookie 失效，需 OAuth 凭证）
- **v0.11.8-0.11.10**：批量操作分片（全选超 200 上限 422 消除）→ 取消制作（协作式检查点 + ffmpeg 轮询终止，回滚 downloaded）+ 发布目标 NOOP 根因修复（runtime allowlist 缺失致保存静默失败）+ 默认直发 + 审核卡发布标题/随机封面入口/header 分组重排 → 绕过评分直接下载（引擎 input_statuses 宽松路径 + 未评分徽章降级）
- **v0.13**：发布策略引擎（B 站发布节奏精细化运营）——账号健康度四相位（warmup 爬坡/caution 减半/cooldown 停发）动态配额 × 内容分层选条目 × 同分区间隔/相邻去重槽位；零新表派生推导，总开关默认关；QueueView 账号状态卡
- **v0.14**：成本控制顶级菜单——ai_calls 用量 × ai_model_prices 查询时动态计价（D-176）；按环节/模型/日趋势聚合 + 执行历史明细 + 未配价警告；环节归因补齐（translate/orchestrator）
- **v0.15**：质量与 ROI 三件套（同赛道调研落地）——三步翻译法（直译→反思→意译）+ 翻译术语表（结构化表 + AI 辅助提取 + prompt 注入）；条目成本 ROI（AI 成本 × 播放 × 千次成本）；标题 N 选 1（3 候选发布卡切换）。**前两项已于 v0.22.x 整体移除**（D-189：Opus-MT 为唯一引擎，术语表判为伪功能，表经 wave21 删除）——此处保留为历史记录，勿当现状
- **v0.16**：热点监控通道（TrendRadar 词法借鉴）——rising 高频拉取 + 三段词法预筛（any/all/exclude + 分数门槛），filter_fn 注入 run_collect；设置页热点监控区
- **v0.17**：月度预算阶梯提醒（Helicone 借鉴，50%/80%/95% 只警示不阻断）+ service.py 四域 Mixin 拆分（D-168 架构债清偿，1805 行 → 196 核心四域文件）
- **v0.18**：移动化与信任建立——Telegram 审核 Bot（long-polling 零公网暴露 + inline 三键过审 + 告警通道）；策略影子模式（dry_run 演练影子计划）；发布日历热力图；频道人设记忆注入创作 prompt
- **v0.19**：数据飞轮一期补完——频道洞察（Top/Bottom 对比 LLM 分析落库 + 注入评分 rubric 与脚本 prompt，冷启动保护）+ Telegram 周报推送；审核推送改最新优先修积压饿死缺陷
- **v0.20**：工程健康——SettingsPage 拆分（1332 → 265 主壳 + 四分区文件，SectionProps 契约）+ ai_calls 聚合 2 万行防线；PipelineView 五 tab 拆分（1355 → 319 主壳 + pipeline/ 六文件，「state 留壳、JSX 下放」，D-183）；测试门禁修复（Node ≥22 实验性 localStorage 遮蔽 jsdom 致 zustand persist 崩 → setup.ts 内存 shim；后端 4 处存量 lint 清零）——verify.sh 恢复全绿
- **v0.21**：P0 安装即用闭环（D-184/D-185）——PyInstaller 固化后端（backend/entrypoint.py：asyncpg 兜底建库 + 编程式 alembic + uvicorn）；内嵌 PostgreSQL（zonky darwin-arm64 发行包首启自动下载到 userData，initdb/pg_ctl 托管，动态端口，退出随停）；electron 打包态跑固化二进制 + HERTZ_USER_DATA 隔离钩子；release.yml tag 触发 mac arm64 构建发 GitHub Releases——新机零配置验收通过；ffmpeg 内嵌兜底（imageio 7.1 含 libass，系统版优先）+ ffprobe 独立解析拆雷；冷启动归因留档（冻结静态导入 ~17s，业务侧全快）；CI 实战首跑验证通过，v0.21.0 dmg 已发布（D-185）
- **v0.22**：栏目化内容工厂（D-186，非破坏性）——多源采集路由（裸名=Reddit 兼容，存量转载源零改动）；AI 原创情感故事源（LLM 直产 text_only 种子，成本闸 per_tick=2，栏目人设注入）+ RSS 通用文本源双新源；栏目实体 wave20（源池/固定音色/B站分区/简介模板/标签/标题风格/persona/片头配置绑定单元）+ items.channel_key 采集打标；固定音色优先级链（栏目>注册表>自适应）；动态标题卡片头（produce 单点汇聚前置 concat，三重降级）；包装注入（标题风格/标签置顶/desc 模板/bili_tid）；设置页 ChannelsCard 管理 UI。Reddit 凭证路径确认死路后降级为可选插件，存量转载分发链路零触碰
- **v0.22.x**：全系统架构审计第一轮清偿（D-187）——_serialize 双死代码删除；telegram push_alert 三接线（熔断/发布失败/预算阶梯，哑火通道复活）；RSS SSRF 防护；ffprobe 探测收敛单一出口；telemetry tick 环形记录 + /api/metrics 端点 + DB 每日备份滚动保留。遗留 B 系结构清偿逐轮推进（media.py 拆分/retranslate 下沉/service_publish 再切等）；翻译引擎可插拔（D-188）——本地 Opus-MT en→zh（ctranslate2 零新增重依赖，模型首用自动下载）与 API 三步法随时切换 + 字幕缓存复用省重复调用
- **v0.23**：地基巩固四项收口（D-191 前置，零行为变更）——media.py 解体收尾（compose/cover/probe/narration/retranslate 等 13 域文件切出，主文件 2141→648 行）；usePipelineExecution 630 行总线 hook 按域拆为 usePipelineData/Actions/Events 三 hooks（壳 30 行）；错误处理统一（ErrorBoundary + 全局 unhandledrejection 监听，异步错误不再无声消失）；script_json 读写两侧全量收敛至 sk 契约常量
- **v0.24**：脚本工坊 MVP（D-192，能力一落地）——语音草稿 → faster-whisper 本地转写 → 逐句编辑入库，产出直连既有 TTS→ASS→ffmpeg 下游零改动；TTS 试听、句子拖拽排序、朗读时长实时预估、纯文本直录、草稿暂存；第六 tab 接入流水线导航可达
- **v0.25**：规则评分引擎 + 智能路由阶梯降级（D-193）——多信号启发式打分（高置信免 LLM，仅灰区增强）；成本阶梯收口两处：budget critical/exceeded 时 router.score 强制本地启发式（零 API）、exceeded 时 ScoreStep 跳过自动批次（人工触发仍可用）。可量化点：API 调用量下降
- **v0.26**：创作资产系统 + 半自动面板（D-194～D-196）——灵感笔记 sidecar 与素材关联、灵感片段标记（t0/t1 + label，与原始素材分离）、素材组合预览、视觉风格预设（wave25_style_presets）；制作优先级 items.priority 列（wave26_item_priority，engine 取件按降序，批量队列拖拽排序的持久化后端）
- **运营面板补齐**（D-197，并入 v0.26 节奏）——流水线壳 Enter 展开/折叠焦点卡文案（与既有 j/k/a/r 同域，state 留壳故监听单点）、发布日历栏目色彩标记（channel_key 哈希稳定色相）
- **v0.30**：整合发布（本轮）——零新功能，但**非零行为变更**：唯一实改是固化启动器迁移目标 `head` → `heads`（多 head 现状下新库首启必抛 CommandError，dev 库早已 stamp 双 head 故隐身，D-198）。发布收尾四件：verify.sh 全绿（ruff/pytest 351/tsc/vitest 35/vite build）、版本号五处对齐 0.30.0（config/electron/frontend/根 package/pyproject）、本地 --dir 打包 + 隔离库新机模拟（health database ok + pipeline API 200 + style_presets 表 + items.priority 列）+ dmg 挂载卷直启实测（首启内嵌 PG 自动装成 → health ok → 零残留退出）、tag v0.30.0 推远端走 release.yml 出 mac-arm64 dmg。战略四项能力（脚本工坊/创作资产/降级路由/运营面板）至此成版
- **v0.30.1**：补丁发布（D-199，三处「文档说交付了、产物里没有」）——转写端点函数级 import 幽灵符号导致招牌路径从未可用（崩 500，静态检查与既有测试全不可见）；`scripts/dev.sh` 与计划书指令仍是单数 `alembic upgrade head`，新克隆冷启动即挂；固化后端建库丢弃口令，外部 PostgreSQL 逃生通道必死。附带修掉一条随挂钟变红的闸门测试，并补 10 项防复发护栏（AST 全仓幽灵符号扫描 / 迁移入口必须复数 heads 的文本+行为双守卫 / 口令透传双路径 / 禁测试裸用真实时钟）——351 → 361

## 在飞（代码已在 main，未打 tag、未发布）

> **2026-09-30 一页状态（给下一个读这里的你；全部是已完成的事实，没有进行时）**
>
> - **发版口径已定：一次发 v0.34.0（用户 2026-09-30 选定）**。理由：仓库最新 tag 是 `v0.30.1`，v0.33.0 从未打 tag、从未 push、从未出过产物，而它之后又叠了 16 个提交（A/B/C 三片）——给一段没发布过的提交单独占一个版本号，只会造出「CHANGELOG 说 0.33.0 交付了 X，而任何 0.33.0 产物里都没有 X」。**版本五处已对齐 0.34.0**（`backend/config.py:APP_VERSION`、`package.json`、`frontend/package.json`、`electron/package.json`、`pyproject.toml`，另 `uv.lock` 里项目自身那条也同步），CHANGELOG 的 `[v0.33.0]` 段已并入 `[v0.34.0]` 并追加本片内容，自 `v0.30.1` 起实测 **42 个提交**。**仍未做、且需要单独授权**：`scripts/release-check.sh`（产物门禁）、`git tag v0.34.0`、`git push`（`origin/main` 现落后 16 个提交）。
> - **A（未评分三轴筛选）已交付**：后端 `6172dde` + 界面接线 `fb735b2`。主题（情感 17 子版）/ 质量档 / 正文有无三轴全部**服务端**筛；`core/preReviewFilter.ts` 是「界面选择 → HTTP query」的唯一构造点，列表与分面共用，`hit/total` 两个数分开报（外加 `unfilled` 那一档）。
> - **C-code 已交付 `aa206c2`**：①`_listing_params` 让匿名 JSON 与 OAuth 共用同一个 `raw_json=1`；②`quality.reassess()` 是**唯一能摘隔离标**的出口；③体检第 7 条 `story_without_text`；④`scripts/backfill-selftext.py` 默认干跑 + 出网探针失败即退出 2 且一个查询都不发。顺手修掉长期误报的体检第 3 条（不排除 `is_invalid` + 写死 `limit(500)`），dev 库体检 **2 红 → 1 红**，剩下的 `invalid_share 2196` 才是真信号。
> - **C-run 未跑，被网络挡着（2026-09-30 复测，口径比「egress 000」更准）**：代理本身活着且能出网（`pypi.org` / `github.com` 经 `127.0.0.1:7897` 或直接都是 **200**），但 **reddit 全域名都是 `000`**——`www.reddit.com` / `oauth.reddit.com` / `api.reddit.com` / `v.redd.it` 直连与经代理各测一遍，全部连接超时；`1.1.1.1` 的 DoH 查询也超时，所以拿不到干净对照。本机 `dscacheutil` 解析 `www.reddit.com` 只回一个 `ipv6_address: 2001::1`（Teredo 段，注入的典型特征）、**没有 A 记录**；`/etc/hosts` 里没有写死 reddit。结论：**这不是代码问题，也不是「整体断网」**——是这台机器到 reddit 的通路（代理规则/DNS）被单独挡住，采集与正文回填在这台机器上都跑不动。命令已就绪：`uv run python scripts/backfill-selftext.py`（先看干跑，再 `--apply`）。
> - **B（看板融合）已交付**：后端契约 `754ff2c`（`daily_goal` + `items.focus_date/focus_note` + wave31 + `board_store` + `GET /api/pipeline/board` + `core/boardWindow`），界面 `5469344`（BoardTab + 撤三个界面写点）。tab 数 **6→6**（看板**替换**发布 tab，队列/日历/入队三个界面写点撤掉，字段与后端机制全留）。`./scripts/verify.sh` 五段全绿：ruff 0、全量 pytest **578 passed**、tsc 0、vitest **17 文件 / 77 tests**、vite build OK。
> - **设置页新增「规范与计划」一节（D-215，本轮最后一格）**：用户要的是「自己能编辑的一本册子」（大概规范 + 固定计划），不是又一个生效配置。两个长文本字段 `creator_norms` / `standing_plan` 落 `runtime.yaml`（无新表无迁移），**不注入任何 prompt**、也不并进 `channel_persona`（那个会被 `ai/router.py` 拼进脚本与标题提示词，合成一格就等于「改备注 → 改口播」）。全量 pytest 587 passed，3 条新测试（含真 PATCH→GET 往返）+ 3 处变异。
> - **`webui.sh` 起不来已修**：SIGTERM 杀不动卡死的 uvicorn（优雅退出要事件循环还转得动）→ 改 TERM→轮询→SIGKILL→复查；另 `lsof -ti tcp:$PORT` 会连**已连接的客户端**一起返回（旧写法能 kill 到浏览器），已加 `-sTCP:LISTEN`。真复现体验过（`SIG_IGN` 的监听者被强杀成功、客户端存活）。
> - **spec §4.6 的第 8 条体检项已交付（D-214）**：原判据照抄会造出长期红的报警器（「今天捞入又被拒」是日常操作，谁都不清 focus）。改两步做：先给「清」一个作者（`board_store.clear_focus` 接进 `engine.reject` / `service_archive.archive` / 发布三处），再上 `check_focus_orphan`；视图层另留兜底 `FOCUS_EXCLUDED_STATUSES`（已拒/已发不进今日列、也不计进完成度的 M）。全量 pytest 因此 **578 → 584**。决策与两条教训写在 `docs/DECISIONS.md` 的 D-213 / D-214。
> - **供给这条底座没变**：`items.selftext` 全库 **0/5281**；隔离池 2196 条里 **2013 条（91.7%）就是情感**、1982 条来自文字为主子版，未隔离的同子版只剩 6 条。你要做的情感**文字**垂直，弹药是 6 条而不是 1982 条——差的缺的只是正文，且 2196 条**全部带 `source_id`，可回填**（= 上面的 C-run）。
> - **还开着的三件事**：① 授权 `release-check.sh` + push + 打 tag `v0.34.0`（口径见本段第一条）；② C-run（要出网）；③ Reddit OAuth 凭证要你在外部注册后填进设置页（能力矩阵已能看到「已配置/未配置」，`probe=true` 会真去换一次 token）。
> - **一条既存缺陷本轮顺手修了**：`/queue` 深链指向 `?mode=queue`，而 `ExecutionPage` 只认 `pipeline|monoline` ⇒ 书签进来一直是 Studio。改指 `mode=pipeline`。
> - **两条按证据作废的 spec 判据**（细节在 `docs/SPEC_V034_BOARD.md` §4.4c / §4.6）：`queueView()` 不能删（运营看板是活读者）；`focus_orphan` 不变量不做（正常「捞入后又拒绝」就会红 = 新造长期红报警器）。
> - 另留一条自己的错：修 I3 时发现 `monkeypatch` 撤销会把旧值写成配置代理的实例属性，从此遮蔽 `runtime.yaml` 的 read-through（CHANGELOG 遗留第 4 条）——真正的修法在 `backend/config.py` 的代理形状，属独立切片。

- **v0.31 尾巴**：B1/B3 引擎入包 ✅（D-200）；B4/B5「模型搬家 + 一键下载」✅ 已并入 v0.32 S4（D-203）。**仍未做**：141MB 全量冷启动首下的成功实测——本机代理 egress 两次中断，只拿到 30MB/141MB 进度与完整失败路径证据；判据已沉淀为 `scripts/sim-newmachine.sh --with-download`（断言模型落进应用目录且 `~/.cache/huggingface` 一个字节不长）
- **v0.32 质量片 S1–S6 ✅**（D-201…D-204）：alembic 删表闸 / 工坊中文输出繁体纠偏 / schema 漂移清偿 / 文档卫生 / 产物级发布门禁 / 本地模型单一真相源，外加清偿一条 **v0.20 起设置页只演出不落盘**的回归（D-204：`save()` 提交的是空 `overrides`，改动全在内存里，页面却 toast「已保存」）。S7 前端拆壳按定档不在本版。**发布动作未执行**（口径已变：这几波连同 v0.34 的 A/B/C 一起并进 **v0.34.0** 一次发，见本段第一条；push / 打 tag 仍需单独授权）
- **v0.33 空壳条目治理（D-212，本轮唯一新增工作面）**：起因是用户报「下载一直 403」。实测根因不是 CDN，而是采集器兜底「不确定就算 video_raw」把 **2011 条 `media_url == source_url`（帖子页当媒体）** 的空壳放进了可操作队列，其中 1989 条连正文都没有；点一次下载就是抓被 Reddit 反爬拦截的页面（实测同机页面 403 / `v.redd.it` 直链 200），403 还会把整域冻进冷却，连带 2089 条真视频停摆。交付：`pipeline/quality.py` 作判据唯一作者（含状态范围：终态一律不动）+ 新增布尔 `is_invalid`（wave30）+ `counts()` 与列表共用 `operational_filters()` + 异常区「空壳」池 + `engine._pending` 不再白跑 + 常驻数据体检 `integrity`（六条不变量，只报不改）+ `scripts/quarantine-shell-items.py`（干跑/`--apply`/`--restore`）。dev 库实测：**discovered 4703→2666、failed 181→27、queued 5→0，rejected 371 / published 18 一条未动**。附带修掉「回环地址被系统代理吃掉」（`infrastructure/net.client_kwargs`）。**发布动作未执行**（v0.33.0 从未打 tag，内容与 v0.31/v0.32 一起并入 v0.34.0 一次发）
- 当前门禁水位（v0.33 代理收口 + 门禁代修之后）：`ruff check backend tests` **EXIT=0**、pytest **504 passed**（`/tmp/fix_r1_full_suite.log`）、`tests/test_monoline_llm.py` 13 passed——上面那条「红在第一阶段」已由 `a2e88fe` 清偿（`suggest` 提升为模块级 import 恢复打桩位、两条死别名删除、两处 N812 改小写，零业务逻辑改动）。代理旁路收成单一作者：`226bd85` + 正向棘轮 `5af6627`（守卫原先只禁旧形状，删掉 `**client_kwargs(...)` 回退成裸 client 时守卫与测试双双绿；现在回退即红，且有变异证据）。vitest/tsc 水位本轮未重测，留给 `verify.sh`
- **情感垂类的供给链是断的（实测，未修）**：`items.selftext` 在 dev 库 **5281 行里 0 行非空**，而 AITA / offmychest / relationship_advice / TrueOffMyChest 这类帖子本来就是文字帖——`offmychest` 503 条全部无正文且全部已隔离、`AmItheAsshole` 419/418、`relationship_advice` 374/374、`TrueOffMyChest` 251/251；v0.33 隔离原因第一名「media_url 落在 Reddit 页面域…正文也不足门槛」占 **1992 条**。机制：`collectors/reddit.py:397-421` 的 `_to_post` 是**唯一**写 selftext 的入口，只在 JSON/OAuth 路径被调用；`:240-250` 匿名 JSON 遇 403/429 **静默降级 RSS**，而 `:372` 注释自陈「RSS 通道拿不到 selftext」。即「下载偶尔 403」与「情感内容全是空壳」是同一个上游缺陷的两张脸。**未实测**：本机代理 egress 今夜整体不通（reddit 与 huggingface 均 `000`），所以「v0.33 之后新采集是否真带上正文」尚未验证；`source_state.last_strategy` 只有通道计数（json 24 / rss 11 / pullpush 5——pullpush 在当前 reddit.py 已不存在，那 5 行是历史值，未据它下结论）。推论：Reddit OAuth 凭证（原以为可选优化）可能是情感文字产线的**先决条件**。**离线尖峰已排除判据链嫌疑**（`/tmp/selftext_spike.log`）：喂一条 281 字正文的文字帖进 `_to_post` + `quality.stamp`，得到 `item_type='text_only'`、`media_url=''`、`is_invalid=None`——v0.33 的闸**放行的正是故事帖**，缺的只有供给。同时量到一个具体缺陷：`_collect_json`（匿名通道）**不传 `raw_json=1`**，而 `_collect_oauth` 传（`reddit.py:288` vs `:261`）——`raw_json=0` 时 Reddit 会把 `selftext` 按自家渲染转义（`&#32;` / `&amp;` 之类实体），一个以文字为弹药的垂类第一天就会吃到脏正文。**存量规模已量化（`/tmp/quarantine_stock.log`，它直接决定优先级）**：v0.33 隔离的 **2196 条里 2013 条（91.7％）落在情感名单内**，其中 **1982 条来自文字为主子版**（`offmychest` 503 / `AmItheAsshole` 418 / `relationship_advice` 374 / `relationships` 328 / `TrueOffMyChest` 251 / `BestofRedditorUpdates` 71 / `JustNoFamily` 37），而**未隔离的同子版条目只剩 6 条**——情感文字垂类今天可操作供给 = 6 条。可回填：2196 条**全部带 `source_id`**（`/api/info.json?id=t3_…` 每请求 100 个 id，帖龄 2026-08-07..08-24）。回填的前置约束：`quality.stamp` 只加隔离标、不清标，所以要先给 `quality` 补一个「理由不再成立即清标」的 `reassess()` 单一作者——**回填脚本自己写 `is_invalid=False` 就是第二个作者**
- 两项新需求已定档待批（2026-09-28 用户提出）：**A** 未评分区「情感主题轴 + 质量轴」筛选（bounded；主题名单从 `category.py` 的 subreddit→分区表里抽成 `THEME_SUBREDDITS` 单一作者、分区行为机械等价；筛选必须服务端做——`PreReviewTab` 只拉 500 条而 discovered 活口 2659 条，客户端筛会得出「没有情感内容」的假结论；`score_dimensions.emotion` 仅覆盖 246/5281=4.7%，故不以 LLM 情感分为判据）；**B** 队列 + 日历融合为看板 + 每日目标（architectural，需 spec→plan；用户已定「全部手动发、两个视图都撤」。前提纠正：`queue_phase`/`scheduled_at` 有四处活读者——`telegram_bot.py:87,273`、`service_promotion.py` 产能槽位、`integrity.py:197-206` 不变量、`service_archive.py:58`——故撤界面不撤字段；`publish_one` 实测只要求 `APPROVED`（`service_publish.py:91`），队列对手动路径确为装饰）。本条推翻 D-132、取消 D-191 的日历增强，待 DECISIONS 记录

## v0.30 战略方向

> 详见 [VISION_V030.md](./VISION_V030.md)

**定位转向**：从「内容工厂」到「创作者工坊」——工具优化机械环节，创意决策归人。

四项核心能力：脚本工坊（语音草稿→逐句打磨）/ 创作资产图（灵感↔素材关联）/
智能降级路由（Tier A-D 供给分层）/ 半自动运营面板（批量+快捷键全覆盖）。

版本节奏：v0.23 地基巩固 → v0.24 脚本工坊 MVP → v0.25 智能路由+规则评分
→ v0.26 创作资产系统 → v0.30 整合发布。

---

## 已知缺口

| 项 | 说明 | 优先级 |
|---|---|---|
| API 鉴权接入 | auth.py 已有 JWT 原语零调用；桌面单用户场景接受，部署为服务时必须接入 | 高 |
| macOS 签名与自动更新 | 无 Developer ID：electron-updater 在 mac 不可用（dmg 手动下载）；签名后开启 win/linux/mac 三端自动更新 | 中 |
| CI 平台矩阵扩展 | release.yml 目前仅 mac arm64（已本地验收）；win/linux 盲发需先行真机验证 | 中 |
| 应用图标与代码签名 | 当前用默认 Electron 图标；macOS 需 Developer ID、Windows 需 EV 证书 | 中 |
| 文字故事产线 | 主体已完成（v0.11.7 已验证）；剩余：数据通道修复（Reddit OAuth/cookie）→ 全量启用 + IP 化 | 中 |
| 半自动内容生产 | 情感频道第二阶段整体规划（文字产线 + 片头/IP 化） | 中 |
| Agent 工具调用 | 对话的 agent 模式（shell/playwright 等）为非目标，列为后续 | 低 |
| 向量检索/记忆 | Milvus/Redis 体系，增强对话上下文 | 低 |
| 多平台发布 | Bilibili 之外的 YouTube/其他平台发布器 | 低 |

## 下一步候选

1. **P1 情感频道第二阶段（收尾）**：故事源数据通道修复（Reddit OAuth 凭证配置/cookie 刷新）→ 全量采集启用，IP 化（片头/固定音色/栏目化）
2. **P1 体验打磨**：下载队列重排、画布多板/图层/图片卡片、对话引用画布卡片
3. **P1 脚本工坊二期**：风格锚点对照检查（当前为预设保存，未做写作时实时比对）、片段↔条目双向引用可视化
4. **P2 发布扩展**：更多平台发布器、定时自动发布、数据导出/导入
5. **P2 平台矩阵与签名**：mac Developer ID 签名（解锁自动更新）+ win/linux 真机验证后扩矩阵（见已知缺口，不在 v0.30 范围）

## 维护约定

- 每个迭代跑 `./scripts/verify.sh`（ruff → pytest → tsc → vitest → vite build）全绿才算完成
- **打 tag 前必跑 `./scripts/release-check.sh`**（v0.32 S5）：源码门禁 → 重建固化包 → 产物级门禁（空库首启 / head 对比 / schema / API 契约 / 转写 / 进程守卫）。v0.30–v0.32 有四个缺陷全部绕过了 `verify.sh`——源码级绿不代表装得上
- 新决策记入 `docs/DECISIONS.md`，波次回顾记入 `HERTZ_RECONSTRUCTION.md`
