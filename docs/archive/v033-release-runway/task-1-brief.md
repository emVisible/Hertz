### Task 1: 代修并发工作流欠的门禁红（4 lint + 1 失败测试）

**Files:**
- Modify: `backend/monoline/runner.py:18-19`（两条未使用的别名 import）、`backend/monoline/runner.py:580`（`suggest` 的函数级 import）
- Modify: `tests/test_monoline_llm.py:134,151`（`import runner as R` 触发 N812）
- Test: 复用现有 `tests/test_monoline_llm.py`（不新增测试；本任务的「测试」就是它变绿）

**Interfaces:**
- Consumes: `backend/monoline/llm_plan.py:290 async def suggest(ai, beat: str, scene: dict, *, model: str, **kw) -> dict`
- Produces: `backend.monoline.runner.suggest`（模块级属性）——测试靠 `monkeypatch.setattr(R, "suggest", ...)` 打桩，这个缝必须存在

- [ ] **Step 1: 先确认别名是真的没用，而不是被漏看的引用**

Run:
```bash
grep -n "_llm_plan\|_tidy_slots" backend/monoline/runner.py
```
Expected: 只有 import 那两行命中 → 确认可删。若还有别处命中，则改那处引用为正式名（不要删 import）。

- [ ] **Step 2: 跑失败测试，确认失败原因就是这个缝不存在**

Run: `uv run pytest tests/test_monoline_llm.py::test_breakout_upgrades_mid_of_long_run -q > /tmp/mono1.log 2>&1; echo EXIT=$?`
Expected: `AttributeError: module 'backend.monoline.runner' has no attribute 'suggest'`（不是断言失败）

- [ ] **Step 3: 把 `suggest` 提升为模块级 import（恢复 monkeypatch 缝），删掉两条死别名**

`backend/monoline/runner.py` 顶部（替换 18-19 两行）：
```python
from .display_text import tidy_slots  # 若 Step 1 显示仍被使用才保留这一行
from .llm_plan import suggest
```
并把 `runner.py:580` 的函数级 import 删掉（保留 `_clean_slots` 的局部 import 也无妨，但 `suggest` 必须来自模块级，否则测试打不到）：
```python
    from .llm_plan import _clean_slots   # 只留这个
```
理由写在 import 上方一行注释里：`# 模块级导入是测试的打桩位（tests/test_monoline_llm 用 monkeypatch 换 suggest）`。

- [ ] **Step 4: 确认没有循环 import**

Run: `uv run python -c "from backend.monoline import runner; print('ok', hasattr(runner, 'suggest'))"`
Expected: `ok True`（`llm_plan.py` 不 import runner，Step 已核：它只 import 标准库/Path）

- [ ] **Step 5: 修 N812（别名大小写），只动测试文件**

`tests/test_monoline_llm.py` 两处 `from backend.monoline import runner as R` 改成小写别名，并同步该函数体内的两处 `R.` 引用（全文件 `R.` 只有 2 次）：
```python
    from backend.monoline import runner as mono
    ...
    mid = await mono._breakout_long_run(...)
```

- [ ] **Step 6: 跑 lint 与该文件的测试，两者都必须绿且单独取退出码**

```bash
uv run ruff check backend tests > /tmp/ruff1.log 2>&1; echo RUFF_EXIT=$?
uv run pytest tests/test_monoline_llm.py -q > /tmp/mono2.log 2>&1; echo PYTEST_EXIT=$?
```
Expected: 两个都是 0。若 `test_breakout_skips_short_run` 之类相邻测试挂了，说明 `_breakout_long_run` 语义在飞改动里也变了 → 停手报告，不要顺手改业务逻辑。

- [ ] **Step 7: 提交**

```bash
git add backend/monoline/runner.py tests/test_monoline_llm.py
git commit -F - <<'MSG'
fix(monoline): 代修门禁红点——suggest 提升为模块级 import 恢复打桩位

runner 顶部两条别名 import 实际未被使用（F401），而 suggest 只在函数里局部导入，
导致 tests/test_monoline_llm 的 monkeypatch(R, "suggest") 找不到属性、测试以
AttributeError 失败。提升为模块级即恢复测试所依赖的缝；两处 N812 别名改小写。
不改任何业务逻辑。
MSG
```

---

