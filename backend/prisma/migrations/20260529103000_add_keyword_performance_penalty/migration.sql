CREATE TABLE IF NOT EXISTS "KeywordPerformancePenalty" (
  "id" TEXT NOT NULL,
  "clusterKey" TEXT NOT NULL DEFAULT 'global',
  "keyword" TEXT NOT NULL,
  "factor" DECIMAL(5,4) NOT NULL,
  "lossPct" DECIMAL(8,6) NOT NULL,
  "thresholdPct" DECIMAL(8,6) NOT NULL,
  "triggerTraceId" TEXT NOT NULL,
  "triggerSymbol" TEXT NOT NULL,
  "triggerAsOf" TIMESTAMP(3) NOT NULL,
  "validFrom" TIMESTAMP(3) NOT NULL,
  "validTo" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KeywordPerformancePenalty_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "KeywordPerformancePenalty_clusterKey_triggerTraceId_triggerS_key"
ON "KeywordPerformancePenalty"("clusterKey", "triggerTraceId", "triggerSymbol", "keyword");

CREATE INDEX IF NOT EXISTS "KeywordPerformancePenalty_clusterKey_keyword_validFrom_validTo_idx"
ON "KeywordPerformancePenalty"("clusterKey", "keyword", "validFrom", "validTo");

CREATE INDEX IF NOT EXISTS "KeywordPerformancePenalty_clusterKey_triggerAsOf_idx"
ON "KeywordPerformancePenalty"("clusterKey", "triggerAsOf");
