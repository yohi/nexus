import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node', include: ['tests/benchmarks/performance/**/*.perf.ts'], exclude: [],
    pool: 'forks', poolOptions: { forks: { execArgv: [] } },
    fileParallelism: false, maxWorkers: 1, minWorkers: 1, isolate: true,
    testTimeout: 3_600_000, hookTimeout: 30_000,
    coverage: { enabled: false }, benchmark: { include: [] },
  },
});
