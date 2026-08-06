"""Provider 内置模板库（v4.3，模型不硬编码）。

模板 = OpenAI 兼容端点的出厂配置：key/名称/base_url + 是否需要 key。
**不内置模型名**——模型靠「拉取模型列表」（GET /v1/models）从远程获取，
硬编码模型名会随平台下架/改名产生幻觉（AXIOM §1.2 单一真相：远端才是权威）。

例外：comfyui / edge_tts 是本地系统连接器（无 /models 端点），保留出厂模型。
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ProviderTemplate:
    key: str
    name: str
    base_url: str
    desc: str
    # 需要 API key？False 的（本地推理）不强制 key
    needs_key: bool = True
    # 协议：openai_compat（默认）| comfyui | edge_tts（决定 TaskRouter 用哪个连接器）
    protocol: str = "openai_compat"
    # 出厂模型（仅系统连接器有；OpenAI 兼容类一律从远程拉取，此处为空）
    models: tuple[tuple[str, str, str], ...] = field(default_factory=tuple)


PROVIDER_TEMPLATES: tuple[ProviderTemplate, ...] = (
    ProviderTemplate(
        key="deepseek",
        name="DeepSeek",
        base_url="https://api.deepseek.com/v1",
        desc="国内直连，性价比高，中文理解强（主推荐）",
    ),
    ProviderTemplate(
        key="ollama",
        name="Ollama（本地 · 免费）",
        base_url="http://localhost:11434/v1",
        desc="本机运行的开源模型，无需密钥",
        needs_key=False,
    ),
    ProviderTemplate(
        key="siliconflow",
        name="硅基流动（免费额度）",
        base_url="https://api.siliconflow.cn/v1",
        desc="国内大模型聚合，注册送免费额度，覆盖 DeepSeek/Qwen/GLM 等",
    ),
    ProviderTemplate(
        key="openai",
        name="OpenAI",
        base_url="https://api.openai.com/v1",
        desc="GPT 系列，通用能力标杆（按量计费）",
    ),
    ProviderTemplate(
        key="comfyui",
        name="ComfyUI（本地出图）",
        base_url="http://127.0.0.1:8188",
        desc="本地 Stable Diffusion 工作流出图，无需密钥",
        needs_key=False,
        protocol="comfyui",
        models=(
            ("image", "comfyui-sdxl", "SDXL 文生图"),
        ),
    ),
    ProviderTemplate(
        key="edge_tts",
        name="Edge TTS（微软语音 · 免费）",
        base_url="",
        desc="微软神经语音合成，无需密钥，内置多音色",
        needs_key=False,
        protocol="edge_tts",
        models=(
            ("tts", "zh-CN-XiaoxiaoNeural", "中文女声·晓晓"),
            ("tts", "zh-CN-YunxiNeural", "中文男声·云希"),
            ("tts", "en-US-AriaNeural", "English · Aria"),
            ("tts", "en-US-GuyNeural", "English · Guy"),
        ),
    ),
)

TEMPLATE_INDEX = {t.key: t for t in PROVIDER_TEMPLATES}
