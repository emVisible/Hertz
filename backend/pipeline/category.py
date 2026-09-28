"""Bilibili 分区自动分配（参考原项目 Autarkeia pipeline/category.py）。

审核页「分区」Select 未手动设置时，produce 步骤按 subreddit 自动写入
script_json.bili_tid：精确 subreddit 映射 → 关键词兜底 → 类型默认值。
声明与执行同一来源（AXIOM §1.2）；用户手动设置后不再覆盖。

v0.34 A：情感名单同时是**主题轴**的唯一作者（`THEME_SUBREDDITS`），
`SUBREDDIT_TID_MAP` 由它构造——「哪些 subreddit 算情感」不再有第二份名单。
等价性由 `tests/test_theme_quality_filter.py` 的 85 键快照逐键钉住（零行为变化）。
"""

#: 主题轴（v0.34 A 未评分区筛选）：主题 key → 成员 subreddit。
#: key 用英文小写常量，中文只在界面翻——判据不拿中文当键，否则改名就等于换语言。
THEME_SUBREDDITS: dict[str, frozenset[str]] = {
    # 情感类（v0.11.6 情感频道）：B 站无情感一级分区 → 生活日常（21）
    "sentiment": frozenset({
        "MadeMeSmile", "MadeMeCry", "HumansBeingBros",
        "wholesome", "wholesomememes",
        "TikTokCringe", "ContagiousLaughter", "WatchPeopleDieInside",
        "AmItheAsshole", "TrueOffMyChest", "offmychest",
        "relationship_advice", "relationships", "JustNoFamily",
        "BestofRedditorUpdates", "confessions", "happycryingdads",
    }),
}

#: 主题 → 该主题成员的默认分区 tid（主题名单与分区在此一处对齐）
_THEME_TID: dict[str, int] = {"sentiment": 21}

#: 非主题化的 subreddit → 分区。情感类不在此列（由 `THEME_SUBREDDITS` 构造进来）：
#: 同一个名字写两处，主题筛选和分区分配就会在不同版本里各自漂移。
_BASE_SUBREDDIT_TID: dict[str, int] = {
    # 动物（152）
    "aww": 152, "AnimalsBeingDerps": 152, "AnimalsBeingBros": 152, "AnimalsBeingJerks": 152,
    "rarepuppers": 152, "StartledCats": 152, "likeus": 152, "cats": 152, "dogpictures": 152,
    "nature": 152, "EarthPorn": 152, "awwnverts": 152, "animalsdoingstuff": 152,
    "NatureIsFuckingLit": 152, "petsthefast": 152,
    # 搞笑（138）
    "funny": 138, "Whatcouldgowrong": 138, "therewasanattempt": 138,
    "instant_regret": 138, "maybemaybemaybe": 138, "nonononoyes": 138, "yesyesyesno": 138,
    "facepalm": 138, "PublicFreakout": 138, "AbruptChaos": 138,
    "IdiotsInCars": 138, "holdmyfeedingtube": 138, "WTF": 138, "mildlyinfuriating": 138,
    # 日常（21）——v0.11.6：情感向版块从搞笑 138 移入（情感频道定位，单一键不重复）
    "oddlysatisfying": 21, "blackmagicfuckery": 21, "nextfuckinglevel": 21, "BeAmazed": 21,
    "mildlyinteresting": 21, "interestingasfuck": 21, "toptalent": 21,
    "Damnthatsinteresting": 21, "pics": 21, "gifs": 21, "videos": 21, "Unexpected": 21,
    # 知识（36）/ 科学（85）/ 科技（71）
    "todayilearned": 36, "AskReddit": 36, "explainlikeimfive": 36, "math": 36,
    "science": 85, "physics": 85, "space": 85, "chemistry": 85,
    "technology": 71, "gadgets": 71, "programming": 71, "VideoEditing": 71,
    # 美食（23）/ 游戏（4）/ 旅行（155）/ 健身（158）/ 汽车（223）
    "food": 23, "recipes": 23, "Cooking": 23, "FoodPorn": 23,
    "gaming": 4, "gamedev": 4, "pcgaming": 4, "Games": 4,
    "travel": 155, "traveltips": 155,
    "fitness": 158, "bodybuilding": 158, "running": 158, "progresspics": 158,
    "weightlifting": 158,
}

def _merge_tid_map(
    base: dict[str, int],
    themes: dict[str, frozenset[str]],
    theme_tid: dict[str, int],
) -> dict[str, int]:
    """基础表 + 各主题成员 → subreddit→tid，**撞名且 tid 不同就报错**。

    写成 `{**base, **theme_entries}` 也能得到今天的结果，但赢家由字典顺序决定：
    一旦有人把某个 subreddit 既写进基础表（tid A）又加进主题集（tid B），
    后写的那份静默胜出，读代码的人看不出来哪份赢了。冲突是配置错误，
    不是可以用顺序兜底的输入。
    """
    merged = dict(base)
    for theme, members in themes.items():
        tid = theme_tid[theme]
        for subreddit in sorted(members):
            existing = merged.get(subreddit)
            if existing is not None and existing != tid:
                raise ValueError(
                    f"'{subreddit}' 同时在基础分区表（tid {existing}）"
                    f"和主题 '{theme}'（tid {tid}）里——分区归属有两个作者了"
                )
            merged[subreddit] = tid
    return merged


#: subreddit → 分区（对外接口不变）：基础表 + 各主题成员（冲突 fail-loud）。
SUBREDDIT_TID_MAP: dict[str, int] = _merge_tid_map(
    _BASE_SUBREDDIT_TID, THEME_SUBREDDITS, _THEME_TID
)



def theme_subreddits(theme: str) -> frozenset[str]:
    """主题成员名单。未知主题 → ValueError，**不静默返回空集**。

    空集会让「名单没配 / key 拼错」长成「今天一条情感内容都没有」的样子——
    用户没法把这两件事区分开，而本仓反复登记过的正是这种静默退化。
    """
    members = THEME_SUBREDDITS.get(theme)
    if members is None:
        raise ValueError(
            f"unknown theme '{theme}'（已配置主题：{sorted(THEME_SUBREDDITS)}）"
        )
    return members


_KEYWORD_TID_MAP: list[tuple[str, int]] = [
    ("animal", 152), ("dog", 152), ("cat", 152), ("bird", 152), ("pet", 152),
    ("wild", 152), ("nature", 152), ("puppy", 152), ("kitten", 152),
    ("funny", 138), ("laugh", 138), ("meme", 138), ("joke", 138), ("fail", 138),
    ("oddly", 21), ("satisfy", 21), ("interesting", 21), ("wtf", 138),
    ("science", 85), ("physics", 85), ("chem", 85), ("space", 85),
    ("learn", 36), ("explain", 36), ("math", 36), ("knowledge", 36),
    ("tech", 71), ("gadget", 71), ("dev", 71), ("code", 71), ("program", 71),
    ("food", 23), ("cook", 23), ("recipe", 23), ("eat", 23),
    ("game", 4), ("gaming", 4), ("play", 4),
    ("travel", 155), ("tour", 155), ("trip", 155),
    ("fit", 158), ("gym", 158), ("workout", 158), ("sport", 234),
    ("car", 223), ("auto", 223), ("moto", 223), ("driving", 223),
]


def assign_bili_tid(subreddit: str, item_type: str = "video_raw") -> int:
    """返回推荐分区 tid：精确 subreddit → 关键词 → 类型默认（图 202/视频 21）。"""
    if subreddit in SUBREDDIT_TID_MAP:
        return SUBREDDIT_TID_MAP[subreddit]
    low = (subreddit or "").lower()
    for keyword, tid in _KEYWORD_TID_MAP:
        if keyword in low:
            return tid
    return 202 if item_type == "image_gallery" else 21
