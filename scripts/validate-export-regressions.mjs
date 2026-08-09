import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { promisify } from 'node:util';
import { URL } from 'node:url';
import { validateExportOutputPath } from './export-path.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);
const runner = path.join(repositoryRoot, 'node_modules/.bin/tsx');
const validator = path.join(repositoryRoot, 'scripts/validate-export.ts');
const migration = await readFile(path.join(repositoryRoot, 'migrations/0001_initial.sql'), 'utf8');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'global-registry-export-validation-'));
const validPath = path.join(temporaryRoot, 'representative.sql');
const outputParent = path.join(temporaryRoot, 'output-parent');
const generatedName = path.join(outputParent, 'global-registry-2026-08-06T00-00-00.000Z.sql');
const exportScript = path.join(repositoryRoot, 'scripts/export.ts');

try {
  await mkdir(outputParent);
  await writeFile(
    validPath,
    `PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE IF NOT EXISTS "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);\nINSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0001_initial.sql','2026-08-06 00:00:00');\n${migration}\n`,
  );
  await expectAccepted(validPath);

  const sideEffectPath = path.join(temporaryRoot, 'unexpected-side-effect.sqlite');
  const maliciousPath = path.join(temporaryRoot, 'malicious-attach.sql');
  await writeFile(
    maliciousPath,
    `ATTACH DATABASE '${sideEffectPath.replaceAll("'", "''")}' AS hostile; CREATE TABLE hostile.created_by_input(value TEXT);`,
  );
  await expectRejected(maliciousPath);
  if (await fileExists(sideEffectPath)) throw new Error('ATTACH regression created a host file.');

  for (const sql of [
    "VACUUM INTO 'unexpected.sqlite';",
    'PRAGMA writable_schema=ON;',
    "SELECT load_extension('unexpected');",
  ]) {
    const target = path.join(temporaryRoot, `forbidden-${sql.length}.sql`);
    await writeFile(target, sql);
    await expectRejected(target);
  }

  const symlinkPath = path.join(temporaryRoot, 'representative-link.sql');
  await symlink(validPath, symlinkPath);
  await expectRejected(symlinkPath);

  const directoryPath = path.join(temporaryRoot, 'directory-input');
  await mkdir(directoryPath);
  await expectRejected(directoryPath);

  const fifoPath = path.join(temporaryRoot, 'fifo-input');
  await execFileAsync('mkfifo', ['--mode=600', fifoPath]);
  await expectRejectedPromptly(fifoPath);
  await expectRejectedPromptly('/dev/null');

  const oversizedPath = path.join(temporaryRoot, 'oversized.sql');
  await writeFile(oversizedPath, '');
  await truncate(oversizedPath, 32 * 1024 * 1024 + 1);
  await expectRejectedPromptly(oversizedPath);

  const emptyPath = path.join(temporaryRoot, 'empty.sql');
  await writeFile(emptyPath, '');
  await expectRejected(emptyPath);

  const malformedPath = path.join(temporaryRoot, 'malformed.sql');
  await writeFile(
    malformedPath,
    "CREATE TABLE actors(id TEXT PRIMARY KEY, identity TEXT DEFAULT 'unterminated);",
  );
  await expectRejected(malformedPath);

  const safeOutput = await validateExportOutputPath(generatedName, repositoryRoot);
  if (safeOutput.outputPath !== generatedName) {
    throw new Error('Safe export output path was not preserved.');
  }
  await expectPathRejected('relative output path', () =>
    validateExportOutputPath('global-registry-output.sql', repositoryRoot),
  );
  await expectPathRejected('repository output path', () =>
    validateExportOutputPath(
      path.join(repositoryRoot, 'global-registry-output.sql'),
      repositoryRoot,
    ),
  );
  const existingOutput = path.join(temporaryRoot, 'existing.sql');
  await writeFile(existingOutput, 'already exists', 'utf8');
  await expectPathRejected('existing output path', () =>
    validateExportOutputPath(existingOutput, repositoryRoot),
  );
  const outputLink = path.join(temporaryRoot, 'output-link.sql');
  await symlink(outsideSideEffectPath(temporaryRoot), outputLink);
  await expectPathRejected('symlink output path', () =>
    validateExportOutputPath(outputLink, repositoryRoot),
  );
  await unlink(outputLink);

  await runRealExportRaceRegressions();
  const gitignore = await readFile(path.join(repositoryRoot, '.gitignore'), 'utf8');
  if (!gitignore.split(/\r?\n/).includes('global-registry-*.sql')) {
    throw new Error('Generated export filename defense-in-depth ignore rule is missing.');
  }

  globalThis.console.log(
    'Raw SQL export regression fixtures passed: representative schema accepted; descriptor-anchored child output, unchanged external canaries across before/during/after parent and leaf swaps, ATTACH, forbidden escape statements, symlink, directory, FIFO, special file, oversize, empty, malformed, no-clobber, child failure, signal, deadline, and cleanup cases rejected without overwriting or leaving staging.',
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function outsideSideEffectPath(directory) {
  return path.join(directory, 'side-effect-target');
}

async function runValidator(inputPath) {
  return execFileAsync(runner, [validator, inputPath], {
    cwd: repositoryRoot,
    timeout: 5_000,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function expectAccepted(inputPath) {
  try {
    await runValidator(inputPath);
  } catch (error) {
    throw new Error(
      `Expected representative export to validate: ${error.stderr ?? error.message}`,
      {
        cause: error,
      },
    );
  }
}

async function expectRejected(inputPath) {
  try {
    await runValidator(inputPath);
  } catch {
    return;
  }
  throw new Error(`Expected SQL input to be rejected: ${inputPath}`);
}

async function expectRejectedPromptly(inputPath) {
  const started = Date.now();
  await expectRejected(inputPath);
  const elapsed = Date.now() - started;
  if (elapsed > 5_000)
    throw new Error(`Special or oversized SQL input was not rejected promptly: ${elapsed}ms.`);
}

async function expectPathRejected(name, action) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(`Expected export path to be rejected: ${name}`);
}

async function runRealExportRaceRegressions() {
  const realPnpm = (await execFileAsync('which', ['pnpm'])).stdout.trim();
  if (realPnpm.length === 0)
    throw new Error('Cannot resolve pnpm for the export child regression.');
  const originalPath = process.env.PATH ?? '';
  const fakePnpmDirectory = path.join(temporaryRoot, 'fake-pnpm-bin');
  await mkdir(fakePnpmDirectory);
  const fakePnpm = path.join(fakePnpmDirectory, 'pnpm');
  await writeFile(
    fakePnpm,
    `#!/usr/bin/env node
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
const mode = process.env.RACE_MODE ?? 'normal';

function waitForRelease() {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(process.env.RACE_RELEASE_FILE)) Atomics.wait(wait, 0, 0, 25);
}

function stagingName() {
  const entry = readdirSync(process.env.RACE_PARENT, { withFileTypes: true }).find(
    (candidate) => candidate.name.startsWith('.global-registry-export-'),
  );
  if (entry === undefined) throw new Error('export staging directory was not observable');
  return entry.name;
}

function swapStaging(kind) {
  const name = stagingName();
  const parent = process.env.RACE_PARENT;
  const external = process.env.RACE_EXTERNAL_ROOT;
  const stage = path.join(parent, name);
  if (kind === 'leaf') {
    rmSync(stage, { recursive: true, force: true });
    symlinkSync(external, stage);
    return;
  }
  renameSync(parent, process.env.RACE_PARENT_MOVED);
  mkdirSync(parent);
  symlinkSync(external, path.join(parent, name));
}

function assertDescriptorOutput(output) {
  if (!/^\\/proc\\/\\d+\\/fd\\/\\d+\\/export\\.sql$/.test(output)) {
    writeFileSync(process.env.RACE_FAILURE_FILE, output);
    process.exit(66);
  }
}

if (args[0] === 'validate:sql-export') {
  assertDescriptorOutput(args[1]);
  if (mode.startsWith('after-')) swapStaging(mode.slice('after-'.length));
  const result = spawnSync(process.env.REAL_PNPM, args, {
    cwd: process.env.REPOSITORY_ROOT,
    env: { ...process.env, PATH: process.env.ORIGINAL_PATH },
    stdio: ['inherit', 'inherit', 'inherit', 3],
  });
  process.exit(result.status ?? 1);
}
if (args[0] !== 'exec' || args[1] !== 'wrangler') process.exit(64);
const outputIndex = args.indexOf('--output');
if (outputIndex < 0 || args[outputIndex + 1] === undefined) process.exit(65);
const output = args[outputIndex + 1];
assertDescriptorOutput(output);
writeFileSync(process.env.RACE_CHILD_PID_FILE, String(process.pid));
if (mode.startsWith('before-')) swapStaging(mode.slice('before-'.length));
if (mode === 'during-parent' || mode === 'during-leaf' || mode === 'failure' || mode === 'deadline') {
  writeFileSync(process.env.RACE_READY_FILE, 'ready');
  waitForRelease();
}
if (mode === 'failure') process.exit(23);
copyFileSync(process.env.RACE_SQL_SOURCE, output);
`,
    { encoding: 'utf8', mode: 0o755 },
  );
  const noClobberParent = path.join(temporaryRoot, 'no-clobber-parent');
  await mkdir(noClobberParent);
  const noClobberOutput = path.join(noClobberParent, 'export.sql');
  await writeFile(noClobberOutput, 'existing-sentinel', 'utf8');
  const noClobber = await runExportChild(
    noClobberParent,
    noClobberOutput,
    fakePnpm,
    realPnpm,
    originalPath,
  );
  const noClobberResult = await noClobber.completed;
  if (noClobberResult.status === 0 || (await fileExists(noClobber.readyFile)))
    throw new Error('Existing export was not rejected before Wrangler.');
  if ((await readFile(noClobberOutput, 'utf8')) !== 'existing-sentinel')
    throw new Error('Existing export sentinel changed.');

  const successfulRoot = path.join(temporaryRoot, 'successful-export');
  await mkdir(successfulRoot);
  const successfulOutput = path.join(successfulRoot, 'export.sql');
  const successful = await runExportChild(
    successfulRoot,
    successfulOutput,
    fakePnpm,
    realPnpm,
    originalPath,
  );
  const successfulResult = await successful.completed;
  if (successfulResult.status !== 0) {
    throw new Error(`Successful descriptor export failed: ${successfulResult.output}`);
  }
  if (!(await fileExists(successfulOutput)))
    throw new Error('Successful export was not published.');
  await assertNoOwnedStagingDirectories(successfulRoot);
  await assertProcessStopped(successful.childPidFile, 'successful export child');

  const scenarios = [
    { name: 'before-parent', mode: 'before-parent', kind: 'parent' },
    { name: 'before-leaf', mode: 'before-leaf', kind: 'leaf' },
    { name: 'during-parent', mode: 'during-parent', kind: 'parent' },
    { name: 'during-leaf', mode: 'during-leaf', kind: 'leaf' },
    { name: 'after-parent', mode: 'after-parent', kind: 'parent' },
    { name: 'after-leaf', mode: 'after-leaf', kind: 'leaf' },
  ];
  for (const scenario of scenarios) {
    const root = path.join(temporaryRoot, `race-${scenario.name}`);
    const externalRoot = path.join(temporaryRoot, `external-${scenario.name}`);
    await mkdir(root);
    await mkdir(externalRoot);
    const externalCanary = path.join(externalRoot, 'export.sql');
    await writeFile(externalCanary, 'ATTACKER-SENTINEL', 'utf8');
    const output = path.join(root, 'export.sql');
    const run = await runExportChild(root, output, fakePnpm, realPnpm, originalPath, {
      mode: scenario.mode,
      externalRoot,
    });
    if (scenario.mode.startsWith('during-')) {
      await waitForFile(run.readyFile);
      await swapStaging(root, externalRoot, scenario.kind);
      await writeFile(run.releaseFile, 'release', 'utf8');
    }
    const result = await run.completed;
    if (result.status === 0) throw new Error(`${scenario.name} swap was accepted.`);
    if ((await readFile(externalCanary, 'utf8')) !== 'ATTACKER-SENTINEL') {
      throw new Error(`${scenario.name} changed the external canary.`);
    }
    if (await fileExists(output)) throw new Error(`${scenario.name} published an output.`);
    await assertNoOwnedStagingDirectories(root);
    await assertNoOwnedStagingDirectories(`${root}-moved`);
    await assertProcessStopped(run.childPidFile, `${scenario.name} export child`);
  }

  const childFailureRoot = path.join(temporaryRoot, 'race-child-failure');
  const childFailureExternal = path.join(temporaryRoot, 'external-child-failure');
  await mkdir(childFailureRoot);
  await mkdir(childFailureExternal);
  const childFailureCanary = path.join(childFailureExternal, 'export.sql');
  await writeFile(childFailureCanary, 'ATTACKER-SENTINEL', 'utf8');
  const childFailure = await runExportChild(
    childFailureRoot,
    path.join(childFailureRoot, 'export.sql'),
    fakePnpm,
    realPnpm,
    originalPath,
    { mode: 'failure', externalRoot: childFailureExternal },
  );
  await waitForFile(childFailure.readyFile);
  await writeFile(childFailure.releaseFile, 'release', 'utf8');
  const childFailureResult = await childFailure.completed;
  if (childFailureResult.status === 0) throw new Error('Child export failure was accepted.');
  if ((await readFile(childFailureCanary, 'utf8')) !== 'ATTACKER-SENTINEL')
    throw new Error('Child failure changed the external canary.');
  await assertNoOwnedStagingDirectories(childFailureRoot);
  await assertProcessStopped(childFailure.childPidFile, 'child failure export child');

  const interruptionRoot = path.join(temporaryRoot, 'race-interruption');
  const interruptionExternal = path.join(temporaryRoot, 'external-interruption');
  await mkdir(interruptionRoot);
  await mkdir(interruptionExternal);
  const interruptionCanary = path.join(interruptionExternal, 'export.sql');
  await writeFile(interruptionCanary, 'ATTACKER-SENTINEL', 'utf8');
  const interruption = await runExportChild(
    interruptionRoot,
    path.join(interruptionRoot, 'export.sql'),
    fakePnpm,
    realPnpm,
    originalPath,
    { mode: 'deadline', externalRoot: interruptionExternal },
  );
  await waitForFile(interruption.readyFile);
  interruption.process.kill('SIGTERM');
  const interruptionResult = await interruption.completed;
  if (interruptionResult.status === 0) throw new Error('Interrupted export was accepted.');
  if ((await readFile(interruptionCanary, 'utf8')) !== 'ATTACKER-SENTINEL')
    throw new Error('Interrupted export changed the external canary.');
  await assertNoOwnedStagingDirectories(interruptionRoot);
  await assertProcessStopped(interruption.childPidFile, 'interrupted export child');

  const deadlineRoot = path.join(temporaryRoot, 'race-deadline');
  const deadlineExternal = path.join(temporaryRoot, 'external-deadline');
  await mkdir(deadlineRoot);
  await mkdir(deadlineExternal);
  const deadlineCanary = path.join(deadlineExternal, 'export.sql');
  await writeFile(deadlineCanary, 'ATTACKER-SENTINEL', 'utf8');
  const deadline = await runExportChild(
    deadlineRoot,
    path.join(deadlineRoot, 'export.sql'),
    fakePnpm,
    realPnpm,
    originalPath,
    { mode: 'deadline', externalRoot: deadlineExternal, deadlineMs: 100 },
  );
  await waitForFile(deadline.readyFile);
  const deadlineResult = await deadline.completed;
  if (deadlineResult.status === 0) throw new Error('Deadline export was accepted.');
  if ((await readFile(deadlineCanary, 'utf8')) !== 'ATTACKER-SENTINEL')
    throw new Error('Deadline cleanup changed the external canary.');
  await assertNoOwnedStagingDirectories(deadlineRoot);
  await assertProcessStopped(deadline.childPidFile, 'deadline export child');
}

async function runExportChild(parent, output, fakePnpm, realPnpm, originalPath, options = {}) {
  const readyFile = path.join(parent, 'ready');
  const releaseFile = path.join(parent, 'release');
  const childPidFile = path.join(temporaryRoot, `${path.basename(parent)}-child.pid`);
  const failureFile = path.join(parent, 'descriptor-failure');
  const child = spawn(runner, [exportScript], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CI: '1',
      GLOBAL_REGISTRY_DATABASE: 'DB',
      GLOBAL_REGISTRY_EXPORT_FILE: output,
      GLOBAL_REGISTRY_REMOTE: 'false',
      PATH: `${path.dirname(fakePnpm)}${path.delimiter}${originalPath}`,
      REAL_PNPM: realPnpm,
      ORIGINAL_PATH: originalPath,
      REPOSITORY_ROOT: repositoryRoot,
      RACE_READY_FILE: readyFile,
      RACE_RELEASE_FILE: releaseFile,
      RACE_SQL_SOURCE: validPath,
      RACE_CHILD_PID_FILE: childPidFile,
      RACE_FAILURE_FILE: failureFile,
      RACE_PARENT: parent,
      RACE_PARENT_MOVED: `${parent}-moved`,
      RACE_EXTERNAL_ROOT: options.externalRoot ?? path.join(parent, 'external'),
      RACE_MODE: options.mode ?? 'normal',
      ...(options.deadlineMs === undefined
        ? {}
        : { GLOBAL_REGISTRY_EXPORT_COMMAND_DEADLINE_MS: String(options.deadlineMs) }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let outputText = '';
  child.stdout?.on('data', (chunk) => {
    outputText += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    outputText += String(chunk);
  });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) =>
      resolve({ status: status ?? 1, signal, output: outputText }),
    );
  });
  return { process: child, readyFile, releaseFile, childPidFile, completed };
}

async function waitForFile(file) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await fileExists(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Export race child did not reach its synchronization point: ${file}`);
}

async function swapStaging(parent, externalRoot, kind) {
  const entries = await readdir(parent, { withFileTypes: true });
  const stage = entries.find((entry) => entry.name.startsWith('.global-registry-export-'));
  if (stage === undefined) throw new Error(`Cannot find staging directory in ${parent}.`);
  const stagePath = path.join(parent, stage.name);
  const canary = path.join(externalRoot, 'export.sql');
  if ((await readFile(canary, 'utf8')) !== 'ATTACKER-SENTINEL') {
    throw new Error(`External canary was not initialized for ${parent}.`);
  }
  if (kind === 'leaf') {
    await rm(stagePath, { recursive: true, force: true });
    await symlink(externalRoot, stagePath);
    return;
  }
  await rename(parent, `${parent}-moved`);
  await mkdir(parent);
  await symlink(externalRoot, path.join(parent, stage.name));
}

async function assertNoOwnedStagingDirectories(root) {
  if (!(await fileExists(root))) return;
  const entries = await readdir(root, { withFileTypes: true });
  const leftovers = entries.filter(
    (entry) => entry.name.startsWith('.global-registry-export-') && entry.isDirectory(),
  );
  if (leftovers.length > 0)
    throw new Error(`Export staging leaked: ${leftovers.map((entry) => entry.name).join(', ')}`);
}

async function assertProcessStopped(pidFile, label) {
  const pid = Number(await readFile(pidFile, 'utf8'));
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    throw error;
  }
  throw new Error(`${label} process ${pid} remained alive after cleanup.`);
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
