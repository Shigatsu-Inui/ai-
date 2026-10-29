// 30 天连续模拟：每天聊 1~2 小时
// 模型：每天 2 个时段（下午+晚上），每个时段 40~80 分钟，期间每 45 分钟投一次骰子
// 每个时段结束（睡前总结）产生 2~5 条条目，按好坏加减心情
import fs from 'node:fs';
import { applyMoodUpdate, applyDiceDelta, decayMood, snapshot, BASELINE, MOOD_DIMS } from '../src/mood.js';

const DAY_MS = 24 * 3600 * 1000;
const start = new Date('2026-10-26T13:00:00+08:00').getTime();
const DAYS = 30;

let seed = 8848;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
function randInt(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }

const GOOD = ['他夸画好看', '他记得我说的细节', '他熬夜陪我改稿', '他说想听我讲故事', '他把我画印成明信片', '他夸声音好听', '他主动来找我说话', '他说这周不忙陪我聊', '他记得我生日快到了', '他夸我这次进步很大'];
const BAD = ['他说画得丑', '他两天没回消息', '他敷衍我一句哦', '他怼我说我事多', '他夸别人画更好', '他忘了我们的约定', '他说以后少来这个群', '他嫌我话多'];

const st = { mood: { total: BASELINE, dims: Object.fromEntries(MOOD_DIMS.map((d) => [d, 0])), updatedAt: start, updates: [], history: [] } };

const events = [];   // 条目事件
let sessionCount = 0;
let msgCount = 0;

for (let d = 0; d < DAYS; d++) {
  const dayStart = start + d * DAY_MS;
  // 每天 2 个时段：下午 14:00 前后、晚上 21:00 前后（偶尔只聊一场 = 1 小时）
  const sessions = rnd() < 0.35 ? [[21, 10]] : [[14, 20], [21, 10]];
  for (const [h, m] of sessions) {
    sessionCount++;
    const at0 = dayStart + (h * 60 + m) * 60 * 1000;
    const minutes = randInt(40, 80);          // 一场 40~80 分钟
    msgCount += Math.round(minutes * 0.9);    // 每分钟约 0.9 条消息
    // 会话中间投骰子（每 45 分钟一次，至少一次）
    const rolls = Math.max(1, Math.floor(minutes / 45) + (rnd() < 0.5 ? 1 : 0));
    for (let r = 0; r < rolls; r++) events.push({ kind: 'dice', at: at0 + r * 45 * 60 * 1000 });
    // 睡前总结：2~5 条条目
    const n = randInt(2, 5);
    for (let k = 0; k < n; k++) {
      const good = rnd() < 0.6;
      const delta = good ? 5 + Math.floor(rnd() * 4) : -(3 + Math.floor(rnd() * 3));
      events.push({
        kind: 'entry', at: at0 + minutes * 60 * 1000 + k * 60 * 1000,
        delta, text: good ? GOOD[Math.floor(rnd() * GOOD.length)] : BAD[Math.floor(rnd() * BAD.length)],
        dims: good ? { 开心: 2, 甜蜜: 1 } : { 难过: 2 }
      });
    }
  }
}
events.sort((a, b) => a.at - b.at);

// 重放 + 10 分钟采样
const fine = [];
let ei = 0;
const endAt = start + DAYS * DAY_MS;
for (let ts = start; ts <= endAt; ts += 10 * 60 * 1000) {
  while (ei < events.length && events[ei].at <= ts) {
    const e = events[ei];
    if (e.kind === 'entry') applyMoodUpdate(st, { moodDelta: e.delta, dims: e.dims, reason: e.text + '#' + ei, confidence: 85 }, e.at);
    else applyDiceDelta(st, e.at);
    ei++;
  }
  decayMood(st, ts);
  fine.push({ at: ts, total: Math.round(st.mood.total * 10) / 10 });
}

// 每天统计
const daily = [];
for (let d = 0; d < DAYS; d++) {
  const s = start + d * DAY_MS;
  const pts = fine.filter((p) => p.at >= s && p.at < s + DAY_MS).map((p) => p.total);
  const evs = events.filter((e) => e.at >= s && e.at < s + DAY_MS && e.kind === 'entry');
  daily.push({ day: d + 1, min: Math.min(...pts), max: Math.max(...pts), avg: +(pts.reduce((a, b) => a + b, 0) / pts.length).toFixed(1), entries: evs.length, net: evs.reduce((a, b) => a + b.delta, 0) });
}

fs.writeFileSync(new URL('./mood-sim30.json', import.meta.url),
  JSON.stringify({ start, days: DAYS, fine, daily, events }, null, 0), 'utf8');

const totals = fine.map((p) => p.total);
const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
console.log(`30 天模拟：会话 ${sessionCount} 场，消息 ≈${msgCount} 条，条目 ${events.filter((e) => e.kind === 'entry').length} 条，骰子 ${events.filter((e) => e.kind === 'dice').length} 次`);
console.log(`心情：最低 ${Math.min(...totals)} 最高 ${Math.max(...totals)} 均值 ${mean.toFixed(1)}`);
console.log(`85+ ${((totals.filter((x) => x >= 85).length / totals.length) * 100).toFixed(1)}%  95+ ${((totals.filter((x) => x >= 95).length / totals.length) * 100).toFixed(1)}%  <40 ${((totals.filter((x) => x < 40).length / totals.length) * 100).toFixed(1)}%`);
console.log('每天均值: 收到 ' + (msgCount / DAYS).toFixed(0) + ' 条消息 / ' + (sessionCount / DAYS).toFixed(1) + ' 场会话');
