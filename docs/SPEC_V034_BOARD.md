# v0.34 流水线看板 + 每日目标 设计说明

**状态：待用户复核**（本文是设计，不是实施计划；实施拆分成一份 plan（与本仓约定一致，放会话 plans 目录，不在 `docs/` 下新造目录），且需先通过本文 review）
**提出人**：用户 2026-09-28 —— 「内容流水线里的队列和日历能不能融合到看板里，我每天要给自己设定每日目标，需要文字输入，像 to do list；我觉得日历和队列没什么实际作用，预发队列我要发就直接发了」
**定档**：用户已选「全部手动发，队列与日历两个视图都撤」；完成度语义见 §4.3（推荐项，待确认）

---

## 一、实测前提（数字先立住，设计不建立在感觉上）

| 事实 | 证据 |
|---|---|
| 手动发布**不经过队列** | `backend/pipeline/service_publish.py:91` `publish_one` 只要求 `status in (APPROVED, PUBLISHED)` |
| `queue_phase` / `scheduled_at` 只服务**默认关闭**的自动发布 | `backend/config.py:126` `pipeline_auto_publish_enabled` 默认关；消费者 `service_promotion.py:246,287-300` |
| 但这两个字段有**四处活读者**，不是只有那两个视图 | `telegram_bot.py:87,273`（今日待发/holding）；`service_promotion.py`（产能槽位，enqueue「今天窗口已排满」的 422 在此）；`integrity.py:197-206`（status × queue_phase 合法组合不变量）；`service_archive.py:58`（归档重置相位） |
| 日历**不建表**，只是 `scheduled_at` 的一个视图 | `docs/DECISIONS.md` D-132「不建新表，单一真相源」；`service_schedule.py:117-145` 直接查 `scheduled_at`/`published_at` |
| 删视图安全，删字段会连带弄坏上面四处 | 同上 |
| 发布 tab 现在是三个并列视图 | `frontend/src/pages/execution/pipeline/PostReviewTab.tsx:19` `PostView = 'list' \| 'queue' \| 'calendar'`，按钮组 `:29-66` |
| 仓库里**没有任何看板** | `frontend/src/stores/board.ts` 与 `pages/canvas/` 是画笔白板，不是条目看板 |
| 条目上**没有**任何待办/备注/目标字段 | `backend/models/item.py` 全列核过；最接近的是 `briefs.content`（创作策略 Markdown，另一域）与 `channel_insights.insights_json.notes` |

**本文推翻两条旧决策**：D-132（为对标 Buffer/新榜特意加日历）、D-191（原计划增强日历）。推翻理由就是上表第 1、2 行——用户的工作流是手动发布，排期视图对他不构成可操作数据，却占据一级入口。落 `DECISIONS.md` 新条目时须显式引用本表。

---

## 二、目标与非目标

**目标**
1. 一个以「我今天要做什么」为中心的一级视图，替代「按状态统计」的三并列视图。
2. 每日目标：一天一段文字，可改，可回看昨天。
3. 条目级待办：把筛出来的素材「捞进今天」，并在我需要后期加工时把备注写在条目上。
4. 队列与日历从界面上退役，**不撤字段、不撤机制**。

**非目标（明确不做）**
- 不做拖拽改状态（看板卡片只做动作按钮，状态推进仍走既有 `act`，避免产生第二套状态迁移作者）。
- 不做逐条 checkbox 的 to-do 状态机（§4.3 说明理由与替代）。
- 不做多日排期视图、不做时区选择器、不做团队成员/协作。
- 不删 `queue_phase` / `scheduled_at` / 产能槽位 / 自动发布代码路径。
- 不动异常区（`is_invalid` 池）的现有位置，看板不承载它。

---

## 三、方案空间与选择

| 方案 | 说明 | 为什么不选 |
|---|---|---|
| **A. 新增一级「今日」视图 + 撤两视图（选这个）** | 看板列 = 阶段（今日待办 / 在制 / 待审 / 待发布 / 今日已发），卡片 = 条目；顶部一段今日目标文字 | — |
| B. 只把队列/日历塞进现有列表 tab 的子分段 | 改动最小 | 用户要的还是「按状态看」，「我今天做什么」仍然没有落点；等于把两个死视图换了个位置 |
| C. 彻底删除排期能力（连字段与 auto_publish 一起删） | 界面与后端一次清干净 | 与「以后可能想开无人值守发布」互斥，且会弄坏 Telegram 机器人与体检不变量的读法（§一 第 3 行）；删字段的收益是负的 |

选 A。B 是搬家不是融合；C 的破坏面大于收益。

---

## 四、设计

### 4.1 数据模型（一次迁移 `wave31_board_goal`，接在 `wave30_item_invalid` 之后）

> **命名冲突已纠正（2026-09-28 实测）**：本 spec 早期版本把每日目标叫 `daily_plan`、
> 模型放进 `backend/models/plan.py`。而 `models/plan.py` **已存在**且属于**编排域**
> （`plans` 表 / `Plan` / `WorkflowRun` / `PhaseRun`）——同一仓库里两个「plan」迟早
> 漂成两套读法，正是 D-205/D-212 在消灭的形状。发现过程也不体面：我按 spec 去"新建"
> 那个文件，Write 直接覆盖了已存在的编排模型（靠 `git checkout` 秒回，未提交所以无损）。
> 现统一改名：表 **`daily_goal`**、列 **`goal_date`**、模型 **`backend/models/board.py`**、
> 服务 **`backend/pipeline/board_store.py`**、端点 **`/api/pipeline/goal/{day}`**。

**新表 `daily_goal`**（一天一行，仿 `models/brief.py` 的 `BaseModel` 约定，白得 id/created_at/updated_at）：

| 列 | 类型 | 说明 |
|---|---|---|
| `goal_date` | `Date`，`unique=True`，`index=True` | 一天一行的身份。索引是因为查询永远是「按日期取一行」，选择性极高 |
| `goal_text` | `Text`，`default=""`，nullable=False | 多行自由文字（用户要的「文字输入 + to do list」就长在这里，不拆成子表） |

**`items` 新增两列**（同一条迁移）：

| 列 | 类型 | 说明 |
|---|---|---|
| `focus_date` | `Date`，nullable=True | 「今天捞它」。空 = 不在今日列。按 v0.32 S2 的索引纪律**不建索引**：全表个位数百分比非空且日切分布随人工捞取，等真实行数上来再量 |
| `focus_note` | `Text`，nullable=True | 「我后面要怎么加工它」——备注长在卡片上，不长在文档里 |

**为什么是 `focus_date` 而不是 `is_today: bool`**：bool 会要求「每天凌晨有人去清零」，那是第二个写入口和新故障面；日期让「昨天捞的」自然掉出今日列，无需任何后台作业。

**时区约定**：`goal_date` / `focus_date` 存「用户墙上日期」。后端**不猜时区**——由前端算出 `YYYY-MM-DD` 字符串随请求下发（`daily_goal` 与今日列的全部读写都走这个口径）。这条写进端点契约，避免 UTC 与服务端本地时区打架。

### 4.2 后端接口（读仍归 `QueriesMixin`，编排不另立查询作者）

| 端点 | 形状 | 备注 |
|---|---|---|
| `GET /api/pipeline/board?date=YYYY-MM-DD` | `{date, goal_text, columns: {focus, in_work, review, ready_to_publish, published_today}, counts: {...}}` | 只做编排：五个列的取数全部调 `list_items(...)`，各列上限常量集中在此模块。列的**唯一**定义（一条记录只能落进一列，重复计数由 vitest 纯函数断言）：`focus` = `focus_date = date` 且未发布；`in_work` = `status ∈ (downloaded, scored)` 且未捞入 focus；`review` = `status = queued`；`ready_to_publish` = `status = approved`；`published_today` = `status = published` 且 `published_at` 落在 `date` 当天（前端下发 UTC 区间两端，后端不做时区推断） |
| `PUT /api/pipeline/plan/{date}` | body `{goal_text: str}` → 回读整行 | upsert 语义；`goal_text` 长度上限 4000，超限 422（输入边界，不是内部信任问题） |
| `PATCH /api/pipeline/items/{id}/focus` | body `{focus_date: str\|null, focus_note: str\|null}` → 回读条目 | 单一写入口。归档条目拒绝（409），与既有 `archive()` 白名单纪律一致 |

`_serialize` 增出 `focus_date` / `focus_note` 两字段（`service.py:144` 附近，那里已是序列化的唯一作者）。

**候补池复用 v0.34-A 的服务端筛选**：看板的「捞进今日」从**带筛选的未评分列表**里取，因此 A（`theme` + 质量档，见 `docs/ROADMAP.md` 在飞段）是 B 的前置，B 不另写第二套筛选参数。

### 4.3 完成度语义（这条是设计里唯一还开着的判断，我给了推荐）

**推荐**：完成度 = **真实数字**，不来自手勾。看板顶栏渲染成「今日目标 · 已发 N / 捞入 M」，其中 M = `focus_date = today` 的条目数，N = 其中 `status = PUBLISHED` 且 `published_at` 落在今天的条数。

- 为什么不手勾：手勾状态要新表 + 新状态机，且「勾了」和「发出去了」是两件事——它会让人对着一个自我安慰的数字收工。真实数不撒谎，这跟 D-204 那条「设置页 toast 说已保存但其实没落盘」是同一类教训的反面。
- 代价：不能表达「今天我要研究一下 AITA 的开头怎么写」这种无法用条目度量的目标。这种内容写在 `goal_text` 里即可，它本来就不该被计入完成度。

### 4.4 界面（一个视图换掉三个并列视图）

- 新增 `frontend/src/pages/execution/pipeline/BoardTab.tsx`；`ExecutionPage` 一级 tab 顺序：`看板（默认）｜预处理｜审核｜发布｜异常`。
- `PostReviewTab.tsx` 删 `PostView` 三分段与按钮组（`:19`、`:29-66`），只保留现存的发布列表 + 发布历史（看板不吞掉发布历史，它仍在发布 tab）。
- 删除文件：`frontend/src/pages/execution/CalendarView.tsx`、`frontend/src/pages/execution/calendar.ts` 及其测试、`frontend/src/components/execution/QueueView.tsx`。
- **保留**：`PublishCard` 上的 **`ScheduleField`（可编辑，`PublishCard.tsx:402` 经 `onSaveMeta` 写 `scheduled_at`）**。这不是「留着旧入口以防万一」——`publishers/router.py:162-177` 读 `item.scheduled_at` 走的是 **biliup 原生定时上传（`--dtime`）**，与 `queue_phase`/`auto_publish` 无关：手动点发布 + 一个未来时间 = B 站侧定时上线。撤掉它就是删一项活能力（本 spec 早期版本写的是「只读呈现」，实施前自查 grep 全部写点后**纠正为保留可编辑**——写点清单：`service_publish.set_meta`、`enqueue`(:229)、`reschedule_expired`(`service_schedule.py:76`)、`service_promotion.py:127,223,338`)。
- **删除**：`PublishCard` 的**「入队」按钮**与 `onEnqueue` 传参（这是 `queue_phase` 在界面上唯一的写点）。
- **由此产生的已知后果（不许事后惊讶）**：撤掉入队按钮后，`auto_publish_tick` 在界面上**再也无法被喂进数据**（它的筛选条件是 `queue_phase == 'ready'`）。代码、端点与产能槽位一律保留，但要开无人值守发布得靠 API 或 Telegram 侧写相位。这与用户定档「全部手动发、两者都撤」一致，故**接受并记录**，不额外补 UI。
- 后端 `GET /api/pipeline/calendar` 随视图删除（唯一调用方是 `CalendarView.tsx:66`）；`GET /publish/queue` 与 `POST /items/{id}/queue` **保留**，它们是 `auto_publish` 这条被配置开关的能力唯一读写口。`reschedule_expired`（进审核页自动触发）与 `next_schedule_slot` 机制**一律不动**。
- i18n：`console.calendar*` / `console.queueView` 等键随组件删除，不留孤儿键。**注意**：本仓没有任何门禁校验 i18n 键（已核：`grep -rn "i18n|zh.json|orphan" tests/*.py` 与 `grep -rln "zh.json|en.json" frontend/src --include="*.test.ts*"` 均零命中），所以这条靠实施时人工核对 + 补一条 vitest（`zh.json` 与 `en.json` 键集相等，且被删键不再被任何 `.tsx` 引用）。

### 4.4b 界面形状修订（2026-09-28 实测后；**本小节覆盖 §4.4 的 tab 部分**）

§4.4 原稿写「新增一级看板（默认）」——那是**没数过现有 tab 就下的结论**。实测：流水线页已经有 **6 个内层 tab**，唯一作者是 `frontend/src/pages/execution/pipeline/shared.tsx:75-85` 的 `PIPELINE_TABS`（运行 / 工坊 / 预处理 / 审核 / 发布 / 异常，每项带 `countKeys`）。再加一个就变 7 个 tab：**恰好在你抱怨「结构没用」的地方加东西**，方向反了。

修订成 **tab 数 6→6 的真融合**：

- **看板替换 `postReview`，不是加在旁边。** 依据：发布 tab 的实际内容就是两张列表 —— `stageApproved`（发布操作，`PublishCard`）与 `stagePublished`（发布历史），而这两张列表正是看板的「待发布」与「今日已发」两列。**复用同一批卡片组件**，搬过去而不是复制一份，所以不产生第二套发布入口。
- 发布 tab 顶部那条 `publishStatus` 警示（noop / B 站 cookie 缺失，`PostReviewTab.tsx:76-104`）跟着搬进「待发布」列的列头，不留孤儿告警。
- 看板五列：`今日待办` → `在制`(downloaded/scored) → `待审`(queued) → `待发布`(approved) → `今日已发`。异常区仍留在 `exceptions` tab，看板不承载（§二 非目标不变）。
- 顶栏：今日目标多行文字 + 「已发 N / 捞入 M」（§4.3 的真实数，不手勾）。
- `PIPELINE_TABS` 里把 `postReview` 一项换成 `{ id: 'board', labelKey: ..., countKeys: ['approved','published'] }`，位置放**第 2 位**（`run` 之后）——没放最前，因为「运行/采集运维」是你每天第一眼要看的东西；顺序若要调，改这一行就够。默认 tab 改 `board`，作者仍是 `stores/execution.ts` 的初始 state。
- 删除清单因此增加一个：`PostReviewTab.tsx`（职能被看板接管）。`CalendarView.tsx` / `calendar.ts` + 测试 / `QueueView.tsx` 照旧删。

其余一律不变：撤界面不撤字段、`PublishCard` 保留可编辑 `ScheduleField`（§4.4 已纠正）、删「入队」按钮、~~`GET /calendar` 随视图删~~（**§4.4c 第 2 条按证据作废**）、`publish/queue` 与 `items/{id}/queue` 保留。

### 4.4c 实施时的三处纠正（2026-09-30，B-UI 落地当天）

写 spec 时数读者数错了三处。都是同一类错：**只数了界面读者，没数机制读者和深链读者**。留编号、留实测，不改写历史。

1. **`queueView()` / `PublishQueueView` 必须保留**（§4.4 的删除清单里那条作废）。
   依据：`pages/dashboard/DashboardPage.tsx:134-136` 在用 `pipelineApi.queueView`，读 `today` 产能与
   `ready`/`holding` 计数。撤掉它会把运营看板的产能卡变成空白——而那是**另一个界面**的活读者。
   教训记法：数读者要按符号名搜（`queueView`），不能按调用写法搜（`queueView(`），
   因为 TanStack Query 的 `queryFn: pipelineApi.queueView` 不带括号——本次就是 `tsc` 替我抓到的。
   保留范围只到读侧：`enqueue()` / `enqueueBatch()` 两个前端写点照 §4.4 删除。
2. **`GET /api/pipeline/calendar` 不删**。它不只被视图用：`tests/test_pipeline_governance.py::test_calendar_endpoint`
   是一条真在跑的行为测试（跨月区间过滤），而且它读的是 `scheduled_at` / `published_at` 这两个
   **仍然可写**的字段（`ScheduleField` → `set_meta`，biliup `--dtime` 消费）。删端点=删一项可检验的能力，
   与「撤界面不撤字段」这条定档自相矛盾。改判：**端点、service 方法、那条测试都留着**；
   删掉的只有前端 `calendar()` 方法与 `CalendarView.tsx`，以及 `refresh()` 里那条
   `['pipeline-calendar']` invalidate（界面不再读它了）。
3. **`/queue` 深链一直是坏的**（顺带修的既存缺陷，不在原 spec 里）。`AppShell.tsx:132` 指向
   `?mode=queue`，而 `ExecutionPage` 的 reader 只认 `pipeline|monoline`，其余一律落回 `studio`
   ——书签进来看到的是 Studio。改成 `/execution?mode=pipeline`，看板正好是默认页签。

### 4.5 边界与失败处理

| 情况 | 行为 |
|---|---|
| `goal_date` 不存在就 PUT | upsert 建行，200 |
| 同一天并发 PUT | 后写覆盖；不做乐观锁（单人本地桌面应用，加版本号是纯成本） |
| `focus` 打在一个已 `archived` 的条目 | 409，文案说明先取消归档 |
| `date` 参数不合法（非 `YYYY-MM-DD`） | 422，由 pydantic 层拦，不进 SQL |
| 今日一列条目为空 | 空态文案给「去未评分筛情感素材」的动线按钮，不是「暂无数据」死路 |
| 迁移 downgrade | `wave31_board_goal` 必须可降：先 drop 两列再 drop 表；alembic 删表闸（v0.32 S1）会要求显式声明 |

### 4.6 体检第 8 条不变量 `focus_orphan`（`pipeline/integrity.py`，只报不改）——**已交付，但判据形状与原文不同**

原设计：`focus_date` 非空但条目处于终态（`REJECTED` / `archived`）→ 说明有第二条路径在绕过 `archive()` 的白名单写 focus。

**原文那个形状不能直接实现**（这是设计时的漏算，不是实施走样）：`set_focus` 之后用户完全可能接着把那条拒了 / 归档了 / 发出去——这三条 transition 都不经过 `set_focus`，谁都不清 `focus_date`。照原文加判据，它会在**最日常的操作**上变红，等于新造一条长期红的报警器（C 切片刚为同一个形状修过第 3 条）。

交付的是两半，顺序不能反：

1. **先给「清」一个作者**：`board_store.clear_focus(item)`（改字段不 commit，提交时机仍归调用方）。三个退出工作区的点各自调它——`engine.reject`、`service_archive.archive`（紧挨着既有的 `scheduled_at` / `queue_phase` 清洗）、`service_publish` 写 `PUBLISHED` 的那一段。
2. **再上判据**：`check_focus_orphan` = `focus_date IS NOT NULL AND (archived OR status ∈ (rejected, published))`。第 1 步之后，正常操作再也造不出这种行，报出来的只可能是绕过。

视图层还留了一道兜底：`board.FOCUS_EXCLUDED_STATUSES` 让 `rejected` 与 `published` 都不进今日列，且 `progress.focused`（M）不计 `rejected`——**报警器坏掉的那天，界面也不假装今天还有活儿**。

守卫（`tests/test_board_domain.py`）：`test_reject_and_archive_clear_focus`（真走两条服务路径）、`test_publish_path_also_clears_focus`（发布不跑真上传，正向断言 `clear_focus(row)` 落在写 `PUBLISHED` 与 commit 之间的同一片段里）、`test_focus_orphan_invariant_reports_only_bypasses`（干净库不红 / 手工旁路那一行必红 / 撤掉即绿）、`test_integrity_registers_eighth_check`。四条变异各自验过：摘掉三处 `clear_focus` 调用、或把第 8 条从 `CHECKS` 里删掉，对应测试都红。

---

## 五、测试策略

- **后端 pytest**：`daily_goal` upsert 与按日期回读；`PUT` 超 4000 字 → 422；`focus` 对归档条目 → 409；`board` 端点各列取数与 `list_items` 的筛选参数一致（防第二作者）；`wave31` 升降级可逆（真库跑一次）；`focus_orphan` 不变量对脏数据行必红、对干净库不红（正/负样本都要，参照 `test_shell_items.py` 的守卫形状）。
- **前端 vitest**：列分组纯函数（一条记录 → 唯一一列，不重复计数）；`goal_text` 草稿态与保存态的区分（这条正是 D-204 那个「只演出不落盘」回归的门禁形状，必须断言真发请求）。
- **产物门禁**：`scripts/verify.sh` 全绿 + `scripts/release-check.sh` 装得上、固化后端日志里 `scheduled job 'integrity'` 仍在（证明我没顺手弄死后台作业）。
- **不做**：不为看板加新依赖；不加 e2e（本仓无 e2e 基座，单开一个不在本版范围）。

### 五的实际落地（2026-09-30，别拿本节当门禁的替身——命令与数字在提交消息里）

| 上面要求的那条 | 在哪儿 |
|---|---|
| `daily_goal` upsert + 按日期回读 | `test_put_goal_upserts_one_row_per_day` / `test_goal_put_then_read_back_through_http`（后者穿 HTTP，PUT→GET 同一文本） |
| `PUT` 超长 → 422 | 判据半条在 `test_overlong_goal_rejected_by_the_single_author`，映射半条在 `test_endpoint_maps_store_errors_to_status_codes`（同处还测 409 与 404） |
| `focus` 对归档 → 409 | `test_focus_patch_semantics`（store 层）+ 上面那条端点测试 |
| 各列取数与 `list_items` 参数一致（防第二作者） | `test_board_endpoint_asks_for_the_documented_columns`（替身只记 kwargs）+ `test_list_items_focus_filter_is_not_decorative`（真库，证明筛选不是摆设）+ `test_board_and_router_do_not_write_their_own_sql` |
| `wave31` 升降级可逆 | 一次性真库 `hertz_wave31_probe` 跑完整往返后 `dropdb`；`test_wave31_joins_main_line_and_heads_stay_two` 钉住 heads 仍是 2 |
| 列分组纯函数（一条记录 → 唯一一列） | **不在 vitest，在后端**：`board.build_columns` 是 Python 侧的纯函数，前端不再分一次列（分两处才会漂）。见 `test_one_row_lands_in_exactly_one_column` |
| 草稿态 vs 保存态（D-204 形状） | 前端 `BoardTab.test.tsx`：未改过 ⇒ 按钮 disabled 且一次请求都不发；改过 ⇒ `saveGoal(day, text)` 真发出去；换日期 ⇒ 上一天的草稿作废 |
| i18n 补一条 vitest | `src/i18n/catalog.test.ts`（中英叶子键集相等 + 退役键既不在目录也不被引用 + 看板要的键两边都在，并带两条「判据能抓到在用的键」对照组） |
| `focus_orphan` 不变量 | **已交付，但判据形状与 §4.6 原文不同**：先给「清」一个作者（`clear_focus` 接进 reject/archive/publish 三处），再上第 8 条。四条腿 + 四条变异见 §4.6 末段 |
| `release-check.sh` | **未跑**（产物门禁排在所有 fix round 之后，见 ROADMAP） |

---

## 六、与 v0.33 发布跑道的关系

本文是 **v0.34** 的工作面，不进 v0.33（v0.33 只收：代理旁口、门禁代修、Reddit 凭证可见性、空壳治理）。依赖顺序：

1. v0.33 发版（会话 plans 目录里的 `2026-09-27-v033-release-runway.md` Task 4，进度见 `.superpowers/sdd/2026-09-27-v033-release-runway/progress.md`）
2. **A** 未评分主题/质量筛选（bounded，本文 §4.2 的前置）
3. **B** 本设计 → plan → 实施
4. 情感供给链闭合（`raw_json=1` 一行 + RSS 静默降级的可见性 + Reddit OAuth 凭证实测）——它决定 B 上线时「候补池」里有没有真弹药，见 `docs/ROADMAP.md` 在飞段实测数字：`selftext` 非空 **0/5281**

**已知未实测（不许被本文当成已证）**：v0.33 之后新采集是否真带上 `selftext`（本机 egress 今夜整体不通，reddit/huggingface 探针均 `000`）；离线尖峰只能证明判据链放行（`item_type=text_only`、`is_invalid=None`）。
