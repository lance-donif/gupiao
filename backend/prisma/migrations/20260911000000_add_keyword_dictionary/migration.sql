-- KeywordDictionary: 全局关键词词典，替代代码硬编码词表（只新增表，不碰现有模型）。
CREATE TABLE "KeywordDictionary" (
    "id" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "canonicalTerm" TEXT,
    "weight" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeywordDictionary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KeywordDictionary_term_category_key" ON "KeywordDictionary"("term", "category");
CREATE INDEX "KeywordDictionary_category_status_idx" ON "KeywordDictionary"("category", "status");
