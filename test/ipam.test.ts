import { describe, it, expect } from 'vitest';
import { api, create, network, location, get } from './helpers';
import type { Row } from '../src/db/types';
describe('allocation on D1', () => {
  it('persists assigned addresses and reports exhaustion as a conflict', async () => {
    const p = await network('192.0.2.0/30');
    for (const address of ['192.0.2.1', '192.0.2.2']) {
      const row = await create('prefixes/' + p.id + '/allocate', {});
      expect(row.address).toBe(address);
      expect(row.status).toBe('assigned');
    }
    expect((await api('prefixes/' + p.id + '/allocate', 'POST', {})).status).toBe(409);
  });
  it('excludes reserved IPs and more-specific prefixes without expanding free rows', async () => {
    const p = await network('198.51.100.0/24');
    await create('ip-addresses', { prefix_id: p.id, address: '198.51.100.1', status: 'reserved' });
    await create('prefixes', { location_id: p.location_id, cidr: '198.51.100.0/26' });
    const result = await create('prefixes/' + p.id + '/allocate', {});
    expect(result.address).toBe('198.51.100.64');
    const detail = await get('prefixes/' + p.id);
    expect(detail.ip_addresses).toHaveLength(2);
    expect(detail.more_specific_prefixes).toHaveLength(1);
  });
  it('excludes addresses registered under overlapping parents', async () => {
    const p = await network('203.0.113.0/24');
    const child = await create('prefixes', { location_id: p.location_id, cidr: '203.0.113.0/30' });
    await create('ip-addresses', { prefix_id: p.id, address: '203.0.113.1', status: 'reserved' });
    expect((await create('prefixes/' + child.id + '/allocate', {})).address).toBe('203.0.113.2');
  });
  it('rejects duplicates, out-of-prefix addresses and shrinking a populated prefix', async () => {
    const p = await network('10.80.0.0/24');
    const data = { prefix_id: p.id, address: '10.80.0.200', status: 'assigned' };
    await create('ip-addresses', data);
    expect((await api('ip-addresses', 'POST', data)).status).toBe(409);
    expect((await api('ip-addresses', 'POST', { ...data, address: '10.81.0.1' })).status).toBe(400);
    expect((await api('prefixes/' + p.id, 'PATCH', { cidr: '10.80.0.0/25' })).status).toBe(400);
    expect(
      (await api('prefixes', 'POST', { location_id: p.location_id, cidr: '10.80.0.55/24' })).status,
    ).toBe(409);
  });
  it('keeps concurrent allocations unique, with no false success audit', async () => {
    const p = await network('10.81.0.0/28');
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => api('prefixes/' + p.id + '/allocate', 'POST', {})),
    );
    expect(responses.every((r) => r.status === 201)).toBe(true);
    const rows = await Promise.all(responses.map((r) => r.json() as Promise<Row>));
    expect(new Set(rows.map((r) => r.address)).size).toBe(4);
    expect(rows.map((r) => r.address).sort()).toEqual([
      '10.81.0.1',
      '10.81.0.2',
      '10.81.0.3',
      '10.81.0.4',
    ]);
    for (const row of rows) {
      const response = await api('audit-log?entity_id=' + row.id);
      expect(((await response.json()) as { total: number }).total).toBe(1);
    }
  });
  it('enforces VLAN location consistency in both directions', async () => {
    const a = await location(),
      b = await location();
    const v = await create('vlans', { location_id: a.id, vid: 10, name: 'LAN' });
    expect(
      (await api('prefixes', 'POST', { location_id: b.id, vlan_id: v.id, cidr: '10.90.0.0/24' }))
        .status,
    ).toBe(409);
    const p = await create('prefixes', { location_id: a.id, vlan_id: v.id, cidr: '10.90.0.0/24' });
    expect((await api('vlans/' + v.id, 'PATCH', { location_id: b.id })).status).toBe(409);
    expect((await api('prefixes/' + p.id, 'PATCH', { location_id: b.id })).status).toBe(409);
  });
});

it('retries only address uniqueness collisions and stops after five attempts', async () => {
  const { env } = await import('cloudflare:workers');
  const { allocate } = await import('../src/ipam/allocate');
  const p = await network('10.120.0.0/24');
  let writes = 0;
  let failure = 'UNIQUE constraint failed: ip_addresses.address';
  const statements = new WeakMap<D1PreparedStatement, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    statements.set(wrapped, sql);
    return wrapped;
  };
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === 'batch')
        return async (batch: D1PreparedStatement[]) => {
          if (
            batch.some((statement) =>
              statements.get(statement)?.includes('INSERT INTO ip_addresses'),
            )
          ) {
            writes++;
            throw new Error(failure);
          }
          return target.batch(batch);
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(allocate(db, 'access:test', p.id, {})).rejects.toThrow(/retry limit/);
  expect(writes).toBe(5);
  failure = 'FOREIGN KEY constraint failed';
  writes = 0;
  await expect(allocate(db, 'access:test', p.id, {})).rejects.toThrow(/relationship/);
  expect(writes).toBe(1);
  expect((await get('prefixes/' + p.id)).ip_addresses).toHaveLength(0);
});
