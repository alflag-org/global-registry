import * as q from './queries';
import type { Row } from './types';
export async function deviceDetail(db: D1Database, id: string) {
  const device = await q.getDevice(db, id);
  const [interfaces, ips, vms] = await db.batch([
    db
      .prepare(
        `SELECT ${q.interfaceColumns.join(',')} FROM interfaces WHERE device_id=? ORDER BY name`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT ${q.ipColumns.join(',')} FROM ip_addresses WHERE interface_id IN (SELECT id FROM interfaces WHERE device_id=?) ORDER BY family,address_key`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT ${q.vmColumns.join(',')} FROM virtual_machines WHERE host_device_id=? ORDER BY name`,
      )
      .bind(id),
  ]);
  return {
    ...device,
    interfaces: interfaces!.results,
    ip_addresses: ips!.results,
    virtual_machines: vms!.results,
  };
}
export async function vmDetail(db: D1Database, id: string) {
  const vm = await q.getVM(db, id);
  const host = vm.host_device_id ? await q.getDevice(db, String(vm.host_device_id)) : null;
  const [interfaces, ips] = await db.batch([
    db
      .prepare(
        `SELECT ${q.interfaceColumns.join(',')} FROM interfaces WHERE virtual_machine_id=? ORDER BY name`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT ${q.ipColumns.join(',')} FROM ip_addresses WHERE interface_id IN (SELECT id FROM interfaces WHERE virtual_machine_id=?) ORDER BY family,address_key`,
      )
      .bind(id),
  ]);
  return {
    ...vm,
    host_device: host,
    location: host ? await q.getLocation(db, String(host.location_id)) : null,
    interfaces: interfaces!.results,
    ip_addresses: ips!.results,
  };
}
export async function prefixDetail(db: D1Database, id: string) {
  const p = await q.getPrefix(db, id);
  const [ips, children] = await db.batch([
    db
      .prepare(
        `SELECT ${q.ipColumns.join(',')} FROM ip_addresses WHERE prefix_id=? ORDER BY family,address_key`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT ${q.prefixColumns.join(',')} FROM prefixes WHERE family=(SELECT family FROM prefixes WHERE id=?) AND range_start >= (SELECT range_start FROM prefixes WHERE id=?) AND range_end <= (SELECT range_end FROM prefixes WHERE id=?) AND prefix_length > (SELECT prefix_length FROM prefixes WHERE id=?) ORDER BY range_start,prefix_length`,
      )
      .bind(id, id, id, id),
  ]);
  return {
    ...p,
    location: await q.getLocation(db, String(p.location_id)),
    vlan: p.vlan_id ? await q.getVLAN(db, String(p.vlan_id)) : null,
    ip_addresses: ips!.results as Row[],
    more_specific_prefixes: children!.results as Row[],
  };
}
