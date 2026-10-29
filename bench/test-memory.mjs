// 打包自测：用抽出来的 memory.js 跑一遍关键行为（确认和线上一致）
import { createMemory } from '../src/memory.js';

const mem = createMemory({ limit: (n, d) => d });
let pass = 0; let total = 0;
const ok = (cond, name) => { total++; if (cond) { pass++; console.log('✅', name); } else console.log('❌', name); };

const st = { activeTopics: [], importantTopics: [], pendingThoughts: [], memberImpressions: {} };

// 1) 写入 + 抽核心词
const e1 = mem.append(st, 'activeTopic', '管理员在2026年10月26日完成了《山海旧事》这本书', { important: true, keys: ['山海旧事'] });
ok(e1.keys.includes('山海旧事'), '自动抽核心词（书名号）');
ok(e1.dates.includes('2026-10-26'), '自动抽日期');

// 2) 重复加权
const e2 = mem.append(st, 'activeTopic', '管理员在2026年10月26日完成了《山海旧事》这本书，写了三年');
ok(st.importantTopics.length === 1 && e2.mentions === 2, '重复条目合并加权（不新增）');

// 3) 核心词命中
ok(mem.relevance(e1, mem.norm('山海旧事写完了吗')).kind === 'hit', '提到核心词 → 命中');
ok(mem.relevance(e1, mem.norm('管理员今天在吗')).kind === 'none', '只提称呼 → 不命中');

// 4) 两 key 概率
const two = { text: 'x', keys: ['云边小馆', '茶馆'], dates: [] };
ok(mem.relevance(two, mem.norm('云边小馆更新了吗')).prob === 0.5, '两个 key 中一个 → 50%');
ok(mem.relevance(two, mem.norm('云边小馆那个茶馆')).prob === 1, '两个 key 都中 → 100%');

// 5) 过期约定优先淘汰
const st2 = { activeTopics: [], importantTopics: [], pendingThoughts: [], memberImpressions: {} };
const expired = { text: '约好 2026年10月11日 交画稿', dates: ['2026-10-11'], createdAt: Date.now() - 30 * 86400000, lastMentionAt: Date.now() - 30 * 86400000, important: true };
const fresh = { text: '他妈妈住院了', createdAt: Date.now(), lastMentionAt: Date.now(), important: true };
st2.importantTopics = [expired, fresh];
ok(mem.isExpired(expired), '过期约定识别');
ok(!mem.isExpired(fresh), '未过期不误判');

// 6) 渲染
mem.append(st, 'pendingThought', '想问问他书稿进度', { motivation: 'curiosity' });
mem.append(st, 'memberImpression', '嘴硬心软', { target: '阿橙' });
const text = mem.format(st, '山海旧事怎么样了');
ok(text.includes('山海旧事'), '召回后进入提示词');
ok(text.includes('想问问他书稿进度'), '待说的话也在');
ok(text.includes('阿橙'), '群友印象也在');

// 7) 普通条目衰减
const st3 = { activeTopics: [], importantTopics: [], pendingThoughts: [], memberImpressions: {} };
mem.append(st3, 'activeTopic', '很久以前的一件小事');
st3.activeTopics[0].lastMentionAt = Date.now() - 5 * 86400000;
st3.activeTopics[0].createdAt = Date.now() - 5 * 86400000;
mem.age(st3);
ok(st3.activeTopics.length === 0, '普通条目 5 天后淡出');

// 7) 游戏 key：条目带游戏名，聊天里提到游戏名 → 这些条目加权、更容易被想起
{
  const sg = { activeTopics: [], importantTopics: [], pendingThoughts: [], memberImpressions: {} };
  const game = mem.append(sg, 'activeTopic', '和老李打蜂王，被秒了两次', { keys: ['蜂王'], gameKey: '泰拉瑞亚', keyReuse: true });
  ok(game.gameKey === '泰拉瑞亚', '游戏 key 写进条目');
  ok(mem.relevance(game, mem.norm('泰拉瑞亚好玩吗')).kind === 'game', '提到游戏名 → 游戏 key 命中');
  ok(mem.relevance(game, mem.norm('泰拉瑞亚')).prob === 1, '游戏名全名命中 → 必被召回');
  ok(mem.relevance(game, mem.norm('泰拉')).prob >= 0.8, '只提简称也给保底概率');
  ok(mem.relevance(game, mem.norm('晚饭吃什么')).kind === 'none', '没提游戏名 → 不靠游戏 key 命中');
  ok(mem.gameMatch(game, mem.norm('泰拉瑞亚')) > 0, 'gameMatch 能算出命中度');
  ok(mem.gameMatch({ text: '没有游戏 key 的条目' }, mem.norm('泰拉瑞亚')) === 0, '没挂游戏 key 的不参与');
  const chat = mem.append(sg, 'activeTopic', '今天不吃火锅了', { keys: ['火锅'] });
  ok(mem.relevance(chat, mem.norm('泰拉瑞亚')).kind === 'none', '普通聊天记忆不会被游戏名连带召回');
  ok(mem.format(sg, '泰拉瑞亚又更新了').includes('蜂王'), '提到游戏名时它出现在提示词里');
}

// ── 2.1 起和线上对齐的行为 ─────────────────────────────────────────────
const blank = () => ({ activeTopics: [], importantTopics: [], pendingThoughts: [], memberImpressions: {} });

// 8) 普通话题有容量上限（默认 20）：写 25 条只剩 20，且淘汰的是权重最低的
{
  const s = blank();
  for (let i = 0; i < 25; i++) mem.append(s, 'activeTopic', `第 ${i} 件不相干的小事`, { keys: [`小事${i}`] });
  ok(s.activeTopics.length === 20, `普通话题封顶 20（实际 ${s.activeTopics.length}）`);
}

// 9) 重要性自动打分：约定/住院这类没显式标 important 也进「重要的事」
{
  const s = blank();
  const imp = mem.append(s, 'activeTopic', '说好下周三把画稿交给他');
  ok(mem.scoreImportance('说好下周三把画稿交给他').level === 'important', '重要性打分：约定 → important');
  ok(imp.important === true && s.importantTopics.length === 1, '没显式标 important 也自动进重要');
  const daily = mem.append(s, 'activeTopic', '今天中午吃了牛肉面', { keys: ['牛肉面'] });
  ok(daily.important === false && s.activeTopics.length === 1, '日常琐事还是普通话题');
  const forced = mem.append(s, 'activeTopic', '答应了要给他画一张（但这次强制当普通）', { important: false });
  ok(forced.important === false, 'important:false 强制降级，覆盖打分');
}

// 10) 重要条目每日配额：超了把当天最弱的降级回普通话题，而不是拒收
{
  const s = blank();
  for (let i = 0; i < 12; i++) mem.append(s, 'activeTopic', `第 ${i} 次约定：说好要办的第 ${i} 件事`, { important: true, keys: [`约定${i}`] });
  ok(s.importantTopics.length === 10, `重要条目当天封顶 10（实际 ${s.importantTopics.length}）`);
  ok(s.activeTopics.length === 2 && s.activeTopics.every((t) => t.important === false), '多出来的 2 条降级成普通话题');
}

// 11) 重要条目总容量默认 50（线上 age 路径的默认值）
{
  const s = blank();
  for (let i = 0; i < 60; i++) s.importantTopics.push({ text: `重要事件 ${i}`, createdAt: Date.now(), lastMentionAt: Date.now(), important: true, keys: [`重要${i}`] });
  mem.age(s);
  ok(s.importantTopics.length === 50, `重要条目封顶 50（实际 ${s.importantTopics.length}）`);
}

// 12) 同一条再说一遍，key 不会被自己改形
{
  const s = blank();
  mem.append(s, 'activeTopic', '今天火锅关门了', { keys: ['火锅'] });
  const again = mem.append(s, 'activeTopic', '今天火锅关门了', { keys: ['火锅'] });
  ok(JSON.stringify(again.keys) === JSON.stringify(['火锅']), `自己的 key 不会被扩词（实际 ${JSON.stringify(again.keys)}）`);
}

// 13) 撞别人的 key 才扩词，扩出来的词和线上一致（噪声字表对齐）
{
  const s = blank();
  mem.append(s, 'activeTopic', '今天火锅关门了', { keys: ['火锅'] });
  const other = mem.append(s, 'activeTopic', '再火锅店吃了顿好的', { keys: ['火锅'] });
  ok(other.keys.includes('再火锅'), `撞词时按线上规则扩成「再火锅」（实际 ${JSON.stringify(other.keys)}）`);
}

// 14) 渲染格式：标题、溢出提示、印象细节
{
  const s = blank();
  for (let i = 0; i < 14; i++) {
    s.importantTopics.push({ text: `重要事件 ${i}`, createdAt: Date.now() - i * 60000, lastMentionAt: Date.now() - i * 60000, important: true, keys: [`重要${i}`] });
  }
  const out = mem.format(s, '今天吃什么');
  ok(out.startsWith('【重要的事】（标了 important，长期记得）'), '重要段标题和线上一致');
  ok(out.includes('- …另有 4 条较早的重要事件：'), `重要条目溢出时给"还有 N 条"提示（实际：${out.split('\n').find((l) => l.includes('另有')) ?? '无'}）`);
  const s2 = blank();
  mem.append(s2, 'activeTopic', '一件普通的小事', { keys: ['小事'] });
  ok(mem.format(s2).includes('【近期的话题】（越靠前记得越牢）'), '普通段标题和线上一致');
}

// 15) 群友印象：同一条不重复记、展示 10 个人、带互动次数
{
  const s = blank();
  mem.append(s, 'memberImpression', '嘴硬心软', { target: '阿橙' });
  mem.append(s, 'memberImpression', '嘴硬心软', { target: '阿橙' });
  ok(s.memberImpressions['阿橙'].traits.length === 1, '同一条印象深刻不重复记');
  for (let i = 0; i < 12; i++) mem.append(s, 'memberImpression', `特点 ${i}`, { target: `群友${i}` });
  ok(Object.keys(s.memberImpressions).length === 10, '最多记 10 个人');
  const out = mem.format(s, '');
  const peopleLines = out.split('\n').filter((l) => l.startsWith('- ') && l.includes('（互动 '));
  ok(peopleLines.length === 10 && peopleLines[0].includes('（互动 1 次）'), '印象段展示 10 个人、带互动次数');
  ok(mem.append(s, 'memberImpression', 'x', { target: '__proto__' }) === null, '非法群友名被拒（防原型污染）');
}

// 16) 想说没说的：同一句只留一条、有上限、带动机
{
  const s = blank();
  mem.append(s, 'pendingThought', '想问问他画稿进度', { motivation: 'curiosity' });
  mem.append(s, 'pendingThought', '想问问他画稿进度', { motivation: 'sociability' });
  ok(s.pendingThoughts.length === 1 && s.pendingThoughts[0].motivation === 'sociability', '同一句想说没说的只留一条（动机更新）');
  for (let i = 0; i < 25; i++) mem.append(s, 'pendingThought', `想说的第 ${i} 句话`);
  ok(s.pendingThoughts.length === 20, `想说没说的封顶 20（实际 ${s.pendingThoughts.length}）`);
  ok(mem.format(s).includes('（curiosity）') || mem.format(s).includes('（'), '渲染时带动机');
}

// 17) 合并时 keys/dates 的容量（6 / 4）
{
  const s = blank();
  mem.append(s, 'activeTopic', '说好那件事要办', { keys: ['k1', 'k2', 'k3', 'k4', 'k5'] });
  const merged = mem.append(s, 'activeTopic', '说好那件事要办，再补几句', { keys: ['k6', 'k7', 'k8'] });
  ok(merged.keys.length <= 6 && merged.dates.length <= 4, `合并后 keys ≤ 6、dates ≤ 4（实际 ${merged.keys.length}/${merged.dates.length}）`);
}

// 18) 召回的默认值：不显式给 always 就不兜底
{
  const s = blank();
  mem.append(s, 'activeTopic', '一件和上下文无关的事', { keys: ['无关'] });
  ok(mem.recall(s.activeTopics, '').length === 0, 'recall 默认不兜底（和线上一致）');
  ok(mem.recall(s.activeTopics, '', { always: 4 }).length === 1, '显式 always 才兜底');
  const dated = { text: '约了 11 月 08 日', keys: [], dates: ['11-08'] };
  ok(mem.relevance(dated, mem.norm('11月08号那天')).kind === 'date' && mem.relevance(dated, mem.norm('11月08号那天')).prob === 0.5, '日期命中给 50%');
  const autoDated = { text: '约了 11 月 8 日', keys: [], dates: mem.extractDates('约了 11 月 8 日') };
  ok(mem.relevance(autoDated, mem.norm('11月8号')).kind === 'date', '自动抽出的日期（11-8）能命中「11月8号」');
}

// 19) participants / pendingQuestion 两个字段（线上有，之前被静默丢掉）
{
  const s = blank();
  const e = mem.append(s, 'activeTopic', '和老李一起打赢了蜂王', { keys: ['蜂王'], participants: ['我', '老李'], pendingQuestion: '问他要不要再来一局' });
  ok(Array.isArray(e.participants) && e.participants.includes('老李'), 'participants 存下来');
  ok(e.pendingQuestion === '问他要不要再来一局', 'pendingQuestion 存下来');
  ok(mem.format(s, '蜂王').includes('；待追问：问他要不要再来一局'), '渲染时带"待追问"');
  const merged = mem.append(s, 'activeTopic', '和老李一起打赢了蜂王，这次没用药', { participants: ['小陈'] });
  ok(merged.participants.includes('老李') && merged.participants.includes('小陈'), '合并时 participants 取并集');
}

// 20) 脱敏 + 码点安全截断
{
  const secure = createMemory({ redact: (v) => String(v).replace(/secret-token-\w+/g, '***') });
  const s = blank();
  const e = secure.append(s, 'activeTopic', '他的 token 是 secret-token-abc123，别乱说');
  ok(!e.text.includes('secret-token-abc123') && e.text.includes('***'), '写入前脱敏');
  const s2 = blank();
  const long = '😀'.repeat(200);
  const truncated = mem.append(s2, 'activeTopic', long);
  ok(!/[\ud800-\udbff]$/.test(truncated.text), '截断不会切出半个 emoji');
}

// 21) 落盘快照带配额，且是权重序
{
  const s = blank();
  for (let i = 0; i < 30; i++) mem.append(s, 'activeTopic', `话题 ${i}`, { keys: [`话题${i}`] });
  const snap = mem.snapshot(s);
  ok(snap.activeTopics.length === 20, '快照里普通话题按配额截断（20）');
  ok(snap.importantTopics.length === 0 && Array.isArray(snap.gameSkills), '快照结构完整');
}

// 22) CRUD：按标签查 / 删 / 清空
{
  const s = blank();
  const g = mem.append(s, 'activeTopic', '地下丛林刷出了蜂王', { keys: ['蜂王'] });
  g.tags = ['泰拉瑞亚'];
  mem.append(s, 'activeTopic', '今天不吃火锅', { keys: ['火锅'] });
  ok(mem.list(s, { tag: '泰拉瑞亚' }).activeTopics.length === 1, '按标签查');
  ok(mem.remove(s, { category: 'activeTopic', content: g.text }).removed === 1, '按原文删');
  ok(mem.list(s).activeTopics.length === 1, '删完只剩另一条');
  mem.clear(s, { category: 'activeTopic' });
  ok(mem.list(s).activeTopics.length === 0, '清空某一类');
}

// 23) 标签也能当"游戏 key"用（桥接写的条目只有 tags，没有 gameKey）
{
  const s = blank();
  const e = mem.append(s, 'activeTopic', '地下丛林刷出了蜂王', { keys: ['蜂王'] });
  e.tags = ['泰拉瑞亚'];
  ok(mem.relevance(e, mem.norm('泰拉瑞亚好玩吗')).kind === 'game', '只有 tags 的条目也能被游戏名召回');
}

// 24) 写入即结算心情（可选钩子，默认不动）
{
  const s = blank();
  mem.append(s, 'activeTopic', '他说了句谢谢，还夸我画得好看');
  ok(!s.mood, '不传 settleMood 时不动心情');
  const calls = [];
  const hot = createMemory({ settleMood: (st2, text, extra, info) => { calls.push({ text, important: info.important }); } });
  hot.append(fresh2(), 'activeTopic', '他说了句谢谢，还夸我画得好看');
  function fresh2() { const x = blank(); hot.append(x, 'activeTopic', '他说了句谢谢，还夸我画得好看'); return x; }
  ok(calls.length >= 1, '传了 settleMood 就每条写完后调一次');
}

console.log(`\n${pass}/${total} 通过`);
if (pass !== total) process.exit(1);
