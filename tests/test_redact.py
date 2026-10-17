"""日志脱敏的判据。

这些断言的形状是"**值不见了、键名还在**"：只断值不满足排查需求
（得知道是哪个字段坏了），只断键名又等于没脱敏（值还在文件里）。
"""

from backend.infrastructure.redact import REDACTED, redact_exception, redact_secrets


class TestRedactSecrets:
    def test_key_value_form_is_masked_but_key_survives(self) -> None:
        out = redact_secrets("client_secret=do-not-echo-me")
        assert "client_secret" in out
        assert "do-not-echo-me" not in out
        assert REDACTED in out

    def test_json_form_keeps_structure(self) -> None:
        out = redact_secrets('{"client_secret": "abc123", "client_id": "keep-me"}')
        assert "abc123" not in out
        assert "client_secret" in out
        # 非密钥字段不动：否则日志会失去大部分诊断价值
        assert "keep-me" in out

    def test_query_string_form_is_masked(self) -> None:
        out = redact_secrets("https://cdn.example.com/v.mp4?Expires=1&Signature=SECRETVALUE&x=2")
        assert "SECRETVALUE" not in out
        assert "Expires=1" in out  # 非密钥参数保留
        assert "x=2" in out

    def test_common_secret_names(self) -> None:
        for raw in (
            "password=hunter2",
            "api_key: k-123",
            "access_token=eyJhbGciOi",
            "Authorization: Bearer abc.def",
        ):
            out = redact_secrets(raw)
            assert "hunter2" not in out
            assert "k-123" not in out
            assert "eyJhbGciOi" not in out
            assert "abc.def" not in out

    def test_text_without_secrets_is_untouched(self) -> None:
        raw = "Reddit OAuth 换取 token 失败 (HTTP 401)"
        assert redact_secrets(raw) == raw

    def test_empty_input(self) -> None:
        assert redact_secrets("") == ""


class TestRedactException:
    def test_class_name_is_kept_and_value_masked(self) -> None:
        exc = RuntimeError("failed——client_secret=do-not-echo-me")
        out = redact_exception(exc)
        # 类名必须留着：API 侧的 hint 就是"异常类型名 + 出路"，少了它这条信息没用
        assert out.startswith("RuntimeError:")
        assert "do-not-echo-me" not in out

    def test_plain_exception_keeps_message(self) -> None:
        assert redact_exception(ValueError("boom")) == "ValueError: boom"


class TestMutationResistance:
    """成对变异：脱敏被摘掉时必须变红。"""

    def test_bypass_helper_would_leak(self) -> None:
        # 直接回显原文（修复前的写法）——用来证明上面那些断言不是空转的
        exc = RuntimeError("client_secret=do-not-echo-me")
        naive = f"{exc.__class__.__name__}: {exc}"
        assert "do-not-echo-me" in naive  # 旧写法确实会漏
        assert "do-not-echo-me" not in redact_exception(exc)  # 新写法不漏