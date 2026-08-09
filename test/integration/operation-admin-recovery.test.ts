import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

type JsonRecord = Record<string, unknown>;

const adminIdentity = 'access:recovery-admin';
const operatorIdentity = 'access:recovery-operator';
const provisionerIdentity = 'access:recovery-provisioner';

function asRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object JSON response.');
  }
  return value as JsonRecord;
}

function headers(identity: string, json = false): Headers {
  const result = new Headers({
    host: 'localhost',
    'x-global-registry-dev-secret': env.LOCAL_AUTH_SECRET,
    'x-global-registry-dev-identity': identity,
    Accept: 'application/json',
  });
  if (json) result.set('content-type', 'application/json');
  return result;
}

async function request(identity: string, path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: headers(identity, init?.body !== undefined),
    }),
  );
}

describe.sequential('Operation administrative recovery', () => {
  beforeAll(async () => {
    const createdAt = new Date().toISOString();
    await env.DB.batch([
      actorStatement('actor-recovery-admin', adminIdentity, 'Recovery Admin', 'admin', createdAt),
      actorStatement(
        'actor-recovery-operator',
        operatorIdentity,
        'Recovery Operator',
        'operator',
        createdAt,
      ),
      actorStatement(
        'actor-recovery-provisioner',
        provisionerIdentity,
        'Recovery Provisioner',
        'provisioner',
        createdAt,
      ),
    ]);
    const location = await request(adminIdentity, '/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify({
        key: 'recovery-site',
        kind: 'location',
        kindVersion: 1,
        name: 'Recovery Site',
        placement: {},
        specOverrides: { category: 'site' },
      }),
    });
    expect(location.status).toBe(201);
  });

  it('rejects recovery of an operation that is not running', async () => {
    await createResource('recovery-planned');
    const operation = await createOperation('recovery-planned');
    const response = await forceCancel(adminIdentity, operation.id, 1, 'Owner unavailable');

    expect(response.status).toBe(409);
    expect(asRecord(await response.json()).error).toMatchObject({
      code: 'operation_recovery_not_running',
    });
  });

  it('allows only an admin to cancel a running operation and preserves its lock snapshot', async () => {
    await createResource('recovery-running');
    const running = await createRunningOperation('recovery-running');
    const lockBefore = await env.DB.prepare(
      `SELECT scope, operation_id, actor_id, fencing_token, expires_at, created_at, updated_at
       FROM resource_locks WHERE operation_id = ?`,
    )
      .bind(running.id)
      .first<{
        scope: string;
        operation_id: string;
        actor_id: string;
        fencing_token: number;
        expires_at: string;
        created_at: string;
        updated_at: string;
      }>();
    expect(lockBefore).not.toBeNull();
    if (lockBefore === null) throw new Error('Running operation lock was not created.');

    for (const identity of [provisionerIdentity, operatorIdentity]) {
      const forbidden = await forceCancel(identity, running.id, 2, 'Owner unavailable');
      expect(forbidden.status).toBe(403);
      expect(asRecord(await forbidden.json()).error).toMatchObject({ code: 'forbidden' });
    }

    const missingReason = await forceCancel(adminIdentity, running.id, 2, '   ');
    expect(missingReason.status).toBe(422);

    const stale = await forceCancel(adminIdentity, running.id, 1, 'Owner unavailable');
    expect(stale.status).toBe(409);
    expect(asRecord(await stale.json()).error).toMatchObject({ code: 'revision_conflict' });
    expect(
      await env.DB.prepare('SELECT scope FROM resource_locks WHERE operation_id = ?')
        .bind(running.id)
        .first(),
    ).not.toBeNull();

    const recovered = await forceCancel(
      adminIdentity,
      running.id,
      2,
      '  The creator service identity was retired.  ',
    );
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      id: running.id,
      actorId: 'actor-recovery-provisioner',
      status: 'cancelled',
      revision: 3,
      planHash: running.planHash,
    });

    expect(
      await env.DB.prepare('SELECT scope FROM resource_locks WHERE operation_id = ?')
        .bind(running.id)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT lifecycle_state, revision FROM resources WHERE key = 'recovery-running'`,
      ).first(),
    ).toEqual({ lifecycle_state: 'absent', revision: 1 });
    expect(
      await env.DB.prepare('SELECT status, revision FROM operation_steps WHERE operation_id = ?')
        .bind(running.id)
        .first(),
    ).toEqual({ status: 'planned', revision: 1 });

    const audit = await env.DB.prepare(
      `SELECT event.actor_id, event.payload_json, outbox.topic
       FROM events event JOIN outbox ON outbox.event_id = event.event_id
       WHERE event.operation_id = ? AND event.event_type = 'operation.force_cancelled'`,
    )
      .bind(running.id)
      .first<{ actor_id: string; payload_json: string; topic: string }>();
    expect(audit).not.toBeNull();
    expect(audit?.actor_id).toBe('actor-recovery-admin');
    expect(audit?.topic).toBe('global-registry.operation.force_cancelled');
    expect(JSON.parse(audit?.payload_json ?? '{}')).toEqual({
      from: 'running',
      to: 'cancelled',
      reason: 'The creator service identity was retired.',
      ownerActorId: 'actor-recovery-provisioner',
      expectedRevision: 2,
      resultingRevision: 3,
      lockSnapshot: [
        {
          scope: lockBefore.scope,
          operationId: lockBefore.operation_id,
          actorId: lockBefore.actor_id,
          fencingToken: lockBefore.fencing_token,
          expiresAt: lockBefore.expires_at,
          createdAt: lockBefore.created_at,
          updatedAt: lockBefore.updated_at,
        },
      ],
    });

    const oldPlanLock = await request(
      provisionerIdentity,
      `/api/v1/operations/${running.id}/locks`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resource/recovery-running'], leaseSeconds: 120 }),
      },
    );
    expect(oldPlanLock.status).toBe(409);
    expect(asRecord(await oldPlanLock.json()).error).toMatchObject({
      code: 'operation_not_lockable',
    });

    const replacement = await createOperation('recovery-running');
    expect(replacement.id).not.toBe(running.id);
    const replacementLock = await acquireLock(replacement.id, 'recovery-running');
    expect(replacementLock.fencingToken).toBeGreaterThan(lockBefore.fencing_token);
    expect(
      await env.DB.prepare(
        `SELECT generation FROM resource_lock_generations WHERE scope = 'resource/recovery-running'`,
      ).first(),
    ).toEqual({ generation: replacementLock.fencingToken });
  });

  it('rolls back status, audit, outbox, and lock release when outbox recording fails', async () => {
    await createResource('recovery-rollback');
    const running = await createRunningOperation('recovery-rollback');
    const outboxBefore = await env.DB.prepare(
      `SELECT count(*) AS count FROM outbox
       WHERE topic = 'global-registry.operation.force_cancelled'`,
    ).first<{ count: number }>();
    await env.DB.prepare(
      `CREATE TRIGGER reject_force_cancel_outbox
       BEFORE INSERT ON outbox
       WHEN NEW.topic = 'global-registry.operation.force_cancelled'
       BEGIN
         SELECT RAISE(ABORT, 'force_cancel_outbox_test_failure');
       END`,
    ).run();
    try {
      const response = await forceCancel(adminIdentity, running.id, 2, 'Owner unavailable');
      expect(response.status).toBe(500);
    } finally {
      await env.DB.prepare('DROP TRIGGER reject_force_cancel_outbox').run();
    }

    expect(
      await env.DB.prepare('SELECT status, revision FROM operations WHERE id = ?')
        .bind(running.id)
        .first(),
    ).toEqual({ status: 'running', revision: 2 });
    expect(
      await env.DB.prepare('SELECT scope FROM resource_locks WHERE operation_id = ?')
        .bind(running.id)
        .first(),
    ).not.toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM events
         WHERE operation_id = ? AND event_type = 'operation.force_cancelled'`,
      )
        .bind(running.id)
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM outbox
         WHERE topic = 'global-registry.operation.force_cancelled'`,
      ).first(),
    ).toEqual(outboxBefore);
  });
});

function actorStatement(
  id: string,
  identity: string,
  displayName: string,
  role: 'admin' | 'operator' | 'provisioner',
  createdAt: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO actors (
      id, identity, display_name, role, active, revision,
      created_at, updated_at, created_by, updated_by
    ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
  ).bind(id, identity, displayName, role, createdAt, createdAt, id, id);
}

async function createResource(key: string): Promise<void> {
  const response = await request(adminIdentity, '/api/v1/resources', {
    method: 'POST',
    body: JSON.stringify({
      key,
      kind: 'compute',
      kindVersion: 1,
      name: key,
      placement: { locationKey: 'recovery-site' },
      specOverrides: {
        substrate: 'vm',
        architecture: 'amd64',
        vcpu: 2,
        memoryMiB: 4096,
      },
    }),
  });
  expect(response.status).toBe(201);
}

async function createOperation(resourceKey: string): Promise<{ id: string; planHash: string }> {
  const response = await request(provisionerIdentity, '/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'recovery-test',
      intent: { recoveryTest: true },
      resources: [
        {
          resourceKey,
          sourceState: 'absent',
          targetState: 'allocated',
          resourceRevision: 1,
        },
      ],
      steps: [{ position: 0, name: 'Allocate', gate: { lockRequired: true } }],
    }),
  });
  expect(response.status).toBe(201);
  const operation = asRecord(await response.json());
  return { id: String(operation.id), planHash: String(operation.planHash) };
}

async function acquireLock(
  operationId: string,
  resourceKey: string,
): Promise<{ fencingToken: number }> {
  const response = await request(provisionerIdentity, `/api/v1/operations/${operationId}/locks`, {
    method: 'POST',
    body: JSON.stringify({ scopes: [`resource/${resourceKey}`], leaseSeconds: 120 }),
  });
  expect(response.status).toBe(201);
  const items = asRecord(await response.json()).items as JsonRecord[];
  return { fencingToken: Number(items[0]?.fencingToken) };
}

async function createRunningOperation(
  resourceKey: string,
): Promise<{ id: string; planHash: string; fencingToken: number }> {
  const operation = await createOperation(resourceKey);
  const lock = await acquireLock(operation.id, resourceKey);
  const start = await request(provisionerIdentity, `/api/v1/operations/${operation.id}/start`, {
    method: 'POST',
    body: JSON.stringify({
      expectedRevision: 1,
      lockScope: `resource/${resourceKey}`,
      fencingToken: lock.fencingToken,
    }),
  });
  expect(start.status).toBe(200);
  return { ...operation, fencingToken: lock.fencingToken };
}

function forceCancel(
  identity: string,
  operationId: string,
  expectedRevision: number,
  reason: string,
): Promise<Response> {
  return request(identity, `/api/v1/operations/${operationId}/force-cancel`, {
    method: 'POST',
    body: JSON.stringify({ expectedRevision, reason }),
  });
}
