"""Health and config endpoint tests."""

import shutil

import pytest
from httpx import AsyncClient

from backend.infrastructure.health import check_disk, check_tools


@pytest.mark.asyncio
async def test_health_ok(client: AsyncClient) -> None:
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] in {"ok", "degraded"}
    assert "database" in data["checks"]
    assert data["checks"]["database"]["status"] == "ok"


@pytest.mark.asyncio
async def test_health_tools_and_disk(client: AsyncClient) -> None:
    resp = await client.get("/api/health")
    data = resp.json()
    tools = data["checks"]["tools"]
    assert tools["status"] in {"ok", "warning"}
    assert tools["tools"]["ffmpeg"]["status"] == ("ok" if shutil.which("ffmpeg") else "error")
    assert "disk" in data["checks"]
    assert data["checks"]["disk"]["status"] in {"ok", "warning"}
    assert data["checks"]["disk"]["free_gb"] > 0


@pytest.mark.asyncio
async def test_logs_buffer(client: AsyncClient) -> None:
    resp = await client.get("/api/logs/buffer")
    assert resp.status_code == 200
    data = resp.json()
    assert "lines" in data
    assert isinstance(data["lines"], list)
    assert data["count"] == len(data["lines"])


@pytest.mark.asyncio
async def test_ai_status(client: AsyncClient) -> None:
    resp = await client.get("/api/ai/status")
    assert resp.status_code == 200
    data = resp.json()
    assert set(data["status"]) == {"llm", "image", "tts"}


@pytest.mark.asyncio
async def test_config_never_leaks_secrets(client: AsyncClient) -> None:
    resp = await client.get("/api/config")
    assert resp.status_code == 200
    data = resp.json()
    assert "deepseek_api_key" not in data
    assert "secret_key" not in data
    assert "database_url" not in data


@pytest.mark.asyncio
async def test_config_rejects_disallowed_runtime_override(client: AsyncClient) -> None:
    resp = await client.patch("/api/config", json={"overrides": {"secret_key": "hacked"}})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_check_tools_reports_each_tool() -> None:
    result = await check_tools()
    assert set(result["tools"]) == {"ffmpeg", "ffprobe", "yt-dlp"}
    for tool in result["tools"].values():
        assert tool["status"] in {"ok", "error"}


@pytest.mark.asyncio
async def test_check_disk_reports_free_space() -> None:
    result = await check_disk(min_free_gb=0.001)
    assert result["status"] == "ok"
    assert result["free_gb"] > 0
    assert result["total_gb"] > 0


@pytest.mark.asyncio
async def test_validation_error_shapes_422(client: AsyncClient) -> None:
    resp = await client.post("/api/pipeline/items/not-a-uuid/approve")
    assert resp.status_code == 422
    body = resp.json()
    assert body["detail"] == "validation error"
    assert isinstance(body["errors"], list)
