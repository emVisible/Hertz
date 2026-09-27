"""HyperFrames CLI 驱动（移植自 monoline `hf/cli.py`，CLI-first 路线）。

铁律（上游 plan 原文保留）：
- stdin=DEVNULL；
- returncode 是成功的唯一权威，不 tail 管道；
- 永远走 pin 版本的二进制（本地预留位 → npx），不用裸 `hyperframes`。

Hertz 适配：`Settings` 形参改为显式构造参数；sidecar HTTP（render_via_sidecar）
保留方法但默认不走——二期按 CLI 实测效果再决定是否拉起常驻 sidecar（D-026）。
Node 解析：HERTZ_NODE22_BIN → nvm v22.14.0 → 系统 node（验 major==22）。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

HF_VERSION = "0.8.63"

# config quality（UI: draft/looks/delivery）→ producer /render vocab
_QUALITY_TO_CLI = {"draft": "draft", "looks": "standard", "standard": "standard",
                   "delivery": "high", "high": "high"}

# Multi-worker capture on macOS is screenshot-based and cannot stream, so the producer
# writes EVERY frame to disk (~6.9 GB for a 110s @ 60fps 1080p render) and aborts when the
# volume can't hold it. mp4/mov stream straight to the encoder at one worker.
RENDER_WORKERS = 1


@dataclass
class ProcResult:
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0


class HFError(RuntimeError):
    pass


class SidecarUnavailableError(RuntimeError):
    """Sidecar unreachable/refused at connect time → caller may fall back to the CLI."""


def _render_argv(project_dir: str, out_path: str, *, fps: int, quality: str, fmt: str) -> list[str]:
    return ["render", str(project_dir), "-o", str(out_path), "--fps", str(fps),
            "--quality", quality, "--format", fmt, "--workers", str(RENDER_WORKERS)]


def _tail_error(stderr: str, limit: int = 600) -> str:
    """The actionable sentence sits right under '✗ Render failed' and is followed by a
    long enumeration of possible causes — slicing the last N chars kept only that tail and
    threw away the numbers (how much space was needed vs actually free)."""
    marker = "Render failed"
    i = stderr.rfind(marker)
    body = stderr[i + len(marker):] if i > -1 else stderr
    lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
    return " | ".join(lines)[:limit] if lines else stderr[-limit:]


def _lint_summary(data: dict) -> str:
    findings = data.get("findings") or []
    errs = [f for f in findings if f.get("severity") == "error"] or findings
    return json.dumps(errs[:8], ensure_ascii=False)[:800]


def resolve_node_bin() -> str:
    """Node 22 解析：显式 env → nvm v22.14.0 → 系统 node（验 major）。"""
    candidates = []
    env_bin = os.environ.get("HERTZ_NODE22_BIN", "").strip()
    if env_bin:
        candidates.append(env_bin)
    candidates.append(str(Path.home() / ".nvm/versions/node/v22.14.0/bin/node"))
    found = shutil.which("node")
    if found:
        candidates.append(found)
    for c in candidates:
        p = Path(c)
        if p.is_file():
            return str(p)
    raise HFError("未找到可用的 node（需要 v22；可设 HERTZ_NODE22_BIN 指向 node 22）")


def node_major(node_bin: str) -> int | None:
    import subprocess

    try:
        out = subprocess.run([node_bin, "--version"], capture_output=True, text=True,
                             timeout=15)
        m = re.match(r"v(\d+)", out.stdout.strip())
        return int(m.group(1)) if m else None
    except Exception:  # noqa: BLE001 — 探活失败视为不可用
        return None


def browser_cache_dir() -> Path:
    """Chrome headless shell 缓存（puppeteer 布局），缺失时 render 置灰。"""
    from backend.infrastructure.storage import file_store

    return file_store.data_dir / "models" / "browser"


def chrome_available() -> bool:
    """Chrome headless 可用性：data 模型缓存，或系统 Chrome（puppeteer 自动发现）。

    实测：/Applications/Google Chrome.app 存在时 render 可直接成功，无需下载。
    """
    if any(browser_cache_dir().rglob("chrome-headless-shell")):
        return True
    if (shutil.which("google-chrome") or shutil.which("chromium")
            or shutil.which("chromium-browser")):
        return True
    return (Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome").exists()
            or Path("/Applications/Chromium.app/Contents/MacOS/Chromium").exists())


class HF:
    def __init__(self, *, hf_bin: str | None = None, node_bin: str | None = None,
                 workdir: Path | None = None, timeout: float = 1800) -> None:
        self.hf_bin = hf_bin  # None → 预留位 → npx pin 版
        self.node_bin = node_bin
        self.workdir = workdir
        self.timeout = timeout
        # Node bin 目录（sync 期解析；ASYNC240 禁止 async 内调 pathlib/os.path）
        self._node_dir: str | None = None
        if node_bin and os.path.exists(node_bin):
            self._node_dir = str(Path(node_bin).parent)

    def _cmd_prefix(self) -> list[str]:
        from backend.infrastructure.storage import file_store

        vendor = file_store.data_dir / "vendor" / "hyperframes"
        for cand in ([self.hf_bin] if self.hf_bin else []):
            if Path(cand).exists():
                return [cand]
        # 本地预留位：npm install --prefix data/vendor/hyperframes hyperframes@x
        local_bin = vendor / "node_modules" / ".bin" / "hyperframes"
        if local_bin.exists():
            return [str(local_bin)]
        standalone = vendor / "hyperframes"
        if standalone.exists():
            return [str(standalone)]
        return ["npx", "--yes", f"hyperframes@{HF_VERSION}"]

    async def run(self, args: list[str], *, cwd: str | None = None,
                  timeout_s: float = 600) -> ProcResult:
        cmd = [*self._cmd_prefix(), *args]
        env = {
            **os.environ,
            "HYPERFRAMES_PYTHON": sys.executable,
            "PUPPETEER_CACHE_DIR": str(browser_cache_dir()),
        }
        if self._node_dir:
            env["PATH"] = self._node_dir + os.pathsep + env.get("PATH", "")
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd or (str(self.workdir) if self.workdir else None),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        except TimeoutError as exc:
            proc.kill()
            raise HFError(f"hyperframes {' '.join(args)} timed out after {timeout_s}s") from exc
        return ProcResult(proc.returncode or 0, out.decode("utf-8", "replace"),
                          err.decode("utf-8", "replace"))

    @staticmethod
    def parse_lint_output(stdout: str) -> dict:
        data: dict = {}
        m = re.search(r"\{.*\}", stdout, re.S)
        if m:
            try:
                data = json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
        findings = data.get("findings") or []
        errors = [f for f in findings if f.get("severity") == "error"]
        data["_error_count"] = len(errors)
        return data

    async def lint(self, project_dir: str) -> tuple[bool, dict]:
        """Return (ok, data). ok = process succeeded AND no error-severity findings."""
        # cwd 必须为 None：project_dir 是绝对路径，cwd 设为工程目录会导致 CLI
        # 把参数按相对路径再拼一次（实测 Not a directory 双倍路径）。
        r = await self.run(["lint", "--json", project_dir], timeout_s=120)
        data = self.parse_lint_output(r.stdout)
        ok = r.ok and data.get("_error_count", 0) == 0
        return ok, data

    def lint_quality(self, quality: str) -> str:
        return _QUALITY_TO_CLI.get(quality, "standard")

    async def render(self, project_dir: str, out_path: str, *, fps: int = 30,
                     quality: str = "standard", fmt: str = "mp4") -> ProcResult:
        r = await self.run(
            _render_argv(project_dir, out_path, fps=fps,
                         quality=self.lint_quality(quality), fmt=fmt),
            # cwd=None（同 lint 注释）：绝对路径 + 工程 cwd 会双倍拼接
            timeout_s=self.timeout,
        )
        if not r.ok:
            raise HFError(f"render failed rc={r.returncode}: {_tail_error(r.stderr)}")
        return r

    async def render_via_sidecar(self, sidecar_url: str, project_dir: str, out_path: str, *,
                                 fps: int = 30, quality: str = "standard",
                                 fmt: str = "mp4") -> dict:
        """二期预留：常驻 sidecar 渲染。CLI-first 阶段默认不调用。"""
        import httpx

        from backend.infrastructure.net import client_kwargs

        payload = {"projectDir": str(project_dir), "output": str(out_path), "fps": fps,
                   "quality": self.lint_quality(quality), "format": fmt,
                   "workers": RENDER_WORKERS}
        try:
            # sidecar 在本机：必须直连——代理到不了回环地址，Clash 在时只会回
            # 502；判据在 infrastructure/net。
            async with httpx.AsyncClient(
                    **client_kwargs(sidecar_url.rstrip("/"),
                                    timeout=httpx.Timeout(self.timeout, connect=5))) as client:
                resp = await client.post(f"{sidecar_url.rstrip('/')}/render", json=payload)
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            raise SidecarUnavailableError(str(e)) from e
        except httpx.TimeoutException as e:
            raise HFError(f"sidecar render timed out after {self.timeout}s") from e
        except httpx.HTTPError as e:
            raise SidecarUnavailableError(str(e)) from e
        if resp.status_code in (502, 503, 504):
            raise SidecarUnavailableError(f"HTTP {resp.status_code}")
        try:
            data = resp.json()
        except Exception as exc:  # noqa: BLE001
            if resp.status_code >= 500:
                raise SidecarUnavailableError(
                    f"HTTP {resp.status_code} (non-JSON body)") from exc
            raise HFError(
                f"sidecar render bad response {resp.status_code}: {resp.text[:300]}") from exc
        if resp.status_code >= 500 or not data.get("success"):
            raise HFError(f"sidecar render failed: {data.get('error') or resp.text[:300]}")
        return data
