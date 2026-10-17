# Task 1 报告：代修并发工作流欠的门禁红（4 lint + 1 失败测试）

- 分支：main（未建 worktree/分支，未 push，未 tag）
- 提交：`a2e88fe` fix(monoline): 代修门禁红——suggest 提升为模块级 import 恢复打桩位
- 工作树：提交后 `git status --porcelain | wc -l` = 0（干净）

## 1. 改了什么，为什么

### `backend/monoline/runner.py`

1. 删除顶部两条从未被使用的别名 import（F401 的两个来源）：
   - `from . import llm_plan as _llm_plan`
   - `from .display_text import tidy_slots as _tidy_slots`
2. 新增模块级 `from .llm_plan import suggest`，上方一行注释写明理由
   （`# 模块级导入是测试的打桩位（tests/test_monoline_llm 用 monkeypatch 换 suggest）`）。
   这是本任务的正题：测试用 `monkeypatch.setattr(mono, "suggest", ...)` 打桩，
   缝必须存在于**模块属性**上；原先 `suggest` 只在 `_breakout_long_run` 里局部导入，
   模块上根本没有这个属性，测试以 AttributeError 失败。
3. `_breakout_long_run` 内的函数级 import 由
   `from .llm_plan import _clean_slots, suggest` 收窄为
   `from .llm_plan import _clean_slots`——`suggest` 改走模块级，
   否则局部 import 会遮蔽模块属性、测试仍然打不到。
   同函数 580 行的 `from .display_text import tidy_slots` 原样保留。

**没加 `from .display_text import tidy_slots`（按上游裁定）**：runner.py 里
`tidy_slots` 的唯一用处是 606 行，而它所在函数在 580 行已有同名函数级 import，
模块级那份会被遮蔽、当场再吃一个 F401，门禁依旧红。brief 的 Step 3 本身把这一行
条件化在 Step 1 的 grep 结果上，结果就是「不要」。
（行号按提交后的文件计：模块级 `suggest` 在 21 行，函数级 `_clean_slots` 在 581 行，
`suggest(...)` 调用在 597 行。）

### `tests/test_monoline_llm.py`

134 / 151 两处 `from backend.monoline import runner as R` 改为小写别名 `mono`（消 N812），
并同步函数体内全部 `R` 引用（136 行 monkeypatch 首参、144 行、155 行）。
断言、输入、期望值一字未动。

**业务逻辑改动：0。** `_breakout_long_run` 的 diff 只有一行 import；测试 diff 只有别名。

## 2. RED 证据

### Step 1：确认别名真是死的（不是漏看的引用）

```
$ grep -n "_llm_plan\|_tidy_slots" backend/monoline/runner.py
18:from . import llm_plan as _llm_plan
19:from .display_text import tidy_slots as _tidy_slots
GREP_EXIT=0
```

只有 import 两行命中 → 符合 brief 预期的「可删」分支。
补充全仓核查（排除 git-ignored 的 `.superpowers/`）：
`grep -rn "_llm_plan\|_tidy_slots" --include=*.py --include=*.md --include=*.ts --include=*.js .`
→ **零命中**，删除不影响任何外部引用点。

### Step 2：失败原因确实是缝不存在（不是断言失败）

```
$ uv run pytest tests/test_monoline_llm.py::test_breakout_upgrades_mid_of_long_run -q > /tmp/mono1.log 2>&1; echo EXIT=$?
EXIT=1
```
`/tmp/mono1.log`：
```
    async def test_breakout_upgrades_mid_of_long_run(tmp_path, monkeypatch) -> None:
        from backend.monoline import runner as R

>       monkeypatch.setattr(R, "suggest", _fake_suggest_changed())
E       AttributeError: <module 'backend.monoline.runner' from '/Users/young/Code/Hertz/backend/monoline/runner.py'> has no attribute 'suggest'

tests/test_monoline_llm.py:136: AttributeError
1 failed in 0.28s
```

为什么这是预期失败：错误类型是 `AttributeError`（属性缺失），发生在 monkeypatch 那一行，
而不是后面的 `assert mid == 2`。也就是说测试的**语义**没被质疑，缺的只是可打桩的模块属性；
修法只能是恢复缝，不是改测试。

### 修改前的 lint 现场（自行复现，不依赖口头测量）

从父提交 `HEAD~1` 的 blob 走 `--stdin-filename`（取当前 per-file 配置，不落临时文件、不脏工作树）：
```
$ { git show HEAD~1:backend/monoline/runner.py | uv run ruff check --stdin-filename backend/monoline/runner.py - ; \
    git show HEAD~1:tests/test_monoline_llm.py | uv run ruff check --stdin-filename tests/test_monoline_llm.py - ; } > /tmp/ruff_prefix.log 2>&1; echo RUFF_PREFIX_EXIT=$?
RUFF_PREFIX_EXIT=1
```
输出恰为 4 条：`F401 .llm_plan`（runner.py:18:27）、`F401 .display_text.tidy_slots`（runner.py:19:41）、
`N812 Lowercase runner imported as non-lowercase R`（test_monoline_llm.py:134、151）。与预检测量一致。

## 3. GREEN 证据

### Step 4：无循环 import，缝已建立

```
$ uv run python -c "from backend.monoline import runner; print('ok', hasattr(runner, 'suggest'))" > /tmp/imp.log 2>&1; echo EXIT=$?
EXIT=0
ok True
```
静态侧证：`backend/monoline/llm_plan.py` 的模块级 import 只有
`asyncio / hashlib / json / os / re / time / pathlib.Path` 与 `from .display_text import tidy_slots`，
不含 `runner` → 提升 `suggest` 不构成回环。

### 修后聚焦测试

```
$ uv run pytest tests/test_monoline_llm.py -q > /tmp/mono2.log 2>&1; echo PYTEST_EXIT=$?
PYTEST_EXIT=0        # 13 passed in 0.40s
```
（此前同文件是 `1 failed, 12 passed` → 现在 13 passed，`test_breakout_skips_short_run`
等相邻测试全绿，说明 `_breakout_long_run` 语义未变，无需触发「停手报告」分支。）

最终树再复跑一次：
```
$ uv run pytest tests/test_monoline_llm.py -q > /tmp/mono_final.log 2>&1; echo MONO_PYTEST_EXIT=$?
MONO_PYTEST_EXIT=0   # 13 passed in 0.20s
```

## 4. 门禁命令与退出码（逐条单独取，未通过管道吞码）

| # | 命令 | 单独捕获的退出码 | 关键输出 |
|---|---|---|---|
| 1 | `grep -n "_llm_plan\|_tidy_slots" backend/monoline/runner.py` | `GREP_EXIT=0` | 仅 18/19 两行 |
| 2 | `uv run pytest tests/test_monoline_llm.py::test_breakout_upgrades_mid_of_long_run -q > /tmp/mono1.log 2>&1` | `EXIT=1` | AttributeError（RED） |
| 3 | `uv run python -c "from backend.monoline import runner; print('ok', hasattr(runner, 'suggest'))"` | `EXIT=0` | `ok True` |
| 4 | 修后首轮 `uv run ruff check backend tests > /tmp/ruff1.log 2>&1` | `RUFF_EXIT=1` | 我自己的注释排版触发 I001（见 §5），非既有欠账 |
| 5 | `uv run ruff check --diff backend/monoline/runner.py` | `DIFF_EXIT=0` | isort 无进一步改动 → 格式已是规范形 |
| 6 | `uv run ruff check backend tests > /tmp/ruff2.log 2>&1` | `RUFF_EXIT=0` | All checks passed! |
| 7 | `uv run pytest tests/test_monoline_llm.py -q > /tmp/mono2.log 2>&1` | `PYTEST_EXIT=0` | 13 passed |
| 8 | 提交前终校 `uv run ruff check backend tests > /tmp/ruff_final.log 2>&1` | `RUFF_EXIT=0` | All checks passed! |
| 9 | 提交前终校 `uv run pytest tests/test_monoline_llm.py -q > /tmp/mono_final.log 2>&1` | `MONO_PYTEST_EXIT=0` | 13 passed |
| 10 | 全量 `uv run pytest -q > /tmp/pytest_full2.log 2>&1` | `PYTEST_FULL_EXIT=0` | 496 passed, 6 warnings in 225.74s |
| 11 | 修改前 ruff 复现（§2） | `RUFF_PREFIX_EXIT=1` | 4 条（2×F401 + 2×N812） |

全量套件第一次跑（`/tmp/pytest_full.log`）是在「注释空行」这个纯空白修正**之前**启动的，
为了让证据对应最终提交的树，已把它中止（TaskStop，killed）并在最终树上重跑（表中 #10）。
6 条 warnings 是既有的（`test_packaging_hygiene` 触到 alembic env 的
`SyntaxWarning: invalid escape sequence`），与本任务无关，未新增。
上一提交自述「495 passed / 1 failed（唯一失败是并发 monoline 缺 runner.suggest）」，
现在 496 passed / 0 failed，正好收掉那一颗。

## 5. 自审（读自己的 `git diff`）发现与处置

- **diff 范围**：`2 files changed, 9 insertions(+), 8 deletions(-)`。逐行读，全部落在
  §1 声明的三处语义点（删两条死别名、提升 `suggest`、测试别名小写化）之内，无夹带。
- **踩到并已修**：第一版把注释紧贴 `from .llm_plan import suggest` 写在
  `from .hf ...` 之后，`ruff check`（select 含 `I`）报 I001「Import block is un-sorted」。
  按 ruff 自己的修复形在注释前补一空行，随后 `ruff check --diff` 对该文件输出为空 →
  格式即 isort 的规范答案，不是我手搓的例外。这也说明表 #4 的那个 1 是**我自己引入的**、
  与并发工作流欠的门禁红无关，已在同一提交里抹平。
- **`suggest` 现在是 runner 的模块属性**：除测试外全仓无第二处
  `monkeypatch ... "suggest"`（grep `\"suggest\"` 仅命中 llm_plan 的缓存目录名与本测试 136 行），
  不存在别的模块依赖「runner 不导入 llm_plan」这一旧形态。
- **遮蔽风险已双向检查**：函数内不再局部导入 `suggest`（否则测试打不到）；
  `tidy_slots`/`_clean_slots` 维持函数级（否则会遮蔽/再吃 F401）。两者口径互不冲突。
- **无新增文件、无临时文件残留**：复现修改前 lint 用的是 `--stdin-filename`，没有往仓库里落副本；
  日志都在 `/tmp`。`git add` 只点名两个文件，暂存后 `git status --short` 仅这两行，
  无 `data/runtime.yaml`、无 `.env`、无游离文件。
- **hooks**：`.git/hooks` 只有 `post-checkout` / `post-commit`，无 pre-commit 门禁，
  提交未绕过任何校验，也未使用 `--no-verify`。
- **未 push / 未 tag / 未建分支**，符合本次约束。

## 6. 文件与提交

- 改动文件：`/Users/young/Code/Hertz/backend/monoline/runner.py`、
  `/Users/young/Code/Hertz/tests/test_monoline_llm.py`
- 提交：`a2e88fe` — `fix(monoline): 代修门禁红——suggest 提升为模块级 import 恢复打桩位`
  （heredoc `-F -` 形式，消息内无反引号）
- 提交后工作树干净。

## 7. 遗留给后续任务的观察（不在本任务范围内）

- `runner.py:712` 一带仍有一处函数级 `from .llm_plan import upgrade`。它目前不影响门禁
  （无 lint 报错、无测试依赖 `runner.upgrade` 缝），但和本次「缝要在模块级」的口径不一致；
  若哪天要测 `upgrade` 的调用位，需同样提升。**本次未动**，避免超出「零逻辑改动」边界。
