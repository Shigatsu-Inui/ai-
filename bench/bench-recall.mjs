import { createMemory } from '../src/memory.js';

const mem = createMemory({ limit: (n, d) => d });
const st = { activeTopics: [], importantTopics: [], pendingThoughts: [], memberImpressions: {} };

const bank = [
  ['M1', '管理员在10月26日完成了《山海旧事》这本书', ['山海旧事']],
  ['M2', '小鲸在写《云边小馆》，山里一间茶馆的故事', ['云边小馆', '茶馆']],
  ['M3', '老周开建材店，最近在弄装修', ['老周', '建材']],
  ['M4', '阿橙住在杭州，养了两只猫', ['杭州']],
  ['M5', '语音模型用 GPT-SoVITS，参考音 ref-shi.wav', ['GPT-SoVITS', 'ref-shi']],
  ['M6', '小区门口那家面馆 11 月 8 号关门了', ['面馆']],
  ['M7', '答应了下周三之前把稿子改完', ['稿子', '下周三']],
  ['M8', '她生日是 3 月 14 日', ['生日']],
  ['M9', '上次吵架是因为语音太糊，后来和好了', ['语音', '吵架']],
  ['M10', '他不喜欢被叫大胖', ['大胖']],
  ['M11', '画图用 SDXL，水墨风格', ['SDXL', '水墨']],
  ['M12', '他妈妈住院了，要做手术', ['住院', '手术']]
].map(([id, text, keys]) => {
  const e = mem.append(st, 'activeTopic', text, { keys, important: true });
  return { id, entry: e };
});

const cases = [
  ['山海旧事写完了吗', 'M1', 'hit'],
  ['那本山海旧事怎么样', 'M1', 'hit'],
  ['云边小馆那个茶馆写得真好', 'M2', 'hit'],
  ['云边小馆更新了吗', 'M2', 'half'],
  ['那茶馆环境不错', 'M2', 'half'],
  ['老周那建材店还开着吗', 'M3', 'hit'],
  ['老周最近忙吗', 'M3', 'half'],
  ['建材价格涨了吧', 'M3', 'half'],
  ['杭州那边下雨了', 'M4', 'hit'],
  ['我家也养了两只猫', null, 'none'],
  ['GPT-SoVITS 又崩了', 'M5', 'half'],
  ['ref-shi 那个音频有问题', 'M5', 'half'],
  ['GPT-SoVITS 的 ref-shi 音频', 'M5', 'hit'],
  ['语音模型换了', null, 'none'],
  ['小区门口那家面馆还开吗', 'M6', 'hit'],
  ['我刚才吃了碗面', null, 'none'],
  ['下周三稿子能改完吗', 'M7', 'hit'],
  ['稿子写到哪了', 'M7', 'half'],
  ['下周三有空吗', 'M7', 'half'],
  ['我生日你记得吗', 'M8', 'hit'],
  ['生日蛋糕订了吗', 'M8', 'hit'],
  ['你生在什么时候', null, 'none'],
  ['上次那个语音太糊了', 'M9', 'half'],
  ['吵架的事过去了', 'M9', 'half'],
  ['语音太糊那次吵架', 'M9', 'hit'],
  ['别叫他大胖', 'M10', 'hit'],
  ['大胖是谁', 'M10', 'hit'],
  ['画图用水墨', 'M11', 'half'],
  ['SDXL 出图太慢', 'M11', 'half'],
  ['水墨那个风格不错', 'M11', 'half'],
  ['SDXL 水墨模式', 'M11', 'hit'],
  ['他妈妈住院了', 'M12', 'half'],
  ['手术做完了吗', 'M12', 'half'],
  ['住院那事怎么样了', 'M12', 'half'],
  ['住院手术都安排好了', 'M12', 'hit'],
  ['管理员今天在吗', null, 'none'],
  ['群主呢', null, 'none'],
  ['老板在不在', null, 'none'],
  ['主人去哪了', null, 'none'],
  ['今天天气不错', null, 'none'],
  ['在吗', null, 'none'],
  ['哈哈哈哈', null, 'none'],
  ['点了个外卖', null, 'none'],
  ['几点了', null, 'none'],
  ['我在打游戏', null, 'none'],
  ['快递到了', null, 'none'],
  ['刚下班', null, 'none'],
  ['吃了没', null, 'none'],
  ['11月8号你有空吗', 'M6', 'date'],
  ['2026年10月26日那天', 'M1', 'date'],
  ['3月14日那天', 'M8', 'date']
];

const TRIALS = 400;
let pass = 0;
const by = {};
for (const [q, expectId, mode] of cases) {
  const ctx = mem.norm(q);
  const certain = bank.filter((b) => mem.relevance(b.entry, ctx).kind === 'hit').map((b) => b.id);
  let ok = false;
  if (mode === 'hit') ok = certain.includes(expectId);
  else if (mode === 'half' || mode === 'date') {
    const target = bank.find((b) => b.id === expectId);
    const prob = target ? (mem.relevance(target.entry, ctx).prob || 0) : 0;
    let c = 0;
    for (let i = 0; i < TRIALS; i++) if (Math.random() < prob) c++;
    const rate = c / TRIALS;
    ok = rate > 0.35 && rate < 0.65;
  } else ok = certain.length === 0;
  if (ok) pass++;
  by[mode] = by[mode] || { n: 0, ok: 0 };
  by[mode].n++; if (ok) by[mode].ok++;
}
console.log('=== 记忆召回（' + cases.length + ' 个样本）===');
console.log('总通过 ' + pass + '/' + cases.length + ' = ' + Math.round((pass / cases.length) * 100) + '%');
const name = { hit: '必中', half: '半概率', date: '时间50%', none: '不该中' };
for (const [k, v] of Object.entries(by)) console.log('  ' + name[k] + '：' + v.ok + '/' + v.n);

process.exit(pass === cases.length ? 0 : 1);
