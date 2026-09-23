"""script_json 字段契约（v0.22.x B 系收口，D-190 遗留清偿）。

单一真相源：所有 script_json 读写的键名在此定义，消除 6 处散写漂移。
消费方按需 import 常量；禁止在模块外硬编码键名字符串。

字段分组：
- 产线产物：narration / subtitle_zh / content_source
- B 站包装：bili_* 系列
- 来源与降级标记：_sub_src / _sub_tgt / subtitle_source / produce_warnings
"""

# ---- 产线产物 ----
NARRATION = "narration"
SUBTITLE_ZH = "subtitle_zh"
CONTENT_SOURCE = "content_source"

# ---- B 站包装 ----
BILI_TITLE = "bili_title"
BILI_TITLE_ALTERNATIVES = "bili_title_alternatives"
BILI_DESC = "bili_desc"
BILI_TAGS = "bili_tags"
BILI_TID = "bili_tid"
BILI_COPYRIGHT = "bili_copyright"

# ---- 来源与降级标记 ----
MODE = "mode"
SOURCE = "source"
SUB_SOURCE = "_sub_src"
SUB_TARGET = "_sub_tgt"
SUBTITLE_SOURCE = "subtitle_source"
PRODUCE_WARNINGS = "produce_warnings"

# ---- 制作标记 ----
PRODUCED_DEGRADED = "produced_degraded"
COMPOSE_QUALITY = "compose_quality"
DURATION_S = "duration_s"

# ---- subtitle_source 合法值 ----
SUB_FROM_ASR = "asr"
SUB_FROM_NARRATION_FALLBACK = "narration_fallback"

# ---- 归档白名单（service_archive 键清洗）----
ARCHIVE_SAFE_KEYS = frozenset({
    BILI_TITLE, BILI_DESC, BILI_TAGS, BILI_TID, BILI_COPYRIGHT,
})
