CREATE TABLE "StockExposureCandidate" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "clusterKey" TEXT NOT NULL DEFAULT 'global',
    "symbol" TEXT NOT NULL,
    "stockName" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "exposureType" TEXT NOT NULL,
    "taxonomyLevel" TEXT,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "evidenceJson" JSONB NOT NULL,
    "memberCount" INTEGER,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockExposureCandidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StockExposureFact" (
    "id" TEXT NOT NULL,
    "traceId" TEXT,
    "clusterKey" TEXT NOT NULL DEFAULT 'global',
    "symbol" TEXT NOT NULL,
    "stockName" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "exposureType" TEXT NOT NULL,
    "taxonomyLevel" TEXT,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "evidenceJson" JSONB NOT NULL,
    "memberCount" INTEGER,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockExposureFact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CausalSignalCandidate" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "clusterKey" TEXT NOT NULL DEFAULT 'global',
    "newsId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "businessVariable" TEXT NOT NULL,
    "assetOrThemeKeyword" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "evidenceText" TEXT NOT NULL,
    "evidenceOffsetStart" INTEGER,
    "evidenceOffsetEnd" INTEGER,
    "extractorType" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CausalSignalCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockExposureCandidate_traceId_symbol_keyword_exposureType_source_sourceId_key"
ON "StockExposureCandidate"("traceId", "symbol", "keyword", "exposureType", "source", "sourceId");

CREATE INDEX "StockExposureCandidate_clusterKey_asOf_status_idx"
ON "StockExposureCandidate"("clusterKey", "asOf", "status");

CREATE INDEX "StockExposureCandidate_clusterKey_symbol_keyword_idx"
ON "StockExposureCandidate"("clusterKey", "symbol", "keyword");

CREATE INDEX "StockExposureCandidate_clusterKey_source_sourceId_idx"
ON "StockExposureCandidate"("clusterKey", "source", "sourceId");

CREATE UNIQUE INDEX "StockExposureFact_clusterKey_symbol_keyword_exposureType_source_sourceId_key"
ON "StockExposureFact"("clusterKey", "symbol", "keyword", "exposureType", "source", "sourceId");

CREATE INDEX "StockExposureFact_clusterKey_symbol_keyword_idx"
ON "StockExposureFact"("clusterKey", "symbol", "keyword");

CREATE INDEX "StockExposureFact_clusterKey_keyword_status_idx"
ON "StockExposureFact"("clusterKey", "keyword", "status");

CREATE INDEX "StockExposureFact_clusterKey_source_sourceId_idx"
ON "StockExposureFact"("clusterKey", "source", "sourceId");

CREATE INDEX "StockExposureFact_clusterKey_validFrom_validTo_idx"
ON "StockExposureFact"("clusterKey", "validFrom", "validTo");

CREATE UNIQUE INDEX "CausalSignalCandidate_traceId_newsId_businessVariable_assetOrThemeKeyword_extractorType_key"
ON "CausalSignalCandidate"("traceId", "newsId", "businessVariable", "assetOrThemeKeyword", "extractorType");

CREATE INDEX "CausalSignalCandidate_traceId_confidence_idx"
ON "CausalSignalCandidate"("traceId", "confidence");

CREATE INDEX "CausalSignalCandidate_clusterKey_asOf_status_idx"
ON "CausalSignalCandidate"("clusterKey", "asOf", "status");

CREATE INDEX "CausalSignalCandidate_clusterKey_assetOrThemeKeyword_idx"
ON "CausalSignalCandidate"("clusterKey", "assetOrThemeKeyword");

CREATE INDEX "CausalSignalCandidate_newsId_idx"
ON "CausalSignalCandidate"("newsId");
