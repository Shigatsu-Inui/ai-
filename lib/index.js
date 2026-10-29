/**
 * DSH 插件入口。
 *
 * 只做两件事：把自己标成已加载、把模块暴露出去。
 * 业务逻辑都在 src/ 里，这里不放任何规则。
 */
import { createMemory } from '../src/memory.js';
import * as mood from '../src/mood.js';

export const name = 'mood-memory';

/** @type {ReturnType<typeof createMemory>|null} */
let memory = null;

/**
 * cordis 插件生命周期入口。
 * @param {object} ctx 宿主上下文（只用到可选的 logger）
 * @param {{memory?: object, mood?: object}} [config]
 */
export function apply(ctx, config = {}) {
  const log = typeof ctx?.logger?.info === 'function' ? (m) => ctx.logger.info(m) : (m) => console.log(m);
  memory = createMemory({
    limit: (n, def) => (config.memory && config.memory[n] != null ? config.memory[n] : def),
    log,
    age: config.memory?.age
  });
  log('[mood-memory] 已加载：心情 + 记忆模块就绪');
}

/**
 * 拿到记忆实例（没调过 apply 时按默认配置新建一个）。
 */
export function getMemory() {
  if (!memory) memory = createMemory({});
  return memory;
}

export { mood };
/** 游戏接入层（2.0）：classify / eventToEntry / createTerrariaCompanion … */
export * as game from '../src/terraria.js';
/** 游戏技能库（2.1）：appendGameSkill / matchGameSkills / formatGameSkills … */
export * as skills from '../src/skills.js';
