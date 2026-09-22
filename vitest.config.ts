import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { randomBytes } from 'node:crypto';
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './src/index.ts',
      wrangler: { configPath: './wrangler.jsonc', environment: 'development' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          LOCAL_AUTH_SECRET: randomBytes(32).toString('hex'),
        },
      },
    })),
  ],
  test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/setup.ts'], fileParallelism: false },
});
