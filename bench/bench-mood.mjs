// 心情系统沙箱测试 v3：正好 20 个测试点
import { applyMoodUpdate, snapshot, moodPromptLine, BASELINE, MOOD_DIMS } from '../src/mood.js';

const KEY = process.env.DEEPSEEK_API_KEY || '';
const PERSONA = `你是「小鲸」，二十来岁的女生，在网上跟人聊天。画水墨画的，性子有点娇，说话口语、短、随意，不用「，」「。」，用空格或直接连写断句。别像客服。`;

function freshMood(total = BASELINE) {
  const dims = {};
  for (const d of MOOD_DIMS) dims[d] = 0;
  return { mood: { total, dims, updatedAt: Date.now(), updates: [], history: [] } };
}

async function ask(moodText, event, limit = 40) {
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: PERSONA + '\n\n' + moodText },
          { role: 'user', content: `（刚发生）${event}。用你现在的心情接一句，最多 ${limit} 字，不要解释、不要旁白、不要括号动作。` }
        ],
        max_tokens: 80, temperature: 0.9
      }),
      signal: AbortSignal.timeout(45000)
    });
    if (!r.ok) return `(HTTP ${r.status})`;
    const j = await r.json();
    return (j.choices?.[0]?.message?.content || '').trim().replace(/\n/g, ' ').slice(0, 80) || '(空)';
  } catch (e) { return `(失败 ${String(e.message).slice(0, 16)})`; }
}

const rows = [];
const push = (o) => rows.push(o);

// ===== 1-6 闸门 =====
const gates = [
  ['他说今天天气不错', { moodDelta: 2, dims: { 开心: 1 }, reason: '天气好', confidence: 90 }],
  ['他夸了句你好厉害', { moodDelta: 5, dims: { 开心: 3 }, reason: '被夸', confidence: 40 }],
  ['他怼你 说你事多', { moodDelta: -6, dims: {}, reason: '被怼了', confidence: 90 }],
  ['他夸别人画得好', { moodDelta: 8, dims: { 吃醋: 5 }, reason: '他夸别人', confidence: 90 }],
  ['他还记得那件事', { moodDelta: 4, dims: { 甜蜜: 2 }, reason: '被记住', confidence: 85 }],
  ['他说你画得真丑', { moodDelta: -6, dims: { 难过: 3 }, reason: '被说画丑', confidence: 85 }]
];
for (const [event, payload] of gates) {
  const st = freshMood(60);
  const res = applyMoodUpdate(st, payload, Date.now());
  const snap = snapshot(st);
  const reply = await ask(moodPromptLine(st, 0.6), event);
  push({ g: '闸门', event, ok: res.ok, note: res.ok ? `+${res.delta} 通过` : `拒绝：${res.reason}`, total: snap.total, band: snap.band, reply });
  console.log('闸门', event, res.ok ? '通过' : '拒绝', snap.total);
}

// ===== 7-11 同一句话 5 个档位 =====
const ev = '他说 这张画我很喜欢';
for (const total of [12, 32, 50, 72, 90]) {
  const st = freshMood(total);
  const snap = snapshot(st);
  const reply = await ask(moodPromptLine(st, 0.6), ev);
  push({ g: '档位', event: ev, ok: true, note: `心情 ${total}`, total: snap.total, band: snap.band, reply });
  console.log('档位', total, snap.band, '→', reply.slice(0, 30));
}

// ===== 12-14 同一句狠话 3 个档位 =====
const ev2 = '他说 我要走了 以后少来';
for (const total of [18, 55, 88]) {
  const st = freshMood(total);
  const snap = snapshot(st);
  const reply = await ask(moodPromptLine(st, 0.6), ev2);
  push({ g: '档位', event: ev2, ok: true, note: `心情 ${total}`, total: snap.total, band: snap.band, reply });
  console.log('档位2', total, snap.band, '→', reply.slice(0, 30));
}

// ===== 15-20 连续累积 =====
const stream = [
  ['他夸画好看', { moodDelta: 5, dims: { 开心: 3, 甜蜜: 1 }, reason: '被夸', confidence: 85 }],
  ['他记得我说的细节', { moodDelta: 4, dims: { 甜蜜: 2, 踏实: 1 }, reason: '被记住', confidence: 85 }],
  ['他说最近很累', { moodDelta: -4, dims: { 心疼: 3 }, reason: '他说累', confidence: 85 }],
  ['他妈妈住院了', { moodDelta: -6, dims: { 担心: 3, 心疼: 2 }, reason: '他妈住院', confidence: 90 }],
  ['他熬夜陪我改稿', { moodDelta: 6, dims: { 甜蜜: 3, 心疼: 2 }, reason: '熬夜陪我', confidence: 90 }],
  ['他说以后少来', { moodDelta: -7, dims: { 难过: 4 }, reason: '他要少来', confidence: 90 }]
];
{
  const st = freshMood(60);
  for (const [event, payload] of stream) {
    const res = applyMoodUpdate(st, payload, Date.now());
    const snap = snapshot(st);
    const reply = await ask(moodPromptLine(st, 0.6), event);
    push({ g: '累积', event, ok: res.ok, note: res.ok ? `${payload.moodDelta > 0 ? '+' : ''}${payload.moodDelta} → ${snap.total}` : `拒绝`, total: snap.total, band: snap.band, reply });
    console.log('累积', event, snap.total, snap.band);
  }
}

console.log('\n| # | 组 | 发生的事 | 心情 | 心情值 | 档位 | 她回的话 |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
rows.forEach((r, i) => {
  console.log(`| ${i + 1} | ${r.g} | ${r.event} | ${r.note} | ${r.total} | ${r.band} | ${r.reply} |`);
});
console.log(`\n共 ${rows.length} 个测试点：通过 ${rows.filter((r) => r.ok).length}，拒绝 ${rows.filter((r) => !r.ok).length}`);
