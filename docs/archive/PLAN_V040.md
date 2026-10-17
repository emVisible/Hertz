# Hertz v0.40 大版本计划——从「能力齐备」到「敢给别人用」

> **已归档** · 2026-10-17 · 被取代者：v0.32 那批已随 v0.34.0 交付（见 `CHANGELOG.md` v0.34.0）
> 保留原因：它量化了当时的债务水位，是「为什么要拆 v0.32 / v0.40」的依据。
> ⚠️ 已知：本文「状态：提案（待用户定档）」与 §六的定档记录自相矛盾，以 §六为准。
> 不要在本文件里继续更新。

> 状态：提案（待用户定档）· 2026-09-23
> 前置：v0.30 战略弧（创作者工坊）四项能力已落地；v0.31「本地引擎入包」B1/B3 已落、B4–B6 在飞
> 本文回答三件事：现在真正欠的是什么、v0.32 收哪些、v0.40 立什么

---

## 一、为什么大版本不是「再加功能」

v0.23→v0.30 那轮把四项能力做完了,但本轮发布过程中的**取证**暴露出一个结构性事实：
**文档、代码、产物三者长期不一致,而且没有任何自动检查发现得了。**

已实测的四个例子（都不是推测）：

1. 脚本工坊的转写端点因函数级幽灵符号 `whisper_importable` 直接崩 500——ruff/tsc/351 项测试全绿了三个版本
2. `hertz.spec` 把 `faster_whisper` 放在 excludes、`ctranslate2` 根本没声明——「零 API 转写与翻译」在**开发态和打包版同时不可用**,而 VISION §七 把它写成目标、ROADMAP 把相关能力写成已交付
3. `scripts/dev.sh` 与重构计划书里的 `alembic upgrade head`——新克隆的人冷启动即挂,只在真的新机器/新克隆上复现
4. `test_reschedule_expired` 在本地 20:00 之后必然变红——发布闸门每晚自己坏一次

共同形状：**故障只在「产物级 / 新环境级 / 时刻级」暴露,而我们的门禁只在「源码级」验证**。
v0.40 的正当主题不是新能力,而是把验证面推到产物上——顺手把已经量化的债清掉。

---

## 二、量化底座（本文件所有数字都来自 2026-09-23 实测）

| 面 | 实测值 | 来源 |
|---|---|---|
| dmg 体积 | 189,948,623 B（不含引擎）→ 245,200,985 B（含引擎栈）= **+52.7MiB / +29%** | 本地 `--publish never` |
| 固化后端 | 153M → 305M | `du -sh electron/backend-dist` |
| 打包版转写 | HTTP 200；6.69s 音频热态 ~1s；health 就绪 ~5s | 隔离空库 + 固化二进制 |
| 工坊中文质量 | 输出**繁体**且含错字（`今天天氣不錯…公園離走走`） | 同上 |
| alembic 漂移 | 约 45 项,含 **2 个 `remove_table`**（messages/conversations）+ **2 个模型有、库里没有的索引** | `uv run alembic check` |
| 迁移图 | 40 个 revision / 2 head / 2 分支点；文件名编号与拓扑序错位约 25 处 | 解析 `alembic/versions/*.py` |
| 结构债热点 | 前端 `AssetsPage.tsx` 1277 / `PlansPage.tsx` 1212 / `AssetViews.tsx` 867；后端最大 698（`orchestration/engine.py`，健康） | `wc -l` |
| 测试面 | 后端 366 passed / 前端 9 files 35 passed；**迁移路径零覆盖**（conftest 用 `create_all` 建库） | `verify.sh` |
| 承诺未交付 | 风格锚点、重读标记、素材组合预览拖拽、笔记↔素材多对多、批量套用栏目参数（5 项,VISION §三 写过） | 代码逐个核 |

---

## 三、v0.32——质量与耐久（整体优化主体，无新能力）

原则：每条都必须让「下一次同类事故被机器拦住」,而不只是把这一处修好。

| ID | 交付 | 为什么是它 | 验收（可自动） |
|---|---|---|---|
| **S1** ✅ | alembic autogenerate 护栏：`env.py` 的 `process_revision_directives` 滤掉 `DropTableOp`（除非显式开关）+ `include_object` 黑名单 legacy 表 | 2 个 remove_table 是唯一的**不可逆**风险 | 纯函数测试：喂造出来的 ops，断言 drop 被滤并写日志 |
| **S2** ✅ | 漂移清偿（**按实测反转**）：`items.archived`/`error_class` 的 `index=True` 是无效声明（5281 行全 False / 5181 空串），改模型而非造索引；`plans.brief_group_id` 补真缺失的外键（wave27，先清孤儿再加约束） | 原判断「库里缺索引=性能债」被数据推翻；FK 缺失则会让悬挂引用不被置空 | `add_fk` 2→0、`add_index` 8→4、`remove_table` 保持 0；dev 库与**空库**均 `upgrade heads` 退出码 0 且 FK/版本经 SQL 核对 |
| **S3** ✅ | 工坊中文输出纠偏：抽出 `asr.transcribe_cues()` 作为**全仓唯一 whisper 出口**（词级时间戳 + 断句 + 繁简纠偏），`studio.py` 与字幕产线共用；并补 `_TRADITIONAL_CHARS` 63→83 字 | 实测两层根因：①工坊自己调 `model.transcribe` 绕开纠偏；②**检测集漏掉真实模型输出**（氣/錯/園/錄/順/實/語/嬰 全不在集内）→ 连字幕产线的纠偏也永不触发 | 注入「首繁二简」假模型断言响应无繁体且发生第二次带 prompt 重转；AST 守卫全仓不得有第二处直调；实测原句可识别 + 简体字形不得入集（防误触发） |
| **S4** ✅ | 模型目录单一真相源（D-203）：`data_dir/models/whisper`，`asr`/`deps`/设置页共用一个 `paths.py`；下载底座 `hf.py`（端点序 + 流式 `.part` 原子改名 + 串行锁）；一键下载 + pending 琥珀态；档位缓存键 `档位@目录`；端点设置合并为 `pipeline_hf_endpoint`；预检新增「引擎在但模型没下」第三态 | 现在耦合 `$HOME/.cache`，违背 `HERTZ_USER_DATA` 隔离的存在理由 | `tests/test_local_models.py` 28 项（含下载锁的删除式反向对照：拆锁→并发测试红在 `.part` 被 unlink）；产物级实测：干净目录判 `model_ready:false`、`deps` pending 带档位、工坊 **502 带出路**（S4 换文案后曾退成裸 500，已按类型修好）。**遗留：141MB 全量首下仍未实测成功**（本机代理 egress 两次中断，只拿到 30MB 进度与完整失败路径证据）→ 待 `sim-newmachine.sh --with-download` |
| **S4.1** ✅ | 设置页保存回归（D-204）：`save()` 自 v0.20 起提交 `overrides: {}`，抽 `core/settingsOverrides.ts`（草稿与配置的差集 + 按 cfg 真值还原类型 + 只写字段「空=不动」） | 「点了说成功」的入口没有一条改→存→重读的机器断言 | `settingsOverrides.test.ts` 7 项 + `tests/test_settings_wiring.py` 7 项（可编辑键 ⊆ 草稿 ⊆ 后端白名单；空载荷字面量禁止；对 HEAD 旧代码跑守卫当场红）+ 产物级 `PATCH→runtime.yaml→GET` 回读 |
| **S5** ✅ | 产物级门禁：`scripts/sim-newmachine.sh`（泛化，去绝对路径、端口与隔离库名按版本派生）+ `scripts/release-check.sh`（源码门禁 → 重建固化包 → 产物门禁；任一阶段非零退出即「禁止打 tag」） | 四个事故全是产物级,而门禁只在源码级 | 实测 `RELEASE_CHECK: PASS`（退出码 0）：空库首启 ~9s、新库 head == 仓库 heads、schema 三项 SQL 核对、版本回读、pipeline API 200、转写非繁体、无进程风暴；上线即抓出 S6 的 ini 中文注释崩点与「包内迁移落后仓库」 |
| **S6** ✅ | 文档真相与卫生：ROADMAP v0.15 行标注「三步法/术语表已于 D-189 移除」；`alembic.ini` 补 `path_separator = os`；删 tracked 的 0 字节 `useStudioExecution.py.tmp`；删测试里空转的 `_set_engine()` 助手 | 文档不得宣称代码没做的事；门禁日志噪音早晚被误读 | `alembic check` 弃用告警 0 次、pytest 告警 8→6（S4c 后又收一条：测试里的 `chat_stream` 是协程而非异步生成器，每次跑都吐 never-awaited；余 6 条 `<unknown>` SyntaxWarning 来自依赖导入期 compile 出的生成代码——已把 backend/ + alembic/ + hertz.spec 全量 `compile()` 扫过，仓库内无非法转义）；14 项翻译/闸测试通过；门禁 382 全绿 |
| **S7** | 前端巨石拆解第一批：`AssetsPage.tsx` 1277 → 主壳 + 分区（照 D-182/D-183 的「state 留壳、JSX 下放」既有模式），`PlansPage.tsx` 1212 同批或紧随 | 前端已成唯一的巨石区（后端最大 698 行健康） | tsc + vitest 不降；主壳 <400 行 |

非目标（v0.32 明确不做）：新表新能力、mac 签名（要花钱买证书,不是代码问题）、win/linux 矩阵、双 head 的完整合并。

---

## 四、v0.40——弧的主题建议

三个候选,证据都指向第一个：

**A. 「可信交付」（推荐）**：v0.40 = 让别人也能装能用。mac Developer ID 签名 + 自动更新闭环 + win/linux 真机矩阵 + 备份/恢复可验证 + 首次运行体验（离线兜底、模型进度、失败可见）。
理由：`已知缺口` 表里唯一的「高」优先级项是 API 鉴权,而桌面单机场景它可接受；真正卡住「给别人用」的是签名与矩阵。且 v0.32 已把产物级门禁建好,v0.40 正好复用它。
成功指标：新机器从 dmg 到「转出第一条字」全自动且无终端操作；三端各有真机验证记录；备份文件可 restore 并校验。

**B. 「资产与叙事」**：把 5 项承诺未交付的功能做完（风格锚点、重读标记、组合预览拖拽、笔记↔素材多对多、批量套用栏目参数）。价值真实,但在质量债未清前再加能力,就是把「文档说有、代码没有」的制造速度提到清偿速度之上。

**C. 「智能供给分层」**：Tier B 本地小模型（Ollama）接进来,VISION §三 能力三的第二档。依赖外部生态、收益最不确定,建议排在 A 之后。

---

## 五、执行节奏与度量

```
v0.31（在飞）  B1 引擎入包✅ → B3 入固化包✅ → B4/B5 并入 v0.32 S4✅ → B6 端到端 → B7 文档自洽 → 发布
v0.32          S1 护栏✅ → S3 繁体✅ → S2 漂移清偿✅ → S6 文档/卫生✅ → S5 产物门禁✅
               → S4 模型搬家 + 一键下载✅ → S4.1 设置保存回归✅
               （S7 前端拆壳已按定档移出 v0.32）
v0.40          可信交付（签名 / 矩阵 / 自动更新 / 备份可验证 / 首启体验）
```

每轮收口口径不变：`verify.sh` 取真实退出码全绿 + 产物级实测 + 文档三处 + 一条 D 编号。
度量看三件事：**闸门是否可在无人值守下可信**、**产物与文档是否一致**、**新机器到达「第一条成片」需要的终端操作数（当前 ≥1，目标 0）**。

---

## 五·五、v0.32 执行期新增的产物级教训（源码级全绿也拦不住）

| 陷阱 | 只有什么才能暴露 | 已钉的守卫 |
|---|---|---|
| 冻结体缺 `multiprocessing.freeze_support()` → 每次构造 whisper 模型就自我重跑主脚本（45s 内 1→7 进程，观测到 138 残留） | 非冻结开发态永远正常；只有跑冻结二进制才现形 | `test_frozen_entrypoint_declares_freeze_support`（AST 断言存在且先于建库/迁移）+ S5 产物门禁数进程 |
| `alembic/env.py` 以**数据文件**进包，它的 import 对 PyInstaller 静态分析不可见 → S1 新引 `migration_guard` 后固化后端**首启迁移即 ImportError** | 380 项源码级测试全绿、`verify.sh` 也绿；只有重建并启动固化二进制才发现 | `test_alembic_env_imports_are_reachable_or_declared`（从冻结入口 BFS 可达性 + spec 登记二选一）+ 直钉 `migration_guard` 必须登记；已做删除行反向对照：删则 2 失败、还原则 7 通过 |
| macOS APFS 大小写不敏感 → 用 `Path.exists()` 判「是不是子模块」会把 `backend/models/Base.py` 判成存在（真实文件 `base.py`），守卫当场虚报 | 只在 macOS 上跑才看得到；Linux CI 上表现不同 | 模块判定一律走 `importlib.util.find_spec`，不再靠路径拼接猜 |
| **UI 承诺型回归**：v0.20 拆 `SettingsPage` 时 `save()` 的字段表被删成 `overrides: {}` ——从 v0.20（08-23）到本轮 S4 之前，设置页只演出不落盘，点保存照样 toast「已保存」，runtime.yaml 一个字节没写 | 只有「改一个设置 → 重启 → 看它有没有回来」这种端到端动作才现形；tsc/vitest/pytest 与看一眼页面全都无感（空载荷的正确形态就是空） | `tests/test_settings_wiring.py`（分区可编辑键 ⊆ 主壳草稿 ⊆ 后端白名单，且 `save()` 不得回退成字面量空对象）+ `frontend/src/core/settingsOverrides.test.ts`（差集与类型还原 7 项）；删除式反向对照已做：拿 HEAD 的旧 `save()` 跑守卫，当场红 |

推论（直接指向 S5）：**发布门禁必须包含一次「启动固化二进制」的冒烟**，否则上述三类永远只能靠人手动撞。

计划更正（S6 执行时）：本片原列「删除 `backend/config.py` 与 `AiSection.tsx` 里指向不存在功能的死引用」，
该前提来自侦察阶段的报告，逐个 grep 核实后**不成立**——这两处没有 `pipeline_translate_engine`
/ `three_pass` / `glossary` 的任何残留（只有 wave15/wave21 迁移文件与一处测试助手）。
唯一真死物是 `tests/test_translate_engine.py` 的 `_set_engine()`：它用 `raising=False`
设置一个 D-189 起就不存在的字段，静默 no-op，只在测试里制造「还能切引擎」的错觉——已连定义
一起删除（不留会 raise 的占位桩：半吊子既不是删除又会炸调用点）。

推论：**侦察结论在写入计划前必须自己复核一遍**，否则修一个不存在的问题还要搭上审查成本。

## 六、定档（2026-09-24 用户拍板，不再是开放问题）

1. **v0.40 主题 = 可信交付**（签名 / 自动更新 / 三端矩阵 / 备份可恢复 / 首启零终端操作）。
   「资产与叙事」五项功能缺口与「智能供给分层」排在 v0.40 之后。
2. **v0.32 不含 S7 前端拆壳**——纯结构改动无用户可感知收益，不与其他六片争时间。
   `AssetsPage.tsx` 1277 行 / `PlansPage.tsx` 1212 行 记为 v0.40 期间的独立机会窗口，
   动手时照 D-182/D-183 的「state 留壳、JSX 下放」既有模式（D-182 已记：JSX 手工切割
   比 Python 方法块脆弱得多，曾有整文件重写才是最快路径的先例）。
3. **`messages` / `conversations` 只留护栏、不删**。实测存量：conversations 3 行、
   messages 8 行，最后写入 2026-08-03。S1 的 `include_object` 黑名单让 autogenerate
   永远碰不到它们；真要删必须走一次显式迁移 + 事先归档，推到 v0.40 一并决定。
4. **v0.32 执行结果（本轮记录，非计划）**：S1–S6 全部落地，另清偿两条执行期暴露的
   真缺陷（工坊端点靠异常文案猜状态码 → 502 退成裸 500；设置页自 v0.20 起提交空
   `overrides`，改动从不落盘 —— D-204）。**发布动作未执行**：`release-check.sh`
   需重建固化包（磁盘与时间成本），是否现在发由用户决定；打 tag 前必须单独授权。
   唯一未闭合的验收项：**141MB 全量冷启动首下的成功实测**（本机代理 egress 两次中断，
   只取得 30MB 进度与完整失败路径证据），判据已沉淀为 `sim-newmachine.sh --with-download`。
5. **计划外追加（v0.33，D-212）**：用户报「下载一直 403」，实测是采集器兜底判据把
   2011 条空壳标成视频放进了可操作队列（详见 D-212）。这一片不属于原 S1–S7 任何一片，
   它属于本计划 §五·五 那一类：**「界面数字看着正常」与「数据真能干活」是两件事**。
   新留下的开放问题（不在本片处理）：`items.score_dimensions.mode="llm"` 与 `ai_calls`
   对不上账 —— 09-27 03:42 有两条 llm 评分，但当天 `ai_calls` 零记录（近 3 天仅 8 条，
   最后一条 09-26 02:19）。两种解释都可能：评分缓存复用把 mode 带了过来，或
   `ai_calls` 漏记（后者会让成本口径失真）。要查就先定「ai_calls 是不是成本唯一作者」。
