import { env } from 'cloudflare:workers';
import { it, expect } from 'vitest';
import { api, create, location } from './helpers';

it('canonicalizes source on create, patch and filters while preserving opaque identifier case', async () => {
  const l = await location();
  for (const entity of ['devices', 'virtual-machines']) {
    const input = {
      name: 'source test',
      ...(entity === 'devices' ? { location_id: l.id, role: 'server' } : {}),
      source: ' Proxmox ',
      source_scope: 'ScopeABC',
      source_id: 'IDabc',
    };
    const row = await create(entity, input);
    expect(row).toMatchObject({ source: 'proxmox', source_scope: 'ScopeABC', source_id: 'IDabc' });
    expect((await api(entity, 'POST', { ...input, source: 'PROXMOX' })).status).toBe(409);
    const filtered = await api(`${entity}?source=PROXMOX&source_scope=ScopeABC`);
    expect(JSON.stringify(await filtered.json())).toContain(row.id);
    const patched = await api(`${entity}/${row.id}`, 'PATCH', { source: 'VMware' });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      source: 'vmware',
      source_scope: 'ScopeABC',
      source_id: 'IDabc',
    });
    for (const source of ['bad value', '_bad', '日本語']) {
      expect((await api(`${entity}/${row.id}`, 'PATCH', { source })).status).toBe(400);
    }
    const table = entity === 'devices' ? 'devices' : 'virtual_machines';
    await expect(
      env.DB.prepare(`UPDATE ${table} SET source=? WHERE id=?`).bind('Proxmox', row.id).run(),
    ).rejects.toThrow();
  }
});

it('documents gateway authentication with both service headers required together', async () => {
  const response = await api('/openapi.json');
  const spec = (await response.json()) as {
    security: unknown;
    components: { securitySchemes: Record<string, { name: string }> };
  };
  expect(spec.security).toEqual([
    { AccessClientId: [], AccessClientSecret: [] },
    { AccessSession: [] },
  ]);
  expect(spec.components.securitySchemes.AccessClientId?.name).toBe('CF-Access-Client-Id');
  expect(spec.components.securitySchemes.AccessClientSecret?.name).toBe('CF-Access-Client-Secret');
  expect(spec.components.securitySchemes).not.toHaveProperty('AccessJWT');
});

it('indexes prefix location filtering', async () => {
  const plan = await env.DB.prepare('EXPLAIN QUERY PLAN SELECT * FROM prefixes WHERE location_id=?')
    .bind(crypto.randomUUID())
    .all();
  expect(JSON.stringify(plan.results)).toContain('prefixes_location_id');
});
