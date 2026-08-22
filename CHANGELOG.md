# Changelog

本项目所有显著变更都将记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [v0.15.0] - 2026-08-22

质量与 ROI 三件套（同赛道产品调研落地，见调研报告：VideoLingo / Helicone / MoneyPrinterTurbo 精华借鉴）。

### 新增

- **三步翻译法**（VideoLingo 精华）：旁白文本 直译 → 反思审校 → 意译定稿——
  任一步失败降级上一步结果不阻塞产线；开关 `pipeline_translate_three_pass`（默认开）。
  字幕批量保持单步 + 术语注入（20 条/批 ×3 成本不可接受）
- **翻译术语表**（结构化表 + UI）：`glossary_terms` 表 + `/api/glossary` CRUD +
  设置 → AI「翻译术语表」管理区（启停开关/搜索/AI 辅助提取候选）；
  术语自动注入全部翻译 prompt（上限 100 条，updated_at 优先）
- **条目成本 ROI**（Helicone 单位经济借鉴）：成本页新增「条目成本 ROI」表——
  每条视频的 AI 总成本 × 播放量 × 千次播放成本（publish_stats 联动）；
  孤儿关联不计入 ROI 视图但计入总花费
- **标题 N 选 1**（MoneyPrinterTurbo 精华）：title_and_tags 单次调用产出 3 个差异化
  候选标题落库 `bili_title_alternatives`；发布卡标题行 ‹› 循环切换选用（点击即保存）

## [v0.14.1] - 2026-08-22

成本页体验四项：执行历史溯源跳转 / hover 操作 / 看板+历史两块布局 / 报表默认人民币。

### 新增

- **执行历史溯源**（`task_id = "item:<uuid>"` 约定）：评分/脚本/标题包装/旁白翻译/字幕翻译五个环节的调用点全部携带条目关联——明细行解析出条目标题与产物目录绝对路径，hover 操作「查看产物」一键跳转 资源 页对应目录；条目已删除自动降级为无关联
- **hover 操作**：历史行悬浮显示「查看产物」+ 复制模型名
- **报表币种**：默认 CNY（汇率可配），设置 → AI → 模型单价卡内选择币种与汇率；概览附日均花费；头部显示币种徽章

### 变更

- **成本页两块式布局**：上「看板」（概览卡行 + 环节分布 | 日趋势 + 按模型分布 双列）、下「执行历史」（表头吸顶内滚 + 分页）
- 测试桩适配：Item 桩补 id 属性（溯源关联需要）

## [v0.14.0] - 2026-08-22

成本控制——独立顶级菜单，透视每一个产生实际费用的 AI 环节。

### 新增

- **「成本控制」页**（`/cost`）：区间切换（7/30/90 天）+ 概览卡行（花费/调用/输入·输出 tokens）+
  **按环节分布**（评分/旁白脚本/标题包装/翻译/编排/对话——调用数、tokens、金额、占比条、点击筛选）+
  每日趋势迷你图 + **执行历史明细表**（时间/环节/模型/tokens/耗时/金额/状态）+ 未配价模型警告 +
  单价管理入口（跳设置 → AI）
- **计价与聚合层 `backend/ai/costs.py`**：`estimate_cost` 纯函数（美元/百万 tokens × 用量）+
  `aggregate_costs` 内存聚合；`GET /api/ai/costs?days=&domain=&limit=&offset=` 端点
- **费用环节归因补齐**：`TaskRouter.chat_messages` 开放 `caller` 参数——翻译两处标
  `operation="translate"`、编排域三处标 `caller="orchestrator"`；未知 operation 原样透传作环节 key（新工序免改代码）
- **执行历史服务端筛选与分页**：点击环节条目按 `domain` 参数重查（数据完整不截断），
  明细 50 条/页翻页；本地日切逻辑收敛至 `infrastructure/timeutils.local_day_str`（此前四处内联同构）

### 设计决策

- **查询时按当前单价动态计算（D-176）**：ai_model_prices 为唯一真相源，改单价追溯重算历史报表；
  ai_calls 只存 token 事实不入库价格快照。未配价模型的桶金额显示 None（未知 ≠ 免费），
  概览给出 coverage（计费覆盖率）
- 口径说明内嵌页面底部：仅统计 LLM API 调用；ASR/TTS 为本地或免费通道不计费

## [v0.13.0] - 2026-08-22

发布策略引擎——B 站「逆向算法」精细化运营（账号健康度 → 动态配额 → 内容分层 → 槽位规划）。

### 新增

- **账号健康度模型**（`pipeline/strategy.py` 纯函数）：从已回捞的公开播放数据实时推导四相位——`warmup`（新号爬坡，累计 <30 条低频起步逐级加量）/ `normal` / `caution`（本周均播较上周降幅 >50% → 配额减半）/ `cooldown`（连续 2 个发布日中位播放 <10，疑似限流 → 自动停发）。数据不足不惩罚；判定附人话证据
- **动态配额**：日产能 = 相位系数 × 爬坡曲线（cooldown=0 / caution 减半 / warmup 按累计数爬坡封顶 / normal=base_daily），替代静态 `daily_limit`
- **内容分层选条目**：premier（AI 分 ≥8 优先占黄金槽）/ regular / filler（lowscore 压仓）——转正不再按入库序先来先得
- **槽位约束**：同分区最小间隔 6h（防堆量痕迹）+ 相邻条目分区去重；复用既有窗口/间隔/抖动引擎
- **QueueView「账号状态」卡**：相位徽章 + 今日配额 used/quota + 判定原因 + 近 7 日发布/播放迷你趋势
- **设置页「发布策略引擎」区**：总开关（默认关闭——关闭时行为与 v0.12 完全一致）+ 常态日配额

### 设计约束

- 零新表：账号状态是 items + publish_json.stats 的派生数据，tick 实时推导（单一真相源不变）
- 全自动但可解释：每个降速/停发决策都带证据文案

## [v0.11.10] - 2026-08-22

绕过评分直接下载（省 API 用量）+ 审核卡未评分降级。

### 新增

- **预处理「直接下载」**：discovered 阶段 header 新增批量直下按钮（`POST /pipeline/run?step=download&unscored=1`，异步队列），未评分行新增单条「直下」按钮（`POST /items/{id}/download?skip_score=1`）——API 余额不足时跳过评分环节，审核以人工判断为主
- **引擎宽松路径**：`run_batch`/`process_one` 支持 `input_statuses` 覆盖（默认仍按 `step.input_statuses`，评分先行语义不变）
- **审核卡「未评分」徽章**：无评分条目显式标注中性 Badge（AI 分/评分维度/低分标记本就条件渲染，排序 `?? -1` 兜底）——评分为辅助信号而非必经环节

### 测试

- `tests/test_download_skip_score.py`：4 个契约测试（默认拒绝/skip_score 放行/批量只拉 discovered/unscored 对其他步骤无效果）；修复 `test_chain_to_review_gate` 对同事务 created_at 排序的时序脆弱依赖

## [v0.11.9] - 2026-08-21

取消制作 + 六项体验修复。

### 新增

- **取消制作（wave11）**：制作中按钮切换为「取消」——协作式取消（模块级标志注册表 + ContextVar 活动条目 + 产线检查点 + ffmpeg 轮询终止）；取消后条目回滚 downloaded（保留原片，清半成品），不标失败；幂等端点 `POST /items/{id}/produce-cancel`
- **随机抽帧封面入口扩展**：审核卡新增（与换封面并排）；发布卡按钮由 hover 浮现改为常驻可见
- **审核卡标题显示发布标题**：`bili_title` 优先，原版英文标题降级为 meta 行 `[EN]` 小字——审核所见即发布所得

### 修复

- **发布目标误报 NOOP**：runtime allowlist 缺 `pipeline_reddit_cookies_browser` 导致设置保存整体 400、`pipeline_publish_target` 从未落盘
- **已下载默认生产方式改为直发**：produce_options 为空时默认 passthrough（部分显式设置保持翻译+字幕兜底，不被直发劫持）
- **发布卡操作区拆分**：「打回审核」独立按钮，发布 select 菜单移除打回项
- **审核页 header 分组重排**：批量｜筛选（搜索+低分池）｜排序（要素+方向+视频优先+随机）

## [v0.11.8] - 2026-08-20

批量操作分片——消除全选超限 422。

### 修复

- **批量请求按 200 分片**：后端 `BatchBody.ids`/`ArchiveBody.ids` 上限 200（AXIOM 8.1 防大查询），全选可产生 500 条 → FastAPI 422 validation error。前端 `chunkIds` 按 200 切片串行执行并聚合 ok/failed（batchAction + archive/unarchive/purge 全覆盖）

### 变更

- **ActivityPanel 三栏改两栏**：移除「实时事件」页签（SSE 同源事件已落盘系统日志），默认展示最近任务；清理 store/hook 中 logs/logSeq/appendLog 死代码与 5 个死 i18n key

## [v0.11.7] - 2026-08-14

情感垂直频道第二阶段——文字故事产线（text_only 帖 → 中文故事旁白 → 配音 → 图文合成）。

### 新增

- **text_only 采集与存储**：Reddit 文字帖（selftext ≥ 50 字）保留为 `item_type=text_only` + `selftext` 列（alembic `wave24_story_selftext`）；短正文丢弃
- **下载跳过**：text_only 无媒体，download 步骤直接分配 output_dir 并跳过（不消耗网络）
- **故事旁白产线**：`produce_story_item`——LLM 中文故事脚本（钩子开场 → 情绪曲线 → 收束，`story=True` 专用 prompt）→ edge-tts 中文配音（`zh-CN-XiaoxiaoNeural`）→ 深紫渐变背景 + 标题卡渲染 → 按字符比例切句 → 字幕烧录合成 1280×720
- **合规适配**：敏感词 Tier1 拆分 `TIER1_SAFETY`（阻断）/`TIER1_MARKETING`（广告极限词）；故事旁白走 `safety_only=True`——中文口语高频词（最/第一）降级告警而非阻断，安全红线仍强制
- **故事源入池**：`AmItheAsshole / TrueOffMyChest / offmychest / relationship_advice / relationships / JustNoFamily / BestofRedditorUpdates` 加入采集池（runtime.yaml）
- **Reddit Cookie 导出增强**：设置页可选浏览器（Chrome/Safari/Edge/Firefox/自动）导出；导出后自动检测会话 cookie（`session_cookie`，杜绝「只有匿名 edgebucket 的假成功」）并立即验证通道（hot.json 200/403），状态卡显示「已登录/未登录」徽章

### 修复

- **produce_one 对 text_only 豁免 raw_path 校验**（无原始媒体条目此前无法进入制作）
- **`_render_story_bg` `out.save` → `img.save`**（Path 无 save 方法）
- **`_compose_story_video` 补 `async` 声明**（SyntaxError）
- **ASYNCIO 清理**：compose 产物校验改 `asyncio.to_thread`（ruff ASYNC240）

## [v0.11.6] - 2026-08-13

情感垂直频道改造（搬运阶段）——源池化 + 情感适配 + 验证门禁修复。

### 新增

- **采集源池勾选 UI**：设置→流水线 升级为分组勾选（情感池/情感故事池/旧源池 + 自定义源输入），`pipeline_sources` 仍为唯一真相源
- **情感评分适配**：`DIM_WEIGHTS.emotion` 0.9 → 1.3；score prompt 引导按「共情/治愈/冲突反转/真人真事」打分，低俗/引战降分
- **情感标题句式**：title prompt 支持共情钩子（冲突前置/反差/悬念），禁低俗擦边与性别对立标题
- **情感版块分区映射**：情感向 subreddit 显式映射 tid 21（日常），从搞笑 138 迁出（单一键）
- **版本单一真相源**：`backend.config.APP_VERSION`（0.11.6），main.py 引用；pyproject/package.json 对齐（此前三处 0.1.0 漂移）

## [v0.11.5] - 2026-08-13

发布流程按用户需求重构（立即发布/简介/转载/排期/封面）。

### 新增

- **立即发布**：`publish` 支持 `now=1` → 清除 `scheduled_at` 按当前时间上传（此前带排期会延迟）
- **随机抽帧封面**：`POST /items/{id}/cover-random` + 发布卡「随机封面」按钮（5%-95% 随机位置，updated_at 触发缩略图刷新）
- **排期高峰快捷点**：ScheduleField 升级 datetime-local + 「推荐」回填完整时刻 + 当天 10:00/12:00/18:00/20:00 即点即选
- **排期当天优先**：`next_slot` lookahead 1 天（只排当天），窗口按本地时区解释（修复排到凌晨/几天后的偏差）；B 站 dtime 下限修正为 5 分钟（原 4h 过严）

### 修复

- **简介不换中文**：`bili_desc` 改为原帖标题（用户明确需求），LLM/启发式兜底同步；手动值仍优先
- **转载变自制**：publish 传 `selfmade=1` 会把 `bili_copyright` 持久化为 1——重置受影响条目为转载，发布链路保持默认转载（--source 挂来源）
- **排期积压**：清理 285 条旧批量分配的远期排期（曾被排到 8/25）；`next_schedule_slot` 只统计未发布条目

## [v0.11.4] - 2026-08-13

字幕句首逗号根因修复（用户投诉「每句翻译字幕最前方有个标点」）。

### 修复

- **ASS Events Format 缺 Name 字段**：`srt_to_ass` 的 Format 行 9 字段但 Dialogue 行 10 值，
  ffmpeg 9.0.1 会把多余字段按逗号拼进文本 → 每句渲染出前导「，」——补上 Name 字段（经
  黑底渲染 + OCR 像素级验证：`，过来听指令` → `过来听我说`）
- **移除 `{\fad(...)}` 标签**：稳定优先（用户确认），字幕硬切
- **phash 改用 raw 源片计算**：成片 phash 被字幕带/缩放主导（不同视频仅差 4 位 → 误判
  「近源成片已发布」）——raw 才反映真实内容；全库 134 条存量 phash 重算
- 回归测试补 Format 断言；验证链（渲染 + Vision OCR）修复后重产 final.mp4 确认干净

## [v0.11.3] - 2026-08-13

处理中感知（长任务反馈）。

### 新增

- `busy` 状态（itemId → {action, title}）驱动按钮 loading + 防重复提交
- 全局反馈并入底部「运行状态」折叠条（ActivityPanel）：`正在处理 N 项 · 制作中《标题》`
- 后端 `process_one` 开始即发 SSE `job_step` + 日志

## [v0.11.2] - 2026-08-13

字幕/翻译标点清洗强化（LLM 前导标点）。

### 修复

- `_LOCALIZE_LEAD_PUNCT` 扩展（含 `…—`）；非中文翻译 `_clean_nonzh_translation_text`
- `_split_en_sentences` 句首剥离 + 8 词硬折行；`_write_srt_cues` 非中文句首标点剥除、纯标点丢弃
- 字体默认切换霞鹜文楷（OFL 免费商用）

## [v0.10.1] - 2026-08-13

批量运行异步队列化（修复"加入队列后立即完成"）。

### 修复

- **批量制作/采集同步阻塞**：`run_batch`/`run_chain` 曾 `await self._task`——HTTP 请求
  挂住直到全部条目处理完，前端"加入队列"后瞬间全部完成、看不到排队与进度——
  现 create_task 后台执行、请求立即返回 `{status: queued}`；进度经 SSE
  （job_step / item / job_done）实时推送，任务状态经 /pipeline/jobs 轮询
- **job summary delta 从未落库**：`run_batch` 在 finally 提交后算 delta 并更新
  `job.summary` 但缺第二次 commit——同步模式下前端拿响应体掩盖了缺口，
  异步化后 jobs 列表/详情读库即暴露；补最终 summary 持久化
- **SSE item/job_done 刷新列表**：后台任务每完成一条立即 invalidate
  pipeline-queue/counts（此前仅写日志，列表要等轮询周期才更新）

### 其他

- 前端入队即时反馈 toast（`jobQueued`，zh/en）；测试隔离 fixture（后台任务
  跨测试泄漏防护）与等待模式改造（`_wait_jobs_done` 等 running=false——job
  落库 COMPLETED 后任务仍有收尾步骤）

## [v0.10.0] - 2026-08-13

字幕/翻译数据源语义修正：基于视频原声（用户明确「视频中的人说的话」），旁白文案仅作回退。

### 修复

- **字幕/翻译基于简介派生文案（语义错误）**：此前字幕与翻译的文本源是 AI 按标题/简介生成的旁白文案，仅「翻译且不配音」组合走原声 ASR——现统一为视频原声为第一数据源：
  - 字幕生产方式 = 原声转写（保留原声语言与时间戳，不再去英文标点）
  - 翻译生产方式 = 原声转写 → 逐段翻译成目标语言（保留原声时间戳）
  - 配音 + 字幕组合同样优先原声字幕（此前被 `not want_voice` 排除）
  - 原声缺失（图片帖/静音）/ ASR 通道不可用/失败 → 回退旁白文案字幕（原行为保留）
- **中文原声视频绕翻译**：转写已含中文且目标为中文时跳过 LLM 翻译（原文即目标语言）
- **SRT 标点清洗误伤英文**：`_write_srt_cues` 无条件去标点曾把 `Hello, world!` 洗成 `Helloworld`——清洗仅对中文本体生效

### 其他

- 新增测试 3 例：translate=False 保留原声原文、中文原声跳过翻译、配音模式字幕仍走 ASR

## [v0.9.0] - 2026-08-13

CandleBone 对齐第三轮：成片混流 / 字幕烧录三级降级 / B 站定时门槛（详见 docs/DECISIONS.md）。

### 对齐

- **成片混流**（原项目 edit.py `_audio_mix_filters`）：`compose_video` 重写——侧链压缩改时间窗口音量曲线 `volume='if(between(t\,narr_start\,narr_end)\,0.22\,1.0)':eval=frame`（窗口 = 旁白实际时长，对齐 duck_floor=0.22）；旁白轨 volume=1.05 + apad/atrim 定长防 amix 塌缩；`amix duration=longest:dropout_transition=0:normalize=0`；统一 aformat(44100/fltp/stereo) + 原声缺失 anullsrc 静音轨；BGM 降音 0.08；合成后音频 < 视频 85% 带 BGM 自动重混一次（audio_guard）
- **字幕烧录三级降级**（原项目 `_subtitle_font`/`_render_cue_png`）：libass 可用 → ASS；缺失 → 逐 cue PNG overlay（PingFang/CJK 字体候选、白字 + 8 向黑描边、最多 4 行、底部留白、fade alpha in/out）；再失败 → 无字幕。烧录方式落 `script["compose_quality"]`，审计卡片提示
- **B 站定时门槛**（原项目 scheduler_utils.py `ensure_bilibili_dtime`）：距 now 不足 `pipeline_bili_dtime_min_hours`(默认 4h) + 5 分钟自动顺延，返回 `dtime_bumped_to` 并回写落库
- **pick_voice tags 修复**：旁白配音候选忽视 bili_tags（恒 None）——改为真实逗号分隔列表参与匹配

### 新增

- 测试 `tests/test_media_mix.py`（8 例：duck 窗口 / apad / normalize=0、音频守卫重混、muted -an、anullsrc、ass/overlay 分支、pick_voice tags、dtime 顺延与已满足）
- 依赖 Pillow（PNG overlay 渲染）

### 其他

- 存量工作树随本轮提交：routers 批量/重试 Body 重复定义清理、health/download/tests ruff 存量问题（F811/B007/ASYNC240/E742/F841/E501；per-file-ignores 仅限 prompt 与 XML fixture 文件）

## [v0.8.8] - 2026-08-12

AXIOM 查漏补缺（四十五：双维度审计遗留物；详见 docs/DECISIONS.md D-163）。

### 修复

- **活动面板分页错乱**：加载更多后轮询以当前页替换累计列表（§35 前端状态与渲染时序）——累计列表按 id 去重合并
- **系统日志重复追加**：until 游标进 queryKey 导致轮询反复追加历史行——加载更多改一次性请求，轮询只刷新初始页
- **i18next 不支持 ICU select**：collectRound 的 `{{err, select, ...}}` 渲染成残缺文本——拆 collectRoundOk/Err 条件渲染
- **job_detail 死接口**（§2.3 接口存在理由）：列表曾全量传 summary 但详情端点无人调用——列表轻量化（sources_ok/err 计数），展开懒加载 /jobs/{id}
- **pipelineApi.jobs 旧函数**（四十六 遗留物治理）：类型与后端新结构不一致——删除
- **日志 API 密钥脱敏**（§8.2）：message 读取时一次 scrub（token/cookie/secret=***）
- **日志全文件重复扫描**（§7.2）：mtime 缓存，文件不变跳过重读（0.07s → 0.000s）
- **日志游标校验**（§8.1）：since/until 非法格式 422；q 截断 120 字符
- **相对时间可读性**：刚发生显示"刚刚"而非孤立符号

## [v0.2.1] - 2026-08-08

原项目功能选择性同步（详见 docs/DECISIONS.md D-128）。

### 新增

- **画布多板**：板签栏（新建 / 切换 / 双击重命名 / 删除），每板独立卡片、图层与笔迹
- **图层面板**：新建 / 重命名 / 显隐 / 排序，新卡片落在激活层
- **图片卡片**：输入态或背景粘贴剪贴板图片即生成图片卡（dataURL 持久化）
- **画布导入导出**：⌘E 导出 `.revel.json`，拖入 / 文件选择导入（与 Revel 原项目格式互通）
- **画布平移**：Space + 拖拽有界平移（±260px，与卡片拖拽互斥）
- **失败分类看板**：failed 按 blocked/rate_limit/timeout/llm/tts/ffmpeg/等 10 类聚合，同类一键批量重试
- **phash 去重**：成片平均哈希指纹，发布闸门拦截同源重复投稿；存量条目批量回填脚本
- **评分成本闸门**：单次运行 / 单日 LLM 评分硬限额，超限跳过（条目保持待评分，不花 API）
- **本地排期引擎**：每日发布窗口 + 最小间隔 + 抖动，发布卡「推荐」按钮一键填充槽位
- **自动过审**：可选开启（默认关闭），超时未审条目自动 approve
- **数据源健康度**：dead / degraded / healthy 三态 + 采集失败冷却 / 熔断 + 供给告警（漏斗空 / 偏紧 / 源失联）
- **多平台导出包**：publish target 新增 `export`——成片 + 字幕 + 封面 + README 发布包，人工 / 半自动上传
- **采集韧性**：失败冷却 30 分钟、连续失败熔断 2 小时、成功清零；Reddit 排序随机轮换反 429

### 技术基础

- 迁移 wave15（error_class）/ wave16（source_state 连续失败/最后错误）
- 工序库重构（上版）：内置工序模型去锁定跟随全局、method 结构化、DEFAULT_AGENTS 并入 PHASES 单一真相源

## [v0.1.0] - 2026-08-06

首个可运行版本：AI 驱动的内容创作与自动化桌面平台。

### 新增

- **画布 Canvas**：灵感黑板，卡片 / 连线 / 语义低语提醒
- **编排 Studio**：多阶段 AI 工作流（内容研究 → 脚本 → 成片），阶段状态与产物实时可视化
  - 工序库：可编排的阶段模板（角色 / 模型 / 提示词 / 输出）
  - 策略 Brief：创作策略文档（Markdown 编辑 + 渲染预览）
  - 角色库与团队：AI 角色 → 模型分配（v4.1 简化：角色仅保留设定描述）
  - Buff / Debuff：正向与反向提示词注入（扩写 11 个内置 Buff + 5 个内置 Debuff）
- **流水线 Pipeline**：内容采集 → 评分 → 脚本 → 素材合成 → 发布（noop / Bilibili），调度器与重试
- **素材库**：
  - 下载管理（B 站 / YouTube，SSE 实时进度，断点续传）
  - 来源标签系统（下载自动打标签，按标签筛选）
  - 产物浏览（Studio / Pipeline 快捷入口，阶段产物融合展示）
  - 项目文档空间（素材根目录下 Markdown 文档的新建 / 编辑 / 删除）
- **AI 底座 v2.0**：
  - Provider 注册表（OpenAI 兼容协议，内置 DeepSeek / 硅基流动 / ComfyUI / Edge-TTS 模板）
  - 角色 → 模型路由（main / fast / embedding / image / tts），运行时可切换
  - 提示词模板库（编排 / 评分 / 图像 / 语音，支持自定义与回退）
  - 调用用量追踪（Trace 面板，流式响应计费）
  - API 密钥经 macOS 钥匙串加密存储
- **设置中心**：通用 / AI 服务 / 提示词 / 用量 / 流水线 分区管理
- 编排页语义分组导航（配置 / 角色 / 增益，行内激活贴纸）、素材根目录可配置、双语言（中 / 英）

### 技术基础

- FastAPI + SQLAlchemy（异步）+ PostgreSQL + Alembic 迁移（wave1 ~ wave10）
- React + Vite + TanStack Query + Tailwind CSS；Electron 桌面壳
- 路径安全（containment 校验）、密钥掩码、SSRF 防护等安全基线（见 axiom.md）

### 已知限制

- 桌面密钥存储目前仅支持 macOS 钥匙串（Windows / Linux 待支持）
- 发布目标仅 noop 与 Bilibili（其余待接入）

[Unreleased]: #
[v0.1.0]: https://github.com/emVisible/Hertz/releases/tag/v0.1.0
