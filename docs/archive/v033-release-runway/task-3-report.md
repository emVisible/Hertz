# Task 3 报告（Reddit 凭证可见性）— 由 controller 补写，如实记录

**为什么不是实施代理写的**：实施代理在 15:58 派发后于 16:03–16:04 完成 5 个文件的改动，此后 **21 分钟无任何文件写入、无 /tmp 门禁日志、系统里没有存活的 pytest/ruff 进程**——判定卡死。controller 于 16:25 `TaskStop` 后自行核对并跑门禁。本报告因此是「controller 验证记录」，不是「实施者自述」。

## 落地内容（改动全部来自该代理，代码判据经 controller 复核）

| 面 | 文件 | 内容 |
|---|---|---|
| 判据唯一作者 | `backend/infrastructure/deps.py::reddit_credentials_configured` | `id` 与 `secret` 均非空才算配齐（只填一半 OAuth 会 401） |
| 能力矩阵条目 | `deps._check_reddit_auth()` + `check_dependencies()` 注册 `"reddit_auth"` | 仿 `_check_telegram_cfg` 的 `off/ok` 形状，可选能力只报不阻断 |
| 状态端点 | `backend/routers/pipeline_ops.py` `GET /reddit-auth/status` | `{configured, token_ok, hint}`；**默认不联网**，`probe=true` 才真取 token；取 token 抛错退成 `token_ok=false` + 可读 hint，不裸 500 |
| 界面 | `settingsCards.tsx` `LABELS` + `rows` | 追加在 `telegram` 之后（controller ruling：显示序不是契约，不插中间扰动既有四张卡） |
| 文档 | `docs/API_INVENTORY.md` | 新端点入清单（该行由代理手工加，见下方遗留） |
| 测试 | `tests/test_reddit_auth_card.py`（10 条，fix round 1 后 17 条） | 见下 |

D-190 四件套的注释也顺手改准了一句：`plan_capability_checks` 的入参是 produce 开关，采集/下载期能力（telegram、reddit_auth）**无处可映射 = 不阻断，只报**——这条原本会被下一个人误读成「漏映射」。

## 测试实际覆盖（比简报草稿强，代理自主补的）

- 矩阵 off/ok 两态，且 `off` 必须带 `install_hint`（只说「没配」不给出路 = 把人留在原地）
- 四件套两条腿分别断言：`reddit_auth` 进矩阵 **且** 出现在缓存 `GET /api/deps` 响应里；`LABELS` 有显示名 **且** 在 `rows` 渲染清单里（少任一条 = 用户看不见）
- `_diff_degradation` 三态：从未配过不刷屏、首次建基线不告警、配好又掉了必须报
- 端点默认**禁止联网**（把 `ensure_reddit_token` 换成「一调就 AssertionError」的桩，证明渲染一次设置页不会打 Reddit）
- `probe=true` 才真取；取 token 失败可读不退 500
- **单作者守卫两条**：`pipeline_reddit_client_secret` 不得出现在 router 源码里（否则判据被数了两遍）；`_check_reddit_auth` 必须走共享 helper（monkeypatch helper 后卡片状态跟着变）

## controller 门禁（退出码全部单独取）

| 命令 | 结果 |
|---|---|
| `uv run ruff check backend tests` | `RUFF_EXIT=0`，All checks passed |
| `uv run pytest tests/test_reddit_auth_card.py tests/test_pipeline_governance.py tests/test_preflight.py tests/test_local_models.py -q` | `PYTEST_EXIT=0`，**166 passed in 51.27s** |
| 全量 `uv run pytest -q` | 后台跑，结果见 `progress.md` 下一节（基线 504） |
| `cd frontend && npx tsc --noEmit` | 同上 |
| `npx vitest run` | 同上 |

## 遗留（提交前不隐藏）

1. ~~`docs/API_INVENTORY.md` 那一行是手工加的~~ **已由 controller 用真实生成器复核**：`uv run python scripts/api_inventory.py` → `INV_EXIT=0`、`wrote 235 operations`，重生成后 `git diff docs/API_INVENTORY.md` 仍是**同一处 1 行新增**（`GET /api/pipeline/reddit-auth/status`，插在 `publish/status` 与 `reddit-cookie/export` 之间），与代理手写的字节一致。也就是说手写这次碰巧对，但结论只能来自真跑过的生成器，不能来自「看起来一样」。
2. 端点的 `except Exception` 把取 token 失败降级成 `hint` 文案：判据上可接受（「我问过并且失败」≠「我没问」），但失败原因若含敏感串会被回显给前端——`ensure_reddit_token` 抛的是 `Reddit OAuth 换取 token 失败 (HTTP 401)` 一类，不含 secret，实测样本见测试桩。
3. 本片**不修 403**：凭证仍需用户去 `reddit.com/prefs/apps` 建 script 应用。Task 5 才闭合。
---

# Fix round 1（评审 Needs fixes：4 Important + 6 Minor）

评审结论落在 `b6142e9` 的四处缺陷上，全部按「先看它红、再修到绿」处理。工作树里另一条任务未提交的版本号（`backend/config.py`、`pyproject.toml`、`package.json`、`frontend/package.json`、`electron/package.json`、`uv.lock`）**一律未动、未 staged**；本次提交只含 5 个文件。

测试数更正（M1）：上方表格「11 条」是错的，`b6142e9` 的 `tests/test_reddit_auth_card.py` 是 **10 条**（defs 在 37/46/52/76/104/115/126/138/162/173 行）。实测证据：`uv run pytest tests/test_reddit_auth_card.py -q` 在 HEAD 上 `EXIT=0`、`10 passed`（/tmp/base_card.log）。本 fix round 后为 **17 条**（+7）。

## I1 — `configured` 判据的第二作者移到采集侧，收成真单作者

改了什么：`deps.reddit_credentials_configured()` 现在接受**可选**的 `client_id/client_secret`（缺省仍读 settings 两个字段），`bool(strip(x) and strip(y))` 这一行是全仓唯一判据；`collectors/reddit.py::ensure_reddit_token` 改为把已读到的值递给它，删掉自己那行原始 `and` 判据（collector→infrastructure 是既有方向，同 `_system_proxy`）。守卫加两条腿：文本腿扩到 `reddit.py`（必须出现 helper 名 + 原始判据不得回来），行为腿两条（见 RED）。docstring 的「唯一作者」现在名副其实——三个消费者：矩阵条目、状态端点、采集侧。

RED（`NO_PROXY=127.0.0.1,localhost uv run pytest tests/test_reddit_auth_card.py -q > /tmp/red1.log 2>&1; echo EXIT=$?` → `EXIT=1`，7 failed/10 passed）：

- `test_collector_agrees_with_the_judgment_on_whitespace_only_creds`：`AssertionError: assert 't-fresh' is None`（red1.log:255）。空格的 id/secret 在原实现里是**真值**，采集侧照发 OAuth 并被桩判成成功——而矩阵同一时刻报 off。这就是「两边各数一遍」的可观测分歧本身，不是断言写得苛刻。
- `test_collector_asks_the_judgment_not_its_own_truthiness`：`assert 't-fresh' is None`（red1.log:272）。把 helper 换成恒 False，采集侧完全不理会——证明它没在问 helper。抄一份 strip 版判据也照样红（抄的那份不认识 helper 的脸色）。
- `test_configured_judgment_has_a_single_author`（ broaden 后）：`AssertionError: 采集侧没问 helper，自己数了一遍`（red1.log:234）。

GREEN：`17 passed`（/tmp/green_card2.log，`EXIT=0`）。中间态也记一笔：第一轮修完后这条仍红，因为我在 `reddit.py` docstring 里**逐字抄了**被禁的表达式，文本腿踩了自己的注释红——文本腿既能被 prose 满足也能被 prose 踩红，所以 docstring 改成不复述原句，判据的牙齿交给行为腿（这正是 I4 的教训）。

## I2 — `probe=true` 不许答陈旧缓存

改了什么：`reddit_auth_status` 在 probe 分支先 `invalidate_reddit_token()` 再 `ensure_reddit_token()`。**采集主路径的缓存语义一字未动**（只是把一次失效提前到 probe，与 401 后的既有失效同类），所以没有触发「必须改 reddit.py 缓存策略就停手」那条红线。测试不再整体替换 `ensure_reddit_token`，而是走真实 `_token_holder` + 桩掉 `reddit.httpx`/`_system_proxy` 的网络边界（离线、确定、记录请求次数），并加 autouse 的 `_isolated_token_cache` 防模块缓存跨测试泄漏。

RED（同一轮 /tmp/red1.log）：

- `test_probe_true_refetches_after_credentials_were_edited`：`AssertionError: probe=true 没发过取 token 请求——它回答的是缓存，不是凭证 / assert []`（red1.log:23）。预置陈旧 token + 桩给 401：原实现命中 `_token_holder` 直接返回，`token_ok` 报 True——用户改完凭证来验，得到的是改动前那次成功的复读。
- `test_probe_true_exchanges_a_fresh_token_when_cache_is_warm`：`assert 0 == 1`（red1.log:89）。缓存热着时 OAuth 端点一次都没被打，probe 退化成「我上次成功过」。

GREEN：两条都过，且 `_token_holder` 被换成新 token（17 passed）。

## I3 — 保存凭证后刷新能力矩阵 + 注释写真

改了什么：`routers/config.py::update_config` 在 overrides 触及 `pipeline_reddit_client_*` 时 `await refresh_dependencies()`（纯配置读，无需探测；失败只 `logger.warning`，不影响已落盘配置），并补 `import logging` + 模块 logger。`pipeline_ops` 的 docstring 改写：原文「设置页每次渲染都打这里」被 grep 证伪（`grep -rn reddit-auth frontend/src` 为空，本次实测 EXIT=1），现在写明**目前没有前端调用方**，它是给用户/脚本手动核验的入口，「默认不联网」是为它被接进渲染路径预留的。

RED：`test_saving_credentials_refreshes_the_cached_matrix`：`AssertionError: 保存后矩阵还是 off——不重测就不算数 / assert 'off' == 'ok'`（red1.log:306）。真流程：启动预热建缓存（off）→ `PATCH /api/config` 写入 client id/secret → `GET /api/deps`。原实现保存后没有任何刷新触发点，主流程（读提示→填字段→保存）结束时芯片仍停在 off。

GREEN：过。中间态记一笔——这条第一次修完仍红，原因是**测试隔离**而非产品码：`monkeypatch.setattr(settings, ...)` 的 undo 会把原值以**实例属性**写回 `_EffectiveSettings` 代理，之后 `__getattr__` 不再回落 runtime.yaml，读穿被永久屏蔽。证伪过程：单跑该条 `1 passed`（/tmp/probe1.log）；先跑 `test_reddit_auth_card_ok_when_configured` 再跑它即 `FAILED`（/tmp/probe2.log）；`vars(settings)` 直接看到 `after undo: {'pipeline_reddit_client_id': ''}`。修法是在这条测试里先清残留、finally 里再清（测试内注释写明）。这是个跨文件的生产性隐患，本 fix round 不扩范围去改 `backend/config.py` 的代理语义，留作独立一条：任何依赖 runtime.yaml 读穿的测试都可能被同文件的 monkeypatch 顺序影响。

## I4 — 单作者守卫加行为腿（文本腿正腿可被 prose 满足）

改了什么：新增 `test_status_endpoint_configured_comes_from_the_live_judgment`——`monkeypatch.setattr(deps, "reddit_credentials_configured", lambda *a: True)` + 空设置 → GET 端点必须 `configured is True`。它同时对「读缓存矩阵」这种回归形状有效（那种写法既无字段名字面量，也无那次 import）。

RED 证据用成对变异取（对 shipped 码它是绿的，牙齿得量出来）：把端点改成 `configured = (_cached() or {}).get("reddit_auth", {}).get("status") == "ok"`，**保留** helper 的 import 与 docstring 提及（即正腿被 prose 满足）：
`NO_PROXY=... uv run pytest tests/test_reddit_auth_card.py::test_status_endpoint_configured_comes_from_the_live_judgment tests/test_reddit_auth_card.py::test_configured_judgment_has_a_single_author -q > /tmp/mutA.log 2>&1; echo EXIT=$?` → `EXIT=1`、`1 failed, 1 passed`：新行为腿红、旧文本腿全绿。变异已撤销（`grep -n MUT-A` 无残留）。

## Minor（M1–M6）

- **M1**：报告「11 条」→「10 条」，并给出 HEAD 上 `10 passed` 的实测证据（见本节开头）。
- **M2**：`_check_reddit_auth()` 的 ok detail 从「签名直链兜底已启用」改为「已配置（可用 reddit-auth/status?probe=true 验证）」——配置读不替可用性代言，这也顺手闭合了上方「遗留 2」的前半段担忧。
- **M3**：probe 失败的 `hint` 不再回显 `str(exc)`，改报 `exc.__class__.__name__` + 固定出路文案，完整原因进 `logger.info`（同 `_verify_reddit_channel` 的先例）。RED：`test_status_endpoint_probe_failure_is_readable_not_500` 加了一条 sentinel——`assert 'client_id' in '取 token 失败：Reddit OAuth 换取 token 失败 (HTTP 401)——client_secret=do-not-echo-me'`（red1.log:168），原实现把异常文本整个搬到前端可见字段；GREEN 后文案定宽由端点决定。
- **M4**：`deps.py` 里 `_check_reddit_auth` 与 D-190 注释块之间的三连空行收成两条（ruff 选中规则不含 E303，门禁对此沉默）。
- **M5**：`_forbid_network` 不再靠桩里 `raise AssertionError`（会被 `pipeline_ops` 的 `except Exception` 咽成 `token_ok=false`，真正的保护一直是 `token_ok is None`），改成返回调用记录，两个默认不联网的测试都断言 `calls == []`。说法与机制对齐。
- **M6**：保留手搭字典那条（它是 `_diff_degradation` 的唯一覆盖），新增 `test_degradation_alert_couples_to_the_real_card`——prev/curr 由真实 `_check_reddit_auth()` 构造。成对变异：把 ok 条目的 `status` 改成 `"ready"` → `1 failed, 1 passed`（/tmp/mutB.log）：手搭那份照样绿，新耦合腿红（`assert False`）。变异已撤销。

## 门禁（退出码单独取）

| 命令 | 结果 |
|---|---|
| `uv run pytest tests/test_reddit_auth_card.py -q`（HEAD 基线核对 M1） | `EXIT=0`，10 passed |
| `NO_PROXY=127.0.0.1,localhost uv run pytest tests/test_reddit_auth_card.py -q`（RED） | `EXIT=1`，7 failed / 10 passed |
| 同上（GREEN） | `EXIT=0`，17 passed |
| `uv run ruff check backend tests` | `RUFF_EXIT=0`，All checks passed |
| `NO_PROXY=... uv run pytest tests/test_reddit_auth_card.py tests/test_pipeline_governance.py tests/test_preflight.py tests/test_download_resilience.py tests/test_health.py -q` | `EXIT=0`，172 passed（含 `ensure_reddit_token` 的采集侧覆盖 test_download_resilience，以及唯一 PATCH /api/config 的 test_health） |
| `NO_PROXY=127.0.0.1,localhost uv run pytest -q`（全量） | `FULL_EXIT=0`，**521 passed in 233.35s** |

全量基线 514 → 521，差 7 = 本次新增的 7 条测试，无其他漂移。未跑 `scripts/verify.sh` / `release-check.sh`（属于被暂停的发版任务）；前端未改动，故 tsc/vitest 不在本轮范围。

环境注记：工作树里那份未提交的 0.33.0 版本号让每次 `uv run` 都重新构建并安装本包（日志里 `Built hertz @ file:///Users/young/Code/Hertz` / `Uninstalled 1 package`），门禁结论不受影响但耗时略增；按要求没碰它。

## 文件

- `backend/infrastructure/deps.py`（I1 helper 可选入参 + 三个消费者的 docstring、M2 文案、M4 空行）
- `backend/pipeline/collectors/reddit.py`（I1 采集侧消费 helper）
- `backend/routers/pipeline_ops.py`（I2 probe 先失效、I3 docstring 写真、M3 hint 只报类型名）
- `backend/routers/config.py`（I3 保存凭证后刷新 deps 缓存 + logger）
- `tests/test_reddit_auth_card.py`（10 → 17 条：新增 I1×2、I2×2、I3×1、I4×1、M6×1；改既有 M3×1、M5×2；文本守卫 broaden 到 reddit.py；autouse `_isolated_token_cache` + `_stub_oauth` 支撑件）

评审「遗留 2」里那条「敏感串回显」的担忧，本轮由 M3 收成有界文案；403 本身仍归 Task 5。
