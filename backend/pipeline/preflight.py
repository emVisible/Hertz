"""制作前预检（v0.22.x 长期机制，D-190）：按生产方式计算所需能力集。

语义（用户拍板）：**「必然产出不符合预期」的缺失 → 阻断**；
「有合理降级」的缺失 → 警告放行但显式记录进 warnings。
- translate 开而本地翻译引擎未就绪 → ❌ 阻断（产出外语字幕正是事故根源）
- voice 开而 TTS 不可用 → ❌ 阻断
- 字幕开而 ASR 不可用 → ⚠️ 警告（旁白兜底 + narration_fallback 标记已存在）
- 字幕开而转写模型未下载 → ⚠️ 警告（会先在产线里下载，说清耗时与替代路径；v0.32 S4）
- LLM 未配置 → ⚠️ 警告（脚本/包装有启发式兜底）
- LLM 未配置 → ⚠️ 警告（脚本/包装有启发式兜底）
纯函数 planner + 可注入探测，便于单测；能力数据源 = deps 缓存矩阵。
"""

from backend.pipeline.helpers import normalize_produce_flags


def plan_capability_checks(
    opts: dict | None,
    *,
    local_mt_ready: bool,
    tts_available: bool | None,
    asr_available: bool,
    whisper_model_ready: bool,
    llm_ok: bool,
) -> tuple[list[str], list[str]]:
    """返回 (blockers, warnings)。tts_available=None 表示无法判定（按警告）。

    `asr_available` = 引擎在不在（可导入/服务已配）；`whisper_model_ready` =
    模型下没下（v0.32 S4 之后才有这两个状态——此前模型藏在 `~/.cache`，
    「装了引擎」与「能转写」在源码里看起来是同一件事）。
    """
    flags = normalize_produce_flags(opts)
    blockers: list[str] = []
    warnings: list[str] = []

    if flags["passthrough"]:
        # 直发：无加工依赖；包装走启发式兜底
        if not llm_ok:
            warnings.append("LLM 未配置：标题/简介将使用兜底文案")
        return blockers, warnings

    if not llm_ok:
        warnings.append("LLM 未配置：脚本将退化为启发式文案")

    if flags["translate"] and not local_mt_ready:
        blockers.append(
            "字幕翻译不可用——本地翻译引擎未就绪"
            "（安装 sentencepiece 并在设置下载模型，或检查网络后重试）"
        )
    if flags["voice"]:
        if tts_available is False:
            blockers.append("TTS Provider 未配置——配音无法合成")
        elif tts_available is None:
            warnings.append("TTS 可用性未知——将在合成阶段确认")
    if (flags["subtitle"] or flags["translate"]) and not asr_available:
        warnings.append(
            "ASR 不可用：字幕将回退旁白文案"
            "（原声字幕缺失，条目会标记 ⚠️ 旁回退）"
        )
    elif (flags["subtitle"] or flags["translate"]) and not whisper_model_ready:
        # 不是「产不出」而是「这一条要先等下载」——不阻断，但必须显式说清耗时
        warnings.append(
            "转写模型未下载：首次转写会在产线内下载（默认档约 141MB，慢网络要十几分钟），"
            "期间该条目停在转写步骤；可先到 设置 → 流水线 一键下载再制作"
        )
    return blockers, warnings
