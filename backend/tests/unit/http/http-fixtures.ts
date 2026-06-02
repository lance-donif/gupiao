import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { IBackendArtifacts, IBackendConfigStore } from '../../../src/http/index.js';

export const createHttpArtifacts = (): IBackendArtifacts => ({
  graphSnapshot: {
    generatedAtBeijing: '2026-03-18 10:00:00',
    sourceNewsFilePath: 'tmp/raw-news-latest.json',
    graph: {
      nodes: [
        {
          keyword: '机器人',
          category: 'theme',
          frequency: 3,
          temperature: 'hot',
          weakSignal: false,
        },
        {
          keyword: '智能制造',
          category: 'industry',
          frequency: 2,
          temperature: 'warming',
          weakSignal: true,
        },
      ],
      relationships: [
        {
          sourceKeyword: '机器人',
          targetKeyword: '智能制造',
          relationType: 'driver',
          direction: 'forward',
          confidence: 0.88,
          status: 'effective',
          weakSignal: false,
          evidence: ['机器人带动智能制造'],
          updatedAt: '2026-03-18T02:00:00.000Z',
        },
      ],
    },
    tree: {
      depthLimit: 1,
      rootKeywords: ['机器人'],
      roots: [],
    },
    aiDecisions: [],
  },
  recommendationFile: {
    generatedAtBeijing: '2026-03-18 10:00:00',
    newsFilePath: 'tmp/raw-news-latest.json',
    stockFilePath: 'tmp/stock-sync.json',
    summary: {
      keywordCount: 2,
      candidateCount: 2,
      totalRecommendations: 2,
      maxPerIndustry: 2,
    },
    recommendations: [
      {
        symbol: '300024',
        stockName: '机器人',
        industry: '机器人',
        score: 91.2,
        matchedSignals: ['机器人'],
        matchedBoards: ['智能制造'],
        reasons: ['命中关键词 机器人'],
        scoreBreakdown: {
          keywordFrequencyScore: 3,
          temperatureScore: 2,
          relationshipConfidenceScore: 2,
          boardMatchScore: 2,
          weakSignalBonus: 0,
          coverageBonus: 1,
        },
      },
      {
        symbol: '000333',
        stockName: '美的集团',
        industry: '智能制造',
        score: 88.6,
        matchedSignals: ['智能制造'],
        matchedBoards: ['智能制造'],
        reasons: ['命中关键词 智能制造'],
        scoreBreakdown: {
          keywordFrequencyScore: 2,
          temperatureScore: 2,
          relationshipConfidenceScore: 2,
          boardMatchScore: 2,
          weakSignalBonus: 0,
          coverageBonus: 1,
        },
      },
      {
        symbol: '600519',
        stockName: '贵州茅台',
        industry: '消费',
        score: 74.2,
        matchedSignals: ['消费升级'],
        matchedBoards: ['白酒'],
        reasons: ['防御属性增强'],
        scoreBreakdown: {
          keywordFrequencyScore: 1,
          temperatureScore: 1,
          relationshipConfidenceScore: 1,
          boardMatchScore: 2,
          weakSignalBonus: 0,
          coverageBonus: 1,
        },
      },
    ],
  },
  stockPayload: {
    syncedAtBeijing: '2026-03-18 10:00:00',
    totalSymbols: 3,
    successCount: 3,
    failedCount: 0,
    failedSymbols: [],
    requestedSymbols: ['300024', '000333', '600519'],
    data: [
      {
        symbol: '300024',
        price: 21.34,
        currency: 'CNY',
        marketTime: '2026-03-18 15:00:00',
        capturedAt: '2026-03-18 15:01:00',
        providerMetadata: {
          yahooSymbol: '300024.SZ',
          source: 'yahoo-finance',
        },
      },
      {
        symbol: '000333',
        price: 58.22,
        currency: 'CNY',
        marketTime: '2026-03-18 15:00:00',
        capturedAt: '2026-03-18 15:01:00',
        providerMetadata: {
          yahooSymbol: '000333.SZ',
          source: 'yahoo-finance',
        },
      },
      {
        symbol: '600519',
        price: 1650.12,
        currency: 'CNY',
        marketTime: '2026-03-18 15:00:00',
        capturedAt: '2026-03-18 15:01:00',
        providerMetadata: {
          yahooSymbol: '600519.SS',
          source: 'yahoo-finance',
        },
      },
    ],
  },
});

export async function writeHttpArtifacts(rootDir: string): Promise<void> {
  const tmpPath = path.join(rootDir, 'tmp');
  await mkdir(path.join(tmpPath, 'http-runtime'), { recursive: true });
  const artifacts = createHttpArtifacts();
  await writeFile(
    path.join(tmpPath, 'friend-network-latest.json'),
    `${JSON.stringify(artifacts.graphSnapshot, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(tmpPath, 'recommendations-latest.json'),
    `${JSON.stringify(artifacts.recommendationFile, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(tmpPath, 'stock-sync-latest.json'),
    `${JSON.stringify(artifacts.stockPayload, null, 2)}\n`,
    'utf8',
  );
}

export class InMemoryConfigStore implements IBackendConfigStore {
  private readonly values = new Map<string, string>([
    ['ai.model', 'deepseek-chat'],
    ['ai.provider', 'builtin-runtime'],
    ['akshare.enabled', 'false'],
    ['strategy.max_depth', '3'],
    ['system.backend_http_port', '8000'],
  ]);

  public async listByCategory(category: 'ai' | 'akshare' | 'strategy' | 'system') {
    return [...this.values.entries()]
      .filter(([key]) => key.startsWith(`${category}.`))
      .map(([key, value]) => ({
        key,
        value,
        category,
        label: key,
        is_secret: false,
      }));
  }

  public async setValue(key: string, value: string) {
    this.values.set(key, value);
    return {
      key,
      value,
      message: 'updated',
    };
  }
}
