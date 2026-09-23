import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import ts from 'typescript';
const root = process.cwd();
const directory = await mkdtemp(path.join(tmpdir(), 'registry-browser-'));
const secret = randomBytes(32).toString('hex');
const parsed = ts.parseConfigFileTextToJson(
  'wrangler.jsonc',
  await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'),
);
assert(!parsed.error, 'Invalid Wrangler configuration.');
const config = parsed.config;
config.main = path.join(root, 'src/index.ts');
config.env.development.vars.LOCAL_AUTH_SECRET = secret;
config.env.development.d1_databases[0].migrations_dir = path.join(root, 'migrations');
const configPath = path.join(directory, 'wrangler.json');
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const common = [
  '--config',
  configPath,
  '--env',
  'development',
  '--persist-to',
  path.join(directory, 'state'),
];
let worker: ChildProcess | undefined;
let output = '';
async function command(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(text))));
  });
}
async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
try {
  await command(['d1', 'migrations', 'apply', 'DB', '--local', ...common]);
  const port = await unusedPort();
  const base = 'http://127.0.0.1:' + port;
  worker = spawn(
    process.execPath,
    [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), ...common],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  worker.stdout!.on('data', (d) => (output += d));
  worker.stderr!.on('data', (d) => (output += d));
  let ready = false;
  for (let n = 0; n < 150; n++) {
    try {
      const response = await fetch(base);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for the local Worker listener. */
    }
    if (worker.exitCode !== null) throw new Error('Worker exited: ' + output);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(ready, 'Worker did not start: ' + output);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    await page.getByRole('dialog').waitFor();
    await page.locator('[name="secret"]').fill(secret);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('heading', { name: 'Infrastructure inventory', exact: true }).waitFor();
    async function create(entity: string, fields: Record<string, string>) {
      await page.goto(base + '/' + entity + '/new');
      for (const [key, value] of Object.entries(fields)) {
        const input = page.locator('[name="' + key + '"]');
        await input.waitFor();
        if (await input.evaluate((e) => e.tagName === 'SELECT')) await input.selectOption(value);
        else await input.fill(value);
      }
      const created = page.waitForResponse(
        (response) =>
          response.url() === base + '/api/v1/' + entity && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Create record', exact: true }).click();
      const response = await created;
      if (response.status() !== 201) throw new Error(entity + ': ' + (await response.text()));
      await page.waitForURL(new RegExp('/' + entity + '/[0-9a-f-]{36}$'));
      await page
        .getByRole('button', { name: 'Delete', exact: true })
        .or(page.getByRole('button', { name: 'Release IP address', exact: true }))
        .waitFor();
      return page.url().split('/').at(-1)!;
    }
    const locationId = await create('locations', { name: 'Browser lab', slug: 'browser-lab' });
    const device = await create('devices', {
      name: 'Browser server',
      role: 'server',
      location_id: locationId,
    });
    const vm = await create('virtual-machines', {
      name: 'Browser VM',
      host_device_id: device,
      vcpu: '2',
      memory_mb: '2048',
    });
    const nic = await create('interfaces', { name: 'net0', virtual_machine_id: vm });
    const vlan = await create('vlans', { name: 'Browser LAN', location_id: locationId, vid: '42' });
    const prefix = await create('prefixes', {
      location_id: locationId,
      vlan_id: vlan,
      cidr: '10.42.0.5/24',
    });
    await page.getByRole('link', { name: 'Allocate IP address', exact: true }).click();
    await page.locator('[name="interface_id"]').selectOption(nic);
    await page.locator('[name="dns_name"]').fill('guest.example.internal');
    await page.getByRole('button', { name: 'Allocate IP address', exact: true }).click();
    await page.waitForURL(/\/ip-addresses\/[0-9a-f-]{36}$/);
    await page.getByRole('heading', { name: '10.42.0.1', exact: true }).waitFor();
    const ip = page.url().split('/').at(-1)!;
    await page.goto(base + '/virtual-machines/' + vm + '?edit');
    await page.locator('[name="name"]').fill('Renamed VM');
    await page.locator('[name="host_device_id"]').selectOption('');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.waitForURL(base + '/virtual-machines/' + vm);
    await page.getByRole('heading', { name: 'Renamed VM', exact: true }).waitFor();
    for (const entity of [
      'locations',
      'devices',
      'virtual-machines',
      'interfaces',
      'vlans',
      'prefixes',
      'ip-addresses',
      'audit-log',
    ]) {
      await page.goto(base + '/' + entity);
      await page.locator('table tbody tr').first().waitFor();
      assert.equal(await page.locator('#error').count(), 0, entity);
    }
    await page.goto(base + '/devices');
    await page.locator('[name="q"]').fill('Browser server');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('link', { name: 'Browser server', exact: true }).waitFor();
    await page.goto(base + '/docs');
    await page.locator('#swagger-ui .opblock').first().waitFor();
    assert((await page.locator('#swagger-ui .opblock').count()) > 30);
    await page.goto(base + '/prefixes/' + prefix);
    await page.getByRole('heading', { name: '10.42.0.0/24', exact: true }).waitFor();
    await page.getByRole('link', { name: '10.42.0.1', exact: true }).waitFor();
    if (process.env.REGISTRY_SCREENSHOT)
      await page.screenshot({ path: process.env.REGISTRY_SCREENSHOT, fullPage: true });
    page.on('dialog', (dialog) => void dialog.accept());
    await page.goto(base + '/interfaces/' + nic);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForURL(base + '/interfaces');
    const response = await fetch(base + '/api/v1/ip-addresses/' + ip, {
      headers: { 'x-global-registry-dev-secret': secret },
    });
    const record = (await response.json()) as { interface_id: string | null };
    assert.equal(record.interface_id, null);
    await page.goto(base + '/ip-addresses/' + ip);
    await page.getByRole('button', { name: 'Release IP address', exact: true }).click();
    await page.waitForURL(base + '/ip-addresses');
    await page.goto(base + '/audit-log');
    await page.locator('table tbody tr').first().waitFor();
    await page.locator('table tbody tr a').first().click();
    await page.locator('dl').waitFor();
    assert.equal(await page.locator('#error').count(), 0);
    async function http(
      entity: string,
      method = 'GET',
      body?: unknown,
      expected = 200,
      extraHeaders: Record<string, string> = {},
    ) {
      const response = await fetch(base + '/api/v1/' + entity, {
        method,
        headers: {
          'x-global-registry-dev-secret': secret,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      assert.equal(response.status, expected, method + ' ' + entity + ': ' + text);
      return text ? JSON.parse(text) : null;
    }
    async function edit(entity: string, id: string) {
      await page.goto(base + '/' + entity + '/' + id + '?edit');
      await page.locator('[name="description"]').fill('Verified in real browser');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await page.waitForURL(base + '/' + entity + '/' + id);
      assert.equal((await http(entity + '/' + id)).description, 'Verified in real browser');
    }
    async function remove(entity: string, id: string) {
      await page.goto(base + '/' + entity + '/' + id);
      await page
        .getByRole('button', {
          name: entity === 'ip-addresses' ? 'Release IP address' : 'Delete',
          exact: true,
        })
        .click();
      await page.waitForURL(base + '/' + entity);
      await http(entity + '/' + id, 'GET', undefined, 404);
    }
    const physicalNic = await create('interfaces', { name: 'eno1', device_id: device });
    const explicitIp = await create('ip-addresses', {
      prefix_id: prefix,
      interface_id: physicalNic,
      address: '10.42.0.10',
      status: 'reserved',
    });
    for (const [entity, id] of [
      ['locations', locationId],
      ['devices', device],
      ['virtual-machines', vm],
      ['interfaces', physicalNic],
      ['vlans', vlan],
      ['prefixes', prefix],
      ['ip-addresses', explicitIp],
    ]) {
      await edit(entity!, id!);
    }
    await http('locations', 'GET', undefined, 401, { 'x-global-registry-dev-secret': '' });
    await http('locations', 'POST', { name: 'Rejected', slug: 'rejected' }, 403, {
      origin: 'https://other.example',
    });
    for (const [entity, id] of [
      ['locations', locationId],
      ['vlans', vlan],
      ['prefixes', prefix],
    ]) {
      await http(entity + '/' + id, 'DELETE', undefined, 409);
    }
    await http(
      'ip-addresses',
      'POST',
      { prefix_id: prefix, address: '10.42.0.10', status: 'assigned' },
      409,
    );
    await http(
      'ip-addresses',
      'POST',
      { prefix_id: prefix, address: '10.43.0.1', status: 'assigned' },
      400,
    );
    await http('interfaces', 'POST', { name: 'invalid-owner' }, 400);
    const child = await http(
      'prefixes',
      'POST',
      { location_id: locationId, cidr: '10.42.0.0/28' },
      201,
    );
    const allocations = await Promise.all(
      Array.from({ length: 4 }, () => http('prefixes/' + prefix + '/allocate', 'POST', {}, 201)),
    );
    assert.deepEqual(allocations.map((row) => row.address).sort(), [
      '10.42.0.16',
      '10.42.0.17',
      '10.42.0.18',
      '10.42.0.19',
    ]);
    const ipv6 = await create('prefixes', { location_id: locationId, cidr: '2001:0db8:42::1/126' });
    const reserved6 = await create('ip-addresses', {
      prefix_id: ipv6,
      address: '2001:db8:42::',
      status: 'reserved',
    });
    await page.goto(base + '/prefixes/' + ipv6 + '?allocate');
    await page.getByRole('button', { name: 'Allocate IP address', exact: true }).click();
    await page.waitForURL(/\/ip-addresses\/[0-9a-f-]{36}$/);
    await page.getByRole('heading', { name: '2001:db8:42::1', exact: true }).waitFor();
    const allocated6 = page.url().split('/').at(-1)!;
    await remove('ip-addresses', allocated6);
    await remove('ip-addresses', reserved6);
    await remove('prefixes', ipv6);
    await http('virtual-machines/' + vm, 'PATCH', { host_device_id: device });
    await remove('devices', device);
    assert.equal((await http('virtual-machines/' + vm)).host_device_id, null);
    assert.equal((await http('ip-addresses/' + explicitIp)).interface_id, null);
    await http('interfaces/' + physicalNic, 'GET', undefined, 404);
    await remove('ip-addresses', explicitIp);
    for (const row of allocations) await http('ip-addresses/' + row.id, 'DELETE', undefined, 204);
    await remove('virtual-machines', vm);
    await remove('prefixes', child.id);
    await remove('prefixes', prefix);
    await remove('vlans', vlan);
    await remove('locations', locationId);
    const audit = await http('audit-log?limit=200');
    for (const action of ['create', 'update', 'delete', 'allocate', 'release'])
      assert(
        audit.items.some((row: { action: string }) => row.action === action),
        action,
      );
    for (const entity of [
      'locations',
      'devices',
      'virtual-machines',
      'interfaces',
      'vlans',
      'prefixes',
      'ip-addresses',
    ])
      assert.equal((await http(entity)).total, 0, entity);
    assert.deepEqual(errors, []);
    console.log(
      'Browser smoke passed: all entity CRUD, IPv4/IPv6, concurrent allocation, reserved/child exclusions, deletion constraints, authentication, audit, and API docs.',
    );
  } finally {
    await browser.close();
  }
} finally {
  if (worker && worker.exitCode === null) {
    const exited = new Promise<void>((resolve) => worker!.once('exit', () => resolve()));
    worker.kill('SIGTERM');
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
