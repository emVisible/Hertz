"""出网前的代理旁路判断（v0.33 单一作者）。

存在理由（实测）：用户开着 Clash（macOS 系统代理 127.0.0.1:7897）时，对本机
回环地址发起的媒体请求会被塞进代理，代理回 **HTTP 502** —— 因为代理压根无法
访问你的 127.0.0.1。macOS 的「代理例外」列表里其实写着 127.0.0.1/localhost，
但 httpx 的 `trust_env` 只读 `NO_PROXY` **环境变量**，不读系统例外表，所以那条例外
对我们无效。

后果有两层：测试里所有本地 HTTP 服务随机变红（同一个环境，`NO_PROXY` 一设就好），
以及生产上任何指向本站的源（自建媒体站、`pipeline_allow_loopback_urls` 打开时）
都必然失败。回环/站内地址一律直连，外部地址保持「跟随系统代理」的原行为。
"""

from __future__ import annotations

import ipaddress
from urllib.parse import urlparse

_LOOPBACK_HOSTS = frozenset({"localhost", "0.0.0.0", "::"})


def is_loopback_url(url: str) -> bool:
    """主机名本身是不是回环/本站地址。

    必须走 `ipaddress` 而不是字符串前缀：`"127." in host` 会把
    `127.0.0.1.example.com` 这种**外部**域名误判成回环（测试里就当场被抓到）。
    """
    host = (urlparse(url or "").hostname or "").lower().strip("[]")
    if host in _LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def client_kwargs(url: str, **kwargs) -> dict:
    """httpx client 的构造参数：外部地址按默认（跟随环境变量/系统代理），
    回环地址关掉 `trust_env`（代理到不了你的本机，留着只会换来 502）。"""
    kwargs.setdefault("trust_env", not is_loopback_url(url))
    return kwargs
