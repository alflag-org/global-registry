import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './src/index.ts',
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        r2Buckets: ['EXPORTS_BUCKET'],
        bindings: {
          ENVIRONMENT: 'development',
          ALLOW_LOCAL_AUTH: 'true',
          ACCESS_TEAM_DOMAIN: 'unset',
          ACCESS_AUD: 'unset',
          TEST_MIGRATIONS: await readD1Migrations(path.join(rootDirectory, 'migrations')),
          LOCAL_AUTH_SECRET: Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join(''),
        },
      },
    })),
  ],
  test: {
    include: [
      'test/contract/**/*.test.ts',
      'test/contract/**/*.test.tsx',
      'test/contract/**/*.test.mts',
      'test/contract/**/*.test.cts',
      'test/integration/**/*.test.ts',
      'test/integration/**/*.test.tsx',
      'test/integration/**/*.test.mts',
      'test/integration/**/*.test.cts',
    ],
    setupFiles: ['./test/apply-migrations.ts'],
    // Each file launches an isolated Workerd runtime with D1; serialize files to avoid timeout flakiness under load.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
