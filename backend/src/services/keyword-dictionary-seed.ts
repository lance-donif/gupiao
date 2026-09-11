/**
 * KeywordDictionary seed 数据：与迁移前代码硬编码词表逐字对应。
 * seed 脚本与单测 fixture 统一从这里取，保证线上词表 == 测试期望。
 */
export type KeywordDictionarySeedCategory =
  | 'stopword'
  | 'high_signal'
  | 'canonical'
  | 'buzz_positive'
  | 'buzz_negative'
  | 'blocking';

export interface IKeywordDictionarySeedEntry {
  readonly term: string;
  readonly category: KeywordDictionarySeedCategory;
  readonly canonicalTerm?: string;
  readonly source: string;
}

const seed = (
  terms: readonly string[],
  category: KeywordDictionarySeedCategory,
  source: string,
): IKeywordDictionarySeedEntry[] => terms.map(term => ({ term, category, source }));

// friend-network-entity-extractor.ts DYNAMIC_STOP_WORDS（原样）
const STOPWORDS = [
  '记者', '今天', '今年', '其中', '公告', '公告称', '日电', '工作要点',
  '发布', '印发', '全面', '提高', '推动', '满足', '需要', '公司',
  '项目', '建设', '资金', '自筹资金', '自有资金', '包括', '进行', '加大', '支持',
] as const;

// friend-network-entity-extractor.ts HIGH_SIGNAL_SUFFIXES（原样，顺序去重：半导体/军工各出现两次）
const HIGH_SIGNAL_TERMS = [
  '白银', '黄金', '铜', '锂', '煤炭', '煤矿', '瓦斯', '石油',
  '天然气', '霍尔木兹海峡', '海峡', '机器人', 'AI', '算力', '基础模型', '智能生态',
  '半导体', '芯片', '智能机器人', '叉车', '制造业', '无人机', '涡扇发动机', '发动机', '航空发动机', '航空',
  '军工', '先进制造业', '产业', '产业链', '行业', '证券',
  '跨境证券', '量化私募', '高频交易', '内幕交易', '银行', '央行', '储备银行', '利率',
  '基准利率', '加息', '降息', '融资', '贷款', '信用贷款', '质押融资', '无还本续贷',
  '研发贷', '园区贷', '专精特新贷', '新能源', '光伏', '科技创新', '营商环境',
] as const;

// friend-network-entity-extractor.ts CANONICAL_REPLACEMENTS（原样；多模式拆成多行，canonicalTerm 相同）
const CANONICAL_GROUPS: ReadonlyArray<{ readonly patterns: readonly string[]; readonly canonical: string }> = [
  { patterns: ['战略性新兴产业'], canonical: '战略性新兴产业' },
  { patterns: ['先进制造业'], canonical: '先进制造业' },
  { patterns: ['智能机器人'], canonical: '智能机器人' },
  { patterns: ['企业信用贷款'], canonical: '企业信用贷款' },
  { patterns: ['知识产权质押融资'], canonical: '知识产权质押融资' },
  { patterns: ['基准利率'], canonical: '基准利率' },
  { patterns: ['澳央行', '澳大利亚储备银行'], canonical: '澳央行' },
  { patterns: ['储备银行'], canonical: '储备银行' },
  { patterns: ['无还本续贷'], canonical: '无还本续贷' },
  { patterns: ['专精特新贷'], canonical: '专精特新贷' },
  { patterns: ['研发贷'], canonical: '研发贷' },
  { patterns: ['园区贷'], canonical: '园区贷' },
  { patterns: ['新能源'], canonical: '新能源' },
  { patterns: ['光伏'], canonical: '光伏' },
  { patterns: ['煤矿'], canonical: '煤矿' },
  { patterns: ['煤炭'], canonical: '煤炭' },
  { patterns: ['瓦斯'], canonical: '瓦斯' },
  { patterns: ['霍尔木兹海峡'], canonical: '霍尔木兹海峡' },
  { patterns: ['石油'], canonical: '石油' },
  { patterns: ['天然气'], canonical: '天然气' },
  { patterns: ['AI'], canonical: 'AI' },
  { patterns: ['算力'], canonical: '算力' },
  { patterns: ['基础模型'], canonical: '基础模型' },
  { patterns: ['半导体'], canonical: '半导体' },
  { patterns: ['芯片'], canonical: '芯片' },
  { patterns: ['无人机'], canonical: '无人机' },
  { patterns: ['涡扇发动机'], canonical: '涡扇发动机' },
  { patterns: ['航空发动机'], canonical: '航空发动机' },
  { patterns: ['军工'], canonical: '军工' },
  { patterns: ['跨境证券'], canonical: '跨境证券' },
  { patterns: ['量化私募'], canonical: '量化私募' },
  { patterns: ['高频交易'], canonical: '高频交易' },
  { patterns: ['内幕交易'], canonical: '内幕交易' },
  { patterns: ['证券'], canonical: '证券' },
  { patterns: ['白银'], canonical: '白银' },
  { patterns: ['黄金'], canonical: '黄金' },
  { patterns: ['银行'], canonical: '银行' },
  { patterns: ['融资'], canonical: '融资' },
  { patterns: ['贷款'], canonical: '贷款' },
  { patterns: ['利率'], canonical: '利率' },
  { patterns: ['加息'], canonical: '加息' },
  { patterns: ['机器人'], canonical: '机器人' },
  { patterns: ['叉车'], canonical: '叉车' },
  { patterns: ['制造业'], canonical: '制造业' },
  { patterns: ['科技创新'], canonical: '科技创新' },
  { patterns: ['营商环境'], canonical: '营商环境' },
] as const;

// scoring-contribution-engine.ts classifyMovementDirection 正/负正则（原样；负优先语义由调用方保持）
const BUZZ_POSITIVE = [
  '火箭发射', '快速反弹', '大笔买入', '封涨停板', '打开跌停板', '有大买盘', '竞价上涨', '高开5日线',
  '向上缺口', '60日新高', '60日大幅上涨', '拉升', '净流入',
] as const;

const BUZZ_NEGATIVE = [
  '加速下跌', '高台跳水', '大笔卖出', '封跌停板', '打开涨停板', '有大卖盘', '竞价下跌', '低开5日线',
  '向下缺口', '60日新低', '60日大幅下跌',
] as const;

// news-ingest-pipeline.ts keywordBucketTerms（原样）
const BLOCKING_TERMS = [
  '白银', '黄金', '铜', '铝', '锂', '镍', '稀土', '煤炭',
  '石油', '天然气', '电力', '光伏', '新能源', '储能', '电池', '芯片',
  '半导体', '机器人', '算力', '医药', '创新药', '化工', '航运', '航空',
  '军工', '原奶', '玻纤', '氢氟酸', '化肥', 'LNG', '油轮', '原油',
  'DRAM', 'MLCC', '白酒', '证券', '铁矿',
] as const;

export const SEED_KEYWORD_DICTIONARY_ENTRIES: readonly IKeywordDictionarySeedEntry[] = [
  ...seed(STOPWORDS, 'stopword', 'seed:entity-extractor'),
  ...seed(HIGH_SIGNAL_TERMS, 'high_signal', 'seed:entity-extractor'),
  ...CANONICAL_GROUPS.flatMap(group =>
    group.patterns.map((pattern): IKeywordDictionarySeedEntry => ({
      term: pattern,
      category: 'canonical',
      canonicalTerm: group.canonical,
      source: 'seed:entity-extractor',
    })),
  ),
  ...seed(BUZZ_POSITIVE, 'buzz_positive', 'seed:scoring-movement-direction'),
  ...seed(BUZZ_NEGATIVE, 'buzz_negative', 'seed:scoring-movement-direction'),
  ...seed(BLOCKING_TERMS, 'blocking', 'seed:news-ingest-blocking'),
];
