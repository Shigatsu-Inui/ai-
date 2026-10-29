/**
 * 统一入口：把心情和记忆的公开 API 都从这里导出。
 *
 * @example
 * import { createMemory, applyMoodUpdate, moodPromptLine } from 'mood-memory';
 */

export { createMemory, truncateText } from './memory.js';

export {
  // 参数
  MOOD_DIMS,
  DEFAULTS,
  BASELINE,
  HALF_LIFE_TOTAL_MS,
  HALF_LIFE_DIM_MS,
  DIM_HALF_LIFE_OVERRIDE,
  DIM_GAIN_SCALE,
  MIN_DELTA,
  MIN_CONFIDENCE,
  MAX_UPDATES_PER_DAY,
  MODEL_WEIGHT,
  WORD_WEIGHT,
  DICE_TABLE,
  ENTRY_RANGE,
  IMPORTANT_RANGE,
  // 七维
  DIM_EFFECTS,
  activeDimEffects,
  // 状态
  ensureMood,
  decayMood,
  moodBand,
  applyMoodUpdate,
  snapshot,
  moodPromptLine,
  // 给分
  wordScore,
  rollMagnitude,
  scoreEntryMood,
  // 条目自动结算（2.1）
  judgeEntryMood,
  pickEntryDims,
  settleEntryMood,
  // 骰子
  rollDice,
  applyDiceDelta
} from './mood.js';

export {
  // 游戏接入（2.0）：把状态文件里发生的事翻译成记忆
  GAME_ACTIONS,
  GAME_DEFAULTS,
  GAME_TAG,
  classify,
  eventToEntry,
  promptLine,
  createTerrariaCompanion,
  readStateFile,
  watchStateFile,
  // 游戏记忆收据（2.1）：带标签、按事件去重、同一段经历只结算一次心情
  appendGameMemory,
  gameMemoryReceipt,
  formatGameMemoryTags
} from './terraria.js';

export {
  // 游戏技能库（2.1）：她在游戏里学到的"能照做的本事"
  GAME_SKILL_ACTIONS,
  GAME_SKILL_ACTION_NAMES,
  MAX_GAME_SKILLS,
  MAX_GAME_SKILL_KEYS,
  normalizeGameAction,
  gameActionLabel,
  inferGameSkillAction,
  skillScore,
  appendGameSkill,
  formatGameSkills,
  matchGameSkills,
  markGameSkillUsed
} from './skills.js';
