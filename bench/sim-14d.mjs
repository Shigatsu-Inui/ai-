// 14 天连续模拟（重做版）：先生成事件，再按时间轴重放+采样
import fs from 'node:fs';
import { applyMoodUpdate, decayMood, BASELINE, MOOD_DIMS } from '../src/mood.js';

const DAY_MS = 24 * 3600 * 1000;
const start = new Date('2026-10-12T08:00:00+08:00').getTime();
const DAYS = 14;

let seed = 20261026;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }

const GOOD = ['他夸画好看', '他记得我说的细节', '他熬夜陪我改稿', '他说想听我讲故事', '他把我画印成明信片', '他夸声音好听', '他主动来找我说话', '他说这周不忙陪我聊', '他记得我生日快到了', '他夸我这次进步很大'];
const BAD = ['他说画得丑', '他两天没回消息', '他敷衍我一句哦', '他怼我说我事多', '他夸别人画更好', '他忘了我们的约定', '他说以后少来这个群', '他嫌我话多'];

// ---- 1) 生成事件 ----
const events = [];
let eid = 0;
for (let d = 0; d < DAYS; d++) {
  const dayStart = start + d * DAY_MS;
  const sessions = [[10, 20], [14, 40], [20, 10], [22, 50]].slice(0, 3 + (rnd() < 0.4 ? 1 : 0));
  for (const [h, m] of sessions) {
    const at0 = dayStart + (h * 60 + m) * 60 * 1000;
    const n = rnd() < 0.15 ? 0 : Math.floor(rnd() * 3) + 1;
    for (let k = 0; k < n; k++) {
      const good = rnd() < 0.62;
      const text = good ? pick(GOOD) : pick(BAD);
      const delta = good ? 5 + Math.floor(rnd() * 4) : -(3 + Math.floor(rnd() * 3));
      const dims = good
        ? (text.includes('夸') ? { 开心: 3, 甜蜜: 2 } : { 甜蜜: 2, 踏实: 1 })
        : { 难过: 2 };
      events.push({ id: eid++, at: at0 + k * 90 * 1000, delta, dims, text, good });
    }
  }
}
events.sort((a, b) => a.at - b.at);

// ---- 2) 重放 + 每 20 分钟采样 ----
const st = { mood: { total: BASELINE, dims: Object.fromEntries(MOOD_DIMS.map((d) => [d, 0])), updatedAt: start, updates: [], history: [] } };
const fine = [];
let ei = 0;
const endAt = start + DAYS * DAY_MS;
for (let ts = start; ts <= endAt; ts += 20 * 60 * 1000) {
  // 先把这一格内到点的事件都应用（带真实时间戳，衰减自然发生）
  while (ei < events.length && events[ei].at <= ts) {
    const e = events[ei];
    decayMood(st, e.at);
    const res = applyMoodUpdate(st, { moodDelta: e.delta, dims: e.dims, reason: e.text + '#' + e.id, confidence: 85 }, e.at);
    e.ok = res.ok;
    e.appliedAt = e.at;
    e.totalAfter = res.mood ? res.mood.total : snapshotTotal(st, e.at);
    ei++;
  }
  decayMood(st, ts);
  fine.push({ at: ts, total: round1(st.mood.total) });
}
function snapshotTotal(state, ts) { decayMood(state, ts); return round1(state.mood.total); }
function round1(n) { return Math.round(n * 10) / 10; }

// ---- 3) 统计 ----
const daily = [];
for (let d = 0; d < DAYS; d++) {
  const s = start + d * DAY_MS;
  const e = s + DAY_MS;
  const evs = events.filter((x) => x.at >= s && x.at < e && x.ok !== false);
  const net = evs.reduce((a, b) => a + b.delta, 0);
  const dayPts = fine.filter((p) => p.at >= s && p.at < e);
  daily.push({ day: d + 1, count: evs.length, net, end: dayPts.length ? dayPts[dayPts.length - 1].total : 60, min: Math.min(...dayPts.map((p) => p.total)), max: Math.max(...dayPts.map((p) => p.total)) });
}

fs.writeFileSync(new URL('./mood-sim.json', import.meta.url),
  JSON.stringify({ start, days: DAYS, fine, events, daily }), 'utf8');

console.log('| 天 | 条目数 | 净变化 | 当天区间 | 当天结束 |');
console.log('| --- | --- | --- | --- | --- |');
for (const d of daily) console.log(`| 第 ${d.day} 天 | ${d.count} | ${d.net > 0 ? '+' : ''}${d.net} | ${d.min}~${d.max} | ${d.end} |`);
const totals = fine.map((p) => p.total);
const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
console.log(`\n最低 ${Math.min(...totals)} 最高 ${Math.max(...totals)} 均值 ${mean.toFixed(1)}`);
console.log(`85+ 占比 ${((totals.filter((x) => x >= 85).length / totals.length) * 100).toFixed(1)}%`);
console.log(`95+ 占比 ${((totals.filter((x) => x >= 95).length / totals.length) * 100).toFixed(1)}%`);
console.log(`<40 占比 ${((totals.filter((x) => x < 40).length / totals.length) * 100).toFixed(1)}%`);
console.log('事件数:', events.length, '取样点:', fine.length);
