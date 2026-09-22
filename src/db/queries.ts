import type { z } from '@hono/zod-openapi';
import * as s from '../api/schemas';
import { invalid } from '../api/errors';
import { reference, prefixLocation } from './relationships';
import { address, prefix, contains } from '../ipam/address';
import { auditStatement, snapshot, batch, required, unchanged, assertChanged } from './mutations';
import { list } from './lists';
import { deleteInventory } from './deletion';
import type { Row, Patch } from './types';
export const locationColumns = [
  'id',
  'name',
  'slug',
  'description',
  'created_at',
  'updated_at',
] as const;
export function listLocation(db: D1Database, query: s.Query) {
  return list(
    db,
    'locations',
    locationColumns.join(','),
    query,
    ['name', 'slug', 'description'],
    {},
  );
}
export function getLocation(db: D1Database, id: string) {
  return required(db, `SELECT ${locationColumns.join(',')} FROM locations WHERE id=?`, id);
}
export async function createLocation(
  db: D1Database,
  actor: string,
  input: z.infer<typeof s.locationInput>,
) {
  const parsed = s.locationInput.parse(input);
  const now = new Date().toISOString();
  const row: Row = {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    name: parsed.name ?? null,
    slug: parsed.slug ?? null,
    description: parsed.description ?? null,
  };
  const results = await batch(db, [
    db
      .prepare(
        'INSERT INTO locations (id,name,slug,description,created_at,updated_at) VALUES (?,?,?,?,?,?) RETURNING id,name,slug,description,created_at,updated_at',
      )
      .bind(row.id, row.name, row.slug, row.description, row.created_at, row.updated_at),
    auditStatement(
      db,
      actor,
      'create',
      'locations',
      locationColumns,
      'id=?',
      [row.id],
      snapshot(locationColumns),
    ),
  ]);
  return results[0]!.results[0] as Row;
}
export async function updateLocation(
  db: D1Database,
  actor: string,
  id: string,
  input: z.infer<typeof s.locationInput> | Patch<z.infer<typeof s.locationInput>>,
) {
  const before = await getLocation(db, id);
  const parsed = s.locationInput.parse({
    ...Object.fromEntries(['name', 'slug', 'description'].map((k) => [k, before[k]])),
    ...input,
  });
  const now = new Date().toISOString();
  const row: Row = {
    id,
    created_at: before.created_at!,
    updated_at: now,
    name: parsed.name ?? null,
    slug: parsed.slug ?? null,
    description: parsed.description ?? null,
  };
  const guard = unchanged(before, locationColumns);
  const results = await batch(db, [
    auditStatement(
      db,
      actor,
      'update',
      'locations',
      locationColumns,
      guard.sql,
      guard.values,
      '?',
      crypto.randomUUID(),
      [JSON.stringify(row)],
    ),
    db
      .prepare(
        `UPDATE locations SET name=?,slug=?,description=?,updated_at=? WHERE ${guard.sql} RETURNING id,name,slug,description,created_at,updated_at`,
      )
      .bind(row.name, row.slug, row.description, row.updated_at, ...guard.values),
  ]);
  assertChanged(results[1]!.meta.changes);
  return results[1]!.results[0] as Row;
}
export function deleteLocation(db: D1Database, actor: string, id: string) {
  return deleteInventory(db, actor, 'locations', locationColumns, id);
}
export const deviceColumns = [
  'id',
  'location_id',
  'name',
  'role',
  'manufacturer',
  'model',
  'serial_number',
  'source',
  'source_scope',
  'source_id',
  'description',
  'created_at',
  'updated_at',
] as const;
export function listDevice(db: D1Database, query: s.Query) {
  return list(
    db,
    'devices',
    deviceColumns.join(','),
    query,
    ['name', 'serial_number', 'description'],
    { location_id: 'location_id', source: 'source', source_scope: 'source_scope' },
  );
}
export function getDevice(db: D1Database, id: string) {
  return required(db, `SELECT ${deviceColumns.join(',')} FROM devices WHERE id=?`, id);
}
export async function createDevice(
  db: D1Database,
  actor: string,
  input: z.infer<typeof s.deviceInput>,
) {
  const parsed = s.deviceInput.superRefine(s.sourceIdentity).parse(input);
  const now = new Date().toISOString();
  const row: Row = {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    location_id: parsed.location_id ?? null,
    name: parsed.name ?? null,
    role: parsed.role ?? null,
    manufacturer: parsed.manufacturer ?? null,
    model: parsed.model ?? null,
    serial_number: parsed.serial_number ?? null,
    source: parsed.source ?? null,
    source_scope: parsed.source_scope ?? null,
    source_id: parsed.source_id ?? null,
    description: parsed.description ?? null,
  };
  await reference(db, 'locations', String(row.location_id));
  const results = await batch(db, [
    db
      .prepare(
        'INSERT INTO devices (id,location_id,name,role,manufacturer,model,serial_number,source,source_scope,source_id,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id,location_id,name,role,manufacturer,model,serial_number,source,source_scope,source_id,description,created_at,updated_at',
      )
      .bind(
        row.id,
        row.location_id,
        row.name,
        row.role,
        row.manufacturer,
        row.model,
        row.serial_number,
        row.source,
        row.source_scope,
        row.source_id,
        row.description,
        row.created_at,
        row.updated_at,
      ),
    auditStatement(
      db,
      actor,
      'create',
      'devices',
      deviceColumns,
      'id=?',
      [row.id],
      snapshot(deviceColumns),
    ),
  ]);
  return results[0]!.results[0] as Row;
}
export async function updateDevice(
  db: D1Database,
  actor: string,
  id: string,
  input: z.infer<typeof s.deviceInput> | Patch<z.infer<typeof s.deviceInput>>,
) {
  const before = await getDevice(db, id);
  const parsed = s.deviceInput.superRefine(s.sourceIdentity).parse({
    ...Object.fromEntries(
      [
        'location_id',
        'name',
        'role',
        'manufacturer',
        'model',
        'serial_number',
        'source',
        'source_scope',
        'source_id',
        'description',
      ].map((k) => [k, before[k]]),
    ),
    ...input,
  });
  const now = new Date().toISOString();
  const row: Row = {
    id,
    created_at: before.created_at!,
    updated_at: now,
    location_id: parsed.location_id ?? null,
    name: parsed.name ?? null,
    role: parsed.role ?? null,
    manufacturer: parsed.manufacturer ?? null,
    model: parsed.model ?? null,
    serial_number: parsed.serial_number ?? null,
    source: parsed.source ?? null,
    source_scope: parsed.source_scope ?? null,
    source_id: parsed.source_id ?? null,
    description: parsed.description ?? null,
  };
  await reference(db, 'locations', String(row.location_id));
  const guard = unchanged(before, deviceColumns);
  const results = await batch(db, [
    auditStatement(
      db,
      actor,
      'update',
      'devices',
      deviceColumns,
      guard.sql,
      guard.values,
      '?',
      crypto.randomUUID(),
      [JSON.stringify(row)],
    ),
    db
      .prepare(
        `UPDATE devices SET location_id=?,name=?,role=?,manufacturer=?,model=?,serial_number=?,source=?,source_scope=?,source_id=?,description=?,updated_at=? WHERE ${guard.sql} RETURNING id,location_id,name,role,manufacturer,model,serial_number,source,source_scope,source_id,description,created_at,updated_at`,
      )
      .bind(
        row.location_id,
        row.name,
        row.role,
        row.manufacturer,
        row.model,
        row.serial_number,
        row.source,
        row.source_scope,
        row.source_id,
        row.description,
        row.updated_at,
        ...guard.values,
      ),
  ]);
  assertChanged(results[1]!.meta.changes);
  return results[1]!.results[0] as Row;
}
export function deleteDevice(db: D1Database, actor: string, id: string) {
  return deleteInventory(db, actor, 'devices', deviceColumns, id);
}
export const vmColumns = [
  'id',
  'name',
  'host_device_id',
  'vcpu',
  'memory_mb',
  'disk_mb',
  'source',
  'source_scope',
  'source_id',
  'description',
  'created_at',
  'updated_at',
] as const;
export function listVM(db: D1Database, query: s.Query) {
  return list(db, 'virtual_machines', vmColumns.join(','), query, ['name', 'description'], {
    host_device_id: 'host_device_id',
    source: 'source',
    source_scope: 'source_scope',
    location_id:
      '(SELECT location_id FROM devices WHERE devices.id=virtual_machines.host_device_id)',
  });
}
export function getVM(db: D1Database, id: string) {
  return required(db, `SELECT ${vmColumns.join(',')} FROM virtual_machines WHERE id=?`, id);
}
export async function createVM(db: D1Database, actor: string, input: z.infer<typeof s.vmInput>) {
  const parsed = s.vmInput.superRefine(s.sourceIdentity).parse(input);
  const now = new Date().toISOString();
  const row: Row = {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    name: parsed.name ?? null,
    host_device_id: parsed.host_device_id ?? null,
    vcpu: parsed.vcpu ?? null,
    memory_mb: parsed.memory_mb ?? null,
    disk_mb: parsed.disk_mb ?? null,
    source: parsed.source ?? null,
    source_scope: parsed.source_scope ?? null,
    source_id: parsed.source_id ?? null,
    description: parsed.description ?? null,
  };
  if (row.host_device_id) await reference(db, 'devices', String(row.host_device_id));
  const results = await batch(db, [
    db
      .prepare(
        'INSERT INTO virtual_machines (id,name,host_device_id,vcpu,memory_mb,disk_mb,source,source_scope,source_id,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id,name,host_device_id,vcpu,memory_mb,disk_mb,source,source_scope,source_id,description,created_at,updated_at',
      )
      .bind(
        row.id,
        row.name,
        row.host_device_id,
        row.vcpu,
        row.memory_mb,
        row.disk_mb,
        row.source,
        row.source_scope,
        row.source_id,
        row.description,
        row.created_at,
        row.updated_at,
      ),
    auditStatement(
      db,
      actor,
      'create',
      'virtual_machines',
      vmColumns,
      'id=?',
      [row.id],
      snapshot(vmColumns),
    ),
  ]);
  return results[0]!.results[0] as Row;
}
export async function updateVM(
  db: D1Database,
  actor: string,
  id: string,
  input: z.infer<typeof s.vmInput> | Patch<z.infer<typeof s.vmInput>>,
) {
  const before = await getVM(db, id);
  const parsed = s.vmInput.superRefine(s.sourceIdentity).parse({
    ...Object.fromEntries(
      [
        'name',
        'host_device_id',
        'vcpu',
        'memory_mb',
        'disk_mb',
        'source',
        'source_scope',
        'source_id',
        'description',
      ].map((k) => [k, before[k]]),
    ),
    ...input,
  });
  const now = new Date().toISOString();
  const row: Row = {
    id,
    created_at: before.created_at!,
    updated_at: now,
    name: parsed.name ?? null,
    host_device_id: parsed.host_device_id ?? null,
    vcpu: parsed.vcpu ?? null,
    memory_mb: parsed.memory_mb ?? null,
    disk_mb: parsed.disk_mb ?? null,
    source: parsed.source ?? null,
    source_scope: parsed.source_scope ?? null,
    source_id: parsed.source_id ?? null,
    description: parsed.description ?? null,
  };
  if (row.host_device_id) await reference(db, 'devices', String(row.host_device_id));
  const guard = unchanged(before, vmColumns);
  const results = await batch(db, [
    auditStatement(
      db,
      actor,
      'update',
      'virtual_machines',
      vmColumns,
      guard.sql,
      guard.values,
      '?',
      crypto.randomUUID(),
      [JSON.stringify(row)],
    ),
    db
      .prepare(
        `UPDATE virtual_machines SET name=?,host_device_id=?,vcpu=?,memory_mb=?,disk_mb=?,source=?,source_scope=?,source_id=?,description=?,updated_at=? WHERE ${guard.sql} RETURNING id,name,host_device_id,vcpu,memory_mb,disk_mb,source,source_scope,source_id,description,created_at,updated_at`,
      )
      .bind(
        row.name,
        row.host_device_id,
        row.vcpu,
        row.memory_mb,
        row.disk_mb,
        row.source,
        row.source_scope,
        row.source_id,
        row.description,
        row.updated_at,
        ...guard.values,
      ),
  ]);
  assertChanged(results[1]!.meta.changes);
  return results[1]!.results[0] as Row;
}
export function deleteVM(db: D1Database, actor: string, id: string) {
  return deleteInventory(db, actor, 'virtual_machines', vmColumns, id);
}
export const interfaceColumns = [
  'id',
  'device_id',
  'virtual_machine_id',
  'name',
  'mac_address',
  'description',
  'created_at',
  'updated_at',
] as const;
export function listInterface(db: D1Database, query: s.Query) {
  return list(
    db,
    'interfaces',
    interfaceColumns.join(','),
    query,
    ['name', 'mac_address', 'description'],
    { device_id: 'device_id', virtual_machine_id: 'virtual_machine_id' },
  );
}
export function getInterface(db: D1Database, id: string) {
  return required(db, `SELECT ${interfaceColumns.join(',')} FROM interfaces WHERE id=?`, id);
}
export async function createInterface(
  db: D1Database,
  actor: string,
  input: z.infer<typeof s.interfaceInput>,
) {
  const parsed = s.interfaceInput.superRefine(s.interfaceOwner).parse(input);
  const now = new Date().toISOString();
  const row: Row = {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    device_id: parsed.device_id ?? null,
    virtual_machine_id: parsed.virtual_machine_id ?? null,
    name: parsed.name ?? null,
    mac_address: parsed.mac_address ?? null,
    description: parsed.description ?? null,
  };
  if (row.device_id) await reference(db, 'devices', String(row.device_id));
  if (row.virtual_machine_id)
    await reference(db, 'virtual_machines', String(row.virtual_machine_id));
  const results = await batch(db, [
    db
      .prepare(
        'INSERT INTO interfaces (id,device_id,virtual_machine_id,name,mac_address,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id,device_id,virtual_machine_id,name,mac_address,description,created_at,updated_at',
      )
      .bind(
        row.id,
        row.device_id,
        row.virtual_machine_id,
        row.name,
        row.mac_address,
        row.description,
        row.created_at,
        row.updated_at,
      ),
    auditStatement(
      db,
      actor,
      'create',
      'interfaces',
      interfaceColumns,
      'id=?',
      [row.id],
      snapshot(interfaceColumns),
    ),
  ]);
  return results[0]!.results[0] as Row;
}
export async function updateInterface(
  db: D1Database,
  actor: string,
  id: string,
  input: z.infer<typeof s.interfaceInput> | Patch<z.infer<typeof s.interfaceInput>>,
) {
  const before = await getInterface(db, id);
  const parsed = s.interfaceInput.superRefine(s.interfaceOwner).parse({
    ...Object.fromEntries(
      ['device_id', 'virtual_machine_id', 'name', 'mac_address', 'description'].map((k) => [
        k,
        before[k],
      ]),
    ),
    ...input,
  });
  const now = new Date().toISOString();
  const row: Row = {
    id,
    created_at: before.created_at!,
    updated_at: now,
    device_id: parsed.device_id ?? null,
    virtual_machine_id: parsed.virtual_machine_id ?? null,
    name: parsed.name ?? null,
    mac_address: parsed.mac_address ?? null,
    description: parsed.description ?? null,
  };
  if (row.device_id) await reference(db, 'devices', String(row.device_id));
  if (row.virtual_machine_id)
    await reference(db, 'virtual_machines', String(row.virtual_machine_id));
  const guard = unchanged(before, interfaceColumns);
  const results = await batch(db, [
    auditStatement(
      db,
      actor,
      'update',
      'interfaces',
      interfaceColumns,
      guard.sql,
      guard.values,
      '?',
      crypto.randomUUID(),
      [JSON.stringify(row)],
    ),
    db
      .prepare(
        `UPDATE interfaces SET device_id=?,virtual_machine_id=?,name=?,mac_address=?,description=?,updated_at=? WHERE ${guard.sql} RETURNING id,device_id,virtual_machine_id,name,mac_address,description,created_at,updated_at`,
      )
      .bind(
        row.device_id,
        row.virtual_machine_id,
        row.name,
        row.mac_address,
        row.description,
        row.updated_at,
        ...guard.values,
      ),
  ]);
  assertChanged(results[1]!.meta.changes);
  return results[1]!.results[0] as Row;
}
export function deleteInterface(db: D1Database, actor: string, id: string) {
  return deleteInventory(db, actor, 'interfaces', interfaceColumns, id);
}
export const vlanColumns = [
  'id',
  'location_id',
  'vid',
  'name',
  'description',
  'created_at',
  'updated_at',
] as const;
export function listVLAN(db: D1Database, query: s.Query) {
  return list(
    db,
    'vlans',
    vlanColumns.join(','),
    query,
    ['name', 'CAST(vid AS TEXT)', 'description'],
    { location_id: 'location_id' },
  );
}
export function getVLAN(db: D1Database, id: string) {
  return required(db, `SELECT ${vlanColumns.join(',')} FROM vlans WHERE id=?`, id);
}
export async function createVLAN(
  db: D1Database,
  actor: string,
  input: z.infer<typeof s.vlanInput>,
) {
  const parsed = s.vlanInput.parse(input);
  const now = new Date().toISOString();
  const row: Row = {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    location_id: parsed.location_id ?? null,
    vid: parsed.vid ?? null,
    name: parsed.name ?? null,
    description: parsed.description ?? null,
  };
  await reference(db, 'locations', String(row.location_id));
  const results = await batch(db, [
    db
      .prepare(
        'INSERT INTO vlans (id,location_id,vid,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?) RETURNING id,location_id,vid,name,description,created_at,updated_at',
      )
      .bind(
        row.id,
        row.location_id,
        row.vid,
        row.name,
        row.description,
        row.created_at,
        row.updated_at,
      ),
    auditStatement(
      db,
      actor,
      'create',
      'vlans',
      vlanColumns,
      'id=?',
      [row.id],
      snapshot(vlanColumns),
    ),
  ]);
  return results[0]!.results[0] as Row;
}
export async function updateVLAN(
  db: D1Database,
  actor: string,
  id: string,
  input: z.infer<typeof s.vlanInput> | Patch<z.infer<typeof s.vlanInput>>,
) {
  const before = await getVLAN(db, id);
  const parsed = s.vlanInput.parse({
    ...Object.fromEntries(['location_id', 'vid', 'name', 'description'].map((k) => [k, before[k]])),
    ...input,
  });
  const now = new Date().toISOString();
  const row: Row = {
    id,
    created_at: before.created_at!,
    updated_at: now,
    location_id: parsed.location_id ?? null,
    vid: parsed.vid ?? null,
    name: parsed.name ?? null,
    description: parsed.description ?? null,
  };
  await reference(db, 'locations', String(row.location_id));
  const guard = unchanged(before, vlanColumns);
  const results = await batch(db, [
    auditStatement(
      db,
      actor,
      'update',
      'vlans',
      vlanColumns,
      guard.sql,
      guard.values,
      '?',
      crypto.randomUUID(),
      [JSON.stringify(row)],
    ),
    db
      .prepare(
        `UPDATE vlans SET location_id=?,vid=?,name=?,description=?,updated_at=? WHERE ${guard.sql} RETURNING id,location_id,vid,name,description,created_at,updated_at`,
      )
      .bind(row.location_id, row.vid, row.name, row.description, row.updated_at, ...guard.values),
  ]);
  assertChanged(results[1]!.meta.changes);
  return results[1]!.results[0] as Row;
}
export function deleteVLAN(db: D1Database, actor: string, id: string) {
  return deleteInventory(db, actor, 'vlans', vlanColumns, id);
}
export const prefixColumns = [
  'id',
  'location_id',
  'vlan_id',
  'cidr',
  'name',
  'description',
  'created_at',
  'updated_at',
] as const;
export function listPrefix(db: D1Database, query: s.Query) {
  return list(db, 'prefixes', prefixColumns.join(','), query, ['cidr', 'name', 'description'], {
    location_id: 'location_id',
    vlan_id: 'vlan_id',
  });
}
export function getPrefix(db: D1Database, id: string) {
  return required(db, `SELECT ${prefixColumns.join(',')} FROM prefixes WHERE id=?`, id);
}
export async function createPrefix(
  db: D1Database,
  actor: string,
  input: z.infer<typeof s.prefixInput>,
) {
  const parsed = s.prefixInput.parse(input);
  const now = new Date().toISOString();
  const row: Row = {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    location_id: parsed.location_id ?? null,
    vlan_id: parsed.vlan_id ?? null,
    cidr: parsed.cidr ?? null,
    name: parsed.name ?? null,
    description: parsed.description ?? null,
  };
  await prefixLocation(db, String(row.location_id), row.vlan_id as string | null);
  const p = prefix(String(row.cidr));
  const derived = {
    family: p.family,
    prefix_length: p.length,
    range_start: p.range_start,
    range_end: p.range_end,
  };
  const results = await batch(db, [
    db
      .prepare(
        'INSERT INTO prefixes (id,location_id,vlan_id,cidr,name,description,created_at,updated_at,family,prefix_length,range_start,range_end) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id,location_id,vlan_id,cidr,name,description,created_at,updated_at',
      )
      .bind(
        row.id,
        row.location_id,
        row.vlan_id,
        row.cidr,
        row.name,
        row.description,
        row.created_at,
        row.updated_at,
        derived.family,
        derived.prefix_length,
        derived.range_start,
        derived.range_end,
      ),
    auditStatement(
      db,
      actor,
      'create',
      'prefixes',
      prefixColumns,
      'id=?',
      [row.id],
      snapshot(prefixColumns),
    ),
  ]);
  return results[0]!.results[0] as Row;
}
export async function updatePrefix(
  db: D1Database,
  actor: string,
  id: string,
  input: z.infer<typeof s.prefixInput> | Patch<z.infer<typeof s.prefixInput>>,
) {
  const before = await getPrefix(db, id);
  const parsed = s.prefixInput.parse({
    ...Object.fromEntries(
      ['location_id', 'vlan_id', 'cidr', 'name', 'description'].map((k) => [k, before[k]]),
    ),
    ...input,
  });
  const now = new Date().toISOString();
  const row: Row = {
    id,
    created_at: before.created_at!,
    updated_at: now,
    location_id: parsed.location_id ?? null,
    vlan_id: parsed.vlan_id ?? null,
    cidr: parsed.cidr ?? null,
    name: parsed.name ?? null,
    description: parsed.description ?? null,
  };
  await prefixLocation(db, String(row.location_id), row.vlan_id as string | null);
  const p = prefix(String(row.cidr));
  const derived = {
    family: p.family,
    prefix_length: p.length,
    range_start: p.range_start,
    range_end: p.range_end,
  };
  const ips = await db
    .prepare('SELECT address FROM ip_addresses WHERE prefix_id=?')
    .bind(id)
    .all<{ address: string }>();
  if (ips.results.some((a) => !contains(p, address(a.address))))
    throw invalid('Prefix must contain every registered IP address.');
  const guard = unchanged(before, prefixColumns);
  const results = await batch(db, [
    auditStatement(
      db,
      actor,
      'update',
      'prefixes',
      prefixColumns,
      guard.sql,
      guard.values,
      '?',
      crypto.randomUUID(),
      [JSON.stringify(row)],
    ),
    db
      .prepare(
        `UPDATE prefixes SET location_id=?,vlan_id=?,cidr=?,name=?,description=?,updated_at=?,family=?,prefix_length=?,range_start=?,range_end=? WHERE ${guard.sql} RETURNING id,location_id,vlan_id,cidr,name,description,created_at,updated_at`,
      )
      .bind(
        row.location_id,
        row.vlan_id,
        row.cidr,
        row.name,
        row.description,
        row.updated_at,
        derived.family,
        derived.prefix_length,
        derived.range_start,
        derived.range_end,
        ...guard.values,
      ),
  ]);
  assertChanged(results[1]!.meta.changes);
  return results[1]!.results[0] as Row;
}
export function deletePrefix(db: D1Database, actor: string, id: string) {
  return deleteInventory(db, actor, 'prefixes', prefixColumns, id);
}
export const ipColumns = [
  'id',
  'prefix_id',
  'interface_id',
  'address',
  'status',
  'dns_name',
  'description',
  'created_at',
  'updated_at',
] as const;
export function listIP(db: D1Database, query: s.Query) {
  return list(
    db,
    'ip_addresses',
    ipColumns.join(','),
    query,
    ['address', 'dns_name', 'description'],
    { prefix_id: 'prefix_id', interface_id: 'interface_id', status: 'status' },
  );
}
export function getIP(db: D1Database, id: string) {
  return required(db, `SELECT ${ipColumns.join(',')} FROM ip_addresses WHERE id=?`, id);
}
export async function createIP(db: D1Database, actor: string, input: z.infer<typeof s.ipInput>) {
  const parsed = s.ipInput.parse(input);
  const now = new Date().toISOString();
  const row: Row = {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    prefix_id: parsed.prefix_id ?? null,
    interface_id: parsed.interface_id ?? null,
    address: parsed.address ?? null,
    status: parsed.status ?? null,
    dns_name: parsed.dns_name ?? null,
    description: parsed.description ?? null,
  };
  if (row.interface_id) await reference(db, 'interfaces', String(row.interface_id));
  const a = address(String(row.address));
  const parent = await reference(db, 'prefixes', String(row.prefix_id));
  if (!contains(prefix(String(parent.cidr)), a))
    throw invalid('IP address must belong to its Prefix.');
  const derived = { family: a.family, address_key: a.key };
  const results = await batch(db, [
    db
      .prepare(
        'INSERT INTO ip_addresses (id,prefix_id,interface_id,address,status,dns_name,description,created_at,updated_at,family,address_key) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id,prefix_id,interface_id,address,status,dns_name,description,created_at,updated_at',
      )
      .bind(
        row.id,
        row.prefix_id,
        row.interface_id,
        row.address,
        row.status,
        row.dns_name,
        row.description,
        row.created_at,
        row.updated_at,
        derived.family,
        derived.address_key,
      ),
    auditStatement(
      db,
      actor,
      'create',
      'ip_addresses',
      ipColumns,
      'id=?',
      [row.id],
      snapshot(ipColumns),
    ),
  ]);
  return results[0]!.results[0] as Row;
}
export async function updateIP(
  db: D1Database,
  actor: string,
  id: string,
  input: z.infer<typeof s.ipInput> | Patch<z.infer<typeof s.ipInput>>,
) {
  const before = await getIP(db, id);
  const parsed = s.ipInput.parse({
    ...Object.fromEntries(
      ['prefix_id', 'interface_id', 'address', 'status', 'dns_name', 'description'].map((k) => [
        k,
        before[k],
      ]),
    ),
    ...input,
  });
  const now = new Date().toISOString();
  const row: Row = {
    id,
    created_at: before.created_at!,
    updated_at: now,
    prefix_id: parsed.prefix_id ?? null,
    interface_id: parsed.interface_id ?? null,
    address: parsed.address ?? null,
    status: parsed.status ?? null,
    dns_name: parsed.dns_name ?? null,
    description: parsed.description ?? null,
  };
  if (row.interface_id) await reference(db, 'interfaces', String(row.interface_id));
  const a = address(String(row.address));
  const parent = await reference(db, 'prefixes', String(row.prefix_id));
  if (!contains(prefix(String(parent.cidr)), a))
    throw invalid('IP address must belong to its Prefix.');
  const derived = { family: a.family, address_key: a.key };
  const guard = unchanged(before, ipColumns);
  const results = await batch(db, [
    auditStatement(
      db,
      actor,
      'update',
      'ip_addresses',
      ipColumns,
      guard.sql,
      guard.values,
      '?',
      crypto.randomUUID(),
      [JSON.stringify(row)],
    ),
    db
      .prepare(
        `UPDATE ip_addresses SET prefix_id=?,interface_id=?,address=?,status=?,dns_name=?,description=?,updated_at=?,family=?,address_key=? WHERE ${guard.sql} RETURNING id,prefix_id,interface_id,address,status,dns_name,description,created_at,updated_at`,
      )
      .bind(
        row.prefix_id,
        row.interface_id,
        row.address,
        row.status,
        row.dns_name,
        row.description,
        row.updated_at,
        derived.family,
        derived.address_key,
        ...guard.values,
      ),
  ]);
  assertChanged(results[1]!.meta.changes);
  return results[1]!.results[0] as Row;
}
export function deleteIP(db: D1Database, actor: string, id: string) {
  return deleteInventory(db, actor, 'ip_addresses', ipColumns, id);
}
