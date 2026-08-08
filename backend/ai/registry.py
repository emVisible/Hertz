"""ProviderRegistry — AI 底座 v2.0 核心服务。

职责：
- Provider / 模型 CRUD（DB 持久化，密钥经 KeychainCrypto 加密）
- 首次启动从环境变量导入遗留配置（env 明文 → Keychain）
- 连通性测试、模型列表拉取（/v1/models）
- 角色（main/fast/image/tts/embedding）→ 模型解析，供 TaskRouter 消费

应用层唯一入口：`registry.providers`。Provider 换实现只动这一处（AXIOM §2.2）。
"""

import logging
from uuid import UUID

from sqlalchemy import select

from backend.ai.keychain import KeychainCrypto, keychain_crypto
from backend.ai.providers.openai_compat import OpenAICompatProvider
from backend.ai.templates import TEMPLATE_INDEX
from backend.config import settings
from backend.models.ai_registry import AIModel, AIProvider, ModelCapability, ModelRole
from backend.models.session import session_factory

logger = logging.getLogger(__name__)

# 多 key 分隔符（DB 加密串内逗号分隔，轮询用）
_KEY_SEP = ","


class ProviderRegistry:
    def __init__(self, crypto: KeychainCrypto | None = None) -> None:
        self.crypto = crypto or keychain_crypto

    def image_output_dir(self):
        """ComfyUI 出图目录（路径配置属于系统级，走 settings；不属 AI 服务配置）。"""

        from backend.infrastructure.storage import file_store

        return file_store.output_root() / "ai" / "images"

    # ---------- seeding ----------

    async def _seed_special_providers(self) -> None:
        """幂等种子：comfyui / edge_tts 特殊 Provider（图像/TTS 连接器）。

        与 LLM Provider 不同，这两个是本地连接器（无 key、配置即 base_url/音色），
        每次都确保存在（缺失则补），用户可编辑 base_url 或禁用。
        """
        async with session_factory() as session:
            existing_keys = set(
                (await session.execute(select(AIProvider.key))).scalars().all()
            )
            for key in ("comfyui", "edge_tts"):
                if key in existing_keys:
                    continue
                tpl = TEMPLATE_INDEX[key]
                base_url = (
                    settings.comfyui_base_url
                    if key == "comfyui"
                    else tpl.base_url
                )
                provider = AIProvider(
                    key=key,
                    name=tpl.name,
                    template=key,
                    base_url=base_url,
                )
                session.add(provider)
                await session.flush()
                session.add_all(
                    [
                        AIModel(
                            provider_id=provider.id,
                            key=mkey,
                            name=mname,
                            capability=cap,
                            sort_order=i,
                        )
                        for i, (cap, mkey, mname) in enumerate(tpl.models)
                    ]
                )
            await session.commit()

    async def _seed_from_env(self) -> None:
        """首次启动：环境里的明文配置导入为默认 Provider（DeepSeek）。"""
        async with session_factory() as session:
            count = (await session.execute(select(AIProvider))).scalars().all()
            if count:
                return
            key = (
                settings.llm_api_key
                or settings.deepseek_api_key
                or ""
            )
            base_url = settings.llm_base_url or settings.deepseek_base_url
            model = settings.llm_model or settings.deepseek_model
            provider = AIProvider(
                key="deepseek",
                name="DeepSeek",
                template="deepseek",
                base_url=base_url or TEMPLATE_INDEX["deepseek"].base_url,
                encrypted_keys=self.crypto.encrypt(key) if key else "",
            )
            session.add(provider)
            await session.flush()
            # 只种 env 显式配置的模型（settings.llm_model）；不硬编码模型名
            # ——创建后「拉取模型列表」从远程获取真实模型（避免幻觉）。
            seed_models = []
            if model:
                seed_models.append(
                    AIModel(
                        provider_id=provider.id,
                        key=model,
                        name=model,
                        capability=ModelCapability.CHAT,
                    )
                )
            session.add_all(seed_models)
            await session.commit()
            logger.info("seeded default AI provider 'deepseek' from env config")

    # ---------- queries ----------

    async def list_providers(self, include_secrets: bool = False) -> list[dict]:
        await self._seed_from_env()
        await self._seed_special_providers()
        async with session_factory() as session:
            rows = (
                (await session.execute(
                    select(AIProvider).order_by(AIProvider.sort_order, AIProvider.created_at)
                )).scalars().all()
            )
            return [await self._serialize_provider(r, include_secrets) for r in rows]

    async def _serialize_provider(
        self, row: AIProvider, include_secrets: bool = False
    ) -> dict:
        # protocol 以模板为准（DB 字段保留给未来自定义协议）；模板缺失视为 openai_compat
        tpl = TEMPLATE_INDEX.get(row.template)
        data = {
            "id": str(row.id),
            "key": row.key,
            "name": row.name,
            "template": row.template,
            "protocol": tpl.protocol if tpl else row.protocol,
            "base_url": row.base_url,
            "enabled": row.enabled,
            "sort_order": row.sort_order,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "last_fetch_at": row.last_fetch_at.isoformat() if row.last_fetch_at else None,
            "keys_count": len(self._decrypt_keys(row.encrypted_keys)),
            "keys_set": bool(self._decrypt_keys(row.encrypted_keys)),
        }
        if include_secrets:
            data["decrypted_keys"] = self._decrypt_keys(row.encrypted_keys)
        return data

    def _decrypt_keys(self, encrypted: str) -> list[str]:
        if not encrypted:
            return []
        return [k for k in self.crypto.decrypt(encrypted).split(_KEY_SEP) if k]

    def _encrypt_keys(self, keys: list[str]) -> str:
        return self.crypto.encrypt(_KEY_SEP.join(k for k in keys if k))

    async def list_models(self, provider_id: UUID | None = None) -> list[dict]:
        await self._seed_from_env()
        async with session_factory() as session:
            stmt = select(AIModel).order_by(AIModel.sort_order, AIModel.created_at)
            if provider_id is not None:
                stmt = stmt.where(AIModel.provider_id == provider_id)
            rows = (await session.execute(stmt)).scalars().all()
            return [
                {
                    "id": str(r.id),
                    "provider_id": str(r.provider_id),
                    "key": r.key,
                    "name": r.name,
                    "capability": r.capability,
                    "context_window": r.context_window,
                    "enabled": r.enabled,
                }
                for r in rows
            ]

    # ---------- CRUD ----------

    async def create_provider(
        self,
        *,
        name: str,
        template: str = "custom",
        base_url: str = "",
        api_keys: list[str] | None = None,
    ) -> dict:
        tpl = TEMPLATE_INDEX.get(template)
        key = template if template != "custom" else _slugify(name)
        async with session_factory() as session:
            exists = (await session.execute(
                select(AIProvider).where(AIProvider.key == key)
            )).scalar_one_or_none()
            if exists is not None:
                raise ValueError(f"provider key already exists: {key}")
            provider = AIProvider(
                key=key,
                name=name.strip(),
                template=template,
                base_url=(base_url or (tpl.base_url if tpl else "")).rstrip("/"),
                encrypted_keys=self._encrypt_keys(api_keys or []),
            )
            session.add(provider)
            await session.flush()
            # 系统连接器（comfyui/edge_tts）无 /models 端点，种子出厂模型；
            # OpenAI 兼容类不内置模型名——创建后由用户「拉取模型列表」从远程获取
            # （硬编码模型名会随平台下架/改名产生幻觉）。
            if tpl and tpl.protocol in ("comfyui", "edge_tts"):
                for i, (cap, mkey, mname) in enumerate(tpl.models):
                    session.add(
                        AIModel(
                            provider_id=provider.id,
                            key=mkey,
                            name=mname,
                            capability=cap,
                            sort_order=i,
                        )
                    )
            await session.commit()
            return await self.get_provider(provider.id)

    async def get_provider(self, provider_id: UUID) -> dict:
        async with session_factory() as session:
            row = await session.get(AIProvider, provider_id)
            if row is None:
                raise KeyError(f"provider not found: {provider_id}")
            return await self._serialize_provider(row)

    async def update_provider(
        self,
        provider_id: UUID,
        *,
        name: str | None = None,
        base_url: str | None = None,
        api_keys: list[str] | None = None,
        enabled: bool | None = None,
        sort_order: int | None = None,
    ) -> dict:
        async with session_factory() as session:
            row = await session.get(AIProvider, provider_id)
            if row is None:
                raise KeyError(f"provider not found: {provider_id}")
            if name is not None:
                row.name = name.strip()
            if base_url is not None:
                row.base_url = base_url.strip().rstrip("/")
            if api_keys is not None:
                row.encrypted_keys = self._encrypt_keys(api_keys)
            if enabled is not None:
                row.enabled = enabled
            if sort_order is not None:
                row.sort_order = sort_order
            await session.commit()
            return await self._serialize_provider(row)

    async def delete_provider(self, provider_id: UUID) -> None:
        async with session_factory() as session:
            row = await session.get(AIProvider, provider_id)
            if row is None:
                raise KeyError(f"provider not found: {provider_id}")
            await session.delete(row)  # models CASCADE
            await session.commit()

    async def add_model(
        self,
        *,
        provider_id: UUID,
        key: str,
        name: str = "",
        capability: str = ModelCapability.CHAT,
        context_window: int | None = None,
    ) -> dict:
        async with session_factory() as session:
            provider = await session.get(AIProvider, provider_id)
            if provider is None:
                raise KeyError(f"provider not found: {provider_id}")
            model = AIModel(
                provider_id=provider_id,
                key=key.strip(),
                name=name or key.strip(),
                capability=capability,
                context_window=context_window,
            )
            session.add(model)
            await session.commit()
            await session.refresh(model)
            return {
                "id": str(model.id),
                "provider_id": str(model.provider_id),
                "key": model.key,
                "name": model.name,
                "capability": model.capability,
                "enabled": model.enabled,
            }

    async def update_model(self, model_id: UUID, **fields) -> dict:
        async with session_factory() as session:
            row = await session.get(AIModel, model_id)
            if row is None:
                raise KeyError(f"model not found: {model_id}")
            for key, value in fields.items():
                if value is not None and hasattr(row, key):
                    setattr(row, key, value)
            await session.commit()
            return {
                "id": str(row.id),
                "provider_id": str(row.provider_id),
                "key": row.key,
                "name": row.name,
                "capability": row.capability,
                "enabled": row.enabled,
            }

    async def delete_model(self, model_id: UUID) -> None:
        async with session_factory() as session:
            row = await session.get(AIModel, model_id)
            if row is None:
                raise KeyError(f"model not found: {model_id}")
            await session.delete(row)
            await session.commit()

    # ---------- model list fetch / test ----------

    async def fetch_models(self, provider_id: UUID) -> list[dict]:
        """拉取 /v1/models 并合并进模型库（不删已存在项）。

        防限流（v5.8）：模型列表只允许手动拉取，且带 60s 冷却窗口——
        窗口内的重复请求直接拒绝（ValueError → 前端可读提示）。
        """
        from datetime import UTC, datetime

        now = datetime.now(UTC)
        async with session_factory() as session:
            row = await session.get(AIProvider, provider_id)
            if row is None:
                raise KeyError(f"provider not found: {provider_id}")
            if row.last_fetch_at is not None:
                elapsed = (now - row.last_fetch_at).total_seconds()
                if elapsed < 60:
                    raise ValueError("模型列表刚刚拉取过，60 秒内请勿重复请求（防限流）")
            keys = self._decrypt_keys(row.encrypted_keys)
            tpl = TEMPLATE_INDEX.get(row.template)
        client = OpenAICompatProvider(
            api_key=keys[0] if keys else "not-needed",
            base_url=row.base_url or (tpl.base_url if tpl else ""),
            model="",
        )
        try:
            remote = await client.list_models()
        finally:
            await client.aclose()
        existing = await self.list_models(provider_id)
        existing_keys = {m["key"] for m in existing}
        added = [m for m in remote if m not in existing_keys]
        for key in added:
            await self.add_model(provider_id=provider_id, key=key, name=key)
        async with session_factory() as session:
            row = await session.get(AIProvider, provider_id)
            row.last_fetch_at = datetime.now(UTC)
            await session.commit()
        return await self.list_models(provider_id)

    async def test_provider(
        self, provider_id: UUID, model_key: str | None = None
    ) -> dict:
        """连通性测试：用指定/首个 chat 模型发一次最小请求。"""
        async with session_factory() as session:
            row = await session.get(AIProvider, provider_id)
            if row is None:
                raise KeyError(f"provider not found: {provider_id}")
            keys = self._decrypt_keys(row.encrypted_keys)
        models = await self.list_models(provider_id)
        chat_models = [
            m for m in models
            if m["capability"] == ModelCapability.CHAT and m["enabled"]
        ]
        target = next((m for m in chat_models if m["key"] == model_key), None) or (
            chat_models[0] if chat_models else None
        )
        if target is None:
            return {"ok": False, "detail": "no chat model configured"}
        client = OpenAICompatProvider(
            api_key=keys[0] if keys else "not-needed",
            base_url=row.base_url,
            model=target["key"],
        )
        try:
            from backend.ai.types import ChatMessage

            chunks: list[str] = []
            async for token in client.chat_stream(
                [ChatMessage(role="user", content="ping")],
                temperature=0.1,
                max_tokens=16,
            ):
                chunks.append(token)
            return {"ok": True, "model": target["key"], "reply": "".join(chunks)[:40]}
        except Exception as exc:  # noqa: BLE001 — 测试路径异常返回给前端展示
            return {"ok": False, "model": target["key"], "detail": str(exc)[:200]}
        finally:
            await client.aclose()

    # ---------- role resolution (v2.1) ----------

    async def resolve_role(self, role: str) -> dict | None:
        """角色 → (provider, model)。未配置角色时回退：
        fast/embedding → main → 首个启用 chat 模型；image/tts 无回退。
        """
        await self._seed_from_env()
        await self._seed_special_providers()
        role_cfg = settings.ai_roles or {}
        configured = role_cfg.get(role)
        async with session_factory() as session:
            providers = (
                (await session.execute(
                    select(AIProvider).where(AIProvider.enabled.is_(True))
                    .order_by(AIProvider.sort_order, AIProvider.created_at)
                )).scalars().all()
            )
            for provider_row in providers:
                keys = self._decrypt_keys(provider_row.encrypted_keys)
                tpl = TEMPLATE_INDEX.get(provider_row.template)
                # custom 模板默认视为需要 key（远端 OpenAI 兼容端点）；
                # 仅显式声明 needs_key=False 的本地模板允许无 key。
                needs_key = not (tpl and not tpl.needs_key)
                if needs_key and not keys:
                    # 需要 key 的远端 Provider 没配 key = 不可用（快速失败，AXIOM §4.2）
                    continue
                if configured:
                    wanted_provider, _, wanted_model = configured.partition(":")
                    if provider_row.key != wanted_provider:
                        continue
                    models = (
                        (await session.execute(
                            select(AIModel).where(
                                AIModel.provider_id == provider_row.id,
                                AIModel.enabled.is_(True),
                            )
                        )).scalars().all()
                    )
                    match = next((m for m in models if m.key == wanted_model), None)
                    if match:
                        return await self._to_resolved(provider_row, match)
                # 未配置或未命中：按角色能力找第一个可用
                cap = {
                    ModelRole.MAIN: ModelCapability.CHAT,
                    ModelRole.FAST: ModelCapability.CHAT,
                    ModelRole.IMAGE: ModelCapability.IMAGE,
                    ModelRole.TTS: ModelCapability.TTS,
                    ModelRole.EMBEDDING: ModelCapability.EMBEDDING,
                }.get(role, ModelCapability.CHAT)
                models = (
                    (await session.execute(
                        select(AIModel).where(
                            AIModel.provider_id == provider_row.id,
                            AIModel.enabled.is_(True),
                            AIModel.capability == cap,
                        ).order_by(AIModel.sort_order)
                    )).scalars().all()
                )
                if models:
                    return await self._to_resolved(provider_row, models[0])
                if role in (ModelRole.FAST, ModelRole.EMBEDDING):
                    # 快速/嵌入角色无对应模型 → 回退 main → 回退任意 chat
                    chat = (
                        (await session.execute(
                            select(AIModel).where(
                                AIModel.provider_id == provider_row.id,
                                AIModel.enabled.is_(True),
                                AIModel.capability == ModelCapability.CHAT,
                            ).order_by(AIModel.sort_order)
                        )).scalars().all()
                    )
                    if chat:
                        return await self._to_resolved(provider_row, chat[0])
        return None

    async def _to_resolved(self, provider_row: AIProvider, model_row) -> dict:
        keys = self._decrypt_keys(provider_row.encrypted_keys)
        tpl = TEMPLATE_INDEX.get(provider_row.template)
        return {
            "provider_key": provider_row.key,
            "provider_id": str(provider_row.id),
            "model_key": model_row.key,
            "capability": model_row.capability,
            "base_url": provider_row.base_url,
            "api_keys": keys,
            "template": provider_row.template,
            "protocol": (tpl.protocol if tpl else "openai_compat"),
        }


def _slugify(name: str) -> str:
    import re

    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:24] or "provider"
    return slug
