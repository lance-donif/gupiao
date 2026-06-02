-- Legacy StockKeywordMapping* tables still contain historical rows in local databases.
-- Keep this migration as an explicit no-op so Prisma history can advance without
-- deleting data that may still be needed for audit or manual comparison.
SELECT 1;
