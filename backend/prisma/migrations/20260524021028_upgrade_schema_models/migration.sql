-- CreateEnum
CREATE TYPE "RunContextKind" AS ENUM ('INGEST', 'BACKTEST', 'ANALYSIS', 'SCHEDULER');

-- CreateTable
CREATE TABLE "RunContext" (
    "id" TEXT NOT NULL,
    "clusterKey" TEXT NOT NULL,
    "kind" "RunContextKind" NOT NULL,
    "asOf" TIMESTAMP(3),
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsItem" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clusterKey" TEXT NOT NULL,
    "runContextId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "exchange" TEXT,
    "clusterKey" TEXT NOT NULL,
    "runContextId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "latestTradeDay" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candle" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "tradingDay" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(18,4) NOT NULL,
    "high" DECIMAL(18,4) NOT NULL,
    "low" DECIMAL(18,4) NOT NULL,
    "close" DECIMAL(18,4) NOT NULL,
    "volume" BIGINT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawNewsRecord" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clusterKey" TEXT NOT NULL,
    "rawMetadata" JSONB NOT NULL,
    "titleHash" TEXT NOT NULL,

    CONSTRAINT "RawNewsRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NormalizedNewsRecord" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clusterKey" TEXT NOT NULL,
    "reprintGroupId" TEXT,
    "reprintWeight" DECIMAL(3,2) NOT NULL DEFAULT 1.0,

    CONSTRAINT "NormalizedNewsRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceContribution" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "newsId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "baseFrequencyScore" DECIMAL(10,4) NOT NULL,
    "timeDecayedScore" DECIMAL(10,4) NOT NULL,
    "reprintPenaltyScore" DECIMAL(10,4) NOT NULL,
    "finalContribScore" DECIMAL(10,4) NOT NULL,
    "reasons" TEXT[],
    "asOf" TIMESTAMP(3) NOT NULL,
    "clusterKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphSnapshot" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "clusterKey" TEXT NOT NULL,
    "nodesJson" JSONB NOT NULL,
    "edgesJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GraphSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockFeatureSnapshot" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "clusterKey" TEXT NOT NULL,
    "newsFrequencyScore" DECIMAL(10,4) NOT NULL,
    "relationConfidenceScore" DECIMAL(10,4) NOT NULL,
    "boardMatchScore" DECIMAL(10,4) NOT NULL,
    "weakSignalBonus" DECIMAL(10,4) NOT NULL,
    "aggregatedScore" DECIMAL(10,4) NOT NULL,
    "reasons" TEXT[],

    CONSTRAINT "StockFeatureSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationSnapshot" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "clusterKey" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "stockName" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "finalScore" DECIMAL(10,4) NOT NULL,
    "reasons" TEXT[],
    "scoreBreakdown" JSONB NOT NULL,
    "yield1Day" DECIMAL(6,4),
    "yield3Day" DECIMAL(6,4),
    "yield5Day" DECIMAL(6,4),
    "realizedPrice" DECIMAL(18,4),
    "realizedPriceTarget" DECIMAL(18,4),
    "isReconciled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RecommendationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunTrace" (
    "traceId" TEXT NOT NULL,
    "clusterKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "errorMessage" TEXT,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RunTrace_pkey" PRIMARY KEY ("traceId")
);

-- CreateTable
CREATE TABLE "PipelineStepTrace" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "stepName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "inputSummary" JSONB NOT NULL,
    "outputSummary" JSONB NOT NULL,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "PipelineStepTrace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RunContext_clusterKey_kind_idx" ON "RunContext"("clusterKey", "kind");

-- CreateIndex
CREATE INDEX "RunContext_clusterKey_asOf_idx" ON "RunContext"("clusterKey", "asOf");

-- CreateIndex
CREATE INDEX "NewsItem_clusterKey_publishedAt_idx" ON "NewsItem"("clusterKey", "publishedAt");

-- CreateIndex
CREATE INDEX "NewsItem_runContextId_publishedAt_idx" ON "NewsItem"("runContextId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NewsItem_clusterKey_source_publishedAt_title_key" ON "NewsItem"("clusterKey", "source", "publishedAt", "title");

-- CreateIndex
CREATE INDEX "Stock_clusterKey_industry_idx" ON "Stock"("clusterKey", "industry");

-- CreateIndex
CREATE INDEX "Stock_runContextId_latestTradeDay_idx" ON "Stock"("runContextId", "latestTradeDay");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_clusterKey_symbol_key" ON "Stock"("clusterKey", "symbol");

-- CreateIndex
CREATE INDEX "Candle_stockId_tradingDay_idx" ON "Candle"("stockId", "tradingDay");

-- CreateIndex
CREATE INDEX "Candle_tradingDay_idx" ON "Candle"("tradingDay");

-- CreateIndex
CREATE UNIQUE INDEX "Candle_stockId_tradingDay_key" ON "Candle"("stockId", "tradingDay");

-- CreateIndex
CREATE INDEX "RawNewsRecord_clusterKey_publishedAt_idx" ON "RawNewsRecord"("clusterKey", "publishedAt");

-- CreateIndex
CREATE INDEX "RawNewsRecord_capturedAt_idx" ON "RawNewsRecord"("capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawNewsRecord_clusterKey_source_publishedAt_titleHash_key" ON "RawNewsRecord"("clusterKey", "source", "publishedAt", "titleHash");

-- CreateIndex
CREATE INDEX "NormalizedNewsRecord_clusterKey_publishedAt_idx" ON "NormalizedNewsRecord"("clusterKey", "publishedAt");

-- CreateIndex
CREATE INDEX "NormalizedNewsRecord_reprintGroupId_idx" ON "NormalizedNewsRecord"("reprintGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "NormalizedNewsRecord_clusterKey_reprintGroupId_url_key" ON "NormalizedNewsRecord"("clusterKey", "reprintGroupId", "url");

-- CreateIndex
CREATE INDEX "EvidenceContribution_traceId_symbol_idx" ON "EvidenceContribution"("traceId", "symbol");

-- CreateIndex
CREATE INDEX "EvidenceContribution_clusterKey_asOf_symbol_idx" ON "EvidenceContribution"("clusterKey", "asOf", "symbol");

-- CreateIndex
CREATE INDEX "EvidenceContribution_symbol_keyword_idx" ON "EvidenceContribution"("symbol", "keyword");

-- CreateIndex
CREATE UNIQUE INDEX "GraphSnapshot_traceId_key" ON "GraphSnapshot"("traceId");

-- CreateIndex
CREATE INDEX "GraphSnapshot_clusterKey_asOf_idx" ON "GraphSnapshot"("clusterKey", "asOf");

-- CreateIndex
CREATE INDEX "StockFeatureSnapshot_clusterKey_asOf_symbol_idx" ON "StockFeatureSnapshot"("clusterKey", "asOf", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "StockFeatureSnapshot_traceId_symbol_key" ON "StockFeatureSnapshot"("traceId", "symbol");

-- CreateIndex
CREATE INDEX "RecommendationSnapshot_clusterKey_asOf_rank_idx" ON "RecommendationSnapshot"("clusterKey", "asOf", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationSnapshot_traceId_symbol_key" ON "RecommendationSnapshot"("traceId", "symbol");

-- CreateIndex
CREATE INDEX "RunTrace_clusterKey_status_idx" ON "RunTrace"("clusterKey", "status");

-- CreateIndex
CREATE INDEX "RunTrace_asOf_idx" ON "RunTrace"("asOf");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStepTrace_traceId_stepName_key" ON "PipelineStepTrace"("traceId", "stepName");

-- AddForeignKey
ALTER TABLE "NewsItem" ADD CONSTRAINT "NewsItem_runContextId_fkey" FOREIGN KEY ("runContextId") REFERENCES "RunContext"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stock" ADD CONSTRAINT "Stock_runContextId_fkey" FOREIGN KEY ("runContextId") REFERENCES "RunContext"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candle" ADD CONSTRAINT "Candle_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceContribution" ADD CONSTRAINT "EvidenceContribution_newsId_fkey" FOREIGN KEY ("newsId") REFERENCES "NormalizedNewsRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineStepTrace" ADD CONSTRAINT "PipelineStepTrace_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "RunTrace"("traceId") ON DELETE CASCADE ON UPDATE CASCADE;
