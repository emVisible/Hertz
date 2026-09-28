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

### 4.1 数据模型（一次迁移 `wave31_board_plan`，接在 `wave30_item_invalid` 之后）

**新表 `daily_plan`**（一天一行，仿 `models/brief.py` 的 `BaseModel` 约定，白得 id/created_at/updated_at）：

| 列 | 类型 | 说明 |
|---|---|---|
| `plan_date` | `Date`，`unique=True`，`index=True` | 一天一行的身份。索引是因为查询永远是「按日期取一行」，选择性极高 |
| `goal_text` | `Text`，`default=""`，nullable=False | 多行自由文字（用户要的「文字输入 + to do list」就长在这里，不拆成子表） |

**`items` 新增两列**（同一条迁移）：

| 列 | 类型 | 说明 |
|---|---|---|
| `focus_date` | `Date`，nullable=True | 「今天捞它」。空 = 不在今日列。按 v0.32 S2 的索引纪律**不建索引**：全表个位数百分比非空且日切分布随人工捞取，等真实行数上来再量 |
| `focus_note` | `Text`，nullable=True | 「我后面要怎么加工它」——备注长在卡片上，不长在文档里 |

**为什么是 `focus_date` 而不是 `is_today: bool`**：bool 会要求「每天凌晨有人去清零」，那是第二个写入口和新故障面；日期让「昨天捞的」自然掉出今日列，无需任何后台作业。

**时区约定**：`plan_date` / `focus_date` 存「用户墙上日期」。后端**不猜时区**——由前端算出 `YYYY-MM-DD` 字符串随请求下发（`daily_plan` 与今日列的全部读写都走这个口径）。这条写进端点契约，避免 UTC 与服务端本地时区打架。

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

### 4.5 边界与失败处理

| 情况 | 行为 |
|---|---|
| `plan_date` 不存在就 PUT | upsert 建行，200 |
| 同一天并发 PUT | 后写覆盖；不做乐观锁（单人本地桌面应用，加版本号是纯成本） |
| `focus` 打在一个已 `archived` 的条目 | 409，文案说明先取消归档 |
| `date` 参数不合法（非 `YYYY-MM-DD`） | 422，由 pydantic 层拦，不进 SQL |
| 今日一列条目为空 | 空态文案给「去未评分筛情感素材」的动线按钮，不是「暂无数据」死路 |
| 迁移 downgrade | `wave31_board_plan` 必须可降：先 drop 两列再 drop 表；alembic 删表闸（v0.32 S1）会要求显式声明 |

### 4.6 体检新增一条不变量（`pipeline/integrity.py`，只报不改）

`focus_orphan`：`focus_date` 非空但条目处于终态（`REJECTED` / `archived`）→ 说明有第二条路径在绕过 `archive()` 的白名单写 focus。这条是「常驻巡检」层，和 v0.33 那六条同级。

---

## 五、测试策略

- **后端 pytest**：`daily_plan` upsert 与按日期回读；`PUT` 超 4000 字 → 422；`focus` 对归档条目 → 409；`board` 端点各列取数与 `list_items` 的筛选参数一致（防第二作者）；`wave31` 升降级可逆（真库跑一次）；`focus_orphan` 不变量对脏数据行必红、对干净库不红（正/负样本都要，参照 `test_shell_items.py` 的守卫形状）。
- **前端 vitest**：列分组纯函数（一条记录 → 唯一一列，不重复计数）；`goal_text` 草稿态与保存态的区分（这条正是 D-204 那个「只演出不落盘」回归的门禁形状，必须断言真发请求）。
- **产物门禁**：`scripts/verify.sh` 全绿 + `scripts/release-check.sh` 装得上、固化后端日志里 `scheduled job 'integrity'` 仍在（证明我没顺手弄死后台作业）。
- **不做**：不为看板加新依赖；不加 e2e（本仓无 e2e 基座，单开一个不在本版范围）。

---

## 六、与 v0.33 发布跑道的关系

本文是 **v0.34** 的工作面，不进 v0.33（v0.33 只收：代理旁口、门禁代修、Reddit 凭证可见性、空壳治理）。依赖顺序：

1. v0.33 发版（会话 plans 目录里的 `2026-09-27-v033-release-runway.md` Task 4，进度见 `.superpowers/sdd/2026-09-27-v033-release-runway/progress.md`）
2. **A** 未评分主题/质量筛选（bounded，本文 §4.2 的前置）
3. **B** 本设计 → plan → 实施
4. 情感供给链闭合（`raw_json=1` 一行 + RSS 静默降级的可见性 + Reddit OAuth 凭证实测）——它决定 B 上线时「候补池」里有没有真弹药，见 `docs/ROADMAP.md` 在飞段实测数字：`selftext` 非空 **0/5281**

**已知未实测（不许被本文当成已证）**：v0.33 之后新采集是否真带上 `selftext`（本机 egress 今夜整体不通，reddit/huggingface 探针均 `000`）；离线尖峰只能证明判据链放行（`item_type=text_only`、`is_invalid=None`）。
