"""AI 底座注册表模型（Wave 8, v2.0）：Provider / 模型 / 调用记录。

设计目标（AXIOM §1.2/§2.2）：应用层只认 ProviderRegistry + TaskRouter，
Provider 与模型解耦、密钥加密存储（§8.2）、每次调用可追踪（§9.1）。
"""

from enum import StrEnum
from uuid import UUID

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class ProviderProtocol(StrEnum):
    OPENAI_COMPAT = "openai_compat"  # 唯一落地协议（v2.0）；字段预留扩展


class ModelCapability(StrEnum):
    CHAT = "chat"
    EMBEDDING = "embedding"  # v2.2 知识库预留
    IMAGE = "image"
    TTS = "tts"


class ModelRole(StrEnum):
    """任务角色（Cherry"默认模型"概念）：创建/快速/图像/语音/嵌入。

    角色 → 模型 key 的分配存 runtime.yaml；任务路由按角色取模型。
    """

    MAIN = "main"  # 创作/编排（强模型）
    FAST = "fast"  # 评分/标题/脚本（便宜快速）
    IMAGE = "image"
    TTS = "tts"
    EMBEDDING = "embedding"  # 预留


class AIProvider(BaseModel):
    __tablename__ = "ai_providers"

    key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    # 模板 key（deepseek/ollama/siliconflow/openai/custom）；custom = 完全自定义
    template: Mapped[str] = mapped_column(String(64), default="custom")
    protocol: Mapped[str] = mapped_column(String(32), default=ProviderProtocol.OPENAI_COMPAT)
    base_url: Mapped[str] = mapped_column(String(255), default="")
    # 加密后的 API key（KeychainCrypto 主密钥加密）；多 key 用逗号分隔轮询
    encrypted_keys: Mapped[str] = mapped_column(Text, default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class AIModel(BaseModel):
    __tablename__ = "ai_models"

    provider_id: Mapped[UUID] = mapped_column(
        ForeignKey("ai_providers.id", ondelete="CASCADE"), index=True
    )
    key: Mapped[str] = mapped_column(String(120))  # 模型 id，如 deepseek-chat
    name: Mapped[str] = mapped_column(String(120), default="")
    capability: Mapped[str] = mapped_column(String(32), default=ModelCapability.CHAT)
    context_window: Mapped[int | None] = mapped_column(Integer, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class AICall(BaseModel):
    """每次 AI 调用的追踪记录（v2.3 调用链 + 用量统计）。"""

    __tablename__ = "ai_calls"

    task_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # 调用方：engine:writer / pipeline:score / ai:chat ...
    caller: Mapped[str] = mapped_column(String(64), default="")
    provider_key: Mapped[str] = mapped_column(String(64), default="")
    model_key: Mapped[str] = mapped_column(String(120), default="")
    role: Mapped[str] = mapped_column(String(32), default="")
    operation: Mapped[str] = mapped_column(String(32), default="")
    # ↑ chat/score/script/title/image/tts
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cost_estimate: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="ok")  # ok/error/fallback
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_summary: Mapped[str | None] = mapped_column(Text, nullable=True)  # 截断到 200 字
    meta_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)


class AIPromptTemplate(BaseModel):
    """提示词模板库（v2.4）：可编辑的 system prompt，DB 持久化。

    出厂默认硬编码在 backend/ai/prompts/；首次访问时种入 DB，
    用户在界面编辑后以 DB 为准。key 即模板标识（如 agent.thinking_protocol）。
    """

    __tablename__ = "ai_prompt_templates"

    key: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    category: Mapped[str] = mapped_column(String(32), default="agent")
    # ↑ agent/brief/synthesis/score/script/title
    content: Mapped[str] = mapped_column(Text, default="")
    version: Mapped[int] = mapped_column(Integer, default=1)
    # 出厂模板是否被用户改过（升级时不覆盖用户编辑）
    customized: Mapped[bool] = mapped_column(Boolean, default=False)
