import { execFile, spawn } from 'node:child_process';
import {
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { promisify } from 'node:util';
import { URL } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);
const gatePath = path.join(repositoryRoot, 'scripts/check-typescript-containment.mjs');
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), 'global-registry-typescript-containment-'),
);
const externalRoot = await mkdtemp(path.join(os.tmpdir(), 'global-registry-typescript-outside-'));
const externalTarget = path.join(externalRoot, 'outside-canary.ts');
const externalRedirectConfig = path.join(externalRoot, 'outside-wrangler.jsonc');
const externalRedirectMain = path.join(externalRoot, 'outside-wrangler-main.mjs');
const externalRedirectMarker = path.join(externalRoot, 'outside-wrangler-marker.txt');
const compilerMarker = path.join(temporaryRoot, 'compiler-invoked.txt');
const wrapperDirectory = path.join(temporaryRoot, 'controlled-bin');
const commandScripts = [
  'dev',
  'types',
  'types:check',
  'typecheck',
  'check',
  'check:migrations',
  'check:openapi',
  'check:deployment-preflight',
  'check:validate-export',
  'check:local-auth',
  'check:domain-boundary',
  'check:test-classification',
  'test',
  'test:unit',
  'test:worker',
  'smoke:local',
  'export:sql',
  'validate:sql-export',
  'deploy:preflight',
  'deploy:dry-run',
  'deploy:dry-run:local',
  'deploy',
  'startup:check',
  'db:migrate:local',
  'db:migrate:remote',
  'lint',
  'format:check',
  'build',
  'check:typescript-containment',
];

try {
  await writeFile(externalTarget, 'export const outsideCanary = true;\n', 'utf8');
  await writeFile(
    externalRedirectMain,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(externalRedirectMarker)}, 'executed');\n`,
    'utf8',
  );
  await writeFile(
    externalRedirectConfig,
    JSON.stringify({ main: externalRedirectMain }, null, 2),
    'utf8',
  );
  await copyRepositoryFixture(temporaryRoot);
  await writeControlledCompilerWrappers(wrapperDirectory, compilerMarker);

  await writeExternalWranglerRedirect(temporaryRoot);
  await expectGateRejected(temporaryRoot, ['Wrangler deploy redirect', 'escapes']);
  await runCommandLevelContainmentMatrix(temporaryRoot, wrapperDirectory, compilerMarker);
  if (await fileExists(externalRedirectMarker)) {
    throw new Error('External Wrangler main executed before redirect rejection.');
  }
  await rm(path.join(temporaryRoot, '.wrangler'), { recursive: true, force: true });

  await writeInternalWranglerRedirect(temporaryRoot);
  await execFileAsync(process.execPath, [gatePath, '--root', temporaryRoot], {
    cwd: temporaryRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
  await rm(path.join(temporaryRoot, '.wrangler'), { recursive: true, force: true });

  await writeForbiddenSourceFixtures(temporaryRoot);
  await expectGateRejected(temporaryRoot, ['external-path', 'external-url', 'outside-canary.ts']);
  await runSpecialFileRegression(temporaryRoot);

  globalThis.console.log(
    `TypeScript containment regressions passed: bounded external Wrangler redirect rejection across ${commandScripts.length} public entry points, safe internal redirect state, all supported import forms, escapes, unresolved modules, unsupported syntax, symlink/FIFO entries, and compiler/test/tsx/Vitest/Wrangler execution before a controlled marker could be written; the fixture reused the verified root dependency tree without nested package resolution.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  await rm(externalRoot, { recursive: true, force: true });
}

async function copyRepositoryFixture(targetRoot) {
  for (const directory of ['src', 'test', 'scripts', 'migrations']) {
    await cp(path.join(repositoryRoot, directory), path.join(targetRoot, directory), {
      recursive: true,
    });
  }
  for (const file of [
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'mise.toml',
    'mise.lock',
    'tsconfig.json',
    'vitest.config.ts',
    'vitest.unit.config.ts',
    'wrangler.jsonc',
    'wrangler.operator.example.jsonc',
  ]) {
    await cp(path.join(repositoryRoot, file), path.join(targetRoot, file));
  }
  const packageManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  delete packageManifest.devDependencies.playwright;
  await writeFile(
    path.join(targetRoot, 'package.json'),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
    'utf8',
  );
  await linkVerifiedRootDependencyTree(targetRoot);
}

async function linkVerifiedRootDependencyTree(targetRoot) {
  const sourceNodeModules = path.join(repositoryRoot, 'node_modules');
  const targetNodeModules = path.join(targetRoot, 'node_modules');
  await mkdir(path.join(targetNodeModules, '.bin'), { recursive: true });
  for (const entry of await readdir(sourceNodeModules, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === 'playwright') continue;
    await symlink(
      path.join(sourceNodeModules, entry.name),
      path.join(targetNodeModules, entry.name),
    );
  }
  for (const entry of await readdir(path.join(sourceNodeModules, '.bin'), {
    withFileTypes: true,
  })) {
    if (entry.name === 'playwright') continue;
    await symlink(
      path.join(sourceNodeModules, '.bin', entry.name),
      path.join(targetNodeModules, '.bin', entry.name),
    );
  }
}

async function writeForbiddenSourceFixtures(targetRoot) {
  const external = JSON.stringify(externalTarget);
  const sourceFiles = {
    'forbidden-static.ts': `import ${external};\n`,
    'forbidden-export.ts': `export { outsideCanary } from ${JSON.stringify(`file://${externalTarget}`)};\n`,
    'forbidden-file-url.ts': `import ${JSON.stringify(`file://${externalTarget}`)};\n`,
    'forbidden-absolute.ts': `import ${external};\n`,
    'forbidden-traversal.ts': `import '../../../../outside-canary.ts';\n`,
    'forbidden-dynamic.ts': `await import(${external});\n`,
    'forbidden-template.ts': `await import(\`${externalTarget}\`);\n`,
    'forbidden-import-type.ts': `type Outside = import(${external}).outsideCanary;\n`,
    'forbidden-require.cts': `const outside = require(${external});\n`,
    'forbidden-import-equals.mts': `import outside = require(${external});\n`,
    'forbidden-unknown-package.ts': `import 'not-allowlisted-package';\n`,
    'forbidden-unresolved.ts': `import './module-that-does-not-exist';\n`,
    'forbidden-unsupported-dynamic.ts': `const specifier = ${external};\nawait import(specifier);\n`,
    'forbidden-unc.ts': `import '\\\\server\\share\\outside.ts';\n`,
    'forbidden-drive.ts': `import 'C:/outside.ts';\n`,
    'forbidden-syntax.ts': 'const invalid = ;\n',
  };
  for (const [fileName, source] of Object.entries(sourceFiles)) {
    await writeFile(path.join(targetRoot, 'src', fileName), source, 'utf8');
  }
}

async function writeControlledCompilerWrappers(directory, marker) {
  await mkdir(directory, { recursive: true });
  for (const name of ['wrangler', 'tsx', 'vitest', 'tsc', 'eslint', 'prettier']) {
    await writeFile(
      path.join(directory, name),
      `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n`,
      { encoding: 'utf8', mode: 0o755 },
    );
  }
}

async function writeExternalWranglerRedirect(root) {
  const redirectDirectory = path.join(root, '.wrangler', 'deploy');
  await mkdir(redirectDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(redirectDirectory, 'config.json'),
    JSON.stringify({ configPath: path.relative(redirectDirectory, externalRedirectConfig) }),
    'utf8',
  );
}

async function writeInternalWranglerRedirect(root) {
  const redirectDirectory = path.join(root, '.wrangler', 'deploy');
  await mkdir(redirectDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(redirectDirectory, 'config.json'),
    JSON.stringify({ configPath: '../../wrangler.jsonc' }),
    'utf8',
  );
}

async function expectGateRejected(root, expectedFragments) {
  try {
    await execFileAsync(process.execPath, [gatePath, '--root', root], {
      cwd: root,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const combined = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    for (const fragment of expectedFragments) {
      if (!combined.includes(fragment)) {
        throw new Error(`Containment rejection omitted ${fragment}: ${combined}`, { cause: error });
      }
    }
    return;
  }
  throw new Error('Containment gate accepted the external-source fixture.');
}

async function runCommandLevelContainmentMatrix(root, wrapperDirectory, marker) {
  const environment = {
    ...process.env,
    CI: 'true',
    PATH: `${wrapperDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
    GLOBAL_REGISTRY_TEST_DEADLINE_MS: '1000',
  };
  for (const script of commandScripts) {
    await rm(marker, { force: true });
    const result = await runBoundedPublicCommand(root, script, environment);
    if (result.status === 0 && result.signal === null) {
      throw new Error(`Public entry ${script} accepted external source.`);
    }
    if (
      !result.output.includes('TypeScript containment') &&
      !result.output.includes('external-') &&
      !result.output.includes('Wrangler deploy redirect')
    ) {
      throw new Error(
        `Public entry ${script} rejected without a containment reason: ${result.output}`,
      );
    }
    if (await fileExists(marker)) {
      const markerContents = await readFile(marker, 'utf8');
      throw new Error(
        `Public entry ${script} opened a compiler/test tool before containment: ${markerContents}`,
      );
    }
  }

  const legacyWatch = await execFileAsync('pnpm', ['run', 'test:watch'], {
    cwd: root,
    env: environment,
    maxBuffer: 1024 * 1024,
  }).then(
    () => false,
    () => true,
  );
  if (!legacyWatch) throw new Error('Unsafe test:watch convenience entry point still exists.');
}

async function runBoundedPublicCommand(cwd, script, environment) {
  const child = spawn('pnpm', ['run', script], {
    cwd,
    env: environment,
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = (chunk) => {
    output += String(chunk);
    if (output.length > 4 * 1024 * 1024) output = output.slice(-4 * 1024 * 1024);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child);
    }, 5_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? 124 : (status ?? 1),
        signal,
        output,
      });
    });
  });
}

function terminateProcessGroup(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

async function runSpecialFileRegression(root) {
  const symlinkPath = path.join(root, 'scripts', 'external-link.ts');
  await symlink(externalTarget, symlinkPath);
  await expectGateRejected(root, ['symbolic link']);
  await unlink(symlinkPath);

  const fifoPath = path.join(root, 'scripts', 'external.fifo');
  await execFileAsync('mkfifo', ['--mode=600', fifoPath]);
  try {
    await expectGateRejected(root, ['non-regular', 'fifo']);
  } finally {
    await unlink(fifoPath).catch(() => undefined);
  }
}

async function fileExists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}
