import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '**/dist/**',
    ],
    // 集成测试连接真实 PostgreSQL，单用例含多次事务与租约竞争，
    // 默认 5s 超时会误判为失败（实测最慢用例约 5.5s）。
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
