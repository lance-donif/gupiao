export interface IFriendNetworkEntityExtractionInput {
  readonly title: string;
  readonly summary: string;
}

const DYNAMIC_STOP_WORDS = new Set([
  '记者',
  '今天',
  '今年',
  '其中',
  '公告',
  '公告称',
  '日电',
  '工作要点',
  '发布',
  '印发',
  '全面',
  '提高',
  '推动',
  '满足',
  '需要',
  '公司',
  '项目',
  '建设',
  '资金',
  '自筹资金',
  '自有资金',
  '包括',
  '进行',
  '加大',
  '支持',
]);

const HIGH_SIGNAL_SUFFIXES = [
  '白银',
  '黄金',
  '铜',
  '锂',
  '煤炭',
  '煤矿',
  '瓦斯',
  '石油',
  '天然气',
  '霍尔木兹海峡',
  '海峡',
  '机器人',
  'AI',
  '算力',
  '基础模型',
  '智能生态',
  '半导体',
  '芯片',
  '智能机器人',
  '叉车',
  '制造业',
  '无人机',
  '涡扇发动机',
  '发动机',
  '航空发动机',
  '航空',
  '军工',
  '先进制造业',
  '产业',
  '产业链',
  '行业',
  '证券',
  '跨境证券',
  '量化私募',
  '高频交易',
  '内幕交易',
  '银行',
  '央行',
  '储备银行',
  '利率',
  '基准利率',
  '加息',
  '降息',
  '融资',
  '贷款',
  '信用贷款',
  '质押融资',
  '无还本续贷',
  '研发贷',
  '园区贷',
  '专精特新贷',
  '新能源',
  '光伏',
  '半导体',
  '军工',
  '科技创新',
  '营商环境',
] as const;

const HIGH_SIGNAL_TERMS = [...HIGH_SIGNAL_SUFFIXES].sort((left, right) => right.length - left.length);

const CANONICAL_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/战略性新兴产业/g, '战略性新兴产业'],
  [/先进制造业/g, '先进制造业'],
  [/智能机器人/g, '智能机器人'],
  [/企业信用贷款/g, '企业信用贷款'],
  [/知识产权质押融资/g, '知识产权质押融资'],
  [/基准利率/g, '基准利率'],
  [/澳央行|澳大利亚储备银行/g, '澳央行'],
  [/储备银行/g, '储备银行'],
  [/无还本续贷/g, '无还本续贷'],
  [/专精特新贷/g, '专精特新贷'],
  [/研发贷/g, '研发贷'],
  [/园区贷/g, '园区贷'],
  [/新能源/g, '新能源'],
  [/光伏/g, '光伏'],
  [/煤矿/g, '煤矿'],
  [/煤炭/g, '煤炭'],
  [/瓦斯/g, '瓦斯'],
  [/霍尔木兹海峡/g, '霍尔木兹海峡'],
  [/石油/g, '石油'],
  [/天然气/g, '天然气'],
  [/AI/g, 'AI'],
  [/算力/g, '算力'],
  [/基础模型/g, '基础模型'],
  [/半导体/g, '半导体'],
  [/芯片/g, '芯片'],
  [/无人机/g, '无人机'],
  [/涡扇发动机/g, '涡扇发动机'],
  [/航空发动机/g, '航空发动机'],
  [/军工/g, '军工'],
  [/跨境证券/g, '跨境证券'],
  [/量化私募/g, '量化私募'],
  [/高频交易/g, '高频交易'],
  [/内幕交易/g, '内幕交易'],
  [/证券/g, '证券'],
  [/白银/g, '白银'],
  [/黄金/g, '黄金'],
  [/银行/g, '银行'],
  [/融资/g, '融资'],
  [/贷款/g, '贷款'],
  [/利率/g, '利率'],
  [/加息/g, '加息'],
  [/机器人/g, '机器人'],
  [/叉车/g, '叉车'],
  [/制造业/g, '制造业'],
  [/科技创新/g, '科技创新'],
  [/营商环境/g, '营商环境'],
] as const;

const normalizeText = (text: string): string => {
  return text.replace(/[\s，。；：、“”‘’（）()【】《》,.;:!?]/g, '');
};

const isHighSignalPhrase = (phrase: string): boolean => {
  if (phrase.length < 2 || phrase.length > 12) {
    return false;
  }

  if (DYNAMIC_STOP_WORDS.has(phrase)) {
    return false;
  }

  return HIGH_SIGNAL_SUFFIXES.some(suffix => phrase.endsWith(suffix) || phrase.includes(suffix));
};

const collectCanonicalEntities = (text: string, target: Set<string>): void => {
  for (const [pattern, canonical] of CANONICAL_REPLACEMENTS) {
    if (pattern.test(text)) {
      target.add(canonical);
    }
  }
};

const collectDynamicCandidates = (text: string, target: Set<string>): void => {
  const candidates = text.match(/[\u4E00-\u9FA5]{2,12}/g) ?? [];

  for (const candidate of candidates) {
    if (isHighSignalPhrase(candidate)) {
      target.add(candidate);
    }
  }
};

const deduplicateEntities = (entities: readonly string[]): string[] => {
  const canonicalTerms = new Set<string>(HIGH_SIGNAL_TERMS);
  const sorted = [...new Set(entities)].sort((left, right) => {
    const leftPriority = canonicalTerms.has(left) ? 1 : 0;
    const rightPriority = canonicalTerms.has(right) ? 1 : 0;
    if (leftPriority !== rightPriority) {
      return rightPriority - leftPriority;
    }
    return right.length - left.length;
  });
  const result: string[] = [];

  for (const entity of sorted) {
    if (result.some(existing => existing.includes(entity) || entity.includes(existing))) {
      if (!result.includes(entity) && !result.includes(entity)) {
        continue;
      }
    }

    if (!result.includes(entity)) {
      result.push(entity);
    }
  }

  return result.slice(0, 6);
};

const expandCanonicalEntities = (text: string, target: Set<string>): void => {
  for (const term of HIGH_SIGNAL_TERMS) {
    if (text.includes(term)) {
      target.add(term);
    }
  }
};

export const extractSignalEntities = (inputs: readonly IFriendNetworkEntityExtractionInput[]): string[] => {
  const entities = new Set<string>();

  for (const input of inputs) {
    const title = normalizeText(input.title);
    const summary = normalizeText(input.summary);
    collectCanonicalEntities(title, entities);
    collectCanonicalEntities(summary, entities);
    expandCanonicalEntities(title, entities);
    expandCanonicalEntities(summary, entities);
    collectDynamicCandidates(title, entities);
    collectDynamicCandidates(summary, entities);
  }

  return deduplicateEntities([...entities]);
};
