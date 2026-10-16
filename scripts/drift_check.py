"""结构漂移检查 CLI（E2，v0.37）。

对指定库报「模型 vs 迁移」的结构漂移——只报会在运行时炸 ORM 的类别
（add_table / remove_table / add_column / remove_column，口径见
backend/infrastructure/drift.py），modify_nullable / JSON→JSONB 等存量
反映噪音降级为计数，不淹没真信号。

用法：
    uv run python scripts/drift_check.py
        # 检查 settings.database_url（默认开发库）
    uv run python scripts/drift_check.py --db postgresql+asyncpg://hertz:hertz@localhost:5432/hertz_fresh
        # 检查指定库（全新迁移库应零结构漂移）
    HERTZ_DATABASE_URL=... uv run python scripts/drift_check.py
        # 环境变量优先于默认值

退出码：0 = 无结构漂移；1 = 有结构漂移。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.config import settings  # noqa: E402
from backend.infrastructure.drift import compare_database  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="模型 vs 迁移的结构漂移检查（只报运行时事故类）")
    parser.add_argument("--db", default=settings.database_url, help="要比对的库 URL（默认 settings.database_url）")
    args = parser.parse_args()

    report = asyncio.run(compare_database(args.db))

    if report.ok:
        print(f"[drift_check] 无结构漂移（库：{args.db}）")
    else:
        print(f"[drift_check] 发现 {len(report.structural)} 处结构漂移（库：{args.db}）：")
        for line in report.structural:
            print(f"  - {line}")

    if report.informational:
        noise = "，".join(f"{kind}×{n}" for kind, n in report.informational.most_common())
        print(f"[drift_check] 反映噪音（不影响运行，不进判定）：共 {sum(report.informational.values())} 条 —— {noise}")
    print(f"[drift_check] 原始 diffs 总计 {report.total} 条")
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
