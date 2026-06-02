import type { IUnitOfWork } from '../repositories/unit-of-work.js';
import type { IStockSource, IStockSourceQuote } from '../sources/contracts.js';
import type { IStockSyncDecision, IStockSyncExecutionRequest, IStockSyncFailureResult, IStockSyncResult, IStockSyncStageReport, IStockSyncSuccessResult } from './stock-sync-types.js';
import { Candle, Stock } from '../types/entities/stock.js';

import { Price } from '../types/value-objects/price.js';
import { Symbol } from '../types/value-objects/symbol.js';

import { TradeDate } from '../types/value-objects/trade-date.js';
import {
  createServiceExecutionContext,
  hasExplicitRuntimeBoundary,
  isDateInsideRuntimeWindow,
} from './service-types.js';
import {

  StockSyncFailureCategory,
} from './stock-sync-types.js';

interface IStockSyncServiceDependencies {
  readonly source: IStockSource;
  readonly unitOfWork: IUnitOfWork;
}

interface IMappedQuote {
  readonly stockId: string;
  readonly symbol: string;
  readonly stockName: string;
  readonly industry: string;
  readonly candle: Candle;
}

const createStageReport = (
  stage: 'fetch' | 'map-domain' | 'plan-sync' | 'persist',
  inputCount: number,
  outputCount: number,
  detail: string,
): IStockSyncStageReport => {
  return {
    stage,
    inputCount,
    outputCount,
    detail,
  };
};

const normalizeDomainSymbol = (raw: string): string => {
  return raw.replace(/\..*$/, '');
};

const createStockId = (symbol: string): string => {
  return `stock-${symbol}`;
};

const toMappedQuote = (
  request: IStockSyncExecutionRequest,
  quote: IStockSourceQuote,
): IMappedQuote => {
  const normalizedSymbol = normalizeDomainSymbol(quote.symbol);

  return {
    stockId: normalizedSymbol === normalizeDomainSymbol(request.symbol)
      ? request.stockId
      : createStockId(normalizedSymbol),
    symbol: normalizedSymbol,
    stockName: normalizedSymbol === normalizeDomainSymbol(request.symbol)
      ? request.stockName
      : normalizedSymbol,
    industry: request.industry,
    candle: new Candle(
      TradeDate.from(quote.marketTime),
      Price.from(quote.price),
      Price.from(quote.price),
      Price.from(quote.price),
      Price.from(quote.price),
      0,
    ),
  };
};

const hasTradeDay = (stock: Stock, candle: Candle): boolean => {
  return stock.candles.some(existingCandle => existingCandle.date.equals(candle.date));
};

export class StockSyncService {
  public constructor(private readonly dependencies: IStockSyncServiceDependencies) {}

  public async execute(request: IStockSyncExecutionRequest): Promise<IStockSyncResult> {
    const executionContext = createServiceExecutionContext(request, `stock-sync::${request.symbol}`);
    const sourceResult = this.dependencies.source.fetch({
      symbol: request.symbol,
      asOf: request.asOf,
      timeWindow: request.timeWindow,
      limit: request.limit,
    });
    const hasExplicitBoundary = hasExplicitRuntimeBoundary(executionContext.runtime);

    if (sourceResult.status === 'failure') {
      return this.createFailureResult(request, executionContext, [
        createStageReport('fetch', 0, 0, sourceResult.failure.message),
      ], {
        category: StockSyncFailureCategory.SourceFailed,
        message: sourceResult.failure.message,
        sourceCategory: sourceResult.failure.category,
      });
    }

    const stageReports: IStockSyncStageReport[] = [
      createStageReport('fetch', 0, sourceResult.items.length, `fetched from ${this.dependencies.source.name}`),
    ];

    const runtimeScopedQuotes = hasExplicitBoundary
      ? sourceResult.items.filter((quote) => {
          return isDateInsideRuntimeWindow(quote.marketTime, executionContext.runtime);
        })
      : sourceResult.items;
    const mappedQuotes = runtimeScopedQuotes.map(quote => toMappedQuote(request, quote));
    const mapDetail = runtimeScopedQuotes.length === sourceResult.items.length
      ? 'mapped quotes into stock/candle entities'
      : 'mapped quotes into stock/candle entities -> drop-future-window-quotes';
    stageReports.push(
      createStageReport('map-domain', sourceResult.items.length, mappedQuotes.length, mapDetail),
    );

    const existingStocks = await this.dependencies.unitOfWork.stockRepository.findAll();
    const stockById = new Map(existingStocks.map(stock => [stock.id, stock] as const));

    const created: IStockSyncDecision[] = [];
    const updated: IStockSyncDecision[] = [];
    const skipped: IStockSyncDecision[] = [];
    const plannedStocks = new Map<string, Stock>();

    for (const mappedQuote of mappedQuotes) {
      const existingStock = plannedStocks.get(mappedQuote.stockId) ?? stockById.get(mappedQuote.stockId);
      const candleTradeDay = mappedQuote.candle.date.toString();

      if (!existingStock) {
        const createdStock = new Stock(
          mappedQuote.stockId,
          Symbol.from(mappedQuote.symbol),
          mappedQuote.stockName,
          mappedQuote.industry,
          [mappedQuote.candle],
        );
        plannedStocks.set(mappedQuote.stockId, createdStock);
        created.push({
          kind: 'created',
          stockId: mappedQuote.stockId,
          symbol: mappedQuote.symbol,
          candleTradeDay,
          reason: 'missing stock in repository',
        });
        continue;
      }

      if (hasTradeDay(existingStock, mappedQuote.candle)) {
        skipped.push({
          kind: 'skipped',
          stockId: existingStock.id,
          symbol: existingStock.symbol.toString(),
          candleTradeDay,
          reason: 'trade day already synchronized',
        });
        plannedStocks.set(existingStock.id, existingStock);
        continue;
      }

      const nextStock = new Stock(
        existingStock.id,
        existingStock.symbol,
        existingStock.name,
        existingStock.industry,
        [...existingStock.candles, mappedQuote.candle],
      );
      plannedStocks.set(existingStock.id, nextStock);
      updated.push({
        kind: 'updated',
        stockId: existingStock.id,
        symbol: existingStock.symbol.toString(),
        candleTradeDay,
        reason: 'new candle trade day detected',
      });
    }

    const persistedStocks = [...new Map([
      ...created.map(decision => [decision.stockId, plannedStocks.get(decision.stockId)] as const),
      ...updated.map(decision => [decision.stockId, plannedStocks.get(decision.stockId)] as const),
    ]).values()].filter((stock): stock is Stock => Boolean(stock));

    stageReports.push(
      createStageReport(
        'plan-sync',
        mappedQuotes.length,
        persistedStocks.length,
        `created=${created.length}, updated=${updated.length}, skipped=${skipped.length}`,
      ),
    );

    if (persistedStocks.length === 0) {
      stageReports.push(
        createStageReport('persist', 0, 0, 'idempotent replay skipped persistence'),
      );

      return this.createSuccessResult(
        request,
        executionContext,
        stageReports,
        sourceResult.items.length,
        mappedQuotes.length,
        persistedStocks,
        created,
        updated,
        skipped,
      );
    }

    try {
      for (const stock of persistedStocks) {
        const existsInRepository = stockById.has(stock.id);
        if (existsInRepository) {
          await this.dependencies.unitOfWork.stockRepository.remove(stock.id);
        }
        await this.dependencies.unitOfWork.stockRepository.add(stock);
      }

      await this.dependencies.unitOfWork.commit();
    }
    catch (error) {
      stageReports.push(
        createStageReport(
          'persist',
          persistedStocks.length,
          0,
          error instanceof Error ? error.message : 'unknown persistence failure',
        ),
      );

      return this.createFailureResult(request, executionContext, stageReports, {
        category: StockSyncFailureCategory.PersistenceFailed,
        message: error instanceof Error ? error.message : 'unknown persistence failure',
      }, {
        fetchedCount: sourceResult.items.length,
        mappedCount: mappedQuotes.length,
        created,
        updated,
        skipped,
      });
    }

    stageReports.push(
      createStageReport('persist', persistedStocks.length, persistedStocks.length, 'committed via unit-of-work'),
    );

    return this.createSuccessResult(
      request,
      executionContext,
      stageReports,
      sourceResult.items.length,
      mappedQuotes.length,
      persistedStocks,
      created,
      updated,
      skipped,
    );
  }

  private createSuccessResult(
    request: IStockSyncExecutionRequest,
    executionContext: ReturnType<typeof createServiceExecutionContext>,
    stageReports: readonly IStockSyncStageReport[],
    fetchedCount: number,
    mappedCount: number,
    persistedStocks: readonly Stock[],
    created: readonly IStockSyncDecision[],
    updated: readonly IStockSyncDecision[],
    skipped: readonly IStockSyncDecision[],
  ): IStockSyncSuccessResult {
    return {
      status: 'success',
      summary: {
        executionContext,
        cluster: request.cluster,
        requestedSymbol: request.symbol,
        fetchedCount,
        mappedCount,
        persistedCount: persistedStocks.length,
        persistedStockIds: persistedStocks.map(stock => stock.id),
        decisions: {
          created,
          updated,
          skipped,
        },
        stageReports,
      },
    };
  }

  private createFailureResult(
    request: IStockSyncExecutionRequest,
    executionContext: ReturnType<typeof createServiceExecutionContext>,
    stageReports: readonly IStockSyncStageReport[],
    failure: IStockSyncFailureResult['summary']['failure'],
    summary: {
      readonly fetchedCount?: number;
      readonly mappedCount?: number;
      readonly created?: readonly IStockSyncDecision[];
      readonly updated?: readonly IStockSyncDecision[];
      readonly skipped?: readonly IStockSyncDecision[];
    } = {},
  ): IStockSyncFailureResult {
    return {
      status: 'failure',
      summary: {
        executionContext,
        cluster: request.cluster,
        requestedSymbol: request.symbol,
        fetchedCount: summary.fetchedCount ?? 0,
        mappedCount: summary.mappedCount ?? 0,
        persistedCount: 0,
        persistedStockIds: [],
        decisions: {
          created: summary.created ?? [],
          updated: summary.updated ?? [],
          skipped: summary.skipped ?? [],
        },
        stageReports,
        failure,
      },
    };
  }
}
