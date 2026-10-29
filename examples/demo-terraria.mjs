// 离线演示：不装游戏、不起服务，喂几帧假快照，看"游戏里发生的事"怎么变成记忆和心情。
//
//   node examples/demo-terraria.mjs
import { createMemory, createTerrariaCompanion, appendGameSkill, matchGameSkills, markGameSkillUsed } from '../src/index.js';
import { moodPromptLine, snapshot } from '../src/mood.js';

const memory = createMemory({});
const state = {}; // 记忆 + 心情都挂在这个对象上（和聊天共用同一份）
const companion = createTerrariaCompanion({ memory, state });

const frame = (over = {}) => ({
  ts: Date.now(),
  day: true,
  player: { name: '老李', hp: 100, maxHp: 100, tileX: 1203, tileY: 420, biome: '森林', dead: false },
  shi: { active: true, hp: 100, maxHp: 120, state: 'follow' },
  nearby: [],
  ...over
});

const story = [
  ['进游戏，站在森林里', frame()],
  ['掉进地下丛林', frame({ player: { name: '老李', hp: 100, maxHp: 100, tileX: 1203, tileY: 620, biome: '地下丛林', dead: false } })],
  ['蜂王刷出来了', frame({ player: { name: '老李', hp: 90, maxHp: 100, tileX: 1203, tileY: 620, biome: '地下丛林', dead: false }, events: [{ kind: 'bossSpawn', name: '蜂王' }] })],
  ['被打死', frame({ player: { name: '老李', hp: 0, maxHp: 100, tileX: 1203, tileY: 620, biome: '地下丛林', dead: true } })],
  ['原地挂机', frame({ ts: Date.now() + 6 * 60 * 1000, player: { name: '老李', hp: 0, maxHp: 100, tileX: 1203, tileY: 620, biome: '地下丛林', dead: true } })],
  ['重来一次，这回赢了', frame({ player: { name: '老李', hp: 40, maxHp: 100, tileX: 1203, tileY: 620, biome: '地下丛林', dead: false }, events: [{ kind: 'bossDefeated', name: '蜂王' }] })],
  ['入夜', frame({ day: false, player: { name: '老李', hp: 40, maxHp: 100, tileX: 1203, tileY: 620, biome: '地下丛林', dead: false } })]
];

for (const [label, snap] of story) {
  const r = companion.ingest(snap);
  console.log(`\n▶ ${label}`);
  console.log(`  ${r.promptLine}`);
  for (const e of r.entries) console.log(`  ✎ 记了一条：${e.text}${e.keys?.length ? `　〔${e.keys.join(' / ')}〕` : ''}`);
  if (!r.entries.length) console.log('  （没有值得记的事，安静）');
}

console.log('\n=== 下一轮聊天时，她的提示词里会长这样 ===');
console.log(memory.format(state, '蜂王又来了？'));
console.log('\n=== 心情 ===');
const snap = snapshot(state);
console.log(`总分 ${snap.total}　七维 ${JSON.stringify(snap.dims)}`);
console.log(moodPromptLine(state, 0.6));

console.log('\n=== 她要动手时，给游戏的指令 ===');
console.log(companion.command('attack', { targetIdx: 3 }));
console.log(companion.command('say', { say: '这次别站桩了' }));

// ===== 游戏 key：提一句游戏名，那一局的事就自己浮上来 =====
const tiny = { activeTopics: [], importantTopics: [], pendingThoughts: [], memberImpressions: {} };
memory.append(tiny, 'activeTopic', '和老李打蜂王，被秒了两次', { keys: ['蜂王'], gameKey: '泰拉瑞亚', keyReuse: true });
memory.append(tiny, 'activeTopic', '老李说今天不吃火锅了', { keys: ['火锅'] });

console.log('\n=== 游戏 key：提到游戏名，带这个 key 的条目一起加权、更容易命中 ===');
for (const ctx of ['泰拉瑞亚还更新吗', '泰拉玩不玩', '今晚吃什么']) {
  const game = memory.relevance(tiny.activeTopics[0], memory.norm(ctx));
  const chat = memory.relevance(tiny.activeTopics[1], memory.norm(ctx));
  console.log(`说「${ctx}」→ 打蜂王那条：${game.kind}（${game.prob}）｜ 火锅那条：${chat.kind}`);
}

// ===== 2.1 技能库：学到的本事（不按时间淡出），按游玩端的指令分类命中 =====
const book = {};
appendGameSkill(book, '先找洞道再往下挖，别在浅层反复刨土', { skill: '深层资源探索', keys: ['洞道'], action: 'explore' });
appendGameSkill(book, '对着矿脉长按左键，矿石会进独立背包', { skill: '采矿', keys: ['矿脉', '镐子'], action: 'mine' });
appendGameSkill(book, '听到召回就从远处跑回来', { skill: '召回归队', action: 'come' });
markGameSkillUsed(book, { skill: '深层资源探索' });
console.log('\n=== 技能库：技能名 / 分类名 / 概述词都进 key ===');
for (const s of book.gameSkills) console.log(`  ${s.skill}：${s.action}（${s.keys.join(' / ')}）`);
console.log('\n=== 游玩端按情境查 ===');
for (const q of ['地下丛林 血42/100 附近3只蝙蝠 想挖矿', '过来吧', '今天吃什么']) {
  const hit = matchGameSkills(book, { q, limit: 2 });
  console.log(`「${q}」→ ${hit.length ? hit.map((h) => `${h.skill}(${h.score})`).join(' | ') : '（没命中，安静）'}`);
}
console.log('\n=== 提示词里的技能段 ===');
console.log(memory.format({ ...book, activeTopics: [], importantTopics: [], pendingThoughts: [], memberImpressions: {} }, '想挖矿'));
