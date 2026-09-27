"""Voice registry (V8) — the curated set of built-in TTS voices + audition samples.

Kokoro-82M ships ~54 voices; the HyperFrames CLI exposes them all by ID even though
`--help` lists only 12. We surface a curated, auditionable subset — deliberately rich
in Chinese (the default language) and English, plus a few other languages. The
phonemizer language is derived from the voice-id prefix (a=en-us, b=en-gb, e=es,
f=fr-fr, j=ja, z=zh), so a job stores voice AND lang together — picking a voice sets
the matching lang and TTS can never mismatch them. Every ID here is verified to
synthesize against the pinned model (voices not in the build are excluded).
"""
from __future__ import annotations

# id = the exact --voice arg; lang = the --phonemizer-lang it needs; group = UI bucket.
VOICES: list[dict] = [
    # 中文 — 8 voices (4 female, 4 male); the priority for a Chinese-first tool.
    {"id": "zf_xiaoxiao",  "label": "晓晓 Xiaoxiao",   "lang": "zh", "group": "中文", "gender": "f"},
    {"id": "zf_xiaoyi",    "label": "晓伊 Xiaoyi",     "lang": "zh", "group": "中文", "gender": "f"},
    {"id": "zf_xiaoni",    "label": "晓妮 Xiaoni",     "lang": "zh", "group": "中文", "gender": "f"},
    {"id": "zf_xiaobei",   "label": "小北 Xiaobei",    "lang": "zh", "group": "中文", "gender": "f"},
    {"id": "zm_yunyang",   "label": "云扬 Yunyang",    "lang": "zh", "group": "中文", "gender": "m"},
    {"id": "zm_yunjian",   "label": "云健 Yunjian",    "lang": "zh", "group": "中文", "gender": "m"},
    {"id": "zm_yunxi",     "label": "云希 Yunxi",      "lang": "zh", "group": "中文", "gender": "m"},
    {"id": "zm_yunxia",    "label": "云夏 Yunxia",     "lang": "zh", "group": "中文", "gender": "m"},
    # English (US)
    {"id": "af_heart",     "label": "Heart",    "lang": "en-us", "group": "English (US)", "gender": "f"},
    {"id": "af_nova",      "label": "Nova",     "lang": "en-us", "group": "English (US)", "gender": "f"},
    {"id": "af_sky",       "label": "Sky",      "lang": "en-us", "group": "English (US)", "gender": "f"},
    {"id": "af_bella",     "label": "Bella",    "lang": "en-us", "group": "English (US)", "gender": "f"},
    {"id": "af_nicole",    "label": "Nicole",   "lang": "en-us", "group": "English (US)", "gender": "f"},
    {"id": "am_adam",      "label": "Adam",     "lang": "en-us", "group": "English (US)", "gender": "m"},
    {"id": "am_michael",   "label": "Michael",  "lang": "en-us", "group": "English (US)", "gender": "m"},
    {"id": "am_fenrir",    "label": "Fenrir",   "lang": "en-us", "group": "English (US)", "gender": "m"},
    {"id": "am_onyx",      "label": "Onyx",     "lang": "en-us", "group": "English (US)", "gender": "m"},
    # English (UK)
    {"id": "bf_emma",      "label": "Emma",      "lang": "en-gb", "group": "English (UK)", "gender": "f"},
    {"id": "bf_isabella",  "label": "Isabella",  "lang": "en-gb", "group": "English (UK)", "gender": "f"},
    {"id": "bf_lily",      "label": "Lily",      "lang": "en-gb", "group": "English (UK)", "gender": "f"},
    {"id": "bm_george",    "label": "George",    "lang": "en-gb", "group": "English (UK)", "gender": "m"},
    {"id": "bm_lewis",     "label": "Lewis",     "lang": "en-gb", "group": "English (UK)", "gender": "m"},
    # Other languages
    {"id": "ef_dora",      "label": "Dora",     "lang": "es",    "group": "Español", "gender": "f"},
    {"id": "ff_siwis",     "label": "Siwis",    "lang": "fr-fr", "group": "Français", "gender": "f"},
    {"id": "jf_alpha",     "label": "Alpha",    "lang": "ja",    "group": "日本語", "gender": "f"},
]

DEFAULT_VOICE = "zf_xiaoxiao"

# One short line per phonemizer language, played when the user auditions a voice.
SAMPLE_TEXT: dict[str, str] = {
    "en-us": "Hi, this is how I sound.",
    "en-gb": "Hello, this is how I sound.",
    "es":    "Hola, así es como sueno.",
    "fr-fr": "Bonjour, voilà ma voix.",
    "ja":    "こんにちは、これが私の声です。",
    "zh":    "你好，这就是我朗读的声音，听听看自不自然。",
}

_BY_ID = {v["id"]: v for v in VOICES}


def available() -> list[dict]:
    """The voice list for the API (defensive copy; order is the UI order)."""
    return [dict(v) for v in VOICES]


def is_known_voice(voice: str | None) -> bool:
    return bool(voice) and voice in _BY_ID


def voice_lang(voice: str) -> str | None:
    """The phonemizer lang a voice needs, or None if unknown."""
    v = _BY_ID.get(voice)
    return v["lang"] if v else None


def sample_text(voice: str) -> str:
    """Audition line for a voice (falls back to the default voice's language)."""
    lang = voice_lang(voice) or _BY_ID[DEFAULT_VOICE]["lang"]
    return SAMPLE_TEXT.get(lang, SAMPLE_TEXT["en-us"])
