import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_EXPORT_ATTEMPTS,
  MAX_OUTBOX_CONSUMER_ATTEMPTS,
  PORTABLE_EXPORT_SCHEMA_VERSION,
} from '../../src/application/limits';
import { consumeOutboxBatch } from '../../src/adapters/queue/outbox-consumer';
import { EXPORT_LEASE_MS } from '../../src/adapters/d1/exports';
import { D1GlobalRegistryRepository } from '../../src/adapters/d1/repository';
import {
  assertPortableExportChunk,
  assertPortableExportManifest,
  manifestChecksumPayload,
  PORTABLE_EXPORT_ENTITIES,
  type PortableExportManifest,
} from '../../src/application/registry-snapshot';
import { R2ExportWriter } from '../../src/adapters/r2/exporter';

const actorId = 'export-recovery-admin';
const claimedAt = '2026-08-01T00:00:00.000Z';
const expiredLease = '2026-07-31T23:00:00.000Z';

interface ExportRowState {
  status: 'planned' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  revision: number;
  lease_until: string | null;
  error_message: string | null;
  r2_object_key: string | null;
  claim_token: string | null;
  claim_object_key: string | null;
  r2_claim_token: string | null;
}

function exportsBucket(): R2Bucket {
  if (env.EXPORTS_BUCKET === undefined) throw new Error('test R2 binding is unavailable');
  return env.EXPORTS_BUCKET;
}

async function checksum(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

async function exportState(exportId: string): Promise<ExportRowState> {
  const row = await env.DB.prepare(
    `SELECT status, attempts, revision, lease_until, error_message, r2_object_key,
            claim_token, claim_object_key, r2_claim_token
       FROM exports WHERE id = ?`,
  )
    .bind(exportId)
    .first<ExportRowState>();
  if (row === null) throw new Error(`Export ${exportId} was not found.`);
  return row;
}

async function seedRunningAtLimit(repository: D1GlobalRegistryRepository): Promise<string> {
  const exportRecord = await repository.createExport(actorId);
  const claimToken = crypto.randomUUID();
  const claimObjectKey = `exports/${encodeURIComponent(exportRecord.id)}/7-${claimToken}/manifest.json`;
  await env.DB.prepare(
    `UPDATE exports
        SET status = 'running', attempts = ?, lease_until = ?, revision = ?,
            checksum = NULL, r2_object_key = NULL, r2_claim_token = NULL,
            claim_token = ?, claim_object_key = ?, completed_at = NULL,
            error_message = NULL, expired_at = NULL, updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      MAX_EXPORT_ATTEMPTS,
      expiredLease,
      7,
      claimToken,
      claimObjectKey,
      claimedAt,
      exportRecord.id,
    )
    .run();
  return exportRecord.id;
}

async function seedFailedAtLimit(repository: D1GlobalRegistryRepository): Promise<string> {
  const exportRecord = await repository.createExport(actorId);
  await env.DB.prepare(
    `UPDATE exports
        SET status = 'failed', attempts = ?, lease_until = NULL, revision = ?,
            checksum = NULL, r2_object_key = NULL, completed_at = NULL,
            error_message = 'export_processing_failed', expired_at = NULL, updated_at = ?
      WHERE id = ?`,
  )
    .bind(MAX_EXPORT_ATTEMPTS, 11, claimedAt, exportRecord.id)
    .run();
  return exportRecord.id;
}

async function seedFailedBeforeLimit(repository: D1GlobalRegistryRepository): Promise<string> {
  const exportRecord = await repository.createExport(actorId);
  await env.DB.prepare(
    `UPDATE exports
        SET status = 'failed', attempts = ?, lease_until = NULL, revision = ?,
            checksum = NULL, r2_object_key = NULL, completed_at = NULL,
            error_message = 'export_processing_failed', expired_at = NULL, updated_at = ?
      WHERE id = ?`,
  )
    .bind(MAX_EXPORT_ATTEMPTS - 1, 13, claimedAt, exportRecord.id)
    .run();
  return exportRecord.id;
}

async function requestedEventId(exportId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT event_id
       FROM events
      WHERE event_type = 'export.requested'
        AND json_extract(payload_json, '$.exportId') = ?
      ORDER BY occurred_at DESC
      LIMIT 1`,
  )
    .bind(exportId)
    .first<{ event_id: string }>();
  if (row === null) throw new Error(`Export request event for ${exportId} was not found.`);
  return row.event_id;
}

interface OutboxDispatchMessage {
  eventId: string;
  dispatchToken: string;
}

async function prepareFinalOutboxDelivery(exportId: string): Promise<OutboxDispatchMessage> {
  const eventId = await requestedEventId(exportId);
  const dispatchToken = crypto.randomUUID();
  await env.DB.prepare(
    `UPDATE outbox
        SET status = 'pending', consumer_attempts = ?, last_error = NULL,
            dispatch_token = ?, updated_at = ?, revision = revision + 1
      WHERE event_id = ?`,
  )
    .bind(MAX_OUTBOX_CONSUMER_ATTEMPTS - 1, dispatchToken, claimedAt, eventId)
    .run();
  return { eventId, dispatchToken };
}

async function prepareStaleDispatchingOutboxDelivery(
  exportId: string,
): Promise<OutboxDispatchMessage> {
  const eventId = await requestedEventId(exportId);
  const dispatchToken = crypto.randomUUID();
  await env.DB.prepare(
    `UPDATE outbox
        SET status = 'dispatching', consumer_attempts = ?, last_error = NULL,
            dispatch_token = ?, updated_at = ?, revision = revision + 1
      WHERE event_id = ?`,
  )
    .bind(MAX_OUTBOX_CONSUMER_ATTEMPTS - 1, dispatchToken, expiredLease, eventId)
    .run();
  return { eventId, dispatchToken };
}

async function putObject(
  exportId: string,
  body = '{"stale":true}',
  metadata: Record<string, string> = {},
): Promise<{ key: string; digest: string; prefix: string; keys: string[]; body: string }> {
  const claim = await env.DB.prepare(
    'SELECT revision, claim_token, claim_object_key FROM exports WHERE id = ?',
  )
    .bind(exportId)
    .first<{ revision: number; claim_token: string; claim_object_key: string }>();
  if (claim === null) throw new Error(`Export claim for ${exportId} was not found.`);
  const key = claim.claim_object_key;
  if (!key.endsWith('manifest.json')) throw new Error('Expected a manifest claim key.');
  const prefix = key.slice(0, -'manifest.json'.length);
  const chunkKey = `${prefix}events-000001.json`;
  const digest = await checksum(body);
  await exportsBucket().put(chunkKey, '{"staleChunk":true}', {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: {
      exportId,
      schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
      claimToken: claim.claim_token,
      revision: String(claim.revision),
    },
  });
  await exportsBucket().put(key, body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: {
      exportId,
      checksum: digest,
      schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
      claimToken: claim.claim_token,
      revision: String(claim.revision),
      ...metadata,
    },
  });
  return { key, digest, prefix, keys: [chunkKey, key], body };
}

async function readManifest(key: string): Promise<PortableExportManifest> {
  const object = await exportsBucket().get(key);
  if (object === null) throw new Error(`Manifest ${key} was not found.`);
  const manifest = assertPortableExportManifest(JSON.parse(await object.text()));
  expect(manifest.checksum).toBe(await checksum(manifestChecksumPayload(manifest)));
  for (const reference of manifest.chunks) {
    const chunkObject = await exportsBucket().get(reference.key);
    expect(chunkObject).not.toBeNull();
    const body = await chunkObject?.text();
    expect(reference.checksum).toBe(await checksum(body ?? ''));
    const chunk = assertPortableExportChunk(JSON.parse(body ?? 'null'));
    expect(chunk).toMatchObject({
      exportId: manifest.exportId,
      entity: reference.entity,
      sequence: reference.sequence,
    });
    expect(chunk.rows).toHaveLength(reference.rows);
  }
  return manifest;
}

function oneMessageBatch(
  message: OutboxDispatchMessage,
  calls: string[],
): MessageBatch<OutboxDispatchMessage> {
  return {
    messages: [
      {
        body: message,
        ack: () => calls.push('ack'),
        retry: () => calls.push('retry'),
      },
    ],
  } as unknown as MessageBatch<OutboxDispatchMessage>;
}

describe.sequential('D1 export recovery', () => {
  beforeAll(async () => {
    const timestamp = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO actors (
        id, identity, display_name, role, active, revision,
        created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, 'admin', 1, 1, ?, ?, ?, ?)`,
    )
      .bind(
        actorId,
        'access:export-recovery-admin',
        'Export Recovery Admin',
        timestamp,
        timestamp,
        actorId,
        actorId,
      )
      .run();
  });

  it('claims an expired max-attempt lease as non-incrementing recovery', async () => {
    const repository = new D1GlobalRegistryRepository(env.DB);
    const exportId = await seedRunningAtLimit(repository);
    const before = await exportState(exportId);

    const attempt = await repository.claimExport(exportId, claimedAt);

    expect(attempt).toMatchObject({
      exportId,
      revision: before.revision + 1,
      attempt: MAX_EXPORT_ATTEMPTS,
      objectKey: expect.stringContaining(`/${before.revision + 1}-`),
      claimToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
      recovery: true,
    });
    expect(attempt?.supersededClaim).toMatchObject({
      revision: before.revision,
      objectKey: before.claim_object_key,
      claimToken: before.claim_token,
    });
    const after = await exportState(exportId);
    expect(after).toMatchObject({
      status: 'running',
      attempts: MAX_EXPORT_ATTEMPTS,
      revision: before.revision + 1,
      lease_until: new Date(Date.parse(claimedAt) + EXPORT_LEASE_MS).toISOString(),
    });
  });

  it('does not claim an active lease', async () => {
    const repository = new D1GlobalRegistryRepository(env.DB);
    const exportRecord = await repository.createExport(actorId);

    const first = await repository.claimExport(exportRecord.id, claimedAt);
    expect(first).not.toBeNull();
    const before = await exportState(exportRecord.id);

    const second = await repository.claimExport(exportRecord.id, claimedAt);

    expect(second).toBeNull();
    expect(await exportState(exportRecord.id)).toEqual(before);
  });

  it('uses the current chunked schema when retrying an export created by an older release', async () => {
    const repository = new D1GlobalRegistryRepository(env.DB);
    const exportRecord = await repository.createExport(actorId);
    await env.DB.prepare("UPDATE exports SET schema_version = '1.1' WHERE id = ?")
      .bind(exportRecord.id)
      .run();

    const attempt = await repository.claimExport(exportRecord.id, claimedAt);

    expect(attempt).not.toBeNull();
    expect(await repository.getExport(exportRecord.id)).toMatchObject({
      schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
      status: 'running',
    });
  });

  it('does not reclaim a failed export at the attempt bound', async () => {
    const repository = new D1GlobalRegistryRepository(env.DB);
    const exportId = await seedFailedAtLimit(repository);
    const before = await exportState(exportId);

    const attempt = await repository.claimExport(exportId, claimedAt);

    expect(attempt).toBeNull();
    expect(await exportState(exportId)).toEqual(before);
  });

  it('exports more than 1,000 audit and outbox rows as bounded consecutive chunks', async () => {
    const timestamp = '2026-08-01T00:00:00.000Z';
    for (let offset = 0; offset < 1_001; offset += 50) {
      const statements: D1PreparedStatement[] = [];
      for (let index = offset; index < Math.min(offset + 50, 1_001); index += 1) {
        const suffix = String(index).padStart(4, '0');
        const payload = JSON.stringify({ index });
        statements.push(
          env.DB.prepare(
            `INSERT INTO events (
               event_id, event_type, actor_id, payload_json, occurred_at
             ) VALUES (?, 'test.export.scale', ?, ?, ?)`,
          ).bind(`evt_export_scale_${suffix}`, actorId, payload, timestamp),
          env.DB.prepare(
            `INSERT INTO outbox (
               id, event_id, topic, payload_json, created_at, updated_at
             ) VALUES (?, ?, 'test.export.scale', ?, ?, ?)`,
          ).bind(
            `out_export_scale_${suffix}`,
            `evt_export_scale_${suffix}`,
            payload,
            timestamp,
            timestamp,
          ),
        );
      }
      await env.DB.batch(statements);
    }
    const repository = new D1GlobalRegistryRepository(env.DB);
    const requested = await repository.createExport(actorId);

    await new R2ExportWriter(repository, exportsBucket()).write(requested.id);

    const completed = await repository.getExport(requested.id);
    const manifest = await readManifest(completed?.r2ObjectKey ?? '');
    for (const entity of ['events', 'outbox'] as const) {
      const references = manifest.chunks.filter((chunk) => chunk.entity === entity);
      expect(references.length).toBeGreaterThan(1);
      expect(references.map((chunk) => chunk.sequence)).toEqual(
        Array.from({ length: references.length }, (_, index) => index + 1),
      );
      expect(references.every((chunk) => chunk.rows <= 1_000)).toBe(true);
      expect(references.reduce((total, chunk) => total + chunk.rows, 0)).toBeGreaterThan(1_000);
    }
  });

  it('writes a fenced canonical R2 body during stale recovery', async () => {
    const repository = new D1GlobalRegistryRepository(env.DB);
    const exportId = await seedRunningAtLimit(repository);
    const object = await putObject(exportId);

    await new R2ExportWriter(repository, exportsBucket()).write(exportId);

    const completed = await repository.getExport(exportId);
    expect(completed).toMatchObject({
      id: exportId,
      status: 'succeeded',
      attempts: MAX_EXPORT_ATTEMPTS,
    });
    expect(completed?.r2ObjectKey).not.toBe(object.key);
    for (const key of object.keys) expect(await exportsBucket().get(key)).toBeNull();
    const manifest = await readManifest(completed?.r2ObjectKey ?? '');
    expect(new Set(manifest.chunks.map((chunk) => chunk.entity))).toEqual(
      new Set(PORTABLE_EXPORT_ENTITIES),
    );
    const stored = await exportsBucket().get(completed?.r2ObjectKey ?? '');
    expect(completed?.checksum).toBe(await checksum((await stored?.text()) ?? ''));
    expect(completed?.checksum).not.toBe(manifest.checksum);
    const storedMetadata = (await exportsBucket().head(completed?.r2ObjectKey ?? ''))
      ?.customMetadata;
    expect(storedMetadata).toMatchObject({
      exportId,
      checksum: completed?.checksum,
      manifestChecksum: manifest.checksum,
      schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
      objectType: 'portable-export-manifest',
    });
    expect(storedMetadata?.claimToken).toBe((await exportState(exportId)).r2_claim_token);
  });

  it('reaches stale export recovery on the sixth outbox delivery and acknowledges success', async () => {
    const repository = new D1GlobalRegistryRepository(env.DB);
    const exportId = await seedRunningAtLimit(repository);
    const object = await putObject(exportId);
    const message = await prepareFinalOutboxDelivery(exportId);
    const calls: string[] = [];

    expect(MAX_OUTBOX_CONSUMER_ATTEMPTS).toBe(MAX_EXPORT_ATTEMPTS + 1);
    await consumeOutboxBatch(
      oneMessageBatch(message, calls),
      repository,
      new R2ExportWriter(repository, exportsBucket()),
    );

    expect(calls).toEqual(['ack']);
    const completed = await repository.getExport(exportId);
    expect(completed).toMatchObject({
      status: 'succeeded',
      attempts: MAX_EXPORT_ATTEMPTS,
    });
    for (const key of object.keys) expect(await exportsBucket().get(key)).toBeNull();
    const manifest = await readManifest(completed?.r2ObjectKey ?? '');
    const stored = await exportsBucket().get(completed?.r2ObjectKey ?? '');
    expect(completed?.checksum).toBe(await checksum((await stored?.text()) ?? ''));
    expect(completed?.checksum).not.toBe(manifest.checksum);
    expect(await repository.getOutboxEventStatus(message.eventId)).toBe('published');
    const outbox = await env.DB.prepare(
      'SELECT consumer_attempts, producer_attempts FROM outbox WHERE event_id = ?',
    )
      .bind(message.eventId)
      .first<{ consumer_attempts: number; producer_attempts: number }>();
    expect(outbox).toEqual({
      consumer_attempts: MAX_OUTBOX_CONSUMER_ATTEMPTS,
      producer_attempts: 0,
    });
  });

  it('reclaims a stale dispatching outbox lease after worker interruption', async () => {
    const repository = new D1GlobalRegistryRepository(env.DB);
    const exportId = await seedRunningAtLimit(repository);
    await putObject(exportId);
    const message = await prepareStaleDispatchingOutboxDelivery(exportId);
    const calls: string[] = [];

    await consumeOutboxBatch(
      oneMessageBatch(message, calls),
      repository,
      new R2ExportWriter(repository, exportsBucket()),
    );

    expect(calls).toEqual(['ack']);
    expect(await repository.getExport(exportId)).toMatchObject({ status: 'succeeded' });
    expect(await repository.getOutboxEventStatus(message.eventId)).toBe('published');
  });

  it('cleans a final R2 put when D1 completion fails and leaves the message unacknowledged', async () => {
    const repository = new D1GlobalRegistryRepository(env.DB);
    const exportId = await seedFailedBeforeLimit(repository);
    const message = await prepareFinalOutboxDelivery(exportId);
    const calls: string[] = [];
    await env.DB.prepare(
      `CREATE TRIGGER reject_export_completion
       BEFORE UPDATE OF status ON exports
       WHEN NEW.status = 'succeeded'
       BEGIN
         SELECT RAISE(ABORT, 'export_completion_injected');
       END`,
    ).run();

    try {
      await consumeOutboxBatch(
        oneMessageBatch(message, calls),
        repository,
        new R2ExportWriter(repository, exportsBucket()),
      );
    } finally {
      await env.DB.prepare('DROP TRIGGER reject_export_completion').run();
    }

    expect(calls).toEqual(['retry']);
    const failed = await exportState(exportId);
    expect(failed.r2_object_key).toBeNull();
    expect(failed.claim_object_key).toBeNull();
    expect(await repository.getExport(exportId)).toMatchObject({
      status: 'failed',
      attempts: MAX_EXPORT_ATTEMPTS,
      errorMessage: 'export_processing_failed',
    });
    expect(await repository.getOutboxEventStatus(message.eventId)).toBe('failed');
  });

  it('recovers a final stale claim even when its old object is missing', async () => {
    const repository = new D1GlobalRegistryRepository(env.DB);
    const exportId = await seedRunningAtLimit(repository);
    const message = await prepareFinalOutboxDelivery(exportId);
    const calls: string[] = [];

    await consumeOutboxBatch(
      oneMessageBatch(message, calls),
      repository,
      new R2ExportWriter(repository, exportsBucket()),
    );

    expect(calls).toEqual(['ack']);
    expect(await repository.getExport(exportId)).toMatchObject({
      status: 'succeeded',
      attempts: MAX_EXPORT_ATTEMPTS,
    });
    expect(await repository.getOutboxEventStatus(message.eventId)).toBe('published');
  });

  it('replaces a mismatched old final-recovery object with the fenced winner', async () => {
    const repository = new D1GlobalRegistryRepository(env.DB);
    const exportId = await seedRunningAtLimit(repository);
    const message = await prepareFinalOutboxDelivery(exportId);
    await putObject(exportId, '{"wrong":true}', {
      checksum: `sha256:${'0'.repeat(64)}`,
    });
    const calls: string[] = [];

    await consumeOutboxBatch(
      oneMessageBatch(message, calls),
      repository,
      new R2ExportWriter(repository, exportsBucket()),
    );

    expect(calls).toEqual(['ack']);
    expect(await repository.getExport(exportId)).toMatchObject({
      status: 'succeeded',
      attempts: MAX_EXPORT_ATTEMPTS,
    });
    expect(await repository.getOutboxEventStatus(message.eventId)).toBe('published');
  });
});
