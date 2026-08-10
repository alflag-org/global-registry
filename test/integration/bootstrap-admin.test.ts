import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { buildBootstrapAdminSql } from '../../scripts/bootstrap-admin-core';

describe('first-admin bootstrap persistence', () => {
  it('creates one self-owned admin with atomic audit/outbox records and refuses a second admin', async () => {
    const first = buildBootstrapAdminSql({
      actorId: 'actor-bootstrap-first',
      identity: 'access:bootstrap-first',
      displayName: 'Registry Administrator',
      createdAt: '2026-08-10T00:00:00.000Z',
    });

    await env.DB.prepare(
      `CREATE TRIGGER reject_bootstrap_outbox
       BEFORE INSERT ON outbox
       WHEN NEW.topic = 'global-registry.actor.created'
       BEGIN
         SELECT RAISE(ABORT, 'bootstrap_outbox_test_failure');
       END`,
    ).run();
    await expect(executeBootstrapSql(first)).rejects.toThrow('bootstrap_outbox_test_failure');
    await env.DB.prepare('DROP TRIGGER reject_bootstrap_outbox').run();
    expect(await registryCounts()).toEqual({ actors: 0, events: 0, outbox: 0 });

    await executeBootstrapSql(first);
    const persisted = await env.DB.prepare(
      `SELECT
         a.id,
         a.identity,
         a.display_name,
         a.role,
         a.active,
         a.revision,
         a.created_by,
         a.updated_by,
         e.event_type,
         e.actor_id AS event_actor_id,
         o.topic,
         o.status AS outbox_status
       FROM actors a
       JOIN events e ON e.event_id = 'evt_actor_' || a.id || '_1'
       JOIN outbox o ON o.event_id = e.event_id
       WHERE a.id = ?`,
    )
      .bind('actor-bootstrap-first')
      .first();
    expect(persisted).toEqual({
      id: 'actor-bootstrap-first',
      identity: 'access:bootstrap-first',
      display_name: 'Registry Administrator',
      role: 'admin',
      active: 1,
      revision: 1,
      created_by: 'actor-bootstrap-first',
      updated_by: 'actor-bootstrap-first',
      event_type: 'actor.created',
      event_actor_id: 'actor-bootstrap-first',
      topic: 'global-registry.actor.created',
      outbox_status: 'pending',
    });

    await executeBootstrapSql(
      buildBootstrapAdminSql({
        actorId: 'actor-bootstrap-second',
        identity: 'service:bootstrap-second',
        displayName: 'Second Administrator',
        createdAt: '2026-08-10T00:01:00.000Z',
      }),
    );
    expect(await registryCounts()).toEqual({ actors: 1, events: 1, outbox: 1 });
  });
});

async function registryCounts(): Promise<{ actors: number; events: number; outbox: number }> {
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM actors) AS actors,
       (SELECT count(*) FROM events) AS events,
       (SELECT count(*) FROM outbox) AS outbox`,
  ).first<{ actors: number; events: number; outbox: number }>();
  if (counts === null) throw new Error('D1 did not return bootstrap verification counts.');
  return counts;
}

async function executeBootstrapSql(sql: string): Promise<D1Result<unknown>[]> {
  const statements = sql
    .split(';\n')
    .map((statement) => statement.trim().replace(/;$/, ''))
    .filter((statement) => statement.length > 0)
    .map((statement) => env.DB.prepare(statement));
  return env.DB.batch(statements);
}
