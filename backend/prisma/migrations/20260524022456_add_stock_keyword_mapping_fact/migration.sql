-- CreateTable
CREATE TABLE "StockKeywordMappingFact" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "stockName" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "board" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockKeywordMappingFact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockKeywordMappingFact_symbol_keyword_idx" ON "StockKeywordMappingFact"("symbol", "keyword");

-- CreateIndex
CREATE INDEX "StockKeywordMappingFact_keyword_idx" ON "StockKeywordMappingFact"("keyword");

-- CreateIndex
CREATE UNIQUE INDEX "StockKeywordMappingFact_symbol_keyword_board_source_key" ON "StockKeywordMappingFact"("symbol", "keyword", "board", "source");
