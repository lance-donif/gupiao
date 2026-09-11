import type { IKeywordDictionarySnapshot, IKeywordDictionaryRow } from '../../src/services/keyword-dictionary.js';

/** 最小可用词表快照：覆盖亲友树单测常用信号词（新能源/白银/高端制造/先进制造业）。 */
export const stubKeywordDictionary: IKeywordDictionarySnapshot = {
  stopwords: new Set(['记者', '今天', '公司']),
  highSignalTerms: ['新能源', '白银', '高端制造', '先进制造业', '半导体'],
  canonicalGroups: [],
  buzzPositive: ['封涨停板', '大笔买入'],
  buzzNegative: ['封跌停板', '大笔卖出'],
  blockingTerms: ['新能源', '白银'],
  entryCount: 11,
  loadedAt: new Date('2026-09-11T00:00:00.000Z'),
};

const buzzRow = (term: string, category: 'buzz_positive' | 'buzz_negative'): IKeywordDictionaryRow => ({
  term,
  category,
  status: 'active',
});

/** 与原硬编码正负正则同语义的行级 fixture，供 mock prisma 的 keywordDictionary.findMany 使用。 */
export const stubKeywordDictionaryRows: readonly IKeywordDictionaryRow[] = [
  ...['火箭发射', '快速反弹', '大笔买入', '封涨停板', '打开跌停板', '有大买盘', '竞价上涨', '高开5日线', '向上缺口', '60日新高', '60日大幅上涨', '拉升', '净流入'].map(term => buzzRow(term, 'buzz_positive')),
  ...['加速下跌', '高台跳水', '大笔卖出', '封跌停板', '打开涨停板', '有大卖盘', '竞价下跌', '低开5日线', '向下缺口', '60日新低', '60日大幅下跌'].map(term => buzzRow(term, 'buzz_negative')),
  { term: '新能源', category: 'high_signal', status: 'active' },
  { term: '白银', category: 'high_signal', status: 'active' },
  { term: '记者', category: 'stopword', status: 'active' },
];
