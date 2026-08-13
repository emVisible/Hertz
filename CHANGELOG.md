# Changelog

本项目所有显著变更都将记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [v0.9.0] - 2026-08-13

CandleBone 对齐第三轮：成片混流 / 字幕烧录三级降级 / B 站定时门槛（详见 docs/DECISIONS.md）。

### 对齐

- **成片混流**（原项目 edit.py `_audio_mix_filters`）：`compose_video` 重写——侧链压缩改时间窗口音量曲线 `volume='if(between(t\,narr_start\,narr_end)\,0.22\,1.0)':eval=frame`（窗口 = 旁白实际时长，对齐 duck_floor=0.22）；旁白轨 volume=1.05 + apad/atrim 定长防 amix 塌缩；`amix duration=longest:dropout_transition=0:normalize=0`；统一 aformat(44100/fltp/stereo) + 原声缺失 anullsrc 静音轨；BGM 降音 0.08；合成后音频 < 视频 85% 带 BGM 自动重混一次（audio_guard）
- **字幕烧录三级降级**（原项目 `_subtitle_font`/`_render_cue_png`）：libass 可用 → ASS；缺失 → 逐 cue PNG overlay（PingFang/CJK 字体候选、白字 + 8 向黑描边、最多 4 行、底部留白、fade alpha in/out）；再失败 → 无字幕。烧录方式落 `script["compose_quality"]`，审计卡片提示
- **B 站定时门槛**（原项目 scheduler_utils.py `ensure_bilibili_dtime`）：距 now 不足 `pipeline_bili_dtime_min_hours`(默认 4h) + 5 分钟自动顺延，返回 `dtime_bumped_to` 并回写落库
- **pick_voice tags 修复**：旁白配音候选忽视 bili_tags（恒 None）——改为真实逗号分隔列表参与匹配

### 新增

- 测试 `tests/test_media_mix.py`（8 例：duck 窗口 / apad / normalize=0、音频守卫重混、muted -an、anullsrc、ass/overlay 分支、pick_voice tags、dtime 顺延与已满足）
- 依赖 Pillow（PNG overlay 渲染）

### 其他

- 存量工作树随本轮提交：routers 批量/重试 Body 重复定义清理、health/download/tests ruff 存量问题（F811/B007/ASYNC240/E742/F841/E501；per-file-ignores 仅限 prompt 与 XML fixture 文件）

## [v0.8.8] - 2026-08-12

AXIOM 查漏补缺（四十五：双维度审计遗留物；详见 docs/DECISIONS.md D-163）。

### 修复

- **活动面板分页错乱**：加载更多后轮询以当前页替换累计列表（§35 前端状态与渲染时序）——累计列表按 id 去重合并
- **系统日志重复追加**：until 游标进 queryKey 导致轮询反复追加历史行——加载更多改一次性请求，轮询只刷新初始页
- **i18next 不支持 ICU select**：collectRound 的 `{{err, select, ...}}` 渲染成残缺文本——拆 collectRoundOk/Err 条件渲染
- **job_detail 死接口**（§2.3 接口存在理由）：列表曾全量传 summary 但详情端点无人调用——列表轻量化（sources_ok/err 计数），展开懒加载 /jobs/{id}
- **pipelineApi.jobs 旧函数**（四十六 遗留物治理）：类型与后端新结构不一致——删除
- **日志 API 密钥脱敏**（§8.2）：message 读取时一次 scrub（token/cookie/secret=***）
- **日志全文件重复扫描**（§7.2）：mtime 缓存，文件不变跳过重读（0.07s → 0.000s）
- **日志游标校验**（§8.1）：since/until 非法格式 422；q 截断 120 字符
- **相对时间可读性**：刚发生显示"刚刚"而非孤立符号

## [v0.2.1] - 2026-08-08

原项目功能选择性同步（详见 docs/DECISIONS.md D-128）。

### 新增

- **画布多板**：板签栏（新建 / 切换 / 双击重命名 / 删除），每板独立卡片、图层与笔迹
- **图层面板**：新建 / 重命名 / 显隐 / 排序，新卡片落在激活层
- **图片卡片**：输入态或背景粘贴剪贴板图片即生成图片卡（dataURL 持久化）
- **画布导入导出**：⌘E 导出 `.revel.json`，拖入 / 文件选择导入（与 Revel 原项目格式互通）
- **画布平移**：Space + 拖拽有界平移（±260px，与卡片拖拽互斥）
- **失败分类看板**：failed 按 blocked/rate_limit/timeout/llm/tts/ffmpeg/等 10 类聚合，同类一键批量重试
- **phash 去重**：成片平均哈希指纹，发布闸门拦截同源重复投稿；存量条目批量回填脚本
- **评分成本闸门**：单次运行 / 单日 LLM 评分硬限额，超限跳过（条目保持待评分，不花 API）
- **本地排期引擎**：每日发布窗口 + 最小间隔 + 抖动，发布卡「推荐」按钮一键填充槽位
- **自动过审**：可选开启（默认关闭），超时未审条目自动 approve
- **数据源健康度**：dead / degraded / healthy 三态 + 采集失败冷却 / 熔断 + 供给告警（漏斗空 / 偏紧 / 源失联）
- **多平台导出包**：publish target 新增 `export`——成片 + 字幕 + 封面 + README 发布包，人工 / 半自动上传
- **采集韧性**：失败冷却 30 分钟、连续失败熔断 2 小时、成功清零；Reddit 排序随机轮换反 429

### 技术基础

- 迁移 wave15（error_class）/ wave16（source_state 连续失败/最后错误）
- 工序库重构（上版）：内置工序模型去锁定跟随全局、method 结构化、DEFAULT_AGENTS 并入 PHASES 单一真相源

## [v0.1.0] - 2026-08-06

首个可运行版本：AI 驱动的内容创作与自动化桌面平台。

### 新增

- **画布 Canvas**：灵感黑板，卡片 / 连线 / 语义低语提醒
- **编排 Studio**：多阶段 AI 工作流（内容研究 → 脚本 → 成片），阶段状态与产物实时可视化
  - 工序库：可编排的阶段模板（角色 / 模型 / 提示词 / 输出）
  - 策略 Brief：创作策略文档（Markdown 编辑 + 渲染预览）
  - 角色库与团队：AI 角色 → 模型分配（v4.1 简化：角色仅保留设定描述）
  - Buff / Debuff：正向与反向提示词注入（扩写 11 个内置 Buff + 5 个内置 Debuff）
- **流水线 Pipeline**：内容采集 → 评分 → 脚本 → 素材合成 → 发布（noop / Bilibili），调度器与重试
- **素材库**：
  - 下载管理（B 站 / YouTube，SSE 实时进度，断点续传）
  - 来源标签系统（下载自动打标签，按标签筛选）
  - 产物浏览（Studio / Pipeline 快捷入口，阶段产物融合展示）
  - 项目文档空间（素材根目录下 Markdown 文档的新建 / 编辑 / 删除）
- **AI 底座 v2.0**：
  - Provider 注册表（OpenAI 兼容协议，内置 DeepSeek / 硅基流动 / ComfyUI / Edge-TTS 模板）
  - 角色 → 模型路由（main / fast / embedding / image / tts），运行时可切换
  - 提示词模板库（编排 / 评分 / 图像 / 语音，支持自定义与回退）
  - 调用用量追踪（Trace 面板，流式响应计费）
  - API 密钥经 macOS 钥匙串加密存储
- **设置中心**：通用 / AI 服务 / 提示词 / 用量 / 流水线 分区管理
- 编排页语义分组导航（配置 / 角色 / 增益，行内激活贴纸）、素材根目录可配置、双语言（中 / 英）

### 技术基础

- FastAPI + SQLAlchemy（异步）+ PostgreSQL + Alembic 迁移（wave1 ~ wave10）
- React + Vite + TanStack Query + Tailwind CSS；Electron 桌面壳
- 路径安全（containment 校验）、密钥掩码、SSRF 防护等安全基线（见 axiom.md）

### 已知限制

- 桌面密钥存储目前仅支持 macOS 钥匙串（Windows / Linux 待支持）
- 发布目标仅 noop 与 Bilibili（其余待接入）

[Unreleased]: #
[v0.1.0]: https://github.com/emVisible/Hertz/releases/tag/v0.1.0
