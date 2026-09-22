import { env } from 'cloudflare:workers';
import { it, expect } from 'vitest';
import { create, location, network } from './helpers';
it('enforces foreign keys and source completeness in raw SQL', async () => {
  const l = await location();
  const d = await create('devices', { location_id: l.id, name: 'host', role: 'server' });
  await expect(
    env.DB.prepare('UPDATE devices SET location_id=? WHERE id=?')
      .bind(crypto.randomUUID(), d.id)
      .run(),
  ).rejects.toThrow(/FOREIGN KEY/);
  await expect(
    env.DB.prepare("UPDATE devices SET source='pve' WHERE id=?").bind(d.id).run(),
  ).rejects.toThrow(/CHECK/);
  await expect(env.DB.prepare('DELETE FROM locations WHERE id=?').bind(l.id).run()).rejects.toThrow(
    /FOREIGN KEY/,
  );
});
it('enforces XOR, uniqueness and direct FK deletion semantics', async () => {
  const l = await location(),
    p = await network('10.110.0.0/24');
  const d = await create('devices', { location_id: l.id, name: 'host', role: 'server' });
  const vm = await create('virtual-machines', { name: 'guest', host_device_id: d.id });
  const nic = await create('interfaces', { name: 'eth0', device_id: d.id });
  const ip = await create('prefixes/' + p.id + '/allocate', { interface_id: nic.id });
  await expect(
    env.DB.prepare('UPDATE interfaces SET device_id=NULL WHERE id=?').bind(nic.id).run(),
  ).rejects.toThrow(/CHECK/);
  await expect(
    env.DB.prepare('UPDATE interfaces SET virtual_machine_id=? WHERE id=?')
      .bind(vm.id, nic.id)
      .run(),
  ).rejects.toThrow(/CHECK/);
  await env.DB.prepare('DELETE FROM devices WHERE id=?').bind(d.id).run();
  expect(
    (await env.DB.prepare('SELECT host_device_id FROM virtual_machines WHERE id=?')
      .bind(vm.id)
      .first())!.host_device_id,
  ).toBeNull();
  expect(
    await env.DB.prepare('SELECT id FROM interfaces WHERE id=?').bind(nic.id).first(),
  ).toBeNull();
  expect(
    (await env.DB.prepare('SELECT interface_id FROM ip_addresses WHERE id=?').bind(ip.id).first())!
      .interface_id,
  ).toBeNull();
});
it('enforces VLAN uniqueness and relational range guards in raw SQL', async () => {
  const p = await network('10.111.0.0/24');
  await create('prefixes/' + p.id + '/allocate', {});
  await expect(
    env.DB.prepare(
      "UPDATE ip_addresses SET address_key='ffffffffffffffffffffffffffffffff' WHERE prefix_id=?",
    )
      .bind(p.id)
      .run(),
  ).rejects.toThrow(/relationship/);
  await expect(
    env.DB.prepare("UPDATE prefixes SET range_end='00000000000000000000000000000000' WHERE id=?")
      .bind(p.id)
      .run(),
  ).rejects.toThrow(/relationship/);
  const v = await create('vlans', { location_id: p.location_id, vid: 7, name: 'LAN' });
  await create('vlans', { location_id: p.location_id, vid: 8, name: 'other' });
  await expect(
    env.DB.prepare('UPDATE vlans SET vid=8 WHERE id=?').bind(v.id).run(),
  ).rejects.toThrow(/UNIQUE/);
});
it('makes audit append-only at the database boundary', async () => {
  await location();
  await expect(env.DB.exec("UPDATE audit_log SET actor='changed'")).rejects.toThrow(/append-only/);
  await expect(env.DB.exec('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
});
it('initial migration contains only the inventory tables and D1 migration metadata', async () => {
  const result = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name!='d1_migrations'",
  ).all<{ name: string }>();
  expect(result.results.map((r) => r.name).sort()).toEqual([
    'audit_log',
    'devices',
    'interfaces',
    'ip_addresses',
    'locations',
    'prefixes',
    'virtual_machines',
    'vlans',
  ]);
  expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
