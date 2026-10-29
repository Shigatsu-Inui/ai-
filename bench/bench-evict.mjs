import { createMemory } from '../src/memory.js';

const mem = createMemory({ limit: (n, d) => d });

const st = { activeTopics: [], importantTopics: [], pendingThoughts: [], memberImpressions: {} };
const mk = (text, keys, daysAgo, important = true) => {
  const e = mem.append(st, 'activeTopic', text, { keys, important });
  e.createdAt = Date.now() - daysAgo * 86400000;
  e.lastMentionAt = e.createdAt;
  return e;
};

const expired = mk('约好 2026年10月11日 交画稿', ['画稿'], 30);
const fresh1 = mk('他家人住院了 要做手术', ['住院'], 1);
const fresh2 = mk('他生日是 3 月 14 日 别忘了', ['生日'], 5);

const isExpired = (e) => {
  const dl = mem.deadlineOf(e);
  return dl > 0 && dl < Date.now();
};

let pass = 0;
const total = 4;

const t1 = isExpired(expired);
console.log((t1 ? '✅' : '❌') + ' 过期约定识别（日期已过去）');
if (t1) pass++;

const t2 = !isExpired(fresh1) && !isExpired(fresh2);
console.log((t2 ? '✅' : '❌') + ' 未过期的不误判');
if (t2) pass++;

const t3 = mem.isAgreement('约好 2026年10月11日 交画稿');
console.log((t3 ? '✅' : '❌') + ' 约定识别（含「约好」）');
if (t3) pass++;

const t4 = !mem.isAgreement('他家人住院了 要做手术');
console.log((t4 ? '✅' : '❌') + ' 非约定不误判为约定');
if (t4) pass++;

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
