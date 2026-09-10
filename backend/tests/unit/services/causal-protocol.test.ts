import { describe, expect, it } from 'vitest';
import {
  CausalProtocolError,
  buildItemsProtocolInstruction,
  parseItemsProtocol,
  parseLegacyProtocol,
  protocolModeForVersion,
  toProtocolVersion,
} from '../../../src/services/causal-protocol.js';
import { CAUSAL_PROTOCOL_VERSION, CAUSAL_PROTOCOL_VERSION_ITEMS } from '../../../src/version.js';

const news = [
  { id: 'n1', title: '白银库存下降', content: '白银库存下降，供给不足。' },
  { id: 'n2', title: '光伏装机增长', content: '光伏装机需求增长，组件订单改善。' },
];

const signal = {
  event: '白银库存下降',
  businessVariable: '供给不足',
  assetOrThemeKeyword: '白银',
  direction: 'positive' as const,
  confidence: 0.9,
  evidenceText: '白银库存下降',
};

const expectCode = (fn: () => unknown, code: CausalProtocolError['code']) => {
  try {
    fn();
    throw new Error('expected parse to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(CausalProtocolError);
    expect((error as CausalProtocolError).code).toBe(code);
  }
};

describe('causal protocol v3 (items)', () => {
  it('normalizes items and preserves explicit no_signal outcomes', () => {
    const parsed = parseItemsProtocol({
      items: [
        { newsId: 'n1', status: 'signals', signals: [signal] },
        { newsId: 'n2', status: 'no_signal', signals: [] },
      ],
    }, news);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ newsId: 'n1', status: 'signals' });
    expect(parsed[0]!.signals[0]).toMatchObject({ evidenceOffsetStart: 0, evidenceOffsetEnd: 6 });
    expect(parsed[1]).toMatchObject({ newsId: 'n2', status: 'no_signal', signals: [] });
  });

  it('accepts a JSON string payload', () => {
    const parsed = parseItemsProtocol(JSON.stringify({ items: [
      { newsId: 'n1', status: 'no_signal', signals: [] },
      { newsId: 'n2', status: 'no_signal', signals: [] },
    ] }), news);
    expect(parsed).toHaveLength(2);
  });

  it('throws when a news outcome is missing', () => {
    expectCode(() => parseItemsProtocol({ items: [{ newsId: 'n1', status: 'no_signal', signals: [] }] }, news), 'missing_news');
  });

  it('throws on a duplicated news outcome', () => {
    expectCode(() => parseItemsProtocol({ items: [
      { newsId: 'n1', status: 'no_signal', signals: [] },
      { newsId: 'n1', status: 'no_signal', signals: [] },
    ] }, news), 'duplicate_news');
  });

  it('throws on an unknown news id', () => {
    expectCode(() => parseItemsProtocol({ items: [
      { newsId: 'n1', status: 'no_signal', signals: [] },
      { newsId: 'ghost', status: 'no_signal', signals: [] },
    ] }, news), 'unknown_news');
  });

  it('throws when status=signals carries an empty signals array', () => {
    expectCode(() => parseItemsProtocol({ items: [
      { newsId: 'n1', status: 'signals', signals: [] },
      { newsId: 'n2', status: 'no_signal', signals: [] },
    ] }, news), 'empty_signals');
  });

  it('throws when status=no_signal carries signals', () => {
    expectCode(() => parseItemsProtocol({ items: [
      { newsId: 'n1', status: 'no_signal', signals: [signal] },
      { newsId: 'n2', status: 'no_signal', signals: [] },
    ] }, news), 'unexpected_signals');
  });

  it('throws on invalid structures', () => {
    expectCode(() => parseItemsProtocol(null, news), 'invalid_structure');
    expectCode(() => parseItemsProtocol({}, news), 'invalid_structure');
    expectCode(() => parseItemsProtocol({ items: 'nope' }, news), 'invalid_structure');
    expectCode(() => parseItemsProtocol({ items: [null] }, news), 'invalid_structure');
    expectCode(() => parseItemsProtocol({ items: [{ newsId: 'n1', status: 'maybe', signals: [] }] }, news), 'invalid_structure');
    expectCode(() => parseItemsProtocol({ items: [{ newsId: 'n1', status: 'signals' }] }, news), 'invalid_structure');
  });

  it('throws on a malformed signal payload', () => {
    expectCode(() => parseItemsProtocol({ items: [
      { newsId: 'n1', status: 'signals', signals: [{ ...signal, confidence: 'high' }] },
      { newsId: 'n2', status: 'no_signal', signals: [] },
    ] }, news), 'invalid_signal');
    expectCode(() => parseItemsProtocol({ items: [
      { newsId: 'n1', status: 'signals', signals: [{ ...signal, direction: 'up' }] },
      { newsId: 'n2', status: 'no_signal', signals: [] },
    ] }, news), 'invalid_signal');
  });

  it('throws when evidence text cannot be located in the news', () => {
    expectCode(() => parseItemsProtocol({ items: [
      { newsId: 'n1', status: 'signals', signals: [{ ...signal, evidenceText: '原文不存在的证据' }] },
      { newsId: 'n2', status: 'no_signal', signals: [] },
    ] }, news), 'evidence_not_locatable');
  });

  it('throws on invalid JSON strings', () => {
    expectCode(() => parseItemsProtocol('{not json', news), 'invalid_json');
  });
});

describe('causal protocol v2 (legacy) normalization', () => {
  it('normalizes signals and no-signal news into the same item structure', () => {
    const parsed = parseLegacyProtocol({
      signals: [{ newsId: 'n1', ...signal }],
      noSignalNewsIds: ['n2'],
    }, news);
    expect(parsed).toEqual([
      { newsId: 'n1', status: 'signals', signals: [expect.objectContaining({ businessVariable: '供给不足' })] },
      { newsId: 'n2', status: 'no_signal', signals: [] },
    ]);
  });

  it('groups multiple signals for one news into a single item', () => {
    const parsed = parseLegacyProtocol({
      signals: [{ newsId: 'n1', ...signal }, { newsId: 'n1', ...signal, businessVariable: '价格上涨' }],
      noSignalNewsIds: ['n2'],
    }, news);
    expect(parsed[0]!.signals).toHaveLength(2);
  });

  it('throws for missing, unknown, overlapping and malformed legacy payloads', () => {
    expectCode(() => parseLegacyProtocol({ signals: [], noSignalNewsIds: ['n2'] }, news), 'missing_news');
    expectCode(() => parseLegacyProtocol({ signals: [{ newsId: 'ghost', ...signal }], noSignalNewsIds: ['n1', 'n2'] }, news), 'unknown_news');
    expectCode(() => parseLegacyProtocol({ signals: [{ newsId: 'n1', ...signal }], noSignalNewsIds: ['n1', 'n2'] }, news), 'duplicate_news');
    expectCode(() => parseLegacyProtocol({ signals: 'nope', noSignalNewsIds: [] }, news), 'invalid_structure');
    expectCode(() => parseLegacyProtocol({ signals: [{ ...signal }], noSignalNewsIds: [] }, news), 'invalid_structure');
    expectCode(() => parseLegacyProtocol({ signals: [{ newsId: 'n1', ...signal, evidenceText: '不存在' }], noSignalNewsIds: ['n2'] }, news), 'evidence_not_locatable');
  });
});

describe('causal protocol helpers', () => {
  it('maps modes to version.ts constants', () => {
    expect(toProtocolVersion('items')).toBe(CAUSAL_PROTOCOL_VERSION_ITEMS);
    expect(toProtocolVersion('legacy')).toBe(CAUSAL_PROTOCOL_VERSION);
    expect(protocolModeForVersion(CAUSAL_PROTOCOL_VERSION_ITEMS)).toBe('items');
    expect(protocolModeForVersion(CAUSAL_PROTOCOL_VERSION)).toBe('legacy');
    expectCode(() => protocolModeForVersion(99), 'invalid_structure');
  });

  it('builds an instruction that forbids cross-news facts and requires one outcome per input', () => {
    const instruction = buildItemsProtocolInstruction();
    expect(instruction).toContain('逐条独立抽取');
    expect(instruction).toContain('禁止把另一篇新闻');
    expect(instruction).toContain('逐条出现且只出现一次');
    expect(instruction).toContain('"items"');
  });
});
