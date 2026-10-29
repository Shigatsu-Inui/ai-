# mood-memory · 给 agent 的安装说明

> 主人把这个包给了你，意思是：**给这个聊天机器人加上"心情"和"记忆"**。
> 不用问，照下面做。装完用一两句大白话告诉主人装好了。

## 这个包是什么

零依赖的纯本地模块，不调模型、不花 token：

- `src/mood.js` —— 心情系统（七维情绪、条目判分、骰子随机、12 小时半衰期、语气生成）
- `src/memory.js` —— 记忆系统（双容器、核心词召回、过期约定优先淘汰、自动判重要性、容量上限）
- `src/terraria.js` —— 游戏接入层（2.0）：把游戏里发生的事写进**同一份**记忆，聊天时接得上话
- `src/skills.js` —— 游戏技能库（2.1）：她在游戏里学到的玩法/窍门，按"游玩端的指令分类"命中

## 第一步：装进 DSH 的 profile

按情况选一种：

1. **包在本地文件夹**
   ```
   dsh plugin --profile <profile> add <文件夹绝对路径>
   ```
   桌面端 profile 一般叫 `desktop`；`dsh web` 通常叫 `web`。

2. **手动挂（最稳）**
   - 把整个文件夹复制到 `~/.dsh/plugins/mood-memory`
   - 编辑 `<profile>/package.json`：
     ```json
     {
       "dependencies": { "mood-memory": "link:~/.dsh/plugins/mood-memory" },
       "dsh": { "profile": { "bundles": [ "...", "mood-memory" ] } }
     }
     ```
   - 在 profile 目录执行 `pnpm install`
   - 包自带 `cordis.patch.yml`（`dsh.bundle.patch` 已声明），加载器会自动 insert 一行 `id: mood-memory`

3. **有插件市场**：搜 `mood-memory` 直接装

装完重启 DSH（或等 HMR），日志出现
`[mood-memory] 已加载：心情 + 记忆模块就绪` 就算成功。

## 第二步：接到机器人里

**如果机器人有自己的桥接层**：桥接层里已经有同一套实现，确认配置即可：

```json
"socialV2": {
  "mood":   { "enabled": true, "toneWeight": 0.6, "autoPerEntry": true,
              "dice": { "enabled": true, "intervalMinMs": 2700000 } },
  "memory": { "maxImportantTopics": 100, "maxTopics": 80, "recallBackfill": 4 }
}
```

**如果是别的机器人**，三行接进去：

```js
import { createMemory } from 'mood-memory/memory';
import { scoreEntryMood, applyMoodUpdate, moodPromptLine } from 'mood-memory/mood';

const mem = createMemory({ limit: (n, d) => config[n] ?? d, log: console.log });

// 记一条 → 判分 → 拼提示词
const s = scoreEntryMood('他夸我画得好看', 8);        // 8 = 模型按人设给的分
applyMoodUpdate(st, { moodDelta: s.delta, dims: { 开心: 2 }, reason: '被夸', confidence: 85 });
const prompt = mem.format(st, 最近消息文本) + '\n\n' + moodPromptLine(st, 0.6);
```

## 第三步：自检

```
node <包目录>/bench/test-memory.mjs
node <包目录>/bench/test-terraria.mjs        # 2.0 起
node <包目录>/bench/test-skills.mjs          # 2.1 起
node <包目录>/bench/test-mood-entry.mjs      # 2.1 起
```

应输出 `62/62 通过`、`65/65 通过`、`46/46 通过`、`24/24 通过`（需要 Node 18+）。
一次跑完：`node <包目录>/bench/run-all.mjs`。

## 2.1 之后要特别知道的

- **写一条记忆就会拨一下心情**（和线上一致）：想开这个行为，`createMemory({ settleMood })`：
  ```js
  import { settleEntryMood } from 'mood-memory/mood';
  const mem = createMemory({
    settleMood: (st, text, extra, info) => settleEntryMood(st, text, { modelScore: extra.moodScore, important: info.important })
  });
  ```
  不传就完全不动心情（老用法不变）。这条路径**不占每日额度、跳过显著闸门**，因为每条记忆都该带一点情绪。
- **重要的事会自动判**：不用主人专门标 `important`，说"说好下周交稿""他住院了"这类会自动进「重要的事」。
  想强制指定就传 `important: true` / `false`。
- **技能库是另一回事**：记忆记"发生过的事"，技能记"学到的本事"（不按时间淡出）。用
  `appendGameSkill()` 记、`matchGameSkills()` 按情境查、`markGameSkillUsed()` 记用量。
  游玩端发的指令分类（`mine/follow/come/…` 共 14 个）会自动进 key，中文名见 `GAME_SKILL_ACTION_NAMES`。

## 如果主人要接游戏（泰拉瑞亚 / Minecraft 之类）

他要的不是"AI 会玩"，是**「游戏里发生的事，聊天时她记得」**。三件事：

1. 游戏侧每 100ms 写一个 `state.json`（玩家位置/血量、她的状态、附近怪、事件增量），
   每 100ms 读一个 `cmd.json`（`idle/follow/explore/attack/come/mine/dig/chop/recall/craft/place/chest/use/say`）。
   所有 I/O 都要 `try/catch`，桥接挂了不能影响游戏。
2. 用 `createTerrariaCompanion({ memory, state })`：`ingest(snapshot)` 一帧 → 写进记忆
   （可选顺带拨心情），`promptLine()` 拿一行状态塞提示词，`command()` 产出给游戏的指令。
3. **记忆必须写进聊天用的同一个 `state` 对象**（同一个会话语境），否则她在 QQ 里想不起来。
4. 每条游戏记忆默认带**游戏 key**（`extra.gameKey` = 游戏名）：之后聊天里一提到「泰拉瑞亚」，
   这些条目会一起加权、更容易被想起来 —— 不用主人复述细节。换游戏就把 `opts.game` 改掉。

先跑 `npm run demo:game` 给主人看效果，再动真机。

## 装完跟主人说的

- **心情**：七维情绪 + 总分 0~100，随聊天内容变，语气跟着变（语气权重 60%，人设 40%）
- **记忆**：重要的事长期记、日常话题几天淡出；提到核心词才会想起来；过期的约定会被优先淘汰
- **不花钱**：两个模块都纯本地，0 token
- **怎么调**：`toneWeight` 0.4 更稳 / 0.8 更情绪化；`dice.intervalMinMs` 控制随机心情的频率
- **接了游戏之后**：她会在游戏里"记得"你们打过什么 —— 打赢的 Boss 自动进「重要的事」，
  死了几次、在哪儿卡的关，第二天聊天提一句她就接得上（`npm run demo:game` 可以先看效果）
- **学会的东西另存一份**（2.1）：游戏里讲过的窍门会变成"技能"，下次遇到同样地形/敌人能直接照做；
  技能不会因为过了几天就忘掉，只有真用不上才淘汰
