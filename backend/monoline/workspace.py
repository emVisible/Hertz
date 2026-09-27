"""单作业工作区布局（移植自 monoline `pipeline/workspace.py`，同布局）。

根目录由调用方传入：Hertz 侧为 `FileStore.output_root() / "monoline" / <job_hex>`，
不再经 monoline settings 的 `workspaces_dir` 解析。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Workspace:
    root: Path

    @property
    def input(self) -> Path: return self.root / "input"
    @property
    def tts(self) -> Path: return self.root / "tts"
    @property
    def ir(self) -> Path: return self.root / "ir"
    @property
    def composition(self) -> Path: return self.root / "composition"
    @property
    def comp_audio(self) -> Path: return self.composition / "audio"
    @property
    def comp_assets(self) -> Path: return self.composition / "assets"
    @property
    def comp_fonts(self) -> Path: return self.composition / "fonts"
    @property
    def comp_vendor(self) -> Path: return self.composition / "vendor"
    @property
    def gate(self) -> Path: return self.root / "gate"
    @property
    def renders(self) -> Path: return self.root / "renders"
    @property
    def logs(self) -> Path: return self.root / "logs"

    def ensure(self) -> Workspace:
        for p in (self.input, self.tts, self.ir, self.composition, self.comp_audio,
                  self.comp_assets, self.comp_fonts, self.comp_vendor, self.gate,
                  self.renders, self.logs):
            p.mkdir(parents=True, exist_ok=True)
        return self

    @property
    def narration_wav(self) -> Path: return self.comp_audio / "narration.wav"
    @property
    def index_html(self) -> Path: return self.composition / "index.html"
    @property
    def font_woff2(self) -> Path: return self.comp_fonts / "cjk.woff2"
