"""Monoline 融合域：文稿转解说视频（移植自 monoline/，见 docs/archive/monoline-fusion.md）。

纯逻辑模块（segment/markdown/display_text/rotation/timings/sceneplan/viz/icons/
themes/subtitles/narration）与上游同语义；Hertz 适配点：
- 包内扁平布局（无 pipeline/ir/compose 子包）；
- themes 不经 settings 解析 tokens，随包发布；
- DB/HTTP/进程管理一律走 Hertz 基础设施（service.py 接线，Phase 1.3）。
"""
