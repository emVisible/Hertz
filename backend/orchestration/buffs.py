"""BuffService — Buff/Debuff 库 CRUD（v5.2）。

Buff = 注入 agent system prompt 的附加指令（态度/话术），两级：
lightweight（轻量纯文本）/ heavy（重量，类 skill——复杂多段指令）。
Debuff = 反向提示词（指明"不要做什么"），与 buff 同一维护机制，
按 polarity 区分注入为【禁忌】段。
内置以代码为准（AXIOM §1.2 单一真相源）：_seed 时同步代码版本，
用户想自定义请新建（内置 key 会被代码覆盖）。random 特殊 key 从随机池抽取。
"""

import logging
import random
from uuid import UUID

from sqlalchemy import select

from backend.models.buff import Buff
from backend.models.session import session_factory

logger = logging.getLogger(__name__)

# 内置 debuff 单一真相源：反向提示词（"不要做什么"）
BUILTIN_DEBUFFS: list[dict] = [
    {
        "key": "no_clickbait",
        "name": "拒绝标题党",
        "kind": "lightweight",
        "effect": (
            "禁止：\n"
            "① 标题或开头使用'震惊''万万没想到''看完你就懂了''99% 的人不知道'等制造虚假悬念；\n"
            "② 夸大事实、把结论说得比论据支撑的更满；\n"
            "③ 用'最后一点最重要''看到最后'式的诱饵。\n"
            "内容本身有价值就直说，不需要用话术骗点击。"
        ),
        "category": "stable",
        "polarity": "debuff",
    },
    {
        "key": "no_ai_phrases",
        "name": "禁用 AI 套话",
        "kind": "lightweight",
        "effect": (
            "以下表达一律禁止出现：\n"
            "'总而言之''综上所述''值得注意的是''不仅…而且…''让我们''在这个…的时代'"
            "'深入浅出''息息相关''一言以蔽之'。\n"
            "也禁止用'首先/其次/最后'的机械罗列开场（除非内容本身是步骤说明）。"
        ),
        "category": "stable",
        "polarity": "debuff",
    },
    {
        "key": "no_fluff",
        "name": "禁止注水",
        "kind": "heavy",
        "effect": (
            "禁止为凑字数而写的内容：\n"
            "① 重复论点——同一个观点用不同说法说两遍以上；\n"
            "② 无关的背景铺垫（'在当今社会…'这类万能开头）；\n"
            "③ 每个观点后面跟一段空泛的'这说明…''这告诉我们…'；\n"
            "④ 三句以上没有新信息的过渡段。\n"
            "自查：删掉任何一段，如果文章意思不变，说明这段就是注水，删掉。"
        ),
        "category": "stable",
        "polarity": "debuff",
    },
    {
        "key": "no_praise",
        "name": "禁止吹捧",
        "kind": "lightweight",
        "effect": (
            "禁止：\n"
            "① 对内容/产品/对象无依据的吹捧（'最好的''最棒的''强烈推荐'）；\n"
            "② 空洞的形容词堆砌（'卓越''极致''匠心'）；\n"
            "③ 结论先于证据的赞颂。\n"
            "想夸就给出可验证的理由；给不出就别说。"
        ),
        "category": "stable",
        "polarity": "debuff",
    },
    {
        "key": "no_formal",
        "name": "禁止端着",
        "kind": "lightweight",
        "effect": (
            "禁止：\n"
            "① 公文/官方腔（'予以''切实''进一步推进''积极落实'）；\n"
            "② 全篇书面语、零口语感——像读文件不像读文章；\n"
            "③ 第三人称旁观视角叙述自己的经历（'我们'代替'我'）。\n"
            "用平时说话的方式写，而不是汇报工作的方式。"
        ),
        "category": "stable",
        "polarity": "debuff",
    },
]

# 内置 buff 单一真相源（AXIOM §1.2）：迁移 wave10 也种同一份。
# 扩写原则（提示词工程）：给出可执行的具体指令而非抽象形容词；
# 每条含「做什么 + 怎么做到 + 避免什么」，让 LLM 有明确行为依据。
BUILTIN_BUFFS: list[dict] = [
    {
        "key": "human_touch",
        "name": "人情味",
        "kind": "lightweight",
        "effect": (
            "让文字像一个有温度的真实的人在说话，而不是机构发言或 AI 模板。\n"
            "怎么做到：\n"
            "① 至少一处来自你个人经验的具体细节（一个场景、一次对话、一个物件），"
            "细节要具体到别人无法编造（如'凌晨两点便利店的热饮机'而不是'深夜'）；\n"
            "② 允许承认不确定、承认自己曾经做错过——'我一开始也这么想，后来发现不是'；\n"
            "③ 用口语化的连接（'说真的''你猜怎么着'），但每篇不超过两处，多了显油；\n"
            "④ 结尾留一个真实的、可被反驳的个人判断，而不是总结陈词。\n"
            "避免：说教口吻、'我们都'式的集体绑架、为了温情而编造的经历。"
        ),
        "category": "stable",
    },
    {
        "key": "de_ai",
        "name": "去 AI 味",
        "kind": "lightweight",
        "effect": (
            "消除一切'一眼 AI'的痕迹，让文字像人写的。\n"
            "必须删除/替换的句式：\n"
            "① 四字成语连排与空洞套话：'总而言之''综上所述''值得注意的是'"
            "'在这个快速发展的时代''不仅…而且…''让我们''总而言之'；\n"
            "② 对称排比堆砌（'既要…又要…更要…'、三连反问）——最多保留一处，且必须服务内容；\n"
            "③ 每个自然段都以结论开头、以总结收尾的机械结构——段内要允许'岔开再收回来'；\n"
            "④ 万能形容词（'深刻''重要''独特''息息相关'）——换成能证明它的具体事实或例子；\n"
            "⑤ 句长均匀、节奏死板——混入 3-5 个短句（≤8 字）和 1 个长句（≥40 字），"
            "制造呼吸感。\n"
            "自检：把自己当读者，任何一句让你觉得'这像客服写的'，就重写。"
        ),
        "category": "stable",
    },
    {
        "key": "firm_tone",
        "name": "语气强硬",
        "kind": "lightweight",
        "effect": (
            "观点直接、立场鲜明、不给自己留退路，读起来像有主见的人在做判断。\n"
            "怎么做到：\n"
            "① 每条核心观点用肯定句陈述（'这行不通'而不是'这可能行不通'）；\n"
            "② 删掉模糊限定词：'可能''或许''某种程度上''一般来说''在我看来'——"
            "需要保留时改成有分量的表述（'事实是''我的判断是''别被骗了'）；\n"
            "③ 对常见的错误观点点名批评（'很多人说…这恰恰是反的'），不匿名和稀泥；\n"
            "④ 结尾给一个明确的行动建议或立场声明，不留开放结尾。\n"
            "避免：为强硬而强硬（骂街式）、无视反方的合理之处——强硬不等于不讲理，"
            "可以先承认反方一点，再亮出更强的判断。"
        ),
        "category": "stable",
    },
    {
        "key": "concise",
        "name": "简洁有力",
        "kind": "lightweight",
        "effect": (
            "用最少的字说清最多的事，像删改过三遍的稿子。\n"
            "怎么做到：\n"
            "① 每句话只留一个意思：一句话里出现两个'和'，拆成两句；\n"
            "② 删掉所有装饰性成分：可删的形容词、副词（'非常''真的''其实''确实'）、"
            "举例前多余的铺垫；\n"
            "③ 能用一个词不用一个短语，能用一个短语不用一个从句；\n"
            "④ 段落里第一句是结论，其余是支撑，没有支撑的句子直接删；\n"
            "⑤ 全文删掉 20% 的字数后再读一遍——如果删了更清楚，说明还该删。\n"
            "目标：读者读完的感觉是'说清楚了'，而不是'写了挺多'。"
        ),
        "category": "stable",
    },
    {
        "key": "hook",
        "name": "开头抓人",
        "kind": "lightweight",
        "effect": (
            "第一段必须让读者停下来，而不是滑走。\n"
            "怎么做到（任选其一，禁止'近年来/随着…的发展'式开头）：\n"
            "① 从一个具体瞬间切入：'我第一次注意到这件事，是在…'；\n"
            "② 抛出一个反直觉的事实或数字：'你可能不信，90% 的人…'；\n"
            "③ 直接亮出观点：'这篇文章就一个意思：…'——先给结论再展开；\n"
            "④ 用一个让读者对号入座的问题：'你有没有过这种时刻…'。\n"
            "规则：开头前 50 字内必须出现'具体的名词或数字'（不是'这件事''这个问题'），"
            "并在一段内说明'关你什么事'。写完检查：如果第一段换成任何主题都成立，重写。"
        ),
        "category": "stable",
    },
    {
        "key": "storyteller",
        "name": "故事化",
        "kind": "heavy",
        "effect": (
            "用场景、人物和冲突来讲清道理，而不是抽象论述——让观点长在故事里。\n"
            "方法：\n"
            "① 开头：从一个具体瞬间切入（时间+地点+一个动作），不要背景介绍；\n"
            "② 展开：让一个具体的人（可以是'我'）在情节中做选择，观点由选择的结果带出，"
            "而不是旁白直接说；\n"
            "③ 细节：至少三处五感细节（视觉/听觉/触觉），一处对话或内心独白；\n"
            "④ 转折：故事里要有一次'事情和预想不一样'的转折，这是论证的支点；\n"
            "⑤ 收尾：回到开头的场景形成闭环，点出这个故事想说什么——但用动作或画面收，"
            "不用'这个故事告诉我们'。\n"
            "规则：全文 60% 以上是具体场景叙述，抽象议论只作点睛。"
        ),
        "category": "stable",
    },
    {
        "key": "second_look",
        "name": "二次把关",
        "kind": "heavy",
        "effect": (
            "初稿完成后，切换成最挑剔的读者视角重审一遍，把问题直接改掉再输出最终版。\n"
            "审稿清单（逐项过）：\n"
            "① 第一段能不能抓住人？不能就重写开头；\n"
            "② 有没有哪段读起来像套路/模板？找到并打散结构、换成自己的话；\n"
            "③ 每个论点有没有证据？没有证据的断言要么补例子，要么删；\n"
            "④ 有没有重复说同一件事（只是换了个说法）？合并；\n"
            "⑤ 有没有读者会在中途问'所以呢'？在位置加上一句承接；\n"
            "⑥ 结尾是戛然而止还是自然收束？补一个明确落点。\n"
            "输出要求：直接给出修改后的最终版正文（Markdown），不要说明你改了什么。"
        ),
        "category": "stable",
    },
    {
        "key": "analogy",
        "name": "类比大师",
        "kind": "heavy",
        "effect": (
            "用读者熟悉的概念解释陌生概念，降低理解门槛——一个精准的类比胜过一段抽象解释。\n"
            "方法：\n"
            "① 给每个核心抽象概念配一个生活化类比（如'写作像搭房子：先立梁再填墙'）；\n"
            "② 类比必须与主题强相关且无歧义——先在心里验证'这个类比会不会让读者误解'，"
            "会就换一个；\n"
            "③ 类比后立即点破对应关系（'所以这里的梁就是…'），不留悬念让读者猜；\n"
            "④ 全篇类比不超过 3 个，多了变花哨；其中一个可以是反例类比（'这不像…而像…'）"
            "来澄清边界。\n"
            "规则：每个类比写完自查——如果换成主题词后类比失效，说明它只是修辞不是理解工具。"
        ),
        "category": "stable",
    },
    {
        "key": "counterpoint",
        "name": "先破后立",
        "kind": "heavy",
        "effect": (
            "不回避反方，先把最强的反对意见摆出来，再逐一击破——这样立论才有分量。\n"
            "方法：\n"
            "① 主动设想读者会提出的 2-3 个最强反驳（不是稻草人，要挑真有道理的那种）；\n"
            "② 先完整陈述反方观点（让人感觉'你说得对'），再指出它的适用范围或隐藏前提；\n"
            "③ 用事实/例子/边界条件回应，而不是情绪化反驳；\n"
            "④ 承认反方在某种情况下成立（'如果只考虑短期，确实…'），反而让主体观点更可信；\n"
            "⑤ 最后收束：说明'为什么整体上我的判断仍然成立'。\n"
            "规则：正文中至少有一段以'有人可能会说…'或'我知道有人会反驳…'开头，"
            "并且这段不能是凑数的。"
        ),
        "category": "stable",
    },
    {
        "key": "citation",
        "name": "有据可依",
        "kind": "heavy",
        "effect": (
            "每个可验证的主张都要有出处或可查证的具体信息，让文章经得起追问。\n"
            "方法：\n"
            "① 数字、事实、历史事件：必须带来源线索（书名/文章/机构/年份），"
            "如'《贫穷的本质》里提到的对照实验'，而不是'研究表明'；\n"
            "② 转述他人观点时点名（'哲学家韩炳哲在《倦怠社会》里说'），不匿名；\n"
            "③ 个人经验做论据时明确标注（'我做过一次小样本测试'），与外部事实区分开；\n"
            "④ 自己不确定的地方，诚实写出'这个数据我记不清了，但量级大致是…'；\n"
            "⑤ 优先引用一手来源，二手转述要注明'转引自'。\n"
            "规则：写完自查——把每句断言读一遍，问'这句话如果被质疑出处，我能回答吗'，"
            "答不上就补或删。"
        ),
        "category": "stable",
    },
    {
        "key": "wild_card",
        "name": "随机应变",
        "kind": "lightweight",
        "effect": "启用后每次运行从随机池抽取 2 个 buff 注入——同一主题每次跑出不同味道。",
        "category": "stable",
    },
]

# 随机池条目（被 wild_card / random key 抽取）——扩写版 + 新增
RANDOM_BUFFS: list[dict] = [
    {
        "key": "rand_irony",
        "name": "冷幽默",
        "kind": "lightweight",
        "effect": (
            "穿插一点冷幽默和反讽，但不刻意搞笑。\n"
            "怎么做到：\n"
            "① 用一本正经的语气说荒诞的事（'互联网教你自律，然后卖你手机'）；\n"
            "② 对常见的荒谬现象用'平静地戳破'的方式吐槽；\n"
            "③ 全篇 1-2 处即可，且必须与论点相关——纯抖机灵删掉。\n"
            "避免：网络流行梗、夸张表情符号、自嗨式括号吐槽。"
        ),
        "category": "random",
    },
    {
        "key": "rand_poetic",
        "name": "诗意留白",
        "kind": "lightweight",
        "effect": (
            "在关键处留白，用意象代替直说，让句子有呼吸感。\n"
            "怎么做到：\n"
            "① 最重要的观点不要直接写透，用一句意象收（'雪化了，路就出现了'）；\n"
            "② 句与句之间允许跳跃，不把每个逻辑环节都填满；\n"
            "③ 至少一处用具体物象承载情绪（一盏灯、一扇窗、一段铁轨），而非情绪词；\n"
            "④ 段末留一句短的、可回味的句子。\n"
            "避免：堆砌意象（一段三个隐喻）、为美而美的空话——留白的前提是前面把道理讲清楚了。"
        ),
        "category": "random",
    },
    {
        "key": "rand_edge",
        "name": "挑衅一点",
        "kind": "lightweight",
        "effect": (
            "带一点挑衅和反常识，逼读者重新想——但不冒犯。\n"
            "怎么做到：\n"
            "① 开头先挑战一个普遍默认的认知（'所有人都告诉你…，我认为正好相反'）；\n"
            "② 对流行说法下'温和但明确'的拆台；\n"
            "③ 敢下'过头半格'的结论，然后用论证拉回来；\n"
            "④ 立场鲜明到读者要么同意要么想反驳——这本身是成功的。\n"
            "避免：人身攻击、为反而反、故意唱反调却没有论据。"
        ),
        "category": "random",
    },
    {
        "key": "rand_data",
        "name": "数据支撑",
        "kind": "heavy",
        "effect": (
            "观点尽量落到具体数字、案例或可验证的事实上，减少空泛断言。\n"
            "怎么做到：\n"
            "① 每个核心断言配一个数字或量级（'不是'很多人'，而是'每 10 个里有 7 个'）；\n"
            "② 有对比数字更好（'三年前是…现在是…'）；\n"
            "③ 数字要具体可查证，给出来源线索；\n"
            "④ 没有数据的点，用具体案例（某个人/某件事/某次经历）替代。\n"
            "规则：写完自查——把'很多''大多数''普遍'全部替换成具体数字或案例，"
            "替换不出来的句子删掉。"
        ),
        "category": "random",
    },
    {
        "key": "rand_short",
        "name": "短句冲击",
        "kind": "lightweight",
        "effect": (
            "全部用短句推进，像拳头一下一下打——节奏快、冲击力强。\n"
            "怎么做到：\n"
            "① 平均句长控制在 15 字以内；\n"
            "② 允许单句成段（'就这一句，是全文的题眼'）；\n"
            "③ 删掉从句和连接词堆砌，用句号代替逗号；\n"
            "④ 段落之间用观点的'顿'而不是过渡词的'顺'连接。\n"
            "避免：短到支离破碎——短句之间要靠逻辑钩子咬合。"
        ),
        "category": "random",
    },
    {
        "key": "rand_question",
        "name": "提问式推进",
        "kind": "lightweight",
        "effect": (
            "用提问推动行文——每抛出一个问题，读者就跟着想一步。\n"
            "怎么做到：\n"
            "① 段落开头用一个具体问题代替主题句（'那然后呢？''这件事真的像表面那样吗？'）；\n"
            "② 问题要具体、可思考，不用'你有没有想过'这种空问；\n"
            "③ 问到关键处可以不给答案，留给读者（一次即可）；\n"
            "④ 全篇 2-3 个问题，形成'提问-回答-再提问'的推进链。\n"
            "避免：连续反问堆砌、把问题当填充物。"
        ),
        "category": "random",
    },
]


class BuffService:
    async def _seed(self) -> None:
        """种入内置 buff/debuff 并同步代码版本（AXIOM §1.2 单一真相源）。

        内置以代码为准：新增的插入，已有的 builtin 行同步更新
        name/kind/polarity/effect/category（扩写升级立即生效）；用户自定义不受影响。
        """
        async with session_factory() as session:
            rows = (await session.execute(select(Buff))).scalars().all()
            by_key = {r.key: r for r in rows}
            changed = 0
            all_builtins = [*BUILTIN_BUFFS, *RANDOM_BUFFS, *BUILTIN_DEBUFFS]
            for i, buff in enumerate(all_builtins):
                row = by_key.get(buff["key"])
                polarity = buff.get("polarity", "buff")
                if row is None:
                    session.add(
                        Buff(
                            key=buff["key"],
                            name=buff["name"],
                            kind=buff.get("kind", "lightweight"),
                            effect=buff["effect"],
                            category=buff.get("category", "stable"),
                            polarity=polarity,
                            builtin=True,
                            sort_order=i,
                        )
                    )
                    changed += 1
                elif row.builtin and (
                    row.name != buff["name"]
                    or row.effect != buff["effect"]
                    or row.kind != buff.get("kind", "lightweight")
                    or row.category != buff.get("category", "stable")
                    or row.polarity != polarity
                ):
                    row.name = buff["name"]
                    row.effect = buff["effect"]
                    row.kind = buff.get("kind", "lightweight")
                    row.category = buff.get("category", "stable")
                    row.polarity = polarity
                    changed += 1
            if changed:
                await session.commit()
                logger.info("synced %d builtin buff(s)", changed)

    async def list_buffs(self) -> list[dict]:
        await self._seed()
        async with session_factory() as session:
            rows = (
                (await session.execute(
                    select(Buff).order_by(Buff.category, Buff.sort_order, Buff.created_at)
                )).scalars().all()
            )
            return [self._serialize(r) for r in rows]

    async def get(self, buff_id: UUID) -> dict:
        async with session_factory() as session:
            row = await session.get(Buff, buff_id)
            if row is None:
                raise KeyError(f"buff not found: {buff_id}")
            return self._serialize(row)

    async def create(
        self,
        *,
        key: str,
        name: str,
        kind: str = "lightweight",
        polarity: str = "buff",
        effect: str = "",
        category: str = "stable",
    ) -> dict:
        async with session_factory() as session:
            exists = (await session.execute(
                select(Buff).where(Buff.key == key)
            )).scalar_one_or_none()
            if exists is not None:
                raise ValueError(f"buff key already exists: {key}")
            row = Buff(
                key=key,
                name=name.strip(),
                kind=kind,
                polarity=polarity,
                effect=effect,
                category=category,
            )
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return self._serialize(row)

    async def update(self, buff_id: UUID, **fields) -> dict:
        async with session_factory() as session:
            row = await session.get(Buff, buff_id)
            if row is None:
                raise KeyError(f"buff not found: {buff_id}")
            for key, value in fields.items():
                if value is not None and hasattr(row, key):
                    setattr(row, key, value)
            await session.commit()
            await session.refresh(row)
            return self._serialize(row)

    async def delete(self, buff_id: UUID) -> None:
        async with session_factory() as session:
            row = await session.get(Buff, buff_id)
            if row is None:
                raise KeyError(f"buff not found: {buff_id}")
            await session.delete(row)
            await session.commit()

    # ---------- engine ----------

    async def resolve_effects(self, buff_keys: list[str]) -> list[dict]:
        """buff keys → 注入指令。`random`/`wild_card` 从随机池抽 2 个。

        返回 [{key, name, kind, effect}]——engine 拼进 system prompt。
        """
        await self._seed()
        if not buff_keys:
            return []
        resolved: list[dict] = []
        seen: set[str] = set()
        async with session_factory() as session:
            rows = (
                (await session.execute(
                    select(Buff).where(Buff.enabled.is_(True))
                )).scalars().all()
            )
            index = {r.key: r for r in rows}
        for key in buff_keys:
            if key in ("random", "wild_card"):
                # 从 random 池随机抽 2 个（每次运行不同——肉鸽感）
                pool = [r for r in index.values() if r.category == "random"]
                picks = random.sample(pool, min(2, len(pool)))
                for p in picks:
                    if p.key in seen:
                        continue
                    seen.add(p.key)
                    resolved.append(self._serialize(p))
                continue
            row = index.get(key)
            if row and row.key not in seen:
                seen.add(row.key)
                resolved.append(self._serialize(row))
        return resolved

    @staticmethod
    def _serialize(row: Buff) -> dict:
        return {
            "id": str(row.id),
            "key": row.key,
            "name": row.name,
            "kind": row.kind,
            "polarity": row.polarity,
            "effect": row.effect,
            "category": row.category,
            "enabled": row.enabled,
            "builtin": row.builtin,
            "sort_order": row.sort_order,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }
