CREATE TABLE "StockKeywordMappingCandidate" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "clusterKey" TEXT NOT NULL DEFAULT 'global',
    "symbol" TEXT NOT NULL,
    "stockName" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "board" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "evidenceCount" INTEGER NOT NULL,
    "reasons" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockKeywordMappingCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockKeywordMappingCandidate_traceId_symbol_keyword_source_key"
ON "StockKeywordMappingCandidate"("traceId", "symbol", "keyword", "source");

CREATE INDEX "StockKeywordMappingCandidate_traceId_confidence_idx"
ON "StockKeywordMappingCandidate"("traceId", "confidence");

CREATE INDEX "StockKeywordMappingCandidate_clusterKey_asOf_status_idx"
ON "StockKeywordMappingCandidate"("clusterKey", "asOf", "status");

CREATE INDEX "StockKeywordMappingCandidate_clusterKey_keyword_idx"
ON "StockKeywordMappingCandidate"("clusterKey", "keyword");
