"""复现脚本：governance 全文件 → caption 测试（定位残留源）。"""
import subprocess

r1 = subprocess.run(
    ["uv", "run", "pytest", "tests/test_pipeline_governance.py",
     "tests/test_telegram_bot.py::test_review_push_caption_contains_metadata", "-q"],
    capture_output=True, text=True,
)
print(r1.stdout[-600:])
print("STDERR tail:", r1.stderr[-200:])
