import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const regressionScript = path.join(repositoryRoot, 'scripts/local-auth-regression.mjs');
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), 'global-registry-local-auth-prerequisites-'),
);

try {
  await expectFailure('missing declared package', await createMissingPackageFixture(), [
    'The declared Playwright package is missing.',
    'pnpm install --frozen-lockfile',
    'pnpm browser:install',
  ]);

  const browserCache = path.join(temporaryRoot, 'empty-browser-cache');
  await mkdir(browserCache);
  await expectFailure(
    'missing browser executable',
    repositoryRoot,
    ['The declared Playwright Chromium executable is missing.', 'pnpm browser:install'],
    { PLAYWRIGHT_BROWSERS_PATH: browserCache },
  );

  globalThis.console.log(
    'Local auth prerequisite regressions passed: missing declared Playwright package and missing Chromium executable produce distinct actionable errors without changing the source dependency tree.',
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function createMissingPackageFixture() {
  const fixtureRoot = path.join(temporaryRoot, 'missing-package');
  await mkdir(path.join(fixtureRoot, 'scripts'), { recursive: true });
  await cp(regressionScript, path.join(fixtureRoot, 'scripts/local-auth-regression.mjs'));
  await writeFile(
    path.join(fixtureRoot, 'package.json'),
    `${JSON.stringify({ type: 'module', devDependencies: { playwright: '1.62.1' }, private: true })}\n`,
    'utf8',
  );
  return fixtureRoot;
}

async function expectFailure(label, cwd, expectedFragments, extraEnvironment = {}) {
  try {
    await executeFile(process.execPath, [path.join(cwd, 'scripts/local-auth-regression.mjs')], {
      cwd,
      env: { ...process.env, NODE_PATH: '', ...extraEnvironment },
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    for (const fragment of expectedFragments) {
      if (!output.includes(fragment)) {
        throw new Error(`${label} omitted ${fragment}: ${output}`, { cause: error });
      }
    }
    return;
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}
