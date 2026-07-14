import { defineConfig } from 'vitest/config';

const isE2eRun = process.env.NEXUS_E2E === '1';

export default defineConfig({
  test: {
    environment: 'node',
    include: isE2eRun
      ? ['tests/e2e/**/*.test.ts']
      : ['tests/**/*.test.ts', 'packages/**/tests/**/*.test.ts'],
    exclude: isE2eRun ? [] : ['tests/e2e/**/*.test.ts'],
    testTimeout: 30000,
    coverage: {
      enabled: true,
      reporter: ['text', 'html'],
    },
  },
});
