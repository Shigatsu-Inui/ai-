// 游戏技能库（2.1 新增）：她在聊天里跟你学来的玩法/窍门，记成"能照做的技能"。
//
// 和记忆条目的区别（这是设计上的关键）：
//   - 记忆 = 发生过的事，按时间淡出；
//   - 技能 = 学到的本事，**不按时间淡出**，只按"用过没有"和容量（默认 80 条）淘汰。
//
// 一条技能 = 游戏名 + 技能名（主 key）+ 指令分类（action）+ 几个 key + 一句话怎么做。
// 游玩端（真正操作游戏的那一端）按当前情境 `q` 来查，命中度 >= 0.5 就可以照做。
//
// 存放位置：和记忆**同一个状态对象**，容器叫 `st.gameSkills`（不是另一个库、另一个文件）。
// 零依赖、纯本地、不调模型；下面全部是纯函数，`st` 由调用方持有。

/** 游玩端的指令分类：只允许"慢决策"，和 GAME_ACTIONS 是同一套词。 */
export const GAME_SKILL_ACTIONS = [
  'idle', 'follow', 'explore', 'attack', 'come', 'mine',
  'dig', 'chop', 'recall', 'craft', 'place', 'chest', 'use', 'say'
];

/** 技能库容量：超了淘汰"用得最少、且最久没用"的 */
export const MAX_GAME_SKILLS = 80;

/** 每条技能最多几个 key（第 1 位是技能名、第 2 位是指令分类名） */
export const MAX_GAME_SKILL_KEYS = 6;

/**
 * 指令分类表：`label` 是中文分类名（**会自动进 key**），`aliases` 是同义说法（只在打分时用，
 * 不写进 key，免得把 key 撑大）。
 *
 * 为什么要把分类名写进 key：游玩端拼查询串时带的就是这些词（"挖矿/探索/跟随"或 `mine`/`follow`），
 * 两边用同一套词，命中才稳，不用靠字面巧合。
 */
export const GAME_SKILL_ACTION_NAMES = {
  idle: { label: '待机', aliases: ['等待', '停下', '别动', '待着', '原地'] },
  follow: { label: '跟随', aliases: ['跟着', '跟上', '跟紧', '跟上我'] },
  explore: { label: '探索', aliases: ['探路', '探险', '找路', '开图', '闲逛'] },
  attack: { label: '攻击', aliases: ['战斗', '打怪', '迎战', '反击', '打架'] },
  come: { label: '回来', aliases: ['过来', '召回', '靠近', '到我这', '回玩家身边'] },
  mine: { label: '采矿', aliases: ['挖矿', '采掘', '矿脉', '矿石'] },
  dig: { label: '下挖', aliases: ['挖洞', '挖通道', '挖地道', '向下挖', '往下挖'] },
  chop: { label: '伐木', aliases: ['砍树', '砍木头', '伐树', '木材'] },
  recall: { label: '回程', aliases: ['回城', '回出生点', '回老家', '传送回去'] },
  craft: { label: '制作', aliases: ['合成', '打造', '做东西', '工作台'] },
  place: { label: '放置', aliases: ['摆放', '建造', '盖房', '搭房子'] },
  chest: { label: '箱子', aliases: ['开箱', '宝箱', '容器'] },
  use: { label: '使用', aliases: ['用道具', '用物品', '吃药'] },
  say: { label: '说话', aliases: ['台词', '对话', '聊天'] }
};

/** 默认游戏名（和记忆的游戏 key 一致） */
export const DEFAULT_GAME = '泰拉瑞亚';

/** 收拾字符串：去掉控制字符、截断 */
function clean(value) {
  return String(value ?? '').replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 100);
}

/**
 * 英文动作 / 中文分类名 / 同义说法 → 规范动作名（认不出返回空串）。
 * @param {string} value 例如 'mine' / '采矿' / '挖矿'
 * @returns {string}
 */
export function normalizeGameAction(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return '';
  if (GAME_SKILL_ACTION_NAMES[v]) return v;
  for (const [action, cat] of Object.entries(GAME_SKILL_ACTION_NAMES)) {
    if (cat.label === v || cat.aliases.includes(v)) return action;
  }
  return '';
}

/**
 * 动作 → 中文分类名（写进 key、给提示词看的就是这个）。
 * @param {string} action
 * @returns {string}
 */
export function gameActionLabel(action) {
  const a = normalizeGameAction(action);
  return a ? GAME_SKILL_ACTION_NAMES[a].label : '';
}

/**
 * 技能没写 action 时，从技能名 / keys 反推它属于哪个指令分类。
 * 不看正文 —— 正文是散文，出现"回来/打下"这类词容易误判。
 * @param {{action?:string, skill?:string, keys?:string[]}} skill
 * @returns {string}
 */
export function inferGameSkillAction(skill) {
  const declared = normalizeGameAction(skill?.action);
  if (declared) return declared;
  const parts = [skill?.skill, ...(Array.isArray(skill?.keys) ? skill.keys : [])]
    .map((x) => String(x ?? '').trim()).filter(Boolean);
  for (const text of parts) {
    let best = ''; let bestLen = 0;
    for (const [action, cat] of Object.entries(GAME_SKILL_ACTION_NAMES)) {
      for (const name of [cat.label, ...cat.aliases]) {
        if (name && name.length > bestLen && text.includes(name)) { best = action; bestLen = name.length; }
      }
    }
    if (best) return best;
  }
  return '';
}

/** 中文没空格：算覆盖度时跳过的虚词（免得"要/按/个"这种字制造假命中） */
const SKILL_STOP_CHARS = new Set([...'的了啊吧呢呀哦嘛嗯是在我你他她它们就都也还很太真已经和与及把被给让对从到而且但可要会能想说要按哪个什么怎样这那就才刚正'.split('')]);

/**
 * 技能对当前情境 `q` 的匹配度（0~1）。分数越高越"确定会"。
 *
 * 打分顺序：
 *   ① 查询里提到某个 key（整串命中 1.0；命中 key 里的字 0.3~0.8）
 *   ①' 指令分类：分类名 1.0、同义说法 0.85、英文动作（q 里常带 state/action 原文）0.8
 *   ② 整串出现在技能内容里 1.0
 *   ③ 有空格/标点的查询按词算 0.4~0.9
 *   ④ 中文整句按 2-gram 覆盖 0.3~0.8
 *   ⑤ 兜底按字覆盖 0.25~0.65
 *
 * @param {object} skill
 * @param {string} q
 * @returns {number}
 */
export function skillScore(skill, q) {
  const needle = String(q || '').toLowerCase().trim();
  if (!needle) return 0;
  const keys = [skill.skill, ...(Array.isArray(skill.keys) ? skill.keys : [])]
    .map((k) => String(k || '').trim().toLowerCase()).filter(Boolean);
  const hay = `${skill.skill || ''} ${skill.text || ''} ${(Array.isArray(skill.keys) ? skill.keys : []).join(' ')}`.toLowerCase();
  let best = 0;
  // ① 查询里直接提到某个 key
  for (const key of keys) {
    if (needle.includes(key)) { best = Math.max(best, 1); continue; }
    const chars = [...new Set([...key])].filter((c) => !SKILL_STOP_CHARS.has(c));
    if (!chars.length) continue;
    const hit = chars.filter((c) => needle.includes(c)).length;
    if (hit) best = Math.max(best, 0.3 + 0.5 * (hit / chars.length));
  }
  // ①' 指令分类
  const action = inferGameSkillAction(skill);
  const cat = action ? GAME_SKILL_ACTION_NAMES[action] : null;
  if (cat) {
    for (const name of [cat.label, ...cat.aliases]) {
      if (name && needle.includes(name.toLowerCase())) best = Math.max(best, name === cat.label ? 1 : 0.85);
    }
    if (new RegExp(`(^|[^a-z0-9])${action}([^a-z0-9]|$)`).test(needle)) best = Math.max(best, 0.8);
  }
  // ② 整串出现在技能内容里
  if (hay.includes(needle)) best = Math.max(best, 1);
  if (best) return best;
  // ③ 有空格/标点的查询：按词算
  const parts = needle.split(/[\s,，、/|;；+]+/).filter((p) => p.length > 0);
  if (parts.length > 1) {
    const hit = parts.filter((p) => hay.includes(p)).length;
    if (hit) return 0.4 + 0.5 * (hit / parts.length);
  }
  // ④ 中文整句：按 2-gram 覆盖率
  const chars = needle.replace(/[\s\p{P}\p{S}]+/gu, '');
  if (chars.length >= 2) {
    const grams = [];
    for (let i = 0; i + 2 <= chars.length; i++) grams.push(chars.slice(i, i + 2));
    const uniq = [...new Set(grams)];
    const got = uniq.filter((g) => hay.includes(g)).length;
    if (got) return 0.3 + 0.5 * (got / uniq.length);
    // ⑤ 兜底：按字覆盖（跳过虚词，至少命中 2 个字才算）
    const meaningful = [...new Set([...chars].filter((c) => !SKILL_STOP_CHARS.has(c)))];
    const charHit = meaningful.filter((c) => hay.includes(c)).length;
    if (charHit >= 2) return 0.25 + 0.4 * (charHit / meaningful.length);
  }
  return 0;
}

/** 排序：匹配度 > 用过次数 > 最近用过 > 最近提过 */
function sortSkills(list, q) {
  return [...list].sort((a, b) =>
    (skillScore(b, q) - skillScore(a, q)) ||
    (Number(b.uses) || 0) - (Number(a.uses) || 0) ||
    (Number(b.lastUsedAt) || 0) - (Number(a.lastUsedAt) || 0) ||
    (Number(b.lastMentionAt) || 0) - (Number(a.lastMentionAt) || 0));
}

/**
 * 记一条技能。同一游戏 + 同一技能名会**合并**（只更新做法、合并 key、mentions +1），不会堆成十条。
 *
 * @param {object} st 状态对象（记忆和技能共用同一个；`st.gameSkills` 就是库）
 * @param {string} content 一句话说明"怎么做"，要能照做（最多 300 字）
 * @param {{game?:string, skill?:string, keys?:string[], action?:string}} [extra]
 *   - `skill`：技能名 = 主 key（不给就用 keys[0] 或正文前 12 字）
 *   - `keys`：1~2 个概述词
 *   - `action`：游玩端指令分类，**认英文也认中文**（'mine' 和 '挖矿' 等价）；不填会按技能名/keys 推断
 * @param {{save?:Function, redact?:(v:string)=>string}} [hooks] `save` 在自己的状态落盘时调用
 * @returns {{ok:boolean, created:boolean, game:string, skill:string, keys:string[], action:string}}
 * @example
 * appendGameSkill(st, '对着矿脉长按左键，矿石会进独立背包', { skill: '采矿', keys: ['矿脉'], action: 'mine' });
 * // => keys 变成 ['采矿', '矿脉']，action 'mine'
 */
export function appendGameSkill(st, content, extra = {}, hooks = {}) {
  const redact = typeof hooks.redact === 'function' ? hooks.redact : (v) => v;
  const text = String(redact(String(content ?? ''))).trim();
  if (!text) throw new Error('技能内容不能为空');
  if (!Array.isArray(st.gameSkills)) st.gameSkills = [];
  const game = clean(extra.game || DEFAULT_GAME).slice(0, 20);
  const raw = [extra.skill, ...(Array.isArray(extra.keys) ? extra.keys : [])]
    .map((k) => clean(k)).filter(Boolean);
  const skill = clean(extra.skill || raw[0] || text.slice(0, 12)).slice(0, 30);
  if (!skill) throw new Error('技能名不能为空');
  // 指令分类：显式给了就用，没给就按技能名/keys 反推；分类名自动排进 key 第 2 位
  const action = normalizeGameAction(extra.action) || inferGameSkillAction({ skill, keys: raw });
  const actionLabel = action ? GAME_SKILL_ACTION_NAMES[action].label : '';
  const keys = [...new Set([skill, actionLabel, ...raw].filter(Boolean))].slice(0, MAX_GAME_SKILL_KEYS);
  const same = (s) => s && String(s.game || '') === game && String(s.skill || '') === skill;
  const existing = st.gameSkills.find(same);
  let created = false;
  if (existing) {
    existing.text = text.slice(0, 300);
    existing.keys = [...new Set([...(Array.isArray(existing.keys) ? existing.keys : []), ...keys])].slice(0, MAX_GAME_SKILL_KEYS);
    existing.mentions = (Number(existing.mentions) || 1) + 1;
    existing.lastMentionAt = Date.now();
    if (action) existing.action = action;
  } else {
    created = true;
    st.gameSkills.push({
      game, skill, text: text.slice(0, 300), keys, action,
      uses: 0, lastUsedAt: 0, mentions: 1, createdAt: Date.now(), lastMentionAt: Date.now()
    });
  }
  if (st.gameSkills.length > MAX_GAME_SKILLS) {
    st.gameSkills = sortSkills(st.gameSkills, '').slice(0, MAX_GAME_SKILLS);
  }
  if (typeof hooks.save === 'function') hooks.save();
  return { ok: true, created, game, skill, keys, action };
}

/**
 * 渲染技能库进提示词（默认最多 6 条；"这轮用得上"的排前面）。
 * @param {object} st
 * @param {{context?:string, max?:number}} [opts] `context` = 这一轮的上下文（聊天内容/游戏情境）
 * @returns {string} 空库返回空串
 */
export function formatGameSkills(st, { context = '', max = 6 } = {}) {
  const list = Array.isArray(st?.gameSkills) ? st.gameSkills.filter((s) => s && (s.skill || s.text)) : [];
  if (!list.length) return '';
  const lines = ['【游戏技能】（学过、能直接照做的操作）'];
  for (const s of sortSkills(list, context).slice(0, Math.max(1, Number(max) || 6))) {
    const keys = [...new Set([s.skill, ...(Array.isArray(s.keys) ? s.keys : [])])].filter(Boolean).slice(0, 3).join(' / ');
    const bits = [`- ${s.game ? `${s.game}·` : ''}${s.skill || '技能'}：${String(s.text || '').slice(0, 80)}〔${keys}〕`];
    if (skillScore(s, context) > 0) bits.push('·这轮用得上');
    if (Number(s.uses) > 0) bits.push(`·用过${Number(s.uses)}次`);
    if (s.action) bits.push(`·动作=${gameActionLabel(s.action) || s.action}`);
    lines.push(bits.join(''));
  }
  return lines.join('\n');
}

/**
 * 游玩端用：按当前情境找技能（已排序）。
 * `q` 建议写成"地形 + 血量 + 敌人 + 想干什么"一句中文，实测最准。
 * @param {object} st
 * @param {{game?:string, q?:string, limit?:number}} [opts]
 * @returns {Array<{game:string, skill:string, text:string, keys:string[], action:string, actionName:string, uses:number, score:number}>}
 *   `score` 0~1：建议 `>= 0.5` 当成"确定会"，`0.3~0.5` 当"可以试试"；给了 `q` 时 score 为 0 的不返回
 */
export function matchGameSkills(st, { game = '', q = '', limit = 8 } = {}) {
  const list = (Array.isArray(st?.gameSkills) ? st.gameSkills : [])
    .filter((s) => s && (s.skill || s.text))
    .filter((s) => !game || String(s.game || '') === String(game));
  const scored = sortSkills(list, q).map((s) => {
    const action = inferGameSkillAction(s);
    return { ...s, action, actionName: gameActionLabel(action), score: Number(skillScore(s, q).toFixed(2)) };
  });
  const filtered = q ? scored.filter((s) => s.score > 0) : scored;
  return filtered.slice(0, Math.max(1, Math.min(50, Number(limit) || 8)));
}

/**
 * 标记"这条技能用过了"——直接决定淘汰顺序（用得少的先被踢掉），也让下次更容易命中。
 * @param {object} st
 * @param {{game?:string, skill:string}} opts
 * @returns {{ok:boolean, skill?:string, game?:string, uses?:number, error?:string}}
 */
export function markGameSkillUsed(st, { game = '', skill = '' } = {}) {
  const list = Array.isArray(st?.gameSkills) ? st.gameSkills : [];
  const hit = list.find((s) => String(s.skill || '') === String(skill) && (!game || String(s.game || '') === String(game)));
  if (!hit) return { ok: false, error: '没有这条技能' };
  hit.uses = (Number(hit.uses) || 0) + 1;
  hit.lastUsedAt = Date.now();
  return { ok: true, skill: hit.skill, game: hit.game, uses: hit.uses };
}
