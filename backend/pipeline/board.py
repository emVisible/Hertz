"""看板列语义（v0.34 B）。**spec §4.2 的表格逐字对应这里**，改一边必须改另一边。

一列一条记录（不重复计数），优先级从上看：

| 列 | 归属条件 |
|---|---|
| `focus` | `focus_date == day` 且 status ∉ (published, rejected) |
| `in_work` | status ∈ (downloaded, scored) 且未捞进今日 |
| `review` | status == queued |
| `ready_to_publish` | status == approved |
| `published_today` | status == published 且 `published_at` ∈ [from, to) |

取数一律走 `QueriesMixin.list_items`——**本模块不写 SQL、不定义筛选条件**。列的划分
做成纯函数是为了测得动：一条记录只能进一列，这条性质用假数据就能钉死，不需要库。

`published_today` 的区间由前端下发（时区在前端算，见 spec §4.1）；这里只比较
ISO 字符串（同一来源、同一格式，字典序即时间序）。
"""

from __future__ import annotations

IN_WORK_STATUSES = ("downloaded", "scored")
#: 今日列不许出现的状态。为什么单独列出来：`set_focus` 只挡归档，用户完全可能
#: 「上午捞进今日、下午把它拒了」——那时它该只出现在异常区，而不是继续赖在
#: 今日待办里冒充还有活儿。`published` 走 spec §4.2 的原规则（归今日已发列）。
FOCUS_EXCLUDED_STATUSES = ("published", "rejected")
#: 每列的展示上限（集中在这一处，端点与界面都读它，别在两侧各写一个数）
COLUMN_LIMITS = {
    "focus": 200,
    "in_work": 100,
    "review": 100,
    "ready_to_publish": 100,
    "published_today": 100,
}
COLUMNS = tuple(COLUMN_LIMITS)


def build_columns(
    items: list[dict], day: str, published_from: str, published_to: str
) -> dict:
    """把条目分到五列，并给出每列**截断前**的计数与今日完成度。

    纯函数：不查库、不修改入参。三个返回键各有用途——`columns` 给界面渲染（已按
    `COLUMN_LIMITS` 截断），`counts` 是截断前的真实条数（界面据此写「共 N 条」；
    把筛后当全量是这个仓库被坑过的形状），`progress` 是顶栏的「已发 N / 捞入 M」。

    去重按 `id`：端点每列各查一次（`list_items` 的筛选参数就是列定义），一条记录被
    两列同时捞到时，由下面的 if/elif **优先级**决定它只出现在一列——这就是「一条记录
    只进一列」的可证形式，重复计数因此会被测出来而不是靠人肉发现。
    """
    uniq: dict[str, dict] = {}
    for it in items:
        iid = it.get("id")
        if iid is not None:
            uniq[str(iid)] = it
    rows = list(uniq.values())

    def _in_window(it: dict) -> bool:
        return published_from <= str(it.get("published_at") or "") < published_to

    # 完成度的 M 含「今天捞入且已发布」那批：它们不进 focus 列（published 归今日已发），
    # 但 spec §4.3 的「已发 N / 捞入 M」必须数得到它们，否则今天发掉的会凭空消失。
    # `rejected` 两边都不算：那条活儿今天不会再动了，把它计进 M 就是让 N/M 永远追不平。
    focused = [
        r for r in rows if r.get("focus_date") == day and str(r.get("status") or "") != "rejected"
    ]
    published_of_focus = [
        r for r in focused if str(r.get("status") or "") == "published" and _in_window(r)
    ]

    cols: dict[str, list[dict]] = {k: [] for k in COLUMNS}
    for it in rows:
        status = str(it.get("status") or "")
        if it.get("focus_date") == day and status not in FOCUS_EXCLUDED_STATUSES:
            cols["focus"].append(it)
        elif status in IN_WORK_STATUSES:
            cols["in_work"].append(it)
        elif status == "queued":
            cols["review"].append(it)
        elif status == "approved":
            cols["ready_to_publish"].append(it)
        elif status == "published" and _in_window(it):
            cols["published_today"].append(it)
        # 其余（discovered / failed / rejected / archived / 昨天捞的）不属于看板，
        # 由未评分区与异常区承载——spec §二 明确看板不接异常区。
    return {
        "columns": {k: v[: COLUMN_LIMITS[k]] for k, v in cols.items()},
        "counts": {k: len(v) for k, v in cols.items()},
        "progress": {"focused": len(focused), "published_of_focus": len(published_of_focus)},
    }
