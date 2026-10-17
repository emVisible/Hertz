# A 实施简报：未评分区「情感主题轴 + 质量轴」服务端筛选

**性质**：bounded（在既有流程上加入口，不重排结构）。设计已在对话中呈现、用户 2026-09-28 定档「主题轴 + 质量轴叠加」。
**不做**：关键词搜索框、LLM emotion 重打分、看板（那是 B，见 `docs/SPEC_V034_BOARD.md`）、采集侧源池改动。

## 分母（先核对再动工，2026-09-28 dev 库实测，`/tmp/sentiment_denom.log`）

```
未评分活口（discovered 且 is_invalid=false 且未归档）  2659
其中情感类 subreddit                                    747  = 28.1%   ← A 有真实收益，不是空转
  ├ 带媒体直链                                          747  = 100%
  ├ item_type == 'text_only'                              0            ← 情感文字弹药为零
  └ 高质量档（reddit_score≥500 且 upvote_ratio≥0.90）   252
MadeMeSmile 286 / TikTokCringe 235 / ContagiousLaughter 62 / wholesome 55 / MadeMeCry 54（全部 video_raw）
```
`text_only = 0` 不是 A 的缺陷，是情感供给链断裂的结果（`selftext` 全表 0/5281，机制见 `docs/ROADMAP.md` 在飞段）。**A 必须把这一格做成可见的筛选值**（「无正文」是一档，能被数出来），而不是让它被筛选悄悄滤掉。

## 判据与单一作者纪律

1. **主题名单落 `backend/pipeline/category.py`**：新增模块级 `THEME_SUBREDDITS: dict[str, frozenset[str]]`，至少含 `"sentiment"`（现有「情感类（v0.11.6 情感频道）」注释下的那批 subreddit，逐条照搬，不增不减不改名）。`SUBREDDIT_TID_MAP` 改为**由主题集构造**（情感类 tid 仍是 21），使「哪些 subreddit 算情感」只有一个作者。
   - **等价性必须机械化证明**：先固化改动前的 85 键映射快照（测试内嵌字面 dict），重构后断言逐键相等。零行为变化是硬要求，不接受「看起来一样」。
   - 主题 key 用英文小写常量（`"sentiment"`），界面上再翻中文——判据不用中文当键。
2. **正文有无的门槛数字复用 `quality.MIN_STORY_CHARS`**，不许在筛选里另写 50。
3. 筛选参数只在 `QueriesMixin.list_items` 一处实现；`counts()` 若需同源数字，走既有 `operational_filters()`，不新开第二套 where 拼装。

## 后端

- `list_items(...)` 新增可选参数：`theme: str | None = None`、`quality: str | None = None`（`"loose"|"standard"|"strict"`）、`has_text: bool | None = None`。
  - `theme` → `Item.subreddit.in_(THEME_SUBREDDITS[theme])`；未知 theme → 抛 `ValueError`（**不要静默返回空集**：那会把「名单没配」伪装成「今天没有情感内容」）。
  - 质量档阈值（阈值集中成一个模块级 dict，一处作者）：
    | 档 | reddit_score | upvote_ratio |
    |---|---|---|
    | loose | ≥100 | ≥0.80 |
    | standard | ≥500 | ≥0.90 |
    | strict | ≥1500 | ≥0.94 |
  - `has_text` → `True`: `func.length(coalesce(selftext,'')) >= quality.MIN_STORY_CHARS`；`False`: 反向；`None`: 不加条件。
- `backend/routers/pipeline_items.py` 的 `GET /items` 透传三个 query 参数（非法值 → 422，不吞）。
- 新增 `GET /api/pipeline/items/facets?status=discovered&theme=sentiment` → `{total, hit, by_quality: {loose, standard, strict}, with_text, without_text}`：给前端「命中 X / 全量 Y」用。**total 与 hit 必须是两个数**——把筛后当全量是这个仓库被坑过的形状。

## 前端

- `PreReviewTab.tsx`：在段标签下方加一行筛选条（主题 / 质量档 / 正文有无 三个 Select），**参数必须进请求**（服务端筛）。理由写进代码注释：`usePipelineData.ts:30-35` 只拉 500 条而活口 2659 条，客户端筛会得出「没有情感内容」的假结论。
- 段标签改成「命中 X / 共 Y」（facets 供数）；筛选变化时列表与 facets 一起失效重取。
- 筛选状态存 zustand pipeline 切片（与 `tab`/`limit` 同一作者，`stores/execution.ts`），**默认 theme=sentiment? 不**——默认 `全部`，避免用户第一次打开以为数据变少了。
- i18n：`zh.json`/`en.json` 同步加键；无门禁校验孤儿键（已核两次 grep 零命中），所以键名加完自查一次。

## 测试（TDD，红→绿）

1. 等价性快照测试（主题化重构前后 map 逐键相等）。
2. `theme` 筛选：插两条合成条目（一条情感 subreddit、一条非情感），断言只回数情感那条。**测试不许依赖 dev 库存量**（合成行 + 独立 session）。
3. 未知 theme → `ValueError`（正/负样本都要）。
4. 质量档：合成 `reddit_score=600, upvote_ratio=0.95` → 三档全命中；`reddit_score=50` → 一档不命中。
5. `has_text=False` 命中「正文空」条目；`has_text=True` 命中 ≥`MIN_STORY_CHARS` 条目。
6. facets：`total != hit` 且 `with_text + without_text == total`。
7. vitest：筛选参数→请求 query 的映射纯函数（断言真的发出 `theme=`，不是只改本地 state）——D-204「只演出不落盘」的同类门禁形状。

## 验收

- `uv run ruff check backend tests` EXIT=0；`uv run pytest -q` EXIT=0（基线 504 passed，报新增数）；`cd frontend && npx tsc --noEmit` EXIT=0；`./scripts/verify.sh` 全绿（退出码单独取，日志里必须出现 `ALL GATES PASSED`）。
- 网络类失败先 `NO_PROXY=127.0.0.1,localhost` 复跑再归因。
- 不 push、不 tag；提交信息 heredoc、不含反引号。
