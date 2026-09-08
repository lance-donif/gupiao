-- ExpectationGapSnapshot: 弱信号/预期差快照
CREATE TABLE IF NOT EXISTS "ExpectationGapSnapshot" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "clusterKey" TEXT NOT NULL DEFAULT 'global',
    "keyword" TEXT NOT NULL,
    "graphStrength" DECIMAL(10,4) NOT NULL,
    "priceReaction" DECIMAL(10,4) NOT NULL,
    "expectationGap" DECIMAL(10,4) NOT NULL,
    "isWeakSignal" BOOLEAN NOT NULL,
    "relatedSymbols" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidenceEdges" JSONB NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpectationGapSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExpectationGapSnapshot_traceId_keyword_key" ON "ExpectationGapSnapshot"("traceId", "keyword");
CREATE INDEX IF NOT EXISTS "ExpectationGapSnapshot_clusterKey_asOf_isWeakSignal_idx" ON "ExpectationGapSnapshot"("clusterKey", "asOf", "isWeakSignal");
CREATE INDEX IF NOT EXISTS "ExpectationGapSnapshot_clusterKey_expectationGap_idx" ON "ExpectationGapSnapshot"("clusterKey", "expectationGap");

-- ThemeForecast: 主题/资产级预测
CREATE TABLE IF NOT EXISTS "ThemeForecast" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "clusterKey" TEXT NOT NULL DEFAULT 'global',
    "theme" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "probability" DECIMAL(5,4) NOT NULL,
    "horizon" INTEGER NOT NULL DEFAULT 5,
    "signalStrength" DECIMAL(10,4) NOT NULL,
    "expectationGap" DECIMAL(10,4) NOT NULL,
    "relatedSymbols" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidenceChain" JSONB NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "realizedDirection" TEXT,
    "realizedChangePct" DECIMAL(8,6),
    "isReconciled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThemeForecast_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ThemeForecast_traceId_theme_key" ON "ThemeForecast"("traceId", "theme");
CREATE INDEX IF NOT EXISTS "ThemeForecast_clusterKey_asOf_direction_idx" ON "ThemeForecast"("clusterKey", "asOf", "direction");
CREATE INDEX IF NOT EXISTS "ThemeForecast_clusterKey_theme_asOf_idx" ON "ThemeForecast"("clusterKey", "theme", "asOf");
