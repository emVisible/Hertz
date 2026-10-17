#!/bin/bash
# 文档链接与 docs 路径引用检查——目录治理的回归护栏。
#
# 为什么需要它：2026-10-17 那次治理把 7 份文档搬了位置，同步引用点是手工做的。
# 手工就会漏，而漏掉的引用不会报错：Markdown 里的死链不阻止构建、不阻止测试、
# 不阻止提交，只在**读者点下去的那一刻**才失效。这正是本仓反复吃过的亏
# （"文档说支持、产物里却不成立"）。
#
# 查两类：
#   A) 活跃 Markdown 里的相对链接（](path) 形式）必须能在磁盘上找到
#   B) 代码/配置里提到的 docs/*.md 路径必须存在
#
# 刻意**不查**的两处，以及为什么：
#   - docs/archive/：归档文档里的路径按当时原样保留（不重写历史），必然有死链
#   - CHANGELOG.md：历史条目里的路径是记录，不是链接（文件头已写明这一约定）
#     scope A 只看 ](...) 形式，历史条目用的是行内代码，不会命中
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_DIRS=(node_modules .git data mdsea .venv __pycache__ build electron/backend-dist docs/archive)
FAILED=0

is_skipped() { # $1=路径
  local p="$1" d
  for d in "${SKIP_DIRS[@]}"; do
    [[ "$p" == "$d"/* ]] && return 0
  done
  return 1
}

# ── A) 活跃 Markdown 的相对链接 ────────────────────────────────────────────
# 取 ](...) 里的目标，排除 http(s)、mailto、纯锚点、以及含变量的模板。
while IFS= read -r f; do
  is_skipped "$f" && continue
  dir="$(dirname "$f")"
  # 一行可能有多个链接，用 grep -o 逐个取出；用进程替换而非管道——管道里的 while
  # 跑在子 shell，FAILED=1 传不回父 shell（踩过：它明明报了死链却仍然 exit 0，
  # 等于一个不会红的判据，比没有判据更坏）
  while IFS= read -r target; do
    case "$target" in
      http://*|https://*|mailto:*|/*) continue ;;
    esac
    # 去掉锚点与查询串
    clean="${target%%#*}"
    clean="${clean%%\?*}"
    [ -z "$clean" ] && continue
    if [ ! -e "$dir/$clean" ]; then
      echo "  死链: $f → $target"
      FAILED=1
    fi
  done < <(grep -oE '\]\([^)#][^)]*\)' "$f" 2>/dev/null | sed -E 's/^\]\((.*)\)$/\1/')
done < <(git ls-files '*.md')

# ── B) 代码/配置里的 docs 路径引用 ─────────────────────────────────────────
# 只查代码与配置：它们"提到某份文档"是在给后来者指路，指到不存在的文件就是错的。
while IFS= read -r f; do
  is_skipped "$f" && continue
  [ "$f" = "CHANGELOG.md" ] && continue   # 历史条目按当时原样保留
  case "$f" in
    *.py|*.ts|*.tsx|*.sh|*.mjs|*.cjs|*.spec|*.toml|*.ini|*.yml|*.yaml|.gitignore) ;;
    *) continue ;;
  esac
  while IFS= read -r target; do
    [ -e "$target" ] || { echo "  悬挂引用: $f → $target"; FAILED=1; }
  done < <(grep -ohE 'docs/[A-Za-z0-9_./-]+\.md' "$f" 2>/dev/null | sort -u)
done < <(git ls-files)

if [ "$FAILED" = "1" ]; then
  echo "✗ 文档链接检查失败（上面列的是死链或悬挂引用）"
  exit 1
fi
echo "✓ 文档链接检查通过（活跃文档的相对链接 + 代码/配置里的 docs 路径）"