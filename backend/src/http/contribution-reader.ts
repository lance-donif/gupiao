import type {
  IContributionDetailPayload,
  IContributionDetailQuery,
  IContributionDetailReader,
  IContributionDetailRow,
} from './types.js';

interface IMinimalPgClient {
  query: <T>(sql: string, values?: readonly unknown[]) => Promise<{ rows: readonly T[] }>;
  end: () => Promise<void>;
}

interface IContributionDbRow {
  readonly news_id: string;
  readonly keyword: string;
  readonly source_keyword: string | null;
  readonly matched_exposure_keyword: string | null;
  readonly exposure_fact_id: string | null;
  readonly match_method: string | null;
  readonly match_confidence: string | number | null;
  readonly base_frequency_score: string | number;
  readonly time_decayed_score: string | number;
  readonly reprint_penalty_score: string | number;
  readonly final_contrib_score: string | number;
  readonly reasons: readonly string[];
  readonly as_of: Date | string;
  readonly cluster_key: string;
}

const toScore = (value: string | number): number => Number(value);

const toIsoString = (value: Date | string): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
};

class PgContributionDetailReader implements IContributionDetailReader {
  public constructor(private readonly client: IMinimalPgClient) {}

  public async getContributionDetail(query: IContributionDetailQuery): Promise<IContributionDetailPayload> {
    const rows = await this.client.query<IContributionDbRow>(
      [
        'SELECT',
        '  "newsId" AS news_id,',
        '  keyword,',
        '  "sourceKeyword" AS source_keyword,',
        '  "matchedExposureKeyword" AS matched_exposure_keyword,',
        '  "exposureFactId" AS exposure_fact_id,',
        '  "matchMethod" AS match_method,',
        '  "matchConfidence" AS match_confidence,',
        '  "baseFrequencyScore" AS base_frequency_score,',
        '  "timeDecayedScore" AS time_decayed_score,',
        '  "reprintPenaltyScore" AS reprint_penalty_score,',
        '  "finalContribScore" AS final_contrib_score,',
        '  reasons,',
        '  "asOf" AS as_of,',
        '  "clusterKey" AS cluster_key',
        'FROM public."EvidenceContribution"',
        'WHERE "traceId" = $1 AND symbol = $2',
        'ORDER BY "finalContribScore" DESC, "asOf" DESC, "newsId" ASC',
      ].join(' '),
      [query.traceId, query.symbol],
    );
    const mappedRows: IContributionDetailRow[] = rows.rows.map(row => ({
      newsId: row.news_id,
      keyword: row.keyword,
      sourceKeyword: row.source_keyword,
      matchedExposureKeyword: row.matched_exposure_keyword,
      exposureFactId: row.exposure_fact_id,
      matchMethod: row.match_method,
      matchConfidence: row.match_confidence === null ? null : toScore(row.match_confidence),
      baseFrequencyScore: toScore(row.base_frequency_score),
      timeDecayedScore: toScore(row.time_decayed_score),
      reprintPenaltyScore: toScore(row.reprint_penalty_score),
      finalContribScore: toScore(row.final_contrib_score),
      reasons: row.reasons,
      asOf: toIsoString(row.as_of),
      clusterKey: row.cluster_key,
    }));
    const totalContribution = mappedRows.reduce((sum, row) => sum + row.finalContribScore, 0);
    return {
      traceId: query.traceId,
      symbol: query.symbol,
      totalContribution,
      rows: mappedRows,
    };
  }

  public close(): Promise<void> {
    return this.client.end();
  }
}

export const createContributionDetailReader = async (
  databaseUrl: string | undefined,
): Promise<IContributionDetailReader | undefined> => {
  if (!databaseUrl) {
    return undefined;
  }
  const pgModule = (await import('pg')) as unknown as {
    Pool: new (options: { connectionString: string }) => IMinimalPgClient;
  };
  return new PgContributionDetailReader(new pgModule.Pool({ connectionString: databaseUrl }));
};
