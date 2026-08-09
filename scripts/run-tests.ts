import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { checkTypeScriptContainment } from './check-typescript-containment.mjs';

await checkTypeScriptContainment();

const vitestPath = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const executeFile = promisify(execFile);
const allTestSuites = [
  { name: 'Node unit', config: 'vitest.unit.config.ts' },
  { name: 'Worker contract/integration', config: 'vitest.config.ts' },
] as const;
const { cliArguments, selectedSuites } = parseArguments(
  process.argv.slice(2).filter((argument) => argument !== '--'),
  allTestSuites,
);
type TestSuite = (typeof allTestSuites)[number];
const testSuites: readonly TestSuite[] = selectedSuites;
const DEFAULT_DEADLINE_MS = 300_000;
const MAX_DEADLINE_MS = 300_000;
const TERMINATION_GRACE_MS = 2_000;
const configuredDeadline = Number(process.env.GLOBAL_REGISTRY_TEST_DEADLINE_MS);
const deadlineMs =
  Number.isSafeInteger(configuredDeadline) &&
  configuredDeadline > 0 &&
  configuredDeadline <= MAX_DEADLINE_MS
    ? configuredDeadline
    : DEFAULT_DEADLINE_MS;

const environment: NodeJS.ProcessEnv = { ...process.env };
const callerTempValue =
  process.platform === 'win32' ? (environment.TEMP ?? environment.TMP) : environment.TMPDIR;
const callerTempDirectory =
  typeof callerTempValue === 'string' && callerTempValue.trim().length > 0
    ? callerTempValue
    : undefined;
const repositoryDevice = await stat(process.cwd())
  .then((information) => information.dev)
  .catch(() => undefined);
let createdTempDirectory: string | undefined;

try {
  const preparedTempDirectory = await prepareTempDirectory(callerTempDirectory, repositoryDevice);
  const tempDirectory = preparedTempDirectory.directory;
  if (preparedTempDirectory.created) createdTempDirectory = tempDirectory;
  environment.TMPDIR = tempDirectory;
  environment.TEMP = tempDirectory;
  environment.TMP = tempDirectory;

  const deadlineAt = Date.now() + deadlineMs;
  let status = 0;
  for (const suite of testSuites) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      console.error(
        `Test suite exceeded the ${deadlineMs}ms total wall-clock deadline before ${suite.name} tests started.`,
      );
      status = 124;
      break;
    }
    status = await runVitest(environment, suite, remainingMs, deadlineMs, deadlineAt);
    if (status !== 0) break;
  }
  process.exitCode = status;
} finally {
  if (createdTempDirectory !== undefined) {
    await rm(createdTempDirectory, { recursive: true, force: true });
  }
}

function parseArguments(
  arguments_: string[],
  suites: typeof allTestSuites,
): { cliArguments: string[]; selectedSuites: readonly TestSuite[] } {
  const result: string[] = [];
  let selectedName: 'all' | 'unit' | 'worker' = 'all';
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--config' || argument === '-c') {
      throw new Error('The test runner owns its fixed configs; --config overrides are rejected.');
    }
    if (argument?.startsWith('--config=')) {
      throw new Error('The test runner owns its fixed configs; --config overrides are rejected.');
    }
    if (argument === '--suite') {
      const value = arguments_[index + 1];
      if (value !== 'all' && value !== 'unit' && value !== 'worker') {
        throw new Error('--suite must be one of: all, unit, worker.');
      }
      selectedName = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith('--suite=')) {
      const value = argument.slice('--suite='.length);
      if (value !== 'all' && value !== 'unit' && value !== 'worker') {
        throw new Error('--suite must be one of: all, unit, worker.');
      }
      selectedName = value;
      continue;
    }
    if (argument !== undefined) result.push(argument);
  }
  return {
    cliArguments: result,
    selectedSuites:
      selectedName === 'all' ? suites : selectedName === 'unit' ? [suites[0]] : [suites[1]],
  };
}

async function prepareTempDirectory(
  callerDirectory: string | undefined,
  repositoryDevice: number | undefined,
): Promise<{ directory: string; created: boolean }> {
  if (callerDirectory !== undefined) {
    const directory = path.resolve(callerDirectory);
    const information = await stat(directory).catch(() => null);
    if (information?.isDirectory()) {
      try {
        await access(directory, constants.W_OK | constants.X_OK);
        const effectiveRoot = await selectTempRoot(directory, information.dev, repositoryDevice);
        // Keep the caller-selected filesystem, but isolate concurrent runners under it.
        return {
          directory: await mkdtemp(path.join(effectiveRoot, 'global-registry-vitest-')),
          created: true,
        };
      } catch {
        // Fall through to an isolated directory when the caller path is unusable.
      }
    }
    console.error(
      `Caller-provided TMPDIR is unusable; using an isolated directory instead: ${directory}`,
    );
  }
  const fallbackRoot = await selectFallbackTempRoot(callerDirectory, repositoryDevice);
  return {
    directory: await mkdtemp(path.join(fallbackRoot, 'global-registry-vitest-')),
    created: true,
  };
}

async function selectTempRoot(
  callerDirectory: string,
  callerDevice: number,
  repositoryDevice: number | undefined,
): Promise<string> {
  if (repositoryDevice === undefined || callerDevice !== repositoryDevice) return callerDirectory;

  const fallbackRoot = await selectFallbackTempRoot(callerDirectory, repositoryDevice);
  if (fallbackRoot !== callerDirectory) {
    console.error(
      `Caller-provided TMPDIR shares the repository filesystem; using an isolated temporary directory under ${fallbackRoot}.`,
    );
    return fallbackRoot;
  }
  return callerDirectory;
}

async function selectFallbackTempRoot(
  callerDirectory: string | undefined,
  repositoryDevice: number | undefined,
): Promise<string> {
  const candidates = process.platform === 'win32' ? [os.tmpdir()] : ['/tmp', os.tmpdir()];
  for (const candidate of candidates) {
    const directory = path.resolve(candidate);
    if (directory === (callerDirectory === undefined ? undefined : path.resolve(callerDirectory))) {
      continue;
    }
    const information = await stat(directory).catch(() => null);
    if (!information?.isDirectory()) continue;
    if (repositoryDevice !== undefined && information.dev === repositoryDevice) continue;
    try {
      await access(directory, constants.W_OK | constants.X_OK);
      return directory;
    } catch {
      // Try the next standard temporary root.
    }
  }
  return os.tmpdir();
}

async function runVitest(
  environment_: NodeJS.ProcessEnv,
  suite: (typeof testSuites)[number],
  timeoutMs: number,
  totalDeadlineMs: number,
  deadlineAt: number,
): Promise<number> {
  const configPath = path.resolve(suite.config);
  const child = spawn(
    process.execPath,
    [vitestPath, 'run', ...cliArguments, '--config', configPath],
    {
      detached: process.platform !== 'win32',
      env: environment_,
      stdio: 'inherit',
      shell: false,
    },
  );

  console.error(
    `[${suite.name}] started with ${timeoutMs}ms remaining of the ${totalDeadlineMs}ms total deadline (pid ${child.pid ?? 'unknown'}).`,
  );

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let terminationPromise: Promise<void> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(
        `[${suite.name}] exceeded the ${totalDeadlineMs}ms total wall-clock deadline; terminating only owned process group ${child.pid ?? 'unknown'}.`,
      );
      terminationPromise = (async () => {
        await printProcessDiagnostics(child);
        await terminateOwnedProcessGroup(child);
      })().catch((error: unknown) => {
        console.error(`Could not terminate the ${suite.name} test process: ${String(error)}`);
      });
    }, timeoutMs);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void (terminationPromise ?? Promise.resolve()).then(() => reject(error));
    });
    child.once('close', (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void (terminationPromise ?? Promise.resolve()).then(() => {
        if (timedOut) {
          console.error(
            `[${suite.name}] deadline cleanup completed; total elapsed time was ${Math.max(0, Date.now() - (deadlineAt - totalDeadlineMs))}ms.`,
          );
          resolve(124);
          return;
        }
        if (signal !== null) {
          console.error(`[${suite.name}] test runner stopped by ${signal}.`);
        }
        resolve(status ?? 1);
      });
    });
  });
}

async function printProcessDiagnostics(child: ChildProcess): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const { stdout } = await executeFile('ps', ['-eo', 'pid=,ppid=,pgid=,stat=,etime=,args='], {
      encoding: 'utf8',
      timeout: 1_000,
      killSignal: 'SIGKILL',
    });
    const processGroup = String(child.pid);
    const lines = String(stdout)
      .split('\n')
      .filter((line) => line.trim().split(/\s+/, 4)[2] === processGroup);
    console.error(`Owned test process group ${processGroup} diagnostics:`);
    console.error(lines.join('\n') || '(no process remained in the owned group)');
  } catch (error) {
    console.error(`Could not collect process diagnostics: ${String(error)}`);
  }
}

async function terminateOwnedProcessGroup(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    child.kill('SIGTERM');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }

  const stopWaitingAt = Date.now() + TERMINATION_GRACE_MS;
  while (Date.now() < stopWaitingAt && processGroupExists(child.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!processGroupExists(child.pid)) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The owned group exited between the existence check and SIGKILL.
  }
}

function processGroupExists(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch {
    return false;
  }
}
