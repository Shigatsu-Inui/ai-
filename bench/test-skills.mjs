// 2.1 自测：游戏技能库（append / 指令分类进 key / 打分 / 容量淘汰 / 渲染）
import {
  appendGameSkill, formatGameSkills, matchGameSkills, markGameSkillUsed, skillScore,
  GAME_SKILL_ACTIONS, GAME_SKILL_ACTION_NAMES, MAX_GAME_SKILLS, MAX_GAME_SKILL_KEYS,
  normalizeGameAction, gameActionLabel, inferGameSkillAction
} from '../src/skills.js';

let pass = 0; let total = 0;
const ok = (cond, name) => { total++; if (cond) { pass++; console.log('✅', name); } else console.log('❌', name); };
const fresh = () => ({ activeTopics: [], importantTopics: [], pendingThoughts: [], memberImpressions: {}, gameSkills: [] });

// 1) 写入 + 合并
{
  const st = fresh();
  const r1 = appendGameSkill(st, '对着矿脉长按左键，矿石会进独立背包', { skill: '采矿', keys: ['矿脉', '镐子'], action: 'mine' });
  ok(r1.ok && r1.created, '记下第一条技能');
  ok(st.gameSkills.length === 1, '存进 st.gameSkills（和记忆同一个状态对象）');
  ok(st.gameSkills[0].game === '泰拉瑞亚', '默认挂游戏名「泰拉瑞亚」');
  ok(st.gameSkills[0].action === 'mine', '动作落库');
  ok(st.gameSkills[0].keys.includes('采矿') && st.gameSkills[0].keys.includes('矿脉'), '技能名和概述词都进 key');

  appendGameSkill(st, '对着矿脉长按左键，矿石会进独立背包（补充：地下也能用）', { skill: '采矿', keys: ['矿脉'] });
  ok(st.gameSkills.length === 1 && st.gameSkills[0].mentions === 2, '同一游戏 + 同一技能名 → 合并，不重复堆');
  ok(st.gameSkills[0].text.includes('地下也能用'), '合并时更新"怎么做"');

  appendGameSkill(st, '史莱姆贴脸时往后跳一步再砍', { game: '我的世界', skill: '躲史莱姆', keys: ['史莱姆', '跳'] });
  ok(st.gameSkills.length === 2, '换游戏另存一条');
}

// 2) 指令分类：中文名自动进 key（第 2 位）
{
  const st = fresh();
  const r = appendGameSkill(st, '用斧头砍树干，木材掉落后捡起来', { skill: '砍树', keys: ['树干'], action: 'chop' });
  ok(r.action === 'chop' && r.keys.includes('伐木'), 'chop → 分类名「伐木」自动进 key');
  ok(r.keys[1] === '伐木', '分类名排在主 key 之后（第 2 位）');

  const cn = appendGameSkill(st, '她跑向玩家身边', { skill: '贴身护卫', action: '跟随' });
  ok(cn.action === 'follow', '传中文分类名也认（跟随 → follow）');

  const guess = appendGameSkill(st, '对着矿脉长按左键', { skill: '采矿' });
  ok(guess.action === 'mine', '没填 action 时按技能名推断');
  ok(guess.keys.includes('采矿'), '推断出的分类名也进 key');
  ok(guess.keys.length <= MAX_GAME_SKILL_KEYS, `key 不超过 ${MAX_GAME_SKILL_KEYS} 个`);

  const many = appendGameSkill(st, '一条塞满 key 的技能', { skill: '塞满', keys: ['a', 'b', 'c', 'd', 'e', 'f'], action: 'craft' });
  ok(many.keys.length === MAX_GAME_SKILL_KEYS, `给再多 key 也只留 ${MAX_GAME_SKILL_KEYS} 个（不挤掉分类名）`);
  ok(many.keys[1] === '制作', 'key 塞满时分类名仍然保住第 2 位');
}

// 3) 动作归一化
{
  ok(normalizeGameAction('mine') === 'mine' && normalizeGameAction('采矿') === 'mine', 'normalizeGameAction 认英文和中文');
  ok(normalizeGameAction('挖矿') === 'mine', '同义说法也能归一到动作');
  ok(normalizeGameAction('瞎写') === '', '认不出返回空串');
  ok(gameActionLabel('come') === '回来', 'gameActionLabel 给中文分类名');
  ok(inferGameSkillAction({ skill: '跟着我', keys: [] }) === 'follow', '按技能名推断 follow');
  ok(inferGameSkillAction({ action: 'chest', skill: '随便' }) === 'chest', '显式 action 优先');
  ok(GAME_SKILL_ACTIONS.length === 14 && GAME_SKILL_ACTIONS.includes('dig') && GAME_SKILL_ACTIONS.includes('craft'),
    '指令分类覆盖游玩端那 14 个动作');
}

// 4) 打分：分类名 / 同义说法 / 英文动作 / 无关查询
{
  const st = fresh();
  appendGameSkill(st, '对着矿脉长按左键，矿石会进独立背包', { skill: '采矿', keys: ['矿脉'], action: 'mine' });
  appendGameSkill(st, '听到召回就从远处跑回玩家身边', { skill: '召回归队', action: 'come' });
  appendGameSkill(st, '跟紧玩家，别掉队', { skill: '贴身跟随', action: 'follow' });
  appendGameSkill(st, '砍树干拿木材，别砍小树', { skill: '砍树', action: 'chop' });

  ok(skillScore(st.gameSkills[0], '挖矿怎么挖') >= 0.5, '问「挖矿怎么挖」→ 采矿命中');
  ok(skillScore(st.gameSkills[0], '地下丛林 mine-cavern 血 42/100 附近 3 只史莱姆 想挖矿') >= 0.5,
    '游玩端真实拼法（含 mine-cavern）→ 命中');
  ok(matchGameSkills(st, { q: '过来吧，别自己乱跑' })[0]?.skill === '召回归队', '同义说法「过来」命中 come 类技能');
  ok(matchGameSkills(st, { q: 'follow' })[0]?.action === 'follow', '只有英文动作 follow 也能命中');
  ok(matchGameSkills(st, { q: '今天吃什么' }).length === 0, '完全无关的查询不瞎返回');
  ok(matchGameSkills(st, { game: '我的世界' }).length === 0, '按游戏过滤');
  ok(matchGameSkills(st, { q: '砍树', limit: 1 }).length === 1, 'limit 生效');
  ok(matchGameSkills(st, { q: '砍树' })[0].actionName === '伐木', '返回里带中文分类名 actionName');
  ok(matchGameSkills(st, { q: '挖矿' })[0].score <= 1, 'score 在 0~1 之间');
}

// 5) 用过加权 + 容量淘汰
{
  const st = fresh();
  appendGameSkill(st, '对着矿脉长按左键', { skill: '采矿', action: 'mine' });
  const before = st.gameSkills[0].uses;
  const m = markGameSkillUsed(st, { skill: '采矿' });
  ok(m.ok && m.uses === before + 1, '标记用过 → uses +1');
  ok(markGameSkillUsed(st, { skill: '不存在的技能' }).ok === false, '标记不存在的技能返回 ok:false，不抛错');

  const big = fresh();
  for (let i = 0; i < MAX_GAME_SKILLS + 5; i++) appendGameSkill(big, `技能 ${i} 的做法`, { skill: `技能${i}` });
  ok(big.gameSkills.length === MAX_GAME_SKILLS, `容量封顶 ${MAX_GAME_SKILLS}`);
  const lucky = big.gameSkills[0];
  markGameSkillUsed(big, { skill: lucky.skill });
  appendGameSkill(big, '再来一条', { skill: '压死骆驼' });
  ok(big.gameSkills.some((s) => s.skill === lucky.skill), '用过的技能不会被淘汰');
}

// 6) 提示词渲染
{
  const st = fresh();
  appendGameSkill(st, '对着矿脉长按左键，矿石会进独立背包', { skill: '采矿', keys: ['矿脉'], action: 'mine' });
  appendGameSkill(st, '史莱姆贴脸时往后跳一步再砍', { skill: '躲史莱姆', keys: ['史莱姆', '跳'], game: '我的世界' });
  const text = formatGameSkills(st, { context: '想挖矿' });
  ok(text.includes('【游戏技能】'), '提示词里有技能段');
  ok(text.includes('泰拉瑞亚·采矿'), '技能带游戏名');
  ok(text.indexOf('采矿') < text.indexOf('躲史莱姆'), '这轮用得上的排前面');
  ok(text.includes('·动作=采矿'), '分类名以中文显示');
  ok(!text.includes('〔采矿 / 采矿'), 'key 列表不重复显示技能名');
  ok(formatGameSkills(fresh()) === '', '空库返回空串（不占 token）');
  ok(formatGameSkills(st, { max: 1 }).split('\n').length === 2, 'max 控制条数（标题 + 1 条）');
}

// 7) 坏输入
{
  const st = fresh();
  let threw = false;
  try { appendGameSkill(st, '   ', { skill: '空内容' }); } catch { threw = true; }
  ok(threw, '空内容直接抛错');
  ok(appendGameSkill(fresh(), '随便一句', {}).skill.length > 0, '不传技能名时用正文前几个字当技能名');
  ok(appendedNothing(), '没有 gameSkills 容器时自动建');
  function appendedNothing() { const s = {}; appendGameSkill(s, '建容器测试', { skill: '建容器' }); return Array.isArray(s.gameSkills) && s.gameSkills.length === 1; }
}

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
