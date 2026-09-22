import type { z } from '@hono/zod-openapi';
import * as s from '../api/schemas';
import { invalid } from '../api/errors';
import { reference, prefixLocation } from './relationships';
import { address, prefix, contains } from '../ipam/address';
import { auditStatement, snapshot, batch, required, unchanged, assertChanged } from './mutations';
import { list } from './lists';
import { deleteInventory } from './deletion';
import * as c from './columns';
import type { Row, Table } from './types';
export * from './columns';
type Values = Record<string, unknown>;
// Runs between input parsing and the atomic write batch: validates references and
// returns derived columns to persist. `before` is set only on updates.
type Prepare = (db: D1Database, row: Row, before?: Row) => Promise<Values | void>;
export interface Entity {
  table: Table;
  columns: readonly string[];
  fields: readonly string[];
  input: z.ZodObject<z.ZodRawShape>;
  schema: z.ZodType;
  search: string[];
  filters: Record<string, string>;
  prepare?: Prepare;
}
export const entities = {
  locations: {
    table: 'locations',
    columns: c.locationColumns,
    fields: ['name', 'slug', 'description'],
    input: s.locationInput,
    schema: s.locationInput,
    search: ['name', 'slug', 'description'],
    filters: {},
  },
  devices: {
    table: 'devices',
    columns: c.deviceColumns,
    fields: [
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
    ],
    input: s.deviceInput,
    schema: s.deviceInput.superRefine(s.sourceIdentity),
    search: ['name', 'serial_number', 'description'],
    filters: { location_id: 'location_id', source: 'source', source_scope: 'source_scope' },
    prepare: async (db, row) => {
      await reference(db, 'locations', String(row.location_id));
    },
  },
  virtual_machines: {
    table: 'virtual_machines',
    columns: c.vmColumns,
    fields: [
      'name',
      'host_device_id',
      'vcpu',
      'memory_mb',
      'disk_mb',
      'source',
      'source_scope',
      'source_id',
      'description',
    ],
    input: s.vmInput,
    schema: s.vmInput.superRefine(s.sourceIdentity),
    search: ['name', 'description'],
    filters: {
      host_device_id: 'host_device_id',
      source: 'source',
      source_scope: 'source_scope',
      location_id:
        '(SELECT location_id FROM devices WHERE devices.id=virtual_machines.host_device_id)',
    },
    prepare: async (db, row) => {
      if (row.host_device_id) await reference(db, 'devices', String(row.host_device_id));
    },
  },
  interfaces: {
    table: 'interfaces',
    columns: c.interfaceColumns,
    fields: ['device_id', 'virtual_machine_id', 'name', 'mac_address', 'description'],
    input: s.interfaceInput,
    schema: s.interfaceInput.superRefine(s.interfaceOwner),
    search: ['name', 'mac_address', 'description'],
    filters: { device_id: 'device_id', virtual_machine_id: 'virtual_machine_id' },
    prepare: async (db, row) => {
      if (row.device_id) await reference(db, 'devices', String(row.device_id));
      if (row.virtual_machine_id)
        await reference(db, 'virtual_machines', String(row.virtual_machine_id));
    },
  },
  vlans: {
    table: 'vlans',
    columns: c.vlanColumns,
    fields: ['location_id', 'vid', 'name', 'description'],
    input: s.vlanInput,
    schema: s.vlanInput,
    search: ['name', 'CAST(vid AS TEXT)', 'description'],
    filters: { location_id: 'location_id' },
    prepare: async (db, row) => {
      await reference(db, 'locations', String(row.location_id));
    },
  },
  prefixes: {
    table: 'prefixes',
    columns: c.prefixColumns,
    fields: ['location_id', 'vlan_id', 'cidr', 'name', 'description'],
    input: s.prefixInput,
    schema: s.prefixInput,
    search: ['cidr', 'name', 'description'],
    filters: { location_id: 'location_id', vlan_id: 'vlan_id' },
    prepare: async (db, row, before) => {
      await prefixLocation(db, String(row.location_id), row.vlan_id as string | null);
      const p = prefix(String(row.cidr));
      if (before) {
        const ips = await db
          .prepare('SELECT address FROM ip_addresses WHERE prefix_id=?')
          .bind(before.id)
          .all<{ address: string }>();
        if (ips.results.some((a) => !contains(p, address(a.address))))
          throw invalid('Prefix must contain every registered IP address.');
      }
      return {
        family: p.family,
        prefix_length: p.length,
        range_start: p.range_start,
        range_end: p.range_end,
      };
    },
  },
  ip_addresses: {
    table: 'ip_addresses',
    columns: c.ipColumns,
    fields: ['prefix_id', 'interface_id', 'address', 'status', 'dns_name', 'description'],
    input: s.ipInput,
    schema: s.ipInput,
    search: ['address', 'dns_name', 'description'],
    filters: { prefix_id: 'prefix_id', interface_id: 'interface_id', status: 'status' },
    prepare: async (db, row) => {
      if (row.interface_id) await reference(db, 'interfaces', String(row.interface_id));
      const a = address(String(row.address));
      const parent = await reference(db, 'prefixes', String(row.prefix_id));
      if (!contains(prefix(String(parent.cidr)), a))
        throw invalid('IP address must belong to its Prefix.');
      return { family: a.family, address_key: a.key };
    },
  },
} satisfies Record<string, Entity>;
export function listEntity(entity: Entity, db: D1Database, query: s.Query) {
  return list(db, entity.table, entity.columns.join(','), query, entity.search, entity.filters);
}
export function getEntity(entity: Entity, db: D1Database, id: string) {
  return required(db, `SELECT ${entity.columns.join(',')} FROM ${entity.table} WHERE id=?`, id);
}
export function findEntity(entity: Entity, db: D1Database, id: string) {
  return db
    .prepare(`SELECT ${entity.columns.join(',')} FROM ${entity.table} WHERE id=?`)
    .bind(id)
    .first<Row>();
}
function buildRow(entity: Entity, parsed: Values, base?: Row): Row {
  const now = new Date().toISOString();
  const row: Row = {
    id: base?.id ?? crypto.randomUUID(),
    created_at: base?.created_at ?? now,
    updated_at: now,
  };
  for (const field of entity.fields) row[field] = (parsed[field] ?? null) as string | number | null;
  return row;
}
const pick = (row: Row, fields: readonly string[]) =>
  Object.fromEntries(fields.map((field) => [field, row[field]]));
export async function createEntity(entity: Entity, db: D1Database, actor: string, input: unknown) {
  const parsed = entity.schema.parse(input) as Values;
  const row = buildRow(entity, parsed);
  const derived = (await entity.prepare?.(db, row)) ?? {};
  const write = [...entity.columns, ...Object.keys(derived)];
  const results = await batch(db, [
    db
      .prepare(
        `INSERT INTO ${entity.table} (${write.join(',')}) VALUES (${write.map(() => '?').join(',')}) RETURNING ${entity.columns.join(',')}`,
      )
      .bind(...write.map((column) => (column in derived ? derived[column] : row[column]))),
    auditStatement(
      db,
      actor,
      'create',
      entity.table,
      entity.columns,
      'id=?',
      [row.id],
      snapshot(entity.columns),
    ),
  ]);
  return results[0]!.results[0] as Row;
}
export async function updateEntity(
  entity: Entity,
  db: D1Database,
  actor: string,
  id: string,
  input: Values,
) {
  const before = await getEntity(entity, db, id);
  const parsed = entity.schema.parse({ ...pick(before, entity.fields), ...input }) as Values;
  const row = buildRow(entity, parsed, before);
  const derived = (await entity.prepare?.(db, row, before)) ?? {};
  const guard = unchanged(before, entity.columns);
  const set = [...entity.fields, ...Object.keys(derived), 'updated_at'];
  const results = await batch(db, [
    auditStatement(
      db,
      actor,
      'update',
      entity.table,
      entity.columns,
      guard.sql,
      guard.values,
      '?',
      crypto.randomUUID(),
      [JSON.stringify(row)],
    ),
    db
      .prepare(
        `UPDATE ${entity.table} SET ${set.map((column) => `${column}=?`).join(',')} WHERE ${guard.sql} RETURNING ${entity.columns.join(',')}`,
      )
      .bind(
        ...set.map((column) => (column in derived ? derived[column] : row[column])),
        ...guard.values,
      ),
  ]);
  assertChanged(results[1]!.meta.changes);
  return results[1]!.results[0] as Row;
}
export function deleteEntity(entity: Entity, db: D1Database, actor: string, id: string) {
  return deleteInventory(db, actor, entity.table, entity.columns, id);
}
