<div align="center">

# Hertz

**AI-driven content creation & automation desktop platform — from inspiration to published video.**

[English](./README.md) · [简体中文](./README.zh-CN.md)

[![Release](https://github.com/emVisible/Hertz/actions/workflows/release.yml/badge.svg)](https://github.com/emVisible/Hertz/actions/workflows/release.yml)

</div>

---

## Overview

Hertz is a local-first content factory that runs the full lifecycle of short-form
video production: **collect → score → produce → review → publish**, with a human
review gate where it matters and full automation everywhere else.

It ships as an Electron desktop app (FastAPI backend + React frontend) with a
plugin-style AI base layer, a strategy-driven publishing engine for Bilibili,
and an installer that requires zero configuration on a fresh machine.

## Features

**Content pipeline**
- Multi-source collection: Reddit, AI-original stories (LLM-generated), generic RSS — routed per channel
- AI scoring with cost gates, duplicate detection (phash + title fingerprint), and safety redlines
- Production line: script → TTS narration → subtitles (ASS burn-in) → composition, with graceful degradation at every stage

**Columns (brand-level operations)**
- Bind source pools, pinned TTS voice, Bilibili category, description/tag templates, title style, persona prompt, and a dynamic title-card intro to one unit
- Items collected through a column automatically inherit its packaging; unbound items are untouched

**Review & publishing**
- Desktop review queue plus Telegram bot approval from your phone
- Publishing strategy engine: account warm-up curve, content tiers, daily quotas and slot spacing
- Publish queue with holding/ready phases, calendar scheduling, and stats back-fill

**AI base layer**
- Provider registry (OpenAI-compatible endpoints, SiliconFlow, Ollama…), role→model routing (`main` / `fast`), editable prompt template library, per-call usage tracking and monthly budget ladders

**Workspace**
- Studio multi-phase orchestration, inspiration canvas, download manager & asset library with tagging

**MD Studio (图文工坊)**
- Top-level layout & export workstation for agent-written Markdown: one pure-TS rendering core (`@hertz/mdcore`), three platform adapters
- WeChat: render-state style inlining (no `class`/`<style>`/CSS vars survive the editor), code-block whitespace hardening, external links converted to end-of-article references, one-click rich-text copy
- Xiaohongshu: measurement-based pagination (binary-split break points, table header repeat across pages, CJK line-break rules), 3:4 card export as PNG set / ZIP, auto cover page, brand footer with QR slot
- Zhihu: degradation renderer (tables → image, formulas → MathJax source, ordered lists → text numbering)
- 9 built-in themes (each platform has a true dark variant), one-click palette recolour derived from a single accent colour, per-draft overrides persisted in the `layouts` table
- Canvas-level editing: click a paragraph to edit its Markdown in place (written back by source line range — Markdown stays the single source of truth), drag a Xiaohongshu card's page boundary to force a break anywhere
- Batch export: pick several drafts, render each, and get one ZIP (`NN-title/page-01.png`) — a failed draft never cancels the batch

**Platform**
- Zero-config packaging: backend frozen via PyInstaller, embedded PostgreSQL auto-provisioned on first launch, auto-update channel via GitHub Releases
- Optional system dependencies only for advanced paths (ffmpeg falls back to a bundled build; `biliup` needed solely for Bilibili uploading)

## Architecture

```
Electron shell (auto-update, embedded PostgreSQL supervisor)
├── Frontend   React 19 · Vite · TanStack Query · Tailwind        :3000
│   └── @hertz/mdcore  pure-TS layout core (IR → theme → platform → export)
└── Backend    FastAPI · SQLAlchemy async · PostgreSQL            :8787
    ├── Pipeline      collectors → steps → producers → publishers
    │                 (multi-source router, columns, strategy engine)
    ├── Orchestration Studio phase engine / roles / prompt buffs
    ├── AI base       provider registry · TaskRouter (role routing)
    │                 · usage tracing (ai_calls) · keychain secrets
    └── Infra         logging · telemetry (/api/metrics) · backups
                       · health/deps checks · Alembic migrations
```

## Getting started

### Download

Grab the latest macOS (Apple Silicon) build from
[Releases](https://github.com/emVisible/Hertz/releases). First launch downloads
an embedded PostgreSQL (~32 MB, one-time) and runs migrations automatically.

> `ffmpeg` is optional — a bundled build covers thumbnails/production/burn-in.
> `biliup` is required only if you publish to Bilibili.

### Development

Prerequisites: Python 3.12+ · [uv](https://docs.astral.sh/uv/) · Node.js 22+ · pnpm · PostgreSQL

```bash
git clone https://github.com/emVisible/Hertz.git && cd Hertz
./scripts/dev.sh          # migrations → backend :8787 → frontend :3000 → Electron
```

Web-only mode: `./webui.sh`

### Quality gate

Every change must pass:

```bash
./scripts/verify.sh       # ruff → pytest → tsc → vitest → vite build
```

## Project structure

```
backend/
  ai/               provider registry, TaskRouter, prompts, usage costs
  pipeline/         collectors / steps / producers / publishers / strategy
  orchestration/    studio phase engine, crews, buffs
  infrastructure/   storage, logging, auth primitives, telemetry, backup
  routers/          thin HTTP layer over domain services
frontend/src/
  pages/            execution · dashboard · mdstudio · monoline · assets · plans · settings · cost
  components/       ui kit, execution views, app shell
  hooks/stores/     usePipelineExecution, zustand stores
packages/mdcore/    pure-TS layout core: parse → IR → theme → platform → export
electron/           main process, preload, builder config, embedded PG
docs/               user guide · roadmap · decision records · AI base design
scripts/            dev launcher, verify gate, backend freeze, migrations
tests/              pytest suite (shared test DB, rebuilt per session)
```

## Documentation

| Doc | Contents |
|---|---|
| [User Guide](./docs/USER_GUIDE.md) | install, environment variables, packaging |
| [Roadmap](./docs/ROADMAP.md) | shipped milestones & known gaps |
| [Decision Records](./docs/DECISIONS.md) | engineering decisions D-001 → |
| [AI Base](./docs/AI_BASE.md) | provider registry & role routing design |
| [Changelog](./CHANGELOG.md) | release notes |

## License

Released under the [MIT License](./LICENSE). Welcome to explore, learn from, and build upon it.
