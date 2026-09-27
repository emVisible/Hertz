"""Mandarin synthesis that keeps its lexical tones.

kokoro-onnx phonemizes Chinese with espeak-ng, which writes tones as *digits*
(`妈` -> `m` + `a` + tone 5). Kokoro's vocabulary is 114 symbols and contains no
digits at all, and `Tokenizer.phonemize` silently drops every character outside it —
so 妈/马/骂 all reach the model as the identical string, and 师/诗/史/市 as one.
Toneless Mandarin is exactly what "every Chinese voice sounds like a dialect" is:
the loss happens before the speaker embedding, so no voice choice can fix it.

misaki's ZHG2P emits the tone contours the model was actually trained on
(-> / rising / dipping / falling arrows, all in-vocab), so Chinese runs through it
and straight into kokoro-onnx via `is_phonemes=True`. Latin runs go to espeak
`en-us` instead: misaki passes them through raw and most ASCII letters are not in
the vocabulary either.
"""
from __future__ import annotations

import re
from pathlib import Path


# Hertz 移植：权重走 data_dir/models/kokoro（收敛本地模型目录习惯，D-024），
# 不用上游的 ~/.cache/hyperframes（Phase 0 验证权重可复用，搬过去即可）。
def _cache_dir() -> Path:
    from backend.infrastructure.storage import file_store

    return file_store.data_dir / "models" / "kokoro"


def _model_path() -> Path:
    return _cache_dir() / "models" / "kokoro-v1.0.onnx"


def _voices_path() -> Path:
    return _cache_dir() / "voices" / "voices-v1.0.bin"


_TTS_CACHE = Path.home() / ".cache" / "hyperframes" / "tts"  # 仅文档参照，不再使用
MODEL = _TTS_CACHE / "models" / "kokoro-v1.0.onnx"
VOICES = _TTS_CACHE / "voices" / "voices-v1.0.bin"

# CJK punctuation, ideographs (incl. ext. A + compatibility) — everything misaki can
# read as Chinese. Built from code points so the ranges stay legible.
_CJK_RANGES = ((0x3005, 0x3007), (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF))
# The capture group is load-bearing: re.split only returns the separators it matched
# when the pattern captures them, and the separators here are the Chinese runs.
_CJK = re.compile("([" + "".join(f"{chr(a)}-{chr(b)}" for a, b in _CJK_RANGES) + "]+)")
# Our planner emits beats like "需求->设计->开发" for flow scenes; the arrow is a
# diagram glyph, so it must become a pause rather than be read out loud.
_LONG_END = re.compile("[" + "".join(chr(c) for c in (0x2026, 0x2014, 0x2015)) + "]")
_ARROW = re.compile("[" + "".join(chr(c) for c in (0x2192, 0x21D2, 0x279C, 0x27A6)) + "]|-{1,2}>|=>")

_engine: dict = {}


def _g2p() -> dict:
    """Load the tone-carrying G2P (no model weights needed)."""
    if "g2p" not in _engine:
        from kokoro_onnx.tokenizer import Tokenizer
        from misaki import zh

        _engine["g2p"] = zh.ZHG2P()
        _engine["en"] = Tokenizer()  # espeak-backed, for Latin runs only
    return _engine


def _load() -> dict | None:
    """Load the ONNX engine, or None when this path can't run on this machine."""
    if "k" in _engine:
        return _engine
    model, voices = _model_path(), _voices_path()
    if not (model.exists() and voices.exists()):
        return None
    try:
        import soundfile  # noqa: F401
        from kokoro_onnx import Kokoro

        _g2p()
        _engine["k"] = Kokoro(str(model), str(voices))
    except Exception:  # noqa: BLE001 — missing dep / unreadable model = fall back
        return None
    return _engine


def status() -> str:
    """"ok" | "will_download" (G2P present, model not cached yet) | "missing"."""
    if _load() is not None:
        return "ok"
    try:
        _g2p()
    except Exception:  # noqa: BLE001
        return "missing"
    return "missing" if (_model_path().exists() and _voices_path().exists()) else "will_download"


def available() -> bool:
    """True when the tone-correct path can actually synthesize.

    The CLI fetches the model files on first use, so a cold machine starts on the
    espeak fallback and upgrades itself to this path once they exist.
    """
    return status() == "ok"


def phonemize(text: str) -> str:
    """Hanzi -> Kokoro phonemes with tone contours; interleaved Latin -> en-us phonemes."""
    eng = _g2p()
    from cn2an import transform
    from misaki import zh as _zh

    text = _ARROW.sub("，", text.strip())
    text = transform(text, "an2cn")          # "3倍" -> 三倍, "92%" -> 百分之九十二
    text = _zh.ZHG2P.map_punctuation(text)   # 。，！？ -> ASCII (in-vocab pauses)
    out: list[str] = []
    for seg in _CJK.split(text):
        if not seg:
            continue
        out.append(eng["g2p"].legacy_call(seg) if _CJK.fullmatch(seg) else eng["en"].phonemize(seg, "en-us"))
    return " ".join(p for p in out if p.strip())


_CLAUSE_END = re.compile(r"[，,；;、]")
_SENT_END = re.compile(r"[。！!？?]")


def _phrasing(text: str) -> list[tuple[str, str]]:
    """Split a line into (chunk, gap-kind) so each clause is voiced on its own and the
    breath between them is ours to size. Ellipses and dashes become a LONG gap."""
    from . import narration

    text = narration.clean(text)
    parts: list[tuple[str, str]] = []
    cur = ""
    for ch in text:
        cur += ch
        if _LONG_END.match(ch):
            parts.append((cur, "long"))
            cur = ""
        elif _SENT_END.match(ch):
            parts.append((cur, "sentence"))
            cur = ""
        elif _CLAUSE_END.match(ch):
            parts.append((cur, "clause"))
            cur = ""
    if cur.strip():
        parts.append((cur, "none"))
    return [(re.sub(r"\s+", " ", a).strip(), b) for a, b in parts if a.strip()]


def render(text: str, voice: str, *, speed: float = 1.0) -> tuple:
    """Synthesize one line with real breaths; return (float32 samples, sample_rate)."""
    import numpy as np
    import soundfile as sf  # noqa: F401  (kept for the writer in synthesize)

    from . import narration

    eng = _load()
    if eng is None:
        raise RuntimeError("tone-correct zh engine unavailable")
    chunks = _phrasing(text)
    if not chunks:
        raise ValueError(f"nothing to say in {text!r}")
    gaps = {"clause": narration.GAP_CLAUSE, "sentence": narration.GAP_SENTENCE,
            "long": narration.GAP_LONG, "none": 0.0}
    out: list = []
    sr = 0
    for i, (chunk, kind) in enumerate(chunks):
        phones = phonemize(chunk)
        if not phones.strip():
            continue
        audio, sr = eng["k"].create(phones, voice, speed, is_phonemes=True)
        x = np.asarray(audio, dtype=np.float32)
        x = _trim_tail(x, sr, narration.TRAIL_KEEP)
        out.append(x)
        if i < len(chunks) - 1 and gaps[kind]:
            out.append(np.zeros(int(gaps[kind] * sr), dtype=np.float32))
    if not out:
        raise ValueError(f"no phonemes for {text!r}")
    import numpy as np

    body = np.concatenate([np.zeros(int(narration.GAP_HEAD * sr), dtype=np.float32), *out,
                           np.zeros(int(narration.GAP_TAIL * sr), dtype=np.float32)])
    return body, sr


def _trim_tail(x, sr: int, keep: float):
    """Cut the model's own trailing silence down to `keep` seconds so gaps stay additive."""
    import numpy as np

    hop = max(1, int(0.01 * sr))
    thr = max(0.015, float(np.abs(x).max()) * 0.06)
    end = len(x)
    i = len(x)
    while i > 0 and i > end - int(2.0 * sr):
        seg = x[max(0, i - hop):i]
        if len(seg) and float(np.sqrt(np.mean(seg ** 2))) > thr:
            break
        i -= hop
    keep_n = int(keep * sr)
    return x[:min(len(x), i + keep_n)]


def synthesize(text: str, voice: str, out_wav: str, *, speed: float = 1.0) -> float:
    """Write one line to `out_wav`; return its duration in seconds."""
    import soundfile as sf

    audio, sr = render(text, voice, speed=speed)
    sf.write(out_wav, audio, sr)
    return len(audio) / sr
