import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  MAX_DEPLOYMENT_CONFIG_BYTES,
  parseJsonc,
  readDeploymentConfig,
  validateDeploymentConfig,
} from './deployment-preflight.mjs';
import { readCheckedFile } from './typescript-imports.mjs';

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const production = {
  name: 'registry-f7-worker',
  account_id: 'account-f7',
  workers_dev: false,
  preview_urls: false,
  vars: {
    ENVIRONMENT: 'production',
    ALLOW_LOCAL_AUTH: 'false',
    ACCESS_TEAM_DOMAIN: 'team.invalid',
    ACCESS_AUD: 'aud-f7',
    BACKUP_ACTOR_ID: 'backup-f7',
  },
  d1_databases: [
    {
      binding: 'DB',
      database_name: 'registry-f7',
      database_id: '00000000-0000-4000-8000-000000000007',
      migrations_dir: 'migrations',
    },
  ],
  r2_buckets: [{ binding: 'EXPORTS_BUCKET', bucket_name: 'exports-f7' }],
  queues: {
    producers: [{ binding: 'EVENT_QUEUE', queue: 'events-f7' }],
    consumers: [
      {
        queue: 'events-f7',
        max_batch_size: 20,
        max_batch_timeout: 5,
        max_retries: 5,
        visibility_timeout_ms: 300000,
        dead_letter_queue: 'events-f7-dlq',
        retry_delay: 300,
      },
    ],
  },
  triggers: { crons: ['0 3 * * *'] },
};

const development = {
  workers_dev: false,
  preview_urls: false,
  vars: { ENVIRONMENT: 'production', ALLOW_LOCAL_AUTH: 'false' },
  d1_databases: [{ binding: 'DB', migrations_dir: 'migrations' }],
  r2_buckets: [{ binding: 'EXPORTS_BUCKET', bucket_name: 'local-exports' }],
  queues: {
    producers: [{ binding: 'EVENT_QUEUE', queue: 'local-events' }],
    consumers: [
      {
        queue: 'local-events',
        max_batch_size: 20,
        max_batch_timeout: 5,
        max_retries: 5,
        visibility_timeout_ms: 300000,
        dead_letter_queue: 'local-events-dlq',
        retry_delay: 300,
      },
    ],
  },
  env: {
    development: {
      vars: {
        ENVIRONMENT: 'development',
        ALLOW_LOCAL_AUTH: 'true',
        ACCESS_TEAM_DOMAIN: 'unset',
        ACCESS_AUD: 'unset',
      },
      d1_databases: [{ binding: 'DB', migrations_dir: 'migrations' }],
      r2_buckets: [{ binding: 'EXPORTS_BUCKET', bucket_name: 'local-exports' }],
      queues: {
        producers: [{ binding: 'EVENT_QUEUE', queue: 'local-events' }],
        consumers: [
          {
            queue: 'local-events',
            max_batch_size: 20,
            max_batch_timeout: 5,
            max_retries: 5,
            visibility_timeout_ms: 300000,
            dead_letter_queue: 'local-events-dlq',
            retry_delay: 300,
          },
        ],
      },
    },
  },
};

validateDeploymentConfig(production);
validateDeploymentConfig(development, { mode: 'local' });

const cases = [
  [
    'wrong database binding',
    (config) => (config.d1_databases[0].binding = 'WRONG_DATABASE_BINDING'),
  ],
  ['missing bucket', (config) => delete config.r2_buckets],
  [
    'extra bucket',
    (config) => config.r2_buckets.push({ binding: 'EXTRA_BUCKET', bucket_name: 'extra' }),
  ],
  [
    'duplicate database binding',
    (config) => config.d1_databases.push({ ...config.d1_databases[0] }),
  ],
  ['wrong queue binding', (config) => (config.queues.producers[0].binding = 'WRONG_QUEUE_BINDING')],
  ['queue mismatch', (config) => (config.queues.consumers[0].queue = 'different-events')],
  [
    'same dead-letter queue',
    (config) => (config.queues.consumers[0].dead_letter_queue = 'events-f7'),
  ],
  ['extra queue property', (config) => (config.queues.consumers[0].extra = true)],
];

for (const [name, mutate] of cases) {
  const candidate = clone(production);
  mutate(candidate);
  assertRejected(name, candidate);
}

const missingEnvironment = clone(development);
delete missingEnvironment.env;
assertRejected('missing development environment', missingEnvironment, { mode: 'local' });

const extraEnvironment = clone(development);
extraEnvironment.env.production = clone(extraEnvironment.env.development);
assertRejected('ambiguous environment set', extraEnvironment, { mode: 'local' });

globalThis.console.log(
  `Deployment preflight regression fixtures passed: production and development exact binding graphs accepted; ${cases.length + 2} wrong-name, missing, extra, duplicate, mismatch, DLQ, and environment cases rejected.`,
);

runJsoncParserRegressions();
await runFilesystemBoundaryRegressions();
await runCliRegression();

function assertRejected(name, config, options = {}) {
  try {
    validateDeploymentConfig(config, options);
  } catch {
    return;
  }
  throw new Error(`Deployment preflight regression case was accepted: ${name}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runJsoncParserRegressions() {
  const exact = parseJsonc(
    `{
      // Wrangler accepts comments and trailing commas.
      "workers_dev": false,
      "nested": { "enabled": true, },
      "items": [1, 2,],
    }`,
    'positive-jsonc',
  );
  if (exact.nested.enabled !== true || exact.items.length !== 2) {
    throw new Error('JSONC positive fixture was not parsed exactly.');
  }
  for (const [name, source] of [
    ['duplicate root key', '{"workers_dev":false,"workers_dev":true}'],
    ['duplicate nested key', '{"env":{"development":{"vars":{},"vars":{}}}}'],
    ['escaped-equivalent key', '{"env":{"development":{"va\\u0072s":{},"vars":{}}}}'],
    ['malformed comment', '{/* unterminated'],
    ['malformed string', '{"key":"unterminated}'],
    ['malformed comma', '{"key" 1}'],
  ]) {
    assertThrows(`${name} must be rejected`, () => parseJsonc(source, name));
  }
}

async function runFilesystemBoundaryRegressions() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'global-registry-preflight-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'global-registry-preflight-outside-'));
  const configPath = path.join(root, 'config.jsonc');
  const outsidePath = path.join(outside, 'outside.jsonc');
  try {
    const validSource = '{"safe":true,}\n';
    await writeFile(configPath, validSource, 'utf8');
    await writeFile(outsidePath, '{"outside":true}\n', 'utf8');
    const parsed = await readDeploymentConfig(configPath, root);
    if (parsed.safe !== true) throw new Error('Regular JSONC config did not pass its boundary.');

    const symlinkPath = path.join(root, 'config-symlink.jsonc');
    await symlink(outsidePath, symlinkPath);
    await assertRejectsPromptly('symlink config must be rejected', () =>
      readDeploymentConfig(symlinkPath, root),
    );
    await assertRejectsPromptly('FIFO config must be rejected', async () => {
      const fifoPath = path.join(root, 'config.fifo');
      await executeFile('mkfifo', [fifoPath]);
      try {
        await readDeploymentConfig(fifoPath, root);
      } finally {
        await unlink(fifoPath).catch(() => undefined);
      }
    });

    await mkdirAndReject(path.join(root, 'config-directory.jsonc'), root);
    await assertRejectsPromptly('missing config must be rejected', () =>
      readDeploymentConfig(path.join(root, 'missing.jsonc'), root),
    );
    const emptyPath = path.join(root, 'empty.jsonc');
    await writeFile(emptyPath, '', 'utf8');
    await assertRejectsPromptly('empty config must be rejected', () =>
      readDeploymentConfig(emptyPath, root),
    );
    const oversizedPath = path.join(root, 'oversized.jsonc');
    await writeFile(oversizedPath, Buffer.alloc(MAX_DEPLOYMENT_CONFIG_BYTES + 1, 0x20));
    await assertRejectsPromptly('oversized config must be rejected', () =>
      readDeploymentConfig(oversizedPath, root),
    );
    await assertRejectsPromptly('external config path must be rejected', () =>
      readDeploymentConfig(outsidePath, root),
    );

    const swapPath = path.join(root, 'swap.jsonc');
    const swapBackup = path.join(root, 'swap.backup.jsonc');
    await writeFile(swapPath, validSource, 'utf8');
    let swapRunning = true;
    const swapper = (async () => {
      while (swapRunning) {
        await rename(swapPath, swapBackup).catch(() => undefined);
        await symlink(outsidePath, swapPath).catch(() => undefined);
        await unlink(swapPath).catch(() => undefined);
        await rename(swapBackup, swapPath).catch(() => undefined);
      }
    })();
    try {
      for (let index = 0; index < 64; index += 1) {
        const value = await readCheckedFile(swapPath, root).catch(() => null);
        if (value !== null && value !== validSource) {
          throw new Error('TOCTOU canary returned content from the swapped path.');
        }
      }
    } finally {
      swapRunning = false;
      await swapper;
      await unlink(swapPath).catch(() => undefined);
      await rename(swapBackup, swapPath).catch(() => undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
  globalThis.console.log('Deployment JSONC and regular-file boundary regressions passed.');
}

async function runCliRegression() {
  const result = await executeFile(
    process.execPath,
    [
      path.join(repositoryRoot, 'scripts/deployment-preflight.mjs'),
      '--local',
      '--config',
      path.join(repositoryRoot, 'wrangler.jsonc'),
    ],
    { cwd: repositoryRoot, timeout: 5_000, maxBuffer: 2 * 1024 * 1024 },
  );
  if (!result.stdout.includes('deployment preflight passed for inert local config')) {
    throw new Error(`Deployment preflight CLI did not validate the local config: ${result.stdout}`);
  }
  globalThis.console.log('Deployment preflight CLI regression passed.');
}

async function mkdirAndReject(directory, root) {
  await mkdir(directory);
  await assertRejectsPromptly('directory config must be rejected', () =>
    readDeploymentConfig(directory, root),
  );
}

async function assertRejectsPromptly(name, action) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve()
        .then(action)
        .then(
          () => {
            throw new Error(`${name}: operation was accepted`);
          },
          () => undefined,
        ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name}: operation timed out`)), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertThrows(name, action) {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(name);
}
