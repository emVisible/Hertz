# Hertz 路线图

> 各波次进度与验收详见 HERTZ_RECONSTRUCTION.md（九、实施波次）。

## 已交付

- **Wave 0-3**：骨架、基础设施（配置/日志/存储/迁移）、AI 接口层（DeepSeek/ComfyUI/TTS）、Factory 装配、下载引擎、资源管理、编排域（多阶段工作流 + SSE）
- **Wave 4**：内容流水线（采集/评分/下载/生产/审核/发布）与 Console 控制台
- **Wave 5**：灵感画布（相似度/聚类/低语/粉笔渲染）与对话流（SSE 持久化）
- **Wave 6**：健康检查（工具/磁盘/AI）、错误边界与全局异常处理、Electron 打包（backend 随包 + 自动更新）
- **Wave 6.5**：Axiom 全局审计——SSRF/路径穿越/密钥配置加固、media_url 落库、i18n 全量、SSE 重连、ChatPage 单源、persist 节流（详见 HERTZ_RECONSTRUCTION.md §9）
- **v0.11.2-0.11.6**：字幕标点清洗强化 → 句首逗号根因修复（ASS Format 缺 Name）→ 发布流程重构（立即发布/原文简介/当天高峰排期/随机封面）→ 情感垂直频道（源池勾选 UI + emotion 加权评分 + 情感标题/分区）→ 健康看板 UI（设置页，v0.11.6 清偿本表「健康检查 UI」项）→ 版本单一真相源（backend.config.APP_VERSION）
- **v0.11.7**：文字故事产线主体（text_only 采集存储 + 下载跳过 + LLM 中文故事旁白 + 固定中文 TTS + 渐变背景/标题卡图文合成 + 敏感词 SAFETY/MARKETING 分层 + 故事源入池）——已端到端验证（真实条目 29s 成片，OCR 确认字幕无前导逗号）；**待数据通道修复后全量启用**（Reddit 匿名 JSON/RSS 403 Blocked，cookie 失效，需 OAuth 凭证）
- **v0.11.8-0.11.10**：批量操作分片（全选超 200 上限 422 消除）→ 取消制作（协作式检查点 + ffmpeg 轮询终止，回滚 downloaded）+ 发布目标 NOOP 根因修复（runtime allowlist 缺失致保存静默失败）+ 默认直发 + 审核卡发布标题/随机封面入口/header 分组重排 → 绕过评分直接下载（引擎 input_statuses 宽松路径 + 未评分徽章降级）
- **v0.13**：发布策略引擎（B 站「逆向算法」精细化运营）——账号健康度四相位（warmup 爬坡/caution 减半/cooldown 停发）动态配额 × 内容分层选条目 × 同分区间隔/相邻去重槽位；零新表派生推导，总开关默认关；QueueView 账号状态卡
- **v0.14**：成本控制顶级菜单——ai_calls 用量 × ai_model_prices 查询时动态计价（D-176）；按环节/模型/日趋势聚合 + 执行历史明细 + 未配价警告；环节归因补齐（translate/orchestrator）
- **v0.15**：质量与 ROI 三件套（同赛道调研落地）——三步翻译法（直译→反思→意译，可关）+ 翻译术语表（结构化表 + AI 辅助提取 + prompt 注入）；条目成本 ROI（AI 成本 × 播放 × 千次成本）；标题 N 选 1（3 候选发布卡切换）
- **v0.16**：热点监控通道（TrendRadar 词法借鉴）——rising 高频拉取 + 三段词法预筛（any/all/exclude + 分数门槛），filter_fn 注入 run_collect；设置页热点监控区
- **v0.17**：月度预算阶梯提醒（Helicone 借鉴，50%/80%/95% 只警示不阻断）+ service.py 四域 Mixin 拆分（D-168 架构债清偿，1805 行 → 196 核心四域文件）
- **v0.18**：移动化与信任建立——Telegram 审核 Bot（long-polling 零公网暴露 + inline 三键过审 + 告警通道）；策略影子模式（dry_run 演练影子计划）；发布日历热力图；频道人设记忆注入创作 prompt
- **v0.19**：数据飞轮一期补完——频道洞察（Top/Bottom 对比 LLM 分析落库 + 注入评分 rubric 与脚本 prompt，冷启动保护）+ Telegram 周报推送；审核推送改最新优先修积压饿死缺陷
- **v0.20**：工程健康——SettingsPage 拆分（1332 → 265 主壳 + 四分区文件，SectionProps 契约）+ ai_calls 聚合 2 万行防线；PipelineView 五 tab 拆分（1355 → 319 主壳 + pipeline/ 六文件，「state 留壳、JSX 下放」，D-183）；测试门禁修复（Node ≥22 实验性 localStorage 遮蔽 jsdom 致 zustand persist 崩 → setup.ts 内存 shim；后端 4 处存量 lint 清零）——verify.sh 恢复全绿
- **v0.21**：P0 安装即用闭环（D-184）——PyInstaller 固化后端（backend/entrypoint.py：asyncpg 兜底建库 + 编程式 alembic + uvicorn）；内嵌 PostgreSQL（zonky darwin-arm64 发行包首启自动下载到 userData，initdb/pg_ctl 托管，动态端口，退出随停）；electron 打包态跑固化二进制 + HERTZ_USER_DATA 隔离钩子；release.yml tag 触发 mac arm64 构建发 GitHub Releases——新机零配置验收通过（首启约 40s-1.5min，之后秒级）

## 已知缺口

| 项 | 说明 | 优先级 |
|---|---|---|
| API 鉴权接入 | auth.py 已有 JWT 原语零调用；桌面单用户场景接受，部署为服务时必须接入 | 高 |
| macOS 签名与自动更新 | 无 Developer ID：electron-updater 在 mac 不可用（dmg 手动下载）；签名后开启 win/linux/mac 三端自动更新 | 中 |
| CI 平台矩阵扩展 | release.yml 目前仅 mac arm64（已本地验收）；win/linux 盲发需先行真机验证 | 中 |
| 应用图标与代码签名 | 当前用默认 Electron 图标；macOS 需 Developer ID、Windows 需 EV 证书 | 中 |
| 文字故事产线 | 主体已完成（v0.11.7 已验证）；剩余：数据通道修复（Reddit OAuth/cookie）→ 全量启用 + IP 化 | 中 |
| 半自动内容生产 | 情感频道第二阶段整体规划（文字产线 + 片头/IP 化） | 中 |
| Agent 工具调用 | 对话的 agent 模式（shell/playwright 等）为非目标，列为后续 | 低 |
| 向量检索/记忆 | Milvus/Redis 体系，增强对话上下文 | 低 |
| 多平台发布 | Bilibili 之外的 YouTube/其他平台发布器 | 低 |

## 下一步候选

1. **P0 安装即用闭环**：PyInstaller 打包后端 → CI（GitHub Actions）产物发布到更新源 → 全新机器零配置安装验收（AXIOM §17.5）
2. **P1 情感频道第二阶段（收尾）**：故事源数据通道修复（Reddit OAuth 凭证配置/cookie 刷新）→ 全量采集启用，IP 化（片头/固定音色/栏目化）
3. **P1 体验打磨**：下载队列重排、画布多板/图层/图片卡片、对话引用画布卡片
4. **P2 发布扩展**：更多平台发布器、定时自动发布、数据导出/导入

## 维护约定

- 每个迭代跑 `./scripts/verify.sh`（ruff → pytest → tsc → vitest → vite build）全绿才算完成
- 新决策记入 `docs/DECISIONS.md`，波次回顾记入 `HERTZ_RECONSTRUCTION.md`
