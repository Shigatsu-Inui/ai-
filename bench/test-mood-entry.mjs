// 2.1 自测：条目自动结算心情（judgeEntryMood / pickEntryDims / settleEntryMood）+ 兼容导出
import {
  judgeEntryMood, pickEntryDims, settleEntryMood, scoreEntryMood,
  DEFAULTS, DIM_GAIN_SCALE, ENTRY_RANGE, IMPORTANT_RANGE, DIM_HALF_LIFE_OVERRIDE,
  ensureMood, applyMoodUpdate
} from '../src/mood.js';

let pass = 0; let total = 0;
const ok = (cond, name) => { total++; if (cond) { pass++; console.log('✅', name); } else console.log('❌', name); };

// 1) 只看文本判好坏
{
  const good = judgeEntryMood('他说了句谢谢，还夸我好看');
  ok(good.kind === 'good' && good.delta >= 5 && good.delta <= 8, `好事 → +5~8（实际 ${good.delta}）`);
  const bad = judgeEntryMood('他怎么又不回我，好冷漠');
  ok(bad.kind === 'bad' && bad.delta <= -3 && bad.delta >= -5, `坏事 → -3~5（实际 ${bad.delta}）`);
  ok(judgeEntryMood('明天要下雨').kind === 'neutral' && judgeEntryMood('明天要下雨').delta === 0, '中性条目不动心情');
  const tie = judgeEntryMood('谢谢，但我真的很难过');
  ok(tie.kind === 'tie' && tie.delta === 0, '好坏各占一半 → 不动');
}

// 2) 按词分维
{
  ok(JSON.stringify(pickEntryDims('他住院了', 'bad')) === JSON.stringify({ 心疼: 3, 担心: 2 }), '生病住院 → 心疼 + 担心');
  ok(JSON.stringify(pickEntryDims('他又不理我', 'bad')) === JSON.stringify({ 难过: 3, 担心: 1 }), '不回消息 → 难过 + 担心');
  ok(pickEntryDims('他夸我画得好看', 'good').开心 === 3, '被夸 → 开心 3');
  ok(JSON.stringify(pickEntryDims('今天天气不错', 'neutral')) === '{}', '中性 → 不分维');
}

// 3) 结算：不动额度、跳过显著闸门、只按文本判断
{
  const st = {};
  const r = settleEntryMood(st, '他说了句谢谢，还夸我画得好看');
  ok(r.applied === true && r.kind === 'good', '好事真的落到心情上');
  ok(ensureMood(st).total > 60, `心情涨了（${ensureMood(st).total}）`);
  ok(ensureMood(st).updates.length === 0, '不占每日额度（updates 不记）');
  ok(ensureMood(st).history.length === 1 && String(ensureMood(st).history[0].reason).startsWith('条目#good#'), '历史里留一条带「条目#good#」的记录');

  const neutral = settleEntryMood({}, '明天要下雨');
  ok(neutral.applied === false, '中性条目不落心情');

  const strong = scoreEntryMood('被夸了', 8);
  const withModel = settleEntryMood({}, '被夸了', { modelScore: 8 });
  ok(withModel.applied === true && withModel.delta > 0, '模型分也参与合成');
  ok(strong.delta > 0, 'scoreEntryMood 单独调用也给分');

  const important = settleEntryMood({}, '他说了句谢谢，还夸我好看', { important: true });
  ok(important.delta >= 14 && important.delta <= 16, `重要条目幅度翻倍 14~16（实际 ${important.delta}）`);
}

// 4) 和 createMemory 串起来：写入即结算
{
  const { createMemory } = await import('../src/memory.js');
  const memory = createMemory({
    settleMood: (st, text, extra, info) => settleEntryMood(st, text, { modelScore: extra.moodScore, important: info.important })
  });
  const st = {};
  memory.append(st, 'activeTopic', '他说了句谢谢，还夸我画得好看');
  ok(st.mood && st.mood.total > 60, 'createMemory + settleMood：写一条好事，心情就涨了');
  const before = st.mood.total;
  memory.append(st, 'activeTopic', '他居然把我忘了，好难过');
  ok(st.mood.total < before, '写一条坏事，心情就掉了');
  memory.append(st, 'pendingThought', '想问问他画稿进度');
  ok(st.mood.history.length === 2, '「想说没说的」不结算心情（只有话题才结算）');
}

// 5) 兼容导出：1.x 引的常量还在，且跟着 DEFAULTS 走
{
  ok(ENTRY_RANGE === DEFAULTS.entryRange, 'ENTRY_RANGE 指向 DEFAULTS');
  ok(IMPORTANT_RANGE === DEFAULTS.importantRange, 'IMPORTANT_RANGE 指向 DEFAULTS');
  ok(DIM_HALF_LIFE_OVERRIDE === DEFAULTS.dimHalfLifeOverride, 'DIM_HALF_LIFE_OVERRIDE 指向 DEFAULTS');
  ok(DIM_GAIN_SCALE === DEFAULTS.dimGainScale, 'DIM_GAIN_SCALE 指向 DEFAULTS（不再是硬编码 0.85）');
  const old = DEFAULTS.dimGainScale;
  DEFAULTS.dimGainScale = 1;
  const st = {};
  applyMoodUpdate(st, { moodDelta: 6, dims: { 开心: 10 }, reason: 'test-scale', confidence: 90 });
  ok(Math.abs(Number(ensureMood(st).dims['开心']) - 10) < 0.001, `改 DEFAULTS.dimGainScale 立刻生效（实际 ${ensureMood(st).dims['开心']}）`);
  DEFAULTS.dimGainScale = old;
}

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
