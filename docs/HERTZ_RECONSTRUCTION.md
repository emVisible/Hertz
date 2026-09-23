# Hertz 重构计划

> **历史设计文档**：记录 v0.1 的整体蓝图与五项目合并脉络，随实现推进有所演进；
> 现行架构以 [README](../README.md) 与 docs/ 其余文档为准。
>
> 从 Autarkeia、Mojito、HeartStone、Revel、Ametrine 五项目合一  
> 版本：v0.1 · 2026-07-31  
> 基于 AXIOM v1.9 体系构建

---

## 零、总纲

### 0.1 项目定义

**Hertz** 是一个桌面端 AI 驱动的内容创作与自动化平台。它整合了灵感构思、AI 编排、内容生产流水线、下载管理与对话式 AI 交互，覆盖从"想法"到"发布"的全链路。

Hertz 不只是一个工具的集合——它是一个有明确软件哲学的系统。这个哲学建立在 AXIOM 七层秩序之上：分层、解耦、单一职责、组件化、最小依赖。

### 0.2 核心精神（摘自 AXIOM 第二部第七条）

> 求真、谦逊、温度、克制、创造、责任、传承

在工程层面体现为：
- **求真**：不隐藏复杂性，不伪造优雅。技术决策记录可追溯。
- **克制**：概念是最昂贵的资源。能用一个词表达的不用两个。
- **具体完成**：交付以可复现验证为准。产物存在 > 过程声明。
- **传承**：代码写给六个月后凌晨三点修 Bug 的自己。

### 0.3 交付边界

本重构计划覆盖：
- 五项目的机制融合、架构统一
- 技术选型、目录结构、数据模型
- 分层架构设计（静态系统 → AI/Factory → 下载/资源 → 编排 → 执行）
- 实施波次规划

本重构计划不覆盖：
- 具体 UI 布局细节（在波次实施时按 AXIOM §27 设计令牌体系推进）
- 发布平台对接的具体字段（属于 Autarkeia 域内的配置项）
- 用户文档（实施完成后按 AXIOM §9.3 文档三分法生成）

---

## 一、术语约定

> AXIOM §5.3：统一术语，一个概念一个词。本节是整个项目的命名权威源。

### 1.1 核心领域术语

| 术语 | 定义 | 来源 |
|------|------|------|
| **Crew** | 一组 AI Agent 角色的配置集合，定义"谁来做" | Mojito |
| **Brief** | 创作策略，Markdown 格式，定义"做什么" | Mojito |
| **Plan** | 编排计划，将 Crew + Brief + Phase 组合为可执行的管道 | Mojito |
| **Phase** | 编排管道中的一个阶段（如"内容写作""图片生成"） | Mojito |
| **Step** | 执行管道中的一个步骤（如"评分""下载"） | Autarkeia（原 Stage） |
| **Studio** | 执行仪表盘，查看管道运行状态与实时日志 | Mojito |
| **Canvas** | 灵感画布，卡片式自由创作空间 | Revel |
| **Console** | Pipeline 控制台，内容审核与发布管理 | Autarkeia（原 WebConsole） |
| **Library** | 资源浏览器，项目化文件管理 | HeartStone（原 AssetBrowser） |
| **Conversation** | 与 AI 的对话会话，支持 LLM 流式交互 | Ametrine |

### 1.2 技术术语

| 术语 | 定义 |
|------|------|
| **Pipe** | 编排管道的抽象接口，定义 Step/Phase 的统一契约 |
| **Pipeline Engine** | 管道执行器的抽象基类，编排层和执行层各自实现 |
| **Provider** | AI 能力的抽象接口（LLM、TTS、ASR、Image） |
| **Router** | AI 任务路由，按任务类型选择 Provider |
| **Factory** | 服务工厂，负责创建和注入依赖，解耦调用方与实现方 |
| **Project** | 下载项目，文件组织的单位 |

### 1.3 禁止使用的术语

以下原项目术语在 Hertz 中**不再出现**：
- `Autarkeia`、`Mojito`、`HeartStone`、`Revel`、`Ametrine`（作为产品名）
- `Stage`（改为 `Step`，避免与 Phase 歧义）
- `OrchestrationTemplate`（改为 `Plan`）
- `StrategyTemplate`（改为 `Brief`）
- `ContentItem`（改为 `Item`，简洁且上下文自明）

---

## 二、架构设计

### 2.1 分层架构

Hertz 采用自底向上的五层架构，层间单向依赖。上层调用下层，下层不感知上层。

```
┌──────────────────────────────────────────────────────────────┐
│                    Electron 桌面外壳                           │
│  窗口管理 · 系统托盘 · 自定义协议 · IPC 通道 · 自动更新       │
├──────────────────────────────────────────────────────────────┤
│                    React 前端（渲染进程）                       │
│  ┌──────────┬──────────┬──────────┬──────────┬───────────┐  │
│  │  Canvas  │  Studio  │ Console  │ Library  │ Downloads │  │
│  └──────────┴──────────┴──────────┴──────────┴───────────┘  │
│  ┌──────────┬──────────┬──────────┬──────────────────────┐  │
│  │  Briefs  │  Plans   │  Config  │  Conversation        │  │
│  └──────────┴──────────┴──────────┴──────────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                  统一 FastAPI 后端（主进程内嵌）               │
│                                                                │
│  ┌──────── 层4：执行域 ────────┐  ┌── 层3：编排域 ─────────┐ │
│  │ Collect → Score → Download │  │ Crew → Brief → Plan    │ │
│  │ → Produce → Review → Pub  │  │ → Phase → Studio       │ │
│  └────────────────────────────┘  └─────────────────────────┘ │
│  ┌───────────────┬──────────────────────────────────────┐    │
│  │  层1：AI 层   │  层1：Factory 层（同级解耦）         │    │
│  │  LLM / TTS    │  Pipeline Executor / Service Locator │    │
│  │  / ASR /      │  / Task Scheduler / Registry         │    │
│  │  ComfyUI      │                                      │    │
│  └───────────────┴──────────────────────────────────────┘    │
│  ┌─────────────── 层0：基础设施 ────────────────────────┐    │
│  │  Auth · Config · Logging · i18n · Storage · Health   │    │
│  │  Download Engine · Library (HeartStone 域下沉至此)    │    │
│  └──────────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────┤
│                    PostgreSQL                                 │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 层间契约

**调用规则**：
- 上层只调用直接下层，不跨层访问
- 跨层能力通过逐层暴露接口传递，不在上层直接导入下层模块
- 每层对外暴露统一 `__init__.py` 接口，内部实现细节不对外可见

**数据流动**：
- 前端 ↔ 后端：REST API（`/api/*`）+ SSE（实时事件：pipeline/studio/download 任务流）
- 前端 ↔ Electron 主进程：IPC（下载、文件系统、剪贴板监控）
- 后端内部：同步/异步函数调用，通过 Factory 层获取依赖

### 2.3 管道抽象设计

> AXIOM §2.2：高层策略不应依赖低层细节

**Pipe** 是编排管道和执行管道的统一抽象基类：

```python
# backend/pipeline/base.py

class Pipe(ABC):
    """管道中的单个步骤或阶段"""

    @property
    @abstractmethod
    def name(self) -> str: ...

    @property
    @abstractmethod
    def input_statuses(self) -> list[str]: ...

    @property
    @abstractmethod
    def output_status(self) -> str: ...

    @abstractmethod
    async def process(self, ctx: PipelineContext, item: Any) -> ProcessResult: ...


class PipelineEngine(ABC):
    """管道执行器的抽象基类"""

    @abstractmethod
    async def run(self, plan_or_items: Any) -> PipelineResult: ...

    @abstractmethod
    async def resume(self, run_id: str) -> PipelineResult: ...
```

两个实现：
- **PhaseEngine**（`backend/orchestration/engine.py`）：执行 Mojito 的 phase 编排管道（现 8 工序），一个 Phase 可以触发一个或多个 Step
- **StepEngine**（`backend/pipeline/engine.py`）：执行 Autarkeia 的 5-step 内容流水线

二者共用 `Pipe → ProcessResult → PipelineContext` 抽象，各自的 Phase/Step 是实现细节。

---

## 三、目录结构

```
Hertz/
├── axiom.md                           # AXIOM 体系权威文档
├── HERTZ_RECONSTRUCTION.md            # 本文件
├── README.md                          # 项目说明（实施后生成）
│
├── pyproject.toml                     # Python 后端项目配置（hatchling）
├── uv.lock                            # Python 依赖锁
├── package.json                       # 前端 + Electron（pnpm）
├── pnpm-lock.yaml
├── alembic.ini                        # 数据库迁移配置
│
├── backend/                           # 统一 FastAPI 后端
│   ├── main.py                        # 应用入口，生命周期管理
│   ├── config.py                      # 统一配置（Settings + RuntimeConfig 分层）
│   ├── database.py                    # SQLAlchemy async engine + session
│   │
│   ├── models/                        # ORM 模型（按域分文件）
│   │   ├── __init__.py
│   │   ├── base.py                    # DeclarativeBase + 工具列（id, created_at, updated_at）
│   │   ├── item.py                    # 内容条目（+ media_url，Wave 6 审计）
│   │   ├── download.py                # 下载任务 / 项目
│   │   ├── crew.py                    # Crew 代理团队
│   │   ├── brief.py                   # Brief 策略
│   │   ├── plan.py                    # Plan 编排计划
│   │   ├── conversation.py            # 对话 / 消息
│   │   ├── pipeline.py                # 管道任务记录（JobRun/Item 状态）
│   │   ├── session.py                 # 运行会话
│   │   └── system.py                  # 系统心跳 / 审计日志
│   │
│   ├── infrastructure/                # 层0：静态系统层
│   │   ├── __init__.py
│   │   ├── auth.py                    # JWT 原语（secret 未配置时快速失败；未接入路由）
│   │   ├── logging.py                 # 结构化日志 + 日志缓冲（/api/logs/buffer）
│   │   ├── storage.py                 # 文件系统抽象（原子写/路径管理）
│   │   ├── events.py                  # 应用内事件总线（job/run 事件广播）
│   │   ├── errors.py                  # 错误原语（AppError/分级）
│   │   └── health.py                  # 健康检查（分层）
│   │
│   ├── ai/                            # 层1：AI 接口层
│   │   ├── __init__.py
│   │   ├── types.py                   # AIProvider / ImageProvider / TTSProvider 协议
│   │   ├── router.py                  # AIRouter：任务路由 → provider 选择
│   │   ├── providers/
│   │   │   ├── __init__.py
│   │   │   ├── deepseek.py            # DeepSeek API（远端 LLM）
│   │   │   ├── comfyui.py             # ComfyUI（本地图像生成）
│   │   │   └── edge_tts.py            # Edge TTS（语音合成）
│   │   └── prompts/                   # System/User Prompt 模板
│   │       ├── __init__.py
│   │       ├── score.py               # 评分 Prompt
│   │       ├── script.py              # 脚本生成 Prompt
│   │       ├── title.py               # 标题生成 Prompt
│   │       └── agent.py               # Agent 角色 Prompt
│   │
│   ├── factory/                       # 层1：Factory 层
│   │   ├── __init__.py
│   │   ├── registry.py                # ServiceRegistry（单例注册中心；shutdown 取消后台任务）
│   │   ├── scheduler.py               # 任务调度器（APScheduler）
│   │   └── concurrency.py             # 并发控制（信号量/限流）
│   │
│   ├── download/                      # 层2：下载引擎
│   │   ├── __init__.py
│   │   ├── engine.py                  # 分片并发下载引擎（asyncio，aiofiles）
│   │   ├── parser.py                  # URL 解析（域名白名单 + 静态 SSRF 检查）
│   │   ├── service.py                 # 任务服务（DB 持久化 + 状态机）
│   │   ├── errors.py                  # 下载错误类型
│   │   ├── sources/
│   │   │   ├── __init__.py
│   │   │   ├── bilibili.py            # B站视频解析 + yt-dlp
│   │   │   ├── youtube.py             # YouTube 解析
│   │   │   ├── generic.py             # 通用网页资源提取（同样过 SSRF 检查）
│   │   │   └── ytdlp.py               # yt-dlp 封装
│   │   └── workers.py                 # 任务池（分片并发下载）
│   │
│   ├── library/                       # 层2：资源管理
│   │   ├── __init__.py
│   │   ├── browser.py                 # 文件浏览/扫描/排序/过滤
│   │   ├── metadata.py                # 元数据读写（.heartstone-meta.json）
│   │   └── thumbnails.py              # 缩略图生成（ffmpeg 截图）
│   │
│   ├── orchestration/                 # 层3：编排域
│   │   ├── __init__.py
│   │   ├── engine.py                  # PhaseEngine（编排管道执行器）
│   │   ├── crud.py                    # Crew/Brief/Plan 通用 CRUD
│   │   ├── crews.py                   # Crew 服务
│   │   ├── briefs.py                  # Brief 服务
│   │   ├── plans.py                   # Plan 服务
│   │   ├── phases.py                  # Phase 定义与注册
│   │   ├── studio.py                  # Studio 执行管理 + SSE 广播（read_file 路径穿越防护）
│   │   └── errors.py                  # 编排错误
│   │
│   ├── pipeline/                      # 层4：执行域
│   │   ├── __init__.py
│   │   ├── base.py                    # Pipe / PipelineEngine 抽象基类
│   │   ├── engine.py                  # StepEngine（内容管道执行器，SSE 事件发射）
│   │   ├── service.py                 # 批/链运行门控（运行中拒绝重入）
│   │   ├── steps/                     # 内置 Step 实现
│   │   │   ├── __init__.py            # STEP_INDEX 注册表（未知 step → 422）
│   │   │   ├── collect.py             # 内容采集（持久化 media_url）
│   │   │   ├── score.py               # AI 评分
│   │   │   ├── download.py            # 媒体下载（media_url 优先 + DNS SSRF 检查）
│   │   │   ├── produce.py             # 内容生产（脚本/TTS/字幕/剪辑/封面）
│   │   │   └── publish.py             # 发布
│   │   ├── collectors/                # 内容源适配器
│   │   │   ├── __init__.py
│   │   │   ├── base.py                # SourceCollector 抽象
│   │   │   └── reddit.py              # Reddit 采集
│   │   ├── producers/
│   │   │   └── media.py               # 媒体产物（合成/封面）
│   │   └── publishers/
│   │       └── router.py              # 发布目标路由（noop | bilibili）
│   │
│   ├── conversation/                  # 对话流
│   │   ├── __init__.py
│   │   ├── chat.py                    # 统一 SSE 流式对话（chat_stream）
│   │   └── history.py                 # 对话历史持久化（列表查询窗口函数防 N+1）
│   │
│   └── routers/                       # FastAPI 路由聚合（薄层）
│       ├── __init__.py                # 注册所有子路由
│       ├── ai.py                      # /api/ai/*
│       ├── download.py                # /api/download/*
│       ├── library.py                 # /api/library/*（项目唯一约束 409）
│       ├── pipeline.py                # /api/pipeline/*（step 白名单 422）
│       ├── conversation.py            # /api/conversation/*（message 1–8000）
│       ├── studio.py                  # /api/studio/*（运行 + 产物文件）
│       ├── config.py                  # /api/config/*
│       ├── health.py                  # /api/health/*
│       ├── logs.py                    # /api/logs/buffer
│       ├── briefs.py / crews.py / plans.py   # /api/* CRUD
│       └── (orchestration 路由并入各域文件)
│
├── frontend/                          # React 前端
│   ├── src/
│   │   ├── main.tsx                   # React 入口
│   │   ├── App.tsx                    # 根布局 + 路由（ErrorBoundary 包裹）
│   │   ├── api/
│   │   │   ├── client.ts              # 统一 fetch 客户端
│   │   │   ├── index.ts               # 模块聚合导出
│   │   │   ├── conversation.ts        # 对话 SSE 消费（fetch + ReadableStream）
│   │   │   ├── download.ts            # 下载任务/解析
│   │   │   ├── library.ts             # 资源库
│   │   │   ├── orchestration.ts       # 编排域（briefs/plans/studio）
│   │   │   └── pipeline.ts            # 管道（运行/审核/事件）
│   │   ├── stores/
│   │   │   ├── board.ts               # 画布状态（persist 节流 500ms + 隐藏强制落盘）
│   │   │   ├── download.ts            # 下载任务状态
│   │   │   └── theme.ts               # 主题（partialize 只持久化 theme）
│   │   ├── hooks/
│   │   │   └── useEventSource.ts      # SSE 订阅 + 指数退避重连
│   │   ├── components/                # 共享 UI 组件（自建，无外部 UI 库）
│   │   │   ├── AppShell.tsx           # 布局壳（侧边栏 + 顶栏）
│   │   │   ├── ErrorBoundary.tsx      # 错误边界（i18n 文案）
│   │   │   ├── layout/index.tsx
│   │   │   └── ui/                    # 基础组件
│   │   │       ├── Badge.tsx / Button.tsx / Card.tsx / EmptyState.tsx
│   │   │       ├── Icon.tsx           # 自建 SVG 图标集（零依赖）
│   │   │       ├── Input.tsx / Select.tsx / Progress.tsx / Spinner.tsx
│   │   │       ├── Tabs.tsx / Toast.tsx / Modal.tsx / index.ts / toast-store.ts
│   │   │       └── *.test.tsx         # 组件测试
│   │   ├── pages/
│   │   │   ├── canvas/                # 灵感画布（Revel）
│   │   │   │   ├── CanvasPage.tsx     # 画布入口 + Studio 产物侧栏
│   │   │   │   ├── Board.tsx          # 黑板主组件（画布/笔迹/连线）
│   │   │   │   ├── CardView.tsx       # 卡片组件
│   │   │   │   ├── StudioInspector.tsx # Studio 产物注入
│   │   │   │   ├── ToolDock.tsx       # 工具坞
│   │   │   │   └── WhispersBar.tsx    # 低语侧栏（i18n 文案 + 静音）
│   │   │   ├── studio/StudioPage.tsx  # Studio 执行入口（SSE 事件 + 产物文件列表）
│   │   │   ├── console/ConsolePage.tsx # Pipeline 控制台（审核队列 + 实时事件）
│   │   │   ├── briefs/BriefsPage.tsx  # Brief 策略
│   │   │   ├── plans/PlansPage.tsx    # Plan 编排
│   │   │   ├── chat/
│   │   │   │   ├── ChatPage.tsx       # 对话页面（单一消息源 + 流式 + 会话管理）
│   │   │   │   └── MessageList.tsx    # 消息列表（内置轻量 Markdown）
│   │   │   ├── DownloadsPage.tsx      # 下载管理
│   │   │   ├── LibraryPage.tsx        # 资源浏览器
│   │   │   └── PlaceholderPage.tsx    # 未实现模块占位
│   │   ├── theme/
│   │   │   └── tokens.ts              # 设计令牌（唯一视觉源）
│   │   ├── styles/global.css          # CSS 变量 + Tailwind 基础
│   │   ├── i18n/
│   │   │   ├── index.ts               # i18next 初始化
│   │   │   ├── zh.json                # 中文（与 en 键全量对齐）
│   │   │   └── en.json                # 英文
│   │   ├── core/                      # 纯逻辑层（零框架依赖）
│   │   │   ├── similarity.ts          # 语义相似度
│   │   │   ├── cluster.ts             # 语义聚类
│   │   │   ├── id.ts                  # ID 生成
│   │   │   └── whisper.ts             # 低语决策引擎（纯数据，无文案）
│   │   ├── canvas/                    # Canvas 渲染层
│   │   │   ├── renderer.ts            # 背景 + 连线渲染
│   │   │   ├── chalk.ts               # 粉笔质感渲染
│   │   │   ├── physics.ts             # 卡片物理漂移
│   │   │   ├── background.ts          # 背景粒子
│   │   │   └── types.ts               # 画布类型（Board/Card/Stroke/颜色）
│   │   └── *.test.ts                  # Vitest（core/whisper、cluster、stores）
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   └── tsconfig.json
│
├── electron/                          # Electron 壳（根目录独立包 hertz-electron）
│   ├── src/
│   │   ├── main.ts                    # 窗口管理 + 托盘 + 协议注册 + IPC（内联注册）
│   │   └── preload.ts                 # 上下文桥接（window.api / window.electron）
│   ├── package.json
│   └── tsconfig.json
│
├── alembic/                           # 数据库迁移
│   ├── env.py
│   └── versions/
│       ├── 001_initial.py             # 初始迁移
│       ├── 47191deda3cf_wave1_core_tables.py
│       ├── wave3_orchestration_add_plan_description.py
│       ├── wave4_pipeline.py
│       ├── wave5_conversation.py
│       └── wave6_audit.py             # media_url + items 唯一约束（当前 head）
│
├── data/                              # 运行时数据（gitignore）
│   ├── runtime.yaml                   # 运行时配置覆盖（配置 UI 写入）
│   ├── downloads/
│   └── projects/
│
├── tests/
│   ├── conftest.py                    # pytest fixtures（含 loopback 逃生阀环境变量）
│   ├── test_ai_router.py
│   ├── test_pipeline_engine.py
│   ├── test_download_engine.py        # 含 SSRF 白名单用例
│   ├── test_download_api.py
│   ├── test_orchestration.py
│   ├── test_conversation.py
│   ├── test_health.py
│   ├── test_library.py
│   └── test_storage.py
│
├── docs/
│   ├── DECISIONS.md                   # 决策记录（为什么/取舍/后果）
│   ├── ROADMAP.md                     # 路线图（做什么/验收/批）
│   └── USER_GUIDE.md                  # 用户文档
│
├── scripts/
│   ├── dev.sh                         # 一键启动开发环境
│   └── verify.sh                      # 预提交验证（ruff + pytest + tsc + vitest + build）
│
└── reference_repo/                    # 原项目参考（只读，不进构建）
    ├── Autarkeia/
    ├── Mojito/
    ├── HeartStone/
    ├── Revel/
    └── Ametrine/
```

---

## 四、技术选型

> AXIOM §6.1：每一个依赖都是一份尚未到期的技术债。引入前回答：自己用 50 行能写吗？停止维护的替换成本？用到了百分之几？

| 层级 | 技术 | 版本 | 理由 |
|------|------|------|------|
| **桌面外壳** | Electron | 33+ | 跨平台、自定义协议、系统托盘、IPC |
| **前端框架** | React | 19 | Mojito/HeartStone/Revel 的共同基础 |
| **样式** | Tailwind CSS | 4 | CSS-variable 驱动，与设计令牌天然对应 |
| **动效** | GSAP | 3.x | 高性能动画编排，替代 framer-motion（自制组件不需要框架级动效绑定） |
| **状态管理** | Zustand + TanStack React Query | 5 + 5 | Zustand 管客户端状态（persist）；React Query 管服务端状态（缓存/失效/重取） |
| **构建** | Vite | 6 | 五个原项目统一使用 |
| **后端框架** | FastAPI | 0.115+ | 异步支持、SSE 流式、Pydantic 集成 |
| **ORM** | SQLAlchemy 2.0 async | 2.0 | asyncpg 驱动，充分利用 FastAPI 异步 |
| **数据库驱动** | asyncpg | 0.30+ | PG 异步驱动 |
| **数据库** | PostgreSQL | 16+ | 统一存储 |
| **迁移** | Alembic | 1.15+ | SQLAlchemy 标准迁移工具 |
| **LLM 远端** | DeepSeek API | — | 主要远端 LLM |
| **图像生成** | ComfyUI | — | 本地 Stable Diffusion 工作流（初期唯一本地方案） |
| **TTS** | Edge TTS | — | Microsoft 神经语音，免费可用的中文/英文 |
| **ASR** | faster-whisper | — | 本地语音识别 |
| **媒体处理** | ffmpeg / ffprobe | — | 视频合成、截图、元数据提取 |
| **下载工具** | yt-dlp | — | B站/YouTube 等平台视频提取（AXIOM §24 成熟工具集成优先于自建） |
| **定时任务** | APScheduler | 3.x | 管道定时触发 |
| **包管理** | uv (Python) + pnpm (Node) | latest | 两端的确定性和速度 |
| **测试** | pytest + Vitest | latest | 后端 + 前端测试 |
| **Lint** | ruff (Python) + biome (TS) | latest | 两端代码质量 |

### 4.1 明确不引入的技术

| 不引入 | 替代方案 | 原因 |
|--------|----------|------|
| Ant Design / shadcn/ui | 自建 UI 组件 | 完全控制视觉，设计令牌穿透无阻 |
| framer-motion | GSAP | 自建组件不需要框架级动效绑定 |
| Redux Toolkit | Zustand | 更轻的 API，与 React Query 互补更好 |
| Milvus | 暂不引入 | 初期不需要向量检索，避免基础设施膨胀 |
| Xinference / Ollama | 暂不实现 | 初期优先 ComfyUI（图像）+ DeepSeek（文本），本地 LLM 后期接入 |
| Pollinations | ComfyUI 本地 | 不依赖外部云服务（AXIOM §17.1 封闭系统原则） |

---

## 五、核心模块设计

### 5.1 基础设施层（层0）

#### 5.1.1 配置系统

> AXIOM §1.2：单一真相源。配置、端口表、路由每种只在一处定义。

```python
# backend/config.py — 全应用唯一配置入口

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="HERTZ_", env_file=".env")

    # 数据库
    database_url: str = "postgresql+asyncpg://hertz:hertz@localhost:5432/hertz"

    # AI Provider
    llm_provider: Literal["deepseek"] = "deepseek"
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com/v1"
    deepseek_model: str = "deepseek-chat"

    image_provider: Literal["comfyui"] = "comfyui"
    comfyui_base_url: str = "http://127.0.0.1:8188"

    # 端口
    backend_port: int = 8787
    frontend_port: int = 3000

    # 路径
    data_dir: Path = Path("data")
    output_dir: Path = Path("output")
    log_dir: Path = Path("logs")

    # 安全
    secret_key: str | None = None   # 未设置时 auth 原语快速失败（AXIOM §8.2）
    access_token_expire_minutes: int = 60

settings = Settings()
```

合并后的配置文件层级（`backend/config.py` 实现，`RuntimeConfig` 按 mtime 缓存）：
1. `Settings` 默认值 + 环境变量（密钥和部署差异）
2. `data/runtime.yaml` — 运行时覆盖（Config 页面写入，通过 `_EffectiveSettings` 代理在读取时合并）

#### 5.1.2 日志系统

> AXIOM §28：简略日志给人看进度，详细日志给人查问题，二者不得互相吞没。

```python
# backend/infrastructure/logging.py

class LogManager:
    # 双通道输出
    buf: LogBuffer      # 内存缓冲区（SSE 实时推送）
    file_logger         # 文件输出（带堆栈的完整日志）
    console_logger      # 终端输出（彩色简要日志）

    def progress(self, run_id: str, phase: str, status: str, elapsed: float): ...
    def detail(self, run_id: str, module: str, level: str, message: str, exc_info=None): ...
```

#### 5.1.3 存储抽象

```python
# backend/infrastructure/storage.py

class FileStore:
    """文件系统抽象，统一所有路径管理"""

    @property
    def data_dir(self) -> Path: ...
    @property
    def output_dir(self) -> Path: ...
    @property
    def projects_dir(self) -> Path: ...

    async def atomic_write(self, path: Path, content: bytes) -> None: ...
    async def safe_read(self, path: Path) -> bytes | None: ...
    def ensure_dir(self, path: Path) -> Path: ...
```

---

### 5.2 AI 接口层（层1）

#### 5.2.1 Provider 协议

> AXIOM §2.2：依赖倒置——业务逻辑不依赖具体 LLM 实现

```python
# backend/ai/types.py

class AIProvider(Protocol):
    """LLM 抽象——业务逻辑只依赖此协议"""
    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> AsyncIterator[str]: ...

class ImageProvider(Protocol):
    """图像生成抽象"""
    async def generate(
        self,
        prompt: str,
        negative_prompt: str = "",
        *,
        width: int = 1024,
        height: int = 1024,
        steps: int = 20,
        seed: int | None = None,
    ) -> ImageResult: ...

class TTSProvider(Protocol):
    """TTS 抽象"""
    async def synthesize(self, text: str, voice: str) -> bytes: ...


class AIRouter:
    """任务 → Provider 路由。
    上层调用方无需知道是 DeepSeek 还是本地模型。"""

    def __init__(
        self,
        llm: AIProvider,
        image: ImageProvider | None,
        tts: TTSProvider | None,
    ): ...

    async def score(self, item: dict) -> ScoreResult:
        """评分任务 → LLM"""
        ...

    async def script(self, context: dict) -> str:
        """脚本生成 → LLM"""
        ...

    async def title_and_tags(self, context: dict) -> TitleResult:
        """标题标签 → LLM"""
        ...

    async def generate_image(self, prompt: str, **kw) -> ImageResult:
        """图片生成 → ComfyUI"""
        ...
```

#### 5.2.2 各 Provider 实现

```python
# backend/ai/providers/deepseek.py

class DeepSeekProvider:
    async def chat_stream(self, messages, *, temperature, max_tokens):
        # OpenAI-compatible API → SSE stream
        ...


# backend/ai/providers/comfyui.py

class ComfyUIProvider:
    async def generate(self, prompt, negative_prompt, *, width, height, steps, seed):
        # POST /prompt → poll /history → download image
        ...
```

---

### 5.3 Factory 层（层1）

```python
# backend/factory/registry.py

class ServiceRegistry:
    """单例注册中心。全局唯一，管理所有服务实例。"""

    _instance: ClassVar["ServiceRegistry | None"] = None

    ai_router: AIRouter
    download_engine: DownloadEngine
    pipeline_engine: StepEngine
    orchestration_engine: PhaseEngine
    chat_service: ChatService
    schedule_manager: ScheduleManager

    @classmethod
    def get(cls) -> "ServiceRegistry": ...
    def initialize(self, settings: Settings) -> None: ...
```

所有上层代码通过 `ServiceRegistry.get().xxx` 获取服务实例，不直接 import 实现类。这保证了：

- 切换 AI Provider 不需要改任何业务代码
- 测试时可以注入 mock 实例
- 新增服务类型只需在 Registry 中添加一个字段

---

### 5.4 下载引擎（层2）

从 HeartStone 提取核心下载能力，下沉为基础设施域：

```python
# backend/download/engine.py

class DownloadEngine:
    """多线程分片下载引擎"""

    async def download(
        self,
        url: str,
        dest_path: Path,
        *,
        project_id: str | None = None,
        on_progress: Callable[[Progress], None] | None = None,
        headers: dict | None = None,
    ) -> DownloadResult: ...

    async def download_batch(
        self,
        urls: list[str],
        dest_dir: Path,
        *,
        concurrency: int = 3,
    ) -> list[DownloadResult]: ...


class URLParser:
    """URL 识别与元数据提取"""

    async def parse(self, url: str) -> ParsedURL:
        """识别 URL 类型，提取媒体信息"""
        ...

    async def scan_page(self, url: str) -> list[ScannedAsset]:
        """扫描网页中的可下载资源"""
        ...
```

---

### 5.5 资源管理（层2）

```python
# backend/library/browser.py

class LibraryBrowser:
    """项目化文件浏览"""

    async def scan_project(self, project_id: str) -> list[FileEntry]: ...
    async def get_metadata(self, file_path: Path) -> FileMeta: ...
    async def generate_thumbnail(self, file_path: Path) -> bytes: ...
```

---

### 5.6 编排域（层3）

```python
# backend/orchestration/engine.py

class PhaseEngine(PipelineEngine):
    """编排管道执行器。驱动 Crew → Brief → Plan 中的 Phase 序列。"""

    async def run(self, plan_id: str, topic: str) -> str:
        """执行一个 Plan，返回 run_id"""
        ...

    async def resume(self, run_id: str) -> str: ...

    async def cancel(self, run_id: str) -> None: ...
```

Phase 注册机制：

```python
# backend/orchestration/phases/__init__.py

_phase_registry: dict[str, type[Pipe]] = {}

def register_phase(key: str, cls: type[Pipe]): ...

def get_phase(key: str) -> type[Pipe]: ...

# 各 Phase 通过装饰器注册
@register_phase("writer")
class WriterPhase(Pipe): ...
```

编排管道作为 Plan 中的一个 Phase 可以触发执行层的全流程：

```python
@register_phase("content_pipeline")
class ContentPipelinePhase(Pipe):
    """将 Autarkeia 的执行管道作为一个编排 Phase 嵌入"""

    async def process(self, ctx, item) -> ProcessResult:
        engine = ServiceRegistry.get().pipeline_engine
        return await engine.run_single(item)
```

---

### 5.7 执行域（层4）

```python
# backend/pipeline/engine.py

class StepEngine(PipelineEngine):
    """内容管道执行器。驱动 Item 经过 Collect → Score → Download → Produce → Publish。"""

    async def run_batch(self, job_name: str, *, limit: int = 10, channel: str = "") -> dict:
        """运行单个 step（或 full chain），记录 JobRun，返回处理统计。"""
        ...

    async def run_chain(self, *, limit: int = 10, channel: str = "") -> dict: ...
    async def approve_item(self, item_id: str) -> None: ...
    async def reject_item(self, item_id: str) -> None: ...
```

Step 注册机制与 Phase 一致，共用 `backend/pipeline/base.py` 中的 `Pipe` 基类；
`backend/pipeline/steps/__init__.py` 维护 `_STEP_INDEX` 注册表，未知 step 名由
路由层拒绝（422，见 §9 Wave 6 审计回顾）。

### 5.8 对话系统

```python
# backend/conversation/chat.py

class ChatService:
    """统一对话服务。SSE 流式输出，双方消息持久化。"""

    def __init__(self, ai: AIRouter | None, history: ConversationHistory | None = None) -> None: ...

    async def chat_stream(
        self,
        conversation_id: str | None,
        message: str,
        mode: str = ConversationMode.LLM,
    ) -> AsyncIterator[dict]:
        """单轮对话，产出 SSE 事件 dict；用户/助手消息均落库。"""
        ...
```

SSE 事件协议（逐行 `data: {json}\n\n`）：

```
data: {"type":"token","content":"..."}
data: {"type":"done","conversation_id":"..."}
data: {"type":"error","message":"..."}
```

- 路由：`POST /api/conversation/chat`（body: `conversation_id?/message/mode`，message 1–8000 字符，mode ∈ {llm, agent}）
- 前端以 fetch + ReadableStream 消费（见 `frontend/src/api/conversation.ts`），AbortController 取消流式对话

---

## 六、数据模型

### 6.1 统一基础列

```python
# backend/models/base.py

class BaseModel(DeclarativeBase):
    __abstract__ = True

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
```

### 6.2 核心表（初始迁移）

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   crews      │     │   briefs     │     │   plans      │
│ id           │     │ id           │     │ id           │
│ name         │     │ name         │     │ name         │
│ agents (JSON)│     │ content (MD) │     │ crew_id (FK) │
│ created_by   │     │ platform_id  │     │ brief_id(FK) │
│              │     │ config(JSON) │     │ phase_order  │
│              │     │              │     │   (JSON)     │
│              │     │              │     │ mode         │
└──────────────┘     └──────────────┘     └──────────────┘
                                               │
                                               │ 1:N
                                               ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ workflow_runs│     │  phase_runs  │     │   items      │
│ id           │     │ id           │     │ id           │
│ plan_id (FK) │     │ run_id (FK)  │     │ status       │
│ status       │     │ phase_key    │     │ source_url   │
│ started_at   │     │ status       │     │ title        │
│ finished_at  │     │ duration     │     │ ai_score     │
│              │     │ error        │     │ script (JSON)│
│              │     │              │     │ raw_path     │
│              │     │              │     │ output_path  │
│              │     │              │     │ cover_path   │
│              │     │              │     │ phash        │
└──────────────┘     └──────────────┘     └──────────────┘
                                               │
                                               │ 1:1 (可选)
                                               ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ download_    │     │ conversations│     │  messages    │
│   tasks      │     │ id           │     │ id           │
│ id           │     │ title        │     │ conv_id (FK) │
│ url          │     │ mode         │     │ role         │
│ status       │     │              │     │ content      │
│ progress     │     │              │     │ status       │
│ file_path    │     │              │     │ token_usage  │
│ project_id   │     │              │     │              │
│ metadata(JSON)│    │              │     │              │
└──────────────┘     └──────────────┘     └──────────────┘

┌──────────────┐     ┌──────────────┐
│  projects    │     │  job_runs    │
│ id           │     │ id           │
│ name         │     │ job_name     │
│ path         │     │ status       │
│              │     │ started_at   │
│              │     │ finished_at  │
│              │     │ summary(JSON)│
└──────────────┘     └──────────────┘
```

### 6.3 Item 状态机

```
         ┌───────┐
         │  new  │ ← 新采集到的原始条目
         └───┬───┘
             ▼
    ┌────────────┐
    │ discovered  │ ← 已发现，等待评分
    └─────┬──────┘
          │ prefilter / llm scoring
          ▼
    ┌────────────┐     ┌──────────┐
    │   scored    │ ──→ │ rejected │ ← 评分不足
    └─────┬──────┘     └──────────┘
          │
          ▼
    ┌────────────┐
    │ downloaded  │ ← 媒体已下载
    └─────┬──────┘
          │
          ▼
    ┌────────────┐
    │   queued    │ ← 生产完成，等待审核
    └─────┬──────┘
          │ human review
    ┌─────┴─────┐
    ▼           ▼
┌──────────┐ ┌──────────┐
│ approved │ │ rejected │
└────┬─────┘ └──────────┘
     │
     ▼
┌──────────┐
│published │ ← 已发布
└──────────┘
```

任何阶段失败后进入 `failed` 状态。`failed` 状态的 Item 可被"继续"（resume）从失败点重新进入管道。

---

## 七、前端架构

### 7.1 组件树

```
<App>
  <WindowControls />            {/* macOS 红绿灯 */}
  <Sidebar>
    <NavItem to="canvas" />
    <NavItem to="studio" />
    <NavItem to="console" />
    <NavItem to="downloads" />
    <NavItem to="library" />
    <NavItem to="conversation" />
    <Divider />
    <NavItem to="briefs" />
    <NavItem to="plans" />
    <NavItem to="config" />
  </Sidebar>
  <main>
    <Routes>
      <Route path="canvas" element={<CanvasPage />} />
      <Route path="studio" element={<StudioPage />} />
      <Route path="console" element={<ConsolePage />} />
      <Route path="downloads" element={<DownloadsPage />} />
      <Route path="library" element={<LibraryPage />} />
      <Route path="conversation" element={<ChatPage />} />
      <Route path="briefs" element={<BriefsPage />} />
      <Route path="plans" element={<PlansPage />} />
      <Route path="config" element={<ConfigPage />} />
    </Routes>
  </main>
</App>
```

### 7.2 状态管理分工

| 状态类别 | 工具 | 持久化 |
|----------|------|--------|
| 服务端数据（Item 列表、Plan/Crew/Brief、对话历史） | React Query | 服务端是真相源，客户端缓存 |
| 客户端配置（主题、语言、保存路径） | Zustand + persist | localStorage |
| 下载任务 | Zustand + persist | localStorage（跨会话恢复） |
| 临时 UI 状态（URL 输入、弹窗开启、展开/折叠） | Zustand（不持久化） | 无 |
| 管道运行实时状态 | SSE + Zustand | 无（瞬态，断线自动重连） |
| 画布数据（Board/Card/Stroke） | Zustand + persist | localStorage |

### 7.3 设计令牌（AXIOM §27）

```typescript
// frontend/src/theme/tokens.ts — 全应用唯一视觉源

export const tokens = {
  color: {
    // 语义色
    primary: "var(--color-primary)",
    success: "var(--color-success)",
    warning: "var(--color-warning)",
    error: "var(--color-error)",

    // 表面色
    surface: {
      0: "var(--color-surface-0)",   // 最深背景
      1: "var(--color-surface-1)",   // 卡片/面板
      2: "var(--color-surface-2)",   // 悬浮层
    },

    // 文本色
    text: {
      primary: "var(--color-text-primary)",
      secondary: "var(--color-text-secondary)",
      disabled: "var(--color-text-disabled)",
    },
  },
  spacing: {
    xs: "4px", sm: "8px", md: "16px", lg: "24px", xl: "32px",
  },
  radius: {
    sm: "4px", md: "8px", lg: "12px", full: "9999px",
  },
  motion: {
    fast: "150ms", normal: "300ms", slow: "500ms",
  },
};
```

组件不得自造色值、间距——所有视觉属性通过 tokens 引用。

### 7.4 自建 UI 组件规范

每个 UI 组件满足：
1. 纯函数 + Props 接口定义在组件文件顶部
2. 不引入外部 UI 库依赖
3. 通过 `className` 接收 Tailwind 扩展，内部通过 tokens 驱动
4. 动画使用 GSAP（`useGSAP` hook 集成）
5. 支持 `dark` 类名自动切换（通过 CSS 变量）

### 7.5 Canvas（Revel）集成为 Studio 子面板

Canvas 定位为 Mojito Studio 中的创作辅助面板，而非独立入口。

```
StudioPage
├── TopicInput         ← 输入主题
├── PhaseView          ← 阶段执行状态（展开/折叠）
├── CanvasPanel        ← Revel 画布（可折叠侧面板）
│   ├── Board
│   ├── ToolDock
│   └── WhispersBar
├── LogTerminal        ← 实时日志
└── OutputPreview      ← 最终产物预览
```

Canvas 作为 Studio 创作的"灵感准备区"：用户可以在 Studio 开始前先在 Canvas 上打散思路、画连线，完成后将 Canvas 内容作为 Brief 的输入参考。

---

## 八、迁移策略

> AXIOM §22.1：建新路 → 迁流量 → 拆旧路

### 8.1 数据迁移

**SQLite → PostgreSQL**（Autarkeia 的 `content_items` 表）：

1. 编写一次性迁移脚本 `scripts/migrate_autarkeia_data.py`
2. 读取原 Autarkeia 的 `data/autarkeia.db`，逐表映射到 PG
3. 字段映射：`content_kind` → `item_type`，`ai_score` → `score_json`（JSONB）
4. 迁移后写入 `migration_log` 表，记录源行数/目标行数/失败行

**已有 PG 数据**（Mojito、Ametrine）：

1. 表结构对齐：`strategy_templates` → `briefs`，`orchestration_templates` → `plans`
2. 列重命名通过 Alembic 迁移脚本完成
3. 原有数据保留，通过迁移脚本转换字段名

### 8.2 代码迁移原则

- 不直接复制原项目文件
- 逐个模块从 reference_repo 提取逻辑，重写为 Hertz 风格
- 每完成一个模块，运行对应测试验证
- 所有 AI 调用方改为通过 `AIRouter` 而非直接调用 DeepSeek API
- 所有配置读取改为通过 `config.py` 而非各自读取 YAML

---

## 九、实施波次

> AXIOM §3.4：波次交付优于功能堆叠。每轮含可演示路径、验收标准、非目标。

### Wave 0：骨架搭建

**目标**：可启动的开发环境，空应用可见

**内容**：
- [x] `pyproject.toml` + `package.json` 初始化
- [x] `backend/main.py` FastAPI 启动（健康检查可用）
- [x] `backend/config.py` 统一配置
- [x] `backend/database.py` SQLAlchemy async engine + session
- [x] `alembic init` + 初始迁移（空表 or base 模型）
- [x] `frontend/` React + Vite + Tailwind 4 脚手架
- [x] `electron/main.ts` 窗口启动 + 加载前端
- [x] `electron/preload.ts` 基础桥接
- [x] `scripts/dev.sh` 一键启动

**验收**：`./scripts/dev.sh` 启动 → Electron 窗口出现 → 控制台无报错 ✅ 已验证（2026-07-31：backend :8787 health ok + db ok，frontend :3000 HTTP 200，Electron 窗口加载前端并成功请求健康检查）

**非目标**：任何业务功能、UI 组件、数据库表

---

### Wave 1：基础设施 + AI 层 + Factory 层

**目标**：三层地基就绪，AI 调用可通

**内容**：

*基础设施*：
- [x] `backend/models/base.py` + 所有 ORM 模型定义
- [x] Alembic 初始迁移（全部表）
- [x] `backend/infrastructure/` 日志、存储、健康检查；鉴权为 JWT 原语（auth.py 提供 create/decode/依赖，但无用户管理 → 路由未接入，见 AXIOM §8.3 待办）
- [x] `backend/routers/` 路由聚合框架（health/ai/config/downloads/library/crews/briefs/plans/studio/logs）
- [x] 前端 UI 基础组件（Button、Card、Modal、Input、Select、Progress、Toast、Spinner、EmptyState、Tabs、Badge、Icon）
- [x] 前端 Layout 组件（Sidebar、Header、WindowControls）
- [x] 前端设计令牌 + 全局 CSS 变量 + 暗色主题
- [x] 前端 i18n 框架 + 中英文基础文案（i18n 在前端 `frontend/src/i18n/`，后端无 i18n 模块）

*AI 层*：
- [x] `backend/ai/types.py` Provider 协议定义
- [x] `backend/ai/providers/deepseek.py` 实现
- [x] `backend/ai/providers/comfyui.py` 实现
- [x] `backend/ai/providers/edge_tts.py` 实现
- [x] `backend/ai/router.py` AIRouter 任务路由
- [x] `backend/ai/prompts/` Prompt 模板

*Factory 层*：
- [x] `backend/factory/registry.py` ServiceRegistry
- [x] `backend/factory/scheduler.py` APScheduler 集成（ScheduleManager 启动/注册 API 就绪；当前零 job——尚无周期性任务需求）
- [x] `backend/factory/concurrency.py` 并发控制

**验收**：
- [x] FastAPI 启动，`/api/health` 返回 OK
- [x] DeepSeek API 调用成功（通过 `/api/ai/llm/test` 端点验证）
- [x] TTS 合成成功（`/api/ai/tts/test` 产出 MP3）
- [x] ComfyUI 连接检查（当前未运行，health 报 degraded；启动后自动 OK）
- [x] 前端所有基础组件渲染正常，暗色/亮色主题切换正确
- [x] 路由骨架导航可用
- [ ] 健康检查 llm 项：目前仅查 configured 标志，未做连通性探测（升级为真实探测属 Wave 6 系统性健康检查范围）

**非目标**：下载、编排、执行管道、对话流、Canvas

---

### Wave 2：下载引擎 + 资源管理

**目标**：下载和文件浏览功能完整

**内容**：
- [x] `backend/download/engine.py` 分片下载引擎
- [x] `backend/download/parser.py` URL 解析器
- [x] `backend/download/sources/` B站/YouTube/通用 适配器
- [x] `backend/download/workers.py` asyncio 任务池（按 task id 追踪/取消；并发由 ConcurrencyLimiter 控制——非线程池）
- [x] `backend/library/` 资源浏览器服务
- [x] `backend/models/download.py`；`project.py` 不建表（项目 = 文件系统目录扫描，无元数据需求）
- [x] Electron IPC 通道注册（`shell:show-in-folder`；window:minimize/toggle-maximize/close；download/filesystem 不在 Electron 做，由后端统一承担。IPC 在 `main.ts`/`preload.ts` 内联注册，无独立 `electron/ipc/` 目录）
- [x] ~~Electron Worker 线程（chunk-fetcher.js）~~ 架构决策：下载引擎整体在 FastAPI 后端（分片 + yt-dlp），Electron 仅 IPC
- [x] 前端 Downloads 页面
- [x] 前端 Library 页面（网格/详情视图、预览、缩略图）
- [x] Zustand download store + React Query library queries

**验收**：
- [x] 粘贴 B站链接 → 解析格式列表 → 选择质量 → 创建任务（CDP 实测通过；实际下载受网络限制：B站 CDN 无凭据慢速、Cloudflare 测速源不支持 Range、GitHub release 本网络不可达——引擎全链路已由 `test_download_engine.py` 本地 HTTP 服务器验证）
- [x] Library 浏览项目目录 → 图片预览/视频播放/音频播放 → 元数据面板显示 ffprobe 信息（CDP 实测通过）

**非目标**：编排管道、执行管道、对话流、Canvas

---

### Wave 3：编排域

**目标**：Crew/Brief/Plan/Studio 全链路可运行

**内容**：
- [x] `backend/models/crew.py`、`backend/models/brief.py`、`backend/models/plan.py` 模型（Wave 1 迁移 `47191deda3cf`；本波迁移 `wave3_orchestration` 为 plan 增加 `description` 列）
- [x] `backend/orchestration/` crews、briefs、plans 服务（CRUD，`crud.py` 共享基座）
- [x] `backend/orchestration/phases.py` 14 个内置 Phase（PHASES/DEFAULT_PHASE_ORDER/DEFAULT_AGENTS）
- [x] `backend/orchestration/engine.py` PhaseEngine（顺序执行 + 阶段产物 `<key>.md` + package 兜底）
- [x] `backend/orchestration/studio.py` Studio 服务（单飞守卫/取消幂等终态/产物访问）；实时广播用 EventHub + SSE（`/api/studio/events`），非 WebSocket（pyproject 无 websockets 依赖）
- [x] ~~`backend/pipeline/base.py` Pipe + PipelineEngine 抽象~~ 推迟到 Wave 4（编排域只需 PhaseEngine；管道抽象与 StepEngine 一并实现）
- [x] 前端 Briefs 页面（Markdown 编辑器 + dirty 跟踪）
- [x] 前端 Plans 页面（Phase 拖拽排序 @dnd-kit + 启用开关 + palette 添加）
- [x] 前端 Studio 页面（Topic 输入 Cmd+Enter → 执行 → SSE 实时日志 → 阶段徽章 → 运行历史 → 产物文件 tab 预览）

**验收**：
- [x] 创建 Crew → 创建 Brief → 创建 Plan（选 Crew + Brief + 拖拽 Phase） → Studio 输入主题 → 执行 → 14 阶段逐个完成 → `final.md` 产出（CDP 实测 + 真实 DeepSeek 全链路跑通：14/14 completed，final.md 为 AI 合成正文；`test_orchestration.py` 7 项 + FakeLLM 覆盖单飞/取消/SSE/降级路径）
- [x] 实时日志在 Studio 页面展示，各阶段耗时可见（SSE 事件 phase_start/log/phase_done/run_done；EventHub 带重放缓冲，事件在快速阶段完成前连接也能补回；前端常驻 EventSource 按 run_id 过滤）
- 修复记录：`_assemble` 缺 `await`（AI 合成失败走本地组装时抛 bytes-like 错误）；engine 误用 `ai.chat(str)` 传 messages 列表（新增 `AIRouter.chat_messages`）；run 目录需绝对路径（FileStore.resolve 将相对路径锚定到 data_dir，导致文件写偏 data/output/）；`read_run_file` 返回 PlainText 而前端 client 一律 `resp.json()`（新增 `api.getText`）

**非目标**：执行管道（Autarkeia 域）、Canvas、对话流

---

### Wave 1-3 回顾（2026-08-01）

> 对照本文件逐项核查 Wave 1-3 交付物，修复一致性问题并补齐缺口。

**修复清单**：

- 下载引擎：`_stream_range` 在 start=0 时发 `Range: {}` 头导致 httpx TypeError（已修：仅 start>0 才加 Range）；`DownloadService.describe` 的 GenericSource client 泄漏（已加 `finally: await client.aclose()`）；`_dest_for` 对带扩展名的 title_hint 重复拼后缀（`media.mp4.mp4`，已修：剥除 hint 扩展名）
- CRUD 契约：`BaseCrudService.update` 改为显式 fields dict（按 key 存在性 setattr，不再过滤 None → 可清空字段）；`delete` 改单 session（get→delete→commit，修复 asyncpg detached 实例删除不可靠）；三个实体子类 `update(**fields)` 直通；routers 按 key presence 构造 body
- 死代码清理：`DownloadWorkerPool.max_workers` 参数（从未使用）、`DownloadCancelledError`（从未 raise，取消走 asyncio.CancelledError）、前端未用 API（`crewsApi.create/update/remove`、`plansApi.defaults`、`studioApi.status/getRun`）
- 补齐文档声明但缺失的交付物：`scripts/verify.sh`（ruff + pytest + tsc + vitest + build 门禁）、`docker-compose.dev.yml`（dev Postgres）、`/api/logs/buffer` 路由（新增 `backend/routers/logs.py` + 测试）
- 测试隔离：`tests/conftest.py` 指向专用 `hertz_test` 库（session 级重建 schema），开发库不再被测试污染；单测恢复 registry 全局状态（cancel 测试恢复 `registry.ai`，download 测试 `_restore_download_state` autouse fixture 恢复 download_dir/url_checker）；临时文件改 `tmp_path`（消除 NamedTemporaryFile 泄漏）；`_prepare_database` 结束后 dispose engine（避免跨 loop 连接泄漏）
- 回归测试：`test_plan_crud_and_validation`（清空字段/缺省键不覆盖）、`test_unknown_length_streams_full_body`（unknown-length + Range 支持时不分片）、`test_logs_buffer`

**已知保留项**（有意为之，非缺陷）：

- `auth.py` 原语零接入：无用户管理，路由未加鉴权（Wave 6 系统性收口）
- ScheduleManager 零 job：当前无周期性任务
- health 的 llm 检查仅查 configured 标志，不做连通性探测（Wave 6 系统性健康检查范围）
- 后端无 `i18n.py`/`asr.py`/`reddit.py`：i18n 在前端；ASR 与 Reddit 属 Wave 5/Wave 4

**回归状态**：`pytest 37 passed` + `ruff` + `tsc` + `vitest 12 passed` + `vite build` 全绿

---

### Wave 4 回顾（2026-08-02）

> 执行域交付后对照 §5.7 核查，记录实现取舍与修复。

**实现取舍**：

- StepEngine 不继承 PipelineEngine：编排域无 pipeline 基类，`Pipe` 抽象（base.py）与 `_STEP_INDEX` 注册表对齐 orchestration/phases.py 既有模式；collect 为 batch-only（注册表不含）
- Reddit 采集单策略（公开 JSON 列表 API + cursor 增量），放弃 Autarkeia 的 OAuth/RSS/pullpush 多策略与 per-host 冷却——非目标范围内保持最小实现
- 无日预算/无 phash 去重：审核闸门前置（produce 后停，approve 才 publish），重复检测仅 (source, source_id)
- 发布目标可配置（`HERTZ_PIPELINE_PUBLISH_TARGET`，默认 `noop` 干跑）；Bilibili 走 biliup CLI + cookie 文件，credentials 缺失时 item 进入 failed 可 retry 而非 rejected
- `JobRun` 复用 `models/system.py`（job_runs 表）做任务审计，不新增表

**修复清单**：

- `engine.run_batch` 创建 JobRun 传了不存在的 `trigger=` 参数（未测试暴露，Wave 4 首个运行即崩）
- `service.recent_jobs` 序列化读取 `j.trigger`（JobRun 无此列，AttributeError）——已删
- `engine._process_item` 在 step 失败（result=None）时仍求值 `result.data`（try 只包 step.process，session 块崩出导致整个 job failed）——已加 `result.data if result else {}`，并清理 `error or result.error if result else error` 优先级陷阱
- `compose_video` 漏加输出路径参数（ffmpeg "At least one output file must be specified"）
- `_run_cmd` 错误截断取 stderr 头部（ffmpeg 报错在尾部，诊断困难）——改为取尾部 500 字符
- `steps/collect.py` `state.last_run_at = state.last_run_at` 自赋值笔误——改为 `datetime.now(UTC)`
- `service._serialize` 缺 `script_json`/`publish_json` 字段（前端审核面板无法展示）——已补
- ruff 0.16 新规则：ASYNC109（async 函数 timeout 参数改名 `timeout_s`）、ASYNC240（async 中 `Path.exists()`/`os.path` 改用 `await asyncio.to_thread(...)`）
- 迁移幂等化：`wave4_pipeline` 用 inspect 反射检查列/表存在性再 add（兼容 dev 库被 `Base.metadata.create_all` 超前的情况）
- 编排域测试适配：新增 `content_pipeline` phase 后 14→15 断言更新；`fake_ai` 注入空 `FakeRedditCollector` 防真实 Reddit 网络请求

**回归状态**：`pytest 42 passed`（+5 pipeline 用例）+ `ruff` + `tsc` + `vitest 12 passed` + `vite build` 全绿

---

### Wave 4：执行域

**目标**：内容采集→评分→下载→生产→审核→发布全流水线

**内容**：
- [x] `backend/pipeline/engine.py` StepEngine（继承 PipelineEngine 的 Pipe 抽象；本实现为独立 StepEngine，复用 `backend/pipeline/base.py` 的 Pipe/StepContext/ProcessResult/StepError）
- [x] `backend/pipeline/steps/` collect / score / download / produce / publish（步骤注册表 `steps/__init__.py`，collect 为 batch-only）
- [x] `backend/pipeline/collectors/` Reddit 采集适配器（公开 JSON API 单策略 + cursor 增量；`FakeRedditCollector` 供测试）
- [x] `backend/pipeline/producers/` AI 脚本/TTS/字幕/剪辑/封面（`producers/media.py`：启发式脚本兜底、edge-tts、SRT 时间分配、ffmpeg 720p 合成+字幕烧录+旁白混音、1s 封面帧；逐级优雅降级）
- [x] `backend/pipeline/publishers/` Bilibili 发布（biliup CLI + cookie；NoopPublisher 干跑；发布目标由 `HERTZ_PIPELINE_PUBLISH_TARGET` 配置）
- [x] `backend/models/item.py` Item 模型 + 状态机（discovered→scored→downloaded→queued→approved→published；rejected/failed 分支）
- [x] `backend/models/pipeline.py` SourceState（cursor/ok_count/fail_count 等，复用 `models/system.py` JobRun 做任务审计）
- [x] `backend/routers/pipeline.py` /api/pipeline/*（状态/步骤/审核队列/counts/approve/reject/retry/run/chain/cancel/jobs/sources/SSE events）
- [x] `backend/pipeline/service.py` PipelineService（单飞守卫 + 后台任务 + 查询序列化）
- [x] 前端 Console 页面（Pipeline 控制台 + 审核面板 + 状态看板 + SSE 实时事件）
- [x] 编排域 Phase → 执行域触发（`phases.py` 新增 `content_pipeline` system phase，run 时调 `run_chain` 至审核闸门，产物写入 `pipeline.md`）
- [x] 迁移 `alembic/versions/wave4_pipeline.py`（items 四列 + source_state 表；幂等实现，兼容已被 create_all 超前的库）

**验收**：
- [x] `tests/test_pipeline_engine.py` 5 用例：全链路链至审核闸门（真实本地 Range 服务器 + 真实 ffmpeg 合成）、approve/reject/retry 审核动作、任务与采集源记录、单飞守卫 409
- [x] 编排域回归：15 phase 全流程 run 中 content_pipeline 空链快速完成（fake collector 注入，零网络）
- [x] `scripts/verify.sh` 全绿（ruff → pytest 42 个 → tsc → vitest 12 → vite build）

**非目标**：Canvas、对话流、多平台发布

---

### Wave 5：Canvas + 对话流

**目标**：灵感画布和 AI 对话就绪

**内容**：
- [x] `frontend/src/core/` 语义相似度（char bigram/trigram cosine + 词重叠加权 + 数字前缀惩罚）、聚类（阈值建图 + 连通分量）、低语引擎（wake/ghost/prompt 三型，从 Revel 迁移）
- [x] `frontend/src/canvas/` Canvas 2D 渲染层：`chalk.ts` 粉笔质感（三通道抖动）、`physics.ts` 轻浮漂移（确定性正弦）、`background.ts` 黑板渐变 + 浮尘粒子、`renderer.ts` 连线绘制
- [x] `frontend/src/pages/canvas/` CanvasPage / Board / CardView / ToolDock / WhispersBar（卡片创建/编辑/拖拽/钉住/删除、连线模式、粉笔笔迹、低语每 5s 轮询、board 状态 zustand persist 至 localStorage）
- [x] Canvas 集成为 Studio 子面板（`StudioInspector` 可折叠侧栏：最近运行 final.md → 一键注入画布成卡片）+ 一键存为 Brief（briefsApi.create）
- [x] `backend/conversation/` 对话服务（`chat.py` + `history.py`，SSE 流式 token/done/error，DB 持久化多轮历史）
- [x] 前端 ChatPage 对话页面（`MessageList` 零依赖 Markdown 渲染、多轮交互、会话 CRUD、删除级联）

**验收**：
- [x] Canvas 上创建卡片、画连线（连线模式点两张卡片）、语义聚类、低语提示（wake 唤醒/ghost 幻影/prompt 提醒）正常工作
- [x] Canvas 内容可作为 Brief 输入（顶部「存为 Brief」按钮）
- [x] 对话页面发送消息 → AI 流式回复 → 对话历史保存（`tests/test_conversation.py` 6 用例验证 SSE 流、多轮历史组装、会话 CRUD、provider 故障落库 status=failed）
- [x] `alembic/versions/wave5_conversation.py` 幂等迁移（conversations + messages 表，FK 级联删除）已应用
- [x] `scripts/verify.sh` 全绿（ruff → pytest 48 个 → tsc → vitest 26 → vite build）

**实现取舍**：

- 相似度算法简化自 Revel：中文无分词器时用 char n-gram 兜底（bigram 0.3 + trigram 0.3 + 词重叠 0.4）；相同文本短路返回 1；共享前缀仅在数字分叉时惩罚（"第1章" vs "第10章"），避免同串/同前缀误伤
- 聚类为「阈值边 + BFS 连通分量」O(n²) 朴素实现；`useBoardClusters` 为纯函数（输入 cards → Map），无 memo 依赖
- 低语引擎沿用 Revel 三型：wake（30s 未触碰）、ghost（相似但未连线 >0.12，取最高）、prompt（35% 概率随机库）；已忽略的低语去重
- Canvas 卡片为 DOM（可编辑/拖拽/双击改文），连线/笔迹/背景走 canvas 2D；浮漂只作用于连线端点（卡片保持稳定可点）
- 对话服务按 Ametrine 设计砍掉 Milvus/Redis：仅 DB 持久化 + 最近 20 条窗口重组 prompt（HISTORY_WINDOW）；SSE 首行 `retry: 3000`
- `AIRouter.stream_chat` 新增（yield 分块），`ChatService` 双写持久化：user 消息先存、assistant 流完再存；provider 异常落库 status=failed 并返回 error 事件
- 前端 SSE 用 `fetch + ReadableStream` 逐行解析（非 EventSource，POST 长连接），支持 AbortController 中断

**修复清单**：

- `similarity.ts` 初版对相同文本误触发前缀惩罚（identical 得分 0.76）——加 normalize 后相等短路 + 仅数字分叉惩罚
- `test_conversation.py` 初版对 `Message.__table__.select()` 用 ORM 行解构（str 无 .role）——改用 `select(Message)` 显式实体映射
- ruff：`conversation/chat.py:65`、`history.py:60` 两处 E501 换行修复；`registry` 导入顺序 I001 自动整理

**回归状态**：`pytest 48 passed`（+6 对话用例）+ `ruff` + `tsc` + `vitest 26 passed` + `vite build` 全绿

**非目标**：Agent 工具调用（shell、playwright 等）、向量检索

---

### Wave 6：打磨与交付

**目标**：系统化健康检查、错误恢复、打包分发

**内容**：
- [x] 系统性健康检查（数据库、AI 三件套、ffmpeg/ffprobe/yt-dlp 工具链、磁盘空间）：`backend/infrastructure/health.py` 扩展 `check_tools`/`check_disk`，`/api/health` 分层报告；warning 不降级整体状态，error 才 degraded
- [x] 错误边界与优雅降级：前端 `ErrorBoundary`（零依赖类组件，崩溃不白屏 + 恢复入口）；后端全局异常处理器（`infrastructure/errors.py`：HertzError→400+code、校验→422+errors、未处理→500+日志）
- [x] electron-builder 打包配置（electron/package.json build 字段）：mac dmg/zip、win nsis、linux AppImage；extraResources 打包 backend（源码）与 frontend/dist（renderer）；`vite base: './'` 支持 file:// 加载
- [x] 打包版 Electron 主进程拉起后端（spawn `python3 -m uvicorn`，cwd=Resources/backend，轮询健康检查，失败弹窗降级；`HERTZ_BACKEND_URL` 可绕过）
- [x] 自动更新（electron-updater 通用源 `HERTZ_UPDATE_URL`，未配置静默跳过；下载完成弹窗重启安装）
- [x] 用户文档 `docs/USER_GUIDE.md`、决策记录 `docs/DECISIONS.md`（D-001~D-024）、路线图 `docs/ROADMAP.md`

**验收**：
- [x] `pnpm --filter hertz-electron build`（`electron-builder`）产出 `electron/release/mac-arm64/Hertz.app`，Resources 含 backend + renderer
- [x] `/api/health` 全检查项返回结构化状态；前端 ErrorBoundary 接入 App 根
- [x] `scripts/verify.sh` 全绿（ruff → pytest 52 → tsc → vitest 26 → vite build）

**实现取舍**（详见 docs/DECISIONS.md D-020~D-024）：

- 后端以源码形式随包分发（extraResources），依赖系统 Python + `uv sync` 的依赖；PyInstaller 固化列为 ROADMAP P0 缺口
- electron-builder 从 GitHub 下载 Electron 二进制在部分网络下超时——可用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 绕过
- 自动更新未配置更新源时静默，避免开发/离线环境噪音；发布通道搭建见 ROADMAP
- 异常处理器兜底不吞错：500 时记录完整堆栈，响应体保持机器可读结构

**回归状态**：`pytest 52 passed`（+4 健康/校验用例）+ `ruff` + `tsc` + `vitest 26 passed` + `vite build` + `electron-builder --dir` 打包成功

### Wave 6.5：Axiom 全局审计查漏补缺（2026-08-03）

对照 AXIOM 原则对后端/前端/文档做了三路审计，逐项修复：

**后端 P0（安全）**：
- [x] `studio.py read_file` 路径穿越 → `relative_to(workdir.resolve())` 约束（AXIOM §8.1）
- [x] `parser.py` URL 分类 SSRF → 域名白名单（`BILI_HOSTS`/`YT_HOSTS`）+ 静态 `is_public_http_url`（IP 字面量/localhost/`.local`/`.internal` 拒绝）；`generic.scan_page` 同入口（AXIOM §8.1）
- [x] `config.py` `secret_key` 默认清空 → 未配置时 auth 原语快速失败（AXIOM §8.2）

**后端 P1**：
- [x] `items.media_url` 落库：迁移 `wave6_audit`（media_url + `uq_items_source_source_id` 唯一约束，幂等）+ collect 持久化 + download 步骤 `media_url` 优先并过 DNS SSRF 检查（`pipeline_allow_loopback_urls` 测试逃生阀）
- [x] `registry.shutdown` 取消全部后台任务（studio/pipeline/download pool，`return_exceptions=True`）
- [x] `history.list_conversations` N+1 → 窗口函数单查询
- [x] 运行时配置真实生效：`RuntimeConfig`（mtime 缓存）+ `_EffectiveSettings` 读穿代理（AXIOM §22.3）

**后端 P2**：
- [x] `POST /pipeline/run` step 白名单（未知 → 422）；`POST /conversation/chat` message 1–8000（422）；`POST /library/projects` 重复 → 409；`create_task` 非法 UUID → 422

**前端**：
- [x] i18n 全量：`whisper.*`（文案移出 core，UI 层渲染）、`canvas.inspector.*`、`chat.*`、`error.*` 补齐，zh/en 键全量对齐（217×2）；Board/MessageList/WhispersBar/ErrorBoundary 去硬编码
- [x] ChatPage 双数据源竞态 → 单一本地消息源（react-query 仅会话切换时装载历史）
- [x] `useEventSource` hook：Console/Studio/Downloads 三处 SSE 断线自动重连（指数退避）
- [x] board store persist 节流（500ms 合并 + `beforeunload`/`visibilitychange` 强制落盘）；theme partialize 只存 `theme`
- [x] 移除未使用依赖 `@gsap/react`；DownloadsPage queryFn 副作用 → effect 装载；StudioPage 产物文件列表改由后端 `GET /runs/{id}/files` 提供（不再硬编码）

**接受项（记录在案）**：全 API 无鉴权（auth.py `get_current_subject` 零调用——桌面单用户场景接受，部署为服务时须接入）；`useQuery` isError 未逐页渲染错误 UI（列表失败显示空态 + 显式动作均有 toast 容错）。

**回归状态**：`pytest 53 passed`（+SSRF 白名单用例）+ `ruff` + `tsc` + `vitest 26 passed` + `vite build`

---

### Wave 6.6：二轮审计补足 + 文档 Tab + 桌面图标 + 一键启动（2026-08-03）

第二路审计（双子代理：后端 10 条 / 前端 10 条，逐行验证）后落地：

**后端 P0（安全）**：
- [x] `library.py` 路径围栏：`_allowed_roots()`（data/library + data/projects + 所有 Project.path 注册根）+ `_ensure_allowed()`（resolve 后 containment，越界 403）；手工验证 `/etc/passwd` → 403（AXIOM §8.1）
- [x] `generic.scan_page` SSRF 加固：`follow_redirects=False` + 每跳 `is_public_http_url` 再验（最多 5 跳）（AXIOM §8.1）

**后端 P1**：
- [x] `events.py publish` 仅在有订阅者时写历史（防无界增长）；迟到订阅者 replay 语义测试重写
- [x] `RuntimeConfig.save` 原子写：tmp + fsync + `os.replace`（AXIOM §22.3 防半写）
- [x] `edge_tts` 合成 `asyncio.wait_for(..., 60)` 超时（防挂起）
- [x] `score.py` 删除 `MIN_SCORE` 常量 → 读 `ctx.settings.pipeline_min_score`（配置单一来源）

**后端 P2**：
- [x] 死代码：`register_step`（注册表改用 `cls.name`）、`Pipe.key`/`output_status`、`config.py` 重复 `settings` 实例
- [x] 错误语义：新建 `pipeline/errors.py`（`PipelineError`/`ItemNotFoundError`/`InvalidItemStateError`），approve/reject/retry 抛类型化异常 → 路由映射 404/409（此前全 409）
- [x] `download/cancel` 持久化 PENDING→CANCELLED 且仅状态变化时 emit；`list_items` 用 `and_` 组合过滤（不再互相覆盖）
- [x] `orchestration._run_agent` 实现声明过的 `retries`：指数退避 `1.5 * 2**attempt`

**前端**：
- [x] API_BASE 三处重复（client/orchestration/DownloadsPage）→ 统一从 `client.ts` 导出；删 `thumbnailUrl`、`apiBase()`、`Tabs.tsx`、`theme/tokens.ts`（CSS 变量即单一来源）、`CLUSTER_COLORS`、`drawChalkText`、`useToastContext`、`setStrokeColor`
- [x] `useBoardClusters` 每次渲染新建 Map → `useMemo`（修复 WhispersBar 定时器反复重建）
- [x] Modal 去 gsap → Web Animations API（依赖清零，锁文件同步）；jsdom 无 `animate` 的防御
- [x] ConsolePage 轮询降频：SSE 兜底语义下 空闲 15s / 运行中 2s（AXIOM §7.2）
- [x] StudioInspector query `enabled: open`；MessageList 硬编码 → i18n（`chat.emptyTitle/emptyHint`、`canvas.connectMode`、`download.runningCount`、`library.projectsEmpty`、`briefs.placeholder`）
- [x] `renderMarkdown` 修复：列表 `<ul>` 包裹（原产出孤儿 `</ul>`）、`**bold**` → `<strong>`；转义在前故内容安全（AXIOM §22.2 注入面）

**新功能**：
- [x] 文档 Tab：后端 `GET /api/docs`（白名单索引：docs/*.md + HERTZ_RECONSTRUCTION.md + axiom.md）+ `GET /api/docs/content`（名称白名单 + symlink-safe containment，遍历 → 404）；前端 `DocsPage`（左侧文件列表 + 复用 `renderMarkdown`）+ nav `book` 图标 + 路由 `/docs` + i18n
- [x] 桌面图标：手绘 SVG（深靛蓝渐变圆角方块 + 靛紫波形与三个泛音点，隐喻「Hertz/频率」）→ qlmanage 渲染 1024 PNG → iconset → `iconutil` 产出 `electron/build/icon.icns`；electron-builder 自动接管打包版 Dock 图标，dev 模式 `main.ts` 显式 `icon`
- [x] 根目录 `./webui.sh`：PG 检查 → 建库 → 依赖 → 迁移 → 后端 :8787 + 前端 :3000（Web 模式，Ctrl+C 全停；完整桌面版仍走 `scripts/dev.sh`）

**回归状态**：`ruff` + `pytest 53 passed` + `tsc` + `vitest 26 passed` + `vite build` 全绿；docs 路由手工验证（index/内容/遍历 404）

---

### Wave 6.7：UI 布局统一 + 设置系统 + 下载页 + 文件浏览修复（2026-08-03）

**布局**：
- [x] 顶部 Header 删除：窗口控制（红黄绿）移到侧栏顶部（macOS 习惯位置），应用名 "Hertz" 移到侧栏最底部（BrandName）；`Header` 组件删除
- [x] 全页面滚动条统一：`main` 层 `overflow-hidden`（最外层永无滚动条），所有溢出内容在各卡片内部 `overflow-y-auto`——Plans 工序库（palette 列 `flex-1` 内滚）、Studio/Console/Briefs 外层滚动全部移除

**下载页**：
- [x] 布局改为左右分栏：左 384px 解析卡片（URL 大输入 + 封面图 + 标题/UP主/时长 + 格式选择 + 开始），右任务列表占满
- [x] 解析结果展示封面（`ParseResult.thumbnail`，加载失败自动隐藏）；进度条去掉 `max-w-64` 限制占满整行
- [x] 外层滚动移除（任务列表内部滚动）

**设置系统（替代空占位）**：
- [x] 后端：`Settings.tts_voice`（HeartStone 音色配置）；`RUNTIME_ALLOWLIST` 扩展（base_url/model/tts_voice/pipeline_*）；`deepseek_api_key` 可写（本地 runtime.yaml）但 GET 只返回 masked（`deepseek_api_key_masked` + `_set`）；pipeline TTS voice 改读配置（auto → en-US-AriaNeural）
- [x] 前端 `SettingsPage`：通用（语言 zh/en 持久化 + 主题）、AI（LLM/API key masked/Base URL/模型/ComfyUI/TTS 音色 5 选）、路径（data/output/log）、流水线（评分/采集上限/发布目标）四段表单，PATCH 保存 + refetch
- [x] `PlaceholderPage` 删除；语言切换持久化 `hertz-lang`

**文件浏览修复**：
- [x] 根因：`_ensure_allowed` 返回 anyio `APath`（`iterdir()` 异步），`LibraryBrowser.scan` 同步 `sorted()` 直接 500 → 文件列表永远空/报错
- [x] 修复：resolve 后转回 stdlib `Path`，scan/info/thumbnail/file 全链路恢复（实测返回 4 类文件 + 缩略图 + 流式服务）

**回归状态**：`ruff` + `pytest 53 passed` + `tsc` + `vitest 26 passed` + `vite build` 全绿；config PATCH（200/400 白名单）、library scan/file 实测通过

---

### Wave 6.8：参考仓库补足（HeartStone / Revel / Autarkeia / Mojito）（2026-08-03）

四路子代理审计 reference_repo 五个项目后，按 Hertz 架构逐项落地：

**Canvas（Revel 对齐）**：
- [x] 预制图形工具：rect/ellipse/line 拖拽绘制（`canvas/stroke.ts shapePoints`，折线点列复用粉笔渲染）；此前 rect/ellipse 是空壳
- [x] 逐笔擦除：`distanceToStroke` 半径 16px 命中检测，拖拽连续擦除（替代"点空白清空全部"）；RDP 抽稀（`simplifyStroke`）控制笔迹点数
- [x] 快捷键系统（`hooks/useKeyboard.ts`）：P/E/U/O/L/R/1·2·3/方向键(±Shift)/Backspace/Esc/⌘E 导出/⌘G 聚类
- [x] 选中聚焦：点击选中（缩放 1.04 + 粉红描边）、其余卡片变暗 0.38、Top-4 相似建议边（琥珀虚线）、连线选中高亮 + 沿线流动光点
- [x] 粉笔确定性：抖动改为种子 LCG（同笔迹每帧一致不闪烁）+ 已提交笔迹离屏 canvas 缓存（仅变化时重绘）
- [x] 聚类可视化：簇色条（顶部彩条 + 发光）+ ⌘G 开关；卡片宽度随内容自适应
- [x] 导入导出：⌘E 导出 `.hertz.json`（整板）、文件选择导入（校验 + 容错）、清空板（confirm）、R 随机重排
- [x] 图层面板（`LayersPanel`）：新建/激活/可见性/重命名/删除，新卡进激活层；粉笔三色（白/黄/青）工具坞色点

**下载/桌面（HeartStone 对齐）**：
- [x] 剪贴板监听（主进程 1.5s 轮询）：命中 B站/YouTube 链接 → 系统通知 → 点击唤起窗口回填 URL 并自动解析
- [x] 下载完成系统通知（`notify:download-done`，SSE completed 事件触发）
- [x] 窗口位置记忆：`userData/window-bounds.json`（resize/move 400ms 节流 + close 落盘），重启恢复
- [x] 素材库增强：分类 Tab（6 类带计数）、排序（名称/大小/日期 + 方向）、网格/列表双视图

**流水线质量（Autarkeia / Mojito 对齐）**：
- [x] 智能封面选帧：`thumbnails.py` 抽 4 个时间点 + signalstats YAVG 评分选居中亮度帧（跳过黑/白帧），纯 ffmpeg 无新依赖
- [x] ASS 淡入字幕：`srt_to_ass`（\fad(200,200)）+ compose 改烧 ASS（失败回退 SRT）
- [x] BGM/SFX 混音：`compose_video` 音频链升级——原声被旁白 `sidechaincompress` duck（threshold 0.04/ratio 6）+ 旁白混入；`data/assets/bgm/` 存在音频文件则 0.10 铺底
- [x] 敏感词合规门禁（`pipeline/sensitive.py`，Mojito heritage）：Tier1 违禁词阻断产出（ProducerError）、Tier2/3 告警、`redact` 脱敏；produce 时自动检查脚本
- [x] ComfyUI 连接测试：`POST /api/config/comfyui/test`（TCP → /system_stats 三级探测 + 中文错误），Settings 页"测试连接"按钮
- [x] 设置系统补足（Wave 6.7 续）：TTS 音色、路径、流水线参数、secret masked

**已知缺口（记录在案）**：评分日预算（LLM 成本控制）、采集策略链（OAuth/RSS）、JobRun 审计表、多语区本地化——需 biliup/新表/多源，列为 ROADMAP。

**回归状态**：`ruff` + `pytest 53 passed` + `tsc` + `vitest 26 passed` + `vite build` 全绿；敏感词/封面选帧/ComfyUI 测试手工验证

---

### Wave 6.9：素材中心（Assets Hub）+ 全局锋利 UI（2026-08-03）

**设计决策**：下载与资源库合并为单一「素材」视图——下载任务 = 「正在进入资源库的素材」，任务完成就地蜕变为可预览素材，全程零跳转。

**AssetsPage（`/assets`，替代 downloads + library 两页）**：
- [x] 左侧项目树（roots + 递归目录，激活项 primary 左边线）；底部显示当前路径
- [x] 顶栏：标题 + ⌘K 搜索框 + 「下载」按钮；分类胶囊（全部/进行中/图片/视频/音频/文档/其他，带实时计数）
- [x] 素材网格与下载任务同构：进行中任务（进度条 + 速度字节数 + 取消）置顶，完成文件以缩略图卡片呈现；点击卡片预览，双击进入目录
- [x] 下载抽屉（Modal）：URL → 解析 → 封面/标题/时长/格式 → 「开始下载」；多资产页勾选批量下载；SSE 实时进度
- [x] 预览浮层：图片/视频/音频内嵌播放、文档（md/txt 等）文本直读显示（≤20KB）、元数据（编码/分辨率/时长）+ Finder/删除
- [x] 右键菜单：在 Finder 显示 / 复制路径 / 删除（新后端 `DELETE /api/library/file`，围栏内 + 连带缩略图）
- [x] 键盘：⌘K 聚焦搜索、⌘N 新下载、Esc 关浮层
- [x] 侧栏 10 项 → 9 项（downloads + library 合并为 assets）；旧两页删除

**全局锋利 UI（无圆角、边缘锋利、动效利落）**：
- [x] 全站清除 `rounded-*` 类（83 处）与 CSS `border-radius`——按钮/卡片/输入/胶囊/色点/交通灯全部直角
- [x] Modal 入场动效改为 100ms ease-out 直线淡入 + 4px 上移（去回弹 overshoot，Web Animations API 零依赖——§6.1）
- [x] 分类胶囊改直角边框按钮（选中 = 主色实边 + 浅底）；右键菜单直角；卡片 hover 硬边过渡
- [x] 画布/黑板视觉保留（内容域不受 chrome 约束）

**回归状态**：`ruff` + `pytest 53 passed` + `tsc` + `vitest 26 passed` + `vite build` 全绿；scan/file/health 实测通过

---

### Wave 6.10：无边框窗口 + 侧栏分组 + 文档并入素材（2026-08-03）

- [x] **无边框窗口**：`frame: false`（去掉系统标题栏），侧栏顶部 40px 设为 `-webkit-app-region: drag` 拖拽区、内部红黄绿按钮 `no-drag`——窗口可拖拽且保留自绘窗口控制（不重复、不缺失）
- [x] **侧栏功能分组**：NavItem 加 `group`，按 创作（画布/Studio/对话）→ 生产（控制台/策略/编排）→ 素材 → 系统（设置）四组渲染，组间分隔线——不再平铺堆叠
- [x] **文档并入素材**：Assets 左侧栏加「素材/文档」双 Tab；文档 Tab 列出 docsApi 白名单文档（含 HERTZ_RECONSTRUCTION/axiom），点击在 markdown 渲染浮层阅读（复用 renderMarkdown）；`/docs` 路由与 DocsPage 删除——Assets 成为系统唯一出口
- [x] 侧栏 9 项 → 8 项（docs 移除）

**回归状态**：`ruff` + `pytest 53 passed` + `tsc` + `vitest 26 passed` + `vite build` 全绿

---

### Wave 6.11：琥珀主题 + 全局窗口条 + 页面过渡 + Studio 居中 + 画布背景（2026-08-03）

- [x] **主题色蓝 → 琥珀金**：`--hz-primary` 从 indigo（#6366f1/#818cf8）改为琥珀（light #d97706 / dark #f59e0b，hover 亮一级）——创作工具经典强调色，避开蓝色审美疲劳；primary 按钮文字改深色 #1c1917（琥珀底白字对比不足）
- [x] **全局窗口条（40px 与红绿灯同高）**：无边框窗口下内容区顶部加统一 header——左侧当前页标题（对齐侧栏红绿灯行）、整条可拖拽、右侧主题切换（自 footer 上移）；footer 仅剩 BrandName；红绿灯与内容首行完全齐平，错位消除
- [x] **页面级过渡**（`PageTransition`，WAAPI 零依赖）：路由切换 220ms 位移淡入 + 顶部一道主色线从左到右"擦拭"后淡出——利落有节奏；Remotion 是视频渲染库，不适合运行时 UI 动画，故以同等效果轻量实现（AXIOM §6.1）
- [x] **Studio 精简**：移除「计划」Select（固定使用第一个启用的 plan，顶部小字提示当前计划名）；主题输入 + 开始执行整体居中（min-w-40 按钮）
- [x] **素材 icon**：downloads → box（立方体）
- [x] **画布背景**：Revel 墨绿黑板 → 深灰黑径向渐变（#1b1b20 → #0f0f13），浮尘微白保留——与全局主题融为一体

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` + `ruff` + `pytest 53 passed` 全绿

---

### Wave 6.12：单色中性主题 + 过渡去抖动（2026-08-03）

- [x] **主题色改为单色中性系统**（Vercel/Linear 企业风）：primary 从琥珀改为浅色强调——暗色下「冰白」#e4e4e7（hover #fafafa）、亮色下深灰 #27272a（hover #18181b）；新增 `--hz-on-primary` token（暗色深字/亮色白字），按钮文字自适应，两种模式都舒适
- [x] **过渡去抖动**：PageTransition 去掉内容 `translateY` 位移（位移叠加内容重排是抖动根源），只保留 200ms 纯淡入；顶部主色细线改 `translateX` 从左端滑到右端（300ms ease-in-out）后淡出——快门扫过感，transform 只作用于线、不触碰内容布局

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` 全绿

---

### Wave 6.13：窗口控制归位 header（2026-08-03）

- [x] 红绿灯从侧栏顶移到全局窗口条左侧（header 首元素，no-drag）；标题紧随其后，中间整条可拖拽
- [x] 侧栏清理：删除残留的第二个主题切换按钮（footer 只留 BrandName）、移除拖拽区与 top 槽位——侧栏 = 纯导航分组 + 品牌名
- [x] 主题切换唯一入口：header 右侧

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` 全绿

---

### Wave 6.14：Studio 执行台重设计（产品级）（2026-08-03）

针对"玩具感"诊断重构 Studio 页：

- [x] **恢复方案选择**：Plan Select 回归（含"选择编排方案"空项），下方方案摘要（工序数 · 模式 · 描述）——选择有信息量，不再是空选项
- [x] **执行控制台结构**：标题行（图标 + 标题 + 运行/空闲状态徽章）→ 三列布局（方案 | 主题输入 | 主操作按钮 h-10 min-w-40）；运行中主按钮切换为「停止」
- [x] **运行进度条**：进行中显示当前阶段名 + 序号 + 脉动进度条（新增面板）
- [x] **日志终端化**：深底（surface-2/50）+ 每行时间戳 + 行 hover 高亮 + 行数统计；done 行粗体错误色、agent 行次级色、phase 行主色
- [x] **工序时间线**：垂直节点线（状态色点：running 脉动 primary/success/error/disabled）+ 连接竖线 + 状态小字——取代 Badge 堆叠
- [x] **运行历史**独立卡片（max-h 内滚）；产物文件 tab 改直角边框样式（选中主色边 + 浅底）、等宽字体

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` + `ruff` + `pytest 53 passed` 全绿

---

### Wave 6.15：素材闭环 + AI 配置专业化 + 编排三合一（2026-08-03）

**素材闭环（下载 → 素材可见）**：
- [x] 下载目录 `data/downloads` 加入库围栏（_allowed_roots）；`/api/library/roots` 新增 `downloads` 字段；素材左侧树固定「下载」入口节点（下载的文件直接可见、可预览、可管理）
- [x] 点击交互分层：**图像区点击 = 快速预览**（图片大图 object-contain、视频/音频 autoPlay 直接播放、文档文本直读，底部一行大小信息）；**名称点击 = 详情**（元数据/在 Finder 显示/删除）——不再"先详情再播放"两步

**AI 服务专业化（Settings）**：
- [x] 后端：LLM 通用化——`OpenAICompatProvider`（deepseek/openai/ollama/xinference 四家 OpenAI 兼容协议单实现，删 DeepSeekProvider）；`llm_provider/llm_base_url/llm_model/llm_api_key` 字段 + 各 provider 默认值表；`POST /api/config/llm/test` 真实连通测试（构建 provider 发最小请求，返回模型回复）；修复 config 路由双前缀 bug（/api/config/llm/test 此前 404）
- [x] 前端：AI 服务拆三卡（LLM/图像/TTS），每卡 = 图标标题 + 配置状态徽章 + 引导文案；LLM：provider 下拉（带描述）→ 模型 **Select 预设**（不再自由输入，防误配）+ base_url 自动联动默认 + API key masked + 测试按钮显示模型实际回复；ollama/xinference 自动隐藏 key 输入

**编排三合一（Plans）**：
- [x] 左侧三 Tab：计划 / 简报 / 班底；「新建…」分支菜单（新建计划/简报/班底，点击即切换并创建）
- [x] 班底 CRUD 完整落地（此前仅 Select 引用）：名称/描述编辑 + 成员只读清单（key/role）+ 删除；简报编辑（名称/平台/Markdown 内容 + 字数统计）从独立页并入
- [x] `BriefsPage` 删除，侧栏 8 → 7 项（briefs 移除，plans 一个入口管三种资产）

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` + `ruff` + `pytest 53 passed` 全绿；roots/downloads 字段、LLM 测试（200/404 修复）实测

---

### Wave 6.16：下载无声修复 + 下载条内联化（2026-08-03）

**无声根因与修复**：
- [x] `DownloadService._execute` 对 B站/YouTube 下载 **audio_id 恒传 None**——DASH 纯视频流从不合并音轨 → 成片无声
- [x] 修复：`build_formats` 给每个格式加 `muxed`（是否含音轨）标记；`_execute` 单次 describe 完成格式协商——选中格式无音轨时自动并入 `best_audio_id` 合并（`-f video+audio` + merge mp4）；有音轨的 muxed 格式不重复合并

**下载流程内联化（融进素材视图）**：
- [x] 「下载」按钮 → 素材页顶栏下方展开 **inline 下载条**（不再弹 Modal）：打开即聚焦输入框，粘贴链接回车即解析
- [x] 解析结果直接内联：视频类 = 封面 160×90 + 标题/UP主/时长 + 格式 Select + 开始按钮（同一行）；页面类 = 资源勾选列表
- [x] 开始后下载条自动收起，任务立即出现在「进行中」区——粘贴 → 解析 → 封面 → 开始全程不离开素材视图

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` + `ruff` + `pytest 53 passed` 全绿

---

### Wave 6.17：下载记录视图 + 画质档位 + 文件名=标题 + 封面闭环（2026-08-03，HeartStone 对齐）

- [x] **画质档位（每分辨率一个选项）**：后端 `quality_options` 按分辨率去重取最优视频流（带音轨优先 → 高码率优先），解析返回 `qualities`：1080P/720P/480P/360P + 仅音频——不再同一分辨率三个可选项（video-only/muxed/编码差异）；实测 B站真实解析输出 4 档 + 音频
- [x] **下载记录视图**：分类胶囊新增「任务」（计数=全部任务）：HeartStone 风格任务列表——封面缩略图 + 标题 + 进度条 + 字节数 + 状态徽章 + 操作（取消/重试/在 Finder 显示/删除），按创建时间倒序
- [x] **开始下载即跳记录**：点开始后下载条收起并自动切到「任务」视图——"下载已开始"与"看见下载记录"同时发生
- [x] **文件名 = 解析标题**：create_task 接受 title → `title_hint`（文件名来源），不再是 Bilibili/YouTube 默认名；后端 describe 兜底更新
- [x] **封面闭环**：解析时展示封面（inline 条已有）；下载完成后抓取封面存 `<文件>.thumb.jpg` sidecar（HeartStone 模式）→ 任务列表封面 + 素材网格缩略图 + 预览全部可见

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` + `ruff` + `pytest 53 passed` 全绿；真实 B站解析（画质档位/封面）实测

---

### Wave 6.18：画布×对话 静态动态叠加 + 输出目录 bug 修复（2026-08-03）

**Canvas Chat（画布与对话系统融合）**：
- [x] 画布右侧新增「对话」面板（与图层/低语/Studio 产物并列）：流式对话 + 历史加载
- [x] **静态叠加（画布→LLM）**：发送时自动注入画布上下文——卡片内容 + 连线关系 + 相似关系（`canvasContext()`），经后端 `chat` 新 `context` 字段作为本轮 system 参考，**不落库**（避免污染历史）
- [x] **动态叠加（LLM→画布）**：每条回复下方「添加到画布」按钮——回复按行拆块一键物化为画布卡片（动态思维回流为静态结构）
- [x] **会话绑定画板**：`board.conversationId` 持久化（随板存储），同一块板永远回到同一段对话
- [x] **本地历史**：沿用 Wave 5 DB 持久化（PostgreSQL 本地存储会话/消息全量历史，`/api/conversation` CRUD）

**「run output directory not found」修复**：
- [x] 根因：`run_dir` 用 `Path(output_dir).resolve()`——**cwd 相关**；设置页改过 output_dir 或 Electron 打包启动（cwd=resources/backend）时，历史 run 目录"消失"
- [x] 修复：FileStore 新增 `output_root()`（相对路径锚定 data_dir，cwd 无关），engine/studio 统一使用
- [x] 防御降级：`list_files` 目录不存在返回空列表而非 404 刷屏（历史 run 被移动/清理时 UI 正常降级）

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` + `ruff` + `pytest 53 passed` 全绿

---

### Wave 6.19：素材系统 → Tag 系统（路径解析 → 标签组织）（2026-08-03）

**架构转变**：素材空间 = 设置里指定的数据目录（data_dir 根），不再是固定文件夹（projects/library/downloads）解析。

- [x] **围栏改为 data_dir 根**：`_allowed_roots` 只含 data_dir（+ 注册项目）；scan 默认根目录；运行时文件过滤（runtime.yaml/.DS_Store/隐藏文件/临时文件）
- [x] **下载直达素材根**：`download_dir` 改为 `settings.data_dir`——下载的文件直接落在素材空间
- [x] **Tag sidecar（素材第一公民）**：`<name>.meta.json`（HeartStone meta 模式）：下载完成自动写 `tags: [download, bilibili/youtube]` + title/url/时间；scan 读 sidecar 合并进条目（tags 字段）
- [x] **打标 API**：`POST /api/library/tags`（围栏内 + sidecar 合并写）
- [x] **左侧 Tag 视图**（替代项目树）：全部（计数）+ 各 tag 按出现次数排序（计数）；目录树删除
- [x] **卡片 Tag 徽章**：素材卡片左上角显示前 2 个 tag（黑底毛玻璃）
- [x] **右键「标记…」**：弹打标 Modal（输入框 + 快捷 chips：download/bilibili/youtube/精选/草稿 + 保存）
- [x] 素材默认落在 data_dir 根（roots 新增 `root` 字段）

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` + `ruff` + `pytest 53 passed` 全绿；scan 根/tag 写入/运行时过滤实测

---

### Wave 6.20：砍对话、画布打通流水线（产品决策落地，奥卡姆剃刀）（2026-08-03）

**产品决策**（用户主导）：内置对话与 DeepSeek 网页版无差异化 → 判定伪需求砍掉；画布定位为流水线输入端保留。

- [x] **砍对话**：前端删 ChatPage/CanvasChat/MessageList/conversationApi/路由/nav 项/icon/i18n chat.*；后端删 routers/conversation.py、conversation/ 包、models/conversation.py、registry 引用、test_conversation.py；`renderMarkdown` 提取至 `utils/markdown.ts`（Docs/Studio 共用）；DB 表保留（数据不迁移）；`/api/conversation` 实测已移除；侧栏 6 项
- [x] **画布 → Studio 一键运行**：画布顶栏「在 Studio 中创作」按钮——卡片内容组装成创作主题（板名 + 卡片清单），跳转 Studio 自动开跑流水线；Studio 读取草稿（localStorage 一次性）预填并执行（run 重构为 runWith(topic, planId) 参数化）
- [x] 画布成为流水线输入端：想法在画布结构化 → 一键成为创作主题 → Studio 跑完整流水线

**回归状态**：`ruff` + `pytest 47 passed`（-6 对话测试）+ `tsc` + `vitest 26 passed` + `vite build` 全绿；conversation 端点实测移除

---

### Wave 6.21：画布轻量化（点击即创建 / 主题化背景 / 砍冗余）（2026-08-03）

- [x] **点击画布任意处直接创建卡片**：write 工具下点空白 → 卡片落在点击位置并**自动进入编辑**（不再需要先点「新卡片」按钮）；双击已有卡片照常编辑
- [x] **背景随主题**：`drawBackground` 读 CSS 变量——light = 白系径向渐变（surface-1 → bg）、dark = 深灰黑；浮尘色随主题（dark 白 / light 灰）——白天拖动不再闪黑（此前 light 模式也是黑底导致视觉闪烁）
- [x] **删图层**：Photoshop 概念不适合轻量灵感画布——LayersPanel 组件、store 图层方法、顶栏按钮全删（board.layers 数据结构保留兼容旧持久化数据）
- [x] **删导入/导出**：exportBoard/importBoardFile/⌘E/文件选择全部移除（自动持久化即历史）
- [x] **删画布标题输入**：顶栏不再显示标题编辑框，画布区域最大化；顶栏仅剩 重排/清空/在 Studio 中创作/聚类/存为简报/Studio 产物/低语
- [x] **低语提示语扩充**：6 → 12 条发散思考提示（换位受众/风险/拆解/反直觉假设/反向想法等）

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` 全绿

---

# Wave 7.0：执行工作台（Execution Workspace）——Studio × Console 融合重构（2026-08-03）

**大版本重构**：两个同构页面（重复约 70%）抽象为「执行工作台」，共享组件层 + 域适配层。

**抽象组件层**（`frontend/src/components/execution/`，6 个可复用组件）：
- [x] `CommandDeck` — 执行控制台骨架（标题行+状态徽章+参数区+主操作按钮）
- [x] `Terminal` — 实时日志终端（时间戳/类型着色/自动滚动/行数/流式指示，两域共用同一实现）
- [x] `StatusTimeline` — 状态时间线（色点+连线+状态小字，Studio 工序通用化）
- [x] `HistoryList` — 历史列表（状态徽章+选中高亮，runs/jobs 通用化）
- [x] `SectionCard` — 带标题卡片容器（消除 6 处重复标题行）
- [x] `ProgressStrip` — 运行进度条（阶段+序号+脉动）

**域适配层**（hooks 抽取，页面逻辑零改动迁移）：
- [x] `useStudioExecution`：plans/run/events/日志/工序/runs/files + 画布草稿自动开跑
- [x] `usePipelineExecution`：status/steps/items/jobs/sources/轮询策略 + run/stop/act
- [x] 不做超接口抽象（审核操作与产物文件语义差异大——奥卡姆）

**融合页面 `ExecutionPage`（/execution）**：
- [x] 模式 Tab（Studio 编排 / 内容流水线），URL 参数记忆（?mode=），切换模式不互清日志
- [x] 统一布局：Deck → ProgressStrip → grid（Terminal | 状态栏）→ 域专属视图（Studio=产物文件预览 / Pipeline=审核队列表格+计数+数据源）
- [x] 全页遵循布局规范：外层 overflow-hidden、内部滚动、直角锋利、浅色强调、i18n、QueryErrorState

**路由与侧栏**：
- [x] 侧栏 5 项（console+studio 合并为「执行」）；旧 /studio、/console 重定向 /execution?mode=；画布「在 Studio 中创作」跳 /execution?mode=studio
- [x] 旧 StudioPage/ConsolePage 删除（git 可回溯）

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` + `ruff` + `pytest 47 passed` 全绿

---

### Wave 7.1：质量门禁动态化 + 画布 NLP 灵感重组 + 幽灵去重（2026-08-03）

- [x] **质量门禁按 plan 动态检查**：`_quality_gate` 不再硬编码 writer/visual_director——按实际启用阶段检查产物（agent → `{key}.md`；system → preflight.md/brief.md；content_pipeline 桥接阶段不要求）
- [x] **执行工作台布局修正**：Studio 模式三列横向（实时日志 | 阶段状态 | 运行记录）；进度条真实完成度（completed/total% 替代固定全满——修复白天全黑/夜晚全白误觉）；产物文件改名称列表 + 点击弹窗预览（refreshFile 返回内容）
- [x] **画布 NLP 灵感重组**（新依赖 jieba）：`POST /api/canvas/remix`——jieba.posseg 词性标注（名词/动词/形容词/副词词池）→ 7 种组合模板随机生成 10 条候选 + 每卡词性概览 + 词池展示；画布顶栏 wand 按钮 → RemixModal（候选列表一键添加为卡片）
- [x] **幽灵去重（重复提示 bug）**：ghost 去重从「单卡」改为「对」（cardId|peer）——同一相似对（含反向）只提示一次；新增 `ghostSeen` 累积（dismiss 后也不再重复提示该对）

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` + `ruff` + `pytest 47 passed` 全绿；remix 真实请求实测

---

### Wave 7.2：执行状态缓存 + 日志/历史融合 + 产物入素材 + 采集网络韧性（2026-08-03）

- [x] **执行状态缓存**：Studio/Pipeline 状态提升至 `stores/execution.ts`（zustand）——切换 tab/离开页面再回来，日志、工序状态、运行中、参数全部保留；SSE 事件用 `getState()` 读最新值防闭包覆盖
- [x] **运行记录融入实时日志**：Terminal 新增 `bottom` 区域——Studio 运行历史渲染在终端卡片底部（横向 chip 列表：状态徽章 + 主题，选中高亮），不再独立遮挡日志；修复日志被遮挡的布局（Terminal `flex-1` 撑满）
- [x] **产物入素材（素材 = 系统资源管理）**：pipeline 产物目录修复 cwd 依赖（`_artifacts_dir` → `output_root()`，产物 = `data/output/pipeline/<id>/`）；roots 新增 `output` 字段；素材左侧树加「产物」固定入口（Studio/流水线产物全可见）
- [x] **采集网络韧性（内容创作报错修复）**：`RedditCollector` 支持 **macOS 系统代理**（urllib.getproxies 喂给 httpx——此前 httpx 只认环境变量，墙内访问必 ConnectError）；collect 网络错误优雅降级（标记 failed + 友好提示，流水线继续）

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` + `ruff` + `pytest 47 passed` 全绿

---

### Wave 7.3：工序可维护 + 词库可维护 + 编排布局 + 去平台依赖 + 启动自愈（2026-08-03）

- [x] **工序 CRUD（工序库可维护）**：新表 `phases`（迁移 wave7_phases）；`PhasesService` 懒种子内置工序（builtin 只读保护）+ 自定义 agent 工序全量增删改；engine 工序索引动态化（`engine.phases` 注入，内置回退）；`/api/phases` CRUD + `GET /api/plans/phases` 改走 service；自定义工序 = LLM 驱动产出 `{key}.md`
- [x] **编排布局**：左侧「编排」独占一行（应用层级最高），下方三个按钮：**工序 / 策略 / 班底**（策略=原简报，文案统一替换"简报"→"策略"）；各列表自带新建按钮
- [x] **去平台依赖**：`content_pipeline`（触发 Reddit 采集的桥接工序）默认禁用——Studio 编排不依赖平台，除非在工序中显式启用
- [x] **词库可维护（灵感重组）**：内置结构性词库（连接词/介词/助词/形容词/宾语意象）+ `data/wordbank.json` 用户覆盖合并；remix 模板扩展（名词+介词+名词+动词 等 5 个新结构）；前端 RemixModal 加「词库」管理面板（五类词逗号分隔编辑 + 保存）
- [x] **webui.sh 启动自愈**：启动前检查 3000/8787 端口占用并自动 kill（修复 "Port 3000 is already in use"）

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` + `ruff` + `pytest 47 passed` 全绿；phases/wordbank API 实测

---

### Wave 7.4：产物"等待执行"修复 + 产物与阶段状态融合 + 测试库隔离（2026-08-03）

- [x] **产物读不到（"等待执行"）双根因修复**：
  - 旧产物目录迁移：Wave 6.18 前产物在 cwd 下 `output/studio/<id>`（cwd 解析），新代码锚定 `data/output/studio/<id>`——启动时 `_migrate_legacy_output()` 一次性搬移旧目录（幂等，实测 7 个目录归位）
  - **测试污染主库**：`tests/conftest.py` 设的是 `DATABASE_URL`，项目 env 前缀是 `HERTZ_`——测试实际连主库，每次 pytest 批量创建假 run（产物在临时目录）→ 用户看到"completed" run 永远点不开；修复前缀为 `HERTZ_DATABASE_URL`（测试真正隔离到 hertz_test）+ 清理主库污染 run（实测 pytest 后主库 run=0）
  - 前端去掉硬编码 fallback 文件列表（猜测的文件名永远点不开）——产物只来自后端权威清单；空时显示 run 实际状态
- [x] **产物文件与阶段状态融合**：产物文件列表嵌入阶段状态卡片底部（StatusSteps 新增 bottom 区域）——同一卡片内：横向步骤条 + 分隔线 + 产物 chips（点击弹窗预览）；独立产物 SectionCard 删除

**回归状态**：`tsc` + `vitest 26 passed` + `vite build` + `ruff` + `pytest 47 passed` 全绿；主库无污染、迁移实测

---

## 十、验证门禁

> AXIOM §4.7：交付前应满足：构建、集成测试、关键 lint、手动验收路径

### 10.1 每轮波次的通用门禁

```
[ ] pyproject.toml + package.json 依赖无冲突
[ ] uv.lock + pnpm-lock.yaml 同步
[ ] ruff check 通过
[ ] biome check 通过
[ ] pytest 全部通过
[ ] vitest 全部通过
[ ] 后端 build（FastAPI 导入无错误）
[ ] 前端 build（vite build 成功）
[ ] Electron 启动不崩溃
[ ] 手动验收路径走通
[ ] 非目标未膨胀
```

### 10.2 门禁脚本

```bash
# scripts/verify.sh（已实现，2026-08-01）
#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)" && cd "$ROOT"
echo "==> [1/5] backend lint (ruff)" && uv run ruff check backend tests
echo "==> [2/5] backend tests (pytest)" && uv run pytest -q
echo "==> [3/5] frontend typecheck (tsc)" && pnpm --filter hertz-frontend typecheck
echo "==> [4/5] frontend tests (vitest)" && pnpm --filter hertz-frontend test
echo "==> [5/5] frontend build (vite)" && pnpm --filter hertz-frontend build
echo "==> ALL GATES PASSED"
```

---

## 十一、开发环境

### 11.1 前置依赖

| 工具 | 检查命令 | 备注 |
|------|----------|------|
| Python 3.12+ | `python --version` | |
| uv | `uv --version` | Python 包管理 |
| Node.js 22+ | `node --version` | |
| pnpm | `pnpm --version` | |
| PostgreSQL | `pg_isready` | 或 Docker |
| ffmpeg | `ffmpeg -version` | 媒体处理 |
| yt-dlp | `yt-dlp --version` | B站/YouTube 下载 |
| ComfyUI | `curl http://127.0.0.1:8188/` | 图像生成（可选，仅图片功能需要） |

### 11.2 一键启动

```bash
# scripts/dev.sh
#!/bin/bash
# 启动 PostgreSQL（如用 Docker）
docker compose -f docker-compose.dev.yml up -d postgres

# 初始化数据库（复数 heads——仓库多 head 现状，单数 head 会被 alembic 拒绝）
cd backend && uv run alembic upgrade heads && cd ..

# 并行启动后端 + 前端 + Electron
uv run -m backend.main &          # FastAPI :8787
cd frontend && pnpm dev &         # Vite :3000
cd electron && pnpm dev &         # Electron

wait
```

### 11.3 Docker Compose（开发用）

```yaml
# docker-compose.dev.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: hertz
      POSTGRES_PASSWORD: hertz
      POSTGRES_DB: hertz
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

---

## 十二、附录

### A. 各原项目机制在 Hertz 中的映射

| 原项目 | 核心机制 | Hertz 中的位置 |
|--------|----------|---------------|
| Autarkeia | Pipeline Engine + Stage | `backend/pipeline/base.py`（Pipe 抽象）+ `backend/pipeline/engine.py`（StepEngine）+ `backend/pipeline/steps/` |
| Autarkeia | Collector 策略链 | `backend/pipeline/collectors/` |
| Autarkeia | Producer 生产模块 | `backend/pipeline/producers/` |
| Autarkeia | Bilibili Publisher | `backend/pipeline/publishers/bilibili.py` |
| Autarkeia | LLM 多 Provider 路由 | `backend/ai/router.py`（AIRouter 统一替代） |
| Autarkeia | 审核 Web Console | `frontend/src/pages/console/` |
| Mojito | Crew/Brief/Plan | `backend/orchestration/` |
| Mojito | Phase Pipeline | `backend/orchestration/engine.py` + `backend/orchestration/phases/` |
| Mojito | Studio SSE 事件 | `backend/orchestration/studio.py` |
| Mojito | Image Generation | `backend/ai/providers/comfyui.py` |
| HeartStone | Worker Pool 下载 | `backend/download/engine.py` + `backend/download/workers.py` |
| HeartStone | URL 解析器 | `backend/download/parser.py` |
| HeartStone | 项目式文件浏览 | `backend/library/` |
| HeartStone | Electron IPC 模块化 | `electron/ipc/`（按域拆分注册） |
| HeartStone | 剪贴板监控 | `electron/ipc/clipboard.ts` |
| Revel | Canvas 2D 渲染 | `frontend/src/canvas/` |
| Revel | 语义相似度/聚类/低语 | `frontend/src/core/` |
| Revel | 纯逻辑零框架依赖 | `frontend/src/core/` |
| Revel | 卡片/笔迹/图层 | `frontend/src/pages/canvas/` |
| Ametrine | SSE 对话流 | `backend/conversation/chat.py` |
| Ametrine | 对话历史持久化 | `backend/conversation/history.py` |
| Ametrine | 统一 SSE 事件协议 | `backend/conversation/chat.py`（type: token/reference/tool_call/error/done） |

### B. 关键决策记录索引

> 实施过程中产生的决策记录应追加到此索引。

| ID | 日期 | 决策 | 理由 |
|----|------|------|------|
| D001 | 2026-07-31 | 统一 FastAPI 后端（非多服务） | AXIOM §2.4 避免碎片化；单进程简化部署 |
| D002 | 2026-07-31 | Pipe 抽象统一编排与执行管道 | 两种管道结构同构，复用基类减少概念 |
| D003 | 2026-07-31 | 自建 UI 组件，不引入外部 UI 库 | 完全控制设计令牌穿透，零外部样式冲突 |
| D004 | 2026-07-31 | Zustand + React Query（非 Redux） | 更轻的 API，客户端/服务端状态分工明确 |
| D005 | 2026-07-31 | SQLAlchemy 2.0 async + asyncpg | 充分利用 FastAPI 异步能力，与 Python 生态一致 |
| D006 | 2026-07-31 | ComfyUI 为初期唯一本地图像方案 | 用户 Mac 环境优先，后续扩展 Ollama/Xinference |
| D007 | 2026-07-31 | 暂不引入向量检索（Milvus） | 初期内容量不需要，避免基础设施膨胀 |
| D008 | 2026-07-31 | GSAP 替代 framer-motion | 自建组件体系不需要框架级动效绑定；GSAP 性能更优 |
| D009 | 2026-07-31 | Canvas 作为 Studio 子面板 | 定位为创作辅助而非独立应用；减少概念数量 |
| D010 | 2026-07-31 | HeartStone 域下沉到基础设施层 | 下载和文件管理不依赖 AI 或编排，属于通用基础能力 |
| D011 | 2026-08-05 | AXIOM 和谐化审计（跨 8 波次迭代后） | §1.2 单一真相源/§3.3 删除死代码/§8.1 输入校验，清理版本演进造成的不一致 |

> Wave 1-6 的决策详见 docs/DECISIONS.md（D-011~D-030），含 Wave 6.5 审计的
> SSRF 分层（D-025）、secret 快速失败（D-026）、无鉴权接受项（D-027）、
> 消息单源（D-028）、SSE 重连（D-029）、persist 节流（D-030）。

---

*本文档按 AXIOM 第零部更新准则制定。修订须有理由，变更保持原子性。*
