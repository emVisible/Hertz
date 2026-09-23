# Hertz 路线图

> 各波次进度与验收详见 [HERTZ_RECONSTRUCTION.md](./HERTZ_RECONSTRUCTION.md)（九、实施波次）。

## 已交付

- **Wave 0-3**：骨架、基础设施（配置/日志/存储/迁移）、AI 接口层（DeepSeek/ComfyUI/TTS）、Factory 装配、下载引擎、资源管理、编排域（多阶段工作流 + SSE）
- **Wave 4**：内容流水线（采集/评分/下载/生产/审核/发布）与 Console 控制台
- **Wave 5**：灵感画布（相似度/聚类/低语/粉笔渲染）与对话流（SSE 持久化）
- **Wave 6**：健康检查（工具/磁盘/AI）、错误边界与全局异常处理、Electron 打包（backend 随包 + 自动更新）
- **Wave 6.5**：Axiom 全局审计——SSRF/路径穿越/密钥配置加固、media_url 落库、i18n 全量、SSE 重连、ChatPage 单源、persist 节流（详见 HERTZ_RECONSTRUCTION.md §9）
- **v0.11.2-0.11.6**：字幕标点清洗强化 → 句首逗号根因修复（ASS Format 缺 Name）→ 发布流程重构（立即发布/原文简介/当天高峰排期/随机封面）→ 情感垂直频道（源池勾选 UI + emotion 加权评分 + 情感标题/分区）→ 健康看板 UI（设置页，v0.11.6 清偿本表「健康检查 UI」项）→ 版本单一真相源（backend.config.APP_VERSION）
- **v0.11.7**：文字故事产线主体（text_only 采集存储 + 下载跳过 + LLM 中文故事旁白 + 固定中文 TTS + 渐变背景/标题卡图文合成 + 敏感词 SAFETY/MARKETING 分层 + 故事源入池）——已端到端验证（真实条目 29s 成片，OCR 确认字幕无前导逗号）；**待数据通道修复后全量启用**（Reddit 匿名 JSON/RSS 403 Blocked，cookie 失效，需 OAuth 凭证）
- **v0.11.8-0.11.10**：批量操作分片（全选超 200 上限 422 消除）→ 取消制作（协作式检查点 + ffmpeg 轮询终止，回滚 downloaded）+ 发布目标 NOOP 根因修复（runtime allowlist 缺失致保存静默失败）+ 默认直发 + 审核卡发布标题/随机封面入口/header 分组重排 → 绕过评分直接下载（引擎 input_statuses 宽松路径 + 未评分徽章降级）
- **v0.13**：发布策略引擎（B 站发布节奏精细化运营）——账号健康度四相位（warmup 爬坡/caution 减半/cooldown 停发）动态配额 × 内容分层选条目 × 同分区间隔/相邻去重槽位；零新表派生推导，总开关默认关；QueueView 账号状态卡
- **v0.14**：成本控制顶级菜单——ai_calls 用量 × ai_model_prices 查询时动态计价（D-176）；按环节/模型/日趋势聚合 + 执行历史明细 + 未配价警告；环节归因补齐（translate/orchestrator）
- **v0.15**：质量与 ROI 三件套（同赛道调研落地）——三步翻译法（直译→反思→意译，可关）+ 翻译术语表（结构化表 + AI 辅助提取 + prompt 注入）；条目成本 ROI（AI 成本 × 播放 × 千次成本）；标题 N 选 1（3 候选发布卡切换）
- **v0.16**：热点监控通道（TrendRadar 词法借鉴）——rising 高频拉取 + 三段词法预筛（any/all/exclude + 分数门槛），filter_fn 注入 run_collect；设置页热点监控区
- **v0.17**：月度预算阶梯提醒（Helicone 借鉴，50%/80%/95% 只警示不阻断）+ service.py 四域 Mixin 拆分（D-168 架构债清偿，1805 行 → 196 核心四域文件）
- **v0.18**：移动化与信任建立——Telegram 审核 Bot（long-polling 零公网暴露 + inline 三键过审 + 告警通道）；策略影子模式（dry_run 演练影子计划）；发布日历热力图；频道人设记忆注入创作 prompt
- **v0.19**：数据飞轮一期补完——频道洞察（Top/Bottom 对比 LLM 分析落库 + 注入评分 rubric 与脚本 prompt，冷启动保护）+ Telegram 周报推送；审核推送改最新优先修积压饿死缺陷
- **v0.20**：工程健康——SettingsPage 拆分（1332 → 265 主壳 + 四分区文件，SectionProps 契约）+ ai_calls 聚合 2 万行防线；PipelineView 五 tab 拆分（1355 → 319 主壳 + pipeline/ 六文件，「state 留壳、JSX 下放」，D-183）；测试门禁修复（Node ≥22 实验性 localStorage 遮蔽 jsdom 致 zustand persist 崩 → setup.ts 内存 shim；后端 4 处存量 lint 清零）——verify.sh 恢复全绿
- **v0.21**：P0 安装即用闭环（D-184/D-185）——PyInstaller 固化后端（backend/entrypoint.py：asyncpg 兜底建库 + 编程式 alembic + uvicorn）；内嵌 PostgreSQL（zonky darwin-arm64 发行包首启自动下载到 userData，initdb/pg_ctl 托管，动态端口，退出随停）；electron 打包态跑固化二进制 + HERTZ_USER_DATA 隔离钩子；release.yml tag 触发 mac arm64 构建发 GitHub Releases——新机零配置验收通过；ffmpeg 内嵌兜底（imageio 7.1 含 libass，系统版优先）+ ffprobe 独立解析拆雷；冷启动归因留档（冻结静态导入 ~17s，业务侧全快）；CI 实战首跑验证通过，v0.21.0 dmg 已发布（D-185）
- **v0.22**：栏目化内容工厂（D-186，非破坏性）——多源采集路由（裸名=Reddit 兼容，存量转载源零改动）；AI 原创情感故事源（LLM 直产 text_only 种子，成本闸 per_tick=2，栏目人设注入）+ RSS 通用文本源双新源；栏目实体 wave20（源池/固定音色/B站分区/简介模板/标签/标题风格/persona/片头配置绑定单元）+ items.channel_key 采集打标；固定音色优先级链（栏目>注册表>自适应）；动态标题卡片头（produce 单点汇聚前置 concat，三重降级）；包装注入（标题风格/标签置顶/desc 模板/bili_tid）；设置页 ChannelsCard 管理 UI。Reddit 凭证路径确认死路后降级为可选插件，存量转载分发链路零触碰
- **v0.22.x**：全系统架构审计第一轮清偿（D-187）——_serialize 双死代码删除；telegram push_alert 三接线（熔断/发布失败/预算阶梯，哑火通道复活）；RSS SSRF 防护；ffprobe 探测收敛单一出口；telemetry tick 环形记录 + /api/metrics 端点 + DB 每日备份滚动保留。遗留 B 系结构清偿逐轮推进（media.py 拆分/retranslate 下沉/service_publish 再切等）；翻译引擎可插拔（D-188）——本地 Opus-MT en→zh（ctranslate2 零新增重依赖，模型首用自动下载）与 API 三步法随时切换 + 字幕缓存复用省重复调用
- **v0.23**：地基巩固四项收口（D-191 前置，零行为变更）——media.py 解体收尾（compose/cover/probe/narration/retranslate 等 13 域文件切出，主文件 2141→648 行）；usePipelineExecution 630 行总线 hook 按域拆为 usePipelineData/Actions/Events 三 hooks（壳 30 行）；错误处理统一（ErrorBoundary + 全局 unhandledrejection 监听，异步错误不再无声消失）；script_json 读写两侧全量收敛至 sk 契约常量
- **v0.24**：脚本工坊 MVP（D-192，能力一落地）——语音草稿 → faster-whisper 本地转写 → 逐句编辑入库，产出直连既有 TTS→ASS→ffmpeg 下游零改动；TTS 试听、句子拖拽排序、朗读时长实时预估、纯文本直录、草稿暂存；第六 tab 接入流水线导航可达
- **v0.25**：规则评分引擎 + 智能路由阶梯降级（D-193）——多信号启发式打分（高置信免 LLM，仅灰区增强）；成本阶梯收口两处：budget critical/exceeded 时 router.score 强制本地启发式（零 API）、exceeded 时 ScoreStep 跳过自动批次（人工触发仍可用）。可量化点：API 调用量下降
- **v0.26**：创作资产系统 + 半自动面板（D-194～D-196）——灵感笔记 sidecar 与素材关联、灵感片段标记（t0/t1 + label，与原始素材分离）、素材组合预览、视觉风格预设（wave25_style_presets）；制作优先级 items.priority 列（wave26_item_priority，engine 取件按降序，批量队列拖拽排序的持久化后端）
- **运营面板补齐**（D-197，并入 v0.26 节奏）——审核卡 Enter 展开、发布日历栏目色彩标记；快捷键覆盖 j/k/a/r/Enter
- **v0.30**：整合发布（本轮）——零行为变更的发布收尾：verify.sh 全绿基线（后端 351 + 前端 35 + tsc）、四处版本号对齐 0.30.0、本地 --dir 打包 + HERTZ_USER_DATA 新机模拟、tag v0.30.0 走 release.yml 出 mac-arm64 dmg。战略四项能力（脚本工坊/创作资产/降级路由/运营面板）至此成版

## v0.30 战略方向

> 详见 [VISION_V030.md](./VISION_V030.md)

**定位转向**：从「内容工厂」到「创作者工坊」——工具优化机械环节，创意决策归人。

四项核心能力：脚本工坊（语音草稿→逐句打磨）/ 创作资产图（灵感↔素材关联）/
智能降级路由（Tier A-D 供给分层）/ 半自动运营面板（批量+快捷键全覆盖）。

版本节奏：v0.23 地基巩固 → v0.24 脚本工坊 MVP → v0.25 智能路由+规则评分
→ v0.26 创作资产系统 → v0.30 整合发布。

---

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

1. **P1 情感频道第二阶段（收尾）**：故事源数据通道修复（Reddit OAuth 凭证配置/cookie 刷新）→ 全量采集启用，IP 化（片头/固定音色/栏目化）
2. **P1 体验打磨**：下载队列重排、画布多板/图层/图片卡片、对话引用画布卡片
3. **P1 脚本工坊二期**：风格锚点对照检查（当前为预设保存，未做写作时实时比对）、片段↔条目双向引用可视化
4. **P2 发布扩展**：更多平台发布器、定时自动发布、数据导出/导入
5. **P2 平台矩阵与签名**：mac Developer ID 签名（解锁自动更新）+ win/linux 真机验证后扩矩阵（见已知缺口，不在 v0.30 范围）

## 维护约定

- 每个迭代跑 `./scripts/verify.sh`（ruff → pytest → tsc → vitest → vite build）全绿才算完成
- 新决策记入 `docs/DECISIONS.md`，波次回顾记入 `HERTZ_RECONSTRUCTION.md`
