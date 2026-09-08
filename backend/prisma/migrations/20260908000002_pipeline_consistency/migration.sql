ALTER TABLE "RecommendationSnapshot"
  ADD COLUMN "yield1DayVisibleAt" TIMESTAMP(3),
  ADD COLUMN "yield3DayVisibleAt" TIMESTAMP(3),
  ADD COLUMN "yield5DayVisibleAt" TIMESTAMP(3),
  ADD COLUMN "isPublished" BOOLEAN NOT NULL DEFAULT false;

UPDATE "RecommendationSnapshot" r SET "isPublished" = true
FROM "RunTrace" t WHERE t."traceId" = r."traceId"
  AND t.status = 'SUCCESS' AND t.kind = 'DAILY_RECOMMENDATION';

-- Unknown historical yield visibility stays NULL: it must be reconciled again
-- before being used to penalize a keyword in a historical replay.
CREATE INDEX "RecommendationSnapshot_published_day_idx"
  ON "RecommendationSnapshot" ("clusterKey", "asOf") WHERE "isPublished";

CREATE TABLE "PipelineCheckpoint" (
  "traceId" TEXT NOT NULL,
  stage TEXT NOT NULL,
  input TEXT NOT NULL,
  result JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("traceId", stage)
);
