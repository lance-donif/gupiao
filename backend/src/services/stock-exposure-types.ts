export type StockExposureType
  = | 'industry_exposure'
    | 'concept_exposure'
    | 'business_exposure'
    | 'company_profile_exposure'
    | 'movement_evidence';

export type StockExposureStatus = 'candidate' | 'promoted' | 'rejected' | 'active' | 'inactive';

export interface IStockExposureEvidence {
  readonly schemaVersion: 'stock-exposure-evidence-v1';
  readonly provider: string;
  readonly requestUrl: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly description?: string;
  readonly payloadHash: string;
  readonly observedAt: string;
  readonly rawSymbol: string;
  readonly normalizedSymbol: string;
  readonly memberCount?: number;
  readonly confidenceReason: string;
  readonly rawFields?: Readonly<Record<string, unknown>>;
}

export interface IStockExposureCandidateRecord {
  readonly traceId: string;
  readonly asOf: Date;
  readonly clusterKey: string;
  readonly symbol: string;
  readonly stockName: string;
  readonly keyword: string;
  readonly exposureType: StockExposureType;
  readonly taxonomyLevel?: string;
  readonly source: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly confidence: number;
  readonly evidenceJson: IStockExposureEvidence;
  readonly memberCount?: number;
  readonly validFrom: Date;
  readonly validTo?: Date | null;
  readonly status: 'candidate';
  readonly failureReason?: string | null;
}

export interface IStockExposureFactRecord extends Omit<IStockExposureCandidateRecord, 'status' | 'failureReason'> {
  readonly status: 'active';
}

export interface IStockExposureRejectedRecord extends Omit<IStockExposureCandidateRecord, 'status'> {
  readonly status: 'rejected';
  readonly failureReason: string;
}
