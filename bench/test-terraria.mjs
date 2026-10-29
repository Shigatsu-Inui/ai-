// 2.0 自测：游戏接入层（classify / eventToEntry / companion / promptLine / command）
import { createMemory } from '../src/memory.js';
import {
  classify, eventToEntry, promptLine, createTerrariaCompanion,
  readStateFile, GAME_ACTIONS,
  appendGameMemory, gameMemoryReceipt, formatGameMemoryTags
} from '../src/terraria.js';

let pass = 0; let total = 0;
const ok = (cond, name) => { total++; if (cond) { pass++; console.log('✅', name); } else console.log('❌', name); };

const fresh = () => ({ activeTopics: [], importantTopics: [], pendingThoughts: [], memberImpressions: {} });
const mem = createMemory({ limit: (n, d) => d });

const frame = (over = {}) => ({
  ts: 1000,
  day: true,
  player: { name: '老李', hp: 100, maxHp: 100, tileX: 100, tileY: 200, biome: '森林', dead: false },
  shi: { active: true, hp: 100, maxHp: 120, state: 'follow' },
  nearby: [],
  ...over
});

// 1) 死亡识别：只在"活着 → 死了"那一帧触发
{
  const alive = frame();
  const dead = frame({ ts: 2000, player: { ...alive.player, hp: 0, dead: true } });
  const ev1 = classify(null, dead);
  ok(ev1.some((e) => e.kind === 'playerDied'), '第一帧就是死的 → 识别 playerDied');
  const ev2 = classify(dead, { ...dead, ts: 3000 });
  ok(!ev2.some((e) => e.kind === 'playerDied'), '一直死着不会重复触发');
  ok(classify(alive, frame({ ts: 2000 })).length === 0, '什么都没变 → 没有事件');
}

// 2) 低血只在跨阈值那一刻触发
{
  const high = frame({ player: { ...frame().player, hp: 80 } });
  const low = frame({ ts: 2000, player: { ...frame().player, hp: 20 } });
  const lower = frame({ ts: 3000, player: { ...frame().player, hp: 10 } });
  ok(classify(high, low).some((e) => e.kind === 'lowHp'), '血量跌破 30% → lowHp');
  ok(!classify(low, lower).some((e) => e.kind === 'lowHp'), '一直在低血区不重复触发');
}

// 3) 游戏自己报的事件（最准）
{
  const snap = frame({ events: [{ kind: 'bossDefeated', name: '蜂王', at: 1500 }] });
  const evs = classify(null, snap);
  ok(evs.some((e) => e.kind === 'bossDefeated' && e.boss === '蜂王'), '来自 events 的 bossDefeated');
}

// 4) 入夜 / 换地形
{
  const day = frame();
  const night = frame({ ts: 2000, day: false });
  ok(classify(day, night).some((e) => e.kind === 'nightFell'), '白天 → 夜晚 = nightFell');
  const moved = frame({ ts: 3000, day: false, player: { ...frame().player, biome: '地下丛林' } });
  ok(classify(night, moved).some((e) => e.kind === 'newBiome' && e.biome === '地下丛林'), '换地形 = newBiome');
}

// 5) 事件 → 记忆条目：文本、核心词、重要标记
{
  const win = eventToEntry({ kind: 'bossDefeated', boss: '蜂王', biome: '地下丛林', player: '老李' });
  ok(win.content.includes('蜂王') && win.content.includes('老李'), '打赢 Boss 的句子有人有事');
  ok(win.extra.keys.includes('蜂王'), 'Boss 名进了核心词');
  ok(win.extra.important === true, '打赢 Boss 默认标重要');
  ok(win.mood && win.mood.moodDelta > 0, '打赢 Boss 会给心情加分');
  const die = eventToEntry({ kind: 'playerDied', biome: '地下丛林', player: '老李' });
  ok(die.content.includes('打死') && die.extra.important !== true, '死亡只当普通话题，不标重要');
  const idle = eventToEntry({ kind: 'idle', player: '老李' });
  ok(idle.category === 'pendingThought' && idle.extra.expiresAt > Date.now(), '挂机 → 想说没说的（带过期）');
  ok(win.extra.gameKey === '泰拉瑞亚', '条目自动打上游戏 key（默认泰拉瑞亚）');
  const other = eventToEntry({ kind: 'playerDied', biome: '森林', player: '老李' }, { game: '我的世界' });
  ok(other.extra.gameKey === '我的世界', '换游戏，游戏 key 跟着换');
}

// 6) 接入器：一帧 → 记忆真的写进去了
{
  const st = fresh();
  const c = createTerrariaCompanion({ memory: mem, state: st, opts: { cooldowns: {} }, now: () => 5000 });
  const r = c.ingest(frame({ ts: 5000, player: { ...frame().player, hp: 0, dead: true } }));
  ok(r.entries.length === 1 && st.activeTopics.length === 1, '死亡写进记忆（activeTopics +1）');
  ok(r.promptLine.includes('【泰拉】') && r.promptLine.includes('刚死了'), '提示词是一行，且带死亡标记');
  ok(Number(st.mood?.dims?.担心) > 0 && st.mood.history.length === 1, '死亡把心情往下拨了（七维「担心」动了）');
}

// 7) 冷却：同一类事件在冷却内不重复写；人活了再死一次才重新记
{
  const st = fresh();
  const c = createTerrariaCompanion({ memory: mem, state: st, now: () => 0 });
  const dead = (ts) => frame({ ts, player: { ...frame().player, hp: 0, dead: true } });
  const alive = (ts) => frame({ ts });
  c.ingest(dead(10000));
  ok(st.activeTopics.length === 1, '第一次死亡记一条');
  c.ingest(alive(20000));
  const blocked = c.ingest(dead(30000));
  ok(blocked.entries.length === 0, '冷却内再死一次不重复写（默认 10 分钟）');
  c.ingest(alive(700000));
  const later = c.ingest(dead(710000));
  ok(later.entries.length === 1, '过了冷却就再记（记忆层会按相似文本合并成一条并加 mentions）');
}

// 8) 每小时上限
{
  const st = fresh();
  const c = createTerrariaCompanion({ memory: mem, state: st, opts: { cooldowns: {}, maxEventsPerHour: 2 }, now: () => 0 });
  c.ingest(frame({ ts: 1000, events: [{ kind: 'bossSpawn', name: 'A', at: 1000 }] }));
  c.ingest(frame({ ts: 2000, events: [{ kind: 'bossSpawn', name: 'B', at: 2000 }] }));
  const third = c.ingest(frame({ ts: 3000, events: [{ kind: 'bossSpawn', name: 'C', at: 3000 }] }));
  ok(third.entries.length === 0, '超过每小时上限就不再写（防止记忆被日志挤爆）');
}

// 9) 挂机提醒：位置不动超过 idleMs，只提一次
{
  const st = fresh();
  const c = createTerrariaCompanion({ memory: mem, state: st, opts: { idleMs: 60000 }, now: () => 0 });
  c.ingest(frame({ ts: 1000 }));
  const idle = c.ingest(frame({ ts: 1000 + 61000 }));
  ok(idle.entries.length === 1 && st.pendingThoughts.length === 1, '挂机 → 写一条"想说没说的"');
  const again = c.ingest(frame({ ts: 1000 + 120000 }));
  ok(again.entries.length === 0, '同一段挂机只提醒一次');
}

// 10) 提示词一行：状态全在，但不啰嗦
{
  const line = promptLine(frame({
    player: { name: '老李', hp: 78, maxHp: 100, biome: '地下丛林', dead: false },
    shi: { active: true, hp: 92, maxHp: 120, state: 'follow' },
    nearby: [{ name: '蝙蝠', hostile: true }, { name: '蝙蝠', hostile: true }, { name: '史莱姆', hostile: true }]
  }));
  ok(line.includes('老李在地下丛林') && line.includes('78/100'), '提示词带位置和血量');
  ok(line.includes('跟着你'), '提示词带她在干嘛');
  ok(line.includes('蝙蝠×2'), '附近怪物按种类合并计数');
  ok(line.length < 120, `提示词够短（${line.length} 字）`);
}

// 11) 指令：白名单 + seq 递增 + 说话截断
{
  const c = createTerrariaCompanion({ memory: mem, state: fresh(), now: () => 0 });
  const a = c.command('follow');
  const b = c.command('say', { say: 'x'.repeat(500) });
  ok(a.seq === 1 && b.seq === 2, '指令带递增 seq（游戏侧可去重）');
  ok(b.say.length === 200, '说话截到 200 字');
  let threw = false;
  try { c.command('往左走三格'); } catch { threw = true; }
  ok(threw, `非白名单动作直接抛错（只允许 ${GAME_ACTIONS.join('/')}）`);
}

// 12) 读状态文件：坏文件不抛，返回 null
{
  const fake = (content) => ({ readFileSync: () => content });
  ok(readStateFile('x.json', { fs: fake('{"a":1}') }).a === 1, '正常 JSON 能读');
  ok(readStateFile('x.json', { fs: fake('{"a":') }) === null, '写了一半的文件 → null（下一帧再读）');
  ok(readStateFile('x.json', { fs: { readFileSync: () => { throw new Error('ENOENT'); } } }) === null, '文件不存在 → null');
}

// 13) 核心词不避重：游戏里同一个地名/Boss 名可以在多条记忆里共存，别被扩成怪词
{
  const st = fresh();
  const c = createTerrariaCompanion({ memory: mem, state: st, opts: { cooldowns: {} }, now: () => 0 });
  c.ingest(frame({ ts: 1000 }));
  c.ingest(frame({ ts: 2000, player: { ...frame().player, biome: '地下丛林' } }));
  c.ingest(frame({ ts: 3000, player: { ...frame().player, biome: '地下丛林', hp: 0, dead: true } }));
  const biomeKeys = st.activeTopics.flatMap((e) => e.keys || []).filter((k) => k.includes('地下丛林'));
  ok(biomeKeys.length >= 2 && biomeKeys.every((k) => k === '地下丛林'), '同名核心词直接复用（不会变成「在地下丛林」这种怪词）');
}

// 14) 游戏 key：提到游戏名，带这个 key 的条目一起被加权、被想起
{
  const st = fresh();
  const c = createTerrariaCompanion({ memory: mem, state: st, opts: { cooldowns: {} }, now: () => 0 });
  c.ingest(frame({ ts: 500 }));
  c.ingest(frame({ ts: 1000, player: { ...frame().player, biome: '地下丛林' } }));
  mem.append(st, 'activeTopic', '老李说今天不吃火锅了', { keys: ['火锅'] });
  const game = st.activeTopics.find((e) => e.gameKey);
  ok(game && game.gameKey === '泰拉瑞亚', '游戏记忆带着 gameKey');
  ok(mem.relevance(game, mem.norm('泰拉瑞亚又更新了')).kind === 'game', '提到游戏名 → 游戏 key 命中');
  ok(mem.relevance(game, mem.norm('泰拉瑞亚又更新了')).prob === 1, '游戏名全名命中 → 必被召回');
  ok(mem.relevance(game, mem.norm('泰拉')).prob >= 0.8, '只提简称也给保底概率');
  ok(mem.relevance(game, mem.norm('今晚吃什么')).kind === 'none', '没提游戏名就不靠游戏 key 命中');
  const chat = st.activeTopics.find((e) => !e.gameKey);
  ok(mem.relevance(chat, mem.norm('泰拉瑞亚')).kind === 'none', '没挂游戏 key 的聊天记忆不受影响');
  ok(mem.format(st, '泰拉瑞亚又更新了').includes('地下丛林'), '提到游戏名时，游戏记忆会出现在提示词里');
}

// 15) 游戏记忆收据：带标签 + 事件去重 + 同类合并 + 心情只结算一次
{
  const st = fresh();
  const settleCalls = [];
  const settleMood = (entry, info) => {
    settleCalls.push({ text: info.text, important: info.important });
    return { settlementCount: 1, lastSettlement: { at: 1, before: 0, after: 5, delta: 5 } };
  };
  const gm = (content, eventId, extra = {}) => appendGameMemory(mem, st, content, {
    gameTopicId: 'terraria:ep-1', gameEventId: eventId, keys: ['蜂王'], important: true, gameKind: 'bossDefeated', ...extra
  }, { save: () => {}, settleMood });

  const first = gm('和老李一起打赢了蜂王', 'ev-1');
  ok(first.handled && first.created, '游戏事件写成一条新记忆');
  const entry = st.importantTopics[0];
  ok(entry && entry.gameTopicId === 'terraria:ep-1', '条目挂了 gameTopicId（同一段经历只占一条）');
  ok(entry.tags.includes('泰拉瑞亚') && entry.gameId === 'terraria', '条目带标签和 gameId');
  ok(entry.narrator === 'self' && entry.gamePlayer && entry.gamePlayer.kind === 'game', '标了叙述者和游戏身份');
  ok(settleCalls.length === 1 && entry.gameMoodReceipt?.lastSettlement?.delta === 5, '首次建档结算一次心情，并留下收据');

  const dup = gm('和老李一起打赢了蜂王', 'ev-1');
  ok(dup.duplicate === true && st.importantTopics.length === 1 && settleCalls.length === 1, '同一事件重复到达：不重复写、不重复结算');

  const second = gm('和老李一起打赢了蜂王', 'ev-2');
  ok(second.created === false && second.occurrences === 2 && settleCalls.length === 1, '同一段经历的新事件：合并 occurrences，不再结算心情');
  ok(String(entry.text).includes('共2次'), '合并后正文写「共 2 次」');
  ok(entry.gameEventIds.length === 2, '事件 id 都记着（最多 128 个）');

  const receipt = gameMemoryReceipt(st, { topicId: 'terraria:ep-1', eventId: 'ev-2' });
  ok(receipt.retained && receipt.eventRecorded && receipt.occurrences === 2, '收据查得到：这条还在、事件已收');
  ok(receipt.tags.includes('泰拉瑞亚') && receipt.settlementCount === 1, '收据带标签和结算次数');
  ok(gameMemoryReceipt(st, { topicId: 'terraria:nope' }).retained === false, '不存在的 topic → retained:false');

  ok(appendGameMemory(mem, st, '普通聊天', {}).handled === false, '没有 gameTopicId → handled:false（调用方走普通 append）');
  let threw = false;
  try { appendGameMemory(mem, st, 'x', { gameTopicId: 'bad id', gameEventId: 'e' }); } catch { threw = true; }
  ok(threw, '非法 gameTopicId 直接抛错');
  threw = false;
  try { appendGameMemory(mem, st, 'x', { gameTopicId: 'terraria:ok', gameEventId: '' }); } catch { threw = true; }
  ok(threw, '缺 gameEventId 直接抛错');
}

// 16) 阵亡计数：同一段经历里"阵亡了N次"
{
  const st = fresh();
  const gm = (eventId) => appendGameMemory(mem, st, '和老李在地下丛林玩，阵亡了一次', {
    gameTopicId: 'terraria:ep-died', gameEventId: eventId, gameKind: 'playerDied', keys: ['地下丛林']
  }, {});
  gm('d1'); gm('d2'); gm('d3');
  const entry = st.activeTopics[0];
  ok(/阵亡了3次/.test(entry.text), `阵亡次数写进正文（实际：${entry.text}）`);
  ok(entry.gameOccurrences === 3 && st.activeTopics.length === 1, '还是同一条，不堆三条');
}

// 17) 按标签补提示词
{
  // A) 条目已经被渲染出来 → 行尾补【标签：…】
  const st = fresh();
  mem.append(st, 'activeTopic', '地下丛林刷出了蜂王，和老李一起打', { keys: ['蜂王'] });
  st.activeTopics[0].tags = ['泰拉瑞亚', 'Boss'];
  st.activeTopics[0].gameId = 'terraria';
  const tagged = formatGameMemoryTags(st, mem.format(st, '今天吃什么'), { context: '今天吃什么' });
  ok(tagged.includes('【标签：泰拉瑞亚、Boss】'), '已渲染的记忆行后面补标签');

  // B) 没被核心词/兜底回填召回的旧条目：提游戏名时按标签补进来
  const old = fresh();
  for (let i = 0; i < 5; i++) mem.append(old, 'activeTopic', `随便聊的第 ${i} 件事`, { keys: [`闲聊${i}`] });
  mem.append(old, 'activeTopic', '地下丛林刷出了蜂王，和老李一起打', { keys: ['蜂王'] });
  const oldEntry = old.activeTopics[old.activeTopics.length - 1];
  oldEntry.tags = ['泰拉瑞亚'];
  oldEntry.gameId = 'terraria';
  const plainOld = mem.format(old, '今天吃什么');
  ok(!plainOld.includes('地下丛林'), '兜底只回填 4 条，排最后的那条没进提示词');
  const recalled = formatGameMemoryTags(old, plainOld, { context: '泰拉瑞亚又更新了' });
  ok(recalled.includes('【游戏相关记忆 · 按标签召回】') && recalled.includes('地下丛林'), '上下文提到游戏名 → 按标签补回来');
  ok(!formatGameMemoryTags(old, plainOld, { context: '今晚吃什么' }).includes('按标签召回'), '没提游戏名就不补');
  ok(formatGameMemoryTags(old, plainOld, { tag: '泰拉瑞亚' }).includes('按标签召回'), '显式给 tag 时按标签过滤');
}

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
