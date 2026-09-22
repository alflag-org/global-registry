import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { api, create, location, network, get } from './helpers';
import type { Row } from '../src/db/types';
const actions = async (id: string) =>
  ((await (await api('audit-log?entity_id=' + id)).json()) as { items: Row[] }).items;
describe('inventory and audit', () => {
  it('supports Device and VM CRUD, placement changes and derived location', async () => {
    const a = await location(),
      b = await location();
    const host = await create('devices', { location_id: a.id, name: 'host-a', role: 'server' });
    const second = await create('devices', { location_id: b.id, name: 'host-b', role: 'server' });
    const vm = await create('virtual-machines', {
      name: 'guest',
      host_device_id: host.id,
      vcpu: 2,
      memory_mb: 2048,
    });
    const nic = await create('interfaces', {
      virtual_machine_id: vm.id,
      name: 'net0',
      mac_address: 'AA:BB:CC:DD:EE:FF',
    });
    expect(nic.mac_address).toBe('aa:bb:cc:dd:ee:ff');
    expect((await get('devices/' + host.id)).virtual_machines).toHaveLength(1);
    const update = await api('virtual-machines/' + vm.id, 'PATCH', { host_device_id: second.id });
    expect(update.status).toBe(200);
    const detail = await get('virtual-machines/' + vm.id);
    expect(detail.id).toBe(vm.id);
    expect(detail.location).toMatchObject({ id: b.id });
    expect(detail.interfaces).toHaveLength(1);
    expect((await api('devices/' + host.id, 'PATCH', { name: 'renamed' })).status).toBe(200);
    expect((await api('interfaces/' + nic.id, 'PATCH', { name: 'eth0' })).status).toBe(200);
    expect((await api('virtual-machines/' + vm.id, 'DELETE')).status).toBe(204);
    expect((await api('interfaces/' + nic.id)).status).toBe(404);
    expect((await api('devices/' + host.id, 'DELETE')).status).toBe(204);
    const records = await actions(vm.id);
    expect(new Set(records.map((r) => r.action))).toEqual(new Set(['create', 'update', 'delete']));
    const mutation = records.find((r) => r.action === 'update')!;
    expect(JSON.parse(String(mutation.before_json)).host_device_id).toBe(host.id);
    expect(JSON.parse(String(mutation.after_json)).host_device_id).toBe(second.id);
    expect(records.every((r) => r.actor === 'access:local-developer')).toBe(true);
  });
  it('rejects incomplete or duplicate source identities and permits distinct scopes', async () => {
    const l = await location();
    const data = {
      name: 'pve',
      role: 'server',
      location_id: l.id,
      source: 'proxmox',
      source_scope: 'scope-a',
      source_id: 'node1',
    };
    await create('devices', data);
    expect((await api('devices', 'POST', data)).status).toBe(409);
    expect((await api('devices', 'POST', { ...data, source_scope: null })).status).toBe(400);
    await create('devices', { ...data, source_scope: 'scope-b' });
    const vm = await create('virtual-machines', {
      name: 'guest',
      source: 'proxmox',
      source_scope: 'a',
      source_id: '123',
    });
    expect(
      (
        await api('virtual-machines', 'POST', {
          name: 'duplicate',
          source: 'proxmox',
          source_scope: 'a',
          source_id: '123',
        })
      ).status,
    ).toBe(409);
    expect((await api('virtual-machines/' + vm.id, 'PATCH', { source: null })).status).toBe(400);
    expect(
      (
        await api('virtual-machines/' + vm.id, 'PATCH', {
          source: null,
          source_scope: null,
          source_id: null,
        })
      ).status,
    ).toBe(200);
  });
  it('enforces Interface XOR and owner-local names', async () => {
    const l = await location(),
      vm = await create('virtual-machines', { name: 'guest' });
    const d = await create('devices', { name: 'host', role: 'server', location_id: l.id });
    expect((await api('interfaces', 'POST', { name: 'eno0' })).status).toBe(400);
    expect(
      (
        await api('interfaces', 'POST', {
          name: 'eno0',
          device_id: d.id,
          virtual_machine_id: vm.id,
        })
      ).status,
    ).toBe(400);
    const nic = await create('interfaces', { name: 'eno0', device_id: d.id });
    expect((await api('interfaces', 'POST', { name: 'eno0', device_id: d.id })).status).toBe(409);
    await create('interfaces', { name: 'eno0', virtual_machine_id: vm.id });
    expect((await api('interfaces/' + nic.id, 'PATCH', { virtual_machine_id: vm.id })).status).toBe(
      400,
    );
    expect(
      (
        await api('interfaces/' + nic.id, 'PATCH', {
          device_id: null,
          virtual_machine_id: vm.id,
          name: 'net1',
        })
      ).status,
    ).toBe(200);
  });
  it('deletes Device interfaces, detaches VMs and preserves their own interfaces and all IPs', async () => {
    const p = await network('10.100.0.0/24');
    const d = await create('devices', { name: 'host', role: 'server', location_id: p.location_id });
    const vm = await create('virtual-machines', { name: 'guest', host_device_id: d.id });
    const vnic = await create('interfaces', { name: 'net0', virtual_machine_id: vm.id });
    const nic = await create('interfaces', { name: 'eno0', device_id: d.id });
    const nic2 = await create('interfaces', { name: 'eno1', device_id: d.id });
    const ip = await create('ip-addresses', {
      prefix_id: p.id,
      interface_id: nic.id,
      address: '10.100.0.1',
      status: 'assigned',
    });
    const ip2 = await create('ip-addresses', {
      prefix_id: p.id,
      interface_id: nic2.id,
      address: '10.100.0.2',
      status: 'assigned',
    });
    expect((await api('devices/' + d.id, 'DELETE')).status).toBe(204);
    expect((await get('virtual-machines/' + vm.id)).host_device_id).toBeNull();
    expect((await api('interfaces/' + vnic.id)).status).toBe(200);
    expect((await api('interfaces/' + nic.id)).status).toBe(404);
    expect((await get('ip-addresses/' + ip.id)).interface_id).toBeNull();
    expect((await get('ip-addresses/' + ip2.id)).interface_id).toBeNull();
    expect((await actions(nic.id)).some((r) => r.action === 'delete')).toBe(true);
    const log = (await actions(ip.id)).find((r) => r.action === 'update')!;
    expect(JSON.parse(String(log.before_json)).interface_id).toBe(nic.id);
    expect(JSON.parse(String(log.after_json))).toEqual(await get('ip-addresses/' + ip.id));
    expect((await actions(vm.id)).some((r) => r.action === 'update')).toBe(true);
  });
  it.each(['interfaces', 'virtual-machines'])('retains IPs when deleting %s', async (target) => {
    const p = await network(target === 'interfaces' ? '10.101.0.0/24' : '10.102.0.0/24');
    const vm = await create('virtual-machines', { name: 'guest' });
    const nic = await create('interfaces', { name: 'net0', virtual_machine_id: vm.id });
    const ip = await create('prefixes/' + p.id + '/allocate', { interface_id: nic.id });
    expect(
      (await api(target + '/' + (target === 'interfaces' ? nic.id : vm.id), 'DELETE')).status,
    ).toBe(204);
    expect((await get('ip-addresses/' + ip.id)).interface_id).toBeNull();
    expect((await api('ip-addresses/' + ip.id, 'DELETE')).status).toBe(204);
    expect((await actions(ip.id)).map((r) => r.action)).toEqual(
      expect.arrayContaining(['allocate', 'update', 'release']),
    );
  });
  it('restricts Location/VLAN/Prefix deletion and logs no successful failed mutation', async () => {
    const l = await location();
    const v = await create('vlans', { location_id: l.id, vid: 200, name: 'LAN' });
    const p = await create('prefixes', { location_id: l.id, vlan_id: v.id, cidr: '10.103.0.0/24' });
    const ip = await create('prefixes/' + p.id + '/allocate', {});
    for (const [path, row] of [
      ['locations', l],
      ['vlans', v],
      ['prefixes', p],
    ] as const) {
      expect((await api(path + '/' + row.id, 'DELETE')).status).toBe(409);
      expect((await actions(row.id)).map((r) => r.action)).toEqual(['create']);
    }
    await api('ip-addresses/' + ip.id, 'DELETE');
    for (const [path, row] of [
      ['prefixes', p],
      ['vlans', v],
      ['locations', l],
    ] as const)
      expect((await api(path + '/' + row.id, 'DELETE')).status).toBe(204);
  });
  it('rolls back data if audit insertion fails', async () => {
    const slug = 'rollback-' + crypto.randomUUID();
    await env.DB.exec(
      "CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;",
    );
    try {
      expect((await api('locations', 'POST', { name: 'rollback', slug })).status).toBe(500);
      expect(
        await env.DB.prepare('SELECT id FROM locations WHERE slug=?').bind(slug).first(),
      ).toBeNull();
    } finally {
      await env.DB.exec('DROP TRIGGER reject_test_audit;');
    }
  });
});

it('rejects stale concurrent updates without orphan audit records', async () => {
  const row = await location();
  const responses = await Promise.all([
    api('locations/' + row.id, 'PATCH', { name: 'Concurrent A' }),
    api('locations/' + row.id, 'PATCH', { name: 'Concurrent B' }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const logs = await actions(row.id);
  expect(logs.filter((r) => r.action === 'update')).toHaveLength(1);
  const committed = logs.find((r) => r.action === 'update')!;
  expect(JSON.parse(String(committed.after_json))).toEqual(await get('locations/' + row.id));
});

it('accepts descriptive hardware roles without a role registry', async () => {
  const l = await location();
  const device = await create('devices', { name: 'Firewall', role: 'firewall', location_id: l.id });
  expect(device.role).toBe('firewall');
  expect((await api('devices/' + device.id, 'PATCH', { role: '  ' })).status).toBe(400);
});
