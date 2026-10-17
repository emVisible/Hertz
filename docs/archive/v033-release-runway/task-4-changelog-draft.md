# CHANGELOG `[v0.33.0]` 段草稿（controller 起草，Task 4 落地时校对日期）

> 事实基线：自 `v0.30.1` 起共 **32 个提交**（`git rev-list --count v0.30.1..HEAD`，2026-09-28 量）。
> 计划原文写的「27 个提交」是写计划时的数，之后又落了 5 条（门禁代修 + 代理收口两条 + 文档两条）——**以 32 为准**。
> 下面六段，每段一句到位；不许出现未做的事。

## 建议正文（Markdown，直接进 CHANGELOG.md）

```markdown
## [v0.33.0] - 2026-09-28

自 v0.30.1 起 32 个提交，本版一次收口。六组变化：

### 本地引擎入包（v0.31 B1/B3）
faster-whisper 与 ctranslate2 升为主依赖、本地引擎进固化包（含 PyInstaller 冻结入口
`freeze_support` 修复），转写与翻译不再依赖用户机器上有没有装对东西。

### 质量片 S1–S6（v0.32）
alembic autogenerate 删表闸（不可逆操作先亮牌）+ 其 PyInstaller 回归修复；工坊转写改走
单一权威出口并做繁简纠偏；无效索引声明清偿；产物级发布门禁 `release-check.sh`（源码门禁
→ 重建固化包 → 产物门禁，任一非零即禁止打 tag）；仓库内 pytest 告警 8→6（余下均在依赖
生成代码里）；文档真相与门禁卫生四项。

### 设置页保存回归（v0.32 S4.1，影响面最大的一条）
**自 v0.20 起设置页点「保存」提交的是空 `overrides`**——所有改动只活在内存里，页面却
toast「已保存」。改为草稿态 diff + 按类型强制转换，并补门禁防复发。

### 本地模型落位（v0.32 S4 / S4c）
Whisper 与翻译模型搬进应用数据目录（`HERTZ_DATA_DIR/models/whisper`）+ 一键下载；
`HF_HOME` 不再参与，隔离数据目录即等价空缓存。状态卡五态化，把「还没问到」和
「依赖没装」分开显示（此前二者共用一个红色结论）。

### 空壳条目治理（v0.33）
起因是「下载一直 403」。实测根因不是 CDN，而是采集器兜底「不确定就算 video_raw」把
2011 条 `media_url == source_url`（把帖子页当媒体）的空壳放进了可操作队列，其中 1989 条
连正文都没有；点下载就是抓被反爬拦截的页面，403 还会把整域冻进冷却、连带 2089 条真视频
停摆。交付：`pipeline/quality.py` 作判据唯一作者 + 新增布尔 `is_invalid`（wave30）+
`counts()` 与列表共用 `operational_filters()` + 异常区「空壳」池 + `engine._pending` 不再
白跑 + 常驻数据体检 `integrity`（六条不变量，只报不改）+ 存量回填脚本（干跑默认）。
dev 库实测 discovered 4703→2666、failed 181→27、queued 5→0，rejected 371 / published 18
一条未动。

### 网络与门禁收口
「本地目标直连、外部目标跟随代理」这件事原先被写了 8 遍（4 处手写关掉环境代理、
3 处各自发现系统代理、1 处新增权威），全部收进 `infrastructure/net.py`；配套仓库级守卫
从「只禁旧形状」改成**正向棘轮**——删掉收口即红，且有成对变异证据。并代修并发工作流
欠下的门禁红（2×F401 + 2×N812 + 一个因打桩位缺失而 AttributeError 的测试），零业务逻辑改动。

### 已知遗留（如实）
1. **141MB Whisper 模型的全量冷启动首下未实测**：本机代理 egress 多次整体中断，只拿到
   30MB/141MB 进度与完整失败路径证据。判据已沉淀为 `scripts/sim-newmachine.sh --with-download`
   （断言模型落进应用目录且 `~/.cache/huggingface` 一个字节不长）。
2. **Reddit 签名直链兜底仍未闭合**：`pipeline_reddit_client_id/secret` 为空时
   `ensure_reddit_token()` 直接返回 None，v0.3.7 的兜底从未启用。本版只做到「这件事可见」
   （能力矩阵 `reddit_auth` 条目 + `GET /api/pipeline/reddit-auth/status`，probe 需显式
   `?probe=true`）；闭合需要用户去 `reddit.com/prefs/apps` 建 script 应用后填凭证。
3. **情感文字供给链断裂已量化未修复**：`items.selftext` 在 dev 库 5281 行里 0 行非空，
   隔离的 2196 条中 2013 条落在情感名单、1982 条来自文字为主子版。修复面在 v0.34。
```

## Task 4 落地时的三条校对

1. `docs/ROADMAP.md` 的「在飞」段现在已含三条新事实（门禁水位刷新到 ruff 0 / pytest 504、
   情感供给链断裂、A/C/B 定档）——改「已交付 v0.33」时**别把这三条删掉**，它们是 v0.34 的入口。
2. 版本号五处的 perl 锚点在本轮已核过一次，五处全是 `0.30.1` 且正则逐字命中：
   `backend/config.py:20`、`package.json:4`、`frontend/package.json:4`、`electron/package.json:4`、
   `pyproject.toml:3`。
3. 若 Step 5 产物门禁因磁盘余量失败（本机 7–12 GiB），**停手报告**，不清用户文件腾地方。
