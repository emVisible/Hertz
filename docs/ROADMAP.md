# Hertz 路线图

> 各波次进度与验收详见 HERTZ_RECONSTRUCTION.md（九、实施波次）。

## 已交付

- **Wave 0-3**：骨架、基础设施（配置/日志/存储/迁移）、AI 接口层（DeepSeek/ComfyUI/TTS）、Factory 装配、下载引擎、资源管理、编排域（多阶段工作流 + SSE）
- **Wave 4**：内容流水线（采集/评分/下载/生产/审核/发布）与 Console 控制台
- **Wave 5**：灵感画布（相似度/聚类/低语/粉笔渲染）与对话流（SSE 持久化）
- **Wave 6**：健康检查（工具/磁盘/AI）、错误边界与全局异常处理、Electron 打包（backend 随包 + 自动更新）
- **Wave 6.5**：Axiom 全局审计——SSRF/路径穿越/密钥配置加固、media_url 落库、i18n 全量、SSE 重连、ChatPage 单源、persist 节流（详见 HERTZ_RECONSTRUCTION.md §9）

## 已知缺口

| 项 | 说明 | 优先级 |
|---|---|---|
| PyInstaller 固化后端 | 打包版依赖系统 Python + 依赖；固化为单二进制后实现真正「安装即用」 | 高 |
| API 鉴权接入 | auth.py 已有 JWT 原语零调用；桌面单用户场景接受，部署为服务时必须接入 | 高 |
| 自动更新发布通道 | 已接 electron-updater，需部署 `HERTZ_UPDATE_URL` 源与 CI 发布流程 | 中 |
| 应用图标与代码签名 | 当前用默认 Electron 图标；macOS 需 Developer ID、Windows 需 EV 证书 | 中 |
| 健康检查 UI | 目前仅 `/api/health` JSON；计划接入设置页可视化看板 | 中 |
| Agent 工具调用 | 对话的 agent 模式（shell/playwright 等）为非目标，列为后续 | 低 |
| 向量检索/记忆 | Milvus/Redis 体系，增强对话上下文 | 低 |
| 多平台发布 | Bilibili 之外的 YouTube/其他平台发布器 | 低 |

## 下一步候选

1. **P0 安装即用闭环**：PyInstaller 打包后端 → CI（GitHub Actions）产物发布到更新源 → 全新机器零配置安装验收（AXIOM §17.5）
2. **P1 设置页**：`/config` 占位页替换为可视化配置 + 健康看板 + 依赖检测向导
3. **P1 体验打磨**：下载队列重排、画布多板/图层/图片卡片、对话引用画布卡片
4. **P2 发布扩展**：更多平台发布器、定时自动发布、数据导出/导入

## 维护约定

- 每个迭代跑 `./scripts/verify.sh`（ruff → pytest → tsc → vitest → vite build）全绿才算完成
- 新决策记入 `docs/DECISIONS.md`，波次回顾记入 `HERTZ_RECONSTRUCTION.md`
