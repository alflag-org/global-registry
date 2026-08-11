import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const repositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Repository must use the owner/name format.');
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/, 'Commit must be a full lowercase Git SHA.');
const accountIdSchema = z
  .string()
  .regex(/^[a-f0-9]{32}$/, 'Cloudflare account ID must be 32 lowercase hexadecimal characters.');
const workerNameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,253}[a-z0-9])?$/, 'Worker name is invalid.');
const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'Hostname is invalid.',
  );
const resourceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]{0,253}[a-z0-9])?$/,
    'Resource names must use lowercase letters, digits, dots, underscores, or hyphens.',
  )
  .refine((value) => !isPlaceholder(value), 'Resource names must not be placeholders.');
const uuidSchema = z.uuid();

export const releaseManifestSchema = z
  .object({
    repository: repositorySchema,
    commit: commitSchema,
  })
  .strict();

const customDomainRouteSchema = z
  .object({
    pattern: hostnameSchema,
    customDomain: z.literal(true),
  })
  .strict();

const zoneRouteSchema = z
  .object({
    pattern: z.string().trim().min(1).max(512),
    zoneName: hostnameSchema,
  })
  .strict();

const observabilityOverrideSchema = z
  .object({
    logsHeadSamplingRate: z.number().min(0).max(1).optional(),
    tracesEnabled: z.boolean().optional(),
    tracesHeadSamplingRate: z.number().min(0).max(1).optional(),
  })
  .strict();

export const deploymentManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    accountId: accountIdSchema,
    environment: z.enum(['staging', 'production']),
    worker: z
      .object({
        name: workerNameSchema,
        baseUrl: z.url(),
        routes: z
          .array(z.union([customDomainRouteSchema, zoneRouteSchema]))
          .min(1)
          .max(100),
      })
      .strict(),
    resources: z
      .object({
        database: z
          .object({
            name: resourceNameSchema,
            id: uuidSchema,
          })
          .strict(),
        exportsBucket: resourceNameSchema,
        outboxQueue: resourceNameSchema,
        deadLetterQueue: resourceNameSchema,
      })
      .strict(),
    access: z
      .object({
        teamDomain: hostnameSchema,
        audience: z
          .string()
          .trim()
          .min(16)
          .max(512)
          .refine((value) => !isPlaceholder(value), 'Access audience must not be a placeholder.'),
      })
      .strict(),
    operations: z
      .object({
        backupActorId: uuidSchema,
      })
      .strict(),
    observability: observabilityOverrideSchema.optional(),
    crons: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  })
  .strict()
  .superRefine((manifest, context) => {
    uniqueValues(
      manifest.worker.routes.map((route) => JSON.stringify(route)),
      ['worker', 'routes'],
      context,
    );
    uniqueValues(manifest.crons, ['crons'], context);

    const baseUrl = new URL(manifest.worker.baseUrl);
    if (
      baseUrl.protocol !== 'https:' ||
      baseUrl.username !== '' ||
      baseUrl.password !== '' ||
      baseUrl.port !== '' ||
      baseUrl.pathname !== '/' ||
      baseUrl.search !== '' ||
      baseUrl.hash !== ''
    ) {
      context.addIssue({
        code: 'custom',
        path: ['worker', 'baseUrl'],
        message: 'Worker baseUrl must be an HTTPS origin without credentials, a port, or a path.',
      });
    }

    const matchingCustomDomain = manifest.worker.routes.some(
      (route) => 'customDomain' in route && route.pattern === baseUrl.hostname,
    );
    if (!matchingCustomDomain) {
      context.addIssue({
        code: 'custom',
        path: ['worker', 'baseUrl'],
        message: 'Worker baseUrl must match a custom-domain route.',
      });
    }

    if (manifest.access.teamDomain === baseUrl.hostname) {
      context.addIssue({
        code: 'custom',
        path: ['access', 'teamDomain'],
        message: 'Access team domain and Worker base URL must be different hosts.',
      });
    }

    if (manifest.resources.outboxQueue === manifest.resources.deadLetterQueue) {
      context.addIssue({
        code: 'custom',
        path: ['resources', 'deadLetterQueue'],
        message: 'Dead-letter Queue must differ from the primary Queue.',
      });
    }
  });

export const environmentManifestsSchema = z
  .object({
    release: releaseManifestSchema,
    deployment: deploymentManifestSchema,
  })
  .strict();

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;
export type EnvironmentManifests = z.infer<typeof environmentManifestsSchema>;

export interface ManifestValidationOptions {
  directory: string;
  expectedEnvironment?: 'production' | 'staging';
  sourceCommit?: string;
  sourceRepository?: string;
}

export async function loadEnvironmentManifests(directory: string): Promise<EnvironmentManifests> {
  const root = resolve(directory);
  const [release, deployment] = await Promise.all([
    loadJson(resolve(root, 'release.json'), releaseManifestSchema),
    loadJson(resolve(root, 'deployment.json'), deploymentManifestSchema),
  ]);
  return environmentManifestsSchema.parse({ release, deployment });
}

export async function validateEnvironmentManifests(
  options: ManifestValidationOptions,
): Promise<EnvironmentManifests> {
  const manifests = await loadEnvironmentManifests(options.directory);
  if (
    options.expectedEnvironment !== undefined &&
    manifests.deployment.environment !== options.expectedEnvironment
  ) {
    throw new Error(
      'Deployment environment ' +
        manifests.deployment.environment +
        ' does not match ' +
        options.expectedEnvironment +
        '.',
    );
  }
  if (options.sourceCommit !== undefined && manifests.release.commit !== options.sourceCommit) {
    throw new Error(
      'Release pin ' +
        manifests.release.commit +
        ' does not match source checkout ' +
        options.sourceCommit +
        '.',
    );
  }
  if (
    options.sourceRepository !== undefined &&
    manifests.release.repository !== options.sourceRepository
  ) {
    throw new Error(
      'Release repository ' +
        manifests.release.repository +
        ' does not match ' +
        options.sourceRepository +
        '.',
    );
  }
  return manifests;
}

async function loadJson<T extends z.ZodType>(path: string, schema: T): Promise<z.output<T>> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error('Required manifest ' + path + ' could not be read.', { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error('Manifest ' + path + ' is not valid JSON.', { cause: error });
  }
  return schema.parse(value);
}

function uniqueValues(values: string[], path: PropertyKey[], context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({ code: 'custom', path: [...path, index], message: 'Duplicate value.' });
    }
    seen.add(value);
  }
}

function isPlaceholder(value: string): boolean {
  return (
    /^unset$/i.test(value) ||
    value.includes('__') ||
    /operator[-_ ]?supplied|change[-_ ]?me|placeholder|example/i.test(value)
  );
}
