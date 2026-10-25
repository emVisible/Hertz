# PROJECT.md —— 当前状态

> 这个文件只回答「现在在哪」。**怎么把「怎么来的」交给别处**：变了什么看 `CHANGELOG.md`，为什么看 `docs/decisions/`，怎么干活看 `AGENTS.md`，历史看 `docs/archive/`。
> 更新时机：里程碑完成、架构变更、发版、重大决策、发现重大风险。**不要为每个小改动更新它。**

## 版本

- 当前版本：**0.37.0** · tag `v0.37.0`（2026-10-18）。六处一致：
  `backend/config.py:APP_VERSION`、`pyproject.toml`、`package.json`、
  `frontend/package.json`、`electron/package.json`（`test_version_drift.py` 守这五处）
  + `uv.lock` 项目自身那条（靠 `uv sync`）
- 发版门禁：`scripts/release-check.sh` **PASS**（源码 9 步 → 重建固化包 → 产物级门禁）
- `[Unreleased]` 已重开为空
- 恢复点 tag：`pre-docs-shuffle-2026-10-17`（文档治理前的 `5201377`）

## 当前阶段

**0.37.0 已发布**。本阶段交付：MD Studio 第三批（Shiki 高亮 / Mermaid / CSS / PDF 导出）、
微信·知乎粘贴修复、两处真实缺陷定性（D-231 配置钉子 / D-232 缓存判同）、文档体系治理、
`dev.sh` 观察面收窄。**下一阶段待点单**：Electron 大版本升级（唯一的高危待办）、MD Studio
下一批候选（图床 / 掘金头条 / 反向导入）。

活跃分支：`main`。

## 最近变更

| 提交 | 变了什么 |
|---|---|
| `72a551f`…`7313b00` | **仓库清偿批次**（6 提交，三路审计驱动）：P0 卫生清偿（说谎注释/死代码/mdcore 出口收窄/测试 4 删 2 放松）→ monoline ffmpeg 样板收敛 + concat 下沉 → registry tick 合并 → MD_STUDIO.md 叙事压缩（524→477 行）→ **pytest 全量 256s→120s**（字体子集替身 + ffmpeg marker 快速档 96s） |
| `7d33b3d` | 字幕重复短语是 ct2 解码退化——参数+折叠+密度三层护栏（D-234） |
| `0.37.0` | **发版**：六处版本对齐、CHANGELOG 收口、产物级门禁 `release-check.sh` 全绿 |
| `fdee85a`…`1feff84` | **文档体系治理**（6 提交）：活跃文档 6,819 → 1,887 行；历史 5,186 行进 `docs/archive/`（含状态头）；决策改一决策一文件；新增 `AGENTS.md` / `PROJECT.md` / `docs/README.md`；`webui.sh` 归位 `scripts/`；门禁新增**文档链接检查**（第 1 步，9 步制） |
| `5201377` | `data/runtime.yaml` 的陈旧默认值钉子——"日志搬家"从未生效，附 D-231 取证更正 |
| `b1ca205` | 判"内容变没变"改用内容签名（`.size` ≠ 内容），附 D-232 |
| `d390832` | 微信/知乎：`---` 右居中、标题被拆行（富文本编辑器不是浏览器） |
| `cd9c139`…`f1e4bca` | 启动期愈合逐条隔离、日志脱敏、版本号对齐、dev.sh 端口自复活刹车 |

恢复点 tag：`pre-docs-shuffle-2026-10-17`（治理前的 `5201377`）。

## 门禁现状

`bash scripts/verify.sh` 全量 **EXIT=0**，共 **9 步**：文档链接 → ruff → pytest **853（约 2 分钟）** → mdcore tsc → mdcore **441** → 前端 tsc → 前端 **379** → vite build → **18 张排版基线**（0.5% 阈值）。日常快速迭代：`uv run pytest -m "not ffmpeg" -q`（777 条 / 96s，真 ffmpeg 家族分层）。

## 已知风险

| 风险 | 状态 | 依据 |
|---|---|---|
| **Electron 37.10.3 有 36 条真实 CVE**（11 high / 20 moderate） | **未修**，需独立改动面 | `docs/decisions/README.md` 的审计结论；清零需升到 ≥41.10.6 |
| 「打开应用约一分钟后机器卡死」 | **未复现**。当前 dev 栈连续运行 CPU ≈0%、零自发重启。最可能是当时全量 pytest 与 dev 栈 + Postgres 同时在跑——**仍是推测** | D-231 |
| 微信/知乎粘贴观感 | 结构判据全绿，**实际编辑器排版只有用户能确认** | `docs/MD_STUDIO_TEST_SHEET.md` |
| 素材「音频比画面长」 | **全族已修**（assemble/cover/phash/compose 四处）。素材侧仍会产生这种文件，现在它只会让成片变短，不会再变成黑屏、黑封面或丢哈希 | `backend/pipeline/producers/assemble.py` 与 `CHANGELOG` |
| 机翻字幕重复短语 | **已修**（解码参数 + 折叠 + 密度截断三层，D-234）。**已产出的坏字幕不会自愈**——重跑该条 `retranslate` 才换新；阈值 0.35 依赖当前模型分布，换模型须重测两族密度 | `tests/test_translate_engine.py`（13 条，五组变异） |
| 旧日志 `logs/`（15MB） | **已清理**（09:51 后停写、0 跟踪文件） | 日志改道 `data/logs/`；`mdsea/` 48MB 参考材料已移出仓库到 `~/Code/_refs/` |

## 待办（谁手里）

**你（需要人工）**
- 走一遍 `docs/MD_STUDIO_TEST_SHEET.md`，重点是微信/知乎粘贴观感与四个导出按钮
- 注册 Reddit OAuth 凭证并填进设置页——情感文字产线可能是它的先决条件
  （`docs/ROADMAP.md`「已知缺口」有量化依据：全库 selftext 0/5281 非空）
- 定 Electron 大版本升级的排期
- 合规词表调校（`packages/mdcore/src/compliance/wordlists.ts`，红线是主编口径）

**我（等点单）**
- **monoline 编辑卡顿（产品侧）**：每编辑一拍触发 17.8MB VF 字体真子集化，实测 4.8s 纯 CPU/次——测试侧已替身，产品侧待修（字形集缓存/静态实例化，见 CHANGELOG 2026-10-25 条目）
- **PlansPage 状态重组（37 个平行 useState → 按 8 实体对象化）**：页面零测试护栏，动前先补最小行为测试
- Electron 37 → 41+ 升级（壳 + 打包 + 全回归）——高危待办
- 正文回填 `backfill-selftext.py`：就绪但要一台能出网的机器（reddit 全域 000）
- MD Studio 候选下一步：图床、掘金/头条、反向导入（排序见 `docs/MD_STUDIO_UPDATE_PLAN.md` §5）

## 规模数字（改动后应重新核对）

跟踪文件 **846**（docs 36：活跃 12 · 归档 24）· 顶层目录 10 · 根级 md 5 · pytest 853 · mdcore 441 · 前端 379 · 排版基线 18 张 · 门禁 9 步
