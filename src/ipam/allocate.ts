import type { z } from '@hono/zod-openapi';
import type { allocationInput } from '../api/schemas';
import { conflict, databaseError } from '../api/errors';
import { getPrefix, ipColumns } from '../db/queries';
import { auditStatement, snapshot, assertChanged } from '../db/mutations';
import type { Row } from '../db/types';
import { reference } from '../db/relationships';
import { address, firstAvailable, prefix } from './address';
export async function allocate(
  db: D1Database,
  actor: string,
  prefixId: string,
  input: z.infer<typeof allocationInput>,
) {
  if (input.interface_id) await reference(db, 'interfaces', input.interface_id);
  for (let attempt = 0; attempt < 5; attempt++) {
    const parent = await getPrefix(db, prefixId);
    const p = prefix(String(parent.cidr));
    const [used, children] = await db.batch<Record<string, string>>([
      db
        .prepare(
          'SELECT address_key FROM ip_addresses WHERE family=? AND address_key BETWEEN ? AND ?',
        )
        .bind(p.family, p.range_start, p.range_end),
      db
        .prepare(
          'SELECT range_start,range_end FROM prefixes WHERE family=? AND range_start>=? AND range_end<=? AND prefix_length>?',
        )
        .bind(p.family, p.range_start, p.range_end, p.length),
    ]);
    const ranges = [
      ...used!.results.map((r) => ({
        start: BigInt(`0x${r.address_key}`),
        end: BigInt(`0x${r.address_key}`),
      })),
      ...children!.results.map((r) => ({
        start: BigInt(`0x${r.range_start}`),
        end: BigInt(`0x${r.range_end}`),
      })),
    ];
    const candidate = firstAvailable(p, ranges);
    if (!candidate) throw conflict('This Prefix has no available addresses.');
    const a = address(candidate);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    try {
      // Recheck the parent and exclusions inside the write transaction; UNIQUE is the final allocation boundary.
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO ip_addresses (id,prefix_id,interface_id,address,status,dns_name,description,created_at,updated_at,family,address_key)
     SELECT ?,?,?,?,'assigned',?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM prefixes WHERE id=? AND cidr=?)
     AND NOT EXISTS (SELECT 1 FROM prefixes WHERE family=? AND prefix_length>? AND range_start>=? AND range_end<=? AND ? BETWEEN range_start AND range_end)
     RETURNING ${ipColumns.join(',')}`,
          )
          .bind(
            id,
            prefixId,
            input.interface_id ?? null,
            candidate,
            input.dns_name ?? null,
            input.description ?? null,
            now,
            now,
            a.family,
            a.key,
            prefixId,
            p.cidr,
            p.family,
            p.length,
            p.range_start,
            p.range_end,
            a.key,
          ),
        auditStatement(
          db,
          actor,
          'allocate',
          'ip_addresses',
          ipColumns,
          'id=?',
          [id],
          snapshot(ipColumns),
        ),
      ]);
      assertChanged(results[0]!.meta.changes);
      return results[0]!.results[0] as Row;
    } catch (error) {
      if (/UNIQUE constraint failed: ip_addresses\.(address|family)/.test(String(error))) continue;
      databaseError(error);
    }
  }
  throw conflict('Concurrent allocations exhausted the retry limit. Retry the request.');
}
