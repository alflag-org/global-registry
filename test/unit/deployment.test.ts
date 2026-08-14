import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../../scripts/jsonc.mjs';
import {
  deploymentManifestSchema,
  loadEnvironmentManifests,
  validateEnvironmentManifests,
} from '../../scripts/deployment-manifests';
import {
  assertAppliedMigrationsCompatible,
  d1QueryRows,
  loadAcceptedMigrationNames,
  migrationNamesFromD1Response,
} from '../../scripts/deployment-migrations';
import { buildWranglerConfiguration } from '../../scripts/deployment-wrangler';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exampleDirectory = path.resolve(repositoryRoot, 'deployment/example');

describe('deployment manifests', () => {
  it('accepts the Product example and validates its environment', async () => {
    const manifests = await validateEnvironmentManifests({
      directory: exampleDirectory,
      expectedEnvironment: 'staging',
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      sourceRepository: 'sandbox/global-registry',
    });
    expect(manifests.deployment.worker.baseUrl).toBe('https://registry.sandbox.test');
  });

  it('rejects target placeholders and unsupported manifest properties', async () => {
    const manifests = await loadEnvironmentManifests(exampleDirectory);
    const placeholder = structuredClone(manifests.deployment);
    placeholder.access.audience = 'unset';
    expect(deploymentManifestSchema.safeParse(placeholder).success).toBe(false);

    const extra = structuredClone(manifests.deployment) as Record<string, unknown>;
    extra.runtime = {};
    expect(deploymentManifestSchema.safeParse(extra).success).toBe(false);
  });

  it('rejects a base URL that has no matching custom-domain route', async () => {
    const manifests = await loadEnvironmentManifests(exampleDirectory);
    const candidate = structuredClone(manifests.deployment);
    candidate.worker.baseUrl = 'https://other.sandbox.test';
    expect(deploymentManifestSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('generated Wrangler configuration', () => {
  it('projects bindings, Access, Cron, observability, and safety flags', async () => {
    const manifests = await loadEnvironmentManifests(exampleDirectory);
    const base = parseJsonc(
      await readFile(path.resolve(repositoryRoot, 'wrangler.jsonc'), 'utf8'),
      'wrangler.jsonc',
    );
    const config = buildWranglerConfiguration({
      baseConfig: base,
      baseConfigPath: path.resolve(repositoryRoot, 'wrangler.jsonc'),
      outputPath: '/tmp/global-registry-deployment-test/wrangler.json',
      deployment: manifests.deployment,
    });

    expect(config).toMatchObject({
      account_id: '00000000000000000000000000000001',
      name: 'global-registry-sandbox',
      workers_dev: false,
      preview_urls: false,
      vars: {
        ENVIRONMENT: 'staging',
        ALLOW_LOCAL_AUTH: 'false',
        ACCESS_TEAM_DOMAIN: 'sandbox.cloudflareaccess.com',
        ACCESS_AUD: 'sandbox-access-audience-0001',
        BACKUP_ACTOR_ID: '00000000-0000-4000-8000-000000000002',
      },
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'global-registry-sandbox-db',
          database_id: '00000000-0000-4000-8000-000000000001',
        },
      ],
      r2_buckets: [{ binding: 'EXPORTS_BUCKET', bucket_name: 'global-registry-sandbox-exports' }],
      queues: {
        producers: [{ binding: 'EVENT_QUEUE', queue: 'global-registry-sandbox-events' }],
        consumers: [
          {
            queue: 'global-registry-sandbox-events',
            dead_letter_queue: 'global-registry-sandbox-dead-letter',
          },
        ],
      },
      routes: [{ pattern: 'registry.sandbox.test', custom_domain: true }],
      triggers: { crons: ['0 3 * * *'] },
      observability: {
        logs: { head_sampling_rate: 1 },
        traces: { enabled: false },
      },
    });
    expect(config).not.toHaveProperty('env');
    expect(config).not.toHaveProperty('keep_vars');
  });
});

describe('migration compatibility', () => {
  it('loads the current Product migration chain and accepts known ledger entries', async () => {
    await expect(
      loadAcceptedMigrationNames(path.resolve(repositoryRoot, 'migrations')),
    ).resolves.toEqual([
      '0001_initial.sql',
      '0002_extensible_providers.sql',
      '0003_versioned_resource_kind_definitions.sql',
    ]);
    expect(() =>
      assertAppliedMigrationsCompatible(
        ['0001_initial.sql', '0002_extensible_providers.sql'],
        [
          '0001_initial.sql',
          '0002_extensible_providers.sql',
          '0003_versioned_resource_kind_definitions.sql',
        ],
      ),
    ).not.toThrow();
  });

  it('rejects a migration from an incompatible remote lineage', () => {
    expect(() =>
      assertAppliedMigrationsCompatible(
        ['0001_initial.sql', '0003_domain_validation.sql'],
        ['0001_initial.sql', '0002_extensible_providers.sql'],
      ),
    ).toThrow('automatic rollback is not performed');
  });

  it('parses Wrangler D1 JSON rows and rejects failed statements', () => {
    const output = JSON.stringify([{ success: true, results: [{ name: '0001_initial.sql' }] }]);
    expect(d1QueryRows(output)).toEqual([{ name: '0001_initial.sql' }]);
    expect(migrationNamesFromD1Response(output)).toEqual(['0001_initial.sql']);
    expect(() => d1QueryRows(JSON.stringify([{ success: false, results: [] }]))).toThrow(
      'failed D1 query',
    );
  });
});
