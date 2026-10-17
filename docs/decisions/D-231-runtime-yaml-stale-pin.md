# D-231 `runtime.yaml` 的陈旧默认值会静默压过类默认值

- 日期：2026-10-17 · 状态：已采纳
- 取代：[D-230](../archive/DECISIONS.md) 的取证结论（「2806 次后端启停 = 运行时重启风暴」）

## 结论

`Settings` 的类默认值不是生效值：`settings` 是 `_EffectiveSettings` 代理，**`data/runtime.yaml` 里的值压过类默认值，且压过去时没有任何告警**。两处结构性修复——读时丢弃被取代的旧默认值，写时不再把默认值存成覆盖。

## 背景

两件可核对的事实：

1. **那 2806 次 lifespan 启停不是运行时风暴，是 pytest 自己造 app。** 四条独立证据：单次启停只花 0.13s（真实 uvicorn 重启含解释器与 `spawn` 成本做不到这么快）；按分钟聚类是连续数小时的 85–110 次/分钟平台段，而非「启动后第 60 秒开始循环」；窗口与 `verify-full.log`（mtime 08:53:07）逐分钟吻合，而窗口内**零 `.py` 变动**——`uvicorn --reload` 只认 `*.py`；峰值 8 次/秒正是「一个 pytest 文件里连续 8 个用例各自建一次 app」的形状。
2. **D-230 的「日志搬家」从未生效过。** 设置页保存的是表单全量快照，早在 10-12 就把当时的旧默认 `log_dir: logs` 写进了 `data/runtime.yaml`。新默认值被自己的历史钉死，真机上 `settings.log_dir` 至今是 `logs`——而全量 pytest 绿、`verify.sh` 全绿、**零报错**。

## 选项与取舍

| 选项 | 评价 |
|---|---|
| **读时丢弃被取代的旧值 + 写时剪掉冗余默认** | 采纳。不动用户文件，治本，且下次默认值变更不会再被同一份文件钉死 |
| 直接改写 `data/runtime.yaml`（把 `logs` 换成 `data/logs`） | 否决：只治这一台机器，而 runtime.yaml 是用户资产，没资格替他改内容 |
| 去掉 `log_dir` 的设置页可编辑性 | 否决：治标。真正的洞是**「runtime.yaml 里可以存默认值」这件事本身**，去掉一个字段并不能防止下一个字段重蹈覆辙 |
| 让 `HERTZ_*` 环境变量压过 runtime.yaml | 否决：会改动 AXIOM §22.3 的分层语义（runtime.yaml 压过 Settings 是既定设计），影响面远大于本问题 |

`assets_root` 默认是 `None`，所以 `assets_root: data` 这种「显式指回 data_dir」不是默认值回声，**不剪**——`docs.py` / `library.py` 直接读 `runtime_config.load()["assets_root"]`，误剪会让素材浏览根静默变成另一棵树。

## 判据

- `tests/test_runtime_path_pinning.py`（11 条）—— 让「改了默认值必须真的生效」跑不掉：
  - 纯逻辑守卫 `RuntimeConfig(path=tmp).load()` 与 env/cwd 无关（测试环境 conftest 注入 `HERTZ_LOG_DIR`，基线本来就不是类默认值）；
  - 端到端守卫：PATCH 存「等于默认值」的值 → 不进 runtime.yaml、生效值一步不差；
  - 反向守卫：剪枝不得变成无差别清空。
- 成对变异：清空 legacy 表 → 2 red；剪枝变空操作 → 3 red；变无差别清空 → 4 red。

## 代价

- `RuntimeConfig.load()` 每次重载多一个字段的查表（可忽略）。
- 未来再改某个路径字段的默认值，仍需在 `_LEGACY_RUNTIME_VALUES` 里补一行旧值——**这是有意的**：显式列出"哪些旧值等于默认值回声"，比隐式猜要可靠。

## 沉淀

**一次「全绿的验证」如果跑在一层看不见失败的位置上，它什么都没验证。** D-230 的门禁全过，但它们都跑在 pytest 进程里，而被测行为发生在**真机 + 用户自己的 runtime.yaml** 这个组合上。另外：**测试断言要钉「生效值」而不是类字段默认值**——本次第一版判据就栽在这（测试环境的 env 覆盖让基线与类默认值不同）。

## 相关

- [`../archive/DECISIONS.md`](../archive/DECISIONS.md) —— D-001…D-232 原始记录（故意保留结构缺陷作为反面例证）
- `AGENTS.md` §2 不变量 #2 —— 「改了 `Settings` 默认值，要确认它真的生效」
- `CHANGELOG.md` —— 本次修的什么（长叙事已不在那里）
