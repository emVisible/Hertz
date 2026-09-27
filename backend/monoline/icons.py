"""Inline SVG icon library (V31) — 158 line icons, no files, no network.

The geometry is vendored from Lucide v1.48.0 (ISC, see ``vendor/lucide``) and
inlined into ``data/icons.json`` by ``scripts/build_icons.py``. We keep *our own*
keys (``chart``, ``trend_up``, ``layers``…) instead of Lucide's slugs so a Lucide
rename upstream can never break a scene plan or a saved preset.

``_ICON_KEYWORDS`` maps surface wording → key, matched as a lowercase substring.
That sets the authoring rules, both enforced by ``tests/test_smoke.py`` because
violations produced real nonsense picks (``位``→binary on 「单位」, ``rain``→droplet
on 「training」): ASCII keywords must be ≥4 chars, Chinese ones ≥2, and every
keyword must already be lowercase.

Deterministic static markup only (safe for HyperFrames render). Names are the
whitelist; unknown names render nothing (no injection). Color comes from the
surrounding CSS ``color`` (themes set it to the accent).
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_DATA = Path(__file__).parent / "data" / "icons.json"


@lru_cache(maxsize=1)
def _table() -> dict[str, str]:
    return dict(json.loads(_DATA.read_text(encoding="utf-8"))["icons"])


_ICONS = _table()

# default icon per scene kind (planner auto-assigns; user can override/clear)
KIND_ICON = {
    "title": "sparkles", "statement": "", "section": "arrow", "stat": "chart",
    "table": "grid", "cards": "layers", "compare": "scale", "quote": "quote",
    "list": "list", "note": "", "definition": "bulb", "summary": "check",
    "image": "eye", "flow": "workflow", "radial": "network", "steps": "list_ordered",
    "arch": "stack", "cycle": "refresh", "funnel": "funnel",
}


def names() -> list[str]:
    return sorted(_ICONS.keys())


def catalog() -> list[dict[str, str]]:
    """Name + path body for every icon — what /api/icons serves so the Studio can
    show a preview grid. Ordered by name; the body is vendored, not user input."""
    return [{"name": k, "body": v} for k, v in sorted(_ICONS.items())]


# keyword → icon, first match wins (ordered by specificity). zh + en substrings.
_ICON_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("cpu", ("芯片", "半导体", "算力", "算法", "模型", "神经网络", "处理器", "推理", "边缘计算",
             "chipset", "semiconductor", "compute", "algorithm", "neural", "inference")),
    ("bot", ("机器人", "自动化", "智能体", "助手", "自动", "agent", "robot", "automation", "assistant")),
    ("brain", ("大脑", "心智", "思维", "心理", "学习", "记忆", "brain", "cognit", "learn", "memory")),
    ("brain_circuit", ("人工智能", "机器学习", "深度学习", "智能系统", "machine learning", "deep learning",
                       "artificial intelligence")),
    ("rocket", ("发射", "起飞", "上线", "发布", "冲刺", "launch", "release", "rocket", "blast off")),
    ("arrow_up", ("增长", "上涨", "涨幅", "翻倍", "grew", "growth", "jumped", "soared")),
    ("arrow_down", ("跌幅", "缩水", "下降至", "reduced", "shrank", "fell")),
    ("chart", ("数据", "统计", "图表", "曲线", "报表", "data", "chart", "figure", "statistic", "analytics")),
    ("pie", ("占比", "份额", "分布", "构成", "组成", "share of", "breakdown", "composition", "proportion")),
    ("percent", ("百分比", "百分", "比例", "折扣", "利率", "税率", "percent", "percentage", "margin")),
    ("gauge", ("仪表", "水平", "程度", "容量", "负载", "capacity", "utilization", "gauge", "throughput")),
    ("range", ("区间", "范围", "幅度", "跨度", "波动区间", "spectrum", "extent")),
    ("coins", ("资金", "投资", "回报", "收益", "利润", "capital", "invest", "return", "profit")),
    ("wallet", ("钱包", "支付", "消费", "预算", "payment", "wallet", "budget", "spend")),
    ("banknote", ("现金", "营收", "销售额", "货币", "收入", "revenue", "cash", "income", "sales")),
    ("cart", ("购买", "订单", "电商", "零售", "下单", "purchase", "orders", "shopping", "retail", "checkout")),
    ("store", ("门店", "商店", "线下", "渠道", "shop", "store", "merchant", "branch")),
    ("truck", ("物流", "运输", "配送", "供应链", "货运", "logistics", "delivery", "shipping", "freight",
               "supply chain")),
    ("package", ("产品", "包装", "交付物", "套件", "product", "package", "bundle", "shipment")),
    ("box", ("容器", "封装", "盒子", "箱体", "container", "crate", "encapsul")),
    ("warehouse", ("仓库", "库存", "储备", "数据中心", "inventory", "warehouse", "storage", "stock")),
    ("factory", ("工厂", "制造", "生产", "产能", "产线", "factory", "manufactur", "production", "plant")),
    ("server", ("服务器", "云端", "集群", "部署", "后端", "server", "cloud", "cluster", "deploy", "backend")),
    ("cloud", ("云计算", "云服务", "在线", "远程", "cloud", "online", "remote", "saas")),
    ("database", ("数据库", "存储", "语料", "索引", "dataset", "database", "index", "query", "corpus")),
    ("code", ("代码", "编程", "开发", "脚本", "源码", "code", "program", "develop", "script")),
    ("terminal", ("命令行", "终端", "控制台", "指令", "command", "terminal", "console", "shell")),
    ("binary", ("二进制", "字节", "编码", "binary", "byte", "encode")),
    ("network", ("网络", "互联", "连接", "节点", "拓扑", "network", "internet", "node", "topology")),
    ("wifi", ("无线", "信号覆盖", "联网", "带宽", "wireless", "broadband")),
    ("signal", ("信号", "传输", "通信", "广播", "signal", "transmit", "broadcast", "communication")),
    ("link", ("链接", "绑定", "关联", "挂钩", "chain", "bind", "unite", "joint")),
    ("workflow", ("流程", "工作流", "编排", "流水线", "workflow", "pipeline", "orchestrat")),
    ("route", ("路径", "路线", "动线", "路线图", "path", "route", "journey", "roadmap")),
    ("branch", ("分支", "分叉", "版本", "branch", "fork", "variant", "edition")),
    ("split", ("拆分", "分离", "解耦", "切开", "split", "separate", "divide", "decouple")),
    ("commit", ("提交", "承诺", "交付承诺", "commit", "check-in")),
    ("milestone", ("里程碑", "阶段目标", "重大节点", "marker", "checkpoint")),
    ("flag", ("第一", "领先", "首个", "突破", "标志", "旗帜", "first", "leading", "record", "flag")),
    ("target", ("目标", "达成", "命中", "聚焦", "精准", "定位", "核心", "goal", "target", "focus", "precision")),
    ("crosshair", ("对准", "对标", "锁定", "精确定位", "align", "benchmark")),
    ("compass", ("战略", "方向感", "导航", "探索", "strategy", "navigate", "explore", "compass")),
    ("map_pin", ("地点", "位置", "站点", "城市", "location", "place of", "map pin")),
    ("globe", ("全球", "世界", "国际", "跨地域", "global", "world", "internation", "abroad")),
    ("earth", ("地球", "环境", "生态", "自然", "earth", "climate", "environ", "ecolog", "green")),
    ("building", ("企业", "公司", "机构", "组织", "企业级", "company", "corporate", "firm", "organization")),
    ("users", ("用户", "团队", "客户", "人群", "社区", "协作", "users", "team", "customer", "audience",
               "community")),
    ("user", ("个人", "个体", "单人", "画像", "personal", "individual", "profile", "persona")),
    ("handshake", ("合作", "伙伴", "协议", "联盟", "partnership", "collaborat", "agreement", "alliance")),
    ("hand_heart", ("关怀", "责任", "公益", "温度", "charity", "welfare", "volunteer")),
    ("heart", ("热爱", "喜欢", "情感", "温度", "love", "heart", "passion")),
    ("award", ("奖项", "荣誉", "获奖", "认证", "award", "honor", "prize", "certified")),
    ("trophy", ("冠军", "夺冠", "排名第一", "金牌", "champion", "winner", "gold medal")),
    ("medal", ("奖牌", "评级", "等级", "银牌", "medal", "rank", "grade", "tier")),
    ("star", ("明星", "评分", "精选", "推荐", "stars", "rating", "featured", "review")),
    ("shield", ("安全", "防护", "合规", "信任", "风控", "security", "privacy", "safety", "compliance", "shield")),
    ("lock", ("加密", "锁定", "权限", "隐私保护", "encrypt", "locked", "permission", "private")),
    ("key", ("关键", "密钥", "核心要素", "钥匙", "secret", "credential")),
    ("alert", ("风险", "警告", "隐患", "告警", "risk", "warning", "alert", "danger", "threat")),
    ("bell", ("提醒", "通知", "告警推送", "notify", "notification", "reminder", "alarm")),
    ("inbox", ("待办", "收件", "队列", "积压", "queue", "backlog", "pending", "inbox")),
    ("clock", ("时间", "历史", "周期", "年限", "日期", "等待", "history", "cycle", "year", "wait")),
    ("timer", ("倒计时", "耗时", "时长", "限时", "countdown", "duration", "elapsed", "deadline")),
    ("hourglass", ("等待", "流逝", "窗口期", "waiting", "window")),
    ("calendar", ("日程", "排期", "计划", "年度", "季度", "schedule", "calendar", "planning", "quarter")),
    ("gantt", ("进度表", "甘特", "时间表", "时间轴", "timeline", "gantt", "roadmap")),
    ("refresh", ("循环", "迭代", "反复", "更新", "闭环", "loop", "iterate", "repeat", "feedback", "recycle")),
    ("repeat", ("重复", "复用", "周期往复", "recurring", "reuse", "cyclic")),
    ("loader", ("进行中", "处理中", "运行中", "loading", "in progress", "ongoing")),
    ("sparkles", ("亮点", "精彩", "创新", "非凡", "独特", "magic", "innovat", "brilliant", "remarkable")),
    ("flame", ("热门", "火爆", "热度", "流行", "trending", "popular", "viral", "heated")),
    ("snow", ("冷启动", "冬季", "遇冷", "停滞", "cold", "stagnant", "freeze")),
    ("wind", ("趋势", "风向", "驱动力", "浪潮", "wind", "momentum", "driven")),
    ("wave", ("声波", "震荡", "起伏", "脉冲", "wave", "oscillat", "pulse")),
    ("activity", ("活动", "活跃", "行为", "运转", "activity", "behavior", "engage")),
    ("atom", ("原子", "微观", "要素", "粒子", "atom", "particle", "molecule", "quantum")),
    ("microscope", ("研究", "细分", "实验", "试验", "research", "study", "experiment", "detail")),
    ("telescope", ("远期", "展望", "前瞻", "洞察远方", "vision", "outlook", "forecast", "foresight")),
    ("search", ("搜索", "查找", "检索", "调研", "search", "find", "lookup", "query")),
    ("scan", ("扫描", "检测", "识别", "筛查", "scan", "detect", "inspect", "check")),
    ("satellite", ("卫星", "遥感", "监测", "航天", "太空", "轨道", "satellite", "spacecraft", "orbit")),
    ("sun", ("日光", "白天", "能量来源", "光明", "solar", "sunlight", "bright", "daytime")),
    ("moon", ("夜间", "睡眠", "黑暗", "夜晚", "night", "sleep", "dark", "lunar")),
    ("bolt", ("速度", "效率", "加速", "快速", "毫秒", "即时", "性能", "电力", "speed", "fast", "performance",
              "instant", "power", "electric")),
    ("circuit", ("电路", "电子", "线路", "circuit", "electronic", "wiring")),
    ("sliders", ("参数", "调节", "配置", "设置", "调优", "parameter", "tune", "settings", "configure", "adjust")),
    ("settings", ("齿轮", "机制设置", "系统设置", "config", "gear", "setup")),
    ("wrench", ("工具", "维护", "修理", "运维", "tool", "maintenance", "repair", "utility")),
    ("hammer", ("建造", "打造", "施工", "构建", "build", "construct", "forge")),
    ("puzzle", ("难题", "拼图", "补位", "环节", "puzzle", "problem", "missing piece", "riddle")),
    ("complex", ("复杂", "交错", "纠缠", "complicated", "intricate", "tangled")),
    ("grid", ("布局", "网格", "多维", "矩阵", "方面", "grid", "layout", "matrix")),
    ("grid2", ("双栏", "二分", "面板", "two column", "pane")),
    ("grid3", ("全景", "总览", "多面板", "overview", "dashboard view")),
    ("panels", ("面板", "分屏", "看板", "panel", "section view")),
    ("table", ("表格", "清单表", "对照表", "tables", "spreadsheet", "ledger")),
    ("list", ("清单", "列表", "条目", "阶段", "list", "items", "agenda", "phase")),
    ("list_ordered", ("步骤", "依次", "按顺序", "编号", "step", "ordered", "sequence", "ranked")),
    ("list_check", ("检查项", "核对", "验收", "checklist", "verify", "audit")),
    ("list_bullet", ("要点", "子弹", "罗列", "bullet", "points")),
    ("todo", ("任务", "执行", "工单", "todo", "task", "to-do")),
    ("clipboard", ("记录", "抄录", "文档", "clipboard", "record", "note")),
    ("file", ("文件", "档案", "报告", "file", "document", "report", "paper", "docs")),
    ("folder", ("目录", "分类", "归档", "folder", "directory", "category", "archive")),
    ("receipt", ("账单", "发票", "明细", "费用", "billing", "invoice", "receipt", "charges")),
    ("layers", ("系统", "架构", "层级", "层次", "分层", "模块", "组件", "结构", "layer", "system", "module")),
    ("stack", ("堆叠", "叠加", "累计", "积压", "heap", "cumulat", "piled", "stacked")),
    ("funnel", ("漏斗", "筛选", "转化", "过滤", "funnel", "filter", "convert", "screening")),
    ("filter", ("过滤", "甄别", "挑选", "筛除", "sift", "exclude")),
    ("minus", ("差距", "缺口", "赤字", "不足", "deficit", "shortfall", "lacks")),
    ("area", ("面积", "覆盖量", "总量", "area", "coverage", "volume")),
    ("bars", ("条形", "柱状", "对比条", "bars", "histogram")),
    ("candlestick", ("行情", "k线", "交易", "stocks", "trading", "candlestick")),
    ("audio", ("音频", "声音", "语音", "旁白", "audio", "sound", "voice", "speech")),
    ("mic", ("麦克风", "录音", "播报", "podcast", "microphone", "record")),
    ("volume", ("音量", "响度", "volume", "loudness")),
    ("play", ("播放", "演示", "运行", "play", "present", "running")),
    ("eye", ("观察", "视角", "洞察", "发现", "看见", "观看", "watch", "insight", "observe", "vision")),
    ("check", ("完成", "成功", "正确", "验证", "达标", "done", "success", "verified", "passed")),
    ("cross", ("错误", "失败", "排除", "问题", "error", "fail", "wrong", "problem", "issue")),
    ("chevron", ("展开", "折叠", "箭头指示", "expand", "collapse")),
    ("chevrons", ("级联", "层层递进", "cascade")),
    ("arrow", ("方向", "未来", "前进", "下一步", "走向", "future", "next", "forward", "direction")),
    ("info", ("注意", "提示", "说明", "信息", "背景", "note", "info", "context", "meanwhile")),
    ("quote", ("认为", "表示", "强调", "指出", "声称", "said", "argues", "notes that")),
    ("message", ("留言", "对话", "消息", "沟通", "message", "chat", "comment", "feedback")),
    ("mail", ("邮件", "写信", "邮箱", "email", "mailbox", "newsletter")),
    ("phone", ("电话", "通话", "热线", "phone", "call", "hotline")),
    ("send", ("发送", "推送", "投递", "send", "submit", "dispatch")),
    ("share", ("分享", "传播", "分发", "share", "distribute", "spread")),
    ("title", ("标题", "名称", "标题为", "heading", "title", "named")),
    ("heading", ("章节", "小标题", "副标题", "subtitle", "section head")),
    ("bulb", ("想法", "创意", "灵感", "概念", "理解", "认知", "原理", "机制", "idea", "concept", "principle",
             "reason")),
    ("scale", ("对比", "权衡", "取舍", "优劣", "平衡", "相比", "versus", "compare", "trade-off", "balance")),
    ("scale", ("公正", "法律", "监管", "合规审查", "justice", "regulation", "legal")),
    ("bookmark", ("收藏", "标记", "书签", "bookmark", "saved", "flag later")),
    ("pin", ("固定", "置顶", "别针", "attach", "stuck")),
    ("droplet", ("水滴", "液体", "湿度", "降雨", "drop", "liquid", "water", "humid")),
    ("footprints", ("足迹", "轨迹", "沿革", "trace", "trail", "traceback")),
    ("dashboard", ("仪表盘", "驾驶舱", "总控", "cockpit", "control panel")),
    ("brackets", ("括号", "标记符", "语法", "bracket", "syntax", "markup")),
    # bare direction sits last: 「提高」/「下降」 say *which way*, not *what* — every
    # domain cluster above deserves first refusal on them.
    ("trend_up", ("上升", "攀升", "提高", "提升", "走高", "increas", "climbed", "upward", "surge")),
    ("trend_down", ("下降", "下滑", "回落", "走低", "减少", "decreas", "decline", "downward", "dropped")),
]


def pick_icon(text: str) -> str:
    """Best-effort semantic icon for a beat's text; '' when nothing matches."""
    s = (text or "").lower()
    for icon, kws in _ICON_KEYWORDS:
        for kw in kws:
            if kw in s:
                return icon
    return ""


def svg(name: str, *, size: int | None = None) -> str:
    inner = _ICONS.get(name)
    if not inner:
        return ""
    dim = f' width="{size}" height="{size}"' if size else ""
    return (f'<svg{dim} viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            f'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{inner}</svg>')
