"""Monoline 融合域测试替身：StubTTS（正弦 wav）+ FakeHF（免 Chrome/免网络）。"""

import asyncio
import io
import json
from pathlib import Path


class StubTTS:
    """0.5s 正弦 wav：assemble/ffprobe 真实链路可测，不依赖 Kokoro 权重。"""

    async def synthesize(self, text: str, voice: str, rate: str = "+0%") -> bytes:
        import numpy as np
        import soundfile as sf

        sr = 22050
        t = np.arange(int(sr * 0.5)) / sr
        buf = io.BytesIO()
        sf.write(buf, (0.3 * np.sin(2 * np.pi * 440 * t)).astype("float32"), sr, format="WAV")
        return buf.getvalue()


class FakeHF:
    """lint 直过；render 按 timings 总时长生成带音频的测试 MP4。"""

    async def lint(self, project_dir: str) -> tuple:
        return True, {"findings": [], "_error_count": 0}

    async def render(self, project_dir: str, out_path: str, **kw) -> dict:
        timings = json.loads((Path(project_dir).parent / "ir" / "timings.json").read_text())
        total = float(timings["total"])
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc2=duration={total}:size=320x240:rate=30",
            "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=stereo:d={total}",
            "-t", str(total), "-c:v", "libx264", "-c:a", "aac", "-shortest", out_path,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"fake render failed: {err.decode()[-200:]}")
        return {"video": out_path, "via": "fake", "format": "mp4"}
