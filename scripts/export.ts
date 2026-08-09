import { spawn, type ChildProcess } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { checkTypeScriptContainment } from './check-typescript-containment.mjs';
import {
  cleanupExportStaging,
  createExportStaging,
  publishStagedExport,
  validateExportOutputPath,
} from './export-path.mjs';

const DEFAULT_EXPORT_COMMAND_DEADLINE_MS = 300_000;
const MAX_EXPORT_COMMAND_DEADLINE_MS = 300_000;
const EXPORT_COMMAND_TERMINATION_GRACE_MS = 2_000;

await checkTypeScriptContainment();

const database = requiredEnvironment('GLOBAL_REGISTRY_DATABASE');
const requestedOutput = requiredEnvironment('GLOBAL_REGISTRY_EXPORT_FILE');
const environment = process.env.GLOBAL_REGISTRY_ENV;
const remoteValue = process.env.GLOBAL_REGISTRY_REMOTE ?? 'false';
if (remoteValue !== 'true' && remoteValue !== 'false') {
  throw new Error('GLOBAL_REGISTRY_REMOTE must be exactly true or false.');
}
const remote = remoteValue === 'true';
const destination = await validateExportOutputPath(requestedOutput);
const staging = await createExportStaging(destination);
try {
  if (remote) {
    await runCommand(process.execPath, [
      'scripts/deployment-preflight.mjs',
      '--config',
      'wrangler.operator.jsonc',
    ]);
  }
  const config = remote ? 'wrangler.operator.jsonc' : 'wrangler.jsonc';
  const wranglerArguments = [
    'exec',
    'wrangler',
    'd1',
    'export',
    database,
    remote ? '--remote' : '--local',
    '--output',
    staging.childStagedOutputPath,
    '--config',
    config,
  ];
  if (environment !== undefined) wranglerArguments.push('--env', environment);
  await runCommand('pnpm', wranglerArguments, { stagingHandle: staging.stagingHandle });
  await runCommand('pnpm', ['validate:sql-export', staging.childStagedOutputPath], {
    stagingHandle: staging.stagingHandle,
  });
  await publishStagedExport(staging);
  console.log(`validated SQL export published atomically to ${destination.outputPath}`);
} finally {
  await cleanupExportStaging(staging);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      name === 'GLOBAL_REGISTRY_EXPORT_FILE'
        ? `Set ${name} to an explicit absolute path outside the repository; exports never choose a repository-relative default.`
        : `Set ${name} to the configured D1 database name or binding.`,
    );
  }
  return value;
}

async function runCommand(
  command: string,
  argumentsList: string[],
  options: { stagingHandle?: FileHandle } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stagingFd = options.stagingHandle?.fd;
    if (stagingFd !== undefined && (!Number.isInteger(stagingFd) || stagingFd < 3)) {
      reject(new Error('secure SQL export publishing requires an inheritable staging descriptor.'));
      return;
    }
    let child: ChildProcess;
    const spawnOptions = {
      cwd: path.resolve(new URL('..', import.meta.url).pathname),
      env: { ...process.env, CI: '1' },
      detached: process.platform !== 'win32',
      shell: false,
    };
    if (stagingFd === undefined) {
      child = spawn(command, argumentsList, { ...spawnOptions, stdio: 'inherit' });
    } else {
      child = spawn(command, argumentsList, {
        ...spawnOptions,
        stdio: ['inherit', 'inherit', 'inherit', stagingFd],
      });
    }
    const deadlineMs = exportCommandDeadlineMs();
    let interruption: NodeJS.Signals | undefined;
    let deadlineExpired = false;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if (!hasErrorCode(error, 'ESRCH')) throw error;
        }
      }
      child.kill(signal);
    };
    const onSignal = (signal: NodeJS.Signals) => {
      if (interruption !== undefined) return;
      interruption = signal;
      terminate(signal);
    };
    const onDeadline = () => {
      if (interruption !== undefined) return;
      interruption = 'SIGTERM';
      deadlineExpired = true;
      terminate('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          terminate('SIGKILL');
        }
      }, EXPORT_COMMAND_TERMINATION_GRACE_MS);
    };
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) process.once(signal, onSignal);
    const removeSignalHandlers = () => {
      for (const signal of signals) process.removeListener(signal, onSignal);
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
    };
    const deadlineTimer = setTimeout(onDeadline, deadlineMs);
    child.once('error', (error) => {
      removeSignalHandlers();
      reject(error);
    });
    child.once('close', (status, signal) => {
      removeSignalHandlers();
      if (interruption !== undefined) {
        reject(
          new Error(
            `${command} ${argumentsList.join(' ')} was terminated by ${interruption}${
              deadlineExpired ? ` after ${deadlineMs}ms` : ''
            }`,
          ),
        );
        return;
      }
      if (status === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${argumentsList.join(' ')} exited with ${signal ?? `status ${status ?? 'unknown'}`}`,
        ),
      );
    });
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function exportCommandDeadlineMs(): number {
  const configured = Number(process.env.GLOBAL_REGISTRY_EXPORT_COMMAND_DEADLINE_MS);
  if (
    Number.isSafeInteger(configured) &&
    configured > 0 &&
    configured <= MAX_EXPORT_COMMAND_DEADLINE_MS
  ) {
    return configured;
  }
  return DEFAULT_EXPORT_COMMAND_DEADLINE_MS;
}
