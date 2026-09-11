import type { ICrossBatchNewsRecord } from '../repositories/interfaces/i-news-repository.js';
import type { IUnitOfWork } from '../repositories/unit-of-work.js';
import type { INewsSource } from '../sources/contracts.js';
import type { NewsItem } from '../types/entities/news-item.js';
import type { INormalizedNewsCandidate } from './news-ingest-pipeline.js';

import type { INewsIngestExecutionRequest, INewsIngestFailureResult, INewsIngestResult, INewsIngestStageReport, INewsIngestSuccessResult } from './news-ingest-types.js';
import crypto from 'node:crypto';
import {
  calculateCosineSimilarity,
  NewsIngestDeduplicationPipeline,
  NewsIngestNormalizationPipeline,
  REPRINT_CONTENT_SIMILARITY_THRESHOLD,
  REPRINT_TITLE_SIMILARITY_THRESHOLD,
  toNewsItems,
} from './news-ingest-pipeline.js';
import {

  NewsIngestFailureCategory,
} from './news-ingest-types.js';
import {
  createServiceExecutionContext,
  hasExplicitRuntimeBoundary,
  isDateInsideRuntimeWindow,
} from './service-types.js';

interface INewsIngestServiceDependencies {
  readonly source: INewsSource;
  readonly unitOfWork: IUnitOfWork;
  /** 转载分桶词（DB KeywordDictionary category='blocking'）；缺失时去重阶段直接抛错。 */
  readonly keywordBlockingTerms?: readonly string[];
}

const createFetchStageReport = (
  fetchedCount: number,
  detail: string,
): INewsIngestStageReport => {
  return {
    stage: 'fetch',
    inputCount: 0,
    outputCount: fetchedCount,
    detail,
  };
};

const createStageReport = (
  stage: 'normalize' | 'deduplicate' | 'persist',
  inputCount: number,
  outputCount: number,
  detail: string,
): INewsIngestStageReport => {
  return {
    stage,
    inputCount,
    outputCount,
    detail,
  };
};

export const CROSS_BATCH_MERGE_LOOKBACK_MS = 72 * 3600_000;
export const CROSS_BATCH_MERGE_REPRINT_WEIGHT = 0.15;

/**
 * 跨批转载归并：仅批内首条（reprintWeight==1.0）与库内近 72h 记录比对，
 * 命中（标题>0.6 或正文>0.85，与批内阈值一致）则并入已有分组并降权 0.15。
 * 批内已归并的非首条保持原分组语义不动；同 id（幂等重放）跳过。
 * 返回归并条数。
 */
export const applyCrossBatchReprintMerge = (
  candidates: readonly INormalizedNewsCandidate[],
  existing: readonly ICrossBatchNewsRecord[],
): number => {
  let merged = 0;
  for (const candidate of candidates) {
    if ((candidate.reprintWeight ?? 1.0) !== 1.0) {
      continue;
    }
    for (const record of existing) {
      if (record.id === candidate.id) {
        continue;
      }
      const titleSim = calculateCosineSimilarity(candidate.title, record.title);
      const isReprint = titleSim > REPRINT_TITLE_SIMILARITY_THRESHOLD
        || calculateCosineSimilarity(candidate.content, record.content) > REPRINT_CONTENT_SIMILARITY_THRESHOLD;
      if (!isReprint) {
        continue;
      }
      candidate.reprintGroupId = record.reprintGroupId ?? record.id;
      candidate.reprintWeight = CROSS_BATCH_MERGE_REPRINT_WEIGHT;
      merged += 1;
      break;
    }
  }
  return merged;
};

export class NewsIngestService {
  private readonly normalizationPipeline = new NewsIngestNormalizationPipeline();

  private get deduplicationPipeline(): NewsIngestDeduplicationPipeline {
    return new NewsIngestDeduplicationPipeline({ blockingTerms: this.dependencies.keywordBlockingTerms });
  }

  public constructor(private readonly dependencies: INewsIngestServiceDependencies) {}

  public async execute(request: INewsIngestExecutionRequest): Promise<INewsIngestResult> {
    const executionContext = createServiceExecutionContext(request, `news-ingest::${request.query}`);
    const sourceResult = this.dependencies.source.fetch({
      query: request.query,
      asOf: request.asOf,
      timeWindow: request.timeWindow,
      limit: request.limit,
    });

    if (sourceResult.status === 'failure') {
      return this.createFailureResult(request, executionContext, [
        createFetchStageReport(0, sourceResult.failure.message),
      ], {
        category: NewsIngestFailureCategory.SourceFailed,
        message: sourceResult.failure.message,
        sourceCategory: sourceResult.failure.category,
      });
    }

    // 将采集到的原始新闻存入 RawNewsRecord (只读账本层) — 批量写入消除 N+1
    if (sourceResult.items.length > 0) {
      const rawRecords = sourceResult.items.map((article) => {
        const titleHash = crypto.createHash('sha256').update(article.title).digest('hex');
        return {
          title: article.title,
          content: article.summary,
          source: article.metadata.provider,
          url: article.url,
          publishedAt: article.publishedAt,
          clusterKey: request.cluster,
          rawMetadata: article.metadata as any,
          titleHash,
        };
      });
      await this.dependencies.unitOfWork.newsRepository.addManyRawRecords(rawRecords);
    }

    const stageReports: INewsIngestStageReport[] = [
      createFetchStageReport(sourceResult.items.length, `fetched from ${this.dependencies.source.name}`),
    ];
    const normalizationReport = this.normalizationPipeline.process(sourceResult.items);
    stageReports.push(
      createStageReport(
        'normalize',
        normalizationReport.input.length,
        normalizationReport.processed.length,
        normalizationReport.steps.join(' -> '),
      ),
    );

    const deduplicationReport = this.deduplicationPipeline.process(normalizationReport.processed);
    const persistedNewsItems = await this.dependencies.unitOfWork.newsRepository.findAll();
    const persistedIds = new Set(persistedNewsItems.map(item => item.id));
    const runtimeScopedCandidates = hasExplicitRuntimeBoundary(executionContext.runtime)
      ? deduplicationReport.processed.filter((candidate) => {
          return isDateInsideRuntimeWindow(candidate.publishedAt, executionContext.runtime);
        })
      : deduplicationReport.processed;
    const idempotentCandidates = runtimeScopedCandidates.filter((candidate) => {
      return !persistedIds.has(candidate.id);
    });
    const deduplicationSteps = [...deduplicationReport.steps];

    if (runtimeScopedCandidates.length !== deduplicationReport.processed.length) {
      deduplicationSteps.push('deduplicate:drop-future-window-items');
    }

    if (idempotentCandidates.length !== runtimeScopedCandidates.length) {
      deduplicationSteps.push('deduplicate:drop-already-persisted-items');
    }

    // N3 跨批转载归并：单次查询库内近 72h 同 cluster 记录（publishedAt<=asOf，
    // 回测不穿越未来数据），内存复用批内余弦阈值比对。查询失败则跳过归并、
    // 保持原有行为，不阻塞新鲜新闻入库。
    const crossBatchAsOf = request.asOf ?? new Date();
    try {
      const recentRecords = await this.dependencies.unitOfWork.newsRepository.findRecentNormalizedRecords(
        request.cluster,
        new Date(crossBatchAsOf.getTime() - CROSS_BATCH_MERGE_LOOKBACK_MS),
        crossBatchAsOf,
      );
      const mergedCount = applyCrossBatchReprintMerge(idempotentCandidates, recentRecords);
      if (mergedCount > 0) {
        deduplicationSteps.push(`deduplicate:cross-batch-merge:${mergedCount}`);
      }
    }
    catch (error) {
      deduplicationSteps.push(
        `deduplicate:cross-batch-merge-skipped:${error instanceof Error ? error.message : 'unknown'}`,
      );
    }

    stageReports.push(
      createStageReport(
        'deduplicate',
        deduplicationReport.input.length,
        idempotentCandidates.length,
        deduplicationSteps.join(' -> '),
      ),
    );

    const newsItems = toNewsItems(idempotentCandidates);

    if (newsItems.length === 0) {
      stageReports.push(
        createStageReport('persist', 0, 0, 'idempotent replay skipped persistence'),
      );

      return this.createSuccessResult(
        request,
        executionContext,
        stageReports,
        sourceResult.items.length,
        normalizationReport.processed.length,
        newsItems,
      );
    }

    try {
      await this.persist(newsItems, idempotentCandidates, request.cluster);
    }
    catch (error) {
      stageReports.push(
        createStageReport(
          'persist',
          newsItems.length,
          0,
          error instanceof Error ? error.message : 'unknown persistence failure',
        ),
      );

      return this.createFailureResult(request, executionContext, stageReports, {
        category: NewsIngestFailureCategory.PersistenceFailed,
        message: error instanceof Error ? error.message : 'unknown persistence failure',
      }, {
        fetchedCount: sourceResult.items.length,
        normalizedCount: normalizationReport.processed.length,
        deduplicatedCount: newsItems.length,
      });
    }

    stageReports.push(
      createStageReport('persist', newsItems.length, newsItems.length, 'committed via unit-of-work'),
    );

    return this.createSuccessResult(
      request,
      executionContext,
      stageReports,
      sourceResult.items.length,
      normalizationReport.processed.length,
      newsItems,
    );
  }

  private async persist(
    newsItems: readonly NewsItem[],
    candidates: readonly INormalizedNewsCandidate[],
    clusterKey: string,
  ): Promise<void> {
    // 批量写入消除 N+1：一次 createMany 替代逐条 create
    await this.dependencies.unitOfWork.newsRepository.addMany(newsItems);

    if (candidates.length > 0) {
      const normalizedRecords = candidates.map((cand) => ({
        id: cand.id,
        title: cand.title,
        content: cand.content,
        source: cand.source,
        url: cand.url,
        publishedAt: cand.publishedAt,
        clusterKey,
        reprintGroupId: cand.reprintGroupId ?? cand.id,
        reprintWeight: cand.reprintWeight ?? 1.0,
      }));
      await this.dependencies.unitOfWork.newsRepository.addManyNormalizedRecords(normalizedRecords);
    }

    await this.dependencies.unitOfWork.commit();
  }

  private createSuccessResult(
    request: INewsIngestExecutionRequest,
    executionContext: ReturnType<typeof createServiceExecutionContext>,
    stageReports: readonly INewsIngestStageReport[],
    fetchedCount: number,
    normalizedCount: number,
    newsItems: readonly NewsItem[],
  ): INewsIngestSuccessResult {
    return {
      status: 'success',
      summary: {
        executionContext,
        cluster: request.cluster,
        query: request.query,
        fetchedCount,
        normalizedCount,
        deduplicatedCount: newsItems.length,
        persistedCount: newsItems.length,
        persistedIds: newsItems.map(item => item.id),
        stageReports,
      },
    };
  }

  private createFailureResult(
    request: INewsIngestExecutionRequest,
    executionContext: ReturnType<typeof createServiceExecutionContext>,
    stageReports: readonly INewsIngestStageReport[],
    failure: INewsIngestFailureResult['summary']['failure'],
    counts: {
      readonly fetchedCount?: number;
      readonly normalizedCount?: number;
      readonly deduplicatedCount?: number;
    } = {},
  ): INewsIngestFailureResult {
    return {
      status: 'failure',
      summary: {
        executionContext,
        cluster: request.cluster,
        query: request.query,
        fetchedCount: counts.fetchedCount ?? 0,
        normalizedCount: counts.normalizedCount ?? 0,
        deduplicatedCount: counts.deduplicatedCount ?? 0,
        persistedCount: 0,
        persistedIds: [],
        stageReports,
        failure,
      },
    };
  }
}
