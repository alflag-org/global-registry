import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { checkTypeScriptContainment } from './check-typescript-containment.mjs';

const repositoryDirectory = fileURLToPath(new URL('..', import.meta.url));
await checkTypeScriptContainment(repositoryDirectory);
const repositoryWranglerState = path.join(repositoryDirectory, '.wrangler');
if (await pathExists(repositoryWranglerState)) {
  throw new Error(
    'smoke:local requires no existing .wrangler state; remove or move that generated state before running it.',
  );
}
let exportDirectory: string | undefined;

try {
  exportDirectory = await mkdtemp(path.join(tmpdir(), 'global-registry-d1-smoke-'));
  await run('pnpm', [
    'exec',
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'DB',
    '--local',
    '--env',
    'development',
    '--config',
    'wrangler.jsonc',
  ]);
  await run('pnpm', [
    'exec',
    'wrangler',
    'd1',
    'execute',
    'DB',
    '--local',
    '--env',
    'development',
    '--config',
    'wrangler.jsonc',
    '--command',
    'PRAGMA quick_check; PRAGMA foreign_key_check;',
  ]);
  await run('pnpm', [
    'exec',
    'wrangler',
    'd1',
    'execute',
    'DB',
    '--local',
    '--env',
    'development',
    '--config',
    'wrangler.jsonc',
    '--command',
    `INSERT INTO actors (id, identity, display_name, role, active, revision, created_at, updated_at, created_by, updated_by) VALUES ('actor-smoke', 'access:smoke-admin', 'Smoke Admin', 'admin', 1, 1, '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z', 'actor-smoke', 'actor-smoke');`,
  ]);
  const exportPath = path.join(exportDirectory, 'smoke-export.sql');
  await run('pnpm', ['export:sql'], {
    env: {
      GLOBAL_REGISTRY_DATABASE: 'DB',
      GLOBAL_REGISTRY_ENV: 'development',
      GLOBAL_REGISTRY_EXPORT_FILE: exportPath,
      GLOBAL_REGISTRY_REMOTE: 'false',
    },
  });
  await run('pnpm', ['validate:sql-export', exportPath]);
  const exported = await readFile(exportPath, 'utf8');
  if (!exported.includes('actor-smoke') || !exported.includes('access:smoke-admin')) {
    throw new Error('fresh local SQL export did not contain the representative Actor data.');
  }
  console.log('fresh local D1 smoke passed with non-empty data and validated SQL export');
} finally {
  await rm(repositoryWranglerState, { recursive: true, force: true });
  if (exportDirectory !== undefined) {
    await rm(exportDirectory, { recursive: true, force: true });
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function run(
  command: string,
  args: string[],
  options: { env?: Record<string, string> } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryDirectory,
      env: { ...process.env, ...options.env, CI: '1' },
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('close', (status) => {
      if (status === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with status ${status ?? 'unknown'}`));
    });
  });
}
