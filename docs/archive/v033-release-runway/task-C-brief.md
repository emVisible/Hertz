# C 实施简报：情感文字供给链闭合（v0.34-S1）

**起因（实测，全部已落 `docs/ROADMAP.md` 在飞段）**：`items.selftext` 在 dev 库 **5281 行里 0 行非空**；v0.33 隔离的 2196 条里 **2013 条（91.7%）落在情感名单**、**1982 条来自文字为主子版**（offmychest 503 / AITA 418 / relationship_advice 374 / relationships 328 / TrueOffMyChest 251 / BestofRedditorUpdates 71 / JustNoFamily 37），未隔离的同子版只剩 **6 条**。2196 条**全部带 `source_id`** → 可回填。
**判据链无罪**：离线尖峰（`/tmp/selftext_spike.log`）证明喂进 281 字正文后 `_to_post` → `item_type='text_only'`、`quality.stamp` → `is_invalid=None`，闸本来就放行故事帖。缺的只有正文。

**切片边界**：C 不碰采集策略选择、不加新数据源、不动 v0.33 已完成面（判据/隔离/体检/回填脚本的既有形状只复用不重写）。

---

## C 分两半，一半现在就能做

| 半片 | 需要网络？ | 内容 |
|---|---|---|
| **C-code** | 否 | 1 `raw_json=1`、2 断裂可见化、3 `quality.reassess()` 单一作者 |
| **C-run** | 是 | 4 回填脚本实跑 + 1982 条重判 + 数字回写文档 |

egress 现状（2026-09-28 08:15Z 复测）：reddit 与 huggingface 探针均 `000`/timeout。所以 **C-run 不许和 C-code 混在一次提交里**，也不许用「脚本写好了」冒充「回填完成了」。

---

## 1. 匿名 JSON 补 `raw_json=1`

`backend/pipeline/collectors/reddit.py`：`_collect_json`（约 `:286-288`）目前 `params={"limit": min(limit, 100)}`，而 `_collect_oauth`（约 `:261`）传了 `raw_json: 1`。差别是实质性的：`raw_json=0` 时 Reddit 按自家渲染返回 `selftext`，实体转义（`&#32;` / `&amp;` / `«` 之类）会直接进库——一个以文字为弹药的垂类第一天就吃到脏文本。

- 改法：与 OAuth 通道对齐，共用同一个 params 构造（**不要两个通道各写一份 `"raw_json": 1`**——那又是一份事实两个作者；抽 `_listing_params(limit)` 之类的单一小函数）。
- 测试：假 httpx client 断言两条通道都发出 `raw_json=1`（正向），并断言它们走的是同一个构造函数（守卫形状：读源码断言 `raw_json` 字面量在 reddit.py 里**只出现一次**，参照 `tests/test_proxy_authority.py` 的正向棘轮形状——删掉收口即红）。

## 2. 把「走了 RSS = 没有正文」变成看得见的东西

现状是**静默降级**：`reddit.py:240-250` 匿名 JSON 遇 403/429 就 `logger.warning` + 落 `_last_strategy="rss"`，而 `reddit.py:372` 注释自陈「RSS 通道拿不到 selftext」。`last_strategy` 已经存在且已入 `source_state`（v0.8.9 AXIOM 28），缺的是**有人看**。两层补齐，不加新布尔列：

- **常驻体检**（`backend/pipeline/integrity.py`，只报不改）：加第 7 条不变量 `story_without_text` —— `item_type == 'text_only'` 却 `selftext` 空/低于 `quality.MIN_STORY_CHARS` 的条目数。它同时是 C-run 的回填候选计数口径，**一个判据两处用，不许各写一份 SQL**（导出成一个 helper 供体检与脚本共用）。
- **界面**：采集状态区把 `last_strategy` 露出来（值 ∈ json / oauth / rss / pullpush），并在 `rss` 时加一句「此通道拿不到正文，文字产线无弹药」。i18n 中英同步。
- 测试：合成一条 `text_only` + 空正文 → 体检计数 +1 且样本命中；干净库不红（正/负样本都要，参照 `tests/test_shell_items.py` 的守卫形状）。

## 3. `quality.reassess()`：能清标的唯一作者

`pipeline/quality.py::stamp` 的既有语义是「只加隔离标、不清标」（避免动到终态与人工标记）。回填需要反向动作，**必须由 quality 自己提供**：脚本自己写 `is_invalid=False` 就是第二个作者，会被 v0.33 的写入口守卫按住（那条守卫要求「凡建 discovered 条目处必须 stamp」）。

- 新增 `reassess(item) -> bool`：重算 `shell_reason`；理由不再成立 → 清 `is_invalid` / `error_class` / `error` 并把 `item_type` 修正为 `text_only`；理由仍成立 → 原样返回 False。**终态一律不动**（沿用 `QUARANTINABLE_STATUSES` 范围判据，别在 reassess 里重写一份状态白名单）。
- 不许覆盖非 `INVALID_REASON` 的 `error_class`（人工/其他来源的标记优先），与 `stamp` 同一条纪律。
- 测试三件套：①正文补够 → 清标且 `item_type='text_only'`；②仍无正文 → 保持隔离且原因文案不变；③终态条目（published/rejected）传进去 → 零改动。

## 4. `scripts/backfill-selftext.py`（C-run）

- 形状照 `scripts/quarantine-shell-items.py`：**默认干跑**，`--apply` 才写库，`--limit N`，末尾打印 before/after 的 `counts()`。
- 取数：`select Item.source_id, Item.subreddit where is_invalid=true and <第 2 条的 story_without_text 判据 helper>` —— 复用 helper，不重写 SQL。
- 请求：`https://api.reddit.com/api/info.json?id=` 逗号拼接 `t3_<id>`，**每请求 100 个**（API 上限），有 OAuth token 时带 Bearer 且走 `oauth.reddit.com/api/info.json`；代理与回环判定一律经 `backend/infrastructure/net.py`（守卫在盯着，别手写 `trust_env`）。
- 节流：请求间 `sleep` 且对 429 退避；单轮上限（默认 20 请求 = 2000 条）防跑飞。
- 写回：拿到 `selftext` 后**只填 `item.selftext` 与必要的 `item_type`，然后调 `quality.reassess(item)`** —— 清标动作必须发生在 quality 里。
- 结论打印四类：`recovered` / `still_shell`（帖已删或正文为空）/ `not_found`（id 取不到）/ `error`（HTTP 失败），并把四类计数写进 `docs/ROADMAP.md` 的实测行。
- **网络前提**：跑之前 `curl -sS -o /dev/null -w '%{http_code}' https://www.reddit.com/r/AITA/new.json` 探一次，拿到 `000` 就停手记「未实测」，不许用干跑冒充成功（这条是仓库里已经犯过一次的错）。
- 单测只测纯逻辑（id 分批 100、四类计数归类、reassess 调用次数），网络层打桩假 transport；脚本本身不进 CI。

---

## 验收

- `uv run ruff check backend tests` EXIT=0；`uv run pytest -q` EXIT=0（报新增数，基线见 `.superpowers/sdd/2026-09-27-v033-release-runway/progress.md` 最新一行）；`cd frontend && npx tsc --noEmit` EXIT=0；`./scripts/verify.sh` 尾部 `ALL GATES PASSED`。
- 退出码一律单独取（`cmd > /tmp/x.log 2>&1; echo EXIT=$?`）。
- 网络类失败先 `NO_PROXY=127.0.0.1,localhost` 复跑再归因。
- 不 push、不 tag；提交信息 heredoc、不含反引号；每半片各一次提交（C-code / C-run 分开）。
- C-run 完成后必须回写：`selftext` 非空数、`recovered`、未评分区情感文字条目数（当前 0）、`story_without_text` 体检值 —— 都是绝对数字，不许写「大幅改善」。
