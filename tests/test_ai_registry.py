"""Wave 8 AI 底座 v2.0 测试：Provider 注册表 / 角色路由 / 模板库 / 调用链。"""

import pytest

from backend.ai.keychain import KeychainCrypto
from backend.ai.providers.openai_compat import OpenAICompatProvider


class _Crypto(KeychainCrypto):
    """测试用：固定主密钥的内存实现（不碰真实 Keychain）。"""

    def __init__(self) -> None:
        self._use_keychain = False
        self._fernet = None  # 惰性初始化（与真实实现一致）

    def _ensure_master_key(self) -> bytes:
        from cryptography.fernet import Fernet

        return Fernet.generate_key()


def test_keychain_encrypt_roundtrip() -> None:
    crypto = _Crypto()
    plain = "sk-test-1234567890abcdef"
    cipher = crypto.encrypt(plain)
    assert cipher != plain
    assert "sk-test" not in cipher
    assert crypto.decrypt(cipher) == plain


def test_keychain_decrypt_garbage_returns_empty() -> None:
    crypto = _Crypto()
    assert crypto.decrypt("not-a-valid-fernet-token") == ""


def test_openai_compat_provider_list_models_url() -> None:
    """list_models 打 /models 端点（不真正联网——仅验证 URL 构造）。"""
    provider = OpenAICompatProvider(api_key="sk-x", base_url="https://example.com/v1")
    assert str(provider._client.base_url) == "https://example.com/v1/"
    assert provider.model == "deepseek-chat"


async def test_roles_validation_rejects_bad_values(client) -> None:
    """PUT /api/ai/roles 拒绝未知角色与格式错误的值（AXIOM §8.1）。"""
    resp = await client.put("/api/ai/roles", json={"roles": {"nope": "a:b"}})
    assert resp.status_code == 422
    resp = await client.put("/api/ai/roles", json={"roles": {"main": "nocolon"}})
    assert resp.status_code == 422
    # 合法值通过
    resp = await client.put("/api/ai/roles", json={"roles": {"main": "deepseek:deepseek-chat"}})
    assert resp.status_code == 200
    assert resp.json()["roles"] == {"main": "deepseek:deepseek-chat"}
    # 清理
    await client.put("/api/ai/roles", json={"roles": {}})


async def test_models_capability_whitelist(client) -> None:
    """POST /api/ai/models 拒绝未知 capability。"""
    providers = (await client.get("/api/ai/providers")).json()
    if not providers:
        pytest.skip("no provider seeded")
    pid = providers[0]["id"]
    resp = await client.post(
        "/api/ai/models", json={"provider_id": pid, "key": "bad-model", "capability": "nope"}
    )
    assert resp.status_code == 422


async def test_provider_crud_flow(client) -> None:
    """Provider 创建/列表/更新/删除 全流程。"""
    resp = await client.post(
        "/api/ai/providers",
        json={
            "name": "测试服务商",
            "template": "custom",
            "base_url": "http://127.0.0.1:9999/v1",
            "api_keys": ["sk-a", "sk-b"],
        },
    )
    assert resp.status_code == 200, resp.text
    provider = resp.json()
    assert provider["keys_count"] == 2
    assert "sk-a" not in str(provider)  # 明文 key 不外泄

    listed = (await client.get("/api/ai/providers")).json()
    assert any(p["id"] == provider["id"] for p in listed)

    # 更新启用状态
    resp = await client.put(f"/api/ai/providers/{provider['id']}", json={"enabled": False})
    assert resp.status_code == 200
    assert resp.json()["enabled"] is False

    # 删除（models CASCADE）
    resp = await client.delete(f"/api/ai/providers/{provider['id']}")
    assert resp.status_code == 200
    resp = await client.get(f"/api/ai/providers/{provider['id']}")
    assert resp.status_code == 404


async def test_provider_template_seeds_models(client) -> None:
    """v4.3：OpenAI 兼容模板不内置模型名（创建后靠远程拉取，避免幻觉）；
    系统连接器（comfyui）种子出厂模型。"""
    # OpenAI 兼容类：创建后无内置模型
    resp = await client.post(
        "/api/ai/providers",
        json={"name": "Ollama 测试", "template": "ollama", "base_url": "http://127.0.0.1:11434/v1"},
    )
    assert resp.status_code == 200, resp.text
    pid = resp.json()["id"]
    models = (await client.get(f"/api/ai/models?provider_id={pid}")).json()
    assert models == []  # 不硬编码模型名
    await client.delete(f"/api/ai/providers/{pid}")

    # 系统连接器（comfyui）有出厂模型（无 /models 端点，必须内置）
    providers = (await client.get("/api/ai/providers")).json()
    comfy = next(p for p in providers if p["key"] == "comfyui")
    models = (await client.get(f"/api/ai/models?provider_id={comfy['id']}")).json()
    assert len(models) >= 1


async def test_special_providers_seeded_with_protocol(client) -> None:
    """v3.0 解耦：comfyui/edge_tts 自动种子为特殊 Provider，protocol 正确。"""
    providers = (await client.get("/api/ai/providers")).json()
    by_key = {p["key"]: p for p in providers}
    assert by_key["comfyui"]["protocol"] == "comfyui"
    assert by_key["edge_tts"]["protocol"] == "edge_tts"
    assert by_key["deepseek"]["protocol"] == "openai_compat"

    # edge_tts 的模型 = 音色列表
    sf = by_key["comfyui"]
    models = (await client.get(f"/api/ai/models?provider_id={sf['id']}")).json()
    assert any(m["capability"] == "image" for m in models)


async def test_role_resolution_image_tts(client) -> None:
    """v3.0：image/tts 角色从注册表解析（协议感知），不依赖 settings 直配。"""
    from backend.ai.registry import ProviderRegistry

    reg = ProviderRegistry()
    image = await reg.resolve_role("image")
    assert image is not None
    assert image["protocol"] == "comfyui"
    assert image["capability"] == "image"
    tts = await reg.resolve_role("tts")
    assert tts is not None
    assert tts["protocol"] == "edge_tts"
    assert tts["capability"] == "tts"


async def test_prompt_templates_api(client) -> None:
    """提示词模板库：列表/编辑/恢复默认。"""
    items = (await client.get("/api/ai/prompts")).json()
    assert items, "templates should be seeded"
    thinking = next(
        (t for t in items if t["key"] == "agent.thinking_protocol"), None
    )
    assert thinking is not None
    assert "思考协议" in thinking["content"]

    original = thinking["content"]
    resp = await client.put(
        "/api/ai/prompts/agent.thinking_protocol",
        json={"content": original + "\n（测试）"},
    )
    assert resp.status_code == 200
    assert resp.json()["customized"] is True

    resp = await client.post("/api/ai/prompts/agent.thinking_protocol/reset")
    assert resp.status_code == 200
    assert resp.json()["customized"] is False
    assert resp.json()["content"] == original


async def test_trace_records_calls(client) -> None:
    """调用链：写入后可按 task_id 查询。"""
    from backend.ai.tracing import record_call

    await record_call(
        task_id="trace-test", caller="test", provider_key="deepseek",
        model_key="deepseek-chat", role="main", operation="chat",
        duration_ms=42, status="ok",
    )
    calls = (await client.get("/api/ai/trace?task_id=trace-test")).json()
    assert len(calls) == 1
    assert calls[0]["model_key"] == "deepseek-chat"
    assert calls[0]["duration_ms"] == 42
