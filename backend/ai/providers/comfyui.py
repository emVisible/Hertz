"""ComfyUI image provider (local Stable Diffusion workflow backend).

Protocol flow: POST /prompt → poll /history/{id} → download /view result.
"""

import asyncio
import random
import time
from pathlib import Path

import httpx

from backend.ai.types import ImageResult


class ComfyUIProvider:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8188",
        output_dir: Path | None = None,
        poll_interval: float = 2.0,
        timeout: float = 300.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.output_dir = output_dir
        self.poll_interval = poll_interval
        self.timeout = timeout
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, read=120.0),
            # 本地服务直连：绕过 HTTP_PROXY 环境变量（同 openai_compat 注释）。
            trust_env=False,
        )

    def _build_workflow(
        self,
        prompt: str,
        negative_prompt: str,
        *,
        width: int,
        height: int,
        steps: int,
        seed: int,
    ) -> dict:
        """Default SDXL-style text2img graph.

        Node ids follow the ComfyUI default template:
        4=checkpoint, 5=empty latent, 6/7=CLIP encode, 3=KSampler, 8=VAE decode, 9=save.
        """
        return {
            "4": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "xl-base-1.0.safetensors"},
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": width, "height": height, "batch_size": 1},
            },
            "6": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": prompt, "clip": ["4", 1]},
            },
            "7": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": negative_prompt, "clip": ["4", 1]},
            },
            "3": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": seed,
                    "steps": steps,
                    "cfg": 7.0,
                    "sampler_name": "euler",
                    "scheduler": "normal",
                    "denoise": 1.0,
                    "model": ["4", 0],
                    "positive": ["6", 0],
                    "negative": ["7", 0],
                    "latent_image": ["5", 0],
                },
            },
            "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
            "9": {
                "class_type": "SaveImage",
                "inputs": {"filename_prefix": "hertz", "images": ["8", 0]},
            },
        }

    async def generate(
        self,
        prompt: str,
        negative_prompt: str = "",
        *,
        width: int = 1024,
        height: int = 1024,
        steps: int = 20,
        seed: int | None = None,
    ) -> ImageResult:
        seed = seed if seed is not None else random.randint(0, 2**32 - 1)
        workflow = self._build_workflow(
            prompt, negative_prompt, width=width, height=height, steps=steps, seed=seed
        )

        resp = await self._client.post(
            f"{self.base_url}/prompt",
            json={"prompt": workflow, "client_id": f"hertz-{int(time.time())}"},
        )
        resp.raise_for_status()
        prompt_id = resp.json()["prompt_id"]

        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            await asyncio.sleep(self.poll_interval)
            hist = await self._client.get(f"{self.base_url}/history/{prompt_id}")
            hist.raise_for_status()
            entry = hist.json().get(prompt_id)
            if not entry:
                continue
            for node_out in entry.get("outputs", {}).values():
                images = node_out.get("images", [])
                if images:
                    img = images[0]
                    return await self._download_image(img, seed)
            raise TimeoutError(f"ComfyUI run {prompt_id} finished with no image output")
        raise TimeoutError(f"ComfyUI run {prompt_id} exceeded {self.timeout:.0f}s")

    async def _download_image(self, img: dict, seed: int) -> ImageResult:
        params = {
            "filename": img["filename"],
            "subfolder": img.get("subfolder", ""),
            "type": img.get("type", "output"),
        }
        resp = await self._client.get(f"{self.base_url}/view", params=params)
        resp.raise_for_status()
        if self.output_dir is None:
            raise ValueError("output_dir not configured for ComfyUI provider")
        self.output_dir.mkdir(parents=True, exist_ok=True)
        name = f"comfyui_{int(time.time())}_{seed}.png"
        path = self.output_dir / name
        path.write_bytes(resp.content)
        return ImageResult(
            path=path,
            width=img.get("width", 0),
            height=img.get("height", 0),
            seed=seed,
        )

    async def is_reachable(self) -> bool:
        try:
            resp = await self._client.get(f"{self.base_url}/system_stats")
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def aclose(self) -> None:
        await self._client.aclose()
