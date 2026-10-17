# PROJECT.md —— 当前状态

> 这个文件只回答「现在在哪」。**怎么把「怎么来的」交给别处**：变了什么看 `CHANGELOG.md`，为什么看 `docs/decisions/`，怎么干活看 `AGENTS.md`，历史看 `docs/archive/`。
> 更新时机：里程碑完成、架构变更、发版、重大决策、发现重大风险。**不要为每个小改动更新它。**

## 版本

- 当前版本：**0.36.0**（四方一致，由 `tests/test_version_drift.py` 守住）
- 下一版本：**0.37**，仍在 `[Unreleased]`，尚未打 tag
- 恢复点 tag：`pre-docs-shuffle-2026-10-17`（文档治理前）

## 当前阶段

**v0.37 收口**。MD Studio 第三批（Shiki 高亮 / Mermaid / CSS / PDF 导出）、微信·知乎粘贴修复、两处真实缺陷修复（D-231 配置钉子 / D-232 缓存判同）均已落地并通过全量门禁。**文档体系治理已完成并合入 `main`**（见下方"最近变更"）。

活跃分支：`main`。

## 最近变更

| 提交 | 变了什么 |
|---|---|
| `fdee85a`…`1feff84` | **文档体系治理**（6 提交）：活跃文档 6,819 → 1,887 行；历史 5,186 行进 `docs/archive/`（含状态头）；决策改一决策一文件；新增 `AGENTS.md` / `PROJECT.md` / `docs/README.md`；`webui.sh` 归位 `scripts/`；门禁新增**文档链接检查**（第 1 步，9 步制） |
| `5201377` | `data/runtime.yaml` 的陈旧默认值钉子——"日志搬家"从未生效，附 D-231 取证更正 |
| `b1ca205` | 判"内容变没变"改用内容签名（`.size` ≠ 内容），附 D-232 |
| `d390832` | 微信/知乎：`---` 右居中、标题被拆行（富文本编辑器不是浏览器） |
| `cd9c139`…`f1e4bca` | 启动期愈合逐条隔离、日志脱敏、版本号对齐、dev.sh 端口自复活刹车 |

恢复点 tag：`pre-docs-shuffle-2026-10-17`（治理前的 `5201377`）。

## 门禁现状

`bash scripts/verify.sh` 全量 **EXIT=0**，共 **9 步**：文档链接 → ruff → pytest **836** → mdcore tsc → mdcore **441** → 前端 tsc → 前端 **379** → vite build → **18 张排版基线**（0.5% 阈值）。

## 已知风险

| 风险 | 状态 | 依据 |
|---|---|---|
| **Electron 37.10.3 有 36 条真实 CVE**（11 high / 20 moderate） | **未修**，需独立改动面 | `docs/decisions/README.md` 的审计结论；清零需升到 ≥41.10.6 |
| 「打开应用约一分钟后机器卡死」 | **未复现**。当前 dev 栈连续运行 CPU ≈0%、零自发重启。最可能是当时全量 pytest 与 dev 栈 + Postgres 同时在跑——**仍是推测** | D-231 |
| 微信/知乎粘贴观感 | 结构判据全绿，**实际编辑器排版只有用户能确认** | `docs/MD_STUDIO_TEST_SHEET.md` |
| 旧日志 `logs/`（15MB） | **已清理**（09:51 后停写、0 跟踪文件） | 日志改道 `data/logs/`；`mdsea/` 48MB 参考材料已移出仓库到 `~/Code/_refs/` |

## 待办（谁手里）

**你（需要人工）**
- 走一遍 `docs/MD_STUDIO_TEST_SHEET.md`，重点是微信/知乎粘贴观感与四个导出按钮
- 定 Electron 大版本升级的排期
- 合规词表调校（`packages/mdcore/src/compliance/wordlists.ts`，红线是主编口径）
- 确认后把 `[Unreleased]` 收成 0.37.0 并打 tag

**我（等点单）**
- Electron 37 → 41+ 升级（壳 + 打包 + 全回归）
- `uvicorn --reload` 加 `--reload-dir backend`：现在它盯整个仓库，改测试文件就会重启正在跑的应用
- MD Studio 候选下一步：图床、掘金/头条、反向导入（排序见 `docs/MD_STUDIO_UPDATE_PLAN.md` §5）

## 规模数字（改动后应重新核对）

跟踪文件 **846**（docs 36：活跃 12 · 归档 24）· 顶层目录 10 · 根级 md 5 · pytest 836 · mdcore 441 · 前端 379 · 排版基线 18 张
