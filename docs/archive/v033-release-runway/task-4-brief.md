### Task 4: v0.33.0 发版收口（版本五处 + 文档 + 产物门禁；**停在打 tag 前**）

**Files:**
- Modify: `backend/config.py:20`、`package.json`、`frontend/package.json`、`electron/package.json`、`pyproject.toml`
- Modify: `CHANGELOG.md`、`docs/ROADMAP.md`（在飞 → 已交付）、`docs/DECISIONS.md`（D-206 发布记录）
- Test: `./scripts/verify.sh` + `./scripts/release-check.sh`（产物级）

**Interfaces:**
- Consumes: Task 1–3 全绿后的 main；`scripts/release-check.sh`（源码门禁 → 重建固化包 → 产物门禁，任一非零即「禁止打 tag」）
- Produces: 一个可打 tag 的发布提交 + 文档一致；tag/push 留给人决定

- [ ] **Step 1: 版本号五处一起动（D-185 的教训：漏一处就是第二个真相源）**

```bash
perl -pi -e 's/^APP_VERSION = "0\.30\.1"/APP_VERSION = "0.33.0"/' backend/config.py
perl -pi -e 's/"version": "0\.30\.1"/"version": "0.33.0"/' package.json frontend/package.json electron/package.json
perl -pi -e 's/^version = "0\.30\.1"/version = "0.33.0"/' pyproject.toml
grep -rn "0\.30\.1" backend/config.py package.json frontend/package.json electron/package.json pyproject.toml | wc -l | tr -d ' '
```
Expected: 最后一步打出 `0`（五处都不再是 0.30.1）。

- [ ] **Step 2: CHANGELOG 新增 [v0.33.0] 段**

内容按事实列五组（每条一句，别写空话）：v0.32 质量片 S1–S6、S4.1 设置页保存回归（自 v0.20 起不落盘）、v0.33 空壳条目治理（判据/隔离/体检/回填）、monoline 融合域入包、代理旁路收口。**同时保留两条如实遗留**：141MB 冷启动首下未实测、真视频 403 的签名直链兜底需用户注册 Reddit 应用后才闭合。

- [ ] **Step 3: ROADMAP 把「在飞」改写成「已交付 v0.33.0」**

在 `## 已交付` 末尾加一行 v0.33（含实测数字：pytest 495→本次增量、vitest 50、discovered 4703→2666、failed 181→27）；删除 `## 在飞` 里已发布的三条，只保留未闭合的两条（首下实测、Reddit 凭证）。

- [ ] **Step 4: 源码门禁**

Run: `./scripts/verify.sh > /tmp/gate_v033.log 2>&1; echo GATE_EXIT=$?`
Expected: `GATE_EXIT=0` 且日志尾部 `ALL GATES PASSED`。任一阶段红 → 按 D-202 约定：不修好不继续，且**禁止打 tag**。

- [ ] **Step 5: 产物级门禁（重建固化包 + 装得上才算数）**

Run: `./scripts/release-check.sh > /tmp/rc_v033.log 2>&1; echo RC_EXIT=$?`
Expected: `RC_EXIT=0` 且尾部 `RELEASE_CHECK: PASS`。重点核对产物回读版本 == `0.33.0`、新库 head 与仓库一致、转写契约 200/502、无进程风暴、`scheduled job 'integrity'` 出现在固化后端日志里。
磁盘前提：本机余量 7–12 GiB，构建前先 `df -h .`；不足则停手报告，不清用户文件腾地方。

- [ ] **Step 6: 网络允许时补一次冷启动首下（不阻塞发版）**

Run: `scripts/sim-newmachine.sh --with-download > /tmp/dl_v033.log 2>&1; echo DL_EXIT=$?`
Expected: 打印「首下耗时/落位大小/`~/.cache` 未增长」。若代理中断（`ConnectError` 或 `000`）→ 记为未实测，写进 D-206 的遗留段，不改判据。

- [ ] **Step 7: 提交，然后**停手

```bash
git add -A backend/config.py package.json frontend/package.json electron/package.json pyproject.toml CHANGELOG.md docs/
git commit -F - <<'MSG'
chore(release): 版本号五处对齐 0.33.0 + CHANGELOG/ROADMAP 收口

main 上已攒 27 个提交（v0.32 质量片、v0.33 空壳治理、monoline 融合域与入包），
版本标记还停在 0.30.1。五处一起动（D-185），ROADMAP 在飞段改记已交付，
未闭合的两条如实保留：141MB 冷启动首下实测、Reddit 凭证到位后的签名直链闭合。
MSG
```
**不要 push、不要 `git tag`**：发布动作需要用户单独授权（`git log origin/main..HEAD` 报告待推提交数，等指令）。

---

