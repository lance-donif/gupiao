CREATE TABLE IF NOT EXISTS "MarketSignalSnapshot" (
  "id" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "asOf" TIMESTAMP(3) NOT NULL,
  "clusterKey" TEXT NOT NULL DEFAULT 'global',
  "symbol" TEXT NOT NULL,
  "latestTradingDay" TIMESTAMP(3),
  "momentum5dPct" DECIMAL(10,6),
  "momentum20dPct" DECIMAL(10,6),
  "volumeRatio20d" DECIMAL(10,4),
  "breakout20d" BOOLEAN NOT NULL DEFAULT false,
  "volatilityCompression" BOOLEAN NOT NULL DEFAULT false,
  "recentWeekGainExceeded" BOOLEAN NOT NULL DEFAULT false,
  "score" DECIMAL(10,4) NOT NULL,
  "reasons" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketSignalSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MarketSignalSnapshot_traceId_symbol_key"
ON "MarketSignalSnapshot"("traceId", "symbol");

CREATE INDEX IF NOT EXISTS "MarketSignalSnapshot_clusterKey_asOf_symbol_idx"
ON "MarketSignalSnapshot"("clusterKey", "asOf", "symbol");

CREATE INDEX IF NOT EXISTS "MarketSignalSnapshot_clusterKey_latestTradingDay_idx"
ON "MarketSignalSnapshot"("clusterKey", "latestTradingDay");

CREATE TABLE IF NOT EXISTS "NewsQualitySnapshot" (
  "id" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "asOf" TIMESTAMP(3) NOT NULL,
  "clusterKey" TEXT NOT NULL DEFAULT 'global',
  "newsId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "reprintGroupId" TEXT,
  "reprintWeight" DECIMAL(3,2) NOT NULL,
  "sameTopicCount" INTEGER NOT NULL DEFAULT 1,
  "titleQuality" TEXT NOT NULL,
  "contentQuality" TEXT NOT NULL,
  "hasBusinessVariable" BOOLEAN NOT NULL DEFAULT false,
  "hasDirectStockName" BOOLEAN NOT NULL DEFAULT false,
  "qualityScore" DECIMAL(5,4) NOT NULL,
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NewsQualitySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NewsQualitySnapshot_traceId_newsId_key"
ON "NewsQualitySnapshot"("traceId", "newsId");

CREATE INDEX IF NOT EXISTS "NewsQualitySnapshot_clusterKey_asOf_idx"
ON "NewsQualitySnapshot"("clusterKey", "asOf");

CREATE INDEX IF NOT EXISTS "NewsQualitySnapshot_traceId_reprintGroupId_idx"
ON "NewsQualitySnapshot"("traceId", "reprintGroupId");

CREATE TABLE IF NOT EXISTS "ExposureMatchCache" (
  "id" TEXT NOT NULL,
  "clusterKey" TEXT NOT NULL DEFAULT 'global',
  "sourceKeyword" TEXT NOT NULL,
  "exposureKeyword" TEXT NOT NULL,
  "exposureFactId" TEXT,
  "matchMethod" TEXT NOT NULL,
  "matchConfidence" DECIMAL(5,4) NOT NULL,
  "reason" TEXT NOT NULL,
  "validFrom" TIMESTAMP(3) NOT NULL,
  "validTo" TIMESTAMP(3),
  "hitCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExposureMatchCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExposureMatchCache_clusterKey_sourceKeyword_exposureKeyword_matchMethod_key"
ON "ExposureMatchCache"("clusterKey", "sourceKeyword", "exposureKeyword", "matchMethod");

CREATE INDEX IF NOT EXISTS "ExposureMatchCache_clusterKey_sourceKeyword_idx"
ON "ExposureMatchCache"("clusterKey", "sourceKeyword");

CREATE INDEX IF NOT EXISTS "ExposureMatchCache_clusterKey_validFrom_validTo_idx"
ON "ExposureMatchCache"("clusterKey", "validFrom", "validTo");
