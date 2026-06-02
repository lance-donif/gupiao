CREATE TABLE IF NOT EXISTS "StrategyDefinition" (
  "id" TEXT NOT NULL,
  "clusterKey" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "configJson" JSONB NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StrategyDefinition_pkey" PRIMARY KEY ("id")
);

DROP INDEX IF EXISTS "StrategyDefinition_clusterKey_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "StrategyDefinition_clusterKey_name_active_key"
ON "StrategyDefinition"("clusterKey", "name")
WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "StrategyDefinition_clusterKey_enabled_idx"
ON "StrategyDefinition"("clusterKey", "enabled");

CREATE INDEX IF NOT EXISTS "StrategyDefinition_clusterKey_deletedAt_idx"
ON "StrategyDefinition"("clusterKey", "deletedAt");

CREATE INDEX IF NOT EXISTS "StrategyDefinition_clusterKey_createdAt_idx"
ON "StrategyDefinition"("clusterKey", "createdAt");

CREATE TABLE IF NOT EXISTS "StrategyRun" (
  "id" TEXT NOT NULL,
  "strategyId" TEXT NOT NULL,
  "strategyNameSnapshot" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "clusterKey" TEXT NOT NULL,
  "asOf" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "inputFingerprint" TEXT NOT NULL,
  "configSnapshot" JSONB NOT NULL,
  "diagnostics" JSONB NOT NULL,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "StrategyRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StrategyRun_strategyId_asOf_inputFingerprint_key"
ON "StrategyRun"("strategyId", "asOf", "inputFingerprint");

CREATE INDEX IF NOT EXISTS "StrategyRun_clusterKey_asOf_idx"
ON "StrategyRun"("clusterKey", "asOf");

CREATE INDEX IF NOT EXISTS "StrategyRun_traceId_idx"
ON "StrategyRun"("traceId");

CREATE INDEX IF NOT EXISTS "StrategyRun_strategyId_createdAt_idx"
ON "StrategyRun"("strategyId", "createdAt");

CREATE TABLE IF NOT EXISTS "StrategyRecommendationEvent" (
  "id" TEXT NOT NULL,
  "strategyRunId" TEXT NOT NULL,
  "strategyId" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "clusterKey" TEXT NOT NULL,
  "asOf" TIMESTAMP(3) NOT NULL,
  "rank" INTEGER NOT NULL,
  "symbol" TEXT NOT NULL,
  "stockName" TEXT NOT NULL,
  "industry" TEXT NOT NULL,
  "finalScore" DECIMAL(10,4) NOT NULL,
  "scoreBreakdown" JSONB NOT NULL,
  "reasons" TEXT[] NOT NULL,
  "baseTradingDay" TIMESTAMP(3) NOT NULL,
  "basePrice" DECIMAL(18,4) NOT NULL,
  "currentTradingDay" TIMESTAMP(3),
  "currentPrice" DECIMAL(18,4),
  "returnPct" DECIMAL(10,6),
  "returnStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StrategyRecommendationEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StrategyRecommendationEvent_strategyRunId_symbol_key"
ON "StrategyRecommendationEvent"("strategyRunId", "symbol");

CREATE INDEX IF NOT EXISTS "StrategyRecommendationEvent_clusterKey_asOf_strategyId_rank_idx"
ON "StrategyRecommendationEvent"("clusterKey", "asOf", "strategyId", "rank");

CREATE INDEX IF NOT EXISTS "StrategyRecommendationEvent_strategyId_asOf_idx"
ON "StrategyRecommendationEvent"("strategyId", "asOf");

CREATE INDEX IF NOT EXISTS "StrategyRecommendationEvent_symbol_asOf_idx"
ON "StrategyRecommendationEvent"("symbol", "asOf");

ALTER TABLE "StrategyRun"
  ADD CONSTRAINT "StrategyRun_strategyId_fkey"
  FOREIGN KEY ("strategyId") REFERENCES "StrategyDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StrategyRecommendationEvent"
  ADD CONSTRAINT "StrategyRecommendationEvent_strategyRunId_fkey"
  FOREIGN KEY ("strategyRunId") REFERENCES "StrategyRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
