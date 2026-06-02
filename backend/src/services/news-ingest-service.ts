import type { IUnitOfWork } from '../repositories/unit-of-work.js';
import type { INewsSource } from '../sources/contracts.js';
import type { NewsItem } from '../types/entities/news-item.js';
import type { INormalizedNewsCandidate } from './news-ingest-pipeline.js';

import type { INewsIngestExecutionRequest, INewsIngestFailureResult, INewsIngestResult, INewsIngestStageReport, INewsIngestSuccessResult } from './news-ingest-types.js';
import crypto from 'node:crypto';
import {

  NewsIngestDeduplicationPipeline,
  NewsIngestNormalizationPipeline,
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

export class NewsIngestService {
  private readonly normalizationPipeline = new NewsIngestNormalizationPipeline();

  private readonly deduplicationPipeline = new NewsIngestDeduplicationPipeline();

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

    // 将采集到的原始新闻存入 RawNewsRecord (只读账本层)
    for (const article of sourceResult.items) {
      const titleHash = crypto.createHash('sha256').update(article.title).digest('hex');
      await this.dependencies.unitOfWork.newsRepository.addRawRecord({
        title: article.title,
        content: article.summary,
        source: article.metadata.provider,
        url: article.url,
        publishedAt: article.publishedAt,
        clusterKey: request.cluster,
        rawMetadata: article.metadata as any,
        titleHash,
      });
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
    for (const item of newsItems) {
      await this.dependencies.unitOfWork.newsRepository.add(item);
    }

    for (const cand of candidates) {
      await this.dependencies.unitOfWork.newsRepository.addNormalizedRecord({
        id: cand.id,
        title: cand.title,
        content: cand.content,
        source: cand.source,
        url: cand.url,
        publishedAt: cand.publishedAt,
        clusterKey,
        reprintGroupId: cand.reprintGroupId ?? cand.id,
        reprintWeight: cand.reprintWeight ?? 1.0,
      });
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
