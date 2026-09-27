"""回环地址不得走系统代理（v0.33）——判据只有一处，行为由下载测试兜底。

实测形状：用户开着 Clash（macOS 系统代理 127.0.0.1:7897）时，`test_download_api`
与 `test_download_resilience` 里那些「起一个本地 HTTP 服务再下载」的测试全部
随机变成 `HTTP_502`；同一台机器上 `NO_PROXY=127.0.0.1` 一设就绿。macOS 的代理
例外表里明明写着 127.0.0.1，但 httpx 的 trust_env 只读环境变量，不读那张表。
"""

from __future__ import annotations

from backend.infrastructure.net import client_kwargs, is_loopback_url


def test_loopback_detection_covers_real_shapes() -> None:
    assert is_loopback_url("http://127.0.0.1:61976/media.mp4") is True
    assert is_loopback_url("http://localhost:8000/x") is True
    assert is_loopback_url("http://[::1]:9000/x") is True
    # 前缀相似的外部地址不许被误判成回环
    assert is_loopback_url("http://127.0.0.1.example.com/x") is False
    assert is_loopback_url("https://v.redd.it/abc/DASHPlaylist.mpd") is False


def test_client_kwargs_only_disables_trust_env_for_loopback() -> None:
    """外部地址保持默认（跟随系统代理，Reddit 就靠它）；回环关掉 trust_env。"""
    assert client_kwargs("http://127.0.0.1:9/x.mp4")["trust_env"] is False
    assert client_kwargs("https://api.siliconflow.cn/v1")["trust_env"] is True
    # 显式传进来的值优先，不覆盖调用方的决定
    assert client_kwargs("http://127.0.0.1:9/x.mp4", trust_env=True)["trust_env"] is True
    # 其余参数原样透传（这里不重新发明 httpx 的构造签名）
    kw = client_kwargs("http://127.0.0.1:9/x.mp4", timeout=30, follow_redirects=True)
    assert kw["timeout"] == 30 and kw["follow_redirects"] is True


def test_system_proxy_returns_usable_url(monkeypatch) -> None:
    import urllib.request

    from backend.infrastructure.net import system_proxy

    monkeypatch.setattr(urllib.request, "getproxies", lambda: {"http": "http://127.0.0.1:7897"})
    assert system_proxy() == "http://127.0.0.1:7897"
    monkeypatch.setattr(urllib.request, "getproxies", lambda: {})
    assert system_proxy() is None


def test_system_proxies_is_the_full_table_author(monkeypatch) -> None:
    """全量表（infra/hf 诊断要的就是这个）同样只认按属性打桩的调用形态。"""
    import urllib.request

    from backend.infrastructure.net import system_proxies

    monkeypatch.setattr(
        urllib.request, "getproxies", lambda: {"https": "http://p:1", "all": "http://a:2"}
    )
    assert system_proxies() == {"https": "http://p:1", "all": "http://a:2"}
    # https 优先由 system_proxy 导出（不是 all/other）
    from backend.infrastructure.net import system_proxy

    assert system_proxy() == "http://p:1"


def test_remote_provider_still_follows_env_proxy() -> None:
    """本地直连不等于「所有 Provider 都不走代理」——远端主机必须照旧。"""
    assert client_kwargs("http://127.0.0.1:11434/v1")["trust_env"] is False
    assert client_kwargs("https://comfyui.example.com:8188")["trust_env"] is True
