import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  bootstrapAdminUsage,
  buildBootstrapAdminSql,
  parseBootstrapAdminArguments,
  parseBootstrapAdminOutput,
  type BootstrapAdminOptions,
  type BootstrapAdminResult,
} from './bootstrap-admin-core';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wranglerScript = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);

export async function bootstrapAdmin(
  options: BootstrapAdminOptions,
): Promise<BootstrapAdminResult> {
  const values = {
    actorId: options.actorId ?? randomUUID(),
    identity: options.identity,
    displayName: options.displayName,
    createdAt: new Date().toISOString(),
  };
  const args = [
    wranglerScript,
    'd1',
    'execute',
    options.database,
    '--config',
    options.config,
    '--command',
    buildBootstrapAdminSql(values),
    '--json',
    '--yes',
    options.remote ? '--remote' : '--local',
  ];
  if (options.environment !== undefined) args.push('--env', options.environment);

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, {
      cwd: repositoryRoot,
      env: { ...process.env, CI: '1' },
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    const details = commandFailureDetails(error);
    throw new Error(`Wrangler D1 bootstrap failed.${details}`, { cause: error });
  }
  return parseBootstrapAdminOutput(stdout);
}

function commandFailureDetails(error: unknown): string {
  if (error === null || typeof error !== 'object') return '';
  const record = error as { stdout?: unknown; stderr?: unknown };
  const output = [record.stderr, record.stdout]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .join('\n');
  return output.length === 0 ? '' : `\n${output}`;
}

async function main(): Promise<void> {
  try {
    const options = parseBootstrapAdminArguments(process.argv.slice(2));
    if (options === null) {
      console.log(bootstrapAdminUsage());
      return;
    }
    const result = await bootstrapAdmin(options);
    console.log(
      JSON.stringify(
        {
          status: 'created',
          mode: options.remote ? 'remote' : 'local',
          database: options.database,
          actorId: result.actorId,
          identity: result.identity,
          role: 'admin',
          active: true,
          auditEvents: result.auditEvents,
          outboxRows: result.outboxRows,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`bootstrap-admin: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedScript = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (invokedScript === fileURLToPath(import.meta.url)) await main();
