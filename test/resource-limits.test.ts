import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, create, get, network } from './helpers';
import { address, key, literal, prefix } from '../src/ipam/address';
import type { Row } from '../src/db/types';
import { deviceDetail, vmDetail, prefixDetail } from '../src/db/details';
import { allocate } from '../src/ipam/allocate';

const now = '2026-01-01T00:00:00.000Z';
function observeResults() {
  const rowCounts: number[][] = [];
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          rowCounts.push(results.map((result) => result.results.length));
          return results;
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, rowCounts };
}
async function seed(statements: D1PreparedStatement[]) {
  for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
}
async function seedIPs(parent: Row, count: number, start: bigint, interfaceId?: string) {
  const p = prefix(String(parent.cidr));
  await seed(
    Array.from({ length: count }, (_, i) => {
      const a = address(literal(start + BigInt(i), p.family));
      return env.DB.prepare(
        'INSERT INTO ip_addresses (id,prefix_id,interface_id,address,status,created_at,updated_at,family,address_key) VALUES (?,?,?,?,?,?,?,?,?)',
      ).bind(
        crypto.randomUUID(),
        parent.id,
        interfaceId ?? null,
        a.address,
        'reserved',
        now,
        now,
        a.family,
        a.key,
      );
    }),
  );
}
async function seedChildren(parent: Row, count: number, start: bigint) {
  const p = prefix(String(parent.cidr));
  await seed(
    Array.from({ length: count }, (_, i) => {
      const value = start + BigInt(i);
      const length = p.family === 4 ? 32 : 128;
      return env.DB.prepare(
        'INSERT INTO prefixes (id,location_id,cidr,created_at,updated_at,family,prefix_length,range_start,range_end) VALUES (?,?,?,?,?,?,?,?,?)',
      ).bind(
        crypto.randomUUID(),
        parent.location_id,
        literal(value, p.family) + '/' + length,
        now,
        now,
        p.family,
        length,
        key(value),
        key(value),
      );
    }),
  );
}

describe('bounded related records', () => {
  it('pages every Device, VM and Prefix collection without losing related records', async () => {
    const p = await network('10.210.0.0/16');
    const device = await create('devices', {
      location_id: p.location_id,
      name: 'Paged host',
      role: 'server',
    });
    const vm = await create('virtual-machines', { name: 'Paged guest', host_device_id: device.id });
    for (const [owner, column] of [
      [device, 'device_id'],
      [vm, 'virtual_machine_id'],
    ] as const) {
      const ids = Array.from({ length: 202 }, () => crypto.randomUUID());
      await seed(
        ids.map((id, i) =>
          env.DB.prepare(
            `INSERT INTO interfaces (id,${column},name,created_at,updated_at) VALUES (?,?,?,?,?)`,
          ).bind(id, owner.id, 'nic-' + String(i).padStart(3, '0'), now, now),
        ),
      );
      await seedIPs(
        p,
        202,
        prefix(String(p.cidr)).start + (column === 'device_id' ? 1n : 1000n),
        ids[0],
      );
    }
    await seed(
      Array.from({ length: 201 }, () =>
        env.DB.prepare(
          'INSERT INTO virtual_machines (id,host_device_id,name,created_at,updated_at) VALUES (?,?,?,?,?)',
        ).bind(crypto.randomUUID(), device.id, 'Same guest name', now, now),
      ),
    );
    await seedChildren(p, 202, prefix(String(p.cidr)).start + 2000n);
    for (const [path, related] of [
      ['devices/' + device.id, ['interfaces', 'ip_addresses', 'virtual_machines']],
      ['virtual-machines/' + vm.id, ['interfaces', 'ip_addresses']],
      ['prefixes/' + p.id, ['ip_addresses', 'more_specific_prefixes']],
    ] as const) {
      const first = await get(path);
      for (const field of related) expect(first[field]).toHaveLength(50);
      expect(first.related_page).toMatchObject({
        limit: 50,
        offset: 0,
        has_more: Object.fromEntries(related.map((field) => [field, true])),
      });
      const seen = Object.fromEntries(related.map((field) => [field, new Set<string>()]));
      for (let offset = 0; offset < 600; offset += 200) {
        const page = (await get(
          path + '?related_limit=200&related_offset=' + offset,
        )) as unknown as Record<string, unknown>;
        for (const field of related) {
          const rows = page[field] as Row[];
          expect(rows.length).toBeLessThanOrEqual(200);
          for (const row of rows) {
            expect(seen[field]!.has(row.id)).toBe(false);
            seen[field]!.add(row.id);
          }
          expect((page.related_page as { has_more: Record<string, boolean> }).has_more[field]).toBe(
            offset + rows.length <
              (path.startsWith('prefixes') && field === 'ip_addresses' ? 404 : 202),
          );
        }
      }
      for (const field of related)
        expect(seen[field]!.size).toBe(
          path.startsWith('prefixes') && field === 'ip_addresses' ? 404 : 202,
        );
      for (const query of [
        'related_limit=201',
        'related_limit=0',
        'related_offset=-1',
        'related_offset=1000001',
      ])
        expect((await api(path + '?' + query)).status).toBe(400);
    }
    const { db, rowCounts } = observeResults();
    for (const [detail, id] of [
      [deviceDetail, device.id],
      [vmDetail, vm.id],
      [prefixDetail, p.id],
    ] as const) {
      await detail(db, id, { related_limit: 200 });
      await expect(detail(db, id, { related_limit: 201 })).rejects.toThrow();
    }
    expect(rowCounts).toEqual([
      [201, 201, 201],
      [201, 201],
      [201, 201],
    ]);
  });
});

describe('bounded allocation exclusions', () => {
  it.each([
    ['ips', '::ffff:10.211.0.0/112'],
    ['children', '10.212.0.0/16'],
    ['ips', '2001:db8:211::/64'],
    ['children', '2001:db8:212::/64'],
  ])(
    'refuses an uncertain candidate beyond the %s budget in %s without writing or auditing',
    async (kind, cidr) => {
      const p = await network(cidr!);
      const range = prefix(String(p.cidr));
      const start = range.start + (range.family === 4 ? 1n : 0n);
      if (kind === 'ips') await seedIPs(p, 1001, start);
      else await seedChildren(p, 1001, start);
      const before = await get('audit-log?limit=1');
      const response = await api('prefixes/' + p.id + '/allocate', 'POST', {});
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'conflict',
        message: expect.stringMatching(/work limit/),
      });
      expect((await get('audit-log?limit=1')).total).toBe(before.total);
      const count = await env.DB.prepare(
        'SELECT count(*) AS total FROM ip_addresses WHERE prefix_id=?',
      )
        .bind(p.id)
        .first<{ total: number }>();
      expect(count?.total).toBe(kind === 'ips' ? 1001 : 0);
    },
  );
  it.each(['0.0.0.0/0', '::/0'])(
    'allows an early proven gap in a large sparse %s inventory',
    async (cidr) => {
      const p = await network(cidr);
      const start = prefix(String(p.cidr)).family === 4 ? 10000n : 1n << 64n;
      await seedIPs(p, 1200, start);
      await seedChildren(p, 1200, start + 10000n);
      const { db, rowCounts } = observeResults();
      const allocated = await allocate(db, 'access:test', p.id, {});
      expect(allocated.address).toBe(cidr === '::/0' ? '::' : '0.0.0.1');
      expect(rowCounts[0]).toEqual([1001, 1001]);
    },
  );
  it.each(['ips', 'children'])('allocates the next gap at exactly the %s budget', async (kind) => {
    const p = await network(kind === 'ips' ? '10.213.0.0/16' : '10.214.0.0/16');
    const start = prefix(String(p.cidr)).start;
    if (kind === 'ips') await seedIPs(p, 1000, start + 1n);
    else await seedChildren(p, 1000, start + 1n);
    expect((await create('prefixes/' + p.id + '/allocate', {})).address).toBe(
      literal(start + 1001n, 4),
    );
  });
});
