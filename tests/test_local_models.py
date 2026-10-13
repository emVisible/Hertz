"""v0.32 S4 的回归直钉：本地模型「路径 / 端点 / 告警 / 加载」四件事各只有一个作者。

存在理由：whisper 此前把模型交给 huggingface_hub 的默认缓存（`~/.cache`），而
`HERTZ_DATA_DIR` 隔离的全部理由就是不碰 `$HOME`——于是打包版里「下了模型也探不到」，
能力矩阵永远 pending，而开发态因为缓存里恰好有模型一切正常。这种两侧各看得见一半
的 bug 只能靠断言钉：网络不能进测试，所以这里断的是**落位形状与决策路径**。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from backend.config import settings
from backend.infrastructure import alerts, hf, paths

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def isolated_data_dir(tmp_path, monkeypatch):
    """把 data_dir 指到 tmp——就绪探测与下载落位全都跟着走。"""
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    return tmp_path


# ---------- infrastructure/hf：端点候选序 ----------


def test_candidate_endpoints_order_and_dedup() -> None:
    assert hf.candidate_endpoints("https://hf-mirror.com") == [
        "https://hf-mirror.com",
        hf.OFFICIAL_ENDPOINT,
    ]
    # 配置项已经等于官方：不重复尝试，也不因为"看起来设过了"就丢掉镜像
    assert hf.candidate_endpoints(hf.OFFICIAL_ENDPOINT) == [
        hf.OFFICIAL_ENDPOINT,
        hf.MIRROR_ENDPOINT,
    ]
    assert hf.candidate_endpoints("   ") == [hf.OFFICIAL_ENDPOINT, hf.MIRROR_ENDPOINT]
    assert hf.candidate_endpoints(None) == [hf.OFFICIAL_ENDPOINT, hf.MIRROR_ENDPOINT]


def test_candidate_endpoints_normalizes_trailing_slash() -> None:
    """尾斜杠不去掉会拼出 `//repo/resolve` ——镜像站把它当路径 404。"""
    assert hf.candidate_endpoints("https://mirror.example/")[0] == "https://mirror.example"


def test_endpoint_candidates_read_single_setting(monkeypatch) -> None:
    """端点设置只有一项（v0.32 S4：翻译与转写共用），且由 hf 这一个入口读。"""
    monkeypatch.setattr(settings, "pipeline_hf_endpoint", "https://mirror.example")
    assert hf.endpoint_candidates()[0] == "https://mirror.example"
    monkeypatch.setattr(settings, "pipeline_hf_endpoint", "")
    assert hf.endpoint_candidates() == [hf.OFFICIAL_ENDPOINT, hf.MIRROR_ENDPOINT]


def test_reason_is_actionable_when_the_library_says_nothing(monkeypatch) -> None:
    """httpx 的 ConnectError 常是空消息（实测本机代理一关就是 `ConnectError: `）。

    只剩一个冒号的告警等于没说——「切镜像」和「你的代理挂了」是两个不同的修复动作，
    所以空消息必须兜底带上代理状态。
    """
    import httpx

    monkeypatch.setattr(
        "urllib.request.getproxies", lambda: {"https": "127.0.0.1:7897"}
    )
    text = hf._reason(httpx.ConnectError(""))
    assert "ConnectError" in text and "127.0.0.1:7897" in text

    class _WrappedError(RuntimeError):
        pass

    cause = OSError("后端断开")
    outer = _WrappedError("")
    outer.__cause__ = cause
    assert hf._reason(outer) == "_WrappedError: 后端断开"
    # 两层都是空消息（httpx.ConnectError ← httpcore.ConnectError 的真实形态）：
    # 必须退回「异常类名 + 代理状态」，不能报成 `_WrappedError: `
    silent = _WrappedError("")
    silent.__cause__ = OSError()
    assert hf._reason(silent) == "_WrappedError: OSError"
    assert hf._reason(RuntimeError("boom")) == "RuntimeError: boom"


def test_old_per_engine_endpoint_settings_are_gone() -> None:
    """一个事实一个作者：`pipeline_translate_hf_endpoint` 不得在代码里复活。

    两项端点设置的结局是用户在两处里漏设一处，然后某个能力静默不可用——
    正是 D-189 那类事故的形状。docs/ 里的历史叙述保留，代码里不留。
    """
    offenders: list[str] = []
    for base in ("backend", "frontend/src", "electron/src", "scripts"):
        for p in (ROOT / base).rglob("*"):
            if p.suffix not in {".py", ".ts", ".tsx", ".sh", ".toml", ".json"}:
                continue
            if "pipeline_translate_hf_endpoint" in p.read_text(encoding="utf-8"):
                offenders.append(str(p.relative_to(ROOT)))
    assert not offenders, "端点设置又分叉了: " + ", ".join(offenders)


# ---------- infrastructure/hf：下载底座 ----------


class _FakeResp:
    def __init__(self, status: int, body: bytes, *, boom: bool = False) -> None:
        self.status_code = status
        self._body = body
        self._boom = boom

    async def __aenter__(self) -> _FakeResp:
        return self

    async def __aexit__(self, *exc) -> bool:
        return False

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    async def aiter_bytes(self, chunk_size: int):
        if self._boom:
            yield self._body[:chunk_size]
            raise RuntimeError("connection reset")
        for i in range(0, len(self._body), chunk_size):
            yield self._body[i : i + chunk_size]


class _FakeClient:
    """按 (endpoint, filename) 表驱动；记录被请求过的 URL。"""

    def __init__(self, table, calls: list[str]) -> None:
        self._table = table
        self._calls = calls

    async def __aenter__(self) -> _FakeClient:
        return self

    async def __aexit__(self, *exc) -> bool:
        return False

    def stream(self, _method: str, url: str) -> _FakeResp:
        self._calls.append(url)
        for key, (status, body, boom) in self._table.items():
            if key in url:
                return _FakeResp(status, body, boom=boom)
        return _FakeResp(404, b"")


def _patch_transport(monkeypatch, table) -> list[str]:
    calls: list[str] = []

    def factory(**_kwargs):
        return _FakeClient(table, calls)

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    return calls


_FILES: tuple[tuple[str, bool], ...] = (
    ("model.bin", True),
    ("config.json", True),
    ("optional.json", False),
)


@pytest.mark.asyncio
async def test_download_writes_files_and_leaves_no_temp(tmp_path, monkeypatch) -> None:
    calls = _patch_transport(
        monkeypatch,
        {
            "model.bin": (200, b"x" * 4096, False),
            "config.json": (200, b"{}", False),
            "optional.json": (200, b"[]", False),
        },
    )
    ok, errors = await hf.download_files(
        "Systran/faster-whisper-base", _FILES, tmp_path / "m", ["https://e1"]
    )
    assert (ok, errors) == (True, [])
    target = tmp_path / "m" / "model.bin"
    assert target.read_bytes() == b"x" * 4096  # 分块拼回完整内容
    assert not list((tmp_path / "m").glob("*.part"))
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_download_rotates_to_next_endpoint(tmp_path, monkeypatch) -> None:
    """官方挂了不算失败——镜像成功即成功；失败原因仍按端点汇总给调用方。"""
    calls = _patch_transport(
        monkeypatch,
        {
            "https://e1/Systran": (503, b"", False),
            "https://e2/Systran": (200, b"ok", False),
        },
    )
    ok, _ = await hf.download_files(
        "Systran/m", (("model.bin", True),), tmp_path, ["https://e1", "https://e2"]
    )
    assert ok is True
    assert any(u.startswith("https://e1/") for u in calls)
    assert any(u.startswith("https://e2/") for u in calls)


@pytest.mark.asyncio
async def test_download_optional_404_is_not_a_failure(tmp_path, monkeypatch) -> None:
    _patch_transport(
        monkeypatch,
        {"model.bin": (200, b"a", False), "config.json": (200, b"{}", False)},
    )
    ok, errors = await hf.download_files(
        "Systran/m", _FILES, tmp_path, ["https://e1"]
    )
    assert (ok, errors) == (True, [])
    assert not (tmp_path / "optional.json").exists()


@pytest.mark.asyncio
async def test_download_failure_leaves_no_partial_file(tmp_path, monkeypatch) -> None:
    """断流必须清掉 .part：半截 model.bin 会让就绪探测说"已就绪"、加载时崩。"""
    dest = tmp_path / "m"
    _patch_transport(monkeypatch, {"model.bin": (200, b"y" * 5000, True)})
    ok, errors = await hf.download_files(
        "Systran/m", (("model.bin", True),), dest, ["https://e1"]
    )
    assert ok is False and "connection reset" in errors[0]
    assert list(dest.iterdir()) == []


@pytest.mark.asyncio
async def test_download_is_idempotent_on_existing_files(tmp_path, monkeypatch) -> None:
    (tmp_path / "model.bin").write_bytes(b"already")
    calls = _patch_transport(monkeypatch, {"config.json": (200, b"{}", False)})
    ok, _ = await hf.download_files(
        "Systran/m", (("model.bin", True), ("config.json", True)), tmp_path, ["https://e1"]
    )
    assert ok is True
    assert not any(u.endswith("model.bin") for u in calls)
    assert (tmp_path / "model.bin").read_bytes() == b"already"


# ---------- infrastructure/alerts ----------


def test_notify_once_dedups_until_reset(monkeypatch) -> None:
    sent: list[str] = []
    monkeypatch.setattr(alerts, "_send", sent.append)
    alerts.reset("k")
    alerts.notify_once("k", "第一条")
    alerts.notify_once("k", "第一条")
    alerts.notify_once("k", "第一条")
    assert sent == ["第一条"]  # 每次转写都推一条会变成噪音
    alerts.reset("k")
    alerts.notify_once("k", "第二条")
    assert sent == ["第一条", "第二条"]  # 恢复后再坏一次，仍要说话


# ---------- infrastructure/paths ----------


def test_whisper_model_dir_lives_under_data_dir(isolated_data_dir) -> None:
    d = paths.whisper_model_dir("base")
    assert d == isolated_data_dir / "models" / "whisper" / "faster-whisper-base"
    assert str(Path.home()) not in str(d)  # 绝不落回 ~/.cache/huggingface


def test_whisper_readiness_requires_tokenizer(isolated_data_dir) -> None:
    """tokenizer.json 缺位时必须判"未就绪"——faster-whisper 会联网去 HF 抓
    openai/whisper-tiny 兜底，离线机器上表现为「模型明明下好了却失败」。"""
    d = paths.whisper_model_dir("base")
    d.mkdir(parents=True)
    assert paths.whisper_model_ready("base") is False
    for f in ("model.bin", "config.json"):
        (d / f).write_bytes(b"x")
    assert paths.whisper_model_ready("base") is False
    (d / "tokenizer.json").write_bytes(b"{}")
    assert paths.whisper_model_ready("base") is True


def test_whisper_files_marks_required_and_optional() -> None:
    assert paths.WHISPER_CORE_FILES == ("model.bin", "config.json", "tokenizer.json")
    assert ("vocabulary.txt", False) in paths.WHISPER_FILES


def test_empty_name_is_never_ready() -> None:
    assert paths.whisper_model_ready("") is False


# ---------- asr：档位、repo id、加载 ----------


def test_whisper_model_name_defaults_to_base(monkeypatch) -> None:
    from backend.pipeline.producers import asr

    monkeypatch.setattr(settings, "pipeline_whisper_model", "  ")
    assert asr.whisper_model_name() == "base"
    monkeypatch.setattr(settings, "pipeline_whisper_model", "large-v3")
    assert asr.whisper_model_name() == "large-v3"


def test_whisper_repo_id_follows_engine_registry() -> None:
    """档位→repo 不能按 pattern 猜：`turbo`/`large`/`distil-*` 都不符合直觉。"""
    from backend.pipeline.producers.asr import _whisper_repo_id

    assert _whisper_repo_id("base") == "Systran/faster-whisper-base"
    assert _whisper_repo_id("large") == "Systran/faster-whisper-large-v3"
    assert _whisper_repo_id("turbo") == "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    assert _whisper_repo_id("some-org/some-model") == "some-org/some-model"


@pytest.mark.asyncio
async def test_ensure_model_skips_network_when_ready(isolated_data_dir, monkeypatch) -> None:
    from backend.pipeline.producers import asr

    d = paths.whisper_model_dir("base")
    d.mkdir(parents=True)
    for f in paths.WHISPER_CORE_FILES:
        (d / f).write_bytes(b"x")

    async def boom(*_a, **_k):
        raise AssertionError("已就绪还去下模型 = 每次转写都在联网")

    monkeypatch.setattr(hf, "download_files", boom)
    assert await asr.ensure_model() == d


@pytest.mark.asyncio
async def test_ensure_model_failure_alerts_once_and_returns_none(
    isolated_data_dir, monkeypatch
) -> None:
    from backend.pipeline.producers import asr

    async def fail(*_a, **_k):
        return False, ["https://huggingface.co: ConnectError"]

    monkeypatch.setattr(hf, "download_files", fail)
    sent: list[str] = []
    monkeypatch.setattr(alerts, "_send", sent.append)
    alerts.reset("whisper_model_download")

    assert await asr.ensure_model() is None
    assert await asr.ensure_model() is None
    assert len(sent) == 1  # 静默失败 vs 每次转写刷屏之间的折中
    assert "ConnectError" in sent[0]


def _write_whisper_model(name: str = "base") -> Path:
    """把某一档模型的核心文件铺出来——就绪探测认的是文件在不在，不认文件内容。"""
    d = paths.whisper_model_dir(name)
    d.mkdir(parents=True, exist_ok=True)
    for f in paths.WHISPER_CORE_FILES:
        (d / f).write_bytes(b"stub")
    return d


@pytest.mark.asyncio
async def test_get_whisper_loads_from_app_data_dir(isolated_data_dir, monkeypatch) -> None:
    """加载路径必须是我们自己下载的目录——并且构造参数按实测签名钉住。"""
    from backend.pipeline.producers import asr

    d = _write_whisper_model("base")

    seen: dict = {}

    def fake_model(path, **kwargs):
        seen["path"] = path
        seen.update(kwargs)
        return object()

    monkeypatch.setattr(asr, "WhisperModel", fake_model)
    monkeypatch.setattr(asr, "_WHISPER_IMPORTED", True)
    monkeypatch.setattr(asr, "_whisper_model", None)
    monkeypatch.setattr(asr, "_whisper_key", "")

    await asr._get_whisper()
    assert seen["path"] == str(d)
    assert seen["device"] == "cpu" and seen["compute_type"] == "int8"

    # 第二次不再构造（懒加载缓存生效）
    seen.clear()
    await asr._get_whisper()
    assert seen == {}
    monkeypatch.setattr(asr, "_whisper_model", None)
    monkeypatch.setattr(asr, "_whisper_key", "")


@pytest.mark.asyncio
async def test_get_whisper_missing_model_fails_fast_without_downloading(
    isolated_data_dir, monkeypatch
) -> None:
    """模型未就绪 → 立刻 AsrUnavailableError，且**一次网络都不该发生**。

    v0.35 的修法：`_get_whisper` 不再调 `ensure_model()`。此前一次转写请求会悄悄
    拉 148MB——产物级门禁实测首调 68.3s 越过 sim 的 60s 预算返回 000（契约要求
    200 或 502），而且「点一次转写就下载」用户完全不知情。下载入口只有设置页那一个。
    """
    from backend.pipeline.producers import asr

    called: list[bool] = []

    async def spy_ensure(force: bool = False):
        called.append(force)
        return paths.whisper_model_dir("base")

    monkeypatch.setattr(asr, "ensure_model", spy_ensure)
    monkeypatch.setattr(asr, "_WHISPER_IMPORTED", True)
    monkeypatch.setattr(asr, "_whisper_model", None)
    monkeypatch.setattr(asr, "_whisper_key", "")
    monkeypatch.setattr(
        asr.alerts, "notify_once", lambda *a, **k: None
    )  # 告警去 Telegram，不是本判据要验的东西

    with pytest.raises(asr.AsrUnavailableError) as exc:
        await asr._get_whisper()

    # 文案必须指得出路（设置页入口），而不是只说「不可用」
    assert "下载转写模型" in str(exc.value)
    assert called == [], "未就绪路径仍在触发下载——这正是 v0.35 要拆掉的行为"


@pytest.mark.asyncio
async def test_get_whisper_missing_model_is_the_only_path_that_raises(
    isolated_data_dir, monkeypatch
) -> None:
    """对照组：把核心文件铺齐，同一个调用就必须成功（防止修成「一律拒绝」）。"""
    from backend.pipeline.producers import asr

    _write_whisper_model("base")
    monkeypatch.setattr(asr, "_WHISPER_IMPORTED", True)
    monkeypatch.setattr(asr, "WhisperModel", lambda path, **_k: object())
    monkeypatch.setattr(asr, "_whisper_model", None)
    monkeypatch.setattr(asr, "_whisper_key", "")

    model = await asr._get_whisper()
    assert model is not None
    assert asr._whisper_key.endswith(str(paths.whisper_model_dir("base")))


@pytest.mark.asyncio
async def test_switching_size_rebuilds_model(isolated_data_dir, monkeypatch) -> None:
    from backend.pipeline.producers import asr

    built: list[str] = []

    _write_whisper_model("base")
    _write_whisper_model("small")
    monkeypatch.setattr(asr, "_WHISPER_IMPORTED", True)
    monkeypatch.setattr(
        asr, "WhisperModel", lambda path, **_k: built.append(str(path)) or object()
    )
    monkeypatch.setattr(asr, "_whisper_model", None)
    monkeypatch.setattr(asr, "_whisper_key", "")

    monkeypatch.setattr(settings, "pipeline_whisper_model", "base")
    await asr._get_whisper()
    await asr._get_whisper()
    assert built == [str(paths.whisper_model_dir("base"))]

    monkeypatch.setattr(settings, "pipeline_whisper_model", "small")
    await asr._get_whisper()
    assert built == [
        str(paths.whisper_model_dir("base")),
        str(paths.whisper_model_dir("small")),
    ]
    monkeypatch.setattr(asr, "_whisper_model", None)
    monkeypatch.setattr(asr, "_whisper_key", "")


def test_asr_never_delegates_model_location_to_the_library() -> None:
    """模型落位只能有一个作者。

    两条各自对应一种复发方式：
    - `download_root=` / `cache_dir=` / `expanduser`：把目录交还给 HF 缓存树，
      于是模型又落到 `$HOME`，`HERTZ_DATA_DIR` 隔离失效、能力矩阵永远 pending。
    - `WhisperModel("base", ...)`：传档位名而不是目录，库自己去联网解析——
      这正是 v0.31 打包版「转写第一次调用就卡 45 秒」的路径。
    """
    src = (ROOT / "backend/pipeline/producers/asr.py").read_text(encoding="utf-8")
    for banned in ("download_root", "cache_dir", "expanduser"):
        assert banned not in src, f"asr.py 里出现了 {banned}——模型落位又长出第二个作者"
    assert 'WhisperModel("' not in src and "WhisperModel('" not in src, (
        "WhisperModel 必须收本地目录，不是档位名"
    )


# ---------- 能力矩阵与端点 ----------


def test_deps_whisper_card_reports_pending_before_download(
    isolated_data_dir, monkeypatch
) -> None:
    from backend.infrastructure import deps

    monkeypatch.setattr(settings, "pipeline_whisper_model", "base")
    monkeypatch.setattr(settings, "xinference_stt_model_id", "")
    monkeypatch.setattr(deps, "whisper_importable", lambda: True)
    card = deps._check_whisper_model()
    assert card["status"] == "pending"
    assert card["dir"] == str(paths.whisper_model_dir("base"))

    d = paths.whisper_model_dir("base")
    d.mkdir(parents=True)
    for f in paths.WHISPER_CORE_FILES:
        (d / f).write_bytes(b"x")
    assert deps._check_whisper_model()["status"] == "ok"


@pytest.mark.asyncio
async def test_whisper_model_status_endpoint(client, isolated_data_dir, monkeypatch) -> None:
    from backend.infrastructure import deps
    from backend.pipeline.producers import asr

    monkeypatch.setattr(settings, "pipeline_whisper_model", "base")
    monkeypatch.setattr(asr, "xinference_configured", lambda: False)
    monkeypatch.setattr(deps, "whisper_importable", lambda: True)

    r = await client.get("/api/pipeline/whisper-model/status")
    assert r.status_code == 200
    body = r.json()
    assert body["deps"] is True
    assert body["model_ready"] is False
    assert body["model_name"] == "base"
    assert body["xinference_on"] is False
    assert body["dir"].endswith("faster-whisper-base")


@pytest.mark.asyncio
async def test_translate_model_status_shares_path_authority(
    client, isolated_data_dir
) -> None:
    """翻译卡片的就绪判定也必须走 paths——两处各数一遍文件名迟早会数得不一样。"""
    r = await client.get("/api/pipeline/translate-model/status")
    assert r.status_code == 200
    assert r.json()["model_ready"] is False

    d = paths.local_mt_dir()
    d.mkdir(parents=True)
    for f in paths.LOCAL_MT_CORE_FILES:
        (d / f).write_bytes(b"x")
    assert (await client.get("/api/pipeline/translate-model/status")).json()[
        "model_ready"
    ] is True


@pytest.mark.asyncio
async def test_downloads_are_serialized(tmp_path, monkeypatch) -> None:
    """两个并发下载必须排队。

    实测形状：设置页点「下载转写模型」，产线同时开始转写并触发第二次 ensure_model
    ——两条流写同一个 `model.bin.part`，交错写出来的 model.bin 直接损坏，
    而就绪探测只看文件名。串行之后后到的那次靠 `exists()` 幂等检查几乎立刻返回。
    """
    active = {"n": 0, "max": 0}

    class _SlowResp(_FakeResp):
        async def aiter_bytes(self, chunk_size: int):
            active["n"] += 1
            active["max"] = max(active["max"], active["n"])
            try:
                await asyncio.sleep(0.02)
                yield self._body
            finally:
                active["n"] -= 1

    class _SlowClient(_FakeClient):
        def stream(self, _method: str, url: str) -> _FakeResp:
            self._calls.append(url)
            return _SlowResp(200, b"z" * 64)

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", lambda **_k: _SlowClient({}, []))
    a, b = await asyncio.gather(
        hf.download_files("Systran/m", (("model.bin", True),), tmp_path, ["https://e1"]),
        hf.download_files("Systran/m", (("model.bin", True),), tmp_path, ["https://e1"]),
    )
    assert a[0] is True and b[0] is True
    assert active["max"] == 1, f"两条下载流同时在写同一个 .part（峰值 {active['max']}）"


def test_translate_engine_does_not_reimplement_transport() -> None:
    """下载传输只有 `hf.download_files` 一个实现；引擎各自手搓 httpx 会走偏。"""
    src = (ROOT / "backend/pipeline/producers/translate_engine.py").read_text(
        encoding="utf-8"
    )
    assert "resolve/main" not in src
    assert "httpx" not in src


def test_streaming_download_uses_async_iteration() -> None:
    """`iter_bytes`（同步）在 AsyncClient 的流式响应上直接抛错——写错了要靠这条
    断言在提交时抓住，而不是等第一次下载。"""
    src = (ROOT / "backend/infrastructure/hf.py").read_text(encoding="utf-8")
    assert "aiter_bytes" in src
    assert "iter_bytes(chunk_size" not in src
