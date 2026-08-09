import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'test/unit/**/*.test.ts',
      'test/unit/**/*.test.tsx',
      'test/unit/**/*.test.mts',
      'test/unit/**/*.test.cts',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
