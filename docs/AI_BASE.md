# Hertz AI 底座（v3.0）— 架构与使用说明

> 状态：ACTIVE · 最后更新 2026-08-24 · **2026-10-18 复核过入口仍有效**（ProviderRegistry
> 与角色→模型路由仍在读本文描述的那套机制），但**正文已 3 个月未随代码更新**。
> 改动 AI 底座时**顺手更新本文**：它是本仓唯一一份把 provider 层 / TaskRouter /
> 提示词模板库讲在一处的文档。
> 对应 `docs/archive/HERTZ_RECONSTRUCTION.md` Wave 8。应用层（编排/流水线/Studio）只调用
> TaskRouter 的稳定接口，配置一律走 Provider 注册表——图像/TTS 与 LLM 同一套机制。

## 一、架构总览

```
┌─────────────────────────────────────────────────┐
│  应用层（固定，接口零改动）                          │
│  编排 engine / 流水线 / Studio / 设置页            │
└───────────────┬─────────────────────────────────┘
                │ chat_messages / score / script / title / image / tts
┌───────────────▼─────────────────────────────────┐
│  AI 底座层（backend/ai/）                        │
│  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ TaskRouter   │→ │ ProviderRegistry        │  │
│  │ 任务路由/角色   │  │ Provider/模型 CRUD       │  │
│  │ 多 Key 轮询    │  │ resolve_role(角色→模型)   │  │
│  │ 协议分派       │  │ 协议: openai/comfyui/tts │  │
│  └──────┬───────┘  └───────────┬─────────────┘  │
│  ┌──────▼──────────────────────▼─────────────┐  │
│  │ KeychainCrypto（macOS 钥匙串加密密钥）       │  │
│  │ PromptTemplateService（提示词模板库）        │  │
│  │ tracing（ai_calls 使用记录）                │  │
│  └───────────────────────────────────────────┘  │
└───────────────┬─────────────────────────────────┘
                │
        DB: ai_providers / ai_models / ai_calls / ai_prompt_templates
```

## 二、核心概念

### Provider（模型服务商）
统一注册表管理三类连接器（v3.0 解耦：不再有 settings 直配）：
- **对话模型**（openai_compat 协议）：DeepSeek / 硅基流动（内置 `deepseek-ai/DeepSeek-V3.2`）/ Ollama / OpenAI / 自定义
- **ComfyUI**（comfyui 协议，自动种子）：本地出图，配置 = base_url
- **Edge TTS**（edge_tts 协议，自动种子）：语音合成，模型列表 = 音色

每个 Provider 标注**能力**：`chat` / `embedding`（预留）/ `image` / `tts`。

### 角色（Role）→ 任务分工（Cherry"默认模型"概念）
| 角色 | 谁在用 | 推荐 |
|---|---|---|
| `main` 创作 | 编排工序、对话 | 最强模型 |
| `fast` 快速 | 评分/标题/脚本 | 便宜快速模型 |
| `embedding` 嵌入 | 知识库（v2.2 预留） | 向量模型 |

未配置的角色回退链：`fast/embedding → main → 首个可用 chat 模型`。

### 工序/角色的 model 字段（v2.4 接入）
工序库或角色库里给某个 agent 指定的 `model` 现在真正生效：
- 值可为裸模型 id（`deepseek-chat`，全局首个匹配）或 `provider:model`（`deepseek:deepseek-reasoner`）
- 未配置 → 按角色回退

## 三、密钥安全（AXIOM §8.2）

- API Key 用 **macOS 钥匙串** 托管主密钥加密后存 DB，明文永不落盘
- 无钥匙串环境（Linux dev/CI）降级为 `data/secrets/master.key`（chmod 600）
- 首次启动自动从环境变量导入旧配置（`HERTZ_DEEPSEEK_API_KEY` 等），之后以 DB 为准
- 一个 Provider 可配**多个 key**（逗号分隔），调用时轮询 + 坏 key 剔除

## 四、提示词模板库（v2.4）

出厂默认在 `backend/ai/prompts/templates.py`；首次访问种入 DB。
设置页「提示词模板库」可编辑，保存后**下次运行生效**；「恢复默认」回到出厂值
（升级不覆盖用户已自定义的模板，`customized` 标记）。

## 五、AI 使用记录（v3.0 可读化）

每次模型调用写入 `ai_calls`：
- 设置页「AI 使用记录」查看：时间 / 调用方（编排·创作、流水线·评分…）/ 操作 / 模型 / 耗时
- 用于排查「这次用了哪个模型、为什么慢」——不用翻日志
- 编排/流水线以 run id 为 `task_id`，可按任务聚合

## 六、API 一览

| 端点 | 说明 |
|---|---|
| `GET /api/ai/templates` | Provider 模板库（含协议） |
| `GET/POST /api/ai/providers` | Provider 列表 / 新建 |
| `GET/PUT/DELETE /api/ai/providers/{id}` | Provider 详情 / 更新 / 删除 |
| `POST /api/ai/providers/{id}/fetch-models` | 拉取 /v1/models |
| `POST /api/ai/providers/{id}/test` | 连通性测试 |
| `GET/POST /api/ai/models`、`PUT/DELETE /api/ai/models/{id}` | 模型库 |
| `GET/PUT /api/ai/roles` | 角色分配（provider:model） |
| `GET /api/ai/prompts`、`PUT /api/ai/prompts/{key}`、`POST .../reset` | 提示词模板库 |
| `GET /api/ai/trace` | 使用记录 |
| `GET /api/ai/status` | 能力状态（兼容旧 API） |

## 七、迁移与兼容

- `AIRouter` 更名为 `TaskRouter`，旧名保留为别名——应用层零改动
- v3.0 解耦：图像（ComfyUI）/语音（Edge TTS）从 settings 直配迁入 Provider 注册表；
  `comfyui_base_url` env 仅用于首次种子；`tts_voice` 改由 `ai_roles.tts` 指定音色
- 新增表均为增量迁移（`wave8_ai_registry`、`wave8b_prompt_templates`）
- 环境变量旧配置首次启动自动导入注册表
- 注意：**打包的 Hertz.app 需重新打包**才含新底座代码
