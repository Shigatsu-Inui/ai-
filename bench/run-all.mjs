/**
 * 测试运行器：跑所有纯本地测试，有失败就以非 0 退出（CI 用）。
 *
 *   node bench/run-all.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TESTS = [
  ['记忆核心行为', 'test-memory.mjs'],
  ['记忆召回 51 样本', 'bench-recall.mjs'],
  ['过期约定淘汰', 'bench-evict.mjs'],
  ['骰子分布', 'bench-dice.mjs'],
  ['游戏接入层（泰拉瑞亚）', 'test-terraria.mjs'],
  ['游戏技能库', 'test-skills.mjs'],
  ['条目自动结算心情', 'test-mood-entry.mjs']
];

let failed = 0;
for (const [name, file] of TESTS) {
  const script = fileURLToPath(new URL(file, import.meta.url));
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  const out = (r.stdout || '').trim().split('\n').filter(Boolean);
  const tail = out.slice(-2).join(' | ') || '(无输出)';
  if (r.status === 0) {
    console.log(`✅ ${name}：${tail}`);
  } else {
    failed++;
    console.log(`❌ ${name}（退出码 ${r.status}）：${tail}`);
    if (r.stderr) console.log('   ' + r.stderr.trim().split('\n').slice(-4).join('\n   '));
  }
}
console.log(failed ? `\n${failed} 个测试失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
