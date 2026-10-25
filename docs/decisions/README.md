# decisions/ —— 一决策一文件（ADR）

> **这里回答「为什么这么设计」。** 「变了什么」看 `CHANGELOG.md`，「现在在哪」看 `PROJECT.md`，「怎么判同」看 `AGENTS.md`。
> **规矩：ADR 只写"为什么"，判据必须落在代码与测试里**，别把判据写进文档就算完。

## 索引

| 编号 | 一句话 | 判据在哪 | 日期 |
|---|---|---|---|
| [D-231](D-231-runtime-yaml-stale-pin.md) | `runtime.yaml` 的陈旧默认值会**静默压过**类默认值——「改了默认值」≠「默认值生效」 | `tests/test_runtime_path_pinning.py` | 2026-10-17 |
| [D-232](D-232-cache-signature.md) | 缓存键是内容哈希时，判同要判**内容**，`.size` 不算内容；注释说「内容变了会更新」不算证据 | `mermaidCacheSignature` + `AsyncRenderWiring.test.tsx` | 2026-10-17 |
| [D-233](D-233-media-stream-duration.md) | 容器时长取最长流（通常音频）——按时长算画面的事必须问**视频流** | `tests/test_producer_assemble.py` + `tests/test_media_stream_duration.py` | 2026-10-19 |
| [D-234](D-234-translation-decode-loop.md) | 机翻的重复短语是**解码退化**不是脏数据；护栏放引擎出口，三层：参数 + 折叠 + 密度截断 | `tests/test_translate_engine.py` | 2026-10-25 |
| [D-235](D-235-ass-wrap-and-srt-contract.md) | libass 不给无空格中文折行（句块叠行、两端被裁）；ASS 回喂 `srt_to_ass` 会静默擦掉字幕——预折行 + SRT 契约 | `tests/test_producer_assemble.py` + `tests/test_pipeline_governance.py` | 2026-10-25 |
| ~~D-001…D-230~~ | [`../archive/DECISIONS.md`](../archive/DECISIONS.md) | — | 2026-10-17 前 |

## 编号规则

- 格式 `D-<三位编号>-<短名>.md`，**编号只增不复用**（D-230 已作废，编号作废而非回收）。
- 一个决策一个文件；跨多次提交的同一个判断**续写原文件**并加日期行，不新开。
- 决策被推翻时：把旧文件顶部状态改成「已推翻」，并在新 ADR 里写明「取代 D-xxx」。

## 模板（照抄这七段，别增段）

```markdown
# D-<编号> <一句话结论>

- 日期：YYYY-MM-DD · 状态：提议 / 已采纳 / 已推翻（被 D-xxx 取代）

## 结论
一句话说清定了什么。

## 背景
触发它的**事实**（可核对：日志、测试数、观测值），不是感受。

## 选项与取舍
选了什么、没选什么、为什么。至少写一个被否掉的方案。

## 判据
- `<测试文件或代码位置>` —— 它怎么让这条决策"跑不掉"

## 代价
放弃了什么；以后要额外注意什么。

## 相关
链到相关文档，**只链不抄**。
```

## 成对变异对照清单

本仓的规矩：**每组新判据都要留下"故意改坏 → 对应测试变红"的对照**（`AGENTS.md` §3.7）。 ADR 里记下这组对照，就能证明判据不是空转。

| ADR | 变异操作 | 实测结果 |
|---|---|---|
| D-231 | 清空 `_LEGACY_RUNTIME_VALUES` 的 legacy 表 | 2 red |
| D-231 | `_prune_redundant_path_defaults` 变成空操作 | 3 red |
| D-231 | 同上，变成无差别 `clear()` | 4 red |
| D-232 | 宿主把签名调用改回比 `cache.size` | 1 red |
| D-232 | 签名只留键、丢掉长度 | 1 red |
| D-232 | 签名退化成 `String(cache.size)` | 2 red |
| D-233 | assemble：xfade offset 退回容器时长递推 | 2 red |
| D-233 | assemble：产物校验去掉视频流比对 | 1 red |
| D-233 | assemble：每段音频不再钉到画面长度 | 1 red |
| D-233 | cover：取帧点退回容器时长 | 6 red（参数化抽样全灭） |
| D-233 | phash：25% seek 退回容器时长 | 1 red |
| D-233 | compose：`target` 退回容器时长 | 1 red |
| D-233 | compose：原声轨去掉 `atrim`（事故当日原样） | 1 red |
| D-234 | 解码参数退回 ct2 默认（`rep=1, nrn=0`） | 1 red |
| D-234 | 精确循环折叠变空操作 | 1 red |
| D-234 | 密度阈值 0.35 → 10.0（门永不开） | 3 red |
| D-234 | 密度阈值 0.35 → 0.30（误伤 0.340 的生产正常句） | 2 red |
| D-234 | 密度统计不再排除同字 gram | 1 red |
| D-234 | `_norm` 去掉归一化 | 2 red |
| D-234 | 最长干净前缀 floor 4 → 8 | 1 red |
| D-234 | 噪声字符类回退（`)`/`〉` typo 复现） | 1 red |
| D-234 | 密度阈值 0.35 → 0.50（墙漏过） | 2 red |
| D-235 | 拆掉 `srt_to_ass` 里的折行调用 | 2 red |
| D-235 | 折行预算忽略留白（`w-80` → `w`） | 1 red |
| D-235 | 估宽错：全角按半宽 | 1 red（像素级判据） |
| D-235 | 行数截断 4 → 999 | 1 red |
| D-235 | ASCII 连写逐字成原子（不整块） | 1 red |
| D-235 | 拆掉 ASS 回喂绊线 | 1 red |
| D-235 | retranslate 改回预转 ASS 交 compose | 1 red |
| D-235 | 硬断行只按换行分段（不认 `\N`） | 1 red |
| D-235 | 超宽连写块不再硬切 | 1 red |

> compose 的判据曾写错过一版：量的是成片**视频流**长度，而缺陷撑长的是**音频**，
> 于是变异打不红。改成量两条流**之差**才咬住——判据测错了东西等于没有判据。
> D-235 复现过一次同型错误：两个样本的断点恰好都落在空格/词边界上，
> 「逐字成原子」「不认 `\N`」两组变异第一版打不红，换成边界落在词中间、
> 分段独立计数的样本才咬住。
