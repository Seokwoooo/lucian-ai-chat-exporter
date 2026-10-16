import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 240_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
