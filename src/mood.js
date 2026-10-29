/**
 * 心情系统 —— 七维情绪 + 总分
 *
 * 设计要点：
 *   1. 状态只存"当前值 + 更新时间"，衰减在读取时按时间差现算（不用定时器）
 *   2. 变化的来源是"增量"，不是"绝对值"——外部只报 +5 / -3，不能直接设成 90
 *   3. 所有阈值集中在 DEFAULTS，改行为只需要动这一个对象
 *
 * 用法：
 *   const st = {};                                    // 任意会话状态对象
 *   applyMoodUpdate(st, { moodDelta: 6, dims: { 开心: 2 }, reason: '被夸', confidence: 85 });
 *   console.log(moodPromptLine(st, 0.6));             // 拼进系统提示词
 *
 * @module mood
 */

// ============================================================
// 一、可调参数（改行为只动这里）
// ============================================================

/** 七维情绪的名字（顺序即展示顺序） */
export const MOOD_DIMS = ['开心', '踏实', '甜蜜', '心疼', '担心', '难过', '吃醋'];

/** 默认参数 */
export const DEFAULTS = {
  /** 总分基线：心情会往这里回落 */
  baseline: 60,
  /** 总分半衰期（毫秒）：12 小时 */
  halfLifeTotalMs: 12 * 60 * 60 * 1000,
  /** 单维情绪半衰期（毫秒）：90 分钟 */
  halfLifeDimMs: 90 * 60 * 1000,
  /** 个别维度的半衰期覆盖：吃醋来得快、去得也快（90 / 1.5 = 60 分钟） */
  dimHalfLifeOverride: { 吃醋: (90 * 60 * 1000) / 1.5 },
  /** 显著闸门：涨跌绝对值小于这个数就忽略 */
  minDelta: 3,
  /** 可信闸门：置信度低于这个数就忽略 */
  minConfidence: 60,
  /** 额度闸门：一天最多调整次数 */
  maxUpdatesPerDay: 10,
  /** 单维情绪的存量上限 */
  maxDimValue: 20,
  /** 模型判断在给分里的权重 */
  modelWeight: 0.7,
  /** 本地词表判断在给分里的权重 */
  wordWeight: 0.3,
  /** 合成分低于这个绝对值视为中性（不动心情） */
  neutralThreshold: 0.15,
  /** 普通条目的加减分区间（加 / 扣） */
  entryRange: { gain: [7, 8], loss: [6, 8] },
  /** 普通六维的加减分系数：整体压到 85%（实测 3.5+ 偏高，压到 ~3 以内） */

  dimGainScale: 0.85,

  /** 重要条目的加减分区间（= 普通 ×2） */
  importantRange: { gain: [14, 16], loss: [12, 16] },

  /** 加分区间（骰子 1→最小，6→最大） */
  gainRange: [5, 8],
  /** 扣分区间 */
  lossRange: [3, 5],
  /** 语气权重：心情对说话语气的影响占比 */
  toneWeight: 0.6,
  /** 简历里最多带几根情绪指令 */
  maxEffectLines: 3,
  /** 骰子表：点数 → 分数变化 */
  diceTable: { 1: 1.5, 2: 0, 3: 0, 4: 0, 5: 0, 6: -1 },
  /** 历史记录保留条数 */
  historyLimit: 50
};

// 兼容旧引用：这些常量仍然导出（2.1 起与线上桥接的 mood.js 对齐，引用 DEFAULTS，不再各存一份快照）
export const BASELINE = DEFAULTS.baseline;
export const HALF_LIFE_TOTAL_MS = DEFAULTS.halfLifeTotalMs;
export const HALF_LIFE_DIM_MS = DEFAULTS.halfLifeDimMs;
export const DIM_HALF_LIFE_OVERRIDE = DEFAULTS.dimHalfLifeOverride;
export const DIM_GAIN_SCALE = DEFAULTS.dimGainScale;   // 六维加减分统一 ×0.85
export const MIN_DELTA = DEFAULTS.minDelta;
export const MIN_CONFIDENCE = DEFAULTS.minConfidence;
export const MAX_UPDATES_PER_DAY = DEFAULTS.maxUpdatesPerDay;
export const MODEL_WEIGHT = DEFAULTS.modelWeight;
export const WORD_WEIGHT = DEFAULTS.wordWeight;
export const DICE_TABLE = DEFAULTS.diceTable;
export const ENTRY_RANGE = DEFAULTS.entryRange;
export const IMPORTANT_RANGE = DEFAULTS.importantRange;

const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================
// 二、状态
// ============================================================

/**
 * 确保 `st.mood` 存在且字段完整（幂等）。
 * @param {object} st 会话状态对象
 * @returns {object} 补齐后的 mood 对象
 */
export function ensureMood(st) {
  if (!st || typeof st !== 'object') throw new TypeError('ensureMood: st 必须是对象');
  if (!st.mood || typeof st.mood !== 'object') {
    st.mood = { total: DEFAULTS.baseline, dims: Object.create(null), updatedAt: Date.now(), history: [], updates: [] };
  }
  const m = st.mood;
  if (!Number.isFinite(Number(m.total))) m.total = DEFAULTS.baseline;
  if (!m.dims || typeof m.dims !== 'object') m.dims = Object.create(null);
  for (const d of MOOD_DIMS) if (!Number.isFinite(Number(m.dims[d]))) m.dims[d] = 0;
  if (!Array.isArray(m.updates)) m.updates = [];
  if (!Array.isArray(m.history)) m.history = [];
  if (!Number.isFinite(Number(m.updatedAt))) m.updatedAt = Date.now();
  return m;
}

/**
 * 半衰期衰减：总分向基线回落，单维向 0 回落。
 * 会就地修改 `st.mood` 并把 `updatedAt` 推到现在。
 * @param {object} st 会话状态
 * @param {number} [now] 当前时间戳
 * @returns {object} mood 对象
 */
export function decayMood(st, now = Date.now()) {
  const m = ensureMood(st);
  const elapsed = Math.max(0, now - Number(m.updatedAt || now));
  if (elapsed < 60 * 1000) return m;   // 一分钟内的抖动不衰减，避免频繁计算
  const totalK = Math.pow(0.5, elapsed / DEFAULTS.halfLifeTotalMs);
  m.total = round1(clamp(DEFAULTS.baseline + (Number(m.total) - DEFAULTS.baseline) * totalK, 0, 100));
  const dimK = Math.pow(0.5, elapsed / DEFAULTS.halfLifeDimMs);
  for (const d of MOOD_DIMS) {
    // 吃醋这类维度的半衰期可以被覆盖（来得快、去得也快）
    const hl = Number(DEFAULTS.dimHalfLifeOverride?.[d]) || DEFAULTS.halfLifeDimMs;
    const k = hl === DEFAULTS.halfLifeDimMs ? dimK : Math.pow(0.5, elapsed / hl);
    m.dims[d] = round1(Number(m.dims[d] || 0) * k);
  }
  m.updatedAt = now;
  return m;
}

// ============================================================
// 三、档位
// ============================================================

/**
 * 总分 → 档位（五档）。
 * @param {number} total 0~100
 * @returns {{name:string, hint:string, len:string}} 档位信息
 */
export function moodBand(total) {
  const t = Number(total) || 0;
  if (t >= 80) return { name: '欢喜', hint: '心情很好：可以多说两句（20~40 字），带语气词，愿意主动延伸话题，甚至可以主动关心对方', len: '20~40 字' };
  if (t >= 60) return { name: '平稳', hint: '正常状态：10~20 字，有事说事，不冷不热', len: '10~20 字' };
  if (t >= 40) return { name: '低落', hint: '有点提不起劲：8~15 字，少用语气词，不主动延伸，对方问什么答什么', len: '8~15 字' };
  if (t >= 20) return { name: '沉', hint: '不太想说话：只能 3~8 个字，几乎不用语气词，别反问、别关心对方、别加戏', len: '3~8 字' };
  return { name: '闷', hint: '心里堵着：3~6 个字，冷、短、敷衍，最多一个"嗯/哦"，不要任何解释', len: '3~6 字' };
}

// ============================================================
// 四、七维情绪的行为指令
// ============================================================

/**
 * 每根情绪超过阈值后对应的行为倾向。
 * 这些文字会直接拼进提示词，所以写成"祈使句 + 具体动作"。
 */
export const DIM_EFFECTS = {
  开心: { min: 1.5, line: '心情是往上走的：可以主动多说一句、接梗、语气轻快，愿意分享自己刚想到的事。' },
  踏实: { min: 1.5, line: '心里是稳的：说话笃定、不飘，答应的事愿意明确接下来，不敷衍。' },
  甜蜜: { min: 1.5, line: '有点被哄软了：语气可以软一点、多用语气词，允许一点点撒娇，但别腻。' },
  心疼: { min: 1.5, line: '在心疼对方：会想问问对方还好吗、吃饭了没、别硬撑；可以主动关心，但别连环追问。' },
  担心: { min: 1.5, line: '有点担心：会多确认一句"真的没事吗""到了说一声"，但别唠叨。' },
  难过: { min: 1.5, line: '心里发沉：话会更少、更容易只回一两个字，不太想接梗；可以冷一点，别硬演开心。' },
  吃醋: { min: 0.9, line: '有点吃味：说话会带一点刺、阴阳、酸话，或者故意表现得不在意；但别真吵起来。' }
};

/**
 * 取当前生效的情绪指令（按强度降序，最多 maxEffectLines 条）。
 * @param {Record<string, number>} dims 七维情绪
 * @returns {Array<{name:string, value:number, line:string}>}
 */
export function activeDimEffects(dims) {
  const list = [];
  for (const [name, cfg] of Object.entries(DIM_EFFECTS)) {
    const v = Number(dims?.[name] || 0);
    if (v >= cfg.min) list.push({ name, value: round1(v), line: cfg.line });
  }
  return list.sort((a, b) => b.value - a.value).slice(0, DEFAULTS.maxEffectLines);
}

// ============================================================
// 五、更新心情（四道闸门）
// ============================================================

/**
 * 应用一次心情变化。所有外部输入都必须经过这里。
 *
 * @param {object} st 会话状态
 * @param {object} payload
 * @param {number} payload.moodDelta 总分变化（或传 delta）
 * @param {Record<string, number>} [payload.dims] 具体哪几根情绪动了
 * @param {string} [payload.reason] 为什么变（用于去重）
 * @param {number} [payload.confidence] 把握程度 0~100
 * @param {number} [now] 当前时间戳
 * @param {object} [opts]
 * @param {boolean} [opts.countsQuota=true] 是否占用每日额度
 * @param {boolean} [opts.skipSignificance=false] 是否跳过"显著"闸门
 * @returns {{ok:boolean, reason?:string, delta?:number, mood:object}}
 */
export function applyMoodUpdate(st, payload = {}, now = Date.now(), opts = {}) {
  const m = ensureMood(st);
  decayMood(st, now);

  const rawDelta = Number(payload.moodDelta ?? payload.delta ?? 0);
  const dims = payload.dims && typeof payload.dims === 'object' ? payload.dims : {};
  const reason = String(payload.reason ?? '').slice(0, 120);
  const confidence = Number(payload.confidence ?? 0);

  const rejected = (why) => ({ ok: false, reason: why, mood: snapshot(st, now) });

  // 闸门 1：显著
  if (!opts.skipSignificance && (!Number.isFinite(rawDelta) || Math.abs(rawDelta) < DEFAULTS.minDelta)) {
    return rejected(`涨跌 ${rawDelta} 不到 ${DEFAULTS.minDelta}，不够显著`);
  }
  // 闸门 2：可信
  if (!Number.isFinite(confidence) || confidence < DEFAULTS.minConfidence) {
    return rejected(`置信度 ${confidence} 低于 ${DEFAULTS.minConfidence}`);
  }
  // 闸门 3：额度
  const countsQuota = opts.countsQuota !== false;
  m.updates = (Array.isArray(m.updates) ? m.updates : []).filter((u) => now - Number(u.at || 0) < DAY_MS);
  if (countsQuota && m.updates.length >= DEFAULTS.maxUpdatesPerDay) {
    return rejected(`今天已经调过 ${m.updates.length} 次心情，到额度了`);
  }
  // 闸门 4：去重
  if (reason && m.updates.some((u) => u.reason === reason)) {
    return rejected('这个理由今天已经用过一次了');
  }

  // 吃醋：单次加分 ×2 且最多 +2，总分也最多 +2
  let delta = rawDelta;
  const dimEntries = [];
  for (const [k, v] of Object.entries(dims)) {
    if (!MOOD_DIMS.includes(k)) continue;
    let val = Number(v);
    if (!Number.isFinite(val) || val === 0) continue;
    // 其余六维统一压到 85%（吃醋有自己的 ×2 规则，不参与）
    if (k !== '吃醋') val = round1(val * DEFAULTS.dimGainScale);
    if (k === '吃醋') {
      // 吃醋：单次加分 ×2（最多 +2），总分也最多 +2
      val = Math.min(2, Math.max(0, val * 2));
      if (delta > 0) delta = Math.min(2, delta);
    }
    dimEntries.push([k, val]);
  }

  const before = Number(m.total);
  m.total = clamp(before + delta, 0, 100);
  for (const [k, v] of dimEntries) {
    m.dims[k] = clamp(Number(m.dims[k] || 0) + v, 0, DEFAULTS.maxDimValue);
  }
  m.updatedAt = now;
  if (countsQuota) m.updates.push({ at: now, delta, reason, confidence, dims: Object.fromEntries(dimEntries) });
  m.updates = m.updates.slice(-DEFAULTS.maxUpdatesPerDay);
  m.history.push({ at: now, before, after: m.total, delta, reason });
  m.history = m.history.slice(-DEFAULTS.historyLimit);
  return { ok: true, delta, mood: snapshot(st, now) };
}

// ============================================================
// 六、快照与提示词
// ============================================================

/**
 * 心情快照（只读，不改变语义）。
 * @param {object} st 会话状态
 * @param {number} [now]
 * @returns {{total:number, band:string, hint:string, dims:Record<string,number>,
 *            top:Array<{d:string,v:number}>, effects:Array<object>, updatedAt:number}}
 */
export function snapshot(st, now = Date.now()) {
  const m = ensureMood(st);
  decayMood(st, now);
  const band = moodBand(m.total);
  const top = MOOD_DIMS
    .map((d) => ({ d, v: round1(Number(m.dims[d] || 0)) }))
    .filter((x) => x.v >= 0.5)
    .sort((a, b) => b.v - a.v)
    .slice(0, 3);
  return {
    total: round1(m.total),
    band: band.name,
    hint: band.hint,
    dims: Object.fromEntries(MOOD_DIMS.map((d) => [d, round1(Number(m.dims[d] || 0))])),
    top,
    effects: activeDimEffects(m.dims),
    updatedAt: m.updatedAt
  };
}

/**
 * 生成一段可以直接拼进系统提示词的心情说明。
 * @param {object} st 会话状态
 * @param {number} [toneWeight=0.6] 心情对语气的影响占比
 * @returns {string}
 */
export function moodPromptLine(st, toneWeight = DEFAULTS.toneWeight) {
  const s = snapshot(st);
  const band = moodBand(s.total);
  const topText = s.top.length ? `（当下最明显的是：${s.top.map((x) => `${x.d}${x.v}`).join('、')}）` : '';
  const pct = Math.round(toneWeight * 100);
  const effects = s.effects.length
    ? '\n现在的情绪（这几根在起作用，要照做）：\n' + s.effects.map((e) => `· ${e.name} ${e.value}：${e.line}`).join('\n')
    : '';
  return `【你现在的心情】总心情 ${s.total}/100，档位「${s.band}」${topText}
怎么说话：${band.hint}。这条要求**字数也要照做**（${band.len}）。${effects}
**优先级**：档位给的是基础语气，**具体情绪优先于档位**——两者冲突时，按上面那几条情绪指令做。
**底线（最高优先级，任何情况都不能破）**：你还是角色卡里那个人。性格、说话习惯、口癖、立场、称呼方式、世界观，一样都不许改。
心情只能调三样东西：**长短、热度、愿不愿意多说**。不能因为心情差就变成另一个人（不能突然毒舌/冷漠/温柔/文艺，除非角色卡本来就这样），也不能因为心情好就丢口癖。
**语气权重 ${pct}%**：心情影响的是"这句话的语气强弱"（${pct}%），不是"你是谁"——人格永远 100% 按角色卡来。
心情低就短、就敷衍、可以不热情、可以不接梗；心情好就多说两句、可以主动。
**标点**：还是不用逗号和句号；要停顿、转折、补充，就发下一条。
**线上**：还是网友聊天，别写「过来」「我给你倒茶」「坐我旁边」这种要人在跟前的话；亲近靠记得和主动，不靠场景。但**失望也要用角色卡里那种失望法**，别演成通用 AI 的丧。`;
}

// ============================================================
// 七、条目给分（0.7 模型 + 0.3 词表 → 骰子定幅度）
// ============================================================

/** 正面词表（命中加分） */
const GOOD_WORDS = ['夸', '好看', '喜欢', '好听', '谢谢', '甜', '陪', '记得', '想你', '开心', '厉害', '进步',
  '辛苦', '可爱', '棒', '温柔', '感动', '答应了', '说好', '约定', '关心', '舍不得', '心疼'];

/** 负面词表（命中扣分） */
const BAD_WORDS = ['丑', '骂', '怼', '敷衍', '没回', '不理', '忘了', '冷落', '烦', '滚', '讨厌', '失望',
  '生气', '难过', '哭', '嫌弃', '嫌', '事多', '少来', '不回', '难受', '伤了', '别人', '其他人'];

/**
 * 本地词表打分：命中正负词，归一化到 -1~+1。
 * @param {string} text
 * @returns {{score:number, pos:number, neg:number}}
 */
export function wordScore(text) {
  const s = String(text ?? '');
  let pos = 0;
  let neg = 0;
  for (const w of GOOD_WORDS) if (s.includes(w)) pos++;
  for (const w of BAD_WORDS) if (s.includes(w)) neg++;
  const total = pos + neg;
  if (!total) return { score: 0, pos, neg };
  return { score: (pos - neg) / total, pos, neg };
}

/**
 * 骰子定幅度：点数越小幅度越小，点数越大幅度越大。
 * @param {number} sign 1=加分 / -1=扣分
 * @param {number} [strength=1] 信号强度 0~1，弱信号会被压缩
 * @returns {{die:number, value:number, base:number}}
 */
export function rollMagnitude(sign, strength = 1) {
  const die = 1 + Math.floor(Math.random() * 6);
  const f = (die - 1) / 5;
  const [lo, hi] = sign > 0 ? DEFAULTS.gainRange : DEFAULTS.lossRange;
  const base = lo + f * (hi - lo);
  const k = 0.5 + 0.5 * Math.max(0, Math.min(1, strength));
  const v = base * k;
  return { die, value: round1(v), base: round1(base) };
}

/**
 * 综合评分一条记忆：0.7 × 模型判断 + 0.3 × 本地词表，幅度由骰子决定。
 * @param {string} text 记忆内容
 * @param {number} [modelScore] 模型按人设给的分数 -10~+10（不给则用本地判断顶替）
 * @returns {{delta:number, combined:number, die:number, local:object, kind:'good'|'bad'|'neutral'}}
 */
export function scoreEntryMood(text, modelScore, opts = {}) {
  const local = wordScore(text);
  const modelNorm = Number.isFinite(Number(modelScore))
    ? Math.max(-1, Math.min(1, Number(modelScore) / 10))
    : local.score;
  const combined = DEFAULTS.modelWeight * modelNorm + DEFAULTS.wordWeight * local.score;
  if (Math.abs(combined) < DEFAULTS.neutralThreshold) {
    return { delta: 0, combined: round2(combined), die: 0, local, kind: 'neutral' };
  }
  const sign = combined > 0 ? 1 : -1;
  const range = opts.important ? DEFAULTS.importantRange : DEFAULTS.entryRange;
  const [lo, hi] = sign > 0 ? range.gain : range.loss;
  // 区间内随机取一个值（普通条目 加 +7~8 / 扣 -6~8；重要条目 ×2）
  const magnitude = lo + Math.random() * (hi - lo);
  return {
    delta: round1(sign * magnitude),
    combined: round2(combined),
    die: 0,
    local,
    kind: sign > 0 ? 'good' : 'bad'
  };
}

// ============================================================
// 七点五、条目自动结算（2.1：和线上"写一条记忆就拨一下心情"一致）
// ============================================================

/** 条目里的好事词（命中即 +1，不看程度） */
const ENTRY_POS_WORDS = [
  '夸', '好看', '喜欢', '好听', '谢谢', '甜', '陪', '记得', '想你', '开心', '厉害', '进步',
  '辛苦', '可爱', '棒', '温柔', '感动', '认真了', '答应了', '说好', '约定', '关心'
];
/** 条目里的坏事词（命中即 -1） */
const ENTRY_NEG_WORDS = [
  '丑', '骂', '怼', '敷衍', '没回', '不理', '忘了', '冷落', '烦', '滚', '讨厌', '失望',
  '生气', '难过', '哭', '嫌弃', '嫌', '事多', '少来', '不回', '难受', '伤了'
];

/**
 * 只看条目文本判好坏（本地词表，不花 token）。
 * @param {string} text
 * @returns {{delta:number, pos:number, neg:number, kind:'good'|'bad'|'neutral'|'tie'}}
 */
export function judgeEntryMood(text) {
  const s = String(text ?? '');
  let pos = 0; let neg = 0;
  for (const w of ENTRY_POS_WORDS) if (s.includes(w)) pos++;
  for (const w of ENTRY_NEG_WORDS) if (s.includes(w)) neg++;
  if (pos === 0 && neg === 0) return { delta: 0, pos, neg, kind: 'neutral' };
  if (pos > neg) return { delta: 5 + Math.floor(Math.random() * 4), pos, neg, kind: 'good' };
  if (neg > pos) return { delta: -(3 + Math.floor(Math.random() * 3)), pos, neg, kind: 'bad' };
  return { delta: 0, pos, neg, kind: 'tie' };
}

/**
 * 按命中的词把情绪分到具体的几维上（七维才有意义；分不到就返回空对象）。
 * @param {string} text
 * @param {'good'|'bad'|string} kind
 * @returns {Record<string, number>}
 */
export function pickEntryDims(text, kind) {
  const s = String(text ?? '');
  const has = (...ws) => ws.some((w) => s.includes(w));
  if (kind === 'bad') {
    if (has('住院', '生病', '手术', '累', '辛苦', '熬夜', '不舒服', '发烧')) return { 心疼: 3, 担心: 2 };
    if (has('没回', '不回', '冷落', '敷衍', '忘了', '少来', '不理')) return { 难过: 3, 担心: 1 };
    if (has('别人', '其他', '她')) return { 吃醋: 3 };
    if (has('骂', '怼', '丑', '嫌', '事多', '烦', '讨厌', '滚')) return { 难过: 2, 吃醋: 1 };
    return { 难过: 2 };
  }
  if (kind === 'good') {
    if (has('记得', '答应', '说好', '约定', '陪')) return { 甜蜜: 2, 踏实: 2 };
    if (has('夸', '好听', '厉害', '好看', '棒', '进步', '可爱')) return { 开心: 3, 甜蜜: 1 };
    if (has('谢', '感动', '辛苦', '舍不得', '心疼')) return { 开心: 2, 甜蜜: 2 };
    return { 开心: 2 };
  }
  return {};
}

/**
 * 记完一条记忆，顺手拨一下心情（本地判定，不调模型）。
 *
 * 和 `applyMoodUpdate` 的区别：这里**不占每日额度、不走去重、跳过显著闸门**，
 * 因为"每条记忆都带一点情绪"是主线的常态，不该被那几道闸卡住（和线上一致）。
 *
 * @param {object} st 会话状态（心情挂在 st.mood 上）
 * @param {string} text 记忆内容
 * @param {{modelScore?:number, important?:boolean, countsQuota?:boolean}} [o]
 *   `modelScore` 是模型按人设给的 -10~10；不给就只用本地词表
 * @returns {{delta:number, combined?:number, local?:object, kind:string, applied:boolean,
 *            dims?:Record<string,number>, mood?:object, reason?:string}}
 * @example
 * // 配合 createMemory：写入即结算
 * const memory = createMemory({ settleMood: (st, text, extra, { important }) =>
 *   settleEntryMood(st, text, { modelScore: extra.moodScore, important }) });
 */
export function settleEntryMood(st, text, o = {}) {
  const j = scoreEntryMood(text, o.modelScore, { important: o.important === true });
  if (!j.delta) return { ...j, applied: false, reason: '中性，不动心情' };
  const dims = pickEntryDims(text, j.kind);
  const res = applyMoodUpdate(st, {
    moodDelta: j.delta,
    dims,
    reason: `条目#${j.kind}#${String(text).slice(0, 24)}`,
    confidence: 85
  }, Date.now(), { countsQuota: o.countsQuota === true, skipSignificance: true });
  return { ...j, dims, applied: res.ok === true, mood: res.mood, reason: res.ok ? undefined : res.reason };
}

// ============================================================
// 八、随机心情（骰子）
// ============================================================

/**
 * 掷一次骰子。
 * @returns {{value:number, delta:number}} 点数与对应分数变化
 */
export function rollDice() {
  const value = 1 + Math.floor(Math.random() * 6);
  const delta = DEFAULTS.diceTable[value] ?? 0;
  return { value, delta };
}

/**
 * 掷骰子并直接把结果落到心情上（不走显著性闸门）。
 * @param {object} st 会话状态
 * @param {number} [now]
 * @returns {{value:number, delta:number, changed:boolean, mood:object}}
 */
export function applyDiceDelta(st, now = Date.now()) {
  const m = ensureMood(st);
  decayMood(st, now);
  const { value, delta } = rollDice();
  if (!delta) return { value, delta: 0, changed: false, mood: snapshot(st, now) };
  const before = Number(m.total);
  m.total = clamp(before + delta, 0, 100);
  m.updatedAt = now;
  m.history.push({ at: now, before, after: m.total, delta, reason: `骰子 ${value}`, dice: value });
  m.history = m.history.slice(-DEFAULTS.historyLimit);
  return { value, delta, changed: true, mood: snapshot(st, now) };
}

// ============================================================
// 九、内部工具
// ============================================================

/** @param {number} n @param {number} lo @param {number} hi */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(n) || 0));
}

/** 保留 1 位小数 */
function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/** 保留 2 位小数 */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
