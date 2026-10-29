// 游戏接入层（2.0 新增）：把「泰拉瑞亚/任意有状态文件的游戏」里发生的事，变成记忆条目 + 一行提示词，
// 并把她的决定写回游戏。
//
// 设计约束（和整个包一致）：零依赖、纯本地、不调模型、不联网。
// 这一层只做"翻译"：游戏状态 → 事件 → 记忆；她的意图 → 游戏指令。
// 它不判断"该不该说话"以外的任何事，也不碰 LLM。
import { applyMoodUpdate } from './mood.js';

/**
 * 游戏指令白名单：只允许"慢决策"，永远不下"往左走三格"这种实时操作。
 * 2.1 起和游玩端（game-bridge 的 protocol ACTIONS）对齐，共 14 个分类；
 * 分类的中文名与同义说法见 `src/skills.js` 的 `GAME_SKILL_ACTION_NAMES`。
 */
export const GAME_ACTIONS = [
  'idle', 'follow', 'explore', 'attack', 'come', 'mine',
  'dig', 'chop', 'recall', 'craft', 'place', 'chest', 'use', 'say'
];

export const GAME_DEFAULTS = {
  /** 游戏名 —— 会作为"游戏 key"打在每一条游戏记忆上：聊天里提到它，这些条目一起加权、更容易被想起 */
  game: '泰拉瑞亚',
  /** 血低于这个比例才算"她该担心一下" */
  lowHpRatio: 0.3,
  /** 玩家多久不动算挂机 */
  idleMs: 5 * 60 * 1000,
  /** 同类事件的最小间隔（冷却），避免一件事被反复写进记忆 */
  cooldowns: {
    playerDied: 10 * 60 * 1000,
    lowHp: 5 * 60 * 1000,
    bossSpawn: 30 * 60 * 1000,
    bossDefeated: 10 * 60 * 1000,
    nightFell: 120 * 60 * 1000,
    newBiome: 5 * 60 * 1000,
    foundLoot: 20 * 60 * 1000,
    idle: 15 * 60 * 1000
  },
  /** 一小时内最多写几条（记忆不是日志，写太密会把真正的记忆挤掉） */
  maxEventsPerHour: 20,
  /** 打赢 Boss 自动标成"重要的事"（长期记得） */
  importantOnBossWin: true,
  /** 事件是否顺带拨一下心情；关掉就只记记忆 */
  mood: true,
  /** 指令默认多久过期（毫秒），过期后游戏侧不会再执行 */
  commandTtlMs: 8000
};

const DEFAULT_BIOME = '未知地带';

/** 小工具：把数字夹在区间里 */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(n) || 0));
}

/** 小工具：把可能为空的字符串收拾干净 */
function text(v, fallback = '') {
  const s = String(v ?? '').trim();
  return s || fallback;
}

/**
 * 纯函数：比较前后两帧快照，产出"发生了什么"。
 *
 * 只认事实，不做判断（"她该不该说话"交给调用方 / 导演层）。
 *
 * @param {object|null} prev 上一帧（第一帧传 null）
 * @param {object} next 这一帧
 * @param {object} [opts] 见 GAME_DEFAULTS
 * @returns {Array<{kind:string, at:number, biome?:string, boss?:string, hp?:number, maxHp?:number, player?:string, item?:string}>}
 */
export function classify(prev, next, opts = {}) {
  const o = { ...GAME_DEFAULTS, ...opts };
  const out = [];
  if (!next || typeof next !== 'object') return out;
  const at = Number(next.ts) || Date.now();
  const player = next.player && typeof next.player === 'object' ? next.player : {};
  const prevPlayer = prev && prev.player && typeof prev.player === 'object' ? prev.player : null;
  const biome = text(player.biome, prevPlayer ? text(prevPlayer.biome, DEFAULT_BIOME) : DEFAULT_BIOME);
  const playerName = text(player.name, '你');

  // 1) 死亡：只看"从活着变成死"，避免一帧内重复触发
  const nowDead = player.dead === true || (Number(player.hp) <= 0 && Number(player.maxHp) > 0);
  const wasDead = prevPlayer ? (prevPlayer.dead === true || (Number(prevPlayer.hp) <= 0 && Number(prevPlayer.maxHp) > 0)) : false;
  if (nowDead && !wasDead) out.push({ kind: 'playerDied', at, biome, player: playerName });

  // 2) 低血：跨过阈值那一刻才算
  const maxHp = Number(player.maxHp) || 0;
  const hp = Number(player.hp);
  if (maxHp > 0 && Number.isFinite(hp) && !nowDead) {
    const ratio = hp / maxHp;
    const prevRatio = prevPlayer && Number(prevPlayer.maxHp) > 0 ? Number(prevPlayer.hp) / Number(prevPlayer.maxHp) : 1;
    if (ratio <= clamp(o.lowHpRatio, 0, 1) && prevRatio > clamp(o.lowHpRatio, 0, 1)) {
      out.push({ kind: 'lowHp', at, biome, hp, maxHp, player: playerName });
    }
  }

  // 3) 游戏自己报的事件（模组里直接 append 的增量事件，最准）
  if (Array.isArray(next.events)) {
    for (const ev of next.events) {
      const kind = text(ev && ev.kind);
      const evAt = Number(ev && ev.at) || at;
      if (kind === 'bossSpawn') out.push({ kind, at: evAt, biome, boss: text(ev.name, 'Boss'), player: playerName });
      else if (kind === 'bossDefeated') out.push({ kind, at: evAt, biome, boss: text(ev.name, 'Boss'), player: playerName });
      else if (kind === 'foundLoot') out.push({ kind, at: evAt, biome, item: text(ev.name, '一样好东西'), player: playerName });
      else if (kind === 'playerDied' && !out.some((x) => x.kind === 'playerDied')) out.push({ kind, at: evAt, biome, player: playerName });
    }
  }

  // 4) 入夜（从白天进夜晚）
  if (prev && prev.day === true && next.day === false) out.push({ kind: 'nightFell', at, biome, player: playerName });

  // 5) 换地形
  if (prevPlayer && text(player.biome) && text(player.biome) !== text(prevPlayer.biome)) {
    out.push({ kind: 'newBiome', at, biome, player: playerName });
  }

  return out;
}

/**
 * 纯函数：一个事件 → 一条记忆条目该长什么样（内部实现，不打游戏 key）。
 *
 * 文本刻意保持"稳定"：同样的地方反复死会得到同一句话，
 * 记忆层的 append 会把它们合并成一条并累加 mentions —— 不用这里自己数。
 *
 * @param {object} ev classify() 的产物
 * @param {object} [opts]
 * @returns {{category:string, content:string, extra:object, mood:object|null}|null}
 */
function entryOf(ev, opts = {}) {
  const o = { ...GAME_DEFAULTS, ...opts };
  if (!ev || !ev.kind) return null;
  const who = text(ev.player, '你');
  const where = text(ev.biome, DEFAULT_BIOME);
  switch (ev.kind) {
    case 'playerDied':
      return {
        category: 'activeTopic',
        content: `和${who}在${where}玩，${who}被打死了`,
        extra: { keys: [where], participants: [who] },
        mood: { moodDelta: -4, dims: { 担心: 1.5 }, reason: `${who}在${where}死了`, confidence: 80 }
      };
    case 'lowHp':
      return {
        category: 'activeTopic',
        content: `和${who}在${where}，${who}血只剩 ${Math.round(Number(ev.hp) || 0)}/${Math.round(Number(ev.maxHp) || 0)}`,
        extra: { keys: [where], participants: [who] },
        mood: { moodDelta: -2, dims: { 担心: 1 }, reason: `${where}血线很低`, confidence: 70 }
      };
    case 'bossSpawn':
      return {
        category: 'activeTopic',
        content: `${where}刷出了${text(ev.boss, 'Boss')}，和${who}一起打`,
        extra: { keys: [text(ev.boss, 'Boss')], participants: [who] },
        mood: { moodDelta: 2, dims: { 开心: 0.8 }, reason: `要打${text(ev.boss, 'Boss')}了`, confidence: 70 }
      };
    case 'bossDefeated': {
      const boss = text(ev.boss, 'Boss');
      return {
        category: 'activeTopic',
        content: `和${who}一起打赢了${boss}`,
        extra: { keys: [boss], participants: [who], important: o.importantOnBossWin === true },
        mood: { moodDelta: 8, dims: { 开心: 2.5, 踏实: 1 }, reason: `打赢了${boss}`, confidence: 85 }
      };
    }
    case 'nightFell':
      return {
        category: 'activeTopic',
        content: `${where}天黑了，${who}还在外面`,
        extra: { keys: [where], participants: [who] },
        mood: { moodDelta: 0, dims: { 担心: 0.8 }, reason: '入夜了', confidence: 60 }
      };
    case 'newBiome':
      return {
        category: 'activeTopic',
        content: `跟${who}跑到了${where}`,
        extra: { keys: [where], participants: [who] },
        mood: { moodDelta: 2, dims: { 开心: 0.6 }, reason: `到了${where}`, confidence: 65 }
      };
    case 'foundLoot':
      return {
        category: 'activeTopic',
        content: `在${where}翻到了${text(ev.item, '好东西')}`,
        extra: { keys: [where], participants: [who] },
        mood: { moodDelta: 3, dims: { 开心: 1 }, reason: `找到了${text(ev.item, '好东西')}`, confidence: 65 }
      };
    case 'idle':
      return {
        category: 'pendingThought',
        content: `想问${who}还玩不玩了，半天没动`,
        extra: { motivation: 'sociability', expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
        mood: null
      };
    default:
      return null;
  }
}

/**
 * 一个事件 → 一条记忆条目（对外入口）。
 *
 * 除了事件本身，还会打上 **游戏 key**（`extra.gameKey` = 游戏名）：
 * 以后聊天里只要提到这个游戏名，这条记忆就一起加权、更容易被想起来 ——
 * 不用你复述"昨天打的那局"，提一句游戏名就够了。
 *
 * @param {object} ev classify() 的产物
 * @param {object} [opts] 见 GAME_DEFAULTS（`game` 决定游戏 key 的内容）
 * @returns {{category:string, content:string, extra:object, mood:object|null}|null}
 */
export function eventToEntry(ev, opts = {}) {
  const entry = entryOf(ev, opts);
  if (!entry) return null;
  const game = text({ ...GAME_DEFAULTS, ...opts }.game, '');
  if (game) entry.extra = { ...(entry.extra || {}), gameKey: game };
  return entry;
}

/**
 * 把一帧快照压成**一行**提示词（游戏状态塞进 prompt 会占 token，所以必须短）。
 *
 * @param {object} snap 状态快照
 * @returns {string} 例：`【泰拉】你在地下丛林 血 78/100（祀 92/120，跟着你）附近 3 只怪：史莱姆×2、蝙蝠`
 */
export function promptLine(snap) {
  if (!snap || typeof snap !== 'object') return '';
  const player = snap.player && typeof snap.player === 'object' ? snap.player : {};
  const shi = snap.shi && typeof snap.shi === 'object' ? snap.shi : {};
  const bits = [];
  const name = text(player.name, '你');
  const where = text(player.biome, '');
  bits.push(where ? `${name}在${where}` : name);
  const hp = Number(player.hp);
  const maxHp = Number(player.maxHp);
  if (Number.isFinite(hp) && maxHp > 0) bits.push(`血 ${Math.round(hp)}/${Math.round(maxHp)}`);
  if (shiOnField(shi)) {
    const shpHp = Number(shi.hp);
    const shMax = Number(shi.maxHp);
    const state = text(shi.state, '');
    const hpText = Number.isFinite(shpHp) && shMax > 0 ? ` ${Math.round(shpHp)}/${Math.round(shMax)}` : '';
    bits.push(`祀${hpText}${state ? `（${state === 'follow' ? '跟着你' : state}）` : ''}`);
  }
  const nearby = Array.isArray(snap.nearby) ? snap.nearby.filter((n) => n && n.hostile !== false) : [];
  if (nearby.length) {
    const counts = new Map();
    for (const n of nearby) {
      const nm = text(n.name, '怪物');
      counts.set(nm, (counts.get(nm) || 0) + 1);
    }
    const list = [...counts.entries()].slice(0, 3).map(([nm, c]) => (c > 1 ? `${nm}×${c}` : nm));
    bits.push(`附近 ${nearby.length} 只怪：${list.join('、')}${counts.size > 3 ? '…' : ''}`);
  }
  if (player.dead === true) bits.push('（你刚死了）');
  return `【泰拉】${bits.join(' ')}`;
}

/** 她这个分身到底在不在场上（缺字段时按 active 判断） */
function shiOnField(shi) {
  if (!shi || typeof shi !== 'object') return false;
  if (shi.active === false) return false;
  return shi.active === true || Number(shi.hp) > 0 || shi.state != null;
}

/**
 * 创建游戏接入器。
 *
 * @param {object} options
 * @param {object} options.memory `createMemory()` 的返回值
 * @param {object} [options.state] 会话状态（记忆/心情都挂在这上面，和聊天共用一份）
 * @param {object} [options.opts] 见 GAME_DEFAULTS
 * @param {() => number} [options.now] 取当前时间（测试可注入）
 * @returns {{
 *   ingest: (snap: object) => {events: object[], entries: object[], promptLine: string},
 *   promptLine: (snap: object) => string,
 *   command: (action: string, extra?: object) => object,
 *   classify: (prev: object|null, next: object) => object[]
 * }}
 */
export function createTerrariaCompanion(options = {}) {
  const memory = options.memory;
  if (!memory || typeof memory.append !== 'function') throw new TypeError('createTerrariaCompanion: 需要传入 createMemory() 的返回值');
  const state = options.state && typeof options.state === 'object' ? options.state : {};
  const o = { ...GAME_DEFAULTS, ...(options.opts || {}) };
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  let prev = null;
  const lastFired = new Map(); // kind → at
  const fired = [];             // 最近一小时的触发时间（限流用）
  let lastPos = null;
  let lastMoveAt = now();
  let idleReported = false;
  let seq = 0;

  /** 限流：冷却 + 每小时上限 */
  function allowed(ev, at) {
    const cd = Number(o.cooldowns?.[ev.kind]) || 0;
    // 从没触发过的事件不能被「最后一次发生在 0 点」挡住
    if (cd > 0 && lastFired.has(ev.kind) && at - lastFired.get(ev.kind) < cd) return false;
    const hourAgo = at - 60 * 60 * 1000;
    const recent = fired.filter((t) => t > hourAgo).length;
    if (recent >= Number(o.maxEventsPerHour || 20)) return false;
    return true;
  }

  /** 挂机检测：位置没变超过 idleMs 就提醒一次，动一下就复位 */
  function trackIdle(snap, at) {
    const p = snap && snap.player && typeof snap.player === 'object' ? snap.player : null;
    if (!p) return null;
    const pos = `${Number(p.tileX) || 0},${Number(p.tileY) || 0}`;
    if (pos !== lastPos) {
      lastPos = pos;
      lastMoveAt = at;
      idleReported = false;
      return null;
    }
    if (!idleReported && Number(o.idleMs) > 0 && at - lastMoveAt >= Number(o.idleMs)) {
      idleReported = true;
      return { kind: 'idle', at, biome: text(p.biome, DEFAULT_BIOME), player: text(p.name, '你') };
    }
    return null;
  }

  /**
   * 吃一帧快照：识别事件 → 冷却/限流 → 写进记忆（可选拨心情）。
   * @param {object} snap
   * @returns {{events: object[], entries: object[], promptLine: string}}
   */
  function ingest(snap) {
    const at = Number(snap && snap.ts) || now();
    const events = classify(prev, snap, o);
    const idle = trackIdle(snap, at);
    if (idle) events.push(idle);

    const entries = [];
    for (const ev of events) {
      if (!allowed(ev, ev.at || at)) continue;
      const entry = eventToEntry(ev, o);
      if (!entry) continue;
      lastFired.set(ev.kind, ev.at || at);
      fired.push(ev.at || at);
      const written = memory.append(
        state,
        entry.category,
        entry.content,
        // keyReuse：游戏记忆里"蜂王"这种核心词在多条里共存是正常的，不要为了避重把 key 扩成怪词
        { keyReuse: true, ...entry.extra },
        'terraria'
      );
      if (written) entries.push(written);
      if (o.mood && entry.mood && typeof applyMoodUpdate === 'function') {
        try { applyMoodUpdate(state, entry.mood, at); } catch { /* 心情被闸门拒了不算错 */ }
      }
    }

    // 事件是"增量"的：读走就清，避免下一次快照重复处理
    if (snap && Array.isArray(snap.events) && snap.events.length) snap.events.length = 0;
    prev = snap;
    return { events, entries, promptLine: promptLine(snap) };
  }

  /**
   * 她的决定 → 游戏指令对象（调用方负责把它写进 cmd.json）。
   * 动作必须在白名单里，说的话语义交给记忆层，这里只夹长度。
   */
  function command(action, extra = {}) {
    const act = text(action);
    if (!GAME_ACTIONS.includes(act)) throw new TypeError(`command: 动作必须是 ${GAME_ACTIONS.join(' / ')}`);
    seq += 1;
    const tile = extra.targetTile && Number.isFinite(Number(extra.targetTile.x)) && Number.isFinite(Number(extra.targetTile.y))
      ? { x: Math.max(0, Math.round(Number(extra.targetTile.x))), y: Math.max(0, Math.round(Number(extra.targetTile.y))) }
      : null;
    return {
      seq,
      action: act,
      targetIdx: Number.isFinite(Number(extra.targetIdx)) ? Number(extra.targetIdx) : -1,
      ...(tile ? { targetTile: tile } : {}),
      say: extra.say == null ? '' : String(extra.say).slice(0, 200),
      expireMs: Math.max(0, Number(extra.expireMs) || Number(o.commandTtlMs) || 0)
    };
  }

  return { ingest, promptLine, command, classify: (a, b) => classify(a, b, o) };
}

/**
 * 读一帧状态文件（游戏写、我们读）。读坏了就返回 null —— 游戏那边正在写盘的时候很常见，
 * 下一次轮询会读到完整的。
 *
 * @param {string} file
 * @param {{fs?: object, retries?: number, retryDelayMs?: number}} [opts]
 * @returns {object|null}
 */
export function readStateFile(file, opts = {}) {
  const fsMod = opts.fs; // 注入 node:fs，测试不必碰真磁盘
  if (!fsMod || typeof fsMod.readFileSync !== 'function') return null;
  try {
    const raw = fsMod.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    // 半截文件 / 文件还没生成，都当"这帧不算"——下一次轮询会读到完整的
    return null;
  }
}

/**
 * 轮询状态文件（默认真实 fs，需要外部传 node:fs）。
 * 返回一个 stop()。
 *
 * @param {string} file
 * @param {object} opts
 * @param {object} opts.fs node:fs
 * @param {(snap: object) => void} opts.onState
 * @param {number} [opts.intervalMs]
 * @param {(err: Error) => void} [opts.onError]
 * @returns {() => void}
 */
export function watchStateFile(file, opts = {}) {
  const fsMod = opts.fs;
  if (!fsMod || typeof fsMod.watchFile !== 'function') throw new TypeError('watchStateFile: 需要传 { fs }（node:fs）');
  const onState = opts.onState;
  if (typeof onState !== 'function') throw new TypeError('watchStateFile: 需要传 { onState }');
  const interval = Math.max(16, Number(opts.intervalMs) || 100);
  const listener = () => {
    const snap = readStateFile(file, { fs: fsMod, retries: 1 });
    if (snap) {
      try { onState(snap); } catch (err) { if (opts.onError) opts.onError(err); }
    }
  };
  fsMod.watchFile(file, { interval, persistent: false }, listener);
  listener(); // 先读一次，别等第一次变化
  return () => { try { fsMod.unwatchFile(file, listener); } catch { /* 已经停了 */ } };
}

// ── 游戏记忆"收据"（2.1）─────────────────────────────────────────────────
// 和技能库不是一回事：这里记的是**发生过的事**（阵亡、打赢 Boss、挖到矿），
// 要进「重要/近期话题」、要按标签能被聊天想起来，同一件事只写一次、只结算一次心情。
// 技能记的是**学到的本事**，见 src/skills.js。

/** 游戏记忆默认挂的标签（= 游戏名） */
export const GAME_TAG = '泰拉瑞亚';

/** 把字符串转义成正则字面量（拼 topicId 的校验用） */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把一条游戏事件写成**带标签的记忆条目**（同一事件重复调用只加 occurrence，不会堆条、不会重复结算心情）。
 *
 * 相比直接 `memory.append`，它多做了四件事：
 *   1. **事件去重**：`gameEventIds` 里已有的 eventId 直接返回 `duplicate:true`；
 *   2. **标签**：`tags: ['泰拉瑞亚', …]`、`gameId`、`narrator:'self'`、`gamePlayer`；
 *   3. **同类合并**：同一个 `gameTopicId` 只占一条，`gameOccurrences` 累加，正文里写"共 N 次"；
 *   4. **心情收据**：传了 `opts.settleMood` 就只在**首次建档**时调它一次，把结算结果记进 `gameMoodReceipt`。
 *
 * @param {object} memory `createMemory()` 的返回值
 * @param {object} st 会话状态（记忆就挂在这上面）
 * @param {string} content 一句话描述发生了什么
 * @param {{gameTopicId:string, gameEventId:string, tags?:string[], keys?:string[], participants?:string[],
 *          important?:boolean, gameKind?:string, gamePlayer?:object}} extra
 *   `gameTopicId` 形如 `terraria:<稳定 id>`，`gameEventId` 是这次事件的唯一 id —— 两个都必填
 * @param {{gameId?:string, gameTag?:string, scopeKey?:string, save?:Function,
 *          settleMood?:(entry:object, info:{text:string, important:boolean}) => object|null}} [opts]
 * @returns {{ok:boolean, handled:boolean, created?:boolean, duplicate?:boolean, entry?:object,
 *            occurrences?:number, mood?:object|null}} `handled:false` 表示这条不是游戏事件，调用方自己走普通 append
 */
export function appendGameMemory(memory, st, content, extra = {}, opts = {}) {
  if (!extra?.gameTopicId) return { ok: false, handled: false };
  if (!memory || typeof memory.append !== 'function') throw new TypeError('appendGameMemory: 需要传 createMemory() 的返回值');
  const gameId = String(opts.gameId || 'terraria');
  const gameTag = String(opts.gameTag || GAME_TAG);
  const topicId = String(extra.gameTopicId);
  const eventId = String(extra.gameEventId || '');
  if (!new RegExp(`^${escapeRe(gameId)}:[\\w:-]{1,120}$`).test(topicId)) throw new Error('Invalid game memory receipt.');
  if (!/^[\w:-]{1,120}$/.test(eventId)) throw new Error('Invalid game memory receipt.');

  const entries = [...(st.activeTopics || []), ...(st.importantTopics || [])];
  let entry = entries.find((t) => t && t.gameTopicId === topicId);
  const save = typeof opts.save === 'function' ? opts.save : () => {};
  const tag = (item) => {
    item.tags = [...new Set([gameTag, ...(Array.isArray(item.tags) ? item.tags : []), ...(Array.isArray(extra.tags) ? extra.tags : [])]
      .filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 40)))].slice(0, 32);
    item.gameId = gameId;
    item.narrator = 'self';
    item.gamePlayer = extra.gamePlayer && typeof extra.gamePlayer === 'object' ? extra.gamePlayer : { kind: 'game', gameId };
    if (Array.isArray(extra.participants) && extra.participants.length) item.participants = extra.participants;
  };

  // 同一事件重复到达（重试/多端）：只补齐标签，不重复写、不重复结算
  if (entry?.gameEventIds?.includes(eventId)) {
    if (!entry.tags?.includes(gameTag) || entry.gameId !== gameId || entry.narrator !== 'self') { tag(entry); save(); }
    return { ok: true, handled: true, duplicate: true, entry, occurrences: Number(entry.gameOccurrences) || 1 };
  }

  const count = (Number(entry?.gameOccurrences) || 0) + 1;
  let sentence = String(content ?? '').trim().slice(0, 200);
  if (extra.gameKind === 'playerDied') sentence = sentence.replace('阵亡了一次', `阵亡了${count}次`);
  else if (count > 1) sentence = sentence.replace(/[。.]$/, '') + `（这次共${count}次）。`;

  let created = false;
  let mood = null;
  if (!entry) {
    const written = memory.append(st, 'activeTopic', sentence,
      { keys: extra.keys, participants: extra.participants, important: extra.important === true }, opts.scopeKey || '');
    // 记忆引擎可能按文本合并到已有条目；只在文本确实对得上时才认领，避免把别的条目改成游戏记忆
    const norm = typeof memory.norm === 'function' ? memory.norm : (s) => String(s ?? '').trim();
    entry = [...(st.activeTopics || []), ...(st.importantTopics || [])]
      .find((t) => t && String(t.text) === sentence)
      || (written && norm(written.text) === norm(sentence) ? written : null);
    if (!entry) throw new Error('Existing memory engine did not retain the game topic.');
    entry.gameTopicId = topicId;
    created = true;
    if (typeof opts.settleMood === 'function') {
      try { mood = opts.settleMood(entry, { text: sentence, important: extra.important === true }) || null; } catch { mood = null; }
      if (mood) entry.gameMoodReceipt = mood;
    }
  } else {
    entry.text = sentence;
    entry.lastMentionAt = Date.now();
    // 同一段经历仍然只算一条话题，不反复结算心情
  }
  entry.gameOccurrences = count;
  tag(entry);
  entry.gameEventIds = [...(entry.gameEventIds || []), eventId].slice(-128);
  save();
  return { ok: true, handled: true, created, duplicate: false, entry, occurrences: count, mood };
}

/**
 * 一条游戏记忆的"收据"：这条还在不在、收了哪几个事件、结算过几次心情。
 * 调用方拿它回执给游戏端，比"我以为写进去了"可靠。
 *
 * @param {object} st
 * @param {{topicId:string, eventId?:string, gameTag?:string}} opts
 * @returns {{retained:boolean, topicId:string, eventId?:string, eventRecorded?:boolean,
 *            tags?:string[], gameId?:string, occurrences?:number, recordedEvents?:number,
 *            important?:boolean, settlementCount?:number, lastSettlement?:object|null}}
 */
export function gameMemoryReceipt(st, { topicId = '', eventId = '', gameTag = GAME_TAG } = {}) {
  const entry = [...(st?.activeTopics || []), ...(st?.importantTopics || [])].find((t) => t && t.gameTopicId === topicId);
  if (!entry) return { retained: false, topicId, eventId };
  const settlements = (st?.mood?.history || []).filter((item) => String(item.reason || '').startsWith('条目#')
    && String(item.reason).endsWith(String(entry.text).slice(0, 24)));
  const latest = settlements.at(-1);
  return {
    retained: true,
    topicId,
    eventId,
    eventRecorded: entry.gameEventIds?.includes(eventId) === true,
    tags: entry.tags || [],
    gameId: entry.gameId,
    occurrences: Number(entry.gameOccurrences) || 0,
    recordedEvents: entry.gameEventIds?.length || 0,
    important: entry.important === true,
    settlementCount: entry.gameMoodReceipt?.settlementCount ?? settlements.length,
    lastSettlement: entry.gameMoodReceipt ? entry.gameMoodReceipt.lastSettlement : (latest ? { at: latest.at, before: latest.before, after: latest.after, delta: latest.delta } : null)
  };
}

/**
 * 给提示词补标签：①在已渲染的记忆行后面加【标签：…】；②这一轮上下文提到游戏名时，
 * 把带游戏标签、但没被核心词召回的条目补最多 8 条进来。
 *
 * @param {object} st
 * @param {string} formatted `memory.format(st, ctx)` 的结果
 * @param {{tag?:string, context?:string, gameTag?:string}} [opts] `tag` 给了就只按这个标签过滤
 * @returns {string}
 */
export function formatGameMemoryTags(st, formatted, { tag = '', context = '', gameTag = GAME_TAG } = {}) {
  const topics = [...(st?.activeTopics || []), ...(st?.importantTopics || [])];
  let result = String(formatted || '').split('\n').map((line) => {
    const entry = topics.find((t) => t.text && line.includes('- ' + t.text) && Array.isArray(t.tags) && t.tags.length);
    if (!entry) return line;
    const tags = entry.tags.filter((t) => typeof t === 'string').map((t) => t.replace(/[\r\n<>]/g, '').slice(0, 40)).join('、');
    return line.replace(entry.text, entry.text + `【标签：${tags}】`);
  }).join('\n');
  const normalized = String(context).toLowerCase();
  const aliases = { [gameTag]: [gameTag, gameTag.slice(0, 2), 'terraria'] };
  const matches = topics.filter((entry) => Array.isArray(entry.tags) && entry.tags.some((label) => !tag
    ? (aliases[label] || [String(label).toLowerCase()]).some((alias) => normalized.includes(alias))
    : label === tag))
    .sort((a, b) => (Number(b.lastMentionAt) || Number(b.createdAt) || 0) - (Number(a.lastMentionAt) || Number(a.createdAt) || 0));
  const extra = matches.filter((entry) => entry.text && !result.includes(entry.text)).slice(0, 8);
  if (extra.length) {
    result += '\n【游戏相关记忆 · 按标签召回】\n'
      + extra.map((entry) => '- ' + entry.text + '【标签：' + entry.tags.map(String).join('、') + '】').join('\n');
  }
  return result;
}
