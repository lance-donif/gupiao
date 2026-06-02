ALTER TABLE "EvidenceContribution"
ADD COLUMN IF NOT EXISTS "sourceKeyword" TEXT,
ADD COLUMN IF NOT EXISTS "matchedExposureKeyword" TEXT,
ADD COLUMN IF NOT EXISTS "exposureFactId" TEXT,
ADD COLUMN IF NOT EXISTS "matchMethod" TEXT,
ADD COLUMN IF NOT EXISTS "matchConfidence" DECIMAL(5,4);

CREATE INDEX IF NOT EXISTS "EvidenceContribution_traceId_sourceKeyword_idx"
ON "EvidenceContribution"("traceId", "sourceKeyword");

CREATE INDEX IF NOT EXISTS "EvidenceContribution_traceId_matchedExposureKeyword_idx"
ON "EvidenceContribution"("traceId", "matchedExposureKeyword");
