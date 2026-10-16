import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
