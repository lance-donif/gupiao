CREATE UNIQUE INDEX IF NOT EXISTS "EvidenceContribution_traceId_newsId_symbol_keyword_key"
ON "EvidenceContribution"("traceId", "newsId", symbol, keyword);
