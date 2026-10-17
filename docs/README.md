# docs/ —— 权威地图

> **先读这份，再读别的。** 它只说「哪份文档是哪个事实的权威」，不复制它们的内容。
> 想知道怎么干活看 [`../AGENTS.md`](../AGENTS.md)；想知道现在在哪看 [`../PROJECT.md`](../PROJECT.md)。

## 读文档的顺序

1. **要动手** → `AGENTS.md`（门禁、不变量、陷阱、别动什么）
2. **要判断现状** → `PROJECT.md`
3. **要查为什么这么设计** → 下面这张表的「权威于」列
4. **要查历史** → `archive/` 或 git log，**不要**在活跃文档里找历史

## 权威地图

| 文档 | 是什么 | 权威于 | 生命周期 |
|---|---|---|---|
| [`API_INVENTORY.md`](API_INVENTORY.md) | 全部 API 路由清单 | **端点列表**（生成物，`uv run python scripts/api_inventory.py` 重生成） | ACTIVE · 自动生成 |
| [`MD_STUDIO.md`](MD_STUDIO.md) | MD Studio 的设计理由与规则归属 | **排版规则在哪、为什么这么取舍、明确不做的事** | ACTIVE |
| [`MD_STUDIO_UPDATE_PLAN.md`](MD_STUDIO_UPDATE_PLAN.md) | 功能审计 + 竞品调研 + 优先级清单 | **MD Studio 的 P0/P1/P2 待办排序**（§5 有下一批候选） | ACTIVE |
| [`MD_STUDIO_TEST_SHEET.md`](MD_STUDIO_TEST_SHEET.md) | 人工验收单（自动化证不到的那些） | **需要人眼确认的检查项**（观感、吸附手感、剪贴板权限） | ACTIVE · 打 tag 后过期 |
| [`ROADMAP.md`](ROADMAP.md) | 里程碑、已知缺口 | **高/中/低缺口表与维护约定**（§在飞 段落已过期，看 git 历史） | ACTIVE |
| [`USER_GUIDE.md`](USER_GUIDE.md) | 面向使用者 | **安装、配置、故障排查**（开发者向的重合部分以 README 为准） | ACTIVE |
| [`AI_BASE.md`](AI_BASE.md) | AI provider 层 | **ProviderRegistry、角色→模型路由、密钥托管**（⚠️ 全文无状态行，最旧的一份，需要时补） | ACTIVE · 待复核 |
| [`specs/`](specs/) | 已批准的设计规格 | **被批准那一刻的架构**（append-only，不追改） | STABLE |
| [`decisions/`](decisions/) | 一决策一文件（ADR） | **为什么这么选 + 判据在哪** | ACTIVE |
| [`archive/`](archive/) | 历史文档，原样保留 | 只对「过去发生过什么」权威；**现状一律不看这里** | ARCHIVED |

## 规矩（三条，破了就会重新长出重复）

1. **一个事实一个权威。** 新增事实前先查这张表；能在别处找到的，只**链**，不抄。
2. **判据不写在文档里，写进代码与测试。** 文档说「靠哪条判据守住」，判据本身是测试。
3. **归档用 `git mv` + 顶部三行状态头**（已归档 / 被谁取代 / 何时），**不重写归档内容**——重写历史会制造无法核对的「真相」（这条教训来自 D-231）。

## 归档区说明

`archive/` 里的文档保留是为了可追溯（Git 历史之外再留一层），**不在其中继续更新**。每份顶部有状态头说明它被谁取代。想知道某个旧设计为什么存在，读它；想知道现在是什么，读上面的表。
