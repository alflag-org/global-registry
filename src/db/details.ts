import { entities, findEntity, getEntity } from './queries';
import type { Row } from './types';
const columns = (entity: keyof typeof entities) => entities[entity].columns.join(',');
export async function deviceDetail(db: D1Database, id: string) {
  const device = await getEntity(entities.devices, db, id);
  const [interfaces, ips, vms] = await db.batch([
    db
      .prepare(`SELECT ${columns('interfaces')} FROM interfaces WHERE device_id=? ORDER BY name`)
      .bind(id),
    db
      .prepare(
        `SELECT ${columns('ip_addresses')} FROM ip_addresses WHERE interface_id IN (SELECT id FROM interfaces WHERE device_id=?) ORDER BY family,address_key`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT ${columns('virtual_machines')} FROM virtual_machines WHERE host_device_id=? ORDER BY name`,
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
  const vm = await getEntity(entities.virtual_machines, db, id);
  // The host may be deleted between reads; a missing host reads as detached rather than 404.
  const host = vm.host_device_id
    ? await findEntity(entities.devices, db, String(vm.host_device_id))
    : null;
  const [interfaces, ips] = await db.batch([
    db
      .prepare(
        `SELECT ${columns('interfaces')} FROM interfaces WHERE virtual_machine_id=? ORDER BY name`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT ${columns('ip_addresses')} FROM ip_addresses WHERE interface_id IN (SELECT id FROM interfaces WHERE virtual_machine_id=?) ORDER BY family,address_key`,
      )
      .bind(id),
  ]);
  return {
    ...vm,
    host_device: host,
    location: host ? await getEntity(entities.locations, db, String(host.location_id)) : null,
    interfaces: interfaces!.results,
    ip_addresses: ips!.results,
  };
}
export async function prefixDetail(db: D1Database, id: string) {
  const p = await getEntity(entities.prefixes, db, id);
  const [ips, children] = await db.batch([
    db
      .prepare(
        `SELECT ${columns('ip_addresses')} FROM ip_addresses WHERE prefix_id=? ORDER BY family,address_key`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT ${columns('prefixes')} FROM prefixes WHERE family=(SELECT family FROM prefixes WHERE id=?) AND range_start >= (SELECT range_start FROM prefixes WHERE id=?) AND range_end <= (SELECT range_end FROM prefixes WHERE id=?) AND prefix_length > (SELECT prefix_length FROM prefixes WHERE id=?) ORDER BY range_start,prefix_length`,
      )
      .bind(id, id, id, id),
  ]);
  return {
    ...p,
    location: await getEntity(entities.locations, db, String(p.location_id)),
    vlan: p.vlan_id ? await getEntity(entities.vlans, db, String(p.vlan_id)) : null,
    ip_addresses: ips!.results as Row[],
    more_specific_prefixes: children!.results as Row[],
  };
}
