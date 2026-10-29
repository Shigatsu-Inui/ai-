// 真机接入示例：盯着游戏写的 state.json，把事件变成记忆，并把她的指令写回 cmd.json。
//
// 游戏侧（模组）要做的只有两件事：每 100ms 写 state.json、每 100ms 读 cmd.json。
// 这个脚本负责中间那层：状态 → 记忆 → 指令。
//
//   node examples/terraria-bridge.mjs --state "%USERPROFILE%\Documents\TerrariaCompanion\state.json" \
//        --cmd "%USERPROFILE%\Documents\TerrariaCompanion\cmd.json" \
//        --save memory-state.json
//
// 参数：
//   --state   游戏写的状态文件（必填）
//   --cmd     要写给游戏的指令文件（可选，不填就只读不写）
//   --save    记忆/心情的状态文件（可选；填了就能跨次重启记住）
//   --interval 轮询间隔，默认 100ms
import fs from 'node:fs';
import path from 'node:path';
import { createMemory, createTerrariaCompanion, watchStateFile } from '../src/index.js';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const stateFile = arg('state');
if (!stateFile) {
  console.error('用法：node examples/terraria-bridge.mjs --state <state.json> [--cmd <cmd.json>] [--save <memory.json>]');
  process.exit(1);
}
const cmdFile = arg('cmd');
const saveFile = arg('save');
const intervalMs = Number(arg('interval')) || 100;

// 记忆状态：能从硬盘续上就续上，省得每次重启都失忆
let state = {};
if (saveFile && fs.existsSync(saveFile)) {
  try { state = JSON.parse(fs.readFileSync(saveFile, 'utf8')); } catch { state = {}; }
}

const memory = createMemory({ log: (m) => console.log(m) });
const companion = createTerrariaCompanion({ memory, state });

let saveTimer = null;
function persist() {
  if (!saveFile) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const dir = path.dirname(path.resolve(saveFile));
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${saveFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, saveFile); // 先写 .tmp 再改名，中途挂掉也不会留下半个文件
    } catch (err) {
      console.error('[记忆] 存盘失败（不影响游戏）：', err?.message ?? err);
    }
  }, 500);
}

function sendCommand(command) {
  if (!cmdFile) return;
  try {
    const dir = path.dirname(path.resolve(cmdFile));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${cmdFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(command), 'utf8');
    fs.renameSync(tmp, cmdFile);
    console.log(`  → 写给游戏：${command.action}${command.say ? `（${command.say}）` : ''}`);
  } catch (err) {
    console.error('[指令] 写失败（不影响游戏）：', err?.message ?? err);
  }
}

console.log(`盯着 ${stateFile}（每 ${intervalMs}ms）…  Ctrl+C 退出`);

const stop = watchStateFile(stateFile, {
  fs,
  intervalMs,
  onState: (snap) => {
    if (snap && snap.inGame === false) return;
    const r = companion.ingest(snap);
    if (r.entries.length) {
      console.log(`\n[${new Date().toLocaleTimeString()}] ${r.promptLine}`);
      for (const e of r.entries) console.log(`  ✎ ${e.text}　〔${(e.keys || []).join(' / ')}〕`);
      persist();
      // 只是示例：这一层负责"该不该动"，动作本身还是白名单里的慢决策
      if (snap.player?.dead) sendCommand(companion.command('come'));
    }
  },
  onError: (err) => console.error('[轮询] 出错但不致命：', err?.message ?? err)
});

process.on('SIGINT', () => {
  stop();
  if (saveFile) {
    try { fs.writeFileSync(saveFile, JSON.stringify(state, null, 2), 'utf8'); } catch { /* 最后一次存盘失败就算了 */ }
  }
  console.log('\n收工。');
  process.exit(0);
});
