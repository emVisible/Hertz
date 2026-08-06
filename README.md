# Hertz

AI 驱动的内容创作与自动化桌面平台 —— 从灵感到成片的一站式工作台。

整合**灵感构思（画布）**、**AI 编排（Studio）**、**自动化流水线（Pipeline）**、
**素材与下载管理（素材库）**于一个 Electron 桌面应用中。

## 功能特性

| 模块 | 说明 |
|---|---|
| 🎨 画布 Canvas | 灵感黑板：卡片、连线、语义低语提醒 |
| 🎬 Studio | 多阶段 AI 工作流编排：内容研究 → 脚本 → 成片，全程阶段状态与产物可视化 |
| 🧩 编排 | 工序库 / 策略 / 角色库（团队）/ Buff-Debuff（正反向提示词），策略级平台定位 |
| ⚙️ 流水线 Pipeline | 内容采集 → 评分 → 脚本 → 素材合成 → 发布，自动化执行 |
| 📦 素材库 | 下载管理（B 站 / YouTube 等）、来源标签系统、产物浏览、项目文档空间 |
| 🤖 AI 底座 v2.0 | Provider 注册表（OpenAI 兼容 / 硅基流动等）、角色→模型路由、提示词模板库、调用用量追踪 |

## 架构

```
Electron 桌面壳
├── React 前端（Vite + TanStack Query + Tailwind）        :3000
└── FastAPI 后端（SQLAlchemy + PostgreSQL + Alembic）      :8787
    ├── AI 底座   Provider 注册表 / 角色路由 / 模板库 / 用量追踪（macOS 钥匙串）
    ├── 引擎     Studio 阶段编排 / Pipeline 流水线
    └── 素材库   下载任务 / 标签 / 产物 / 项目文档
```

## 快速开始

**Web 模式**（后端 :8787 + 前端 :3000，浏览器访问）：

```bash
./webui.sh
```

**完整桌面模式**（另起 Electron 窗口）：

```bash
./scripts/dev.sh
```

前置依赖：Python 3.12+、uv、Node.js 22+、pnpm、PostgreSQL、ffmpeg、yt-dlp。

## 打包分发

```bash
cd frontend && pnpm build          # 前端产物（frontend/dist）
cd ../electron && pnpm build       # electron-builder 产出 release/
```

## 文档

- [用户指南](./docs/USER_GUIDE.md) —— 安装、使用、打包说明
- [架构与路线](./docs/ROADMAP.md) —— 演进规划
- [AI 底座设计](./docs/AI_BASE.md) —— Provider 注册表与角色路由
- [决策记录](./docs/DECISIONS.md) —— 设计决策（D-001 ~ D-111）
- [工程规范 axiom](./axiom.md) —— 编码与架构原则
- [变更记录](./CHANGELOG.md)

## 许可证

未定（私有项目，保留所有权利）。
