<div align="center">

# Hertz

**AI 驱动的内容创作与自动化桌面平台 —— 从灵感到发布的一站式内容工厂。**

[English](./README.md) · [简体中文](./README.zh-CN.md)

[![Release](https://github.com/emVisible/Hertz/actions/workflows/release.yml/badge.svg)](https://github.com/emVisible/Hertz/actions/workflows/release.yml)

</div>

---

## 概览

Hertz 是一个本地优先的短视屏内容工厂，覆盖完整生产生命周期：
**采集 → 评分 → 制作 → 审核 → 发布**——关键节点保留人工闸门，其余全程自动化。

以 Electron 桌面应用交付（FastAPI 后端 + React 前端），内置插件式 AI 底座、
面向 B 站的策略驱动发布引擎，以及全新机器零配置的安装体验。

## 功能特性

**内容流水线**
- 多源采集：Reddit、AI 原创故事（LLM 直产）、通用 RSS——按通道路由
- AI 评分带成本闸门、双重去重（phash + 标题指纹）与安全红线
- 制作产线：脚本 → TTS 旁白 → 字幕（ASS 烧录）→ 合成，逐级优雅降级

**栏目化运营**
- 源池、固定音色、B 站分区、简介/标签模板、标题风格、人设提示词、动态标题卡片头
  绑定为一个「栏目」单元
- 经栏目通道采集的条目自动继承包装配置；未绑定条目不受任何影响

**审核与发布**
- 桌面审核队列 + Telegram Bot 手机端过审
- 发布策略引擎：账号爬坡曲线、内容分层、每日配额与槽位间隔
- 发布队列（预发布/就绪相位）、日历排期、播放数据回捞

**AI 底座**
- Provider 注册表（OpenAI 兼容 / 硅基流动 / Ollama…）、角色→模型路由（`main` / `fast`）、
  可编辑提示词模板库、逐调用用量追踪与月度预算阶梯

**工作台**
- Studio 多阶段编排、灵感画布、下载管理与素材库（标签系统）

**平台能力**
- 零配置打包：后端 PyInstaller 固化 + 内嵌 PostgreSQL 首启自动供给 +
  GitHub Releases 自动更新通道
- 系统依赖仅高级路径需要（ffmpeg 内置兜底；仅 B 站上传需要 `biliup`）

## 架构

```
Electron 壳（自动更新 / 内嵌 PostgreSQL 托管）
├── 前端   React 19 · Vite · TanStack Query · Tailwind          :3000
└── 后端   FastAPI · SQLAlchemy async · PostgreSQL               :8787
    ├── Pipeline      collectors → steps → producers → publishers
    │                 （多源路由 / 栏目化 / 发布策略引擎）
    ├── Orchestration Studio 阶段引擎 / 角色 / 提示词 Buff
    ├── AI 底座       Provider 注册表 · TaskRouter 角色路由
    │                 · 用量追踪（ai_calls)· 钥匙串密钥
    └── 基础设施      日志 · telemetry（/api/metrics）· 备份
                       · 健康/依赖检测 · Alembic 迁移
```

## 快速开始

### 下载安装

从 [Releases](https://github.com/emVisible/Hertz/releases) 获取最新 macOS
（Apple Silicon）安装包。首次启动会自动下载内嵌 PostgreSQL（约 32 MB，一次性）
并完成数据库迁移。

> `ffmpeg` 可选——内置版本已覆盖缩略图/制作/字幕烧录；仅在发布 B 站时需要 `biliup`。

### 开发模式

前置依赖：Python 3.12+ · [uv](https://docs.astral.sh/uv/) · Node.js 22+ · pnpm · PostgreSQL

```bash
git clone https://github.com/emVisible/Hertz.git && cd Hertz
./scripts/dev.sh          # 迁移 → 后端 :8787 → 前端 :3000 → Electron
```

仅 Web 模式：`./webui.sh`

### 质量门禁

所有改动必须通过：

```bash
./scripts/verify.sh       # ruff → pytest → tsc → vitest → vite build
```

## 项目结构

```
backend/
  ai/               Provider 注册表、TaskRouter、提示词、用量成本
  pipeline/         collectors / steps / producers / publishers / strategy
  orchestration/    Studio 阶段引擎、团队、Buff
  infrastructure/   存储、日志、鉴权原语、telemetry、备份
  routers/          覆于领域服务之上的薄 HTTP 层
frontend/src/
  pages/            execution · dashboard · assets · plans · settings · cost
  components/       UI 组件库、执行域视图、应用壳
  hooks/stores/     usePipelineExecution、zustand stores
electron/           主进程、preload、打包配置、内嵌 PG
docs/               用户指南 · 路线图 · 决策记录 · AI 底座设计
scripts/            dev 启动器、verify 门禁、后端固化、迁移
tests/              pytest 套件（独立测试库，每会话重建）
```

## 文档

| 文档 | 内容 |
|---|---|
| [用户指南](./docs/USER_GUIDE.md) | 安装、环境变量、打包说明 |
| [路线图](./docs/ROADMAP.md) | 已交付里程碑与已知缺口 |
| [决策记录](./docs/DECISIONS.md) | 工程设计决策 D-001 → |
| [AI 底座](./docs/AI_BASE.md) | Provider 注册表与角色路由设计 |
| [变更记录](./CHANGELOG.md) | 版本说明 |

## 许可证

以 [MIT License](./LICENSE) 发布——欢迎参考、学习与二次构建。
