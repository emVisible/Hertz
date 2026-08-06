# Changelog

本项目所有显著变更都将记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
