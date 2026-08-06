"""KeychainCrypto — 主密钥托管与 API Key 加解密（AXIOM §8.2）。

设计：
- 主密钥存放在 macOS Keychain（`security add-generic-password`），
  磁盘上只存被主密钥加密的密文——明文 key 永不落盘。
- 无 Keychain 环境（Linux dev / CI）降级为 data/secrets/master.key
  （chmod 600），行为一致。
- 加密用 Fernet（对称）；主密钥丢失时所有已存 key 无法恢复——
  由上层提供"重新配置"入口，这是 §8.2 的代价，比明文安全得多。
"""

import logging
import os
import shutil
import subprocess
from pathlib import Path

from cryptography.fernet import Fernet

logger = logging.getLogger(__name__)

_SERVICE = "hertz-ai"
_ACCOUNT = "master-key"
_KEYCHAIN_LABEL = "Hertz AI 底座主密钥"


class KeychainCrypto:
    def __init__(self, data_dir: Path | None = None) -> None:
        self._data_dir = data_dir or Path(os.environ.get("HERTZ_DATA_DIR", "data"))
        self._fallback_path = self._data_dir / "secrets" / "master.key"
        self._fernet: Fernet | None = None
        self._use_keychain = (
            shutil.which("security") is not None and os.uname().sysname == "Darwin"
        )

    # ---------- key management ----------

    def _keychain_get(self) -> str | None:
        try:
            out = subprocess.run(
                ["security", "find-generic-password", "-s", _SERVICE, "-a", _ACCOUNT, "-w"],
                capture_output=True, text=True, timeout=10, check=False,
            )
            if out.returncode == 0:
                return out.stdout.strip()
        except (subprocess.SubprocessError, OSError) as exc:
            logger.warning("keychain read failed: %s", exc)
        return None

    def _keychain_set(self, key: str) -> None:
        try:
            subprocess.run(
                ["security", "add-generic-password", "-s", _SERVICE, "-a", _ACCOUNT,
                 "-w", key, "-U", "-j", _KEYCHAIN_LABEL],
                capture_output=True, text=True, timeout=10, check=False,
            )
        except (subprocess.SubprocessError, OSError) as exc:
            logger.warning("keychain write failed: %s", exc)

    def _ensure_master_key(self) -> bytes:
        """取主密钥；不存在则生成并存好（Keychain 或 fallback 文件）。"""
        if self._use_keychain:
            raw = self._keychain_get()
            if raw:
                return raw.encode()
            key = Fernet.generate_key().decode()
            self._keychain_set(key)
            return key.encode()
        # fallback: chmod 600 文件
        if self._fallback_path.exists():
            return self._fallback_path.read_bytes().strip()
        self._fallback_path.parent.mkdir(parents=True, exist_ok=True)
        key = Fernet.generate_key()
        self._fallback_path.write_bytes(key)
        self._fallback_path.chmod(0o600)
        return key

    def _fernet_instance(self) -> Fernet:
        if self._fernet is None:
            self._fernet = Fernet(self._ensure_master_key())
        return self._fernet

    # ---------- public ----------

    def encrypt(self, plaintext: str) -> str:
        if not plaintext:
            return ""
        return self._fernet_instance().encrypt(plaintext.encode()).decode()

    def decrypt(self, ciphertext: str) -> str:
        if not ciphertext:
            return ""
        try:
            return self._fernet_instance().decrypt(ciphertext.encode()).decode()
        except Exception as exc:  # noqa: BLE001 — 解密失败当作不可用而非崩溃
            logger.error("failed to decrypt secret: %s", exc)
            return ""

    @property
    def storage_kind(self) -> str:
        return "keychain" if self._use_keychain else "file"


keychain_crypto = KeychainCrypto()
