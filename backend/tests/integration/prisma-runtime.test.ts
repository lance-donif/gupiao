import { describe, expect, it } from 'vitest';

import { createPrismaClientAdapter } from '../../src/services/prisma-adapter.js';

describe('prisma runtime', () => {
  it('constructs a real Prisma client for PostgreSQL without requiring fake injection', async () => {
    const databaseUrl = 'postgresql://gupiao:password@localhost:5432/gupiaodb?schema=public';

    expect(() => createPrismaClientAdapter(databaseUrl)).not.toThrow();

    const prisma = createPrismaClientAdapter(databaseUrl);
    await prisma.$disconnect();
  });
});
