import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import {
  assertAppliedMigrationsCompatible,
  d1QueryRows,
  loadAcceptedMigrationNames,
  migrationNamesFromD1Response,
} from './deployment-migrations';
import { validateEnvironmentManifests, type EnvironmentManifests } from './deployment-manifests';
import { generateWranglerConfiguration } from './deployment-wrangler';

type DeploymentCommand = 'validate' | 'generate' | 'dry-run' | 'publish' | 'deploy';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const baseConfigPath = resolve(repositoryRoot, 'wrangler.jsonc');
const migrationsDirectory = resolve(repositoryRoot, 'migrations');

interface Arguments {
  command: DeploymentCommand;
  directory: string;
  expectedEnvironment?: 'production' | 'staging';
  output?: string;
  sourceCommit?: string;
  sourceRepository?: string;
}

async function main(): Promise<void> {
  const argumentsValue = parseCommandArguments(process.argv.slice(2));
  const manifests = await validateEnvironmentManifests({
    directory: argumentsValue.directory,
    ...(argumentsValue.expectedEnvironment === undefined
      ? {}
      : { expectedEnvironment: argumentsValue.expectedEnvironment }),
    ...(argumentsValue.sourceCommit === undefined
      ? {}
      : { sourceCommit: argumentsValue.sourceCommit }),
    ...(argumentsValue.sourceRepository === undefined
      ? {}
      : { sourceRepository: argumentsValue.sourceRepository }),
  });

  switch (argumentsValue.command) {
    case 'validate':
      printJson(validationResult(manifests));
      return;
    case 'generate': {
      if (argumentsValue.output === undefined) {
        throw new Error('deployment generate requires --output.');
      }
      const outputPath = resolve(argumentsValue.output);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeGeneratedConfiguration(outputPath, manifests);
      printJson({ environment: manifests.deployment.environment, output: outputPath });
      return;
    }
    case 'dry-run':
      await withGeneratedConfiguration(manifests, async (configPath) => {
        runWrangler([
          'deploy',
          '--config',
          configPath,
          '--dry-run',
          '--experimental-auto-create=false',
        ]);
      });
      printJson({ environment: manifests.deployment.environment, dryRun: true });
      return;
    case 'publish':
      await publishEnvironment(manifests, false);
      return;
    case 'deploy':
      await publishEnvironment(manifests, true);
      return;
  }
}

async function publishEnvironment(
  manifests: EnvironmentManifests,
  applyMigrations: boolean,
): Promise<void> {
  await withGeneratedConfiguration(manifests, async (configPath) => {
    runWrangler([
      'deploy',
      '--config',
      configPath,
      '--dry-run',
      '--experimental-auto-create=false',
    ]);

    const acceptedMigrations = await loadAcceptedMigrationNames(migrationsDirectory);
    const appliedMigrations = readAppliedMigrationNames(
      configPath,
      manifests.deployment.resources.database.name,
    );
    assertAppliedMigrationsCompatible(appliedMigrations, acceptedMigrations);

    runWrangler(['deploy', '--config', configPath, '--experimental-auto-create=false']);

    if (applyMigrations) {
      runWrangler([
        'd1',
        'migrations',
        'apply',
        manifests.deployment.resources.database.name,
        '--config',
        configPath,
        '--remote',
        '--experimental-auto-create=false',
      ]);
    }
  });

  printJson({
    environment: manifests.deployment.environment,
    releaseCommit: manifests.release.commit,
    worker: manifests.deployment.worker.name,
    published: true,
    ...(applyMigrations ? { migrationsApplied: true } : {}),
  });
}

async function withGeneratedConfiguration(
  manifests: EnvironmentManifests,
  operation: (configPath: string) => Promise<void>,
): Promise<void> {
  const workDirectory = await mkdtemp(resolve(tmpdir(), 'global-registry-deployment-'));
  const configPath = resolve(workDirectory, 'wrangler.json');
  try {
    await writeGeneratedConfiguration(configPath, manifests);
    await operation(configPath);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export async function writeGeneratedConfiguration(
  outputPath: string,
  manifests: EnvironmentManifests,
): Promise<void> {
  const config = await generateWranglerConfiguration({
    baseConfigPath,
    outputPath,
    deployment: manifests.deployment,
  });
  await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function readAppliedMigrationNames(configPath: string, databaseName: string): string[] {
  const baseArguments = [
    'd1',
    'execute',
    databaseName,
    '--config',
    configPath,
    '--remote',
    '--experimental-auto-create=false',
    '--json',
  ];
  const tables = d1QueryRows(
    captureWrangler([
      ...baseArguments,
      '--command',
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'",
    ]),
  );
  if (tables.length === 0) return [];
  return migrationNamesFromD1Response(
    captureWrangler([...baseArguments, '--command', 'SELECT name FROM d1_migrations ORDER BY id']),
  );
}

function runWrangler(arguments_: string[]): void {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...arguments_], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Wrangler failed with status ${result.status ?? 'unknown'}.`);
  }
}

function captureWrangler(arguments_: string[]): string {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...arguments_], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Wrangler failed with status ${result.status ?? 'unknown'}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function validationResult(manifests: EnvironmentManifests) {
  return {
    environment: manifests.deployment.environment,
    repository: manifests.release.repository,
    commit: manifests.release.commit,
    worker: manifests.deployment.worker.name,
    valid: true,
  };
}

function parseCommandArguments(values: string[]): Arguments {
  const commandArguments = [...values];
  if (commandArguments[0] === '--') commandArguments.shift();
  const command = commandArguments.shift();
  if (!isDeploymentCommand(command)) {
    throw new Error(
      'Usage: deployment.ts <validate|generate|dry-run|publish|deploy> --directory <path>.',
    );
  }
  const parsed = parseArgs({
    args: commandArguments,
    options: {
      directory: { type: 'string' },
      'expected-environment': { type: 'string' },
      output: { type: 'string' },
      'source-commit': { type: 'string' },
      'source-repository': { type: 'string' },
    },
    strict: true,
  }).values;
  if (parsed.directory === undefined || parsed.directory.trim().length === 0) {
    throw new Error('--directory is required.');
  }
  if (
    parsed['expected-environment'] !== undefined &&
    parsed['expected-environment'] !== 'staging' &&
    parsed['expected-environment'] !== 'production'
  ) {
    throw new Error('--expected-environment must be staging or production.');
  }
  if (parsed['source-commit'] !== undefined && !/^[a-f0-9]{40}$/.test(parsed['source-commit'])) {
    throw new Error('--source-commit must be a full lowercase Git SHA.');
  }
  if (parsed['source-repository'] !== undefined && parsed['source-repository'].trim() === '') {
    throw new Error('--source-repository must not be empty.');
  }
  if (parsed.output !== undefined && command !== 'generate') {
    throw new Error('--output is only valid for deployment generate.');
  }
  return {
    command,
    directory: parsed.directory,
    ...(parsed['expected-environment'] === undefined
      ? {}
      : { expectedEnvironment: parsed['expected-environment'] }),
    ...(parsed.output === undefined ? {} : { output: parsed.output }),
    ...(parsed['source-commit'] === undefined ? {} : { sourceCommit: parsed['source-commit'] }),
    ...(parsed['source-repository'] === undefined
      ? {}
      : { sourceRepository: parsed['source-repository'] }),
  };
}

function isDeploymentCommand(value: string | undefined): value is DeploymentCommand {
  return (
    value === 'deploy' ||
    value === 'dry-run' ||
    value === 'generate' ||
    value === 'publish' ||
    value === 'validate'
  );
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof ZodError) {
    for (const issue of error.issues) {
      process.stderr.write(`${issue.path.join('.') || '<root>'}: ${issue.message}\n`);
    }
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
