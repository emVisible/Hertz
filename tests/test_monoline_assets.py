"""Monoline 融合域 P3：资产链（assets/logo/bgm/brand）。"""

import io

PNG = (b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
WAV = b"RIFF" + b"\x00" * 100


async def _job(client, script: str = "第一段。第二段。") -> str:
    r = await client.post("/api/monoline/jobs", json={"script": script})
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def test_asset_upload_and_pin(client) -> None:
    jid = await _job(client)
    r = await client.post(
        f"/api/monoline/jobs/{jid}/assets",
        files={"file": ("pic.png", io.BytesIO(PNG), "image/png")},
    )
    assert r.status_code == 200
    rel = r.json()["rel"]
    assert rel.startswith("assets/") and rel.endswith(".png")

    r = await client.post(
        f"/api/monoline/jobs/{jid}/assets",
        files={"file": ("evil.svg", io.BytesIO(b"<svg/>"), "image/svg+xml")},
    )
    assert r.status_code == 422

    # 大纲 pin 图：image kind + 已冻结 rel → imaged==1
    view = (await client.post(f"/api/monoline/jobs/{jid}/outline")).json()
    edits = [{"text": e["text"]} for e in view["entries"]]
    edits[0] = {"text": edits[0]["text"], "kind": "image", "image": rel}
    r = await client.patch(f"/api/monoline/jobs/{jid}/outline", json={"entries": edits})
    assert r.json()["imaged"] == 1


async def test_bgm_upload_remove(client) -> None:
    jid = await _job(client)
    r = await client.post(
        f"/api/monoline/jobs/{jid}/bgm",
        files={"file": ("bed.mp3", io.BytesIO(b"ID3" + b"\x00" * 50), "audio/mpeg")},
    )
    assert r.status_code == 200 and r.json()["bgm"]["src"] == "audio/bgm.mp3"
    job = (await client.get(f"/api/monoline/jobs/{jid}")).json()
    assert job["config"]["bgm"]["volume"] == 0.22

    r = await client.post(
        f"/api/monoline/jobs/{jid}/bgm",
        files={"file": ("bed.txt", io.BytesIO(b"x"), "text/plain")},
    )
    assert r.status_code == 422
    r = await client.delete(f"/api/monoline/jobs/{jid}/bgm")
    assert r.json() == {"removed": True}


async def test_job_logo_cycle(client) -> None:
    jid = await _job(client)
    r = await client.post(
        f"/api/monoline/jobs/{jid}/logo",
        files={"file": ("logo.png", io.BytesIO(PNG), "image/png")},
    )
    assert r.status_code == 200 and "assets/logo-" in r.json()["rel"]
    r = await client.delete(f"/api/monoline/jobs/{jid}/logo")
    assert r.json() == {"removed": True}


async def test_brand_defaults_and_logo(client) -> None:
    r = await client.get("/api/monoline/brand")
    assert r.json()["label"] == "Monoline"
    r = await client.patch("/api/monoline/brand",
                           json={"label": "测试台", "theme": "mono-paper", "accent": "#123456"})
    assert r.json()["label"] == "测试台"
    r = await client.patch("/api/monoline/brand", json={"theme": "nope"})
    assert r.status_code == 422

    r = await client.post(
        "/api/monoline/brand/logo",
        files={"file": ("b.png", io.BytesIO(PNG), "image/png")},
    )
    assert r.json()["logo_name"].startswith("logo-")
    # 建作业自动套用品牌 + 冻入 logo
    jid = await _job(client)
    job = (await client.get(f"/api/monoline/jobs/{jid}")).json()
    assert job["config"]["brand"] == "测试台" and job["config"]["theme"] == "mono-paper"
    r = await client.delete("/api/monoline/brand/logo")
    assert r.json()["logo_name"] in (None, "")
    # 恢复默认，避免污染其他测试
    await client.patch("/api/monoline/brand",
                       json={"label": "Monoline", "theme": "mono-ink", "accent": ""})
