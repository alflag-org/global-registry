import { describe, it, expect } from 'vitest';
import { address, prefix, contains, firstAvailable } from '../src/ipam/address';
import { api, create, network, location, get } from './helpers';
import type { Row } from '../src/db/types';
describe('IP literals and ranges', () => {
  it('normalizes IPv4 and IPv6 networks', () => {
    expect(prefix('10.10.10.5/24').cidr).toBe('10.10.10.0/24');
    expect(prefix('2001:0DB8:0000:0000::AbCd/64').cidr).toBe('2001:db8::/64');
    expect(address('2001:0db8::0010').address).toBe('2001:db8::10');
  });
  it.each([
    '999.1.1.1',
    '10.1',
    '010.0.0.1',
    '0x7f000001',
    '1.2.3.4/24',
    'fe80::1%eth0',
    '2001:::1',
  ])('rejects invalid/ambiguous literal %s', (value) => expect(() => address(value)).toThrow());
  it.each(['10.0.0.1/33', '2001:db8::/129', '10.0.0.1', '10.1/16'])(
    'rejects invalid CIDR %s',
    (value) => expect(() => prefix(value)).toThrow(),
  );
  it('checks membership and family', () => {
    expect(contains(prefix('10.0.0.0/24'), address('10.0.0.255'))).toBe(true);
    expect(contains(prefix('10.0.0.0/24'), address('10.0.1.1'))).toBe(false);
    expect(contains(prefix('::/0'), address('0.0.0.1'))).toBe(false);
  });
  it('unifies IPv4-mapped IPv6 identities', () => {
    expect(address('::ffff:192.0.2.1').address).toBe('192.0.2.1');
    expect(prefix('::ffff:192.0.2.1/120').cidr).toBe('192.0.2.0/24');
  });
  it('jumps over enormous IPv6 intervals', () => {
    const p = prefix('2001:db8::/64');
    const child = prefix('2001:db8::/65');
    expect(firstAvailable(p, [{ start: child.start, end: child.end }])).toBe('2001:db8:0:0:8000::');
  });
});
describe('allocation on D1', () => {
  it.each([
    ['192.0.2.0/30', ['192.0.2.1', '192.0.2.2']],
    ['192.0.2.8/31', ['192.0.2.8', '192.0.2.9']],
    ['192.0.2.12/32', ['192.0.2.12']],
    ['2001:db8:1::/127', ['2001:db8:1::', '2001:db8:1::1']],
  ])('allocates %s and reports exhaustion', async (cidr, expected) => {
    const p = await network(cidr as string);
    for (const address of expected) {
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
