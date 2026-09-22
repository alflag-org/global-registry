import { it, expect } from 'vitest';
import { api, create, location } from './helpers';
it('validates requests and consistently reports 400, 404 and 409', async () => {
  for (const [path, method, body, status] of [
    ['locations', 'POST', {}, 400],
    ['devices', 'POST', { name: 'x', role: 'anything' }, 400],
    ['interfaces', 'POST', { name: 'x' }, 400],
    ['ip-addresses', 'POST', { address: 'bad' }, 400],
    ['locations?limit=-1', 'GET', undefined, 400],
    ['locations?limit=201', 'GET', undefined, 400],
    ['locations?offset=abc', 'GET', undefined, 400],
    ['locations?unknown=x', 'GET', undefined, 400],
    ['locations/bad', 'GET', undefined, 400],
    ['locations/' + crypto.randomUUID(), 'GET', undefined, 404],
    ['resources', 'GET', undefined, 404],
  ] as const) {
    const result = await api(path, method, body);
    expect(result.status, path).toBe(status);
    expect(await result.json()).toMatchObject({
      code: expect.any(String),
      message: expect.any(String),
    });
  }
  const l = await location();
  expect((await api('locations/' + l.id, 'PATCH', {})).status).toBe(400);
  expect((await api('locations/' + l.id, 'PATCH', { name: null })).status).toBe(400);
  expect((await api('locations/' + l.id, 'PATCH', { unknown: 1 })).status).toBe(400);
  expect(
    (
      await api('devices', 'POST', {
        name: 'missing location',
        role: 'server',
        location_id: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
});
it('filters and paginates with stable totals, including VM location derived from host', async () => {
  const a = await location(),
    b = await location();
  const marker = crypto.randomUUID();
  for (let n = 0; n < 3; n++)
    await create('devices', {
      name: marker + '-' + n,
      location_id: a.id,
      role: 'server',
      source: 'test',
      source_scope: marker,
      source_id: String(n),
    });
  await create('devices', { name: marker + '-other', location_id: b.id, role: 'router' });
  const result = (await (
    await api(
      'devices?q=' +
        marker +
        '&location_id=' +
        a.id +
        '&source=test&source_scope=' +
        marker +
        '&limit=1&offset=1',
    )
  ).json()) as { items: { id: string }[]; total: number };
  expect(result.total).toBe(3);
  expect(result.items).toHaveLength(1);
  const vm = await create('virtual-machines', {
    name: 'guest',
    host_device_id: result.items[0]!.id,
  });
  const found = (await (
    await api('virtual-machines?location_id=' + a.id + '&host_device_id=' + result.items[0]!.id)
  ).json()) as { items: { id: string }[] };
  expect(found.items.map((r) => r.id)).toContain(vm.id);
  expect(((await (await api('devices?q=%25')).json()) as { total: number }).total).toBe(0);
});
it('generates OpenAPI from registered validation schemas and exposes all operations', async () => {
  const response = await api('/openapi.json');
  expect(response.status).toBe(200);
  const spec = (await response.json()) as {
    openapi: string;
    paths: Record<
      string,
      Record<
        string,
        {
          requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
          responses: Record<string, unknown>;
        }
      >
    >;
    components: { schemas: Record<string, unknown> };
  };
  expect(spec.openapi).toBe('3.1.0');
  for (const path of [
    'locations',
    'devices',
    'virtual-machines',
    'interfaces',
    'vlans',
    'prefixes',
    'ip-addresses',
  ]) {
    expect(Object.keys(spec.paths['/api/v1/' + path]!).sort()).toEqual(['get', 'post']);
    expect(Object.keys(spec.paths['/api/v1/' + path + '/{id}']!).sort()).toEqual([
      'delete',
      'get',
      'patch',
    ]);
  }
  expect(spec.paths['/api/v1/prefixes/{id}/allocate']).toHaveProperty('post');
  expect(Object.keys(spec.paths['/api/v1/audit-log']!)).toEqual(['get']);
  expect(spec.components.schemas).toHaveProperty('PrefixDetail');
  expect(spec.components.schemas).toHaveProperty('DeviceDetail');
  expect(spec.components.schemas).not.toHaveProperty('Resource');
});
it('serves the UI shell, assets, and docs with browser protections', async () => {
  for (const path of [
    '/',
    '/locations',
    '/devices',
    '/virtual-machines',
    '/interfaces',
    '/vlans',
    '/prefixes',
    '/ip-addresses',
    '/audit-log',
    '/docs',
  ]) {
    const response = await api(path);
    expect(response.status, path).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('Global Registry');
  }
  expect((await api('/assets/app.js')).headers.get('content-type')).toContain('javascript');
  expect(
    (
      await api(
        'locations',
        'POST',
        { name: 'bad', slug: 'bad' },
        { origin: 'https://evil.example' },
      )
    ).status,
  ).toBe(403);
});
