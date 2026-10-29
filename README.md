# mood-memory · 心情 + 记忆模块

[![test](https://github.com/<your-name>/mood-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/<your-name>/mood-memory/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mood-memory)](https://www.npmjs.com/package/mood-memory)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)


> 一套给聊天机器人用的「像人」模块：会变的心情 + 记得住事的记忆。
> **零依赖、纯本地、不调模型、不产生 token 成本。**

两个独立模块，可以只用其中一个：

| 模块 | 文件 | 一句话 |
| --- | --- | --- |
| 心情 | `src/mood.js` | 七维情绪 + 总分，会随聊天内容变，说话语气跟着变 |
| 记忆 | `src/memory.js` | 重要的事长期记、日常话题几天淡出，提到核心词才想起来 |
| **游戏接入**（2.0） | `src/terraria.js` | 游戏里发生的事（死了/Boss/挖到宝）写进**同一份**记忆，聊天时接得上话 |
| **游戏技能库**（2.1） | `src/skills.js` | 她在游戏里跟你学来的玩法/窍门，按"游玩端的指令分类"命中，用过就加权 |

> 2.0 起带了游戏接入层：你现在陪她打的那局泰拉，明天在 QQ 里提一句，她记得。
> 2.1 起带了技能库，并把记忆/心情核心与线上桥接**逐条对齐**：自动判重要性、重要条目每日配额、
> 群友印象有寿命、条目写完自动拨心情、容量上限与落盘配额都补齐了。

---

## 目录

- [安装](#安装)
- [为什么需要这两个模块](#为什么需要这两个模块)
- [一、心情系统](#一心情系统)
- [二、记忆系统](#二记忆系统)
- [三、两者怎么配合](#三两者怎么配合)
- [四、接入游戏（泰拉瑞亚）](#四接入游戏泰拉瑞亚)
- [五、接入自己的机器人](#五接入自己的机器人)
- [六、配置说明](#六配置说明)
- [七、自测](#七自测)
- [八、设计取舍](#八设计取舍踩过的坑)
- [九、常见问题](#九常见问题)
- [十、工程结构](#十工程结构)
- [十一、贡献](#十一贡献)

---

## 安装

### 方式一：丢给 DSH 的 agent（推荐）

把整个包（或 zip）发给 DSH 里的 agent，说「装上它」。它会照 `AGENT.md` 自动：

1. 装进 profile（`dsh plugin --profile <profile> add <路径>` 或手动 link）
2. 重启 DSH
3. 跑自检确认

### 方式二：命令行

```bash
dsh plugin --profile desktop add /path/to/mood-memory
```

### 方式三：手动

1. 把文件夹复制到 `~/.dsh/plugins/mood-memory`
2. 编辑 profile 的 `package.json`：

```json
{
  "dependencies": { "mood-memory": "link:/绝对路径/mood-memory" },
  "dsh": { "profile": { "bundles": [ "...", "mood-memory" ] } }
}
```

3. 在 profile 目录执行 `pnpm install`
4. 重启 DSH，日志出现 `[mood-memory] 已加载` 即成功

> 包内 `cordis.patch.yml` 已声明，加载器会自动 insert 一行配置，不需要手动改。

### 方式四：只用模块（不装 DSH）

直接复制 `src/mood.js` 和 `src/memory.js` 到你的项目里，Node 18+ 直接 import：

```js
import { createMemory } from './src/memory.js';
import { scoreEntryMood, applyMoodUpdate, moodPromptLine } from './src/mood.js';
```

---

## 为什么需要这两个模块

普通聊天机器人有两个通病：

| 病 | 表现 | 本包怎么治 |
| --- | --- | --- |
| **没有心情** | 永远热情、永远积极、永远"我很乐意帮你" | 七维情绪 + 总分，会掉会涨，语气跟着变 |
| **没有记忆** | 昨天说的事今天忘，或者反过来乱翻旧账 | 双容器记忆 + 核心词召回，该想起来才想起来 |

两个模块都**不调用模型**，所有判断都是本地规则，所以不花钱、不增加延迟、不依赖网络。

---

## 一、心情系统

### 结构

```
总分 0~100（五档）
  ├─ 欢喜  80~100
  ├─ 平稳  60~80
  ├─ 低落  40~60
  ├─ 沉    20~40
  └─ 闷     0~20

七维情绪（各自独立，0~20）
  开心 / 踏实 / 甜蜜 / 心疼 / 担心 / 难过 / 吃醋
```

### 七维参数一览（1.2.0）

| 维度 | 触发阈值 | 半衰期 | 说明 |
| --- | --- | --- | --- |
| 开心 / 踏实 / 甜蜜 / 心疼 / 担心 / 难过 | 1.5 | 90 分钟 | 加减分统一 ×0.85 |
| **吃醋** | **0.9** | **60 分钟** | 单次 ×2（最多 +2），来得快去得也快 |

> 阈值 = 到这个值才写进提示词去影响语气；半衰期 = 多久衰减一半。

### 核心词（keys）怎么挑

| 给几个词 | 提到其中一个时的召回概率 |
| --- | --- |
| 1 个 | **100%** |
| 2 个 | 50% |
| 3 个 | 33% |

> **核心词别贪多**：命中率 = 命中数 ÷ 总词数。挑 1~2 个最容易被提到的就够了。
> 单字也行（「猫」「茶」「收」），但「的/了/啊/他」这类虚词会被过滤掉。
>
> **撞词会自动加长**：新词和已有条目重复时，会在原文里往左右扩 1~2 个字做出专属词
> （火锅 → 火锅店，生日 → 他生日）。扩不出来就保留原词，不会丢。

**总分决定基础语气，七维决定具体怎么说，但两者都不能越过人设。**

> ⚠️ **人设是底线**：心情只调「长短 / 热度 / 愿不愿意多说」，不改性格、口癖、立场、称呼。
> 心情再低也只能"用角色卡里那种失望法"，不能变成通用 AI 的丧。

### 心情怎么变

| 来源 | 幅度 | 时机 | 成本 |
| --- | --- | --- | --- |
| 条目判分 | 见下方公式 | 每记一条记忆立刻结算 | 0 |
| 骰子随机 | 1→+1.5，6→-1，其它 0 | 每 45 分钟一次 | 0 |
| 模型主动调 | 自己定 | 睡前总结时 | 少量 |
| 自然衰减 | 总分半衰期 12 小时回基线 60 | 持续 | 0 |

### 给分公式（每记一条记忆）

```
最终分 = 0.7 × 模型判断（按人设，-10~+10 归一化到 -1~+1）
       + 0.3 × 本地好坏词判断（-1~+1）

幅度 = 扔骰子决定
        点数越小 → 幅度越小
        点数越大 → 幅度越大
        加分区间 5~8 分，扣分区间 3~5 分
        再按信号强度缩放（弱信号不会被放大）
```

**为什么是 0.7 / 0.3**：让模型（懂人设）主导判断，本地词表只做兜底和纠偏，避免纯词表的误判。

实测：

| 条目 | 模型分 | 词表分 | 合成 | 骰子 | 实际变化 |
| --- | --- | --- | --- | --- | --- |
| 他夸我这次画得真好看 | 8 | 1.00 | 0.86 | 3 | **+5.8** |
| 他骂我画得丑还嫌我事多 | -8 | -1.00 | -0.86 | 5 | **-4.3** |
| 他记得我说过的细节 | 6 | 1.00 | 0.72 | 6 | **+6.9** |
| 他两天没回我 有点敷衍 | -5 | -1.00 | -0.65 | 6 | **-4.1** |
| 今天天气不错 | 0 | 0 | 0 | — | 0（不动） |

模型可以通过 `extra.moodScore`（-10~+10）传入自己的判断；不给就用本地词表顶替。

### 七维各管什么

每根情绪超过 **1.5** 就会变成一条具体的行为指令，拼进提示词，**优先级高于档位**：

| 情绪 | 行为倾向 |
| --- | --- |
| 开心 | 主动多说一句、接梗、语气轻快、愿意分享 |
| 踏实 | 说话笃定不飘、愿意明确接下来 |
| 甜蜜 | 语气软、语气词多、可以一点点撒娇 |
| 心疼 | 问对方还好吗、别硬撑；主动关心但不连环追问 |
| 担心 | 多确认一句「真的没事吗」「到了说一声」 |
| 难过 | 话少、只回一两个字、不接梗、可以冷 |
| 吃醋 | 带刺、阴阳、酸话、故意不在意 |

**实测（总分都是 60，只有情绪不同，同一句「他说今天有点累 想早点睡」）**：

| 情绪 | 回的话 |
| --- | --- |
| 心疼 | 那早点睡吧 别撑着 晚安 |
| 担心 | 那你早点睡吧 到了跟我说一声 |
| 难过 | 嗯 那你早点睡吧 |
| 吃醋 | 哦 那你去睡呗 反正也不差这一会儿 |
| 甜蜜 | 那你快去睡吧 别硬撑着哦 晚安啦 |
| 开心 | 那你快去睡吧 我正好把那张画收个尾 |
| 踏实 | 那早点睡吧 明天有精神了再说 |
| 无情绪 | 嗯 那你早点睡吧 我也去画会儿画 |

同分不同话 —— 这就是七维存在的意义。

### 衰减规则

| 对象 | 半衰期 | 效果 |
| --- | --- | --- |
| 总分 | 12 小时 | 隔一夜还留着余温，第三天基本归零 |
| 单维情绪 | 90 分钟 | 只有最近发生的事才有情绪，不会一直记着 |

**没有衰减，心情会一直贴顶，等于没有心情。**

### 四道闸（防止心情乱飘）

```
① 显著：涨跌 >= 3 才算（自动判分的路径跳过这条，因为骰子已限制幅度）
② 可信：置信度 >= 60
③ 额度：一天最多 10 次（条目自动判分不占这个额度）
④ 去重：同样的理由一天只算一次
```

### 提示词长什么样

```
【你现在的心情】总心情 72/100，档位「平稳」（当下最明显的是：甜蜜2、踏实1.8）
怎么说话：正常状态：10~20 字，有事说事，不冷不热。这条要求字数也要照做（10~20 字）。
现在的情绪（这几根在起作用，要照做）：
· 甜蜜 2：有点被哄软了：语气可以软一点、多用语气词，允许一点点撒娇，但别腻。
· 踏实 1.8：心里是稳的：说话笃定、不飘，答应的事愿意明确接下来，不敷衍。
优先级：档位给的是基础语气，具体情绪优先于档位——两者冲突时，按上面那几条情绪指令做。
语气权重 60%：心情影响的是"这句话的语气强弱"（60%），不是"你是谁"——人格永远 100% 按角色卡来。
```

---

## 二、记忆系统

### 双容器

| 容器 | 默认上限 | 衰减 | 放什么 |
| --- | --- | --- | --- |
| `importantTopics` | 100 条 | 永不按时间删（权重保底 70%） | 重大事件 / 心情剧变 / 约定约束 |
| `activeTopics` | 80 条 | 阶梯衰减，约 4 天淡出 | 日常话题 |

### 权重公式

```
普通条目：权重 = 时间系数 × 0.8
重要条目：权重 = max(0.7, 时间系数)     ← 有保底
```

| 距今天数 | ≤1 天 | 2 天 | 3 天 | 4 天 | 更早 |
| --- | --- | --- | --- | --- | --- |
| 时间系数 | 1.0 | 0.8 | 0.6 | 0.5 | 0（删除） |

### 三条核心规则

**① 重复就加权**

同一件事说第二遍不会新增条目，只加 `mentions`；说够 **3 遍**自动升级成重要事。

**② 核心词召回（重点）**

每条记忆自动抽「核心词」：

```
「管理员 2026-10-26 完成了《山海旧事》」→ keys: ["山海旧事"]
「云边小馆里那间茶馆」                → keys: ["云边小馆 茶馆"]（词组）
```

聊天里**提到这些词**才唤起：

| 聊天里说的 | 结果 |
| --- | --- |
| 山海旧事写完了吗 | ✅ 唤起（1 个 key，100%） |
| 云边小馆更新了吗 | 🎲 50%（2 个 key 只中 1 个） |
| 云边小馆那个茶馆 | ✅ 100%（2 个 key 全中） |
| 管理员今天在吗 | ❌ 不唤起（称呼不算核心词） |
| 2026年10月26日 | 🎲 50%（只提到时间） |
| 今天天气不错 | ❌ 不唤起 |

规则细节：

- **多个 key 是「或」关系**（任一命中即唤起）
- **词组内部是「与」关系**（空格分隔的词全部出现才算命中）
- 时间类用纯数字串比对（`11月8号` = `118` = `11-8`）
- 称呼类词（管理员/群主/老板/主人…）永远不会被当成核心词

**③ 过期约定优先淘汰**

重要容器满了以后，淘汰顺序：

```
① 已过期的约定/约束（越早过期越先走）
② 权重最低
③ 最久没提
```

「约好 2026-10-11 交画稿」在 2027 年会被第一个踢出去，而不是挤掉上周刚发生的「家人住院」。

约定识别词：`约定 答应 说好 约好 保证 承诺 不许 必须 期限 截止 下周三 下个月 明天 后天 下周 月底 年底`

### 提示词长这样

```
【重要的事】（标了 important，长期记得）
- 他家人住院了，要做手术（2小时前）
- 答应了下周三之前把稿子改完（昨天）·80%
- …另有 4 条较早的重要事件：…（要细节用 memory.list）

【近期的话题】（越靠前记得越牢）
- 语音语速调到 0.83（3小时前）

【游戏技能】（学过、能直接照做的操作）
- 泰拉瑞亚·深层资源探索：先找洞道再往下挖，别在浅层刨土〔深层资源探索 / 挖矿 / 探索〕·用过2次·动作=探索

【你想说但还没说的】
- 想问问他书稿进度（curiosity）

【对群友的印象】
- 阿橙：嘴硬心软、爱抬杠（重要）·80%（互动 4 次）
```

每条带**时间标记**（12分钟前 / 3小时前 / 2天前）和**权重标记**（·80%，只在不满 100% 时显示），超过 6 小时的还会标「已搁置」；带 `pendingQuestion` 的条目尾巴上会跟「；待追问：…」。

### 召回策略

不是把所有记忆都塞进提示词，而是：

```
核心词命中 → 必带（最多 showTopics 条）
只命中时间 → 50% 概率带
都没命中   → format() 里按权重补 4 条打底（recallBackfill）
```

> 直接调 `mem.recall(list, ctx)` **默认不兜底**（`always` 默认 0，和线上一致）；要打底就显式传 `{ always: 4 }`。
> `mem.format()` 已经按 `recallBackfill` 传好了，日常用 format 就行。

**记忆越多，这套机制省得越多**——旧话题不会被无关的聊天带出来。

### 2.1 补上的三条记忆规则

| 规则 | 默认值 | 为什么 |
| --- | --- | --- |
| **自动判重要性** | 打分 ≥3 进「重要的事」，≥1 算"maybe"，日常琐事扣分 | 约定/纪念日/住院这类事，用户不会专门去标 `important`；不判就会被 3~4 天后的衰减清掉 |
| **重要条目每日配额** | `maxImportantPerDay = 10` | 热闹的一天不会把重要池冲满：超出的**不是拒收**，而是把当天最弱的降级回普通话题 |
| **群友印象有寿命** | `maxTraits = 15`、`maxPeople = 10` | 印象只增不减会变成一坨；老的按权重淘汰、长期不聊的人自动清掉 |

自动判重要性只认"重大事件 / 心情剧变 / 约定约束"，出差、吃饭、上班这类日常安排**不算**——
想强制指定，传 `important: true`（强制重要）或 `important: false`（强制当普通）。

### 游戏 key（2.0）

一条记忆除了自己的核心词，还可以额外挂一个**游戏 key**，内容就是游戏名：

```js
mem.append(st, 'activeTopic', '和老李打蜂王，被秒了两次', {
  keys: ['蜂王'],          // 具体到"哪件事"
  gameKey: '泰拉瑞亚'      // 归属到"哪个游戏"
});
```

于是聊天里只要提到这个游戏名，**所有带这个 key 的条目一起加权、一起更容易被想起来**：

```
说「泰拉瑞亚还更新吗」→ 命中度 1.0，权重 ×1.5，必被召回
说「泰拉玩不玩」      → 只说了简称，命中度 0.57 → 仍给 80% 保底概率
说「今晚吃什么」      → 不命中（不会因为挂着游戏名就被硬带出来）
```

两条规则：

| 规则 | 数值 | 为什么 |
| --- | --- | --- |
| 提到游戏名 → 权重乘 | `GAME_KEY_BOOST = 1.5` | 排序和兜底回填时，这一局的记忆排在前面 |
| 仅靠游戏名召回的概率 | `GAME_KEY_PROB = 0.8`（命中度更高时按命中度） | 不是必中：一嘴游戏名不该把整本流水账倒出来 |

匹配用的是和核心词一样的容错逻辑（2-gram），所以「泰拉瑞亚」在只说了「泰拉」时也能拿部分分。
不想用这套行为？不传 `gameKey` 就行，老数据完全不受影响。

**2.1 起 `tags` 也算游戏 key**：上线版给游戏记忆打的是 `tags: ['泰拉瑞亚', …]`（没有 `gameKey` 字段），
这个包也能读——上下文提到标签里的任何词，这些条目一样加权、一样被召回。两套数据可以混着用。

---

## 三、两者怎么配合

```
聊天中  → 记一条记忆 → 判好坏（0.7 人设 + 0.3 词表）→ 骰子定幅度
        → 心情变 → 分到七维 → 下次说话语气跟着变
        ↓
睡前总结 → 记 1~3 条 + 调一次心情 → 进入休眠
        ↓
休眠一段时间 → 清上下文（记忆和心情都保留）
        ↓
下次唤醒 → 记忆按核心词召回 + 心情带进语气 → 像刚想起来一样接着聊
```

一句话：**记忆决定「她知道什么」，心情决定「她怎么说话」。**

---

## 四、接入游戏（泰拉瑞亚）

**2.0 新增。** 给聊天机器人配个"会玩游戏的伴儿"，难点不在操作，在**记忆**：
打输的那场、说好下次再来的那个 Boss、昨晚死了五次的地方 —— 游戏里发生的事得进**同一份记忆**，
她才能在 QQ 里接上话。这一层就是干这个的。

```
游戏（tModLoader 模组 / 任何能写状态文件的游戏）
  │  每 100ms 写 state.json（玩家 / 她 / 附近怪 / 事件）
  ▼
src/terraria.js  ← 你在这里：状态 → 事件 → 记忆（顺带拨心情）
  │  memory.append() / applyMoodUpdate()
  ▼
她的提示词（和聊天共用同一份记忆、同一个会话语境）
  ▲
  │  cmd.json（idle / follow / attack / come / mine / say）
  └── 她的决定 → 游戏里的手和脚
```

三条硬规矩（写在代码里，不靠自觉）：

| 规矩 | 实现 |
| --- | --- |
| **记忆只有一份** | 游戏事件写进**聊天那个 state 对象**（同一个会话 key），不复刻第二套 |
| **她只做慢决策** | 动作白名单 `idle/follow/attack/come/mine/say`，传"往左走三格"直接抛错 |
| **记忆不是日志** | 同类事件有冷却、每小时有上限，写太密会把真正的记忆挤掉 |
| **一提游戏名就想起来** | 每条游戏记忆都带 **游戏 key**（= 游戏名）：聊天里提到「泰拉瑞亚」，这些条目一起加权、更容易命中 |

### 先看效果（不用装游戏）

```bash
npm run demo:game
```

```
▶ 蜂王刷出来了
  【泰拉】老李在地下丛林 血 90/100 祀 100/120（跟着你）
  ✎ 记了一条：地下丛林刷出了蜂王，和老李一起打　〔蜂王〕

▶ 被打死
  【泰拉】老李在地下丛林 血 0/100 祀 100/120（跟着你） （你刚死了）
  ✎ 记了一条：和老李在地下丛林玩，老李被打死了　〔地下丛林〕

▶ 重来一次，这回赢了
  ✎ 记了一条：和老李一起打赢了蜂王　〔蜂王〕   ← 自动进「重要的事」，长期记得
```

下一轮聊天，她的提示词里就长这样（和日常聊天共用）：

```
【重要的事】（长期记得）
- 和老李一起打赢了蜂王（刚刚）
【近期的话题】
- 地下丛林刷出了蜂王，和老李一起打（刚刚）
- 和老李在地下丛林玩，老李被打死了（刚刚）
```

而且你**不用复述细节**：只要提一句「泰拉瑞亚」（或者「泰拉」），上面这些带游戏 key 的条目会一起加权、
一起更容易被翻出来 —— 见上一节的 [游戏 key](#游戏-key20)。

### 怎么用

```js
import { createMemory, createTerrariaCompanion } from 'mood-memory';

const memory = createMemory({});
const state = {};                                        // 记忆 + 心情都挂这上面
const companion = createTerrariaCompanion({ memory, state });

// 每一帧（10Hz 就够）喂状态快照
const r = companion.ingest(snapshot);
r.promptLine;   // 【泰拉】老李在地下丛林 血 78/100 祀 92/120（跟着你）附近 3 只怪：蝙蝠×2
r.entries;      // 这一帧新写进记忆的条目（没有就是空数组）

// 她要动手时：拿到指令对象，你负责写进 cmd.json
companion.command('attack', { targetIdx: 3 });   // → { seq, action, targetIdx, say, expireMs }
```

也可以只拿纯函数自己拼：

```js
import { classify, eventToEntry, promptLine } from 'mood-memory/game';

const events = classify(prevFrame, nextFrame);   // 死亡 / 低血 / Boss / 入夜 / 换地形 / 挂机
const entry = eventToEntry(events[0]);           // → { category, content, extra, mood }
const line = promptLine(nextFrame);              // 压成一行，省 token
```

### 状态文件（游戏写、我们读）

```jsonc
{
  "ts": 1793171818057,
  "inGame": true,
  "day": true,
  "player": { "name": "老李", "hp": 78, "maxHp": 100, "tileX": 1203, "tileY": 420,
              "biome": "地下丛林", "dead": false },
  "shi":    { "active": true, "hp": 92, "maxHp": 120, "state": "follow" },
  "nearby": [{ "name": "蝙蝠", "hp": 30, "dist": 9, "hostile": true }],
  "events": [{ "kind": "bossSpawn", "name": "蜂王", "at": 1793171817000 }]   // 增量，读走就清
}
```

- `events` 里能写 `playerDied / bossSpawn / bossDefeated / foundLoot`，这几个比"猜"准
- 其余靠前后两帧对比推：血量跌破 30%、白天进夜晚、换地形、挂机
- 写盘请"先写 `.tmp` 再改名"：读到半截文件会被当成"这帧不算"，不影响下一帧

### 指令文件（她写、游戏读）

```jsonc
{ "seq": 12, "action": "follow", "targetIdx": -1, "say": "", "expireMs": 8000 }
```

`seq` 递增，同一条重复读到不会重复执行；`expireMs` 过期后游戏侧应该丢掉。

### 游戏技能库（2.1）

游戏里"发生过的事"进记忆（上面的 `classify` / `eventToEntry`），**"学到的本事"进技能库**——两者是两回事：

| | 记忆条目 | 技能 |
| --- | --- | --- |
| 记的是 | 发生过的事（阵亡、打赢 Boss） | 学到的做法（怎么挖矿、怎么躲史莱姆） |
| 淡出 | 3~4 天后衰减（除非 important） | **不按时间淡出**（本事不该忘），只按用过没有 + 容量淘汰 |
| 命中 | 核心词 / 时间 / 游戏名 | 游玩端的**情境**（地形+血量+怪+想干什么） |
| 存放 | `st.activeTopics` / `st.importantTopics` | `st.gameSkills`（同一个状态对象，不是另一个库） |

```js
import { createMemory, appendGameSkill, matchGameSkills, formatGameSkills, markGameSkillUsed } from 'mood-memory';

const memory = createMemory({});
const st = {};                                   // 记忆 + 心情 + 技能都挂这一个 state 上

// 她（或你）从聊天里学到一条玩法：记成技能
appendGameSkill(st, '对着矿脉长按左键，矿石会进独立背包', {
  skill: '采矿', keys: ['矿脉', '镐子'], action: 'mine'
});
// → keys 变成 ['采矿', '矿脉', '镐子']，action 'mine'

// 游玩端按当下情境查（中文整句就行，不用切词）
const hit = matchGameSkills(st, { q: '地下丛林 血42/100 附近3只史莱姆 想挖矿', limit: 3 });
// → [{ skill: '采矿', text: '…', score: 1, action: 'mine', actionName: '采矿' }]

// 真执行了就记一笔（用得多的排前面、也不容易被淘汰）
markGameSkillUsed(st, { skill: '采矿' });

// 拼进提示词（format 会自动带上，也可以单独拼）
formatGameSkills(st, { context: '想挖矿' });
```

**指令分类（游玩端发的就是这套）**——`action` 填英文或中文都行，不填会按技能名/keys 自动推断；
分类名会自动进 key，所以查询里出现"挖矿/跟随/过来"这类词就能直接命中：

| 分类 | 中文名（自动进 key） | 同义说法（只参与打分） |
| --- | --- | --- |
| `idle` | 待机 | 等待 / 停下 / 别动 |
| `follow` | 跟随 | 跟着 / 跟上 / 跟紧 |
| `explore` | 探索 | 探路 / 探险 / 找路 / 开图 |
| `attack` | 攻击 | 战斗 / 打怪 / 迎战 / 反击 |
| `come` | 回来 | 过来 / 召回 / 靠近 |
| `mine` | 采矿 | 挖矿 / 采掘 / 矿脉 / 矿石 |
| `dig` | 下挖 | 挖洞 / 挖通道 / 挖地道 |
| `chop` | 伐木 | 砍树 / 砍木头 / 伐树 / 木材 |
| `recall` | 回程 | 回城 / 回出生点 / 回老家 |
| `craft` | 制作 | 合成 / 打造 / 做东西 / 工作台 |
| `place` | 放置 | 摆放 / 建造 / 盖房 |
| `chest` | 箱子 | 开箱 / 宝箱 / 容器 |
| `use` | 使用 | 用道具 / 用物品 / 吃药 |
| `say` | 说话 | 台词 / 对话 / 聊天 |

打分的口径（`score` 0~1，建议 `>= 0.5` 当"确定会"、`0.3~0.5` 当"可以试试"）：

```
指令分类名（采矿/跟随…）1.0  >  同义说法（挖矿/过来…）0.85  >  英文动作（q 里带的 mine/follow）0.8
> 主 key 命中 1.0  >  整串命中  >  分词  >  中文 2-gram  >  单字兜底
```

技能库容量默认 80 条，超了淘汰"用得最少、且最久没用"的。

> 想"这一局只用技能库里学过的做法"：把 `matchGameSkills()` 的结果当执行约束喂给决定动作的那一层，
> 没命中就安静，别硬编一条——技能库空着是正常的，等她学会。

### 游戏记忆的标签（2.1）

上线版给每条游戏记忆打标签（`tags` / `gameId` / `narrator` / `gameTopicId`），这样：
聊天里提到「泰拉瑞亚」时，除了核心词召回，还能按标签把相关经历补回来，而且**同一件事只写一条、只结算一次心情**。

```js
import { appendGameMemory, gameMemoryReceipt, formatGameMemoryTags } from 'mood-memory';

// 游戏端给的稳定 id：topicId = 同一段经历，eventId = 这一次事件
appendGameMemory(memory, st, '和老李一起打赢了蜂王', {
  gameTopicId: 'terraria:ep-20261030-1',
  gameEventId: 'ev-0007',
  tags: ['Boss'],
  keys: ['蜂王'],
  important: true
}, { save: persist });

// 同一个事件重投：只补标签，不重复写、不重复结算心情
// 同一段经历的第二个事件：gameOccurrences +1，正文写「共 2 次」，也不再结算心情

gameMemoryReceipt(st, { topicId: 'terraria:ep-20261030-1', eventId: 'ev-0007' });
// → { retained: true, eventRecorded: true, occurrences: 2, tags: ['泰拉瑞亚','Boss'], settlementCount: 1 }

// 拼提示词时：行内补【标签：…】，并在提到游戏名时按标签补一段
formatGameMemoryTags(st, memory.format(st, ctx), { context: ctx });
```

### 调参与限流

```js
createTerrariaCompanion({
  memory, state,
  opts: {
    game: '泰拉瑞亚',          // 游戏 key 的内容：聊天提到它，这套记忆一起加权
    lowHpRatio: 0.3,          // 血量低于 30% 才提醒
    idleMs: 5 * 60 * 1000,    // 5 分钟不动 → 想问一句"还玩不玩了"
    maxEventsPerHour: 20,     // 一小时最多写 20 条（记忆不是日志）
    cooldowns: { playerDied: 10 * 60 * 1000, bossSpawn: 30 * 60 * 1000 },
    importantOnBossWin: true, // 打赢 Boss 自动标「重要的事」
    mood: true                // 事件顺带拨心情；关掉就只记记忆
  }
});
```

### 真机接入

`examples/terraria-bridge.mjs` 是现成的循环：盯 `state.json` → 写记忆 → 需要时往 `cmd.json` 丢指令。

```bash
node examples/terraria-bridge.mjs \
  --state "%USERPROFILE%\Documents\TerrariaCompanion\state.json" \
  --cmd   "%USERPROFILE%\Documents\TerrariaCompanion\cmd.json" \
  --save  memory-state.json
```

**游戏侧只要写两件事**：每 100ms 写 `state.json`、每 100ms 读 `cmd.json`。
tModLoader 那边一个 `ModSystem` 就够，所有 I/O 记得 `try/catch` —— 桥接挂了不能影响游戏。

> 不是泰拉也行：任何能把"发生了什么"写成 JSON 的游戏（Minecraft、星露谷、饥荒）都能接，
> 换一下 `classify()` 的字段映射就行。

---

## 五、接入自己的机器人

### 最小可用例子

```js
import { createMemory } from 'mood-memory/memory';
import { scoreEntryMood, applyMoodUpdate, moodPromptLine, snapshot } from 'mood-memory/mood';

// 1) 建记忆实例
const mem = createMemory({
  limit: (name, def) => config.memory[name] ?? def,   // 你的配置读取
  log: console.log
});

// 2) 会话状态（自己存，随便什么结构）
const st = {
  activeTopics: [], importantTopics: [], pendingThoughts: [], memberImpressions: {},
  mood: { total: 60, dims: {}, updatedAt: Date.now(), updates: [], history: [] }
};

// 3) 记一条记忆
mem.append(st, 'activeTopic', '他夸我画得好看', {
  keys: ['画'],          // 核心词，自己挑；不传则自动抽书名号内容
  important: false       // 是不是重大事件
});

// 4) 立刻结算心情
const s = scoreEntryMood('他夸我画得好看', 8);   // 8 = 模型按人设给的分（-10~10）
if (s.delta) {
  applyMoodUpdate(st, {
    moodDelta: s.delta,
    dims: { 开心: 3, 甜蜜: 1 },
    reason: '被夸',
    confidence: 85
  }, Date.now(), { countsQuota: false, skipSignificance: true });
}

// 5) 拼系统提示词
const prompt = mem.format(st, 最近几条聊天文本) + '\n\n' + moodPromptLine(st, 0.6);
```

### 三种记忆类别

```js
mem.append(st, 'activeTopic', '内容', { keys: [...], important: true });
mem.append(st, 'pendingThought', '想问问他书稿进度', { motivation: 'curiosity', expiresAtMs: 7200000 });
mem.append(st, 'memberImpression', '嘴硬心软、爱抬杠', { target: '阿橙', important: true });
```

### 定期调用 age()

```js
setInterval(() => mem.age(st), 10 * 60 * 1000);
```

它负责：普通话题按权重淘汰、重要容器超容量时按「过期约定 → 低权重 → 最久没提」淘汰、清过期想法。

### 其他可用方法

| 方法 | 用途 |
| --- | --- |
| `mem.relevance(entry, ctxText)` | 判断某条记忆在当前上下文里是否命中（返回 kind/prob） |
| `mem.recall(list, ctx, always)` | 按上下文筛选记忆列表 |
| `mem.topByWeight(list, n)` | 按权重取前 N 条 |
| `mem.isExpired(entry)` / `mem.deadlineOf(entry)` | 判断约定是否过期 |
| `activeDimEffects(dims)` | 拿到当前生效的情绪指令 |
| `snapshot(st)` | 拿到心情快照（total/band/dims/effects） |

---

## 六、配置说明

### 记忆

```json
"memory": {
  "maxImportantTopics": 100,
  "maxImportantPerDay": 10,
  "maxTopics": 80,
  "maxPeople": 10,
  "maxTraits": 15,
  "maxThoughts": 20,
  "maxGameSkills": 80,
  "recallBackfill": 4,
  "showTopics": 10,
  "showThoughts": 10,
  "showPeople": 10,
  "showGameSkills": 6,
  "age": {
    "minWeight": 0.4,
    "importanceFactor": 0.8,
    "importantFloor": 0.7,
    "oldKeepTraits": 0,
    "keepImportant": true
  }
}
```

> 说明：普通话题在 `append` 时按 `maxTopics`（默认 20）裁，落盘时按 `maxTopicsSave`（默认 80）裁；
> 重要条目按 `maxImportantTopics`（默认 50）裁、每天最多新增 `maxImportantPerDay` 条。
> 所有数值都会做 `1~500` 的夹取，配 0 或 9999 都不会把提示词撑爆。

### 心情

```json
"mood": {
  "enabled": true,
  "toneWeight": 0.6,
  "autoPerEntry": true,
  "dice": {
    "enabled": true,
    "intervalMinMs": 2700000
  }
}
```

### 调参建议

| 想要 | 改什么 |
| --- | --- |
| 心情变化更明显 | `toneWeight` 调高（0.8）；或提高给分幅度 |
| 心情更稳定 | `toneWeight` 调低（0.4）；或把半衰期改短 |
| 记忆更牢 | 提高 `importantFloor`、降低 `minWeight` |
| 记忆更省 token | 降低 `showTopics` 和 `recallBackfill` |
| 少一点随机 | 关掉 `dice.enabled` |

---

## 七、自测

```bash
node bench/test-memory.mjs       # 记忆核心行为 62 项（纯本地）
node bench/bench-recall.mjs      # 召回 51 个样本（纯本地）
node bench/bench-evict.mjs       # 过期约定识别（纯本地）
node bench/bench-dice.mjs        # 骰子分布 + 14 天漂移（纯本地）
node bench/test-terraria.mjs     # 游戏接入 65 项（纯本地，不用装游戏）
node bench/test-skills.mjs       # 游戏技能库 46 项（纯本地）
node bench/test-mood-entry.mjs   # 条目自动结算心情 24 项（纯本地）
node bench/bench-mood.mjs        # 心情 20 个测试点（需 DEEPSEEK_API_KEY）
node bench/bench-dims.mjs        # 七维对比（需 DEEPSEEK_API_KEY）
node bench/sim-14d.mjs           # 14 天模拟
node bench/sim-30d.mjs           # 30 天模拟
```

> 需要 `DEEPSEEK_API_KEY` 的两个脚本，没设环境变量时会打印 `(HTTP 401)` 并继续，不会崩。

跑过的基准结果（参考）：

```
记忆行为      62/62（容量上限 / 自动重要性 / 每日配额 / 印象寿命 / 脱敏 / CRUD / 落盘配额）
游戏接入      65/65（事件识别 / 冷却限流 / 指令白名单 / 坏文件不崩 / 游戏 key 召回 / 标签与事件去重）
游戏技能库    46/46（指令分类进 key / 中文动作 / 自动推断 / 英文动作命中 / 容量淘汰）
条目结算心情  24/24（好坏判定 / 分维 / 不占额度 / 跳过显著闸门 / 兼容导出）
记忆召回      51/51 = 100%（必中 15/15、半概率 16/16、不该中 17/17、时间 3/3）
过期约定      第一条被淘汰的永远是过期约定 ✅
骰子分布      1 万次，每点 16%~17%，平均 +0.083 分
14 天模拟     均值 67~73，85+ 占 3~9%，95+ 占 0.6~1.2%
30 天模拟     均值 70.4，85+ 占 1.5%，95+ 占 0%，<40 占 0%
```

最后两行说明：**有起伏、不贴顶、不掉底**——这是心情系统健康的标志。

---

## 八、设计取舍（踩过的坑）

| 坑 | 现象 | 结论 |
| --- | --- | --- |
| 心情每轮都判 | 判断太频繁，质量不稳 | 改成**按条目判 + 骰子补随机** |
| 步长太大 | 长期贴在 95+，等于没有心情 | +5~8 / -3~5 配 12h 半衰期 |
| 强行"被骂不许掉心情" | 不真实，用户能感觉出来 | 删除，被惹也照扣 |
| 一次注入 10 条记忆 | 浪费 token 且容易跑题 | 改成**核心词召回 + 4 条打底** |
| 重要条目按"最久没提"淘汰 | 会把过期约定留住、把新大事挤掉 | 改成**过期约定优先** |
| 词组 key 当一个长串匹配 | 永远匹配不上 | 改成**拆词，全部出现才算命中** |
| 归一化时把「日」当日期符号 | 「生日」被削成「生」 | 只剥标点，日期用数字串比对 |
| 日期补零不一致 | `11月8号` 匹配不到 `11-08` | 补零/不补零两种都存 |
| 七维只记录不生效 | 心情一样、说话一样 | 每维配一条**行为指令**，情绪优先于档位 |
| 条目自动判分占用模型额度 | 模型自己调不动心情了 | 自动判分**不占额度** |
| 条目扣分被"显著 ≥3"拦掉 | 小扣分完全无效 | 自动路径**跳过显著性闸门** |

---

## 九、常见问题

**Q：会花很多 token 吗？**
A：不花。两个模块都是纯本地计算。只有把生成的提示词塞进对话时才消耗正常 token，那段大约 150~300 tokens。

**Q：能只用记忆不用心情吗？**
A：可以，两个文件互不依赖，只 import `memory.js` 就行。

**Q：支持英文吗？**
A：核心词/日期/称呼过滤是为中文设计的。英文内容可以存取，但召回效果会差一些。

**Q：数据存哪？**
A：模块本身不落盘，所有状态都在你传进去的 `st` 对象里，你自己决定存哪（JSON/SQLite/Redis 都行）。

**Q：记忆会无限膨胀吗？**
A：不会。普通话题 4 天淡出，重要容器有上限且按优先级淘汰，想法有有效期。

**Q：为什么心情基线是 60 不是 50？**
A：60 是「平稳」，让人默认处于略偏正面的状态：向上到 80「欢喜」只需两次好事，向下到 40「低落」需要更多坏事——符合真人情绪的不对称性。


---

## 独立小窗（看心情和记忆）

包里带了一个零依赖的本地查看器，不用改任何代码就能看效果：

```bash
node tools/viewer/server.mjs --file tools/viewer/demo-state.json --open
```

它会启动一个本地页面（默认 3310 端口），显示：

- 心情总分 + 档位 + 七维（到阈值的会高亮）
- 重要条目 / 普通条目（内容、核心词、提过几次、多久前）
- 群友印象（每人几条属性、互动次数）

数据来源就是你导出的一个 JSON，格式见 [tools/viewer/README.md](./tools/viewer/README.md)：

```json
{
  "conversations": {
    "private:10001": {
      "mood": { "total": 76.4, "dims": { "开心": 3.1, "吃醋": 0.9 } },
      "memory": {
        "importantTopics": [{ "text": "...", "keys": ["稿子"], "mentions": 3 }],
        "activeTopics": [],
        "memberImpressions": { "阿橙": { "traits": ["嘴硬但心软"] } }
      }
    }
  }
}
```

## 十、工程结构

```
mood-memory/
├── src/
│   ├── index.js      统一出口
│   ├── mood.js       心情系统，参数集中在顶部 DEFAULTS
│   ├── memory.js     记忆系统，工厂函数 createMemory()
│   ├── terraria.js   游戏接入层（2.0）：状态 → 事件 → 记忆 / 指令；2.1 补了记忆标签与事件去重
│   └── skills.js     游戏技能库（2.1）：学到的本事 + 指令分类命中
├── lib/index.js      DSH 插件入口（只挂载，不放规则）
├── examples/
│   ├── demo-terraria.mjs    离线演示（不用装游戏，npm run demo:game）
│   └── terraria-bridge.mjs  真机循环：盯 state.json、写 cmd.json
├── bench/
│   ├── run-all.mjs        测试运行器（失败返回非 0，CI 用）
│   ├── test-memory.mjs    记忆行为 62 项
│   ├── test-terraria.mjs  游戏接入 65 项
│   ├── test-skills.mjs    游戏技能库 46 项
│   ├── test-mood-entry.mjs 条目结算心情 24 项
│   ├── bench-recall.mjs   召回 51 样本
│   ├── bench-evict.mjs    过期约定识别
│   ├── bench-dice.mjs     骰子分布
│   ├── bench-mood.mjs     心情 20 点（需 API key）
│   ├── bench-dims.mjs     七维对比（需 API key）
│   └── sim-14d / sim-30d  多天模拟
├── cordis.patch.yml  DSH 加载器自动 insert
├── AGENT.md          给 agent 的安装说明
├── README.md / CONTRIBUTING.md / CHANGELOG.md / LICENSE
└── .github/workflows/ci.yml
```

**设计约束**（提 PR 前请确认）：

- 零运行时依赖
- 不调用任何模型 API（需要模型判断的地方由调用方注入 `modelScore`）
- 可调参数必须写进 `DEFAULTS`，不散落魔法数字
- 每个公开函数都有 JSDoc

### 改行为改哪里

| 想改 | 位置 |
| --- | --- |
| 心情基线 / 衰减速度 | `DEFAULTS.baseline` / `halfLifeTotalMs` / `halfLifeDimMs` |
| 加减分幅度 | `DEFAULTS.gainRange` / `lossRange` |
| 模型与词表的权重 | `DEFAULTS.modelWeight` / `wordWeight` |
| 骰子表 | `DEFAULTS.diceTable` |
| 各维行为指令 | `DIM_EFFECTS` |
| 记忆容量 / 召回条数 | 传给 `createMemory` 的 `limit()` |
| 衰退曲线 | `createMemory({ age: { ... } })` |
| 什么算"重要的事" | `IMP_HIGH` / `IMP_LOW`（`src/memory.js`） |
| 写记忆顺手拨心情 | `createMemory({ settleMood })` + `settleEntryMood()` |
| 有哪些游戏事件 | `classify()` |
| 事件写成什么话 | `eventToEntry()` |
| 游戏状态的提示词 | `promptLine()` |
| 事件冷却 / 每小时上限 | `GAME_DEFAULTS.cooldowns` / `maxEventsPerHour` |
| 她能对游戏下哪些指令 | `GAME_ACTIONS` |
| 指令分类的中文名 / 同义说法 | `GAME_SKILL_ACTION_NAMES`（`src/skills.js`） |
| 技能怎么打分 | `skillScore()`（`src/skills.js`） |
| 技能库容量 | `MAX_GAME_SKILLS` / 每条 key 上限 `MAX_GAME_SKILL_KEYS` |

---

## 十一、贡献

```bash
git clone <repo>
cd mood-memory
node bench/run-all.mjs     # 先确认基线是绿的
```

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。核心要求只有一条：**改动必须让 `node bench/run-all.mjs` 通过，行为变化要补测试。**

---

MIT License
