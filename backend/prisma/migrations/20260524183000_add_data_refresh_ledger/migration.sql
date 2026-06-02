CREATE TABLE "DataRefreshLedger" (
    "id" TEXT NOT NULL,
    "dataKind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "clusterKey" TEXT NOT NULL DEFAULT 'global',
    "bucketKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "traceId" TEXT,
    "summary" JSONB NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataRefreshLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DataRefreshLedger_dataKind_source_clusterKey_bucketKey_key"
ON "DataRefreshLedger"("dataKind", "source", "clusterKey", "bucketKey");

CREATE INDEX "DataRefreshLedger_clusterKey_dataKind_source_expiresAt_idx"
ON "DataRefreshLedger"("clusterKey", "dataKind", "source", "expiresAt");

CREATE INDEX "DataRefreshLedger_traceId_idx"
ON "DataRefreshLedger"("traceId");
