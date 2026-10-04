import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            main: './src/index.ts',
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations('./migrations'),
              },
            },
          })),
        ],
        test: {
          name: 'workers',
          include: ['test/*.test.ts'],
          setupFiles: ['./test/setup.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
});
