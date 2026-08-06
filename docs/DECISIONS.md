# Hertz 决策记录

本文件按时间顺序记录重构过程中的关键决策、取舍与原因（对应 HERTZ_RECONSTRUCTION.md 各波次的「实现取舍」）。

## Wave 0-1：骨架与基础设施

- **D-001 全新重构而非渐进迁移**：旧代码（CandleBone 时代）与 Hertz 需求差异过大，采用新工作树重建；旧代码 staged 删除保留在 git 历史中。
- **D-002 后端异步全栈（FastAPI + SQLAlchemy async + Alembic）**：下载/转码/LLM 均为 IO 密集，async 单进程足够；避免 celery/redis 复杂度。
- **D-003 零运行时第三方 UI 依赖**（AXIOM §6.1）：图标、Markdown 渲染、Toaster、Modal 全部自建；只依赖框架级 React/状态/请求库。
- **D-004 设计令牌单一来源**：Tailwind v4 `@theme inline` 映射 CSS 变量（`--hz-*`），暗色主题只改变量。

## Wave 2：下载引擎

- **D-005 下载工具直驱而非 daemon 服务**：任务由后端进程内后台循环调度（asyncio + 单飞守卫），不引入独立 worker 进程。
- **D-006 yt-dlp 以模块方式驱动**：`python -m yt_dlp` 而非二进制；保证与后端依赖版本一致，跨平台可控。
- **D-007 数据目录可配置**（`HERTZ_DATA_DIR`）：下载/缩略图/运行时状态统一落盘，便于备份与迁移。

## Wave 3：编排域

- **D-008 编排域不引入新的 agent 框架**：直接在 orchestration/ 下实现 phase 定义、运行器、事件流（SSE）；复用 AI 接口层。
- **D-009 事件总线用 SSE 而非 WebSocket**：单向日志流足够，服务端实现简单，前端 EventSource 零依赖。

## Wave 4：执行域

- **D-010 StepEngine 独立实现，不继承 PipelineEngine**：编排域无 pipeline 基类；Pipe 抽象 + 注册表与 orchestration/phases.py 对齐，保持两域解耦。
- **D-011 Reddit 采集单策略**：公开 JSON 列表 API + cursor 增量，砍掉 OAuth/RSS 多策略——非目标范围最小实现。
- **D-012 审核闸门前置**：pipeline 链停在「待审核」，approve 才发布；重复检测仅 (source, source_id)，不做 phash——控制范围。
- **D-013 发布目标可配置且默认干跑**（`HERTZ_PIPELINE_PUBLISH_TARGET=noop`）：无凭据也能全链路演练。
- **D-014 健康检查分层分级**：ok/warning/error 三态，warning 不降级整体状态（磁盘不足 5GB 仍可用但提示）。

## Wave 5：Canvas + 对话

- **D-015 相似度算法简化自 Revel**：无中文分词器，用 char bigram/trigram cosine + 词重叠加权；相同文本短路，仅数字分叉触发前缀惩罚——避免「第1章/第10章」误判。
- **D-016 聚类用朴素 O(n²) 阈值图 + 连通分量**：画布卡片量级（<100）下足够，换取零依赖。
- **D-017 对话砍掉 Milvus/Redis**（对比 Ametrine 参考）：只做 DB 持久化 + 最近 20 条窗口重组 prompt；向量检索列为非目标。
- **D-018 画布卡片为 DOM、连线/笔迹/背景走 canvas 2D**：卡片可编辑/双击/无障碍，视觉层才用渲染器；浮漂只作用于连线端点保持卡片可点。
- **D-019 前端 SSE 用 fetch + ReadableStream 而非 EventSource**：POST 长连接 + AbortController 中断；Console 的 GET 流保留 EventSource。

## Wave 6：打磨与交付

- **D-020 打包版由 Electron 主进程拉起后端**：生产模式 spawn `python3 -m uvicorn`（cwd=Resources/backend）并轮询健康检查；失败弹窗优雅降级，可用 `HERTZ_BACKEND_URL` 完全绕过。
- **D-021 后端以源码形式进包（extraResources）而非 PyInstaller**：首版交付依赖系统 Python + 依赖；PyInstaller 固化为已知缺口（见 ROADMAP）。
- **D-022 自动更新走 electron-updater 通用源**（`HERTZ_UPDATE_URL`）：未配置更新源时静默跳过，避免开发机/离线环境的噪音。
- **D-023 vite 产物相对路径（base: './'）**：file:// 协议下资源加载正确，与 dev server 共存。
- **D-024 全局异常处理器只兜底不吞错**：HertzError → 400 + code，校验错误 → 422 + errors，未处理异常 → 500 且记录日志；前端 ErrorBoundary 兜 UI 崩溃并给恢复入口。

## Wave 6.5：Axiom 审计

- **D-025 SSRF 防御分层**：URL 分类做静态检查（域名白名单 + IP 字面量/localhost/.local/.internal 拒绝，离线可用），DNS 解析实检只发生在真正抓取/下载层（`is_safe_media_url`）；`pipeline_allow_loopback_urls` 仅作测试逃生阀。
- **D-026 secret_key 默认清空、auth 原语快速失败**：桌面单用户默认无鉴权（D-027），但密钥缺失时 `_require_secret` 直接抛错，杜绝「看似加密实则明文」的假安全。
- **D-027 全 API 无鉴权为有意为之**：auth.py 的 JWT 原语零调用是已知接受项——桌面单用户场景，鉴权只增加摩擦；部署为共享服务时必须先接回（见 ROADMAP）。
- **D-028 前端消息列表单一数据源**：react-query 只负责会话切换时装载历史，渲染源为本地 state——消除 streaming 中切会话读到残留消息的双源竞态。
- **D-029 SSE 断线自动重连（指数退避，最长 15s）**：后端重启/休眠唤醒后事件流自行恢复，不丢任务状态。
- **D-030 board persist 节流 500ms + 页面隐藏强制落盘**：笔迹/拖拽每帧 setState 不直接写 localStorage，`beforeunload`/`visibilitychange` 兜底。
- **D-031 轮询是 SSE 的兜底而非主源**：Console 页空闲 15s / 运行中 2s 轮询；事件驱动的 invalidate 才是刷新主力，轮询只防漏。
- **D-032 pipeline 错误类型化**（`PipelineError`/`ItemNotFoundError`/`InvalidItemStateError`）：approve/reject/retry 不再笼统 409——资源缺失 404、状态不允许 409，前端据此渲染按钮语义。
- **D-033 文档白名单 + symlink-safe containment**：`/api/docs` 只索引 docs/*.md 与顶层两份设计文档；`/api/docs/content` 按名称查表并校验 `resolve()` 结果，遍历请求 404。
- **D-034 依赖即债务，动画用平台原语**：Modal 入场动画从 gsap 换成 Web Animations API（200ms fade/scale），前端依赖再少一个（AXIOM §6.1）。
- **D-035 最外层永无滚动条**：main 容器 `overflow-hidden`，溢出内容一律在各卡片/面板内部滚动——双滚动条消失，滚动行为可预期（AXIOM §7.2 交互预算）。
- **D-036 secret 只写不回**：`deepseek_api_key` 允许经 PATCH 写入本地 runtime.yaml（单用户桌面），GET 永远只返回 masked 值——「能配置、不能读出」。
- **D-037 语言切换前端持久化**（`hertz-lang` localStorage），后端不存 UI 偏好（AXIOM §2 前后端职责分离）。
- **D-038 库浏览统一 stdlib Path**：`_ensure_allowed` 的 anyio APath 只用于异步 resolve，出围栏后转回 `Path` 供同步扫描——async 边界清晰，避免 async_generator 混入同步栈。
- **D-039 Canvas 图形即笔迹**（Revel heritage）：rect/ellipse/line 生成折线点列复用粉笔渲染与逐笔擦除管线——工具不新增渲染路径，一套几何一套擦除。
- **D-040 笔迹确定性 + 离屏缓存**：抖动用种子 LCG（同笔迹每帧一致，杜绝闪烁），已提交笔迹画进离屏 canvas 仅变化时重建——动画帧只 drawImage（AXIOM §7.2）。
- **D-041 智能封面选帧用 ffmpeg signalstats 而非图像库**：抽 4 时间点 + YAVG 评分选居中亮度帧，零新依赖（AXIOM §6.1）。
- **D-042 混音主链 = 原声 + 旁白 ducking + 可选 BGM**：sidechaincompress（threshold 0.04/ratio 6）压原声、旁白静默恢复；BGM 固定 0.10 铺底（Autarkeia edit.py 简化移植）。
- **D-043 合规门禁前置**：敏感词 Tier1 阻断在 produce 入口执行（ProducerError），不进审核队列——宁可误杀不可漏放（AXIOM §22.1）。
- **D-044 剪贴板监听只读不抢**：主进程 1.5s 轮询 + 通知点击才回填，不自动导航不吞剪贴板——桌面助手的克制交互。
- **D-045 下载与资源库合一（Assets Hub）**：任务 = 进行中的素材，完成就地蜕变；单一网格组件渲染任务与文件（状态覆盖层），无第二套心智模型；侧栏减一项。
- **D-046 全站直角 UI（无圆角）**：去 83 处 rounded 类与 CSS radius；胶囊改直角选中边；动效 100ms 直线淡入无 overshoot——锋利、powerful、快（AXIOM §7.2 交互预算）。
- **D-047 删除是资源库一等操作**：`DELETE /api/library/file` 走既有 `_ensure_allowed` 围栏 + 连带缩略图清理；前端右键菜单触发，confirm 由用户行为（右键→删除）隐含。
- **D-048 无边框窗口 + 侧栏拖拽区**：`frame: false` 去系统标题栏，侧栏顶部 40px `-webkit-app-region: drag`（内部按钮 no-drag）——窗口可拖、自绘控制钮不重复（方案 B，用户确认）。
- **D-049 侧栏功能分组**：创作/生产/素材/系统四组 + 分隔线，替代平铺堆叠——导航即心智地图（AXIOM §7.2 信息架构）。
- **D-050 Assets 为唯一出口**：下载/资源/文档三者合一（左侧双 Tab：素材/文档），侧栏 8 项——系统的所有"内容入口"收拢到一个视图。
- **D-051 主题色定琥珀金**：创作工具经典强调色（达芬奇/LR 同系），非蓝防审美疲劳；primary 按钮深色文字保证对比。
- **D-052 全局窗口条 = 拖拽区**：无边框窗口内容区顶部 40px header（标题/可拖/主题切换）与侧栏红绿灯同高——窗口条即 header，红绿灯与内容首行齐平（D-048 的完整化）。
- **D-053 页面过渡用 WAAPI 而非 Remotion**：Remotion 是视频渲染库，运行时 UI 过渡用 220ms 位移淡入 + 主色擦拭线（260ms），零依赖（AXIOM §6.1）。
- **D-054 Studio 单一执行入口**：计划选择移出 UI（固定首个启用 plan，小字提示），主题输入 + 开始执行居中——操作聚焦，选项隐藏。
- **D-055 单色中性主题（企业级克制）**：primary 定为「浅色强调」——暗色冰白 #e4e4e7、亮色深灰 #27272a；`--hz-on-primary` 保证按钮文字双主题对比；非蓝非橙，无审美疲劳。
- **D-056 过渡 transform 只作用于装饰层**：内容动画仅 opacity（位移叠加内容重排是抖动根源），擦拭线独立 `translateX` 滑动——装饰不与内容共享 transform 链。
- **D-057 四家 LLM 一个实现**：deepseek/openai/ollama/xinference 同属 OpenAI 兼容协议 → 单 provider + provider 默认值表；模型只能从预设列表选（Select 防误配），base_url 联动默认（AXIOM §1.2 单实现）。
- **D-058 预览分层**：图像区点击 = 直达媒体（图片放大/视频音频直接播），名称点击 = 详情管理——高频预览一步到位，低频管理独立入口。
- **D-059 编排一入口管三资产**：计划/简报/班底同左侧栏 + 新建分支菜单；班底补齐 CRUD（此前只有引用无管理）。
- **D-060 DASH 音轨自动合并**：`muxed` 标记 + 单次 describe 协商——纯视频流（无音轨）自动并最佳音轨，muxed 格式不重复合并；无声问题根除。
- **D-061 下载条内联于素材视图**：不弹窗；打开即聚焦、回车解析、结果内联含封面，开始后自动收起任务出现在进行中区——获取动作融入持有视图（D-045 深化）。
- **D-062 画质档位而非格式列表**：`quality_options` 按分辨率去重（带音轨优先→高码率优先），下载自动合并音轨——「一个分辨率一个选项」，与 HeartStone 画质下拉一致。
- **D-063 下载即见记录**：开始下载自动切到「任务」视图（含封面/标题/进度/操作）——动作与反馈同一时刻呈现。
- **D-064 文件名=标题 + 封面 sidecar**：title_hint 驱动文件名（不再 Bilibili/YouTube）；下载后封面抓取为 `<name>.thumb.jpg` 就近存放——任务列表/素材网格/预览三处可见同一封面。
- **D-065 画布×对话双叠加**：静态（画布卡片/连线/聚类 → 每轮 context 注入，不落库）+ 动态（LLM 回复 → 一键物化为卡片）；会话绑定画板（conversationId 随板持久化）。
- **D-066 输出目录锚定 data_dir**：`FileStore.output_root()` 相对路径锚定 data_dir（cwd 无关）；run 输出目录历史查询不再受启动目录/配置变更影响；历史目录缺失降级为空列表。
- **D-067 素材 = data_dir 根 + Tag sidecar**：素材空间即指定数据目录（下载直达）；`<name>.meta.json` 记 tags/来源/时间（随文件走、零 DB 同步）；下载自动打 download+来源 tag——tag 系统取代路径解析。
- **D-068 运行时文件不出现在素材**：runtime.yaml/.DS_Store/隐藏文件/临时文件在 scan 层过滤——素材空间与运行时状态分离。
- **D-069 砍对话（伪需求判定）**：内置对话与免费 DeepSeek 网页版无差异化优势（UX/生态/上下文全劣）；LLM 价值已通过流水线环节（评分/脚本/编排）兑现，无需独立窗口。数据保留、代码全删（奥卡姆剃刀）。
- **D-070 画布 = 流水线输入端**：画布唯一不可替代价值是空间化思考结构；「在 Studio 中创作」把卡片组装为主题直接驱动流水线——画布从创意笔记本变成引擎燃料。
- **D-071 画布轻量化（奥卡姆）**：点击即创建（落点即位置+自动编辑）、背景随主题、删图层（Photoshop 概念不适用于灵感画布）、删导入导出（自动持久化即历史）、删标题（画布最大化）——保留空间化思考这个唯一核心价值。
- **D-072 执行工作台（Wave 7.0）**：Studio/Console 70% 同构 → 共享组件层（CommandDeck/Terminal/StatusTimeline/HistoryList/SectionCard/ProgressStrip）+ 域适配 hook；不做超接口抽象（审核操作 vs 产物文件语义差异大）。
- **D-073 域专属视图不泛化**：审核队列表格与产物文件预览保持域内实现——列配置/操作语义泛化是过度设计（奥卡姆）。
- **D-074 执行状态 store 化**：Studio/Pipeline 运行状态（日志/工序/参数）放 zustand store——页面级导航不丢进度，事件处理统一 getState() 读最新（防闭包覆盖）。
- **D-075 采集走系统代理**：httpx 只认环境变量不读 macOS 系统代理——urllib.getproxies 桥接；collect 网络错误优雅降级（步骤 failed + 提示，流水线继续）。
- **D-076 工序库可维护（DB 化）**：内置工序懒种子（builtin 只读）+ 自定义 agent 工序 CRUD；引擎索引动态化（service 注入 + 内置回退）——工序从代码常量变用户资产。
- **D-077 Studio 默认不依赖平台**：content_pipeline（采集桥接）默认禁用——编排是纯创作空间，平台连接显式启用。
- **D-078 结构性词库内置 + 可维护**：连接词/介词/助词/形容词/宾语意象并入 remix 词池；data/wordbank.json 用户覆盖合并——只填名词动词也能串成句子。
- **D-079 测试库真正隔离**：conftest 的 DATABASE_URL 与项目 env 前缀（HERTZ_）不匹配导致测试污染主库——前缀修正 + 一次性清理；产物"读不到"的主因是测试假 run。
- **D-080 产物与阶段状态同卡片**：横向步骤条 + 产物 chips 融合于 StatusSteps 底部——阶段进展与产出物一个视图看完。
- **D-081 AI 底座 v2.0（Wave 8）**：应用层接口零改动，底座从「单 Provider 单模型」升级为「Provider 注册表 + 角色化模型分工」——对齐 Cherry Studio 的模型服务/默认模型概念；知识库（RAG）明确后置（先不做），embedding 角色位预留。
- **D-082 密钥进钥匙串（AXIOM §8.2 落实）**：macOS Keychain 托管主密钥，DB 只存 Fernet 密文；无钥匙串环境降级 data/secrets chmod 600；首次启动自动从 env 导入旧明文配置（一次性迁移，之后以 DB 为准）。
- **D-083 OpenAI 兼容协议单一实现**：DeepSeek/Ollama/硅基流动/OpenAI/自定义全走 `/v1/chat/completions`——一个 provider 实现覆盖 90% 场景；Anthropic/Gemini 协议字段预留（protocol 列）但本期不做。
- **D-084 角色化模型分工（Cherry"默认模型"）**：main（创作）/fast（评分标题）/embedding（预留）三角色；任务按角色取模型，未配置回退 main → 首个可用 chat；工序/班底的 model 字段 v2.4 接入真正生效。
- **D-085 提示词模板库（v2.4）**：出厂默认硬编码 + 首访种 DB；customized 标记防升级覆盖；engine 运行开始时取一次快照传给构建函数——提示词从代码常量变可编辑资产。
- **D-086 多 Key 轮询 + 调用链**：Provider 多 key 逗号分隔轮询（坏 key 剔除）；每次调用写 ai_calls（task_id 关联编排 run）——成本可追、故障可查。
- **D-087 提示词模板库只覆盖 agent/brief/synthesis 三类**：score/script/title 提示词暂不模板化（内部任务，调参面小）——控制模板库初始概念面。
- **D-088 AI 底座 v3.0 解耦（图像/TTS 入注册表）**：ComfyUI/Edge TTS 从 settings 直配迁入 Provider 注册表（protocol=comfyui/edge_tts 自动种子）；TaskRouter 按角色解析连接器，registry.initialize 不再构造注入——应用层只依赖 TaskRouter 稳定接口（AXIOM §2.2 落地）。
- **D-089 设置页子菜单化**：左栏导航（通用/AI 服务/提示词/使用记录/流水线）替代单页滚动；「AI 服务」（Provider 管理）与「默认模型」（角色分配）合并一页——服务层与使用层同页上下结构，图像/TTS 配置统一在模型服务里编辑。
- **D-090 「AI 调用链」→「AI 使用记录」可读化**：caller/operation 机器码映射为人类语言（编排·内容创作/流水线·评分…）+ 时间戳展示——从开发术语变成用户可理解的使用记录。
- **D-091 image/tts 角色无 chat 回退**：图像/TTS 找不到对应能力模型时直接报错而非回退 chat（快速失败，AXIOM §4.2）；仅 fast/embedding 保留 main→chat 回退链。
- **D-092 班底 → 团队 + 角色库（v4.0）**：角色（roles 表）独立成库（可复用配置实体）；团队（crews 表，语义=团队）只存角色 key 的有序列表；计划关联团队；引擎从角色库展开配置（wave9 迁移自动转换旧内联 agents）。编排 tab 调整为 工序库/策略/角色库/团队。
- **D-093 团队/角色编辑器 MD 双栏**：与策略一致——左侧 Markdown 源码 + 右侧渲染预览（复用 md-body 单一渲染器）；团队成员卡片列表可滚动、带间距（修复原无法下滚问题）。
- **D-094 角色简化（v4.1）**：角色从「可复用 agent 配置」收敛为「纯 MD 内容实体」——只剩 key/name/role_name/description；method/style/model/timeout/retries 删除（wave9b 迁移并入 description）。执行配置归工序库与编排层（引擎回退链本就覆盖）；风格由上层应用层设置；模型在调用/编排时指定。
- **D-095 团队成员卡片文档化**：成员卡片展示角色 MD 说明摘要，可展开完整渲染预览（与策略/角色库同一 md-body 渲染器）；新增「一键添加全部角色」快速组队。
- **D-096 阶段详情弹窗（运行时可观测）**：步骤条节点可点击查看该阶段 状态/耗时/错误/产物文件；运行详情接口 2s 轮询刷新——长阶段等待不再是无反馈黑盒。
- **D-097 硅基流动推理模型提速**：DeepSeek-V3.2 思考链默认关闭（enable_thinking=false 仅对 siliconflow 发，避免 OpenAI 官方 400）；策略分析阶段（build_brief）改走 fast 角色（Qwen 快模型）——实测首个阶段 40s → 11s；system phase 输出「开始…」进度日志。
- **D-098 不内置模型名（v4.3）**：OpenAI 兼容类 Provider 模板删除出厂模型——创建后点「拉取模型列表」从远程 /v1/models 获取真实模型（硬编码模型名会随平台下架/改名产生幻觉）；仅系统连接器（comfyui/edge_tts，无 /models 端点）保留内置模型。
- **D-099 阶段产物文件融合**：每个阶段节点下方显示该阶段产物文件标识（output_file 声明优先，无则 {key}.md 惯例）；package 阶段 final.md 高亮（弱化样式，不张扬）；点击直接打开预览——产物不再与阶段分离。
- **D-100 产物文件深度融合（v4.4）**：删除底部「常用文件」栏——每阶段节点下方直接显示该阶段**真实产物文件**（后端 get_run 读 run 目录按阶段归属：{key}.md / output_file / images/ → visual_director / package 汇总 final.md；user-input.md 输入不归属）；点文件打开**渲染后 MD 预览**（react-markdown + md-body），非 MD 原样展示；「在资源中查看」保留为步骤条底部单按钮。
- **D-101 团队愈合兼容字符串 agents**：v4.0 后 crews.agents 为角色 key 字符串列表，启动愈合函数改为兼容 str/dict 两种格式（修复启动 AttributeError）。
- **D-102 Buff 体系（v5.0）**：游戏化态度/话术注入——ai_buffs 表两级（lightweight 纯文本 / heavy 类 skill 复杂指令），stable/random 双池；plan.buff_keys 计划级持久 + Studio 运行时多选覆盖（RunBody.buff_keys）；engine 把生效 buff 拼进每个 agent 的 system prompt【附加要求】块；`random` 特殊 key 每次从随机池抽 2 个（肉鸽可变性）。
- **D-103 同事调度暂缓**：跨角色评审 token 成本 +10~20% 且效果不确定（LLM 自审常无信息增益）；留待 heavy buff 的「二次把关」形态后续扩展，本期不做独立机制。
- **D-104 Buff 扩写（v5.1）**：全部内置 buff 按提示词工程重写——从"一两句抽象形容词"扩为"做什么+怎么做到+避免什么"的可执行指令（含具体例子、自检清单）；新增 6 个功能性 buff：hook 开头抓人 / analogy 类比大师 / counterpoint 先破后立 / citation 有据可依（稳定池 heavy）+ rand_short 短句冲击 / rand_question 提问式推进（随机池）。内置 buff 以代码为单一真相源（_seed 同步更新 builtin 行，扩写升级立即生效；用户自定义不受影响）。
- **D-105 Debuff（v5.2）**：反向提示词（"不要做什么"）与 buff 同表同维护——ai_buffs 加 polarity（buff/debuff）；内置 5 个（拒绝标题党/禁用 AI 套话/禁止注水/禁止吹捧/禁止端着）；engine 注入时 debuff 单独进【禁忌】段（与【附加要求】分离），前端红色高亮区分；Studio/Plan 均支持 debuff 多选。
- **D-106 编排左侧 4 行布局**：编排独占一行，下方 2×2 网格（工序/策略 · 角色库/团队 · Buff/Debuff）——6 个 tab 不再挤一行。
- **D-107 平台字段冗余化（v5.3）**：策略（Brief）的 MD 正文已承载平台语境（调性/受众/话术），独立 platform_id 字段冗余——前端策略编辑器删除平台下拉、engine 不再注入【平台】标签（platform_id 恒空，走提示词默认）；DB 列与 API 保留（向后兼容，未来"发布目标"可能需要）；删除死代码 BriefsPage 与 constants/platforms.ts。
- **D-108 界面优化批（v5.4）**：提示词模板库列表加内容摘要+整行可编辑+弹窗源码/渲染双栏；默认模型卡片生效标签 truncate 防超长；Studio/Plan 的 debuff 去除红色改用中性色（与 buff 对齐）、"（禁忌）"字样移除；素材左侧去掉"全部"入口——产物区拆为 Studio / Pipeline 两个快捷入口（按自动化流程分）。
- **D-109 编排左侧导航重构（v5.5）**：「编排」由可点击按钮改为页面身份标题（当前页即编排）；5 个子 tab 按语义分三组——配置（工序库/策略）、角色（角色库/团队）、增益（Buff/Debuff），组间加小号分组标题；选中态与素材页 tag 统一为「左侧 2px 主色条 + surface-2 背景 + 主色文字」。
- **D-110 分组标题改行内贴纸 + 产物目录提示收敛（v5.6）**：编排左侧分组标题不再独立占行——改为组内任一 tab 激活时该行右侧显示简约贴纸（9px 圆角 pill，中性色）；素材页产物目录（output 下）隐藏「还没有标签」提示与下载引导空态，改用中性「该目录暂无产物」，消除误导性覆盖。
- **D-111 素材左侧固定导航 + 根目录可配置 + 项目文档空间（v5.7）**
  - 编排左侧组贴纸由横排 pill 改为竖排小字（vertical-rl，9px），不占行宽、不挤压 tab
  - 素材左侧 = 固定导航：Tag 系统改为始终基于素材根目录聚合（独立 rootScan），不再随浏览路径消失；noTags 提示同为固定信息
  - 新增可配置「素材根目录」（assets_root，默认 = 当前项目目录 data_dir），Settings 通用页可设，作为素材浏览根与面包屑根
  - 文档重构为项目级功能：docs 端点改为项目文档空间（素材根目录下 .md 的浏览/新建/编辑/删除，containment 校验），素材页文档 tab 内嵌阅读/编辑工作区，替代原仓库过程文件只读展示
