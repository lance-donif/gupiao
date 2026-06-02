ALTER TABLE "StockExposureCandidate"
  ADD COLUMN IF NOT EXISTS "evidenceText" TEXT,
  ADD COLUMN IF NOT EXISTS "validFromCandidate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "coverageGapCaseId" TEXT;

CREATE INDEX IF NOT EXISTS "StockExposureCandidate_coverageGapCaseId_idx"
ON "StockExposureCandidate"("coverageGapCaseId");

CREATE TABLE IF NOT EXISTS "HistoricalLimitUpCase" (
  "id" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "clusterKey" TEXT NOT NULL DEFAULT 'global',
  "symbol" TEXT NOT NULL,
  "stockName" TEXT NOT NULL,
  "tradeDate" TIMESTAMP(3) NOT NULL,
  "touchLimit" BOOLEAN NOT NULL DEFAULT false,
  "sealedLimit" BOOLEAN NOT NULL DEFAULT false,
  "prevClose" DECIMAL(18,4) NOT NULL,
  "high" DECIMAL(18,4) NOT NULL,
  "close" DECIMAL(18,4) NOT NULL,
  "boardType" TEXT NOT NULL,
  "limitThresholdPct" DECIMAL(5,4) NOT NULL,
  "diagnosticsJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HistoricalLimitUpCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "HistoricalLimitUpCase_traceId_symbol_tradeDate_key"
ON "HistoricalLimitUpCase"("traceId", "symbol", "tradeDate");

CREATE INDEX IF NOT EXISTS "HistoricalLimitUpCase_clusterKey_tradeDate_idx"
ON "HistoricalLimitUpCase"("clusterKey", "tradeDate");

CREATE INDEX IF NOT EXISTS "HistoricalLimitUpCase_clusterKey_tradeDate_sealedLimit_idx"
ON "HistoricalLimitUpCase"("clusterKey", "tradeDate", "sealedLimit");

CREATE INDEX IF NOT EXISTS "HistoricalLimitUpCase_clusterKey_symbol_tradeDate_idx"
ON "HistoricalLimitUpCase"("clusterKey", "symbol", "tradeDate");

CREATE TABLE IF NOT EXISTS "CoverageGapCase" (
  "id" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "clusterKey" TEXT NOT NULL DEFAULT 'global',
  "asOf" TIMESTAMP(3) NOT NULL,
  "symbol" TEXT NOT NULL,
  "stockName" TEXT NOT NULL,
  "tradeDate" TIMESTAMP(3) NOT NULL,
  "historicalCaseId" TEXT,
  "gapStage" TEXT NOT NULL,
  "missReason" TEXT NOT NULL,
  "selectedRank" INTEGER,
  "scoreAtAsOf" DECIMAL(10,4),
  "diagnosticsJson" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CoverageGapCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CoverageGapCase_traceId_symbol_tradeDate_gapStage_missReason_key"
ON "CoverageGapCase"("traceId", "symbol", "tradeDate", "gapStage", "missReason");

CREATE INDEX IF NOT EXISTS "CoverageGapCase_clusterKey_asOf_missReason_idx"
ON "CoverageGapCase"("clusterKey", "asOf", "missReason");

CREATE INDEX IF NOT EXISTS "CoverageGapCase_clusterKey_tradeDate_status_idx"
ON "CoverageGapCase"("clusterKey", "tradeDate", "status");

CREATE INDEX IF NOT EXISTS "CoverageGapCase_historicalCaseId_idx"
ON "CoverageGapCase"("historicalCaseId");

CREATE TABLE IF NOT EXISTS "KeywordAlias" (
  "id" TEXT NOT NULL,
  "traceId" TEXT,
  "clusterKey" TEXT NOT NULL DEFAULT 'global',
  "sourceKeyword" TEXT NOT NULL,
  "canonicalKeyword" TEXT NOT NULL,
  "relationType" TEXT NOT NULL,
  "confidence" DECIMAL(5,4) NOT NULL,
  "source" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "evidenceText" TEXT NOT NULL,
  "validFrom" TIMESTAMP(3) NOT NULL,
  "validTo" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'candidate',
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KeywordAlias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "KeywordAlias_clusterKey_sourceKeyword_canonicalKeyword_relationType_source_sourceId_key"
ON "KeywordAlias"("clusterKey", "sourceKeyword", "canonicalKeyword", "relationType", "source", "sourceId");

CREATE INDEX IF NOT EXISTS "KeywordAlias_clusterKey_sourceKeyword_status_idx"
ON "KeywordAlias"("clusterKey", "sourceKeyword", "status");

CREATE INDEX IF NOT EXISTS "KeywordAlias_clusterKey_canonicalKeyword_status_idx"
ON "KeywordAlias"("clusterKey", "canonicalKeyword", "status");

CREATE INDEX IF NOT EXISTS "KeywordAlias_clusterKey_validFrom_validTo_idx"
ON "KeywordAlias"("clusterKey", "validFrom", "validTo");

CREATE TABLE IF NOT EXISTS "FactSnapshot" (
  "id" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "clusterKey" TEXT NOT NULL DEFAULT 'global',
  "asOf" TIMESTAMP(3) NOT NULL,
  "factHash" TEXT NOT NULL,
  "activeExposureCount" INTEGER NOT NULL,
  "activeAliasCount" INTEGER NOT NULL,
  "sourceSummaryJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FactSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FactSnapshot_traceId_key"
ON "FactSnapshot"("traceId");

CREATE INDEX IF NOT EXISTS "FactSnapshot_clusterKey_asOf_idx"
ON "FactSnapshot"("clusterKey", "asOf");

CREATE INDEX IF NOT EXISTS "FactSnapshot_clusterKey_factHash_idx"
ON "FactSnapshot"("clusterKey", "factHash");
