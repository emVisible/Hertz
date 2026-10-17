# Task 2 report — 代理旁路收进单一作者（8 处 → 1 处）+ 仓库级守卫

Commit: `226bd85` refactor(net): 代理旁路收成单一作者——8 处各自实现改调 infrastructure/net (branch main, not pushed, not tagged)

## Scope (per rulings A/B, over the brief's 7)

8 production sites converged on `backend/infrastructure/net.py`:
site 0 owner `net.py` (extended), 4 hand-rolled bypass decisions, 3 hand-rolled proxy discoveries (`backend/infrastructure/hf.py` added per Ruling A).

## Changes per site

**0. `backend/infrastructure/net.py`** — Ruling B two layers added:
- `system_proxies() -> dict[str, str]`: single discovery author, returns the full table (`dict(urllib.request.getproxies())`), best-effort `{}` on any failure. Per Ruling C it is invoked as `urllib.request.getproxies()` — module attribute lookup at call time (import inside the function), never `from urllib.request import getproxies`, so attribute-based monkeypatches keep landing.
- `system_proxy() -> str | None`: thin derivation (`https` or `http` or None).
- `client_kwargs()` / `is_loopback_url()` untouched — still the only decision point.

**1. `backend/ai/providers/openai_compat.py:50-58`** — client now `httpx.AsyncClient(base_url=base, headers=..., **client_kwargs(base, timeout=httpx.Timeout(30.0, read=180.0)))` with `base = base_url.rstrip("/")` used as both the client base_url and the target (same value the client actually talks to). `base_url`/`headers` stayed explicit; timeout folded into `client_kwargs`. Local `from backend.infrastructure.net import client_kwargs` (brief's shape). Old comment ("绝不读 HTTP_PROXY/HTTPS_PROXY 环境变量…远端 API 走直连") described the pre-change semantics and was replaced by behaviour-worded comment; no banned word (`trust_env`/`getproxies`) appears in any new comment.

**2. `backend/ai/providers/comfyui.py:28-32`** — target is `self.base_url` (set on the line above, already rstripped): `**client_kwargs(self.base_url, timeout=httpx.Timeout(30.0, read=120.0))`. Same comment rewrite rationale.

**3. `backend/monoline/hf.py:229-233`** — per-request sidecar client: `**client_kwargs(sidecar_url.rstrip("/"), timeout=httpx.Timeout(self.timeout, connect=5))`; the target is exactly the URL the request hits (`f"{sidecar_url.rstrip('/')}/render"`). Import placed **inside the method** next to the local `import httpx`, preserving this module's no-backend-module-level-imports rule.

**4. `backend/pipeline/producers/asr.py:344-352`** — xinference STT client: `**client_kwargs(settings.xinference_stt_base_url, timeout=120.0)` (base, not the /audio/transcriptions path, per task ruling). Import inside `transcribe_with_xinference` next to its local `import httpx`.

**5. `backend/pipeline/collectors/reddit.py:103-114`** — `_system_proxy()` kept as name (imported by `backend/routers/pipeline_ops.py:61,67`, called at reddit.py:151,212) but body is now `from backend.infrastructure.net import system_proxy` + `return system_proxy()`. Trap handled: module-level `import urllib.request` (line 15) deleted (was the only consumer); `import urllib.parse` (line 14) kept — still used at line 145+.

**6. `backend/pipeline/reddit_media.py:79-86`** — inline try/`getproxies` block deleted, now `from backend.infrastructure.net import system_proxy` + `proxy = system_proxy()` (best-effort semantics preserved inside net).

**7. `backend/infrastructure/hf.py:94-101`** — `_reason()` diagnostic now `prox = system_proxies()` inside `try/except Exception: prox = {}` (Ruling B: it needs the full dict, not one URL; the "探测失败不该盖住真实原因" rationale kept verbatim in the except comment).

**Tests** — `tests/test_net_proxy_bypass.py` gained the brief's two tests plus one extra (`test_system_proxies_is_the_full_table_author`) pinning Ruling B's dict layer and its https-precedence derivation. New `tests/test_proxy_authority.py` guard: scans every `backend/**/*.py` except `net.py` for `trust_env` and `getproxies`, plus the anti-idle assertion requiring `{"client_kwargs", "is_loopback_url", "system_proxy", "system_proxies"} <= names` (Ruling B extension of the brief's three).

## TDD evidence

**RED** (guard written first; `/tmp/proxy_guard_red.log`, EXIT=1):
- `trust_env 又被自己判了一次: ['backend/ai/providers/comfyui.py', 'backend/ai/providers/openai_compat.py', 'backend/monoline/hf.py', 'backend/pipeline/producers/asr.py']`
- `代理发现出现第二个作者: ['backend/infrastructure/hf.py', 'backend/pipeline/collectors/reddit.py', 'backend/pipeline/reddit_media.py']`
- owner-exists failure naming the two missing functions (`system_proxy`, `system_proxies`)

That offender list (7 + owner gap) is the 收口清单; after the convergence run the guard is empty.

**GREEN** (after conversion): `uv run pytest tests/test_proxy_authority.py tests/test_net_proxy_bypass.py -q` → EXIT=0 (guard 3 passed, bypass 5 passed incl. the two pinned semantics; 8 = 3 + 5).

## Gate commands, separately captured exit codes

| Command | Output | Exit |
|---|---|---|
| `uv run pytest tests/test_proxy_authority.py -q` (pre-change, RED) | /tmp/proxy_guard_red.log | **1** (expected — this step is red by design) |
| `uv run pytest tests/test_proxy_authority.py tests/test_net_proxy_bypass.py -q` (GREEN) | /tmp/proxy_guard_green.log | **0** |
| `uv run pytest tests/test_ai_registry.py tests/test_ai_router.py -q` | /tmp/ai_tests.log | **0** |
| `uv run pytest tests/test_local_models.py -q` (Ruling C check) | /tmp/local_models.log | **0** |
| `uv run ruff check backend tests` | /tmp/ruff.log | **0** |
| `uv run pytest -q` (full suite) | /tmp/full_suite.log — `502 passed, 6 warnings in 877.12s` | **0** |
| Step 7 Ollama probe (`uv run python -c ...`, see below) | /tmp/ollama_probe.log | **0** |

## Live Ollama probe (Step 7)

`OpenAICompatProvider(api_key='', base_url='http://localhost:11434/v1', model='batiai/gemma4-e4b:q4').list_models()` → `OLLAMA_EXIT=0`, printed `models: ['batiai/gemma4-e4b:q4']`. No `NO_PROXY` re-run was needed: everything went green first pass, and the loopback probe succeeding straight through is itself the point of the change (client built via `client_kwargs` → loopback → direct connect, Clash environment notwithstanding).

## Files changed (10, all in commit 226bd85)

`backend/infrastructure/net.py`, `backend/infrastructure/hf.py`, `backend/ai/providers/openai_compat.py`, `backend/ai/providers/comfyui.py`, `backend/monoline/hf.py`, `backend/pipeline/collectors/reddit.py`, `backend/pipeline/reddit_media.py`, `backend/pipeline/producers/asr.py`, `tests/test_net_proxy_bypass.py`, `tests/test_proxy_authority.py` (new).

## Self-review findings (git diff read-through)

- Post-change grep: `trust_env|getproxies` in `backend/` now appears **only** in `net.py` (the exempt owner) — no comment at any of the eight sites carries either word.
- Ruling C verified end-to-end: `tests/test_local_models.py:68` patches `urllib.request.getproxies` by attribute and still passes, exercising the hf.py → `system_proxies()` → attribute-lookup chain.
- Checked no test patches the removed aliases (`reddit.urllib...`) — none exists.
- `_hint_for` in openai_compat.py ("如开着 Clash/代理，确认 localhost 已走直连…") only fires for local URLs, where direct-connect still holds — left as-is, still truthful.
- reddit.py `_system_proxy()` signature and name preserved for `pipeline_ops.py` imports; docstring says what remains true.
- Intentional behaviour change NOT safety-pinned anywhere: no call site passes an explicit bypass kwarg to force the old semantics; `test_remote_provider_still_follows_env_proxy` pins the new ones; change is stated in the commit message.

## Concerns

1. **Intentional, shipped behaviour change**: providers pointed at non-loopback hosts (deepseek/siliconflow via openai_compat, and a remote ComfyUI) now follow environment/system proxy instead of forcing it off. That's the ruling, but it does mean a user with a broken system proxy who previously reached a remote API directly will now route through it. Mitigated by design (that's what "follow the environment" means) and pinned by the new test.
2. Local `from backend.infrastructure.net import client_kwargs` inside `__init__`/methods follows the brief's shape; slightly unidiomatic versus module-level imports, chosen deliberately for monoline's module-import rule and kept uniform elsewhere. Harmless.
3. The `try/except Exception: prox = {}` in hf.py `_reason()` is now double-defensive (system_proxies itself returns `{}` on failure) — kept because Ruling B mandates it and it additionally covers import-time surprises. No cost.
4. Full suite runtime ~15 min (network-heavy DB/media tests); exit code captured separately, 502/502.
5. No push, no tag (per constraints).

---

# Fix round 1 (on top of `226bd85`) — 守卫改正向棘轮 + 三条 prose/dead-code Minor

Scoped review approved the shipped convergence and left 1 Important + 3 Minor. This section closes those four only; the convergence itself was not re-touched (no site added, no site removed, no semantics changed).

## Important — the ratchet did not discriminate

**Finding**: the guard was purely literal-string (forbidding `trust_env` / `getproxies` outside `net.py`), and `tests/test_net_proxy_bypass.py:61-64` called `client_kwargs` directly with two literals duplicating `:25-26`. Deleting `**client_kwargs(...)` from `openai_compat.py` — the exact reversion that brings back the Clash 502 — left both files green.

**(a) Behaviour test now reaches a real call site.** `test_remote_provider_still_follows_env_proxy` (self-referential literals) replaced by two async tests that construct real providers and assert on the constructed client's flag:
- `test_openai_compat_client_carries_the_owner_decision` — loopback `http://127.0.0.1:11434/v1` → `_client.trust_env is False`; non-loopback `https://api.siliconflow.cn/v1` → `is True`.
- `test_comfyui_client_carries_the_owner_decision` — `http://127.0.0.1:8188` → `False`; `https://comfyui.example.com:8188` → `True` (ComfyUI stores `self.base_url` and builds its client without `base_url=`, so the target is that attribute).
- Disposal follows the house pattern already in `tests/test_pipeline_governance.py:1655` (`await provider...aclose()`), here via each provider's own `aclose()`, in a `finally`. Verified warning-free: `uv run pytest tests/test_net_proxy_bypass.py tests/test_proxy_authority.py -q -W error::ResourceWarning` → EXIT=**0**, 10 passed.

**(b) Guard now fails on reversion.** New `test_converged_sites_still_call_the_owner` in `tests/test_proxy_authority.py`: an explicit `CONVERGED` list, each path required to contain `client_kwargs` **or** `system_prox`. Plain substring membership, no AST. The two pre-existing consumers (`backend/pipeline/download.py:118,122`, `backend/download/engine.py:28,171`) are in the list — both already reference `client_kwargs` today, so the ratchet locks them too.
- **Needle deviation (recorded)**: the ruling suggested `system_proxy` "(that needle also matches `system_proxies`)" — it does not: `system_prox` + `y` vs `system_prox` + `ies`, so `infrastructure/hf.py` (which imports `system_proxies`) would have failed a correct file. Used `system_prox`, which matches both spellings; intent (positive ratchet by literal membership) unchanged.

### Mutation evidence (the finding was "a gate that passes on both good and bad code")

Mutation applied to `backend/ai/providers/openai_compat.py`: the `**client_kwargs(base, ...)` spread, its comment block and its (now-unused) local import deleted, leaving a plain `httpx.AsyncClient(base_url=..., headers=..., timeout=...)` — i.e. the reversion the reviewer named, with no banned literal reintroduced.

| Step | Command | Output | Exit |
|---|---|---|---|
| Old (committed) guard on mutated code | `git show 226bd85:tests/test_proxy_authority.py > tests/test_zz_old_guard_tmp.py && uv run pytest tests/test_zz_old_guard_tmp.py -q` (temp file deleted right after) | `/tmp/fix_r1_oldguard_on_mutated.log` — `3 passed` | **0** ← the hole, reproduced |
| New guard on mutated code | `uv run pytest tests/test_proxy_authority.py -q` | `/tmp/fix_r1_newguard_RED.log` — `FAILED ...::test_converged_sites_still_call_the_owner`; `AssertionError: 这些收口点不再调用唯一作者（收口被回退？）: ['backend/ai/providers/openai_compat.py']`; `1 failed, 3 passed` | **1** |
| New behaviour test on mutated code | `uv run pytest tests/test_net_proxy_bypass.py -q` | `/tmp/fix_r1_bypass_RED.log` — `FAILED ...::test_openai_compat_client_carries_the_owner_decision`; `> assert local._client.trust_env is False` / `E assert True is False`; `1 failed, 5 passed` | **1** |
| Restore + re-run both files | `git checkout -- backend/ai/providers/openai_compat.py` then `uv run pytest tests/test_proxy_authority.py tests/test_net_proxy_bypass.py -q` | `/tmp/fix_r1_guard_GREEN.log` — `10 passed` | **0** |

After the restore, `git status --short` showed only `M tests/test_net_proxy_bypass.py`, `M tests/test_proxy_authority.py` (then the Minor files) — the mutation was not committed and is not in the tree.

## Minor 1 — `openai_compat.py` comment over-claimed

`# 远端主机则正常跟随环境/系统代理…` → `# 远端主机则照常跟随环境变量里的代理设置（v0.33 收口后有意的行为变化）。` httpx's flag reads env vars only (`net.py:5-7`: it does not read macOS's system-proxy exception table), so the "系统" claim was false. Contains neither banned literal — states behaviour instead. Covered by `uv run pytest tests/test_proxy_authority.py -q` (EXIT=**0**, i.e. the two literal bans still hold after the comment edit).

## Minor 2 — dead-by-design wrapper in `infrastructure/hf.py`

`_reason()` no longer wraps the call: `try: prox = system_proxies() / except Exception: prox = {}` collapsed to a direct `system_proxies()` call plus a two-line comment pointing at where the swallowing actually lives. The wrapper could only fire on an import-path mistake, i.e. it swallowed programmer error. **Supersedes Concern 3 above.** Rationale "探测失败不该盖住真实原因" moved into `net.system_proxies()`'s docstring (Minor 3 edit), where the `except` that produces `{}` actually is. Covered by `uv run pytest tests/test_local_models.py -q` in the targeted run below (that test exercises `hf._reason` → `system_proxies` through the attribute-patched `getproxies`) → EXIT=**0**.

## Minor 3 — `system_proxies()` docstring claimed too small a role

Docstring said "这是诊断辅助". Its derivative is functionally load-bearing for egress: `collectors/reddit.py:148,214` and `reddit_media.py:88` pass `system_proxy()` as the httpx client's `proxy=` argument, so a discovery failure there silently degrades to direct-connect. Rewrote the paragraph to name the real dependents (Reddit 采集 / 签名直链 / infra-hf 诊断) and to state what the swallowed exception actually costs.

## Report prose correction (round 0)

Line 42 said "bypass 6 passed"; `tests/test_net_proxy_bypass.py` at `226bd85` has 5 tests. Fixed to "guard 3 passed, bypass 5 passed … (8 = 3 + 5)" — re-counted from `git show 226bd85:` (guard 3, bypass 5).

## Fix-round gate commands, separately captured exit codes

| Command | Output | Exit |
|---|---|---|
| `uv run ruff check backend tests` (twice: mid-way and after final prose edits) | `/tmp/fix_r1_ruff.log`, `/tmp/fix_r1_ruff_final.log` — `All checks passed!` | **0**, **0** |
| `uv run pytest tests/test_proxy_authority.py tests/test_net_proxy_bypass.py tests/test_local_models.py tests/test_ai_registry.py tests/test_ai_router.py -q` | `/tmp/fix_r1_targeted.log` — `54 passed in 2.21s`, no warnings section | **0** |
| `uv run pytest -q` (full suite) | `/tmp/fix_r1_full_suite.log` — `504 passed, 6 warnings in 479.54s` | **0** |

Suite count: **502 → 504** (+2 = guard 3→4, bypass 5→6 after replacing 1 literal-only test with 2 real-client tests). No `NO_PROXY` re-run needed: nothing failed, first pass straight through.

## Files changed (fix round 1, 5)

`tests/test_net_proxy_bypass.py`, `tests/test_proxy_authority.py`, `backend/ai/providers/openai_compat.py` (comment only), `backend/infrastructure/hf.py`, `backend/infrastructure/net.py`. Plus this report (git-ignored, not part of the commit).

## Round-0 lines now stale (annotated, not rewritten)

Line 71 names `test_remote_provider_still_follows_env_proxy` — replaced by the two real-client tests above. Line 75's "environment/system proxy" — the shipped semantics are environment-variable-only (Minor 1). Concern 3 — removed by Minor 2. `backend/infrastructure/net.py:38` (`client_kwargs`) still reads "跟随环境变量/系统代理"; same over-claim, but it predates this task and is outside the four findings, so it was left alone.

