"""Bilibili 分区自动分配（参考原项目 Autarkeia pipeline/category.py）。

审核页「分区」Select 未手动设置时，produce 步骤按 subreddit 自动写入
script_json.bili_tid：精确 subreddit 映射 → 关键词兜底 → 类型默认值。
声明与执行同一来源（AXIOM §1.2）；用户手动设置后不再覆盖。
"""

SUBREDDIT_TID_MAP: dict[str, int] = {
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
    # 情感类（v0.11.6 情感频道）：B 站无情感一级分区 → 生活日常（21）
    "MadeMeSmile": 21, "MadeMeCry": 21, "HumansBeingBros": 21,
    "wholesome": 21, "wholesomememes": 21,
    "TikTokCringe": 21, "ContagiousLaughter": 21, "WatchPeopleDieInside": 21,
    "AmItheAsshole": 21, "TrueOffMyChest": 21, "offmychest": 21,
    "relationship_advice": 21, "relationships": 21, "JustNoFamily": 21,
    "BestofRedditorUpdates": 21, "confessions": 21, "happycryingdads": 21,
}

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
