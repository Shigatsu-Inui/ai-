// 骰子沙箱测试：分布 + 长期漂移 + 和条目打分共存时的效果
import { rollDice, applyDiceDelta, applyMoodUpdate, snapshot, BASELINE, MOOD_DIMS } from '../src/mood.js';

function fresh(total = BASELINE) {
  return { mood: { total, dims: Object.fromEntries(MOOD_DIMS.map((d) => [d, 0])), updatedAt: Date.now(), updates: [], history: [] } };
}

// 1) 分布测试（1 万次）
const N = 10000;
const cnt = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
let sum = 0;
for (let i = 0; i < N; i++) {
  const r = rollDice();
  cnt[r.value]++;
  sum += r.delta;
}
console.log('=== 1 万次投掷分布 ===');
console.log('| 点数 | 次数 | 占比 | 分数变化 |');
console.log('| --- | --- | --- | --- |');
const table = { 1: '+1.5', 2: '不动', 3: '不动', 4: '不动', 5: '不动', 6: '-1' };
for (const v of [1, 2, 3, 4, 5, 6]) {
  console.log(`| ${v} | ${cnt[v]} | ${(cnt[v] / N * 100).toFixed(2)}% | ${table[v]} |`);
}
console.log(`\n平均每次变化：${(sum / N).toFixed(3)} 分（理论值 +0.083）`);

// 2) 长期漂移（只有骰子，没有条目）
const st = fresh(60);
const DAY = 24 * 3600 * 1000;
const start = Date.now();
const perDay = 32;  // 45 分钟一次 ≈ 32 次/天
const trace = [];
for (let d = 0; d < 14; d++) {
  for (let k = 0; k < perDay; k++) {
    applyDiceDelta(st, start + d * DAY + k * 45 * 60 * 1000);
  }
  const snap = snapshot(st, start + d * DAY + DAY - 1);
  trace.push({ day: d + 1, total: snap.total });
}
console.log('\n=== 只有骰子、14 天 ===');
console.log('| 天 | 心情 |');
console.log('| --- | --- |');
for (const x of trace) console.log(`| 第 ${x.day} 天 | ${x.total} |`);

// 3) 骰子 + 条目打分共存
const st2 = fresh(60);
const events = [
  { day: 0, at: 10, delta: 6, dims: { 开心: 3 } },
  { day: 0, at: 15, delta: -4, dims: { 难过: 2 } },
  { day: 1, at: 10, delta: 7, dims: { 甜蜜: 3 } },
  { day: 1, at: 20, delta: 5, dims: { 开心: 2 } },
  { day: 2, at: 11, delta: -5, dims: { 难过: 3 } },
  { day: 2, at: 19, delta: 8, dims: { 开心: 4 } },
  { day: 3, at: 14, delta: 6, dims: { 甜蜜: 2 } },
  { day: 3, at: 21, delta: -3, dims: { 难过: 1 } }
];
let ei = 0;
const t2 = [];
for (let step = 0; step < 4 * 24 * 4; step++) {
  const ts = start + step * 15 * 60 * 1000;
  while (ei < events.length) {
    const e = events[ei];
    const at = start + e.day * DAY + e.at * 3600 * 1000;
    if (at > ts) break;
    applyMoodUpdate(st2, { moodDelta: e.delta, dims: e.dims, reason: `ev${ei}`, confidence: 85 }, at);
    ei++;
  }
  if (step % 32 === 0) applyDiceDelta(st2, ts);
  t2.push({ step, total: snapshot(st2, ts).total });
}
const totals = t2.map((x) => x.total);
console.log('\n=== 骰子 + 条目打分（4 天）===');
console.log(`最低 ${Math.min(...totals)} 最高 ${Math.max(...totals)} 结束 ${totals[totals.length - 1]}`);
