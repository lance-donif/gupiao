-- Phase 1 契约冻结（contract freeze）：仅新增，不删除、不修改现有列。
-- 新增 8 张表 + 对 7 个现有模型追加可空/带默认值的列，保证旧代码继续可跑。
--
-- 说明：本迁移在 `prisma migrate dev` 自动生成的基础上，剔除了仓库既有的历史漂移
-- 修复语句（DROP TABLE / DROP DEFAULT / RenameIndex 等），这些漂移与本阶段契约无关，
-- 且 `20260524170000_drop_legacy_stock_keyword_mapping` 已明确将其保留为 no-op。

-- ============================================================
-- 一、扩展现有模型（只新增列）
-- ============================================================

-- AlterTable
ALTER TABLE "AiWorkflow" ADD COLUMN "leaseGeneration" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "AiWorkItem" ADD COLUMN "leaseGeneration" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Candle"
ADD COLUMN "tradingStatus" TEXT,
ADD COLUMN "limitUpPrice" DECIMAL(12,4),
ADD COLUMN "limitDownPrice" DECIMAL(12,4),
ADD COLUMN "adjType" TEXT,
ADD COLUMN "visibleAt" TIMESTAMP(3),
ADD COLUMN "datasetVersionId" TEXT;

-- AlterTable
ALTER TABLE "CausalSignalCandidate" ADD COLUMN "protocolVersion" INTEGER;

-- AlterTable
ALTER TABLE "PipelineStepTrace"
ADD COLUMN "stageId" TEXT,
ADD COLUMN "artifactId" TEXT;

-- AlterTable
ALTER TABLE "RunTrace"
ADD COLUMN "recipeVersion" TEXT,
ADD COLUMN "businessConfigHash" TEXT,
ADD COLUMN "stageVersionMapJson" JSONB;

-- AlterTable
ALTER TABLE "Stock"
ADD COLUMN "listedAt" TIMESTAMP(3),
ADD COLUMN "delistedAt" TIMESTAMP(3);

-- ============================================================
-- 二、新增表
-- ============================================================

-- CreateTable
CREATE TABLE "RunArtifact" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "upstreamFingerprints" JSONB NOT NULL,
    "shardCount" INTEGER NOT NULL DEFAULT 1,
    "contentHash" TEXT NOT NULL,
    "originTraceId" TEXT,
    "originArtifactId" TEXT,
    "committedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunArtifactShard" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "shardIndex" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "byteSize" INTEGER,

    CONSTRAINT "RunArtifactShard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationPublish" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "publishVersion" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "auditStatus" TEXT NOT NULL,
    "supersededBy" TEXT,
    "reason" TEXT,
    "asOf" TIMESTAMP(3) NOT NULL,
    "clusterKey" TEXT NOT NULL,

    CONSTRAINT "RecommendationPublish_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentCacheEntry" (
    "id" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "extractionSemanticVersion" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "sourceModel" TEXT,
    "rawText" TEXT NOT NULL,
    "evidenceOffsetsJson" JSONB,
    "resultJson" JSONB,
    "status" TEXT NOT NULL,
    "contentVersion" TEXT NOT NULL,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "ContentCacheEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketDatasetVersion" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "revision" TEXT NOT NULL,
    "checksum" TEXT,
    "coverageStart" TIMESTAMP(3),
    "coverageEnd" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketDatasetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingCalendarDay" (
    "id" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "isOpen" BOOLEAN NOT NULL,
    "openTime" TEXT,
    "closeTime" TEXT,
    "source" TEXT NOT NULL,
    "calendarVersion" TEXT NOT NULL,

    CONSTRAINT "TradingCalendarDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YieldRecord" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "horizon" INTEGER NOT NULL,
    "value" DECIMAL(12,6),
    "status" TEXT NOT NULL,
    "plannedExitDay" TIMESTAMP(3),
    "actualExitDay" TIMESTAMP(3),
    "maturityAt" TIMESTAMP(3),
    "computeVersion" TEXT NOT NULL,

    CONSTRAINT "YieldRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockStatusHistory" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "isST" BOOLEAN NOT NULL DEFAULT false,
    "industry" TEXT,
    "listedAt" TIMESTAMP(3),
    "delistedAt" TIMESTAMP(3),
    "source" TEXT,

    CONSTRAINT "StockStatusHistory_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- 三、新增表的索引与唯一键
-- ============================================================

-- CreateIndex
CREATE INDEX "RunArtifact_traceId_idx" ON "RunArtifact"("traceId");

-- CreateIndex
CREATE INDEX "RunArtifact_originTraceId_idx" ON "RunArtifact"("originTraceId");

-- CreateIndex
CREATE UNIQUE INDEX "RunArtifact_traceId_stageId_version_key" ON "RunArtifact"("traceId", "stageId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "RunArtifactShard_artifactId_shardIndex_key" ON "RunArtifactShard"("artifactId", "shardIndex");

-- CreateIndex
CREATE INDEX "RecommendationPublish_clusterKey_asOf_idx" ON "RecommendationPublish"("clusterKey", "asOf");

-- CreateIndex
CREATE INDEX "RecommendationPublish_supersededBy_idx" ON "RecommendationPublish"("supersededBy");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationPublish_traceId_publishVersion_key" ON "RecommendationPublish"("traceId", "publishVersion");

-- CreateIndex
CREATE INDEX "ContentCacheEntry_status_idx" ON "ContentCacheEntry"("status");

-- CreateIndex
CREATE INDEX "ContentCacheEntry_leaseUntil_idx" ON "ContentCacheEntry"("leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "ContentCacheEntry_cacheKey_contentVersion_key" ON "ContentCacheEntry"("cacheKey", "contentVersion");

-- CreateIndex
CREATE UNIQUE INDEX "MarketDatasetVersion_source_asOf_revision_key" ON "MarketDatasetVersion"("source", "asOf", "revision");

-- CreateIndex
CREATE INDEX "TradingCalendarDay_exchange_date_idx" ON "TradingCalendarDay"("exchange", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TradingCalendarDay_exchange_date_calendarVersion_key" ON "TradingCalendarDay"("exchange", "date", "calendarVersion");

-- CreateIndex
CREATE INDEX "YieldRecord_status_maturityAt_idx" ON "YieldRecord"("status", "maturityAt");

-- CreateIndex
CREATE UNIQUE INDEX "YieldRecord_snapshotId_symbol_horizon_computeVersion_key" ON "YieldRecord"("snapshotId", "symbol", "horizon", "computeVersion");

-- CreateIndex
CREATE INDEX "StockStatusHistory_symbol_idx" ON "StockStatusHistory"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "StockStatusHistory_symbol_effectiveFrom_key" ON "StockStatusHistory"("symbol", "effectiveFrom");
