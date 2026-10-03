import { missing } from '../api/errors';
import { auditStatement, batch, snapshot } from './mutations';
import { interfaceColumns, ipColumns, vmColumns } from './columns';
import type { Table } from './types';
// Explicitly audit dependent mutations before the parent is deleted, in the same D1 batch.
export async function deleteInventory(
  db: D1Database,
  actor: string,
  table: Table,
  columns: readonly string[],
  id: string,
) {
  const statements: D1PreparedStatement[] = [];
  const now = new Date().toISOString();
  const detach = (target: Table, cols: readonly string[], field: string, where: string) => {
    statements.push(
      auditStatement(
        db,
        actor,
        'update',
        target,
        cols,
        where,
        [id],
        snapshot(cols, { [field]: 'NULL', updated_at: `'${now}'` }),
      ),
    );
    statements.push(
      db.prepare(`UPDATE ${target} SET ${field}=NULL,updated_at=? WHERE ${where}`).bind(now, id),
    );
  };
  statements.push(
    auditStatement(
      db,
      actor,
      table === 'ip_addresses' ? 'release' : 'delete',
      table,
      columns,
      'id=?',
      [id],
      'NULL',
    ),
  );
  if (table === 'devices' || table === 'virtual_machines') {
    const owner = table === 'devices' ? 'device_id' : 'virtual_machine_id';
    detach(
      'ip_addresses',
      ipColumns,
      'interface_id',
      `interface_id IN (SELECT id FROM interfaces WHERE ${owner}=?)`,
    );
    statements.push(
      auditStatement(
        db,
        actor,
        'delete',
        'interfaces',
        interfaceColumns,
        `${owner}=?`,
        [id],
        'NULL',
      ),
    );
    statements.push(db.prepare(`DELETE FROM interfaces WHERE ${owner}=?`).bind(id));
    if (table === 'devices')
      detach('virtual_machines', vmColumns, 'host_device_id', 'host_device_id=?');
  } else if (table === 'interfaces')
    detach('ip_addresses', ipColumns, 'interface_id', 'interface_id=?');
  statements.push(db.prepare(`DELETE FROM ${table} WHERE id=?`).bind(id));
  const results = await batch(db, statements);
  if (!results.at(-1)!.meta.changes) throw missing();
}
