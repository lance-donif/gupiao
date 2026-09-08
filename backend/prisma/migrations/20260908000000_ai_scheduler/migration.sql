CREATE TABLE "AiSchedulerState" (
  "id" TEXT PRIMARY KEY,
  "state" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "AiWorkflow" (
  "traceId" TEXT PRIMARY KEY,
  "asOf" TIMESTAMP(3) NOT NULL,
  "clusterKey" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "checkpoint" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "owner" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "AiWorkItem" (
  "id" TEXT PRIMARY KEY,
  "traceId" TEXT NOT NULL REFERENCES "AiWorkflow"("traceId"),
  "rootId" TEXT NOT NULL,
  "input" JSONB NOT NULL,
  "result" JSONB,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "owner" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AiWorkItem_trace_status_idx" ON "AiWorkItem"("traceId","status");
CREATE TABLE "AiAttempt" (
  "id" TEXT PRIMARY KEY,
  "taskId" TEXT,
  "candidate" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "kind" TEXT,
  "httpStatus" INTEGER,
  "latencyMs" INTEGER,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3)
);
CREATE INDEX "AiAttempt_task_idx" ON "AiAttempt"("taskId");
