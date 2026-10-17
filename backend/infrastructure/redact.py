"""日志脱敏：把"顺手写进日志"的密钥值换成占位符。

## 为什么要有这一层

API 响应侧早就做了脱敏（`pipeline_ops._reddit_auth_status` 只回异常**类名**，
`tests/test_reddit_auth_card.py` 也断言了密钥不出现在 hint 里）。但**日志侧是
另一条通道**：那里写的是 `str(exc)` 原文。

差别在于"宽度由谁决定"：异常文本里会不会带密钥，取决于**异常作者**——
今天 Reddit 那条不带，但只要哪天有人在异常里塞了响应体，日志就会把
`client_secret=...` 原样写进磁盘上那个明文文件，而明文日志会进备份、
会被贴进工单、会被 grep 出来。

所以规矩是：**凡是要写进日志的外部文本，一律先过这一层**。
API 侧继续只回类名（更严，也更好读），日志侧保留可诊断信息但值被掩掉。

## 判据

`tests/test_redact.py`：键名仍在、值消失、URL 里的 query 也要脱敏；
成对变异（改回原文）打红。
"""

from __future__ import annotations

import re

# 需要脱敏的键名。顺序无意义（正则按 key= 统一匹配）。
_SECRET_KEYS = (
    "client_secret",
    "app_secret",
    "secret_key",
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "auth_token",
    "id_token",
    "password",
    "passwd",
    "pwd",
    "secret",
    "token",
    "cookie",
    # 签名直链（`download.py` 会把 signed URL 写进运行日志）：凭证就在 query 里，
    # 且形态是 `Signature=` / `X-Amz-Signature=` / `sig=`——不带 token 字样，
    # 所以必须单列，否则"日志里有链接"就等于"日志里有凭证"。
    "authorization",
    "signature",
    "x-amz-signature",
    "sig",
)

# `key=value` / `key: value` / `"key": "value"`，值吃到分隔符为止。
# 值里允许引号（JSON 形态）与 `Bearer ` 前缀（Authorization 头），前缀本身保留、
# 只换后面的凭证——`Authorization: Bearer ***` 仍然是可读的诊断信息。
_SECRET_RE = re.compile(
    r"(?P<key>[\"']?(?:" + "|".join(_SECRET_KEYS) + r")[\"']?)"
    r"(?P<sep>\s*[:=]\s*)"
    r"(?P<value>Bearer\s+[^\s,;&)\]}]+|\"[^\"]*\"|'[^']*'|[^\s,;&)\]}]+)",
    re.IGNORECASE,
)

# URL query：`?client_secret=abc&x=1` → 只换值，保留结构便于排查。
_QUERY_SECRET_RE = re.compile(
    r"(?P<key>\b(?:" + "|".join(_SECRET_KEYS) + r")=)(?P<value>[^&\s\"'#]+)",
    re.IGNORECASE,
)

REDACTED = "***REDACTED***"


def redact_secrets(text: str) -> str:
    """把文本里 `key=value` 形态的密钥值换成 :data:`REDACTED`。

    保留键名与分隔符（`client_secret=***REDACTED***`）——排查时要能确认
    "是哪个字段有问题"，而不是只知道"有东西被涂了"。
    """
    if not text:
        return text
    out = _QUERY_SECRET_RE.sub(lambda m: f"{m.group('key')}{REDACTED}", text)
    out = _SECRET_RE.sub(lambda m: f"{m.group('key')}{m.group('sep')}{REDACTED}", out)
    return out


def redact_exception(exc: BaseException) -> str:
    """异常 → 可安全落盘的文本（类名 + 脱敏后的消息）。

    类名必须带上：`_reddit_auth_status` 给前端的 hint 就是"异常类型名 +
    出路"，少了类名这条信息对排查没用。
    """
    return f"{exc.__class__.__name__}: {redact_secrets(str(exc))}"