# Changelog

本项目所有显著变更都将记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

（暂无未发布变更。原先挂在本段的三条 v0.34 工作面——未评分三轴筛选 A、情感供给链 C-code、看板 B——已全部并入下面的 `[v0.34.0]`。）

## [v0.34.0] - 2026-09-30

自 `v0.30.1` 起 **42 个提交**（`git rev-list --count v0.30.1..HEAD`，2026-09-30 于本发版提交之前量）。

**为什么这一版把原来的 `[v0.33.0]` 段一起吃掉**：v0.33.0 从未打 tag、从未 push、从未出过产物（发版准备提交 `4d4f050` 之后 main 上又叠了 16 个提交：A 筛选、C-code 供给片、B 看板后端+界面、第 8 条体检）。给一段**没有发布过**的提交单独占一个版本号，结果就是「CHANGELOG 说 0.33.0 交付了 X，而任何 0.33.0 的产物里都没有 X」——这正是本仓一路在防的那类缺陷（见 D-185 之后各轮「文档说交付了、产物里没有」的补丁条目）。下面各小节按原样保留，新增内容追加在「已知遗留」之前。

### 文稿成片融合域（monoline，D-205~D-211，执行域独立菜单 `/monoline`）

- 九阶段文稿转视频全链：大纲审阅（合并/拆分/ pin 图）→ Kokoro 本地配音 → 组装 → 分镜 → 字体子集化 → 合成 → HyperFrames 门禁/渲染/交付；`scripts/monoline_warmup.py` 冷启动验收
- 逐拍精修：改旁白（单拍重 TTS）、换 kind/版式/图标/槽位、拖拽重排（音频跟随）、单拍/全片换音色、换主题、单拍问模型、快捷键 j/k/1-9
- 交付物：分镜浏览器内预览、MP4 行内播放与下载、字幕 srt/vtt、封面；作业列表 poster 缩略图
- 资产链：图片/BGM/Logo 上传冻结、品牌默认外观、音色试听、AI 写稿（主题/语气/篇幅）
- 地基回哺：API 清单 228 操作双向比对、标题排版 owner、阶段输入指纹、httpx 本地直连（`trust_env=False`）+ 502/503 重试
- 打包：`hertz.spec` 收 TTS 链与 monoline 运行期数据，冻结包内真机验证通过

### 本地引擎入包（v0.31 B1/B3，D-200）

faster-whisper 与 ctranslate2 升为主依赖、删掉到不了的 `asr` 可选组、本地引擎进固化包，并修掉冻结入口缺 `multiprocessing.freeze_support()` 的进程风暴（此前每构造一次模型就把主脚本从头再跑一遍，45 秒内进程 1→7、观测到 138 个残留）。实测代价：`backend-dist` 153M→305M，dmg 189,948,623→245,200,985 字节（+52.7MiB / +29%）；产物内 `/api/studio/transcribe` HTTP 200——转写与翻译从此不再取决于用户机器上有没有装对东西。

### 质量片 S1–S6（v0.32，D-201…D-204）

alembic autogenerate 删表闸（两个 `remove_table` 漂移不可逆操作先亮牌）+ 其 PyInstaller hiddenimports 回归修复；工坊转写改走 `asr.transcribe_cues()` 单一权威出口并把繁体字符集从 63 字扩到 83 字（原集漏掉真实模型输出，纠偏从未触发）；无效索引声明清偿（`add_fk` 2→0、`add_index` 8→4、`remove_table` 恒 0）；产物级发布门禁 `release-check.sh`（源码门禁 → 重建固化包 → 产物门禁，任一非零即禁止打 tag）；仓库内 pytest 告警 8→6（余下 6 条均在依赖生成代码里）；文档真相与门禁卫生四项。

### 设置页保存回归（v0.32 S4.1，影响面最大的一条）

**自 v0.20 起设置页点「保存」提交的是空 `overrides`**——所有改动只活在内存里，页面却 toast「已保存」（`git blame` 指到拆分那一次）。改为草稿态 diff + 按类型强制转换，并补前端 7 项 + 仓库级 7 项守卫防复发。

### 本地模型落位（v0.32 S4 / S4c，D-203）

Whisper 与翻译模型搬进应用数据目录（`HERTZ_DATA_DIR/models/whisper`）+ 一键下载；`HF_HOME` 不再参与，隔离数据目录即等价空缓存。状态卡五态化，把「还没问到」和「依赖没装」分开显示（此前二者共用一个红色结论）；工坊不可用改按异常类型分派，502 带应用内出路而非裸 500。

### 空壳条目治理（v0.33）

起因是「下载一直 403」。实测根因不是 CDN，而是采集器兜底「不确定就算 video_raw」把 **2011 条 `media_url == source_url`**（把帖子页当媒体）的空壳放进了可操作队列，其中 1989 条连正文都没有；点下载就是抓被反爬拦截的页面，403 还会把整域冻进冷却、连带 2089 条真视频停摆。交付：`pipeline/quality.py` 作判据唯一作者 + 新增布尔 `is_invalid`（wave30）+ `counts()` 与列表共用 `operational_filters()` + 异常区「空壳」池 + `engine._pending` 不再白跑 + 常驻数据体检 `integrity`（六条不变量，只报不改）+ 存量回填脚本（干跑默认）。dev 库实测 discovered 4703→2666、failed 181→27、queued 5→0，rejected 371 / published 18 一条未动。

### 网络与门禁收口

「本地目标直连、外部目标跟随代理」这件事原先被写了 8 遍（4 处手写关掉环境代理、3 处各自发现系统代理、1 处新增权威），全部收进 `infrastructure/net.py`；配套仓库级守卫从「只禁旧形状」改成**正向棘轮**——删掉收口即红，且有成对变异证据。并代修并发工作流欠下的门禁红（2×F401 + 2×N812 + 一个因打桩位缺失而 AttributeError 的测试），零业务逻辑改动。

### Reddit 凭证状态可见（v0.33，D-190 四件套第三例）

未配 `client_id/secret` 时 `ensure_reddit_token()` 直接返回 None，v0.3.7 的签名直链兜底**从未启用**，而界面上没有任何地方说这件事——用户体感只是「下载偶尔 403」。补一条能力矩阵条目（`off` 带出路文案、`ok` 说明已配置）+ 显示名 + `GET /api/pipeline/reddit-auth/status`（`?probe=true` 才真取 token，避免设置页渲染就打 Reddit）。可选能力，不阻断预检：匿名通道本就能用。

评审抓出并一并修掉的三处：判据「id 与 secret 均非空」原先在采集器里还有第二份写法（不 `strip()`，空格尾巴会两边判定不一致）——现收成 `deps.reddit_credentials_configured()` 一个作者、采集器也消费它；`probe=true` 原先可能命中模块缓存返回一个过期 token 冒充「刚验过」——现强制重取；保存凭证后矩阵不刷新（新条目要等重启或手动重测才变绿）——现凭证改动触发重算。守卫也补了行为腿：只扫源码字面量的断言会被注释喂饱，现改成 monkeypatch 判据 helper 后断言端点跟着变。

### 未评分区三轴筛选（v0.34 A，`6172dde` + `fb735b2`）

用户要转情感垂类，第一件需要的不是新内容而是「从杂域里把情感浮出来」。实测分母：未评分活口 2659，情感类 747（28.1%，高质量档 252）。三条轴全部**服务端**筛（`limit 500 < 活口 2659`，客户端筛只能看见最新 500 条，一旦情感不在里面界面就会得出「没有情感内容」的假结论）：

- 主题轴名单作者 `category.THEME_SUBREDDITS`（情感块实测**恰好 17 个**子版，与简报名单双向零差异）；质量轴阈值作者 `quality.QUALITY_TIERS`（loose 100/0.80、standard 500/0.90、strict 1500/0.94）；正文轴用 `length(coalesce(selftext,''))`，两档互补且 `with + without == 分母`。
- **缺省值不当成低质量**：实测未评分活口里 **17.2% 的 `upvote_ratio` 是采集器缺省的 0**（不是「真的 0 赞」）。任何 `min_ratio > 0` 的档位都会把它们**静默排除**——「未知」和「不合格」是两个事实。处置是单列 `quality.QUALITY_UNFILLED` 一档（可选、可数），不是把数字混进低质量。
- `GET /api/pipeline/items/facets` 与列表共用同一份条件（`service_queries.axis_filters`），**`total` 与 `hit` 分开报**（把筛后当全量是本仓被坑过的形状）；未知 `theme`/`quality` 抛 `ValueError` 并列出可选值，映射 422——「名单没配」不能伪装成「今天没有情感内容」。
- 界面：`core/preReviewFilter.ts` 是「界面选择 → HTTP query」唯一构造点，默认三轴全「全部」（默认情感会让人以为数据变少了）；`usePipelineData.test.tsx` 钉住选了情感+标准档就真的发出 `theme=sentiment&quality=standard`。

### 情感文字供给链可判的那半（v0.34 C-code，`aa206c2`）

- 匿名 JSON 通道补 `raw_json=1` 并与 OAuth 通道共用 `_listing_params`（`raw_json=0` 时 Reddit 按自家渲染返回正文，`&#32;`/`&amp;` 直接进库）。守卫数的是字面量出现次数 == 1，两个通道各写一份就会一边补一边漏。
- `quality.reassess()` 成为**唯一能摘隔离标**的出口（`stamp` 的既有语义是只加不清）。三条保守规则：终态不动、`shell_reason` 仍成立不动、`error_class` 不是本模块的原因码就不清——隔离位上挂着别人的失败记录时，静默摘标等于替别人宣布「问题解决了」。
- **修掉一条长期误报**：体检第 3 条 `downloaded_without_file` 原先不排除 `is_invalid`，把 v0.33 刻意停进异常区的空壳天天报成「产物缺失」；它还写死 `limit(500)` 私有窗口，正是本文件 `SCAN_CAP` 注释记过的坑复发。改消费 `operational_filters()` + 接回 `SCAN_CAP`，dev 库体检 **2 红 → 1 红**。
- 新增体检第 7 条 `story_without_text`。如实记一条：**它在 dev 库是绿的**（`count=0`），也就是说它不是能抓住这次供给断裂的那条——真正在报这件事的是 `invalid_share 2196`。别把它当安全网夸。
- `scripts/backfill-selftext.py`：默认干跑、每请求 100 个 id、四类计数分明；**出网探针失败就退出且一个查询都不发**——「0 条候选」既可能是已回填完也可能是根本连不上，脚本拒绝替运维猜哪一种。代理一律走 `net.system_proxy` 单作者（旧写法按 URL 前缀只给匿名通道挂代理，结果是「配了凭证反而不走代理」）。

### 看板替换发布 tab（v0.34 B，`754ff2c` + `5469344` + `de89099`，D-213/D-214）

用户原话：每天要给自己设一个文字目标（像 to-do），而「队列和日历大概没什么实际作用，我要发的话直接就发了」。定档两条：全部手动发、两个视图都撤。

- **是替换不是新增**：实测流水线页原本就有 6 个内层 tab（唯一作者 `pipeline/shared.tsx` 的 `PIPELINE_TABS`）。在被抱怨「结构没用」的地方加第 7 个是反方向。发布 tab 的实质内容正是 `approved` / `published` 两张列表 = 看板的「待发布」「今日已发」，于是**搬过去**复用同一批卡片（`PublishCard`/`AuditCard`/`StageItemRow`），不产生第二套发布入口。tab 数 **6→6**，`board` 放第 2 位，默认页签改 `board`。
- 顶栏完成度用**真实已发数**（`已发 N / 捞入 M`），不是手勾 checkbox——手勾要新表新状态机，且「勾了」和「发出去了」是两件事，那数字会自我安慰。
- 数据形状：`daily_goal`（一天一行）+ `items.focus_date`/`focus_note`（wave31）。选日期不选 `is_today` 布尔：布尔要每天凌晨有人清零，那是第二个写入口；日期让「昨天捞的」自然掉出今日列，零后台作业。`focus_*` 有意不建索引（沿用 v0.32 S2「先量再决定」）。备注长在卡片上——用户说他后面要自己加工。
- **判据各归一个作者**：列的划分只在后端 `pipeline/board.py`（`counts` 是截断**前**的数，界面写「共 N 条」不能拿展示条数冒充）；「界面上的某一天 → HTTP query」只在 `core/boardWindow.ts`（半开区间 `[本地零点, 次日零点)`，含两端会把午夜那条数进两天）；ISO 归一化只在 `service_queries.utc_instant`（否则「SQL 筛了 A 区间、界面按 B 区间分列」）。
- **撤界面不撤字段**：`queue_phase`/`scheduled_at`、`auto_publish` 槽位、可编辑 `ScheduleField`（被发布器读成 biliup 原生 `--dtime` 定时上传）全部保留。已知后果写进 spec §4.4：撤掉「入队」按钮后，自动发布**在界面上再也喂不进数据**，要开无人值守得走 API/Telegram。
- 两处 spec 判据按证据作废（§4.4c）：前端 `queueView()` 不能删——运营看板 `DashboardPage` 是活读者，而它写的是 `queryFn: pipelineApi.queueView`（**不带括号**），我按 `queueView(` 搜所以漏了，是 `tsc` 抓到的；`GET /api/pipeline/calendar` 不删——它有在跑的行为测试且读的字段仍可写。顺带修一条既存坏链：`/queue` 深链一直指向 `?mode=queue`，而 reader 只认 `pipeline|monoline` ⇒ 书签进来是 Studio。
- **第 8 条体检 `focus_orphan` 前置纪律（D-214）**：spec 原文那条判据照抄会造出一条长期红的报警器——「上午捞进今日、下午拒掉/归档/发布」是日常操作，而这三条 transition 谁都不清 focus。所以先给「清」一个作者（`board_store.clear_focus` 接进那三处），再上判据；视图层另留兜底 `FOCUS_EXCLUDED_STATUSES`，报警器坏掉的那天界面也不假装今天还有活儿。
- 本仓**第一条 i18n 门禁**（`frontend/src/i18n/catalog.test.ts`）：中英叶子键集相等（当前 1404 = 1404）+ 退役键既不在目录也不被引用 + 看板要的键两边都在。实测既存两处漂移（`common.copyTitle` 只在中文、`common.custom` 只在英文）都是代码里真在用的键，切语言会露裸键名——**补齐而不是加例外**。负向那条带两条对照组（判据必须能抓到 `t('…')` 直用的键，否则「零命中」只是判据不可达），并如实写下盲区：拼出来的键与放在 `labelKey:` 映射表里的键它看不见。

### 设置 ·「我的规范与固定计划」（v0.34，D-215）

用户要的是一条自己的产线：他已有大概规范与固定计划，需要一个**自己能编辑、布局清楚**的地方放着。

- 设置页导航新增一节（第 3 位，紧跟「AI 服务」）：**大概规范**与**固定计划**两个长文本 + 一个保存按钮，落 `runtime.yaml`（无新表、无迁移）。字段 `creator_norms` / `standing_plan`。
- **不并进 `channel_persona`，也不注入任何 prompt**：那个字段会被 `ai/router.py` 拼进脚本与标题提示词，合成就变成「我改一句自己的备注，视频口播跟着变」——用户要的是册子，不是又一个生效配置。页面上第一行就写明这件事，并把「要调调性请去 AI 服务」指路出去。
- **不放看板**：看板上那个是**每天一条**的目标（存 `daily_goal`），这两段是**长期一份**。按天的东西塞进设置页，每天要多切一次屏。
- 这条链由 v0.32 那套仓库级护栏自动兜住（`tests/test_settings_wiring.py`：能编辑的键必须有草稿、草稿必须在后端白名单里、`save()` 不许退回空载荷）——那正是 v0.20 起设置页「只演出不落盘」十几版的解毒剂。本轮新增 3 条测试（两条接线 + 一条真 PATCH→GET 往返，内容带中文与换行）。

### 开发入口修复：`webui.sh` 端口清理（v0.34）

`./webui.sh` 起不来：脚本打印「Port 8787 in use — stopping...」却什么都没停下来，新后端随后 `bind` 失败（`[Errno 48] Address already in use`）、整个进程组连坐退出；而用户查 3000 是空的（方向对，端口错）。两个独立缺陷：

- **SIGTERM 杀不动卡死的 uvicorn**：它接住信号走优雅退出，而优雅退出要事件循环还能转。改成 TERM → 轮询 → SIGKILL → 复查，仍占着就打印 pid 并**退出脚本**（不再让后端无声崩掉拖着前端一起死）；父进程只在同命令族（uvicorn/vite/pnpm）时才连带强杀，**用户的 shell 绝不碰**。
- **`lsof -ti tcp:$PORT` 连客户端一起返回**：实测造一个监听者 + 一个已连接客户端，不加限制时返回 3 个 pid——也就是浏览器开着 dev 页面时脚本会去 kill 浏览器。加 `-sTCP:LISTEN` 后只返回监听者。这个危险在改之前就存在。
- 验证用真复现体（`signal(SIGTERM, SIG_IGN)` 的监听者，确认 `kill -TERM` 后仍 LISTEN）：新 `free_port` 强杀成功、`FREE_RC=0`、已连接的客户端进程存活；空端口直接返回 0。

### v0.34 的验证账（数字由命令产生，不心算）

- 源码门禁 `./scripts/verify.sh` 五段全绿多次；最后一次于设置节那块之后：**ruff 0、全量 pytest 587 passed、tsc 0、vitest 17 文件 77 tests、vite build OK**。基线从 v0.33 准备时的 521 涨到 587（A +25、C-code +16、B 后端与界面 +22、设置节 +3、dev.sh 与 i18n 门禁带来的增减另计）。
- 变异证据（每条新判据都验过「摘掉能力本身」会红）：窗口改成两端闭、`counts` 改用截断后长度、`focus_date` 参数收下不用、端点少传 `limit`、三处 `clear_focus` 调用任摘其一、第 8 条从 `CHECKS` 删除、回填脚本摘掉探针或把代理改回按前缀分支——各自把对应测试跑红。
- 迁移 `wave31_board_goal` 在一次性真库 `hertz_wave31_probe` 上跑完整往返（`upgrade heads` ⇒ `downgrade -1` ⇒ 再 `upgrade`）后 `dropdb`；heads 迁移前后**都是 2**（悬空分支 `wave21_glossary_remove` 按定档不动，有测试钉住）。
- 界面在浏览器里真用过（vite :3000 + 自建 :8899 后端 + dev 库）：看板是默认页签、五列真数据、目标保存后**换页回读仍在库里**、捞入今日 ⇒ 列 0→1 且「捞入 1」、备注失焦落库、移出回到 0、空态动线落在未评分且三轴为情感+有正文。探针数据已清干净（`daily_goal` 0 行、`focus_*` 非空 0 行，清空走 PATCH 而不是手改库）。**截图与观感未验**（browser-use 拿不到可见面，指针/视觉动作被拒），验的是结构、文本与真写库回读。
- 设置那一节：**没在他正在跑的实例上点保存**——`save()` 提交的是整份草稿差集，往里写示例文字有覆盖他现有配置的风险。浏览器侧只验到渲染（导航第 3 项、两个 textarea 的 rows/占位文案、未编辑时保存按钮 disabled），落盘与回读由 pytest 那条真 `PATCH /api/config` → `GET` 往返覆盖。他此刻的 `runtime.yaml` 里这两段仍是空串。



1. **141MB Whisper 模型的全量冷启动首下未实测**：本机代理 egress 多次整体中断，只拿到 30MB/141MB 进度与完整失败路径证据。判据已沉淀为 `scripts/sim-newmachine.sh --with-download`（断言模型落进应用目录且 `~/.cache/huggingface` 一个字节不长）。
2. **Reddit 签名直链兜底仍未闭合**：`pipeline_reddit_client_id/secret` 为空时 `ensure_reddit_token()` 直接返回 None，v0.3.7 的兜底从未启用。本版只做到「这件事可见」（能力矩阵 `reddit_auth` 条目 + `GET /api/pipeline/reddit-auth/status`，probe 需显式 `?probe=true`）；闭合需要用户去 `reddit.com/prefs/apps` 建 script 应用后填凭证。
3. **情感文字供给链只修了一半**：`items.selftext` 在 dev 库 5281 行里 0 行非空，隔离的 2196 条中 2013 条落在情感名单、1982 条来自文字为主子版，未隔离的同子版只剩 6 条。本版落的是**可判的那半**（C-code：`raw_json` 单作者、`quality.reassess()` 唯一清标出口、体检第 7 条、回填脚本）；**C-run（真回填那 1982 条）仍未执行**——它需要出网，而 2026-09-30 复测 `www.reddit.com` 直连与 `127.0.0.1:7897` 两条路都是 `000`。命令已就绪：`uv run python scripts/backfill-selftext.py`（先看干跑，再 `--apply`）。也就是说**装好这一版之后，情感「文字」垂类的可操作弹药仍然是 6 条而不是 1982 条**，别把 C-code 当成供给恢复本身。
4. **测试替身会永久遮蔽配置代理（本片修 I3 时发现，未修）**：`monkeypatch.setattr(settings, …)` 撤销时把旧值写成 `_EffectiveSettings` 的**实例属性**，从此遮蔽对 `runtime.yaml` 的 read-through——同一进程内后续测试看到的不再是真配置。本次在测试内局部规避并写明，真正的修法在 `backend/config.py` 的代理形状，留作 v0.34 独立切片。

5. **本条版本号对应的产物尚未生成、也未发布**：`[v0.34.0]` 这一段写的是「代码已在 main、源码门禁全绿」，**`scripts/release-check.sh`（产物级门禁）未跑，tag `v0.34.0` 未打，`origin/main` 落后 16 个提交**。三者都需要单独授权后才动；在那之前任何「v0.34.0 已交付」的说法只适用于源码树，不适用于任何可安装的产物。
6. **看板那三处「界面写点已撤」是决定而不是遗漏**：撤掉「入队」按钮与队列/日历视图后，`auto_publish_tick` 在界面上再也喂不进数据（它的筛选条件是 `queue_phase == 'ready'`）。代码、端点（`POST /items/{id}/queue`、`GET /publish/queue`、批量入队）与产能槽位一律保留，要开无人值守发布得走 API 或 Telegram 侧写相位。

## [v0.30.1] - 2026-09-23
### 补丁发布：三处「文档说交付了、产物里没有」的缺陷

- **修复脚本工坊转写端点从未可用**：`POST /api/studio/transcribe` 在函数内 import 了 `asr` 模块并不存在的 `whisper_importable`（真符号是 `whisper_available`），且该 import 在 try 之外——任何真实请求以裸 ImportError 崩成 500。因是函数级 import，ruff / tsc / 全部后端测试都看不见
- **修复新克隆冷启动即挂**：`scripts/dev.sh` 与重构计划书里的初始化指令仍用单数 `alembic upgrade head`，在多 head 现状下被 alembic 直接拒绝（`webui.sh` 是这两个的入口）；`DECISIONS` 里 D-184 的历史记述按原样保留
- **修复外部 PostgreSQL 逃生通道**：固化后端建库时手拼 DSN 丢掉口令，导致「设 `HERTZ_DATABASE_URL` 指向外部 PostgreSQL」这条被明确推荐的路径在迁移之前就因认证失败死掉；内嵌 PG（trust 认证）行为逐字节不变
- **修复随挂钟变红的发布闸门**：排期重排测试把「当天窗口排满 → 保持无排期」这条正确行为判成失败，本地约 20:00 之后必然红；改为守端点不变量，并由注入固定时钟的纯函数测试继续覆盖「能拿到未来槽位」一支
- 新增 10 项防复发护栏（351 → 361）：全仓函数级 import 幽灵符号 AST 扫描、迁移入口必须用复数 `heads`（文本层 + 行为层）、口令透传与 trust 双路径、测试不得在未注入时钟时断言具体槽位
- 版本五处对齐 0.30.1；`hertz.spec` 的 `faster_whisper` 排除与 `--extra asr` 话术清理**刻意留到 v0.31**（引擎入包一并做，本轮加入会立刻跑红）

## [v0.30.0] - 2026-09-23
### 创作者工坊战略整合发布（v0.23 → v0.30 一轮收口）

本轮零新功能，为「从内容工厂到创作者工坊」战略（D-191）的四项能力做整合发布。

- 脚本工坊 MVP（D-192）：语音草稿 → faster-whisper 本地转写 → 逐句打磨（拖拽排序 / 朗读时长预估 / TTS 试听 / 纯文本直录 / 草稿暂存）→ 入库，产出直连既有 TTS→字幕→合成下游，下游零改动；作为第六个 tab 接入流水线导航
- 智能路由阶梯降级 + 规则评分（D-193）：多信号启发式评分高置信免 LLM；预算 critical/exceeded 时评分强制本地启发式，exceeded 时自动批次跳过评分（人工仍可触发）——降级路径有日志可追
- 创作资产（D-194/D-195）：素材 sidecar `<name>.meta.json` 承载笔记与灵感片段（`{t0,t1,label}`，非法条目丢弃不报错）、素材组合预览；视觉风格预设表 `style_presets`（wave25），套用只写创意子集、不动栏目归属字段
- 半自动运营面板（D-196/D-197）：制作优先级 `items.priority`（wave26，默认 0 与存量行为等价）打通「批量队列拖拽排序 → 落库 → 取件按降序」全链路；发布日历栏目色彩标记；流水线壳 Enter 展开焦点卡
- 地基巩固收口（v0.23）：media.py 2141→648 行（producers/ 13 域文件）、usePipelineExecution 拆为 Data/Actions/Events 三 hooks、前端全局错误边界 + unhandledrejection、script_json 读写两侧收敛至 sk 契约
- 修复：固化后端首启在多 head 现状下抛 `Multiple head revisions are present`（仅全新数据库复现，dev 库已 stamp 双 head 故长期隐身）——启动器迁移目标 `head` → `heads`，未改动任何迁移文件，新库终点与开发库一致（D-198）
- 版本对齐：`backend/config.py` / `electron` / `frontend` / 根 `package.json` / `pyproject.toml` 五处同步 0.30.0（D-185 教训清偿：此前打包版本停在 0.21.0 而 CHANGELOG 已到 0.22）
- 已知限制（未在本轮解决）：macOS 未签名，dmg 需手动下载且无自动更新；CI 仅 mac arm64 单矩阵，win/linux 未真机验证

## [v0.22.0] - 2026-08-24
### 栏目化内容工厂（非破坏性）
- 翻译引擎可插拔：本地 Opus-MT en→zh（免费离线，ctranslate2 推理零新增重依赖，模型约 300MB 首用自动下载，支持 hf-mirror 镜像端点）与 API 三步法随时切换；本地失败自动回落 API
- 字幕缓存复用：重制作时脚本未变直接复用已翻字幕，不再重复消耗翻译 API（此前一次翻译实际为三步法 ×3 次调用）
- 制作前能力预检（D-190）：翻译开而本地引擎未就绪→明确报错阻断；配音开而 TTS 未配置→阻断；ASR/LLM 缺失→警告放行并记录 produce_warnings；依赖矩阵新增 local_mt/whisper_model/llm/telegram 四条目（DepsCard 琥珀态三色）
- 环境退化即知：deps 快照 diff → Telegram 告警（签名去重，启动首跑仅建基线）；sentencepiece 升主依赖（修复 uv run 无 extras 时本地翻译静默失效）
- service_publish 按域拆分两批：StatsMixin（统计回捞）/ PrepOpsMixin（预处理单条操作）/ ScheduleMixin（排期过审日历）/ PromotionMixin（策略转正引擎+影子模式+自动发布 tick）各自独立——PublishMixin 1039→347 行纯留发布执行域
- service_publish 按域拆分第一批：StatsMixin（统计回捞）/ PrepOpsMixin（预处理单条操作）/ ScheduleMixin（排期过审日历）独立文件，发布核心与队列策略留驻
- 翻译彻底去 API 化：LLM 三步法与字幕逐段 LLM 批量翻译移除，Opus-MT 为唯一引擎（失败回退原文）；术语表功能整体下架（本地引擎无注入点，表结构经 wave21 迁移删除）
- 降级可观测性：模型下载多端点重试+单次告警；ASR/本地 MT 失败带原因日志；旁白回退字幕在审核卡显式 ⚠️ 标注（不再静默冒充正常字幕）；设置页一键下载本地模型

- 多源采集路由：裸通道名兼容存量 Reddit 源；新增 `ai-story/<主题>`（LLM 直产文字故事种子，成本闸 per_tick=2）与 `rss/<名称>`（通用 RSS/Atom 文本源）两类零凭证采集器
- 栏目实体（channels 表）：源池 × 固定音色 × B 站分区 × 简介模板 × 标签 × 标题风格 × 人设提示词 × 片头配置 绑定单元；条目经 `items.channel_key` 自动归属
- 固定音色优先级链：栏目 > 注册表 tts 角色 > 内容自适应
- 动态标题卡片头：按主片参数编码前置 concat，三重降级，成片时长自动计入排期
- 包装注入：标题风格提示词 / 栏目标签置顶 / 简介模板渲染 / 分区覆盖
- 设置页栏目管理卡 + `/api/channels` CRUD

## [v0.21.0] - 2026-08-23
### P0 安装即用闭环
- PyInstaller 后端固化：单入口（建库 → 迁移 → uvicorn），onedir 产物随应用分发
- 内嵌 PostgreSQL：首启自动下载发行包、initdb/pg_ctl 托管、动态端口、退出随停；外部库可经环境变量接管
- Electron 打包态运行固化二进制；`HERTZ_USER_DATA` 隔离钩子
- CI：tag 触发 mac arm64 构建并发布 GitHub Releases
- ffmpeg 内置兜底（imageio 构建，含 libass）；冷启动归因打点

## [v0.20.0] - 2026-08-22

工程健康轮：SettingsPage 拆分 + 成本聚合性能防线。

### 变更

- **SettingsPage 拆分**（1332 行 → 265 行主壳 + 分区文件）：
  `sections/shared.tsx`（SectionProps 契约 + PathField）/ `GeneralSection`（健康看板/
  语言主题/路径）/ `AiSection`（功能映射/供应商/角色/单价·币种·预算/人设/术语表）/
  `PipelineSection`（采集·热点监控·源池·自动发布·策略·TG·字幕语言·Reddit·B 站状态·依赖）/
  `settingsCards`（PublishStatusCard/DepsCard 随迁）。form 草稿与 save 留主壳统一持有，
  外部 import 路径不变
- **ai_calls 聚合防线**：内存聚合行数硬上限 2 万行（取最近），summary 如实标注 truncated
- **PipelineView（1355 行）拆分列入下一轮**——本轮聚焦 SettingsPage 保证质量

## [v0.19.0] - 2026-08-22

数据飞轮一期补完（VidPal feedback loop 精华借鉴）+ Telegram 周报 + bot 测试网。

### 新增

- **频道洞察**（`pipeline/insights.py`）：近 30 天已发布表现 → Top5/Bottom5 对比
  喂给 LLM → 结构化洞察（受众偏好/有效钩子/应避开题材/建议）落 `channel_insights`
  表（历史保留）；**注入评分 rubric 与脚本 prompt**——评分向本账号受众校准；
  冷启动保护（<5 条拒绝生成）；Dashboard「频道洞察」卡 + 手动重新分析按钮
  （成本可控不做自动周期）
- **Telegram 周报**：每周一次产能/AI 成本/最高播放/队列存量摘要推送
  （7 天节流，bot 启用时默认开，可关）

### 变更

- **审核推送排序改最新优先**（seq desc）：修复历史积压条目占满每轮推送窗口、
  「饿死」新条目的真实缺陷（FIFO 待办语义在积压场景失效——审核员关心新内容）；
  已通知排除下沉 SQL NOT IN 子查询
- **测试**：telegram bot 5 项契约（回调解析/推送去重/轮询分发/chat 隔离）
  + 洞察生成与注入集成；全文件清理 fixture 模式推广

## [v0.18.0] - 2026-08-22

移动化 · 数据飞轮 · 信任建立——第三轮同赛道调研落地四件套。

### 新增

- **Telegram 审核 Bot**：待审条目推送封面卡片（multipart 直传）+ inline 键盘
  ✅通过 / ↩️打回预处理 / ❌拒绝；**手写 long-polling 客户端零公网暴露**
  （本地桌面安全模型契合）；只响应配置的 chat_id（最小信任面）；
  `tg_notifications` 表去重重启不重推；预算告警复用同通道
- **策略影子模式**：`pipeline_strategy_dry_run` 照常计算转正计划但不落库，
  QueueView 展示「影子计划」（标题/排期）——观察满意后关闭即无缝切真实执行
- **发布日历热力图**：日历格按当日已发布数着色（GitHub contribution 风格）+ 角标计数
- **频道人设记忆**：`channel_persona` 注入脚本与标题生成 prompt 尾部
  （翻译不掺调性保持忠实）；设置 → AI 人设 textarea

## [v0.17.0] - 2026-08-22

预算阶梯提醒（Helicone 精华借鉴，第二轮调研落地）+ service.py 架构拆分（D-168 清偿）。

### 新增

- **月度预算阶梯**：`cost_monthly_budget`（报表币种计，0=不启用）——自然月累计
  AI 花费达 50%/80%/95% 三档时成本页顶部横幅提示（warning/critical/exceeded，
  只警示不阻断）；设置 → AI 单价卡内配置

### 变更

- **service.py 拆分为四域 Mixin**（D-168 架构债清偿）：1805 行单文件 →
  196 行运行控制核心 + review(审核预处理)/publish(发布·队列·策略·排期)/
  archive(归档备用库)/queries(查询看板) 四域文件；
  外部 import 路径不变、295 测试安全网全绿验证零行为变化

## [v0.16.0] - 2026-08-22

热点监控通道（第二轮同赛道调研落地，TrendRadar 词法精华借鉴）。

### 新增

- **采集源第二形态「主动雷达」**：对指定 subreddit 以独立高频间隔拉取
  rising/hot 排序，三段词法预筛后才入库——普通词任一命中 / `+必须词` 全含 /
  `!排除词` 一票否决，另支持 Reddit 分数门槛。把评分额度花在源头更可能爆的
  内容上；命中条目仍走正常评分与审核流程（不绕过闸门）
- 设置 → 流水线「热点监控」子区：开关/订阅列表/排序/间隔/三组关键词/分数门槛

### 设计决策

- 词法预筛以 `filter_fn` 注入 `run_collect`（collect 步骤不知道 watch 语义——职责单一）
- 监控节流并入 collect tick 由 engine 属性判断，与 auto_collect_minutes 解耦；
  依赖自动采集 tick 存在（关闭自动采集时手动运行链也会触发）

## [v0.15.1] - 2026-08-22

失败→修复建议映射（蚁小二 CLI 精华借鉴，同赛道调研落地第四项）。

### 新增

- **异常区修复建议**：失败条目按 `error_class` 显示人话操作指引
  （限流→稍后重试 / LLM→查供应商余额 / ffmpeg→重装命令 / 源失效→建议拒绝…）；
  失败分类看板的重试按钮 hover 同样带出该类建议。未知分类静默不显示。

## [v0.15.0] - 2026-08-22

质量与 ROI 三件套（同赛道产品调研落地，见调研报告：VideoLingo / Helicone / MoneyPrinterTurbo 精华借鉴）。

### 新增

- **三步翻译法**（VideoLingo 精华）：旁白文本 直译 → 反思审校 → 意译定稿——
  任一步失败降级上一步结果不阻塞产线；开关 `pipeline_translate_three_pass`（默认开）。
  字幕批量保持单步 + 术语注入（20 条/批 ×3 成本不可接受）
- **翻译术语表**（结构化表 + UI）：`glossary_terms` 表 + `/api/glossary` CRUD +
  设置 → AI「翻译术语表」管理区（启停开关/搜索/AI 辅助提取候选）；
  术语自动注入全部翻译 prompt（上限 100 条，updated_at 优先）
- **条目成本 ROI**（Helicone 单位经济借鉴）：成本页新增「条目成本 ROI」表——
  每条视频的 AI 总成本 × 播放量 × 千次播放成本（publish_stats 联动）；
  孤儿关联不计入 ROI 视图但计入总花费
- **标题 N 选 1**（MoneyPrinterTurbo 精华）：title_and_tags 单次调用产出 3 个差异化
  候选标题落库 `bili_title_alternatives`；发布卡标题行 ‹› 循环切换选用（点击即保存）

## [v0.14.1] - 2026-08-22

成本页体验四项：执行历史溯源跳转 / hover 操作 / 看板+历史两块布局 / 报表默认人民币。

### 新增

- **执行历史溯源**（`task_id = "item:<uuid>"` 约定）：评分/脚本/标题包装/旁白翻译/字幕翻译五个环节的调用点全部携带条目关联——明细行解析出条目标题与产物目录绝对路径，hover 操作「查看产物」一键跳转 资源 页对应目录；条目已删除自动降级为无关联
- **hover 操作**：历史行悬浮显示「查看产物」+ 复制模型名
- **报表币种**：默认 CNY（汇率可配），设置 → AI → 模型单价卡内选择币种与汇率；概览附日均花费；头部显示币种徽章

### 变更

- **成本页两块式布局**：上「看板」（概览卡行 + 环节分布 | 日趋势 + 按模型分布 双列）、下「执行历史」（表头吸顶内滚 + 分页）
- 测试桩适配：Item 桩补 id 属性（溯源关联需要）

## [v0.14.0] - 2026-08-22

成本控制——独立顶级菜单，透视每一个产生实际费用的 AI 环节。

### 新增

- **「成本控制」页**（`/cost`）：区间切换（7/30/90 天）+ 概览卡行（花费/调用/输入·输出 tokens）+
  **按环节分布**（评分/旁白脚本/标题包装/翻译/编排/对话——调用数、tokens、金额、占比条、点击筛选）+
  每日趋势迷你图 + **执行历史明细表**（时间/环节/模型/tokens/耗时/金额/状态）+ 未配价模型警告 +
  单价管理入口（跳设置 → AI）
- **计价与聚合层 `backend/ai/costs.py`**：`estimate_cost` 纯函数（美元/百万 tokens × 用量）+
  `aggregate_costs` 内存聚合；`GET /api/ai/costs?days=&domain=&limit=&offset=` 端点
- **费用环节归因补齐**：`TaskRouter.chat_messages` 开放 `caller` 参数——翻译两处标
  `operation="translate"`、编排域三处标 `caller="orchestrator"`；未知 operation 原样透传作环节 key（新工序免改代码）
- **执行历史服务端筛选与分页**：点击环节条目按 `domain` 参数重查（数据完整不截断），
  明细 50 条/页翻页；本地日切逻辑收敛至 `infrastructure/timeutils.local_day_str`（此前四处内联同构）

### 设计决策

- **查询时按当前单价动态计算（D-176）**：ai_model_prices 为唯一真相源，改单价追溯重算历史报表；
  ai_calls 只存 token 事实不入库价格快照。未配价模型的桶金额显示 None（未知 ≠ 免费），
  概览给出 coverage（计费覆盖率）
- 口径说明内嵌页面底部：仅统计 LLM API 调用；ASR/TTS 为本地或免费通道不计费

## [v0.13.0] - 2026-08-22

发布策略引擎——B 站「逆向算法」精细化运营（账号健康度 → 动态配额 → 内容分层 → 槽位规划）。

### 新增

- **账号健康度模型**（`pipeline/strategy.py` 纯函数）：从已回捞的公开播放数据实时推导四相位——`warmup`（新号爬坡，累计 <30 条低频起步逐级加量）/ `normal` / `caution`（本周均播较上周降幅 >50% → 配额减半）/ `cooldown`（连续 2 个发布日中位播放 <10，疑似限流 → 自动停发）。数据不足不惩罚；判定附人话证据
- **动态配额**：日产能 = 相位系数 × 爬坡曲线（cooldown=0 / caution 减半 / warmup 按累计数爬坡封顶 / normal=base_daily），替代静态 `daily_limit`
- **内容分层选条目**：premier（AI 分 ≥8 优先占黄金槽）/ regular / filler（lowscore 压仓）——转正不再按入库序先来先得
- **槽位约束**：同分区最小间隔 6h（防堆量痕迹）+ 相邻条目分区去重；复用既有窗口/间隔/抖动引擎
- **QueueView「账号状态」卡**：相位徽章 + 今日配额 used/quota + 判定原因 + 近 7 日发布/播放迷你趋势
- **设置页「发布策略引擎」区**：总开关（默认关闭——关闭时行为与 v0.12 完全一致）+ 常态日配额

### 设计约束

- 零新表：账号状态是 items + publish_json.stats 的派生数据，tick 实时推导（单一真相源不变）
- 全自动但可解释：每个降速/停发决策都带证据文案

## [v0.11.10] - 2026-08-22

绕过评分直接下载（省 API 用量）+ 审核卡未评分降级。

### 新增

- **预处理「直接下载」**：discovered 阶段 header 新增批量直下按钮（`POST /pipeline/run?step=download&unscored=1`，异步队列），未评分行新增单条「直下」按钮（`POST /items/{id}/download?skip_score=1`）——API 余额不足时跳过评分环节，审核以人工判断为主
- **引擎宽松路径**：`run_batch`/`process_one` 支持 `input_statuses` 覆盖（默认仍按 `step.input_statuses`，评分先行语义不变）
- **审核卡「未评分」徽章**：无评分条目显式标注中性 Badge（AI 分/评分维度/低分标记本就条件渲染，排序 `?? -1` 兜底）——评分为辅助信号而非必经环节

### 测试

- `tests/test_download_skip_score.py`：4 个契约测试（默认拒绝/skip_score 放行/批量只拉 discovered/unscored 对其他步骤无效果）；修复 `test_chain_to_review_gate` 对同事务 created_at 排序的时序脆弱依赖

## [v0.11.9] - 2026-08-21

取消制作 + 六项体验修复。

### 新增

- **取消制作（wave11）**：制作中按钮切换为「取消」——协作式取消（模块级标志注册表 + ContextVar 活动条目 + 产线检查点 + ffmpeg 轮询终止）；取消后条目回滚 downloaded（保留原片，清半成品），不标失败；幂等端点 `POST /items/{id}/produce-cancel`
- **随机抽帧封面入口扩展**：审核卡新增（与换封面并排）；发布卡按钮由 hover 浮现改为常驻可见
- **审核卡标题显示发布标题**：`bili_title` 优先，原版英文标题降级为 meta 行 `[EN]` 小字——审核所见即发布所得

### 修复

- **发布目标误报 NOOP**：runtime allowlist 缺 `pipeline_reddit_cookies_browser` 导致设置保存整体 400、`pipeline_publish_target` 从未落盘
- **已下载默认生产方式改为直发**：produce_options 为空时默认 passthrough（部分显式设置保持翻译+字幕兜底，不被直发劫持）
- **发布卡操作区拆分**：「打回审核」独立按钮，发布 select 菜单移除打回项
- **审核页 header 分组重排**：批量｜筛选（搜索+低分池）｜排序（要素+方向+视频优先+随机）

## [v0.11.8] - 2026-08-20

批量操作分片——消除全选超限 422。

### 修复

- **批量请求按 200 分片**：后端 `BatchBody.ids`/`ArchiveBody.ids` 上限 200（AXIOM 8.1 防大查询），全选可产生 500 条 → FastAPI 422 validation error。前端 `chunkIds` 按 200 切片串行执行并聚合 ok/failed（batchAction + archive/unarchive/purge 全覆盖）

### 变更

- **ActivityPanel 三栏改两栏**：移除「实时事件」页签（SSE 同源事件已落盘系统日志），默认展示最近任务；清理 store/hook 中 logs/logSeq/appendLog 死代码与 5 个死 i18n key

## [v0.11.7] - 2026-08-14

情感垂直频道第二阶段——文字故事产线（text_only 帖 → 中文故事旁白 → 配音 → 图文合成）。

### 新增

- **text_only 采集与存储**：Reddit 文字帖（selftext ≥ 50 字）保留为 `item_type=text_only` + `selftext` 列（alembic `wave24_story_selftext`）；短正文丢弃
- **下载跳过**：text_only 无媒体，download 步骤直接分配 output_dir 并跳过（不消耗网络）
- **故事旁白产线**：`produce_story_item`——LLM 中文故事脚本（钩子开场 → 情绪曲线 → 收束，`story=True` 专用 prompt）→ edge-tts 中文配音（`zh-CN-XiaoxiaoNeural`）→ 深紫渐变背景 + 标题卡渲染 → 按字符比例切句 → 字幕烧录合成 1280×720
- **合规适配**：敏感词 Tier1 拆分 `TIER1_SAFETY`（阻断）/`TIER1_MARKETING`（广告极限词）；故事旁白走 `safety_only=True`——中文口语高频词（最/第一）降级告警而非阻断，安全红线仍强制
- **故事源入池**：`AmItheAsshole / TrueOffMyChest / offmychest / relationship_advice / relationships / JustNoFamily / BestofRedditorUpdates` 加入采集池（runtime.yaml）
- **Reddit Cookie 导出增强**：设置页可选浏览器（Chrome/Safari/Edge/Firefox/自动）导出；导出后自动检测会话 cookie（`session_cookie`，杜绝「只有匿名 edgebucket 的假成功」）并立即验证通道（hot.json 200/403），状态卡显示「已登录/未登录」徽章

### 修复

- **produce_one 对 text_only 豁免 raw_path 校验**（无原始媒体条目此前无法进入制作）
- **`_render_story_bg` `out.save` → `img.save`**（Path 无 save 方法）
- **`_compose_story_video` 补 `async` 声明**（SyntaxError）
- **ASYNCIO 清理**：compose 产物校验改 `asyncio.to_thread`（ruff ASYNC240）

## [v0.11.6] - 2026-08-13

情感垂直频道改造（搬运阶段）——源池化 + 情感适配 + 验证门禁修复。

### 新增

- **采集源池勾选 UI**：设置→流水线 升级为分组勾选（情感池/情感故事池/旧源池 + 自定义源输入），`pipeline_sources` 仍为唯一真相源
- **情感评分适配**：`DIM_WEIGHTS.emotion` 0.9 → 1.3；score prompt 引导按「共情/治愈/冲突反转/真人真事」打分，低俗/引战降分
- **情感标题句式**：title prompt 支持共情钩子（冲突前置/反差/悬念），禁低俗擦边与性别对立标题
- **情感版块分区映射**：情感向 subreddit 显式映射 tid 21（日常），从搞笑 138 迁出（单一键）
- **版本单一真相源**：`backend.config.APP_VERSION`（0.11.6），main.py 引用；pyproject/package.json 对齐（此前三处 0.1.0 漂移）

## [v0.11.5] - 2026-08-13

发布流程按用户需求重构（立即发布/简介/转载/排期/封面）。

### 新增

- **立即发布**：`publish` 支持 `now=1` → 清除 `scheduled_at` 按当前时间上传（此前带排期会延迟）
- **随机抽帧封面**：`POST /items/{id}/cover-random` + 发布卡「随机封面」按钮（5%-95% 随机位置，updated_at 触发缩略图刷新）
- **排期高峰快捷点**：ScheduleField 升级 datetime-local + 「推荐」回填完整时刻 + 当天 10:00/12:00/18:00/20:00 即点即选
- **排期当天优先**：`next_slot` lookahead 1 天（只排当天），窗口按本地时区解释（修复排到凌晨/几天后的偏差）；B 站 dtime 下限修正为 5 分钟（原 4h 过严）

### 修复

- **简介不换中文**：`bili_desc` 改为原帖标题（用户明确需求），LLM/启发式兜底同步；手动值仍优先
- **转载变自制**：publish 传 `selfmade=1` 会把 `bili_copyright` 持久化为 1——重置受影响条目为转载，发布链路保持默认转载（--source 挂来源）
- **排期积压**：清理 285 条旧批量分配的远期排期（曾被排到 8/25）；`next_schedule_slot` 只统计未发布条目

## [v0.11.4] - 2026-08-13

字幕句首逗号根因修复（用户投诉「每句翻译字幕最前方有个标点」）。

### 修复

- **ASS Events Format 缺 Name 字段**：`srt_to_ass` 的 Format 行 9 字段但 Dialogue 行 10 值，
  ffmpeg 9.0.1 会把多余字段按逗号拼进文本 → 每句渲染出前导「，」——补上 Name 字段（经
  黑底渲染 + OCR 像素级验证：`，过来听指令` → `过来听我说`）
- **移除 `{\fad(...)}` 标签**：稳定优先（用户确认），字幕硬切
- **phash 改用 raw 源片计算**：成片 phash 被字幕带/缩放主导（不同视频仅差 4 位 → 误判
  「近源成片已发布」）——raw 才反映真实内容；全库 134 条存量 phash 重算
- 回归测试补 Format 断言；验证链（渲染 + Vision OCR）修复后重产 final.mp4 确认干净

## [v0.11.3] - 2026-08-13

处理中感知（长任务反馈）。

### 新增

- `busy` 状态（itemId → {action, title}）驱动按钮 loading + 防重复提交
- 全局反馈并入底部「运行状态」折叠条（ActivityPanel）：`正在处理 N 项 · 制作中《标题》`
- 后端 `process_one` 开始即发 SSE `job_step` + 日志

## [v0.11.2] - 2026-08-13

字幕/翻译标点清洗强化（LLM 前导标点）。

### 修复

- `_LOCALIZE_LEAD_PUNCT` 扩展（含 `…—`）；非中文翻译 `_clean_nonzh_translation_text`
- `_split_en_sentences` 句首剥离 + 8 词硬折行；`_write_srt_cues` 非中文句首标点剥除、纯标点丢弃
- 字体默认切换霞鹜文楷（OFL 免费商用）

## [v0.10.1] - 2026-08-13

批量运行异步队列化（修复"加入队列后立即完成"）。

### 修复

- **批量制作/采集同步阻塞**：`run_batch`/`run_chain` 曾 `await self._task`——HTTP 请求
  挂住直到全部条目处理完，前端"加入队列"后瞬间全部完成、看不到排队与进度——
  现 create_task 后台执行、请求立即返回 `{status: queued}`；进度经 SSE
  （job_step / item / job_done）实时推送，任务状态经 /pipeline/jobs 轮询
- **job summary delta 从未落库**：`run_batch` 在 finally 提交后算 delta 并更新
  `job.summary` 但缺第二次 commit——同步模式下前端拿响应体掩盖了缺口，
  异步化后 jobs 列表/详情读库即暴露；补最终 summary 持久化
- **SSE item/job_done 刷新列表**：后台任务每完成一条立即 invalidate
  pipeline-queue/counts（此前仅写日志，列表要等轮询周期才更新）

### 其他

- 前端入队即时反馈 toast（`jobQueued`，zh/en）；测试隔离 fixture（后台任务
  跨测试泄漏防护）与等待模式改造（`_wait_jobs_done` 等 running=false——job
  落库 COMPLETED 后任务仍有收尾步骤）

## [v0.10.0] - 2026-08-13

字幕/翻译数据源语义修正：基于视频原声（用户明确「视频中的人说的话」），旁白文案仅作回退。

### 修复

- **字幕/翻译基于简介派生文案（语义错误）**：此前字幕与翻译的文本源是 AI 按标题/简介生成的旁白文案，仅「翻译且不配音」组合走原声 ASR——现统一为视频原声为第一数据源：
  - 字幕生产方式 = 原声转写（保留原声语言与时间戳，不再去英文标点）
  - 翻译生产方式 = 原声转写 → 逐段翻译成目标语言（保留原声时间戳）
  - 配音 + 字幕组合同样优先原声字幕（此前被 `not want_voice` 排除）
  - 原声缺失（图片帖/静音）/ ASR 通道不可用/失败 → 回退旁白文案字幕（原行为保留）
- **中文原声视频绕翻译**：转写已含中文且目标为中文时跳过 LLM 翻译（原文即目标语言）
- **SRT 标点清洗误伤英文**：`_write_srt_cues` 无条件去标点曾把 `Hello, world!` 洗成 `Helloworld`——清洗仅对中文本体生效

### 其他

- 新增测试 3 例：translate=False 保留原声原文、中文原声跳过翻译、配音模式字幕仍走 ASR

## [v0.9.0] - 2026-08-13

CandleBone 对齐第三轮：成片混流 / 字幕烧录三级降级 / B 站定时门槛（详见 docs/DECISIONS.md）。

### 对齐

- **成片混流**（原项目 edit.py `_audio_mix_filters`）：`compose_video` 重写——侧链压缩改时间窗口音量曲线 `volume='if(between(t\,narr_start\,narr_end)\,0.22\,1.0)':eval=frame`（窗口 = 旁白实际时长，对齐 duck_floor=0.22）；旁白轨 volume=1.05 + apad/atrim 定长防 amix 塌缩；`amix duration=longest:dropout_transition=0:normalize=0`；统一 aformat(44100/fltp/stereo) + 原声缺失 anullsrc 静音轨；BGM 降音 0.08；合成后音频 < 视频 85% 带 BGM 自动重混一次（audio_guard）
- **字幕烧录三级降级**（原项目 `_subtitle_font`/`_render_cue_png`）：libass 可用 → ASS；缺失 → 逐 cue PNG overlay（PingFang/CJK 字体候选、白字 + 8 向黑描边、最多 4 行、底部留白、fade alpha in/out）；再失败 → 无字幕。烧录方式落 `script["compose_quality"]`，审计卡片提示
- **B 站定时门槛**（原项目 scheduler_utils.py `ensure_bilibili_dtime`）：距 now 不足 `pipeline_bili_dtime_min_hours`(默认 4h) + 5 分钟自动顺延，返回 `dtime_bumped_to` 并回写落库
- **pick_voice tags 修复**：旁白配音候选忽视 bili_tags（恒 None）——改为真实逗号分隔列表参与匹配

### 新增

- 测试 `tests/test_media_mix.py`（8 例：duck 窗口 / apad / normalize=0、音频守卫重混、muted -an、anullsrc、ass/overlay 分支、pick_voice tags、dtime 顺延与已满足）
- 依赖 Pillow（PNG overlay 渲染）

### 其他

- 存量工作树随本轮提交：routers 批量/重试 Body 重复定义清理、health/download/tests ruff 存量问题（F811/B007/ASYNC240/E742/F841/E501；per-file-ignores 仅限 prompt 与 XML fixture 文件）

## [v0.8.8] - 2026-08-12

AXIOM 查漏补缺（四十五：双维度审计遗留物；详见 docs/DECISIONS.md D-163）。

### 修复

- **活动面板分页错乱**：加载更多后轮询以当前页替换累计列表（§35 前端状态与渲染时序）——累计列表按 id 去重合并
- **系统日志重复追加**：until 游标进 queryKey 导致轮询反复追加历史行——加载更多改一次性请求，轮询只刷新初始页
- **i18next 不支持 ICU select**：collectRound 的 `{{err, select, ...}}` 渲染成残缺文本——拆 collectRoundOk/Err 条件渲染
- **job_detail 死接口**（§2.3 接口存在理由）：列表曾全量传 summary 但详情端点无人调用——列表轻量化（sources_ok/err 计数），展开懒加载 /jobs/{id}
- **pipelineApi.jobs 旧函数**（四十六 遗留物治理）：类型与后端新结构不一致——删除
- **日志 API 密钥脱敏**（§8.2）：message 读取时一次 scrub（token/cookie/secret=***）
- **日志全文件重复扫描**（§7.2）：mtime 缓存，文件不变跳过重读（0.07s → 0.000s）
- **日志游标校验**（§8.1）：since/until 非法格式 422；q 截断 120 字符
- **相对时间可读性**：刚发生显示"刚刚"而非孤立符号

## [v0.2.1] - 2026-08-08

原项目功能选择性同步（详见 docs/DECISIONS.md D-128）。

### 新增

- **画布多板**：板签栏（新建 / 切换 / 双击重命名 / 删除），每板独立卡片、图层与笔迹
- **图层面板**：新建 / 重命名 / 显隐 / 排序，新卡片落在激活层
- **图片卡片**：输入态或背景粘贴剪贴板图片即生成图片卡（dataURL 持久化）
- **画布导入导出**：⌘E 导出 `.revel.json`，拖入 / 文件选择导入（与 Revel 原项目格式互通）
- **画布平移**：Space + 拖拽有界平移（±260px，与卡片拖拽互斥）
- **失败分类看板**：failed 按 blocked/rate_limit/timeout/llm/tts/ffmpeg/等 10 类聚合，同类一键批量重试
- **phash 去重**：成片平均哈希指纹，发布闸门拦截同源重复投稿；存量条目批量回填脚本
- **评分成本闸门**：单次运行 / 单日 LLM 评分硬限额，超限跳过（条目保持待评分，不花 API）
- **本地排期引擎**：每日发布窗口 + 最小间隔 + 抖动，发布卡「推荐」按钮一键填充槽位
- **自动过审**：可选开启（默认关闭），超时未审条目自动 approve
- **数据源健康度**：dead / degraded / healthy 三态 + 采集失败冷却 / 熔断 + 供给告警（漏斗空 / 偏紧 / 源失联）
- **多平台导出包**：publish target 新增 `export`——成片 + 字幕 + 封面 + README 发布包，人工 / 半自动上传
- **采集韧性**：失败冷却 30 分钟、连续失败熔断 2 小时、成功清零；Reddit 排序随机轮换反 429

### 技术基础

- 迁移 wave15（error_class）/ wave16（source_state 连续失败/最后错误）
- 工序库重构（上版）：内置工序模型去锁定跟随全局、method 结构化、DEFAULT_AGENTS 并入 PHASES 单一真相源

## [v0.1.0] - 2026-08-06

首个可运行版本：AI 驱动的内容创作与自动化桌面平台。

### 新增

- **画布 Canvas**：灵感黑板，卡片 / 连线 / 语义低语提醒
- **编排 Studio**：多阶段 AI 工作流（内容研究 → 脚本 → 成片），阶段状态与产物实时可视化
  - 工序库：可编排的阶段模板（角色 / 模型 / 提示词 / 输出）
  - 策略 Brief：创作策略文档（Markdown 编辑 + 渲染预览）
  - 角色库与团队：AI 角色 → 模型分配（v4.1 简化：角色仅保留设定描述）
  - Buff / Debuff：正向与反向提示词注入（扩写 11 个内置 Buff + 5 个内置 Debuff）
- **流水线 Pipeline**：内容采集 → 评分 → 脚本 → 素材合成 → 发布（noop / Bilibili），调度器与重试
- **素材库**：
  - 下载管理（B 站 / YouTube，SSE 实时进度，断点续传）
  - 来源标签系统（下载自动打标签，按标签筛选）
  - 产物浏览（Studio / Pipeline 快捷入口，阶段产物融合展示）
  - 项目文档空间（素材根目录下 Markdown 文档的新建 / 编辑 / 删除）
- **AI 底座 v2.0**：
  - Provider 注册表（OpenAI 兼容协议，内置 DeepSeek / 硅基流动 / ComfyUI / Edge-TTS 模板）
  - 角色 → 模型路由（main / fast / embedding / image / tts），运行时可切换
  - 提示词模板库（编排 / 评分 / 图像 / 语音，支持自定义与回退）
  - 调用用量追踪（Trace 面板，流式响应计费）
  - API 密钥经 macOS 钥匙串加密存储
- **设置中心**：通用 / AI 服务 / 提示词 / 用量 / 流水线 分区管理
- 编排页语义分组导航（配置 / 角色 / 增益，行内激活贴纸）、素材根目录可配置、双语言（中 / 英）

### 技术基础

- FastAPI + SQLAlchemy（异步）+ PostgreSQL + Alembic 迁移（wave1 ~ wave10）
- React + Vite + TanStack Query + Tailwind CSS；Electron 桌面壳
- 路径安全（containment 校验）、密钥掩码、SSRF 防护等安全基线（见 axiom.md）

### 已知限制

- 桌面密钥存储目前仅支持 macOS 钥匙串（Windows / Linux 待支持）
- 发布目标仅 noop 与 Bilibili（其余待接入）

[Unreleased]: #
[v0.1.0]: https://github.com/emVisible/Hertz/releases/tag/v0.1.0
