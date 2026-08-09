import { execFile, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { access, cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'global-registry-local-auth-'));
const port = 8787;
const baseUrl = `http://127.0.0.1:${port}`;
const secret = randomBytes(32).toString('hex');
const identity = 'access:local-admin';
const actorId = 'actor-local-admin-e2e';
const headers = {
  'x-global-registry-dev-secret': secret,
  'x-global-registry-dev-identity': identity,
};
let developmentProcess;
let browser;
let developmentOutput;
let chromium;
let wranglerEntrypoint;

try {
  await assertDeclaredPlaywrightBootstrap();
  wranglerEntrypoint = resolveDeclaredWranglerEntrypoint();
  await ensurePortIsFree(port);
  await copyRepositoryForLocalState();
  await writeFile(
    path.join(temporaryRoot, '.dev.vars'),
    [
      'ENVIRONMENT=development',
      'ALLOW_LOCAL_AUTH=true',
      `LOCAL_ACTOR_IDENTITY=${identity}`,
      'ACCESS_TEAM_DOMAIN=unset',
      'ACCESS_AUD=unset',
      `LOCAL_AUTH_SECRET=${secret}`,
      'BACKUP_ACTOR_ID=unset',
      '',
    ].join('\n'),
    'utf8',
  );

  await runLocalWrangler([
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
  await seedActor();
  developmentProcess = spawn(
    process.execPath,
    [
      wranglerEntrypoint,
      'dev',
      '--local',
      '--env',
      'development',
      '--config',
      'wrangler.jsonc',
      '--ip',
      '127.0.0.1',
    ],
    {
      cwd: temporaryRoot,
      detached: true,
      env: { ...process.env, CI: '1', WRANGLER_LOG: 'debug' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  developmentOutput = collectOutput(developmentProcess);
  await waitForServer();
  await runBrowserRegression();

  await expectStatus('authenticated API', request('/api/v1/auth/session', headers), 200);
  await expectStatus(
    'authenticated API with exact Wrangler marker',
    request('/api/v1/auth/session', { ...headers, 'cf-connecting-ip': '127.0.0.1' }),
    200,
  );
  const ui = await request('/ui', headers);
  if (ui.status !== 200) throw new Error(`Authenticated UI returned ${ui.status}.`);
  assertCsp(ui.headers.get('content-security-policy'));
  await ui.arrayBuffer();
  await expectStatus('authenticated JavaScript asset', request('/ui/assets/app.js', headers), 200);
  await expectStatus('authenticated CSS asset', request('/ui/assets/app.css', headers), 200);
  await expectStatus(
    'invalid local secret',
    request('/api/v1/auth/session', {
      ...headers,
      'x-global-registry-dev-secret': randomBytes(32).toString('hex'),
    }),
    401,
  );
  await expectStatus(
    'forwarded local request',
    request('/api/v1/auth/session', { ...headers, 'x-forwarded-for': '192.0.2.10' }),
    503,
  );
  for (const header of [
    'x-cf-connecting-ip',
    'x_cf_connecting_ip',
    'x-cf-ray',
    'x_cloudflare_ray',
    'cf_connecting_ip',
  ]) {
    await expectStatus(
      `forbidden proxy header ${header}`,
      request('/api/v1/auth/session', { ...headers, [header]: '127.0.0.1' }),
      503,
    );
  }
  await expectStatus(
    'non-loopback Host context',
    requestWithHost('/api/v1/auth/session', headers, 'example.test'),
    503,
  );
  await assertRawCredentialIngressRejected();
  globalThis.console.log(
    'Local auth regression passed: clean declared Playwright bootstrap, local Wrangler dev, fresh local D1 migration, mapped Actor, authenticated API/UI/assets, exact Wrangler marker, invalid secret, forwarding and X-CF header variants, non-loopback Host, raw credential-bearing absolute-form ingress rejection, CSP, and browser console checks.',
  );
} catch (error) {
  const details =
    developmentOutput === undefined
      ? ''
      : `\nWorker stdout:\n${developmentOutput.stdout}\nWorker stderr:\n${developmentOutput.stderr}`;
  throw new Error(`${error instanceof Error ? error.message : String(error)}${details}`, {
    cause: error,
  });
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined);
  await stopProcess(developmentProcess);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function assertDeclaredPlaywrightBootstrap() {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const declaredVersion = packageJson.devDependencies?.playwright;
  if (declaredVersion !== '1.62.1') {
    throw new Error(
      'local-auth regression requires the declared Playwright 1.62.1 package. Run `pnpm install --frozen-lockfile` before retrying.',
    );
  }
  let playwright;
  try {
    playwright = await import('playwright');
  } catch (error) {
    if (isMissingModuleError(error)) {
      throw new Error(
        'The declared Playwright package is missing. Run `pnpm install --frozen-lockfile`, then `pnpm browser:install`, and retry `pnpm check:local-auth`.',
        { cause: error },
      );
    }
    throw new Error('The declared Playwright package could not be loaded.', { cause: error });
  }
  chromium = playwright.chromium;
  const resolved = fileURLToPath(import.meta.resolve('playwright'));
  const dependencyRoot = `${path.join(repositoryRoot, 'node_modules')}${path.sep}`;
  if (!resolved.startsWith(dependencyRoot)) {
    throw new Error(`Playwright resolved outside the declared dependency tree: ${resolved}`);
  }
  try {
    await access(chromium.executablePath());
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(
        'The declared Playwright Chromium executable is missing. Run `pnpm install --frozen-lockfile`, then `pnpm browser:install`, and retry `pnpm check:local-auth`.',
        { cause: error },
      );
    }
    throw new Error('The declared Playwright Chromium executable could not be accessed.', {
      cause: error,
    });
  }
}

function isMissingModuleError(error) {
  return error !== null && typeof error === 'object' && error.code === 'ERR_MODULE_NOT_FOUND';
}

function isMissingFileError(error) {
  return error !== null && typeof error === 'object' && error.code === 'ENOENT';
}

function resolveDeclaredWranglerEntrypoint() {
  let resolved;
  try {
    resolved = fileURLToPath(import.meta.resolve('wrangler'));
  } catch (error) {
    if (isMissingModuleError(error)) {
      throw new Error(
        'The declared Wrangler package is missing. Run `pnpm install --frozen-lockfile`, then retry `pnpm check:local-auth`.',
        { cause: error },
      );
    }
    throw new Error('The declared Wrangler package could not be resolved.', { cause: error });
  }
  const dependencyRoot = `${path.join(repositoryRoot, 'node_modules')}${path.sep}`;
  if (!resolved.startsWith(dependencyRoot)) {
    throw new Error(`Wrangler resolved outside the declared dependency tree: ${resolved}`);
  }
  return resolved;
}

async function copyRepositoryForLocalState() {
  await cp(repositoryRoot, temporaryRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(repositoryRoot, source);
      if (relative === '') return true;
      const first = relative.split(path.sep)[0];
      return ![
        '.git',
        '.wrangler',
        'node_modules',
        'worker-configuration.d.ts',
        '.dev.vars',
      ].includes(first);
    },
  });
  await symlink(
    path.join(repositoryRoot, 'node_modules'),
    path.join(temporaryRoot, 'node_modules'),
  );
}

async function seedActor() {
  const timestamp = new Date().toISOString();
  const sql = `INSERT INTO actors (id, identity, display_name, role, active, revision, created_at, updated_at, created_by, updated_by) VALUES ('${actorId}', '${identity}', 'Local E2E Admin', 'admin', 1, 1, '${timestamp}', '${timestamp}', '${actorId}', '${actorId}');`;
  await runCommand(
    process.execPath,
    [
      wranglerEntrypoint,
      'd1',
      'execute',
      'DB',
      '--local',
      '--env',
      'development',
      '--config',
      'wrangler.jsonc',
      '--command',
      sql,
    ],
    { cwd: temporaryRoot },
  );
}

async function runLocalWrangler(argumentsList) {
  await runCommand(
    process.execPath,
    [path.join(temporaryRoot, 'scripts/check-typescript-containment.mjs')],
    { cwd: temporaryRoot },
  );
  return runCommand(process.execPath, [wranglerEntrypoint, ...argumentsList], {
    cwd: temporaryRoot,
  });
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await request('/healthz', headers);
      if (response.status === 200) {
        await response.arrayBuffer();
        return;
      }
    } catch {
      // The listener can accept connections before the local Worker is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('pnpm dev did not start within 30 seconds.');
}

async function request(route, requestHeaders) {
  return requestWithHost(route, requestHeaders, `127.0.0.1:${port}`);
}

function requestWithHost(route, requestHeaders, host) {
  return requestTarget(route, requestHeaders, host);
}

function requestTarget(target, requestHeaders, host) {
  return new Promise((resolve, reject) => {
    const requestObject = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: target,
        method: 'GET',
        headers: { ...requestHeaders, host },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve(
            new globalThis.Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers: response.headers,
            }),
          ),
        );
      },
    );
    requestObject.on('error', reject);
    requestObject.end();
  });
}

async function assertRawCredentialIngressRejected() {
  const username = 'absolute-form-user';
  const password = 'absolute-form-password';
  const response = await requestTarget(
    `http://${username}:${password}@127.0.0.1:${port}/api/v1/auth/session`,
    headers,
    `127.0.0.1:${port}`,
  );
  const body = await response.text();
  if (response.status !== 500) {
    throw new Error(
      `Credential-bearing absolute-form ingress returned ${response.status}; expected local Workerd rejection with status 500. Response: ${body.slice(0, 1_000)}`,
    );
  }
  if (response.headers.get('x-request-id') !== null) {
    throw new Error(
      'Credential-bearing absolute-form ingress reached application request handling.',
    );
  }
  const workerOutput = `${developmentOutput?.stdout ?? ''}\n${developmentOutput?.stderr ?? ''}`;
  if (
    body.includes(username) ||
    body.includes(password) ||
    workerOutput.includes(username) ||
    workerOutput.includes(password)
  ) {
    throw new Error(
      'Credential-bearing absolute-form ingress was exposed in a response or project log.',
    );
  }
}

async function expectStatus(label, responsePromise, expected) {
  const response = await responsePromise;
  if (response.status !== expected) {
    const body = await response.text();
    throw new Error(
      `${label} returned ${response.status}; expected ${expected}. Response: ${body.slice(0, 1_000)}`,
    );
  }
  await response.arrayBuffer();
}

function assertCsp(value) {
  if (
    value === null ||
    !value.includes("default-src 'self'") ||
    !value.includes("script-src 'self'") ||
    !value.includes("style-src 'self'")
  ) {
    throw new Error(`Authenticated UI CSP is not self-only: ${value ?? '<missing>'}`);
  }
}

async function runBrowserRegression() {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ extraHTTPHeaders: headers });
  const page = await context.newPage();
  try {
    const consoleErrors = [];
    const pageErrors = [];
    const assets = {};
    const failedAssetBodies = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('response', (response) => {
      const url = response.url();
      if (url.endsWith('/ui/assets/app.js') || url.endsWith('/ui/assets/app.css')) {
        assets[url] = response.status();
        if (response.status() >= 400) {
          failedAssetBodies.push(response.text().catch((error) => String(error)));
        }
      }
    });
    const response = await page.goto(`${baseUrl}/ui`, { waitUntil: 'networkidle' });
    const result = {
      status: response?.status() ?? 0,
      title: await page.title(),
      assets,
      consoleErrors,
      pageErrors,
      body: await page.locator('body').innerText(),
    };
    if (result.status !== 200 || Object.values(result.assets).some((status) => status !== 200)) {
      throw new Error(
        `Browser UI or assets failed: ${JSON.stringify({
          ...result,
          failedAssetBodies: (await Promise.all(failedAssetBodies)).map((body) =>
            body.slice(0, 2_000),
          ),
        })}`,
      );
    }
    if (result.consoleErrors.length > 0 || result.pageErrors.length > 0) {
      throw new Error(`Browser console errors: ${JSON.stringify(result)}`);
    }
  } finally {
    await context.close();
  }
}

async function runCommand(command, argumentsList, options = {}) {
  try {
    return await executeFile(command, argumentsList, {
      cwd: options.cwd,
      env: { ...process.env, CI: '1' },
      timeout: options.timeout ?? 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `${command} ${argumentsList.join(' ')} failed: ${error.stderr ?? error.message}`,
      { cause: error },
    );
  }
}

function collectOutput(child) {
  const output = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => {
    output.stdout = `${output.stdout}${chunk}`.slice(-32_768);
  });
  child.stderr?.on('data', (chunk) => {
    output.stderr = `${output.stderr}${chunk}`.slice(-32_768);
  });
  return output;
}

async function stopProcess(child) {
  if (child === undefined) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
    await exited;
  }
}

async function ensurePortIsFree(candidatePort) {
  await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE')
        reject(new Error(`Port ${candidatePort} is already in use.`));
      else reject(error);
    });
    server.listen(candidatePort, '127.0.0.1', () => server.close(resolve));
  });
}
