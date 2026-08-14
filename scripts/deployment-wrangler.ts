import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { parseJsonc } from './jsonc.mjs';
import type { DeploymentManifest } from './deployment-manifests';

export type GeneratedWranglerConfiguration = Record<string, unknown>;

interface BaseWranglerConfiguration {
  $schema: string;
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  workers_dev?: boolean;
  preview_urls?: boolean;
  vars: Record<string, string | number | boolean>;
  d1_databases: Array<Record<string, unknown>>;
  r2_buckets: Array<Record<string, unknown>>;
  queues: {
    producers: Array<Record<string, unknown>>;
    consumers: Array<Record<string, unknown>>;
  };
  observability?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function generateWranglerConfiguration(input: {
  baseConfigPath: string;
  outputPath: string;
  deployment: DeploymentManifest;
}): Promise<GeneratedWranglerConfiguration> {
  const baseConfigPath = resolve(input.baseConfigPath);
  const baseConfig = parseJsonc(await readFile(baseConfigPath, 'utf8'), baseConfigPath);
  return buildWranglerConfiguration({
    baseConfig,
    baseConfigPath,
    outputPath: input.outputPath,
    deployment: input.deployment,
  });
}

export function buildWranglerConfiguration(input: {
  baseConfig: unknown;
  baseConfigPath: string;
  outputPath: string;
  deployment: DeploymentManifest;
}): GeneratedWranglerConfiguration {
  const baseConfigPath = resolve(input.baseConfigPath);
  const outputPath = resolve(input.outputPath);
  const base = parseBaseConfiguration(input.baseConfig);
  const baseDirectory = dirname(baseConfigPath);
  const outputDirectory = dirname(outputPath);
  const sourceEntrypoint = resolve(baseDirectory, base.main);
  const migrationDirectory = resolve(
    baseDirectory,
    stringValue(base.d1_databases[0]?.migrations_dir, 'd1_databases[0].migrations_dir'),
  );
  const schemaPath = resolve(baseDirectory, base.$schema);
  const producer = base.queues.producers[0];
  const consumer = base.queues.consumers[0];
  if (producer === undefined || consumer === undefined) {
    throw new Error('Public Worker base must define one outbox producer and consumer.');
  }

  const {
    env: _environments,
    account_id: _accountId,
    keep_vars: _keepVariables,
    routes: _routes,
    triggers: _triggers,
    ...shared
  } = base;
  void _environments;
  void _accountId;
  void _keepVariables;
  void _routes;
  void _triggers;

  const database = base.d1_databases[0];
  const bucket = base.r2_buckets[0];
  if (database === undefined || bucket === undefined) {
    throw new Error('Public Worker base must define one D1 database and one R2 bucket.');
  }

  return {
    ...shared,
    $schema: relativeConfigPath(outputDirectory, schemaPath),
    name: input.deployment.worker.name,
    main: relativeConfigPath(outputDirectory, sourceEntrypoint),
    account_id: input.deployment.accountId,
    workers_dev: false,
    preview_urls: false,
    vars: {
      ...base.vars,
      ENVIRONMENT: input.deployment.environment,
      ALLOW_LOCAL_AUTH: 'false',
      ACCESS_TEAM_DOMAIN: input.deployment.access.teamDomain,
      ACCESS_AUD: input.deployment.access.audience,
      LOCAL_AUTH_SECRET: 'unset',
      LOCAL_ACTOR_IDENTITY: 'unset',
      BACKUP_ACTOR_ID: input.deployment.operations.backupActorId,
    },
    d1_databases: [
      {
        ...database,
        database_name: input.deployment.resources.database.name,
        database_id: input.deployment.resources.database.id,
        migrations_dir: relativeConfigPath(outputDirectory, migrationDirectory),
      },
    ],
    r2_buckets: [
      {
        ...bucket,
        bucket_name: input.deployment.resources.exportsBucket,
      },
    ],
    queues: {
      producers: [
        {
          ...producer,
          queue: input.deployment.resources.outboxQueue,
        },
      ],
      consumers: [
        {
          ...consumer,
          queue: input.deployment.resources.outboxQueue,
          dead_letter_queue: input.deployment.resources.deadLetterQueue,
        },
      ],
    },
    routes: input.deployment.worker.routes.map((route) =>
      'customDomain' in route
        ? { pattern: route.pattern, custom_domain: true }
        : { pattern: route.pattern, zone_name: route.zoneName },
    ),
    observability: mergeObservability(base.observability ?? {}, input.deployment.observability),
    triggers: { crons: input.deployment.crons },
  };
}

function parseBaseConfiguration(value: unknown): BaseWranglerConfiguration {
  if (!isRecord(value)) throw new Error('Public Wrangler base config must be an object.');
  const requiredStrings = ['$schema', 'name', 'main', 'compatibility_date'] as const;
  for (const key of requiredStrings) stringValue(value[key], key);
  if (!isRecord(value.vars)) throw new Error('Public Wrangler base config requires vars.');
  if (!Array.isArray(value.d1_databases) || value.d1_databases.length !== 1) {
    throw new Error('Public Wrangler base config requires exactly one D1 binding.');
  }
  if (!Array.isArray(value.r2_buckets) || value.r2_buckets.length !== 1) {
    throw new Error('Public Wrangler base config requires exactly one R2 binding.');
  }
  if (!isRecord(value.queues)) throw new Error('Public Wrangler base config requires queues.');
  if (!Array.isArray(value.queues.producers) || value.queues.producers.length !== 1) {
    throw new Error('Public Wrangler base config requires exactly one Queue producer.');
  }
  if (!Array.isArray(value.queues.consumers) || value.queues.consumers.length !== 1) {
    throw new Error('Public Wrangler base config requires exactly one Queue consumer.');
  }
  return value as BaseWranglerConfiguration;
}

function mergeObservability(
  base: Record<string, unknown>,
  override: DeploymentManifest['observability'],
): Record<string, unknown> {
  if (override === undefined) return base;
  const baseLogs = objectValue(base.logs);
  const baseTraces = objectValue(base.traces);
  return {
    ...base,
    logs: {
      ...baseLogs,
      ...(override.logsHeadSamplingRate === undefined
        ? {}
        : { head_sampling_rate: override.logsHeadSamplingRate }),
    },
    traces: {
      ...baseTraces,
      ...(override.tracesEnabled === undefined ? {} : { enabled: override.tracesEnabled }),
      ...(override.tracesHeadSamplingRate === undefined
        ? {}
        : { head_sampling_rate: override.tracesHeadSamplingRate }),
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Public Wrangler base config requires a non-empty ${name}.`);
  }
  return value;
}

function relativeConfigPath(from: string, to: string): string {
  const path = relative(from, to).replaceAll('\\', '/');
  return path.startsWith('.') ? path : `./${path}`;
}
