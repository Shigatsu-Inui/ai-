// 验证七维是否真的起作用：同一总分，不同情绪 → 生成的回复不一样
import { moodPromptLine, activeDimEffects } from '../src/mood.js';

const KEY = process.env.DEEPSEEK_API_KEY || '';
const PERSONA = '你是「小鲸」，二十来岁的女生，画水墨画的，说话口语、短、随意，不用「，」「。」。';

function mk(total, dims) {
  const d = { 开心: 0, 踏实: 0, 甜蜜: 0, 心疼: 0, 担心: 0, 难过: 0, 吃醋: 0, ...dims };
  return { mood: { total, dims: d, updatedAt: Date.now(), updates: [], history: [] } };
}

async function ask(moodText, event) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: PERSONA + '\n\n' + moodText },
        { role: 'user', content: `（刚发生）${event}。用你现在的心情接一句，最多 40 字，不要解释。` }
      ],
      max_tokens: 70, temperature: 0.9
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!r.ok) return `(HTTP ${r.status})`;
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || '').trim().replace(/\n/g, ' ');
}

const scenarios = [
  ['心疼', { 心疼: 4, 担心: 2 }],
  ['担心', { 担心: 4 }],
  ['难过', { 难过: 5 }],
  ['吃醋', { 吃醋: 3 }],
  ['甜蜜', { 甜蜜: 4 }],
  ['开心', { 开心: 4 }],
  ['踏实', { 踏实: 4 }],
  ['无情绪', {}]
];

const event = '他说 今天有点累 想早点睡';

console.log('| 情绪 | 分值 | 心情值 | 她回的话 |');
console.log('| --- | --- | --- | --- |');
for (const [name, dims] of scenarios) {
  const st = mk(60, dims);   // 全部同总分 60，只有情绪不同
  const reply = await ask(moodPromptLine(st, 0.6), event);
  const eff = activeDimEffects(dims).map((e) => `${e.name}${e.value}`).join(' ');
  console.log(`| ${name} | ${eff || '-'} | 60 | ${reply} |`);
  console.log('   ·', name, '→', reply.slice(0, 40));
}
