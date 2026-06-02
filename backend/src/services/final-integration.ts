import type { IAgentExecutionRecord, IAgentRuntimeEvent } from '../index.js';
import type { IProviderNewsArticlePayload, IProviderNewsResponse, ISourceProviderHealthStatus } from '../sources/contracts.js';

import type { IBackendIntegrationConfig } from './integration-config.js';
import type { INewsIngestResult } from './news-ingest-types.js';
import type { PrismaClientAdapter } from './prisma-adapter.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ControlledAgentStateContext, createAgentExecutionContext, createAgentRunner, createInMemoryAgentExecutionStore, createNewsIngestAgentCommand, createSchedulerTaskRequest, EventRecorder, IdleState, Scheduler } from '../index.js';
import { PrismaUnitOfWork } from '../repositories/unit-of-work.js';
import { createProviderRequestMetadata, TavilyNewsSource } from '../sources/index.js';
import { createBackendIntegrationConfig, requireEnvironmentValue } from './integration-config.js';
import { NewsIngestService } from './news-ingest-service.js';
import { createPrismaClientAdapter } from './prisma-adapter.js';
import { AkToolsHttpNewsProvider } from './tavily-news-provider.js';

export interface IFinalIntegrationDiagnosticEvent {
  readonly runId: string;
  readonly cluster: string;
  readonly provider: string;
  readonly source?: string;
  readonly serviceStage: string;
  readonly eventType: string;
  readonly failureCategory?: string;
  readonly detail: string;
}

export interface IFinalIntegrationPersistedNewsSnapshot {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly publishedAt: string;
  readonly capturedAt: string;
  readonly clusterKey: string;
  readonly sourceRef: string | null;
  readonly runContextId: string | null;
}

export interface IFinalIntegrationReport {
  readonly status: 'success' | 'failure';
  readonly runId: string;
  readonly cluster: string;
  readonly provider: string;
  readonly diagnostics: readonly IFinalIntegrationDiagnosticEvent[];
  readonly rawNewsFilePath?: string;
  readonly serviceResult?: INewsIngestResult;
  readonly agentEvents?: readonly IAgentRuntimeEvent[];
  readonly executionRecord?: IAgentExecutionRecord | null;
  readonly persistedNews: readonly IFinalIntegrationPersistedNewsSnapshot[];
  readonly replayContext?: {
    readonly asOf?: string;
    readonly windowStart?: string;
    readonly windowEnd?: string;
    readonly deduplicationKey: string;
    readonly sourceHealth?: string;
    readonly duplicateScheduleDetected: boolean;
  };
  readonly failureCategory?: string;
}

export interface IFinalIntegrationRequest {
  readonly cluster: string;
  readonly query: string;
  readonly asOf: Date;
  readonly timeWindow: {
    readonly start: Date;
    readonly end: Date;
  };
  readonly limit?: number;
}

export interface IFinalIntegrationHarnessDependencies {
  readonly prismaFactory?: (databaseUrl: string) => PrismaClientAdapter;
  readonly rawNewsArtifactWriter?: IRawNewsArtifactWriter;
}

export interface IRawNewsSummary {
  readonly totalNewsCount: number;
  readonly sourcesBreakdown: Readonly<Record<string, number>>;
  readonly earliestPublishedAt: string | null;
  readonly latestPublishedAt: string | null;
  readonly fetchedAt: string;
  readonly query: string;
  readonly cluster: string;
  readonly runId: string;
}

export interface IRawNewsArtifact {
  readonly provider: string;
  readonly sourceHealth: string;
  readonly timeWindow?: {
    readonly start: string;
    readonly end: string;
  };
  readonly limit: number | null;
  readonly deduplicationKey: string;
  readonly requestMetadata: {
    readonly requestId: string;
    readonly providerIdentity: string;
    readonly queryRef?: string;
  };
  readonly summary: IRawNewsSummary;
  readonly rawNews: readonly IProviderNewsArticlePayload[];
}

export interface IRawNewsArtifactWriter {
  write: (artifact: IRawNewsArtifact) => Promise<string>;
}

const createRunId = (): string => {
  return `final-integration-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`;
};

const resolveTmpDirectory = (): string => {
  return path.resolve(process.cwd(), 'backend', 'tmp');
};

const toPublishedTimestamp = (raw: string): number | null => {
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
};

const createSourcesBreakdown = (
  items: readonly IProviderNewsArticlePayload[],
): Readonly<Record<string, number>> => {
  return items.reduce<Record<string, number>>((accumulator, item) => {
    const source = typeof item.providerMetadata?.source === 'string'
      ? item.providerMetadata.source
      : 'unknown';
    accumulator[source] = (accumulator[source] ?? 0) + 1;
    return accumulator;
  }, {});
};

const resolveBoundaryTimestamps = (
  items: readonly IProviderNewsArticlePayload[],
): { readonly earliestPublishedAt: string | null; readonly latestPublishedAt: string | null } => {
  const datedItems = items
    .map(item => ({
      item,
      timestamp: toPublishedTimestamp(item.publishedAt),
    }))
    .filter((entry): entry is { readonly item: IProviderNewsArticlePayload; readonly timestamp: number } => {
      return entry.timestamp !== null;
    });

  if (datedItems.length === 0) {
    return {
      earliestPublishedAt: null,
      latestPublishedAt: null,
    };
  }

  const sorted = [...datedItems].sort((left, right) => left.timestamp - right.timestamp);
  return {
    earliestPublishedAt: sorted[0]?.item.publishedAt ?? null,
    latestPublishedAt: sorted.at(-1)?.item.publishedAt ?? null,
  };
};

const buildRawNewsArtifact = (
  runId: string,
  request: IFinalIntegrationRequest,
  response: Extract<IProviderNewsResponse, { readonly status: 'success' }>,
  providerName: string,
  sourceHealth: ISourceProviderHealthStatus,
): IRawNewsArtifact => {
  const { earliestPublishedAt, latestPublishedAt } = resolveBoundaryTimestamps(response.payload.items);
  const deduplicationKey = [
    request.cluster,
    request.asOf.toISOString(),
    `${request.timeWindow.start.toISOString()}..${request.timeWindow.end.toISOString()}`,
    `news-ingest::${request.query}`,
  ].join('::');

  return {
    provider: providerName,
    sourceHealth: sourceHealth.detail,
    timeWindow: {
      start: request.timeWindow.start.toISOString(),
      end: request.timeWindow.end.toISOString(),
    },
    limit: request.limit ?? null,
    deduplicationKey,
    requestMetadata: {
      requestId: response.metadata.requestId,
      providerIdentity: response.metadata.providerIdentity,
      queryRef: response.metadata.queryRef,
    },
    summary: {
      totalNewsCount: response.payload.items.length,
      sourcesBreakdown: createSourcesBreakdown(response.payload.items),
      earliestPublishedAt,
      latestPublishedAt,
      fetchedAt: response.payload.items[0]?.capturedAt ?? new Date().toISOString(),
      query: request.query,
      cluster: request.cluster,
      runId,
    },
    rawNews: response.payload.items,
  };
};

export class FileSystemRawNewsArtifactWriter implements IRawNewsArtifactWriter {
  private readonly directoryPath: string;

  public constructor(directoryPath: string = resolveTmpDirectory()) {
    this.directoryPath = directoryPath;
  }

  public async write(artifact: IRawNewsArtifact): Promise<string> {
    await mkdir(this.directoryPath, { recursive: true });
    const filePath = path.join(this.directoryPath, `${artifact.summary.runId}-raw-news.json`);
    await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    return filePath;
  }
}

const toDiagnostic = (
  input: Omit<IFinalIntegrationDiagnosticEvent, 'detail'> & { readonly detail?: string },
): IFinalIntegrationDiagnosticEvent => {
  return {
    ...input,
    detail: input.detail ?? input.serviceStage,
  };
};

const createFailureReport = (
  runId: string,
  cluster: string,
  provider: string,
  diagnostics: readonly IFinalIntegrationDiagnosticEvent[],
  persistedNews: readonly IFinalIntegrationPersistedNewsSnapshot[],
  failureCategory: string,
  rawNewsFilePath?: string,
): IFinalIntegrationReport => {
  return {
    status: 'failure',
    runId,
    cluster,
    provider,
    diagnostics,
    rawNewsFilePath,
    persistedNews,
    failureCategory,
  };
};

const mapPersistedNews = async (prisma: PrismaClientAdapter): Promise<readonly IFinalIntegrationPersistedNewsSnapshot[]> => {
  const records = await prisma.newsItem.findMany();

  return records.map(record => ({
    id: record.id,
    title: record.title,
    source: record.source,
    publishedAt: record.publishedAt.toISOString(),
    capturedAt: record.capturedAt.toISOString(),
    clusterKey: record.clusterKey,
    sourceRef: record.sourceRef ?? null,
    runContextId: record.runContextId ?? null,
  }));
};

const resolveResponseSource = (response: Awaited<ReturnType<AkToolsHttpNewsProvider['executeAsync']>>): string | undefined => {
  if (response.status === 'failure') {
    return undefined;
  }

  const firstItem = response.payload.items[0];
  const source = firstItem?.providerMetadata?.source;
  return typeof source === 'string' ? source : undefined;
};

export class FinalIntegrationHarness {
  private readonly config: IBackendIntegrationConfig;

  private readonly dependencies: IFinalIntegrationHarnessDependencies;

  public constructor(
    config: IBackendIntegrationConfig = createBackendIntegrationConfig(),
    dependencies: IFinalIntegrationHarnessDependencies = {},
  ) {
    this.config = config;
    this.dependencies = dependencies;
  }

  public async run(request: IFinalIntegrationRequest): Promise<IFinalIntegrationReport> {
    const runId = createRunId();
    const providerName = 'aktools-news-provider';
    const diagnostics: IFinalIntegrationDiagnosticEvent[] = [];
    let rawNewsFilePath: string | undefined;

    let prisma: PrismaClientAdapter | null = null;

    try {
      const aktoolsBaseUrl = requireEnvironmentValue(this.config.aktoolsBaseUrl, 'AKTOOLS_BASE_URL');
      prisma = this.dependencies.prismaFactory?.(this.config.databaseUrl)
        ?? createPrismaClientAdapter(this.config.databaseUrl);
      await prisma.$connect();

      diagnostics.push(toDiagnostic({
        runId,
        cluster: request.cluster,
        provider: providerName,
        serviceStage: 'bootstrap',
        eventType: 'integration-started',
      }));

      const provider = new AkToolsHttpNewsProvider({
        baseUrl: aktoolsBaseUrl,
        maxResults: this.config.aktoolsMaxResults,
      });

      const response = await provider.executeAsync({
        query: request.query,
        asOf: request.asOf,
        timeWindow: request.timeWindow,
        limit: request.limit,
      }, createProviderRequestMetadata());

      diagnostics.push(toDiagnostic({
        runId,
        cluster: request.cluster,
        provider: providerName,
        source: resolveResponseSource(response),
        serviceStage: 'source-fetch',
        eventType: response.status === 'success' ? 'source-fetch-succeeded' : 'source-fetch-failed',
        failureCategory: response.status === 'failure' ? response.failure.category : undefined,
        detail: response.status === 'success'
          ? `fetched=${response.payload.items.length}; health=${provider.getHealthStatus().detail}`
          : response.failure.message,
      }));

      if (response.status === 'failure') {
        return createFailureReport(
          runId,
          request.cluster,
          providerName,
          diagnostics,
          [],
          response.failure.category,
          rawNewsFilePath,
        );
      }

      const rawNewsArtifactWriter = this.dependencies.rawNewsArtifactWriter
        ?? new FileSystemRawNewsArtifactWriter();

      try {
        const rawNewsArtifact = buildRawNewsArtifact(
          runId,
          request,
          response,
          providerName,
          provider.getHealthStatus(),
        );
        rawNewsFilePath = await rawNewsArtifactWriter.write(rawNewsArtifact);
        diagnostics.push(toDiagnostic({
          runId,
          cluster: request.cluster,
          provider: providerName,
          serviceStage: 'raw-news-artifact',
          eventType: 'raw-news-artifact-written',
          detail: rawNewsFilePath,
        }));
      }
      catch (error) {
        diagnostics.push(toDiagnostic({
          runId,
          cluster: request.cluster,
          provider: providerName,
          serviceStage: 'raw-news-artifact',
          eventType: 'raw-news-artifact-write-failed',
          failureCategory: 'artifact_write_failed',
          detail: error instanceof Error ? error.message : 'unknown raw news artifact write failure',
        }));
      }

      const source = new TavilyNewsSource({
        name: provider.name,
        execute: (): typeof response => response,
        isAvailable: (): boolean => provider.isAvailable(),
        getHealthStatus: (): ReturnType<AkToolsHttpNewsProvider['getHealthStatus']> => provider.getHealthStatus(),
      });
      const unitOfWork = new PrismaUnitOfWork(prisma);
      const service = new NewsIngestService({
        source,
        unitOfWork,
      });

      const serviceResult = await service.execute({
        cluster: request.cluster,
        query: request.query,
        asOf: request.asOf,
        timeWindow: request.timeWindow,
        limit: request.limit,
      });

      for (const stage of serviceResult.summary.stageReports) {
        diagnostics.push(toDiagnostic({
          runId,
          cluster: request.cluster,
          provider: providerName,
          serviceStage: stage.stage,
          eventType: 'service-stage-completed',
          detail: stage.detail,
        }));
      }

      if (serviceResult.status === 'failure') {
        diagnostics.push(toDiagnostic({
          runId,
          cluster: request.cluster,
          provider: providerName,
          serviceStage: 'service-result',
          eventType: 'service-failed',
          failureCategory: serviceResult.summary.failure.category,
          detail: serviceResult.summary.failure.message,
        }));

        return createFailureReport(
          runId,
          request.cluster,
          providerName,
          diagnostics,
          await mapPersistedNews(prisma),
          serviceResult.summary.failure.category,
          rawNewsFilePath,
        );
      }

      Scheduler.resetForTesting();
      const scheduler = Scheduler.getInstance();
      const events = new EventRecorder<IAgentRuntimeEvent>();
      const executionStore = createInMemoryAgentExecutionStore();
      const schedulerTask = createSchedulerTaskRequest({
        runId,
        taskId: `${runId}-task`,
        cluster: request.cluster,
        taskKind: 'news-ingest' as const,
        triggeredAt: new Date(),
        asOf: request.asOf,
        timeWindow: request.timeWindow,
        payload: {
          query: request.query,
          limit: request.limit,
        },
      });

      let duplicateScheduleDetected = false;

      const agentRun = await scheduler.schedule(schedulerTask, ({ context, isDuplicate }) => {
        duplicateScheduleDetected = isDuplicate;
        const runner = createAgentRunner({ eventRecorder: events, executionObserver: executionStore });
        const command = createNewsIngestAgentCommand(
          createAgentExecutionContext(context),
          schedulerTask.payload,
          {
            execute: async (): Promise<INewsIngestResult> => service.execute({
              cluster: context.cluster,
              query: request.query,
              asOf: context.asOf,
              timeWindow: context.timeWindow,
              limit: request.limit,
            }),
          },
        );
        const state = new ControlledAgentStateContext(new IdleState(), {
          runId: context.runId,
          taskId: context.taskId,
          taskKind: context.taskKind,
          eventSubject: {
            notify(event): void {
              events.update(event);
            },
          },
        });

        return runner.run({ command, state });
      });

      const executionRecord = await executionStore.findByRunId(runId);

      for (const event of agentRun.events) {
        diagnostics.push(toDiagnostic({
          runId,
          cluster: request.cluster,
          provider: providerName,
          serviceStage: 'agent-runner',
          eventType: event.eventType,
          failureCategory: 'failureCategory' in event ? event.failureCategory : undefined,
          detail: JSON.stringify(event),
        }));
      }

      const persistedNews = await mapPersistedNews(prisma);

      return {
        status: agentRun.summary.success ? 'success' : 'failure',
        runId,
        cluster: request.cluster,
        provider: providerName,
        diagnostics,
        rawNewsFilePath,
        serviceResult,
        agentEvents: agentRun.events,
        executionRecord,
        persistedNews,
        replayContext: {
          asOf: request.asOf.toISOString(),
          windowStart: request.timeWindow.start.toISOString(),
          windowEnd: request.timeWindow.end.toISOString(),
          deduplicationKey: serviceResult.summary.executionContext.idempotency.deduplicationKey,
          sourceHealth: provider.getHealthStatus().detail,
          duplicateScheduleDetected,
        },
        failureCategory: agentRun.summary.failure?.category,
      };
    }
    catch (error) {
      diagnostics.push(toDiagnostic({
        runId,
        cluster: request.cluster,
        provider: providerName,
        serviceStage: 'integration-exception',
        eventType: 'integration-failed',
        failureCategory: 'integration_exception',
        detail: error instanceof Error ? error.message : 'unknown integration exception',
      }));

      return createFailureReport(
        runId,
        request.cluster,
        providerName,
        diagnostics,
        prisma ? await mapPersistedNews(prisma) : [],
        'integration_exception',
        rawNewsFilePath,
      );
    }
    finally {
      if (prisma) {
        await prisma.$disconnect();
      }
    }
  }
}
