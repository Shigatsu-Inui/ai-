// 记忆系统（可独立使用）：双容器 + 权重衰减 + 核心词召回 + 过期约定优先淘汰
//
// 2.1 起与线上桥接的实现（qq-bridge 的 appendMemoryV2 / ageMemoryV2 / formatMemoryV2）**逐条对齐**：
//   - 普通话题有容量上限（默认 20 条，按权重淘汰最弱的），不再无限增长
//   - 新条目按词表自动判重要性（约定/纪念日/住院…），标明 important 的进「重要的事」
//   - 重要条目有每日配额（默认 10 条）：超了不是拒收，而是把当天最弱的降级回普通话题
//   - 群友印象有寿命：老的按权重淘汰、长期不聊的人自动清掉
//   - 同一条反复说，key 不会再被自己的旧 key 改形（「火锅」不会变成「天火锅」）
//   - 支持脱敏、码点安全截断、落盘配额（snapshot）、按标签查询/删除/清空
//   - 写入可选自动结算心情（`opts.settleMood`，配合 src/mood.js 的 settleEntryMood）
//
// 容器结构（和聊天桥接共用同一个状态对象）：
//   st.activeTopics / st.importantTopics / st.pendingThoughts / st.memberImpressions / st.gameSkills
import { formatGameSkills } from './skills.js';

/**
 * 码点安全截断：`slice` 会把 emoji 切成半个代理对，这里不会。
 * （判据与 qq-bridge/src/md-to-plain.js 的 truncateText 一致）
 * @param {*} value
 * @param {number} max 最大码点长度
 * @returns {string}
 */
export function truncateText(value, max) {
  const s = String(value ?? '');
  const cap = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : 0;
  if (cap === 0) return '';
  if (s.length <= cap) return s;
  let cut = cap;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // 切在高代理上：前移一个码元
  if (cut <= 0) {
    const first = s.charCodeAt(0);
    const second = s.charCodeAt(1);
    cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
  }
  return s.slice(0, cut);
}

export function createMemory(opts = {}) {
  // 配置读取：必须在 (0, hi] 之间，否则回落到默认值（防止 0 / 负数 / 9999 这类值把提示词撑爆）
  const limitFn = typeof opts.limit === 'function' ? opts.limit : (name, def) => def;
  const limit = (name, def, hi = 500) => {
    const raw = Number(limitFn(name, def));
    return Number.isFinite(raw) && raw > 0 ? Math.min(hi, Math.round(raw)) : def;
  };
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  /** 脱敏钩子：把已知的 token/key 换成 ***，默认原样返回 */
  const redact = typeof opts.redact === 'function' ? opts.redact : (v) => String(v ?? '');
  /** 截断钩子：默认码点安全 */
  const cut = typeof opts.truncate === 'function' ? opts.truncate : truncateText;
  const DAY_MS = 24 * 60 * 60 * 1000;

  // ---------- 游戏 key（2.0） ----------
  // 一条记忆可以额外挂一个"游戏 key"（内容就是游戏名，比如「泰拉瑞亚」）。
  // 聊天里提到这个游戏名时，所有带这个 key 的条目一起加权、一起更容易被命中 ——
  // 这样"昨天打的那局"不用复述细节，提一句游戏名就能翻出来。
  const GAME_KEY_BOOST = 1.5;     // 提及时权重乘这个数（排序和回填都会占先）
  const GAME_KEY_PROB = 0.8;      // 只靠游戏名被召回的保底概率（不是必中，免得一嘴游戏名把整本流水账倒出来）

  // ---------- 配置 ----------
  function ageCfg() {
    const a = opts.age || {};
    const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
    const decay = (Array.isArray(a.decay) && a.decay.length ? a.decay : [
      { days: 1, weight: 1 }, { days: 2, weight: 0.8 }, { days: 3, weight: 0.6 }, { days: 4, weight: 0.5 }
    ]).map((d) => ({ days: Math.max(0, Number(d?.days) || 0), weight: Math.min(1, Math.max(0, Number(d?.weight) || 0)) }))
      .sort((x, y) => x.days - y.days);
    return {
      decay,
      freshMs: num(a.freshDays, 3) * DAY_MS,
      pruneTopicMs: num(a.pruneTopicDays, 3) * DAY_MS,
      oldKeepTraits: num(a.oldKeepTraits, 0),
      keepImportant: a.keepImportant !== false,
      minWeight: Math.min(1, Math.max(0, num(a.minWeight, 0.4))),
      importanceFactor: Math.min(1, Math.max(0, num(a.importanceFactor, 0.8))),
      importantFloor: Math.min(1, Math.max(0, num(a.importantFloor, 0.7)))
    };
  }

  /** 只看时间新旧：1 = 刚刚，0 = 太久（没有时间戳的旧数据当作"新的"，避免一升级就清空） */
  function recency(atMs, cfg = ageCfg()) {
    const t = Number(atMs);
    if (!Number.isFinite(t) || t <= 0) return 1;
    const ageDays = (Date.now() - t) / DAY_MS;
    if (ageDays <= 0) return 1;
    for (const step of cfg.decay) if (ageDays <= step.days) return step.weight;
    return 0;
  }

  /** 综合权重 = 时间新旧 × 重要性（important 不打折，还有 0.7 的下限） */
  function weight(atMs, cfg = ageCfg(), important = false) {
    const base = recency(atMs, cfg);
    return important ? Math.max(cfg.importantFloor, base) : base * cfg.importanceFactor;
  }

  /** 权重转短标记（只在 <100% 时显示，省 token） */
  function weightTag(w) {
    if (!(w > 0) || w >= 1) return '';
    return `·${Math.round(w * 100)}%`;
  }

  /** 按记忆强度取前 N 条（不依赖存储顺序） */
  function topByWeight(list, n) {
    const cfg = ageCfg();
    return [...list]
      .map((t) => {
        const at = Number(t?.lastMentionAt) || Number(t?.createdAt) || 0;
        return { t, w: weight(at, cfg, t?.important === true), at };
      })
      .sort((x, y) => (y.w - x.w) || (y.at - x.at))
      .slice(0, n).map((x) => x.t);
  }

  function agoLabel(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const diff = Math.max(0, Date.now() - ms);
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 3600 * 1000) return `${Math.round(diff / 60000)}分钟前`;
    if (diff < DAY_MS) return `${Math.round(diff / 3600000)}小时前`;
    return `${Math.round(diff / DAY_MS)}天前`;
  }

  // ---------- 核心词 ----------
  const STOP_KEYS = new Set(['管理员', '群主', '老板', '主人', '爸爸', '妈妈', '老公', '老婆', '哥哥', '姐姐',
    '弟弟', '妹妹', '老师', '大佬', '同学', '朋友', '大家', '有人', '别人', '用户', '这个人', '那个人', '这家伙',
    '群里', '群聊', '我们', '你们', '他们']);

  function norm(s) {
    return String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  }

  /** 单字虚词：放开单字 key 之后必须拦掉，否则"了/的/啊"会被当核心词 */
  const STOP_CHARS = new Set([...'的了啊吧呢呀哦嘛嗯哈是在我你他她它们就都也还很太真已经和与及把被给让对从到而且假如但可要会能想说看走吃'.split('')]);

  function isStopCharKey(k) {
    return String(k).length === 1 && STOP_CHARS.has(String(k));
  }

  function extractKeys(text, extraKeys) {
    const src = String(text ?? '');
    const keys = new Set();
    for (const m of src.matchAll(/[《「『“"]([^》」』”"]{2,20})[》」』”"]/g)) keys.add(m[1].trim());
    if (Array.isArray(extraKeys)) for (const k of extraKeys) {
      const v = String(k ?? '').trim();
      // 允许单字核心词（猫/茶/收），否则这类条目永远召不回来；虚词由 STOP_CHARS 拦掉
      if (v.length >= 1 && v.length <= 30) keys.add(v);
    }
    return [...keys].map((k) => String(k).trim())
      .filter((k) => k && !STOP_KEYS.has(k) && !isStopCharKey(k) && (/\s/.test(k) ? norm(k).length >= 3 : norm(k).length >= 1))
      .map((k) => k.slice(0, 30)).slice(0, 8);
  }

  function extractDates(text) {
    const src = String(text ?? '');
    const out = new Set();
    const add = (y, mo, d) => {
      const M = Number(mo); const D = Number(d);
      if (!M || !D) return;
      out.add(`${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`);
      out.add(`${M}-${D}`);
      if (y) { out.add(`${y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`); out.add(`${y}-${M}-${D}`); }
    };
    for (const m of src.matchAll(/(20\d{2})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/g)) add(m[1], m[2], m[3]);
    for (const m of src.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g)) add(null, m[1], m[2]);
    return [...out].slice(0, 8);
  }

  // 核心词打分：整句命中 = 1；词组按片段比例；短语按 2-gram 覆盖率给部分分。
  // 目的：像「交稿子」「火锅店关门」这种谓语+宾语式的 key，不必等他原话重说一遍才能唤起。
  function keyScore(key, ctxNorm, o = {}) {
    const raw = String(key ?? '').trim();
    if (!raw || !ctxNorm) return 0;
    const full = norm(raw);
    if (!full) return 0;
    if (full.length === 1) return (ctxNorm.includes(full) && !isStopCharKey(raw)) ? 1 : 0;
    if (ctxNorm.includes(full)) return 1;
    const parts = raw.split(/[\s,，、/|·;；]+/).map(norm).filter((p) => p.length >= 1);
    if (parts.length >= 2) {
      const got = parts.filter((p) => ctxNorm.includes(p)).length;
      if (!got) return 0;
      return got === parts.length ? 1 : 0.4 + 0.5 * (got / parts.length);
    }
    if (full.length >= 3) {
      const grams = [];
      for (let i = 0; i + 2 <= full.length; i++) grams.push(full.slice(i, i + 2));
      const uniq = [...new Set(grams)];
      const got = uniq.filter((g) => ctxNorm.includes(g)).length;
      if (!got) return 0;
      return 0.4 + 0.5 * (got / uniq.length);
    }
    // 单字加权（只在 o.single=true 时启用：普通条目启用，重要条目不给）
    // 目的：像「猫蹲台阶」这种，他只提一个「猫」字，也该想起那件事
    if (o.single && full.length >= 3) {
      const chars = [...full].filter((c) => !isStopCharKey(c));
      if (chars.length >= 2) {
        const gotChars = chars.filter((c) => ctxNorm.includes(c)).length;
        if (gotChars >= 2) return 0.5 + 0.25 * (gotChars / chars.length);
      }
    }
    return 0;
  }

  function keyHit(key, ctxNorm, o = {}) {
    return keyScore(key, ctxNorm, o) >= 0.5;
  }

  /**
   * 游戏 key 命中度（0~1）：条目的 gameKey（2.0）或 tags（2.1，桥接写入的老条目只有标签）
   * 在这一轮上下文里被提到多少。用和核心词一样的容错匹配：「泰拉瑞亚」在只说了「泰拉」时也拿部分分。
   */
  function gameMatch(topic, ctxNorm) {
    if (!ctxNorm) return 0;
    const g = String(topic?.gameKey ?? '').trim();
    const byKey = g ? keyScore(g, ctxNorm, { single: false }) : 0;
    if (byKey) return byKey;
    const tags = Array.isArray(topic?.tags) ? topic.tags.map(String).filter(Boolean) : [];
    let best = 0;
    for (const tag of tags) best = Math.max(best, keyScore(tag, ctxNorm, { single: false }));
    return best;
  }

  // 命中率：2 个 key 只中 1 个 = 50%，全中 = 100%
  function relevance(topic, ctxNorm) {
    if (!ctxNorm) return { kind: 'none', prob: 0, hit: 0, total: 0 };
    const keys = (Array.isArray(topic?.keys) ? topic.keys : []).map(String).filter(Boolean);
    // 普通条目允许单字部分命中；重要条目保持精确匹配
    const singleOk = !topic?.important;
    const hit = keys.filter((k) => keyHit(k, ctxNorm, { single: singleOk }));
    if (keys.length && hit.length) {
      const prob = hit.length / keys.length;
      return { kind: prob >= 1 ? 'hit' : 'partial', prob, hit: hit.length, total: keys.length, key: hit.join(' + ') };
    }
    // 自己的核心词没中，但上下文提到了这条记忆挂的游戏名/标签 → 算"游戏 key 命中"：
    // 给一个较高的召回概率 + 权重加成（见 recall），但不保证必中
    const gm = gameMatch(topic, ctxNorm);
    if (gm > 0) {
      return { kind: 'game', prob: Math.min(1, Math.max(GAME_KEY_PROB, gm)), hit: 1, total: keys.length, key: topic?.gameKey, game: true };
    }
    const dates = Array.isArray(topic?.dates) ? topic.dates : [];
    if (dates.length) {
      const ctxDigits = String(ctxNorm).replace(/\D+/g, '');
      if (ctxDigits.length >= 3) {
        for (const d of dates) {
          const dd = String(d).replace(/\D+/g, '');
          if (dd.length >= 3 && ctxDigits.includes(dd)) return { kind: 'date', prob: 0.5, key: d };
        }
      }
    }
    return { kind: 'none', prob: 0, hit: 0, total: keys.length };
  }

  // ---------- 约定 / 过期 ----------
  const AGREEMENT_WORDS = ['约定', '答应', '说好', '约好', '保证', '承诺', '不许', '必须', '期限', '截止',
    '下周三', '下个月', '明天', '后天', '下周', '月底', '年底', '之前完成'];

  function isAgreement(text) {
    const s = String(text ?? '');
    return AGREEMENT_WORDS.some((w) => s.includes(w));
  }

  function deadlineOf(topic) {
    if (!topic) return 0;
    const explicit = Number(topic.deadlineAt) || 0;
    if (explicit > 0) return explicit;
    const dates = Array.isArray(topic.dates) ? topic.dates : [];
    const now = Date.now();
    let best = 0;
    for (const d of dates) {
      const m1 = /^(20\d{2})-(\d{1,2})-(\d{1,2})$/.exec(String(d));
      const m2 = /^(\d{1,2})-(\d{1,2})$/.exec(String(d));
      let y; let mo; let da;
      if (m1) { y = Number(m1[1]); mo = Number(m1[2]); da = Number(m1[3]); }
      else if (m2) {
        mo = Number(m2[1]); da = Number(m2[2]);
        y = new Date(now).getFullYear();
        const guess = new Date(y, mo - 1, da, 23, 59, 59).getTime();
        if (guess < now - 180 * DAY_MS) y += 1;
      } else continue;
      const ts = new Date(y, mo - 1, da, 23, 59, 59).getTime();
      if (Number.isFinite(ts) && ts > best) best = ts;
    }
    return best;
  }

  function isExpired(topic, now = Date.now()) {
    const dl = deadlineOf(topic);
    return dl > 0 && dl < now;
  }

  /**
   * 收集容器里**除本条以外**已经占用的核心词。
   * @param {object} st 会话状态
   * @param {string} [skipText] 跳过这条（合并同一条时不跟自己比）
   * @returns {Set<string>}
   */
  function usedKeys(st, skipText = '') {
    const used = new Set();
    for (const e of [...(st.activeTopics || []), ...(st.importantTopics || [])]) {
      if (!e || !Array.isArray(e.keys)) continue;
      if (skipText && String(e.text) === String(skipText)) continue;
      for (const k of e.keys) used.add(String(k));
    }
    return used;
  }

  // 扩展候选时，把首尾的标点和空白削掉
  const TRIM_EDGE = /^[\s，。、,.!?！？：:；;'"“”「」『』（）()【】\[\]—…·]+|[\s，。、,.!?！？：:；;'"“”「」『』（）()【】\[\]—…·]+$/g;
  // 噪声字表（与桥接一致）：扩词时挑的那一格，别挑成"了/再/打"这种没信息量的字
  const LEAD_NOISE = /^[这那哪个张只条把些某家间次种份位名]/;
  const TAIL_NOISE = /[的了有是在上下来去要会就都也和与及把被给对从到而但可很太真已经着过吗呢吧啊呀嘛哦嗯]$/;

  /**
   * 核心词去重：跟已有 key 撞了，就在原文里往左右扩展，尽量做出专属的词。
   * 例：已有「画」→ 新词变成「画江水」；已有「江水」→ 变成「画江水」。
   * 扩不动（原文里找不到、或扩出来还撞）就原样保留，绝不丢 key。
   */
  function uniquifyKeys(keys, text, used) {
    const src = String(text ?? '');
    const out = [];
    for (const raw of Array.isArray(keys) ? keys : []) {
      const key = String(raw ?? '').trim();
      if (!key) continue;
      if (!used.has(key)) { out.push(key); used.add(key); continue; }
      let picked = '';
      const idx = src.indexOf(key);
      if (idx >= 0) {
        // 只比原词长 1~2 个字：再长就不像"核心词"了
        const maxLen = Math.min(12, key.length + 2);
        // 按固定顺序试：左1 → 右1 → 左2 → 右2 → 两边各1 → 两边各2
        for (const [a, b] of [[1, 0], [0, 1], [2, 0], [0, 2], [1, 1], [2, 2]]) {
          const s = Math.max(0, idx - a);
          const e = Math.min(src.length, idx + key.length + b);
          const cand = src.slice(s, e).replace(TRIM_EDGE, '');
          if (cand.length <= key.length || cand.length > maxLen) continue;
          if (used.has(cand) || LEAD_NOISE.test(cand) || TAIL_NOISE.test(cand)) continue;
          picked = cand;
          break;
        }
      }
      const finalKey = picked || key;
      out.push(finalKey);
      used.add(finalKey);
    }
    return out;
  }

  // ---------- 重要性打分（2.1） ----------
  // 只有"重大事件 / 心情剧变 / 约定约束"才算重要；出差、吃饭、上班这类日常安排不算。
  const IMP_HIGH = [
    ['约定', 3], ['答应', 3], ['说好', 3], ['保证', 3], ['承诺', 3], ['不许', 3], ['必须', 2],
    ['约好', 3], ['期限', 2], ['截止', 2], ['纪念日', 3], ['生日', 3], ['忌日', 3], ['周年', 2],
    ['去世', 4], ['走了', 3], ['离世', 4], ['过世', 4], ['葬礼', 4], ['生病', 3], ['住院', 3], ['手术', 3], ['分手', 4], ['绝交', 4],
    ['结婚', 4], ['离婚', 4], ['辞职', 3], ['搬家', 2], ['考上', 3], ['考完', 2], ['毕业', 3],
    ['出版', 3], ['完成了', 2], ['写完了', 2], ['签约', 3], ['中奖', 3], ['吵架', 2], ['和好', 3],
    ['道歉', 2], ['误会', 2], ['第一次', 1], ['最后一次', 2], ['再也不会', 3], ['永远', 1],
    ['很难过', 3], ['特别难过', 3], ['哭了', 2], ['崩溃', 3], ['害怕', 2], ['想哭', 3], ['不甘心', 2],
    ['特别开心', 2], ['太开心了', 2], ['激动', 1], ['表白', 3], ['喜欢你', 2]
  ];
  const IMP_LOW = [
    ['出差', 2], ['吃饭', 2], ['吃了', 2], ['上班', 2], ['下班', 2], ['睡觉', 2], ['睡了', 2],
    ['买', 1], ['快递', 2], ['天气', 2], ['游戏', 1], ['看剧', 2], ['刷视频', 2], ['打游戏', 2],
    ['点外卖', 2], ['洗澡', 2], ['几点了', 3], ['在吗', 3], ['哈哈', 2], ['好的', 2]
  ];

  /**
   * 重要性打分：≥3 判 important，≥1 判 maybe，其余 normal；带了具体日期（2026-11-08）额外 +1。
   * @param {string} text
   * @returns {{level:'important'|'maybe'|'normal', score:number, hits:string[]}}
   */
  function scoreImportance(text) {
    const s = String(text ?? '');
    let score = 0;
    const hits = [];
    for (const [w, v] of IMP_HIGH) if (s.includes(w)) { score += v; hits.push('+' + w); }
    for (const [w, v] of IMP_LOW) if (s.includes(w)) { score -= v; hits.push('-' + w); }
    if (/20\d{2}\s*[年\-/.]\s*\d{1,2}\s*[月\-/.]\s*\d{1,2}/.test(s)) { score += 1; hits.push('+具体日期'); }
    const level = score >= 3 ? 'important' : score >= 1 ? 'maybe' : 'normal';
    return { level, score, hits };
  }

  // ---------- 容器 ----------
  function ensure(st) {
    if (!st || typeof st !== 'object') throw new TypeError('createMemory: st 必须是对象');
    if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
    if (!Array.isArray(st.importantTopics)) st.importantTopics = [];
    if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
    if (!Array.isArray(st.gameSkills)) st.gameSkills = [];
    if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
    return st;
  }

  /** 游戏 key 归一：空串当没有，最长 20 字 */
  function gameKeyOf(extra) {
    const g = String(extra?.gameKey ?? '').trim();
    return g ? g.slice(0, 20) : '';
  }

  // ---------- 写入 ----------
  function append(st, category, content, extra = {}, scopeKey = '') {
    ensure(st);
    const text = redact(String(content ?? '')).trim();   // 2.1：写入前先脱敏
    if (!text) return null;
    age(st);
    if (category === 'activeTopic') {
      const nText = norm(text);
      const same = (t) => {
        if (!t || !t.text) return false;
        const nt = norm(t.text);
        if (!nt) return false;
        if (nt === nText) return true;
        return nt.length >= 6 && nText.length >= 6 && (nt.includes(nText) || nText.includes(nt));
      };
      const existing = st.activeTopics.find(same) || st.importantTopics.find(same);
      if (existing) {
        existing.lastMentionAt = Date.now();
        existing.mentions = (Number(existing.mentions) || 1) + 1;
        // 合并时跳过"自己"：否则自己的旧 key 会被当成别人占用的，把「火锅」扩成「天火锅」
        const newKeys = uniquifyKeys(extractKeys(text, extra.keys), text, usedKeys(st, text));
        existing.keys = [...new Set([...(existing.keys || []), ...newKeys])].slice(0, 6);
        existing.dates = [...new Set([...(existing.dates || []), ...extractDates(text)])].slice(0, 4);
        if (!existing.gameKey && gameKeyOf(extra)) existing.gameKey = gameKeyOf(extra);
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redact(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = cut(redact(String(extra.pendingQuestion)), 200);
        // 同一条说三遍以上，自动升级为重要
        let promoted = false;
        if (!existing.important && existing.mentions >= 3 && extra.important !== false) {
          existing.important = true;
          st.activeTopics = st.activeTopics.filter((x) => x !== existing);
          st.importantTopics.push(existing);
          promoted = true;
        }
        if (promoted) log(`[记忆] 重复 ${existing.mentions} 次，升级为重要：${String(existing.text).slice(0, 30)}`);
        settle(st, text, extra, existing, true);
        trimTopics(st, scopeKey);
        return existing;
      }
      // 新建：先按词表判重要性（extra.important === false 表示"强制当普通"）
      const impScore = scoreImportance(text);
      const important = extra.important === true || (extra.important !== false && impScore.level === 'important');
      if (extra.important !== true && impScore.score) {
        log(`[记忆] 重要性打分 ${impScore.score}（${impScore.level}）${impScore.hits.join(' ')}：${String(text).slice(0, 24)}`);
      }
      const entry = {
        text: cut(text, 200),
        createdAt: Date.now(),
        lastMentionAt: Date.now(),
        mentions: 1,
        important,
        agreement: isAgreement(text),
        deadlineAt: Number(extra.deadlineAt) || 0,
        keys: uniquifyKeys(extractKeys(text, extra.keys), text, extra.keyReuse === true ? new Set() : usedKeys(st)),
        dates: extractDates(text),
        participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redact(String(p))).slice(0, 10) : [],
        pendingQuestion: cut(redact(String(extra.pendingQuestion || '')), 200),
        // 游戏 key：内容就是游戏名。聊天里提到它，这条记忆一起加权、更容易被召回
        ...(gameKeyOf(extra) ? { gameKey: gameKeyOf(extra) } : {})
      };
      if (important) {
        st.importantTopics.push(entry);
        // 每日配额：先照收，再把当天最弱的降级回普通话题（不是"满 10 条就拒收"）
        const cap = limit('maxImportantPerDay', 10);
        const since = Date.now() - DAY_MS;
        const cfg = ageCfg();
        const weightOf = (t) => weight(Number(t.lastMentionAt) || Number(t.createdAt) || 0, cfg, true);
        const recent = st.importantTopics.filter((t) => t && (Number(t.createdAt) || 0) > since);
        if (recent.length > cap) {
          const scored = recent
            .map((t) => ({ t, w: weightOf(t), at: Number(t.lastMentionAt) || Number(t.createdAt) || 0 }))
            .sort((x, y) => (x.w - y.w) || (x.at - y.at));
          const demoted = scored.slice(0, recent.length - cap);
          for (const { t } of demoted) {
            t.important = false;
            st.importantTopics = st.importantTopics.filter((x) => x !== t);
            st.activeTopics.push(t);
          }
          if (demoted.length) {
            log(`[记忆] ${scopeKey || '?'} 今天重要事件候选 ${recent.length} 条 > 配额 ${cap}，把最弱的 ${demoted.length} 条降级为普通记忆：${demoted.map((d) => String(d.t.text || '').slice(0, 20)).join('、')}`);
          }
        }
      } else {
        st.activeTopics.push(entry);
      }
      settle(st, text, extra, entry, important);
      trimTopics(st, scopeKey);
      return entry;
    }
    if (category === 'pendingThought') {
      // 2.1：同一句"想说没说的"只留一条，更新过期时间；最多留 20 条
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = cut(redact(String(extra.motivation)), 50);
        return existing;
      }
      const thought = {
        text: cut(text, 200), createdAt: Date.now(),
        expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
        motivation: cut(redact(String(extra.motivation || 'curiosity')), 50)
      };
      st.pendingThoughts.push(thought);
      const cap = limit('maxThoughts', 20);
      if (st.pendingThoughts.length > cap) st.pendingThoughts.splice(0, st.pendingThoughts.length - cap);
      return thought;
    }
    if (category === 'memberImpression') {
      const name = String(extra.target || '').trim();
      if (!name) return null;
      if (['__proto__', 'constructor', 'prototype'].includes(name)) return null;   // 防原型污染
      const im = st.memberImpressions[name] || { traits: [], interactionCount: 0, lastSeenAt: Date.now() };
      im.traits = Array.isArray(im.traits) ? im.traits : [];
      const maxTraits = limit('maxTraits', 15);
      // 存储顺序约定：权重高的在前；同一条印象不重复记
      const traitText = cut(text, 60);
      const exists = im.traits.some((x) => (typeof x === 'string' ? x : String(x?.text ?? '')) === traitText);
      if (traitText && !exists) im.traits.unshift({ text: traitText, at: Date.now(), important: extra.important === true });
      im.traits = im.traits.slice(0, maxTraits);
      im.interactionCount = (Number(im.interactionCount) || 0) + 1;
      im.lastSeenAt = Date.now();
      st.memberImpressions[name] = im;
      // 最多记 N 个人：超了按最久没见到的先淘汰
      const maxPeople = limit('maxPeople', 10);
      const entries = Object.entries(st.memberImpressions);
      if (entries.length > maxPeople) {
        entries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < entries.length - maxPeople; i++) delete st.memberImpressions[entries[i][0]];
      }
      return im;
    }
    return null;
  }

  /** 可选：写入后结算心情（默认关；传了 opts.settleMood 才动） */
  function settle(st, text, extra, entry, important) {
    if (typeof opts.settleMood !== 'function') return;
    try {
      opts.settleMood(st, text, extra, { important, entry });
    } catch (error) {
      log(`[心情] 条目判定失败：${error?.message ?? error}`);
    }
  }

  /** 普通话题的容量上限（重要条目在 age 里按自己的上限管，不占这里的名额） */
  function trimTopics(st, scopeKey = '') {
    const cap = limit('maxTopics', 20);
    if (st.activeTopics.length <= cap) return;
    const cfg = ageCfg();
    const wOf = (t) => weight(Number(t.lastMentionAt) || Number(t.createdAt) || 0, cfg, false);
    const tOf = (t) => Number(t.lastMentionAt) || Number(t.createdAt) || 0;
    st.activeTopics.sort((a, b) => (wOf(a) - wOf(b)) || (tOf(a) - tOf(b)));   // 权重低的在前
    const evicted = st.activeTopics.slice(0, st.activeTopics.length - cap);
    if (evicted.length) {
      log(`[记忆] ${scopeKey || '?'} 普通话题超上限 ${cap}，淘汰权重最低的 ${evicted.length} 条：${evicted.map((t) => String(t.text || '').slice(0, 20)).join('、')}`);
    }
    st.activeTopics = st.activeTopics.slice(-cap);                            // 留权重最高的 N 条
    st.activeTopics.sort((a, b) => (wOf(b) - wOf(a)) || (tOf(b) - tOf(a)));   // 恢复"越靠前越牢"
  }

  // ---------- 时效整理 ----------
  function age(st) {
    ensure(st);
    const cfg = ageCfg();
    // 1) 兼容老数据：误存进 activeTopics 的 important 条目搬回 importantTopics
    if (st.activeTopics.some((t) => t && t.important === true && t.text)) {
      const moved = st.activeTopics.filter((t) => t && t.important === true && t.text);
      st.activeTopics = st.activeTopics.filter((t) => !(t && t.important === true && t.text));
      const seen = new Set(st.importantTopics.map((t) => String(t.text || '')));
      for (const m of moved) {
        if (!seen.has(String(m.text || ''))) { st.importantTopics.push(m); seen.add(String(m.text || '')); }
      }
    }
    // 2) 普通话题：时间衰减 + 按权重排序
    st.activeTopics = st.activeTopics
      .filter((t) => t && t.text && weight(Number(t.lastMentionAt) || Number(t.createdAt) || 0, cfg, false) >= cfg.minWeight)
      .sort((x, y) => {
        const wx = weight(Number(x.lastMentionAt) || Number(x.createdAt) || 0, cfg, false);
        const wy = weight(Number(y.lastMentionAt) || Number(y.createdAt) || 0, cfg, false);
        if (wy !== wx) return wy - wx;
        return (Number(y.lastMentionAt) || 0) - (Number(x.lastMentionAt) || 0);
      });
    // 3) 重要事件：不按时间删，只按容量（默认 50）
    const cap = Math.max(1, limit('maxImportantTopics', 50));
    st.importantTopics = st.importantTopics.filter((t) => t && t.text).map((t) => ({ ...t, important: true }));
    if (st.importantTopics.length > cap) {
      const tOf = (x) => Number(x.lastMentionAt) || Number(x.createdAt) || 0;
      const now = Date.now();
      // 淘汰优先级：① 已过期的约定（越早过期越先走）② 权重最低 ③ 最久没提
      const scored = st.importantTopics.map((x) => ({
        x, expired: isExpired(x, now), dl: deadlineOf(x) || Number.MAX_SAFE_INTEGER, w: weight(tOf(x), cfg, true), at: tOf(x)
      }));
      scored.sort((p, q) => {
        if (p.expired !== q.expired) return p.expired ? 1 : -1;
        if (p.expired && q.expired && p.dl !== q.dl) return q.dl - p.dl;
        if (p.w !== q.w) return q.w - p.w;
        return q.at - p.at;
      });
      const keep = new Set(scored.slice(0, cap).map((s) => s.x));
      const evicted = scored.slice(cap).map((s) => s.x);
      log(`[记忆] 重要事件超上限 ${cap}，淘汰 ${evicted.length} 条（其中过期约定 ${scored.slice(cap).filter((s) => s.expired).length} 条）`);
      st.importantTopics = st.importantTopics.filter((x) => keep.has(x));
      st.importantTopics.sort((x, y) => tOf(y) - tOf(x));
    } else {
      st.importantTopics.sort((x, y) => (Number(y.lastMentionAt) || Number(y.createdAt) || 0) - (Number(x.lastMentionAt) || Number(x.createdAt) || 0));
    }
    // 4) 想说没说的：过期就清
    st.pendingThoughts = st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    // 5) 群友印象：按权重衰减、裁到 maxTraits、没互动也没内容的人直接清掉
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : null;
    if (impressions) {
      const maxTraits = limit('maxTraits', 15);
      for (const [name, im] of Object.entries(impressions)) {
        if (!im || typeof im !== 'object') { delete impressions[name]; continue; }
        const list = (Array.isArray(im.traits) ? im.traits : [])
          .map((x) => {
            if (typeof x === 'string') {
              // 老数据没有自己的时间：用 lastSeenAt 兜底
              return { text: x, at: Number(im.lastSeenAt) || 0, important: false };
            }
            return { text: String(x?.text ?? '').trim(), at: Number(x?.at) || 0, important: x?.important === true };
          })
          .filter((x) => x.text);
        const keep = [];
        const dropped = [];
        for (const tr of list) {
          const w = weight(tr.at, cfg, tr.important === true);
          if ((cfg.keepImportant && tr.important) || w >= cfg.minWeight) keep.push({ ...tr, w });
          else dropped.push({ ...tr, w });
        }
        // 一条都没剩时保底留 1 条最近丢弃的，避免整页空白
        const extra = keep.length === 0 ? dropped.slice(-Math.max(1, cfg.oldKeepTraits)) : dropped.slice(-cfg.oldKeepTraits);
        im.traits = [...extra, ...keep]
          .sort((x, y) => (y.w ?? 0) - (x.w ?? 0))
          .slice(0, maxTraits)
          .map((tr) => ({ text: tr.text, at: tr.at, important: tr.important === true }));
        if (!im.traits.length && !Number(im.interactionCount)) delete impressions[name];
      }
    }
    return st;
  }

  // ---------- 召回 + 渲染 ----------
  function recall(list, ctxNorm, o = {}) {
    const cfg = ageCfg();
    // 2.1：默认不兜底（和线上一致），要兜底请显式传 always
    const always = Math.max(0, Number(o.always) || 0);
    // 提到游戏名的这一轮，带该游戏 key / 标签的条目权重 ×GAME_KEY_BOOST，排序和回填都占先
    const wOf = (x) => weight(
      Number(x?.lastMentionAt) || Number(x?.createdAt) || 0,
      cfg,
      x?.important === true
    ) * (gameMatch(x, ctxNorm) > 0 ? GAME_KEY_BOOST : 1);
    const items = (Array.isArray(list) ? list : []).filter((x) => x && x.text);
    const hit = []; const maybe = []; const rest = [];
    for (const x of items) {
      const r = relevance(x, ctxNorm);
      if (r.kind === 'hit') hit.push(x);
      else if (r.kind === 'partial' || r.kind === 'date' || r.kind === 'game') maybe.push({ x, prob: r.prob });
      else rest.push(x);
    }
    const picked = [...hit];
    for (const m of maybe) if (Math.random() < m.prob) picked.push(m.x);
    const sortedRest = rest.sort((a, b) => (wOf(b) - wOf(a)) || ((Number(b.lastMentionAt) || Number(b.createdAt) || 0) - (Number(a.lastMentionAt) || Number(a.createdAt) || 0)));
    if (picked.length < always) picked.push(...sortedRest.slice(0, always - picked.length));
    const seen = new Set();
    return picked.filter((x) => {
      const k = norm(x.text);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /**
   * 渲染成提示词（空库返回空串）。
   * 段落顺序与线上一致：重要的事 → 近期的话题 → 游戏技能 → 想说的 → 印象。
   * @param {object} st
   * @param {string} [ctxText] 这一轮的上下文（聊天内容 / 游戏情境），用于召回
   * @param {{skills?:boolean}} [o] `skills:false` 可关掉【游戏技能】段
   * @returns {string}
   */
  function format(st, ctxText = '', o = {}) {
    ensure(st);
    const cfg = ageCfg();
    const now = Date.now();
    const lines = [];
    const renderTopicSection = (list, title) => {
      const items = Array.isArray(list) ? list.filter((t) => t && t.text) : [];
      if (!items.length) return;
      const scored = items.map((t) => {
        const last = Number(t.lastMentionAt) || Number(t.createdAt) || 0;
        return { t, w: weight(last, cfg, t.important === true), rec: recency(last, cfg), last };
      });
      scored.sort((x, y) => (y.w - x.w) || (y.last - x.last));
      lines.push(title);
      for (const { t, rec, last } of scored.slice(0, limit('showTopics', 10))) {
        const ago = agoLabel(last);
        const stale = last && now - last > 6 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}${weightTag(rec)}${ago ? `（${ago}）` : ''}${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
    };
    const ctxNorm = norm(ctxText || '');
    // 重要/普通同一套召回规则（核心词命中必带、时间 50%），唯一的区别是权重衰减
    renderTopicSection(st.importantTopics.length ? recall(st.importantTopics, ctxNorm, { always: limit('recallBackfill', 4) }) : [], '【重要的事】（标了 important，长期记得）');
    // 重要条目多了以后，超出的不塞进提示词（省 token），但要让模型知道"还有这些"
    const impAll = st.importantTopics.filter((t) => t && t.text);
    const impShow = Math.min(limit('showTopics', 10), impAll.length);
    if (impAll.length > impShow) {
      const rest = impAll.slice()
        .sort((x, y) => (Number(y.lastMentionAt) || Number(y.createdAt) || 0) - (Number(x.lastMentionAt) || Number(x.createdAt) || 0))
        .slice(impShow, impShow + 10);
      lines.push(`- …另有 ${impAll.length - impShow} 条较早的重要事件：${rest.map((t) => String(t.text || '').slice(0, 12)).join('、')}（要细节用 memory.list）`);
    }
    renderTopicSection(st.activeTopics.length ? recall(st.activeTopics, ctxNorm, { always: limit('recallBackfill', 4) }) : [], '【近期的话题】（越靠前记得越牢）');
    // 游戏技能：独立容器，不按时间淡出（学到的本事不是聊过的事）
    if (o.skills !== false) {
      const skillsText = formatGameSkills(st, { context: ctxText, max: limit('showGameSkills', 6) });
      if (skillsText) lines.push(...skillsText.split('\n'));
    }
    const thoughts = st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || now < t.expiresAt));
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-limit('showThoughts', 10))) lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
    }
    const names = Object.keys(st.memberImpressions || {});
    if (names.length) {
      lines.push('【对群友的印象】');
      for (const name of names.slice(-limit('showPeople', 10))) {
        const im = st.memberImpressions[name] || {};
        const traits = (Array.isArray(im.traits) ? im.traits : [])
          .map((x) => (typeof x === 'string'
            ? { text: x, at: Number(im.lastSeenAt) || 0, important: false }
            : { text: String(x?.text ?? ''), at: Number(x?.at) || 0, important: x?.important === true }))
          .filter((x) => x.text)
          .map((tr) => ({ ...tr, w: weight(tr.at, cfg, tr.important === true), rec: recency(tr.at, cfg) }))
          .sort((x, y) => y.w - x.w)
          .slice(0, limit('maxTraits', 15));
        const parts = traits.map((tr) => `${tr.text}${tr.important ? '（重要）' : ''}${weightTag(tr.rec)}`);
        lines.push(`- ${name}：${parts.length ? parts.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
    }
    return lines.join('\n');
  }

  // ---------- 维护 / 查询（2.1） ----------
  /**
   * 按类别查（返回 `raw` 结构，和线上 `GET /api/socialV2/memory` 一致）。
   * @param {object} st
   * @param {{tag?:string, category?:string}} [o] `tag` 按标签过滤（只看 active/important）
   */
  function list(st, { tag = '', category = '' } = {}) {
    ensure(st);
    const raw = {
      activeTopics: topByWeight(st.activeTopics, 20),
      importantTopics: st.importantTopics.slice(0, 50),
      pendingThoughts: st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < Number(t.expiresAt)).slice(-20),
      memberImpressions: st.memberImpressions,
      gameSkills: Array.isArray(st.gameSkills) ? [...st.gameSkills] : []
    };
    if (tag) {
      const keep = (t) => Array.isArray(t.tags) && t.tags.includes(tag);
      raw.activeTopics = raw.activeTopics.filter(keep);
      raw.importantTopics = raw.importantTopics.filter(keep);
    }
    if (category === 'activeTopic') { raw.pendingThoughts = []; raw.memberImpressions = {}; raw.gameSkills = []; }
    else if (category === 'pendingThought') { raw.activeTopics = []; raw.importantTopics = []; raw.memberImpressions = {}; raw.gameSkills = []; }
    else if (category === 'memberImpression') { raw.activeTopics = []; raw.importantTopics = []; raw.pendingThoughts = []; raw.gameSkills = []; }
    else if (category === 'gameSkill') { raw.activeTopics = []; raw.importantTopics = []; raw.pendingThoughts = []; raw.memberImpressions = {}; }
    return raw;
  }

  /**
   * 删一条（按原文精确匹配）：`category: 'activeTopic' | 'pendingThought' | 'memberImpression' | 'gameSkill'`。
   * @returns {{ok:boolean, removed:number}}
   */
  function remove(st, { category = '', content = '', target = '' } = {}) {
    ensure(st);
    const text = String(content ?? '');
    let removed = 0;
    if (category === 'activeTopic') {
      const before = st.activeTopics.length + st.importantTopics.length;
      st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== text);
      st.importantTopics = st.importantTopics.filter((t) => String(t?.text ?? '') !== text);
      removed = before - st.activeTopics.length - st.importantTopics.length;
    } else if (category === 'pendingThought') {
      const before = st.pendingThoughts.length;
      st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== text);
      removed = before - st.pendingThoughts.length;
    } else if (category === 'memberImpression') {
      const key = String(target ?? '').trim();
      if (key && Object.prototype.hasOwnProperty.call(st.memberImpressions, key)) { delete st.memberImpressions[key]; removed = 1; }
    } else if (category === 'gameSkill') {
      const before = st.gameSkills.length;
      st.gameSkills = st.gameSkills.filter((s) => String(s?.skill ?? '') !== text && String(s?.text ?? '') !== text);
      removed = before - st.gameSkills.length;
    }
    return { ok: true, removed };
  }

  /** 清空某一类（不传 category 就全清，和线上 memory-clear 一致） */
  function clear(st, { category = '' } = {}) {
    ensure(st);
    if (!category || category === 'activeTopic') { st.activeTopics = []; st.importantTopics = []; }
    if (!category || category === 'pendingThought') st.pendingThoughts = [];
    if (!category || category === 'memberImpression') st.memberImpressions = {};
    if (!category || category === 'gameSkill') st.gameSkills = [];
    return { ok: true };
  }

  /**
   * 落盘用快照：带上和线上一样的配额（普通 80 / 重要 100 / 想说 50 / 技能 80），
   * 且普通话题和技能是**按强度排好序**再截断的（直接序列化 `st` 会没有上限、顺序也不对）。
   */
  function snapshot(st) {
    ensure(st);
    return {
      activeTopics: topByWeight(st.activeTopics, limit('maxTopicsSave', 80)),
      importantTopics: st.importantTopics.slice(0, limit('maxImportantTopics', 100)),
      pendingThoughts: st.pendingThoughts.slice(-50),
      gameSkills: [...st.gameSkills]
        .sort((x, y) => (Number(y?.uses) || 0) - (Number(x?.uses) || 0) || (Number(y?.lastUsedAt) || 0) - (Number(x?.lastUsedAt) || 0))
        .slice(0, limit('maxGameSkills', 80)),
      memberImpressions: st.memberImpressions
    };
  }

  /** 就地改一条（只改传进来的字段）：`{ text, pendingQuestion, participants, important, expiresAtMs }` */
  function update(st, entry, patch = {}) {
    ensure(st);
    if (!entry || typeof entry !== 'object') return null;
    if (patch.text) entry.text = cut(redact(String(patch.text)), 200);
    if (patch.pendingQuestion !== undefined) entry.pendingQuestion = cut(redact(String(patch.pendingQuestion)), 200);
    if (Array.isArray(patch.participants)) entry.participants = [...new Set(patch.participants.map((p) => redact(String(p))))].slice(0, 10);
    if (patch.expiresAtMs !== undefined) entry.expiresAt = Number(patch.expiresAtMs) || 0;
    if (patch.important !== undefined) {
      entry.important = patch.important === true;
      const inActive = st.activeTopics.includes(entry);
      if (entry.important && inActive) { st.activeTopics = st.activeTopics.filter((x) => x !== entry); st.importantTopics.push(entry); }
      if (!entry.important) {
        st.activeTopics = st.activeTopics.filter((x) => x !== entry);
        st.importantTopics = st.importantTopics.filter((x) => x !== entry);
        st.activeTopics.push(entry);
      }
    }
    entry.lastMentionAt = Date.now();
    return entry;
  }

  return {
    ageCfg, recency, weight, weightTag, topByWeight, norm, extractKeys, extractDates, keyHit, keyScore, relevance,
    gameMatch, scoreImportance, GAME_KEY_BOOST, GAME_KEY_PROB,
    isAgreement, deadlineOf, isExpired, ensure, append, age, recall, format, agoLabel,
    list, remove, clear, snapshot, update, truncate: cut
  };
}
