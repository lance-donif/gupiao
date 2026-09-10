-- RunLease: 独立运行租约表，替代旧 PipelineCheckpoint __pipeline_run_lease__ hack。
CREATE TABLE "RunLease" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunLease_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RunLease_traceId_key" ON "RunLease"("traceId");
CREATE INDEX "RunLease_leaseUntil_idx" ON "RunLease"("leaseUntil");
