import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { D1GlobalRegistryRepository } from '../../src/adapters/d1/repository';
import { ActorService } from '../../src/application/actors';

const bootstrapActorId = 'actor-administration-bootstrap';
const bootstrapIdentity = 'access:actor-administration-bootstrap';

describe.sequential('Actor administration persistence', () => {
  const repository = new D1GlobalRegistryRepository(env.DB);
  const service = new ActorService(repository);

  beforeAll(async () => {
    const createdAt = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO actors (
        id, identity, display_name, role, active, revision,
        created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, 'admin', 1, 1, ?, ?, ?, ?)`,
    )
      .bind(
        bootstrapActorId,
        bootstrapIdentity,
        'Actor Administration Bootstrap',
        createdAt,
        createdAt,
        bootstrapActorId,
        bootstrapActorId,
      )
      .run();
  });

  it('validates, creates, reads, lists, and atomically updates Actors', async () => {
    await expect(
      Promise.resolve().then(() =>
        service.create({
          identity: 'admin@example.com',
          displayName: 'Invalid Actor',
          role: 'readonly',
          actorId: bootstrapActorId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_actor_create', status: 422 });

    const actor = await service.create({
      identity: 'service:actor-administration-operator',
      displayName: '  Actor Administration Operator  ',
      role: 'operator',
      actorId: bootstrapActorId,
    });
    expect(actor).toMatchObject({
      identity: 'service:actor-administration-operator',
      displayName: 'Actor Administration Operator',
      role: 'operator',
      active: true,
      revision: 1,
    });
    expect(await repository.getActor(actor.id)).toEqual(actor);
    expect((await repository.listActors()).map((entry) => entry.id)).toContain(actor.id);

    const createdAudit = await env.DB.prepare(
      `SELECT e.actor_id, e.payload_json, o.topic
       FROM events e
       JOIN outbox o ON o.event_id = e.event_id
       WHERE e.event_id = ?`,
    )
      .bind(`evt_actor_${actor.id}_1`)
      .first<{ actor_id: string; payload_json: string; topic: string }>();
    expect(createdAudit).toMatchObject({
      actor_id: bootstrapActorId,
      topic: 'global-registry.actor.created',
    });
    expect(JSON.parse(createdAudit?.payload_json ?? '{}')).toMatchObject({
      actorId: actor.id,
      identity: actor.identity,
      displayName: actor.displayName,
      role: actor.role,
      active: true,
      resultingRevision: 1,
    });

    const auditCountBeforeInvalidCreates = await actorAuditCount();
    await expect(
      service.create({
        identity: actor.identity,
        displayName: 'Duplicate Actor',
        role: 'readonly',
        actorId: bootstrapActorId,
      }),
    ).rejects.toMatchObject({ code: 'duplicate_actor_identity', status: 409 });
    await expect(
      repository.createActor({
        id: 'actor-administration-non-canonical',
        identity: 'access: trailing-space ',
        displayName: 'Non-canonical Actor',
        role: 'readonly',
        actorId: bootstrapActorId,
      }),
    ).rejects.toThrow('actor_identity_not_canonical');
    expect(await actorAuditCount()).toBe(auditCountBeforeInvalidCreates);

    await expect(
      Promise.resolve().then(() =>
        service.update({
          id: actor.id,
          expectedRevision: 0,
          displayName: 'Invalid Revision',
          actorId: bootstrapActorId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_actor_update', status: 422 });
    await expect(
      Promise.resolve().then(() =>
        service.update({
          id: actor.id,
          expectedRevision: actor.revision,
          actorId: bootstrapActorId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'empty_actor_patch', status: 422 });

    const updated = await service.update({
      id: actor.id,
      displayName: 'Actor Administration Operator Updated',
      active: false,
      expectedRevision: actor.revision,
      actorId: bootstrapActorId,
    });
    expect(updated).toMatchObject({
      id: actor.id,
      displayName: 'Actor Administration Operator Updated',
      active: false,
      revision: 2,
    });

    const persistedAudit = await env.DB.prepare(
      `SELECT
         a.display_name,
         a.active,
         a.revision,
         e.actor_id,
         e.payload_json,
         o.topic
       FROM actors a
       JOIN events e ON e.event_id = ?
       JOIN outbox o ON o.event_id = e.event_id
       WHERE a.id = ?`,
    )
      .bind(`evt_actor_${actor.id}_2`, actor.id)
      .first<{
        display_name: string;
        active: number;
        revision: number;
        actor_id: string;
        payload_json: string;
        topic: string;
      }>();
    expect(persistedAudit).toMatchObject({
      display_name: updated.displayName,
      active: 0,
      revision: 2,
      actor_id: bootstrapActorId,
      topic: 'global-registry.actor.updated',
    });
    expect(JSON.parse(persistedAudit?.payload_json ?? '{}')).toMatchObject({
      actorId: actor.id,
      displayName: updated.displayName,
      active: false,
      previousRevision: 1,
      resultingRevision: 2,
    });

    const auditCountBeforeFailures = await actorAuditCount();
    await expect(
      repository.updateActor({
        id: actor.id,
        displayName: 'Stale Update',
        expectedRevision: 1,
        actorId: bootstrapActorId,
      }),
    ).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
    expect(await actorAuditCount()).toBe(auditCountBeforeFailures);

    await expect(
      env.DB.prepare(
        `UPDATE actors
         SET identity = ?,
             revision = revision + 1,
             updated_at = ?,
             updated_by = ?
         WHERE id = ? AND revision = ?`,
      )
        .bind(
          'service:actor-administration-changed',
          new Date().toISOString(),
          bootstrapActorId,
          actor.id,
          updated.revision,
        )
        .run(),
    ).rejects.toThrow('actor_immutable_fields');
    expect(await actorAuditCount()).toBe(auditCountBeforeFailures);

    await env.DB.prepare(
      `CREATE TRIGGER reject_actor_update_outbox
       BEFORE INSERT ON outbox
       WHEN NEW.topic = 'global-registry.actor.updated'
       BEGIN
         SELECT RAISE(ABORT, 'actor_outbox_test_failure');
       END`,
    ).run();
    try {
      await expect(
        repository.updateActor({
          id: actor.id,
          displayName: 'Must Roll Back',
          expectedRevision: updated.revision,
          actorId: bootstrapActorId,
        }),
      ).rejects.toThrow('actor_outbox_test_failure');
    } finally {
      await env.DB.prepare('DROP TRIGGER reject_actor_update_outbox').run();
    }
    expect(await repository.getActor(actor.id)).toEqual(updated);
    expect(await actorAuditCount()).toBe(auditCountBeforeFailures);
    expect(
      await env.DB.prepare(`SELECT event_id FROM events WHERE event_id = ?`)
        .bind(`evt_actor_${actor.id}_3`)
        .first(),
    ).toBeNull();
  });

  it('rejects every C0 control and DEL in local D1 Actor insert and update paths', async () => {
    const controlPoints = [...Array.from({ length: 32 }, (_, index) => index), 127];
    await expect(
      repository.createActor({
        id: 'actor-valid-boundary-access',
        identity: 'access:a',
        displayName: 'Valid Access Boundary',
        role: 'readonly',
        actorId: bootstrapActorId,
      }),
    ).resolves.toMatchObject({ identity: 'access:a' });
    await expect(
      repository.createActor({
        id: 'actor-valid-boundary-service',
        identity: 'service:a',
        displayName: 'Valid Service Boundary',
        role: 'readonly',
        actorId: bootstrapActorId,
      }),
    ).resolves.toMatchObject({ identity: 'service:a' });

    for (const codePoint of controlPoints) {
      const control = String.fromCodePoint(codePoint);
      const insertId = `actor-d1-insert-control-${codePoint}`;
      const timestamp = new Date().toISOString();
      await expect(
        env.DB.prepare(
          `INSERT INTO actors (
            id, identity, display_name, role, active, revision,
            created_at, updated_at, created_by, updated_by
          ) VALUES (?, ?, ?, 'readonly', 1, 1, ?, ?, ?, ?)`,
        )
          .bind(
            insertId,
            `access:insert${control}control`,
            `Insert Control ${codePoint}`,
            timestamp,
            timestamp,
            bootstrapActorId,
            bootstrapActorId,
          )
          .run(),
      ).rejects.toThrow('actor_identity_not_canonical');

      const updateId = `actor-d1-update-control-${codePoint}`;
      await repository.createActor({
        id: updateId,
        identity: `service:valid-control-${codePoint}`,
        displayName: `Update Control ${codePoint}`,
        role: 'readonly',
        actorId: bootstrapActorId,
      });
      await expect(
        env.DB.prepare(
          `UPDATE actors SET identity = ?, revision = revision + 1, updated_at = ?, updated_by = ?
           WHERE id = ? AND revision = 1`,
        )
          .bind(
            `access:update${control}control`,
            new Date().toISOString(),
            bootstrapActorId,
            updateId,
          )
          .run(),
      ).rejects.toThrow('actor_identity_not_canonical');
      expect(
        await env.DB.prepare('SELECT identity FROM actors WHERE id = ?').bind(updateId).first(),
      ).toMatchObject({ identity: `service:valid-control-${codePoint}` });
    }
  });

  it('protects self lockout and serializes concurrent admin demotions', async () => {
    const externalActor = await repository.createActor({
      id: 'actor-administration-external-operator',
      identity: 'service:actor-administration-external-operator',
      displayName: 'Actor Administration External Operator',
      role: 'operator',
      actorId: bootstrapActorId,
    });
    const auditCountBeforeLastAdminFailures = await actorAuditCount();
    await expect(
      service.update({
        id: bootstrapActorId,
        active: false,
        expectedRevision: 1,
        actorId: bootstrapActorId,
      }),
    ).rejects.toMatchObject({ code: 'self_lockout', status: 409 });
    await expect(
      service.update({
        id: bootstrapActorId,
        role: 'readonly',
        expectedRevision: 1,
        actorId: externalActor.id,
      }),
    ).rejects.toMatchObject({ code: 'last_active_admin', status: 409 });
    expect(await actorAuditCount()).toBe(auditCountBeforeLastAdminFailures);

    const secondAdmin = await repository.createActor({
      id: 'actor-administration-admin-2',
      identity: 'access:actor-administration-admin-2',
      displayName: 'Actor Administration Admin 2',
      role: 'admin',
      actorId: bootstrapActorId,
    });
    const selfDemoted = await service.update({
      id: bootstrapActorId,
      role: 'readonly',
      expectedRevision: 1,
      actorId: bootstrapActorId,
    });
    expect(selfDemoted).toMatchObject({ role: 'readonly', active: true, revision: 2 });

    const thirdAdmin = await repository.createActor({
      id: 'actor-administration-admin-3',
      identity: 'service:actor-administration-admin-3',
      displayName: 'Actor Administration Admin 3',
      role: 'admin',
      actorId: secondAdmin.id,
    });
    await repository.updateActor({
      id: secondAdmin.id,
      role: 'readonly',
      expectedRevision: secondAdmin.revision,
      actorId: secondAdmin.id,
    });
    const fourthAdmin = await repository.createActor({
      id: 'actor-administration-admin-4',
      identity: 'access:actor-administration-admin-4',
      displayName: 'Actor Administration Admin 4',
      role: 'admin',
      actorId: thirdAdmin.id,
    });

    const auditCountBeforeConcurrentDemotion = await actorAuditCount();
    const results = await Promise.allSettled([
      repository.updateActor({
        id: thirdAdmin.id,
        role: 'readonly',
        expectedRevision: thirdAdmin.revision,
        actorId: thirdAdmin.id,
      }),
      repository.updateActor({
        id: fourthAdmin.id,
        role: 'readonly',
        expectedRevision: fourthAdmin.revision,
        actorId: fourthAdmin.id,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'self_lockout', status: 409 },
    });
    expect(await activeAdminCount()).toBe(1);
    expect(await actorAuditCount()).toBe(auditCountBeforeConcurrentDemotion + 1);
  });
});

async function actorAuditCount(): Promise<number> {
  const result = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM events WHERE event_type LIKE 'actor.%'`,
  ).first<{ count: number }>();
  if (result === null) throw new Error('Actor audit count query returned no row.');
  return result.count;
}

async function activeAdminCount(): Promise<number> {
  const result = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM actors WHERE role = 'admin' AND active = 1`,
  ).first<{ count: number }>();
  if (result === null) throw new Error('Active administrator count query returned no row.');
  return result.count;
}
