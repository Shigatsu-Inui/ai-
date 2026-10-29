# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.1.0] - 2026-10-30

这一版把包**对齐到线上正在跑的那套实现**：游戏技能库、记忆标签/事件去重、自动判重要性、
重要条目每日配额、群友印象寿命、条目写完自动拨心情、容量与落盘配额全部补齐。

### 新增

- **游戏技能库 `src/skills.js`**：她在游戏里学来的玩法/窍门，记成"能照做的技能"
  - `appendGameSkill(st, content, { skill, keys, action })` —— 同一游戏 + 同一技能名会合并
  - `matchGameSkills(st, { game, q, limit })` —— 游玩端按当下情境查（中文整句即可），返回 0~1 的 `score`
  - `formatGameSkills(st, { context, max })` —— 渲染进提示词（`memory.format()` 会自动带上这一段）
  - `markGameSkillUsed(st, { skill })` —— 记一笔用量，决定淘汰顺序
  - **指令分类进 key**：`action` 认英文也认中文（`mine` / `采矿` / `挖矿` 等价），分类名自动排进 key 第 2 位；
    不填 `action` 会按技能名/keys 自动推断。14 个分类的中文名与同义说法见 `GAME_SKILL_ACTION_NAMES`
  - 技能**不按时间淡出**，只按用量 + 容量（默认 80 条）淘汰
- **游戏记忆的标签与事件去重**（`src/terraria.js`）
  - `appendGameMemory(memory, st, content, { gameTopicId, gameEventId, tags, … })` —— 同一事件重投只补标签、
    不重复写；同一段经历 `gameOccurrences` 累加、正文写「共 N 次」；首次建档才结算一次心情
  - `gameMemoryReceipt(st, { topicId, eventId })` —— 回执：这条还在不在、收了哪几个事件、结算过几次
  - `formatGameMemoryTags(st, formatted, { context })` —— 行内补【标签：…】，提游戏名时按标签补最多 8 条
- **记忆（`src/memory.js`）**
  - 自动判重要性（`scoreImportance`）：约定/纪念日/住院等词表打分，≥3 直接进「重要的事」，日常琐事扣分
  - 重要条目每日配额（`maxImportantPerDay`，默认 10）：超了不拒收，把当天最弱的降级回普通话题
  - 普通话题容量上限（`maxTopics`，默认 20），不再无限增长
  - 群友印象寿命：按权重淘汰、`maxTraits` 15 条、`keepImportant`/`oldKeepTraits` 兜底、长期不聊的人自动清掉
  - 条目新增 `participants` / `pendingQuestion` 字段（渲染时跟「；待追问：…」）
  - `opts.redact` 脱敏钩子 + 码点安全截断 `truncateText`（不再切出半个 emoji）
  - 维护接口：`list()`（按标签查）、`remove()`、`clear()`、`update()`、`snapshot()`（带落盘配额）
  - `opts.settleMood(st, text, extra, info)` 钩子：写入即结算心情（默认关，不传就不动）
- **心情（`src/mood.js`）**
  - `judgeEntryMood(text)` / `pickEntryDims(text, kind)` / `settleEntryMood(st, text, { modelScore, important })`
    —— 只看文本判好坏、分到七维、**不占每日额度、跳过显著闸门**（和线上一致）

### 变更

- `GAME_ACTIONS` 从 6 个补到 14 个（对齐游玩端的 `idle/follow/explore/attack/come/mine/dig/chop/recall/craft/place/chest/use/say`）
- `command()` 支持 `targetTile`（craft/place/mine 这类动作要用）
- `memory.recall(list, ctx)` 的 `always` **默认值 4 → 0**（和线上一致：默认不兜底；`format()` 仍按 `recallBackfill` 打底）
- 容量与展示默认值对齐线上：`maxTraits` 20→15、`showPeople` 5→10、`maxThoughts` 40→20、重要条目上限 100→50
- 合并条目的 `keys` 上限 8→6、`dates` 8→4；合并时统计"别人占用的 key"会跳过自己，不再把自己的 key 改形
- `uniquifyKeys` 的噪声字表与线上完全一致（扩词结果不再有差异）
- 渲染格式对齐：段落标题、重要条目溢出时的「…另有 N 条较早的重要事件」、印象带「（重要）·权重%（互动 N 次）」
- `limit()` 统一做 `1~500` 夹取，配 0 / 负数 / 9999 都不会把提示词撑爆
- 游戏 key 也认 `tags`：线上给条目打的是 `tags: ['泰拉瑞亚']`，这个包直接能读
- `DIM_GAIN_SCALE` 改为引用 `DEFAULTS.dimGainScale`（不再是一份独立快照）；修正两处注释
- 统一出口新增 `./skills` 子路径、`skills` / `game` 命名空间（`lib/index.js`）

### 兼容性

- 2.0 的用法全部照旧，没有删除任何公开 API；`DESCENT_DIMS` 仍是 2.0 里明确移除的那一个
- 补回三个 1.x 里引用的常量：`ENTRY_RANGE` / `IMPORTANT_RANGE` / `DIM_HALF_LIFE_OVERRIDE`
- 唯一的行为变化是 `recall()` 默认不再兜底（`always: 0`）。之前直接调 `recall` 依赖"默认补 4 条"的话，显式传 `{ always: 4 }` 即可
- 测试从 22+43 项涨到 62+65+46+24 项，全部纯本地

## [2.0.0] - 2026-10-28

### 新增

- **游戏接入层 `src/terraria.js`**：把状态文件里"游戏里发生了什么"翻译成记忆条目 + 一行提示词，
  再把她的决定写回指令文件。核心目的只有一个：**游戏里的事要进同一份记忆**，这样聊天时才接得上话。

  - `classify(prev, next)` —— 纯函数，比较前后两帧：死亡、血量跨过阈值、Boss 刷新/击杀、
    入夜、换地形、原地挂机
  - `eventToEntry(ev)` —— 事件 → `{ category, content, extra, mood }`；打赢 Boss 自动标成
    「重要的事」，死亡只算普通话题
  - `createTerrariaCompanion({ memory, state })` —— `ingest(snapshot)` 一帧快照写进记忆
    （可选顺带拨心情）、`promptLine()` 把状态压成一行、`command()` 产出游戏指令
  - `readStateFile()` / `watchStateFile()` —— 读到半截文件返回 `null` 而不是崩，封装好轮询
  - **冷却 + 每小时上限**（默认同类事件 5~30 分钟、一小时最多 20 条）：记忆不是日志，
    写太密会把真正的记忆挤掉
  - **指令白名单** `idle / follow / attack / come / mine / say`：传"往左走三格"直接抛错 ——
    她只做慢决策，走位交给游戏里的状态机

- **游戏 key（`extra.gameKey`）**：每条游戏记忆额外挂一个"游戏名"作为特殊 key。
  聊天里只要提到这个游戏名，**所有带这个 key 的条目一起加权、一起更容易被命中** ——
  你不用复述"昨天打的那局"，提一句「泰拉瑞亚」就够了。

  - 提到游戏名 → 该条目召回权重 `×1.5`（`GAME_KEY_BOOST`），排序和兜底回填都占先
  - 仅靠游戏名召回时给 `80%` 保底概率（`GAME_KEY_PROB`），命中度更高就按命中度：
    说「泰拉瑞亚」是 1.0 必中，只说简称「泰拉」也能到 0.57 → 仍给 80%
  - 匹配复用核心词那套容错逻辑（2-gram），不额外引入词典
  - 没挂 `gameKey` 的老条目完全不受影响；游戏名由 `GAME_DEFAULTS.game` 配置

- `examples/demo-terraria.mjs`（`npm run demo:game`）：不装游戏就能看完整链路，
  末尾直接对比"提游戏名 / 不提游戏名"的召回差异
- `examples/terraria-bridge.mjs`：真机循环 —— 盯 `state.json`、写 `cmd.json`、可选持久化记忆
- `bench/test-terraria.mjs`：游戏接入 43 项自测（事件识别 / 冷却限流 / 指令白名单 / 坏文件不崩 /
  游戏 key 召回），`bench/test-memory.mjs` 增加 9 项游戏 key 断言，都已接进 `npm test`

### 变更

- `src/index.js` 统一出口新增游戏接入 API；也可以 `import ... from 'mood-memory/game'` 单独引
- 核心词避重更严格：`uniquifyKeys` 不再拿介词/动词给 key 扩写（"了蜂王""在地下丛林"这类怪词）
- `memory.append` 支持 `extra.keyReuse: true`：游戏记忆里同一个地名 / Boss 名可以在多条里共存，
  不用为了避重把核心词改得认不出来

### 兼容性

- 仍然零依赖；1.x 的用法全部照旧，没有破坏性改动。
  判 major 是因为新增了一整块对外能力（外加导出变多），按语义化版本该跳。

## [1.3.0] - 2026-10-27

### 新增

- **独立小窗查看器**（`tools/viewer/`）：零依赖，读一个 JSON 状态文件就能看心情、七维、
  重要/普通条目、群友印象。不依赖任何服务端、不联网。

  ```bash
  node tools/viewer/server.mjs --file tools/viewer/demo-state.json --open
  ```

  - 支持两种数据格式：通用的 `{conversations: {key: {mood, memory}}}`，以及 qq-bridge 的
    `social-v2.json`（自动识别，不用转换）
  - 四个区块可折叠，折叠状态记在浏览器里
  - 每 5 秒重读一次文件，导出的一变界面就跟着变
  - 附带 `启动小窗.bat`，Windows 双击即用

## [1.2.0] - 2026-10-27

### 变更

- **七维加减分整体 ×0.85**（`DEFAULTS.dimGainScale`）：实测同一晚能堆到 3.5 以上，看起来太夸张；
  压到 85% 后峰值落在 3 左右。吃醋不参与（它有自己的 ×2 规则）。
- **吃醋触发阈值 1.5 → 0.9**：稍微有点吃味就该表现出来，不用攒到很高。
- **吃醋半衰期 90 → 60 分钟**（`DEFAULTS.dimHalfLifeOverride`）：来得快、去得也快，
  一次吃味大约挂一小时就散，不容易长期记仇。

### 参数一览（1.2.0）

| 维度 | 触发阈值 | 半衰期 | 单次上限 |
| --- | --- | --- | --- |
| 开心 / 踏实 / 甜蜜 / 心疼 / 担心 / 难过 | 1.5 | 90 分钟 | — |
| 吃醋 | **0.9** | **60 分钟** | **+2** |

## [1.1.3] - 2026-10-27

### 新增

- **核心词自动去重**（`uniquifyKeys`）：新 key 跟已有条目撞了，就在原文里往左右扩 1~2 个字，
  做出更专属的词，例如：

  | 已有 | 新条目原文 | 去重后的新词 |
  | --- | --- | --- |
  | 火锅 | 楼下新开了家**火锅**店 | 火锅店 |
  | 生日 | **生日**那天要出差 | 他生日 |
  | 住院 | **住院**费挺贵的 | 住院费 |

  规则：优先「左边加一个字」（中文多是修饰语在前），不行再试右边；扩出来带指示词/量词开头、
  或以虚词结尾的不要（"那张画""稿子上有"）；实在扩不出来就原样保留，**绝不丢 key**。

## [1.1.2] - 2026-10-26

### 修复

- **单字核心词被丢弃**：`extractKeys` 要求归一化后 ≥2 字，导致「猫」「茶」「收」这类 key 存不进去。
  现在允许单字，并用 `STOP_CHARS` 拦掉「的/了/啊/他」这类虚词。
- **单字 key 匹配不上**：`keyHit` 同样要求 ≥2 字，所以即使存进去也永远召回不了。一并放开。

### 变更

- `keys` 参数说明强调「1~2 个就够」：命中率 = 命中数 ÷ 总词数，给 3 个词只提一个只有 33% 机会被想起。

## [1.1.1] - 2026-10-27

### 变更

- 心情提示词加入**人设底线**：心情只调「长短 / 热度 / 愿不愿意多说」，不改性格、口癖、立场、称呼
- 「语气权重 60%」的表述改成"语气强弱占 60%"，明确人格永远 100% 按角色卡

## [1.1.0] - 2026-10-27

### 新增

- `DEFAULTS`：所有可调参数集中到一个对象，改行为只动这里
- `src/index.js`：统一出口，可 `import { createMemory, moodPromptLine } from 'mood-memory'`
- `bench/run-all.mjs`：测试运行器，失败时返回非 0（可直接接 CI）
- `.github/workflows/ci.yml`：Node 18/20/22 三版本自动跑测试
- `LICENSE`、`CONTRIBUTING.md`、`CHANGELOG.md`、`.gitignore`、`.editorconfig`
- 全部公开 API 补 JSDoc 类型注释

### 变更

- `src/mood.js` 重排结构（参数 → 状态 → 档位 → 七维 → 更新 → 快照 → 给分 → 骰子 → 工具）
- 给分里的幅度区间从硬编码改成 `DEFAULTS.gainRange` / `lossRange`

### 移除

- `DESCENT_DIMS`（早期"下降只许因为心疼/担心/难过"的规则已废弃，常量成了死代码）

### 修复

- `bench-evict.mjs` 引用了未定义变量导致 CI 恒失败
- `bench/run-all.mjs` 在 Windows 上路径解析错误

## [1.0.1] - 2026-10-27

### 变更

- README 全面重写（安装 4 种方式、七维实测表、11 条踩坑记录、调参建议）

### 安全

- 移除测试脚本里硬编码的 API Key，改为读 `DEEPSEEK_API_KEY`
- 移除包内全部本机绝对路径
- 清除示例里可能指向真实项目/用户的名称

## [1.0.0] - 2026-10-26

### 新增

- 心情系统：七维情绪、总分五档、0.7/0.3 给分、骰子定幅度、双半衰期衰减、四道闸门
- 记忆系统：双容器、权重衰减、核心词召回、词组匹配、过期约定优先淘汰
- DSH 插件包形态（`cordis.patch.yml` + `lib/index.js` + `AGENT.md`）
