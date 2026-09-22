import { conflict } from '../api/errors';
import type { Table, Row } from './types';
// Only static table names are accepted; IDs are always bound values.
export async function reference(db: D1Database, table: Table, id: string): Promise<Row> {
  const row = await db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first<Row>();
  if (!row) throw conflict(`The referenced ${table.replaceAll('_', ' ')} record does not exist.`);
  return row;
}
export async function prefixLocation(
  db: D1Database,
  locationId: string,
  vlanId: string | null | undefined,
) {
  await reference(db, 'locations', locationId);
  if (vlanId) {
    const vlan = await reference(db, 'vlans', vlanId);
    if (vlan.location_id !== locationId)
      throw conflict('The VLAN and Prefix must belong to the same Location.');
  }
}
