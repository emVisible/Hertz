# Hertz 用户指南

## 这是什么

Hertz 是 AI 驱动的内容创作与自动化桌面应用，五个功能区：

| 模块 | 用途 |
|---|---|
| 画布 Canvas | 灵感黑板：卡片、连线、粉笔笔迹、语义低语提醒 |
| 对话 Conversation | 与 AI 流式对话，历史保存在本地数据库 |
| 编排 Studio | 多阶段 AI 工作流（内容研究 → 脚本 → 成片） |
| 流水线 Console | 内容采集 → 评分 → 审核 → 发布 |
| 资源 Library / Downloads | 下载管理与媒体浏览 |

## 快速开始（开发模式）

```bash
./scripts/dev.sh
```

前置依赖：Python 3.12+、uv、Node.js 22+、pnpm、PostgreSQL、ffmpeg、yt-dlp。

启动后打开 http://localhost:3000（或 Electron 窗口），后端运行在 http://localhost:8787。

## 安装即用（打包分发版）

```bash
./scripts/build-backend.sh                        # PyInstaller 固化后端（CI 自动执行）
cd electron && pnpm install && pnpm build        # 产出 release/ 下安装包
```

打包版（macOS arm64 `.dmg`，v0.21 起）**零配置**：

- 后端已固化为自带二进制（PyInstaller onedir）——无需安装 Python 与依赖
- 内嵌 PostgreSQL：首次启动自动下载（约 32MB，需联网一次）到用户数据目录并托管，
  建库/迁移全自动；退出随应用一并停止
- **ffmpeg 内置兜底**：系统未装时自动使用包内 imageio 版（7.1，实测含 libass，
  缩略图/制作/字幕烧录开箱可用）；装了系统版则优先用系统版（尊重定制构建）
- `biliup`（仅 B 站发布需要）与 `ffprobe` 仍为系统依赖：缺失时依赖检测给 brew
  指引——ffprobe 缺失不阻塞主链路，但时长类特性（排期估算/原声字幕时间轴）降级

首次启动等待窗口较长（下载 + 初始化 + 迁移；实测热缓存约 20s、全新机器首启
约 40s-1.5min——耗时主要在固化包静态导入与 PG 下载，之后启动秒级）。

可通过环境变量绕过内置行为：

| 环境变量 | 作用 |
|---|---|
| `HERTZ_BACKEND_URL` | 指向外部后端（设置后不再本地拉起，内嵌 PG 跳过） |
| `HERTZ_DATABASE_URL` | 指向外部 PostgreSQL（内嵌 PG 跳过） |
| `HERTZ_PYTHON` | 指定 Python 解释器路径（无固化二进制时的回退） |
| `HERTZ_USER_DATA` | 重定向用户数据目录（测试/多实例隔离） |
| `HERTZ_UPDATE_URL` | 通用更新源（electron-updater），未设置则不做自动更新检查 |

> 发布产物经 GitHub Actions 自动构建上传 GitHub Releases：推 `v*` tag 即触发
> （`.github/workflows/release.yml`）。macOS 未签名——electron-updater 自动更新
> 待 Developer ID 签名后开启（ROADMAP 已知缺口）。

## 日常使用

### 画布
- 左侧工具条「+」新建卡片；双击卡片内容进入编辑；拖拽移动
- 连线工具：依次点两张卡片建立/断开连接
- 粉笔工具可手绘笔迹；擦除工具点击空白清除笔迹
- 右上「低语」栏每 5 秒给出提醒：长时间未触碰（唤醒）、相似未连线卡片（幻影）、随机提示（提醒）
- 「Studio 产物」面板可将最近一次工作流的最终输出一键注入画布；顶部 Brief 按钮将画布内容存为 Brief 供工作流使用
- 画布状态自动保存在本地浏览器存储（localStorage）

### 对话
- 左侧列出历史会话；新消息自动创建会话（以首条消息命名）
- `⌘↵` / `Ctrl↵` 发送；回复以 Markdown 渲染
- 悬停会话显示删除按钮（级联删除该会话全部消息）

### 流水线（Console）
- 「运行链」执行采集→评分→下载→生产，停在审核闸门
- 预处理的「未评分」阶段支持绕过评分直接下载（批量「直接下载」按钮或行内「直下」）——省 API 用量；未评分条目进审核时显示「未评分」徽章，AI 分仅作辅助参考
- 审核队列逐条 通过/拒绝；失败的条目可重试；配置 Telegram Bot 后待审条目自动推送到手机，inline 按钮 直接 通过/打回/拒绝（零公网暴露）
- 顶部面板实时显示状态看板、任务与采集源
- 发布策略引擎（设置 → 流水线开启）：开启后转正/产能跟随账号健康度自动调节——新号爬坡低频起步、播放骤降自动减半、疑似限流自动停发冷却；发布 → 队列 的「账号状态」卡展示相位、今日配额与判定原因
- 成本控制（左侧菜单）：按环节（评分/脚本/标题包装/翻译/编排）透视 AI 花费与执行历史；金额按「设置 → AI → 模型单价」实时计算，改单价会追溯历史报表；可在单价卡配置月度预算，花费达 50%/80%/95% 时成本页自动提示。看板「频道洞察」卡：AI 基于近 30 天发布表现总结受众偏好与应避开题材，自动校准评分与脚本生成（≥5 条已发布可点击重新分析）；「条目成本 ROI」表展示每条视频的 AI 成本与播放表现
- 翻译质量（设置 → AI → 翻译术语表）：维护人名/品牌译名自动注入翻译；旁白默认走三步翻译法（直译→反思→意译，可在设置关闭省 API）；发布卡标题行 ‹› 可在 3 个候选标题间切换
- 翻译引擎（设置 → 流水线 → 字幕样式与语言）：**本地 Opus-MT**（免费离线，英→中，首次使用自动下载约 300MB 模型；国内网络可在旁侧切换 hf-mirror 镜像端点）与 **API 三步法**（高质量）随时切换；重制作时脚本未变自动复用已翻字幕不重复计费；本地引擎失败自动回落 API
- 热点监控（设置 → 流水线 → 采集与入库）：开启后按独立间隔高频拉取指定 subreddit 的飙升内容，三组关键词（任一/必须/排除）预筛后才入库——省评分额度；命中条目仍走正常评分与审核

### 健康检查
- `GET http://localhost:8787/api/health` 返回分层检查：数据库、系统工具（ffmpeg/ffprobe/yt-dlp）、磁盘空间、AI 供应商
- 任一检查为 error 时整体状态 `degraded`，为 warning 时仍为 `ok`（如磁盘低于 5GB）

## 配置

后端配置通过环境变量（`HERTZ_` 前缀）或 `backend/config.py` 默认值控制，
运行时 `GET/PATCH /api/config` 可读改（机密字段永不回传，`secret_key` 等禁止运行时覆盖）。

主要配置：

| 配置 | 环境变量 | 说明 |
|---|---|---|
| DeepSeek API Key | `HERTZ_DEEPSEEK_API_KEY` | 对话与编排的 LLM |
| ComfyUI 地址 | `HERTZ_COMFYUI_BASE_URL` | 图像生成（可选） |
| TTS 供应商 | `HERTZ_TTS_PROVIDER` | 配音（可选） |
| 数据目录 | `HERTZ_DATA_DIR` | 下载/产物/运行时状态 |
| 前端端口 | `HERTZ_FRONTEND_PORT` | CORS 白名单（默认 3000） |

## 故障排查

| 症状 | 处理 |
|---|---|
| 页面提示「后端未就绪」 | 检查 8787 端口：`curl http://localhost:8787/api/health`；确认 PostgreSQL 运行、依赖已装 |
| 下载失败 HTTP 4xx | 视频可能已下线或地区受限 |
| ffmpeg 相关报错 | 确认 `ffmpeg`/`ffprobe` 在 PATH 中 |
| 对话一直失败 | `/api/health` 中 llm 检查是否通过（DeepSeek Key） |
| 数据异常 | 数据库在 `backend/data`（开发）/ `HERTZ_DATA_DIR`；备份后删除可重置 |

## 升级

设置 `HERTZ_UPDATE_URL` 的打包版启动时自动检查更新，下载完成后弹窗提示重启安装。
