import { describe, expect, it } from 'vitest';
import {
  MAX_EXPORT_ATTEMPTS,
  MAX_EXPORT_RETENTION_WORK,
  MAX_PORTABLE_EXPORT_OBJECT_BYTES,
  MAX_PORTABLE_EXPORT_ROWS_PER_CHUNK,
  PORTABLE_EXPORT_SCHEMA_VERSION,
} from '../../src/application/limits';
import type { ExportPersistencePort, OutboxPersistencePort } from '../../src/application/ports';
import {
  assertPortableExportChunk,
  assertPortableExportManifest,
  manifestChecksumPayload,
  PORTABLE_EXPORT_ENTITIES,
  serializePortableExportObject,
  type PortableExportChunk,
  type PortableExportManifest,
} from '../../src/application/registry-snapshot';
import { D1Exports } from '../../src/adapters/d1/exports';
import { consumeOutboxBatch } from '../../src/adapters/queue/outbox-consumer';
import { R2ExportWriter } from '../../src/adapters/r2/exporter';
import type { ExportRecord } from '../../src/domain/models/global-registry';

interface StoredObject {
  body: string;
  customMetadata: Record<string, string>;
}

class MemoryExportStore implements ExportPersistencePort {
  readonly records = new Map<string, ExportRecord>();
  readonly claims = new Map<string, { revision: number; objectKey: string; claimToken: string }>();
  failNextCompletion = false;
  throwAfterCompletion = false;
  invalidChunk = false;
  sourceValidationCalls = 0;
  renewalCalls = 0;
  beforeCompletion:
    | ((input: {
        exportId: string;
        revision: number;
        objectKey: string;
        claimToken: string;
      }) => Promise<void>)
    | undefined;

  constructor() {
    this.records.set('exp-test', {
      id: 'exp-test',
      schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
      status: 'planned',
      attempts: 0,
      revision: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      requestedBy: 'actor-admin',
    });
  }

  async getExport(id: string): Promise<ExportRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : { ...record };
  }

  async claimExport(id: string, claimedAt = new Date().toISOString()) {
    const record = this.records.get(id);
    if (record === undefined || record.status === 'succeeded' || record.expiredAt !== undefined) {
      return null;
    }
    if (
      record.status === 'running' &&
      record.leaseUntil !== undefined &&
      record.leaseUntil > claimedAt
    ) {
      return null;
    }
    const recovery = record.attempts >= MAX_EXPORT_ATTEMPTS;
    if (recovery && record.status !== 'running') return null;
    const previousClaim =
      record.status === 'running' && this.claims.get(id) !== undefined
        ? this.claims.get(id)
        : undefined;
    record.status = 'running';
    if (!recovery) record.attempts += 1;
    record.revision += 1;
    record.leaseUntil = new Date(Date.parse(claimedAt) + 5 * 60_000).toISOString();
    delete record.errorMessage;
    const claimToken = crypto.randomUUID();
    const objectKey = `exports/${encodeURIComponent(id)}/${record.revision}-${claimToken}/manifest.json`;
    this.claims.set(id, { revision: record.revision, objectKey, claimToken });
    return {
      exportId: id,
      revision: record.revision,
      attempt: record.attempts,
      objectKey,
      claimToken,
      ...(previousClaim === undefined ? {} : { supersededClaim: previousClaim }),
      recovery,
    };
  }

  async validatePortableExportSource(): Promise<void> {
    this.sourceValidationCalls += 1;
  }

  async renewExportLease(input: {
    exportId: string;
    revision: number;
    objectKey: string;
    claimToken: string;
  }): Promise<void> {
    this.renewalCalls += 1;
    const record = this.records.get(input.exportId);
    const claim = this.claims.get(input.exportId);
    if (
      record?.status !== 'running' ||
      record.revision !== input.revision ||
      claim?.objectKey !== input.objectKey ||
      claim.claimToken !== input.claimToken
    ) {
      throw new Error('export_lease_conflict');
    }
    record.leaseUntil = new Date(Date.now() + 5 * 60_000).toISOString();
  }

  async *readPortableExportChunks(exportId: string): AsyncIterable<PortableExportChunk> {
    for (const entity of PORTABLE_EXPORT_ENTITIES) {
      yield assertPortableExportChunk({
        schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
        exportId,
        entity,
        sequence: 1,
        rows: this.invalidChunk && entity === 'actors' ? [{ bad: true }] : [],
      });
    }
  }

  async completeExport(input: {
    exportId: string;
    revision: number;
    checksum: string;
    objectKey: string;
    claimToken: string;
  }): Promise<void> {
    const completionHook = this.beforeCompletion;
    this.beforeCompletion = undefined;
    if (completionHook !== undefined) await completionHook(input);
    if (this.failNextCompletion) {
      this.failNextCompletion = false;
      throw new Error('injected_d1_completion_failure');
    }
    const record = this.records.get(input.exportId);
    const claim = this.claims.get(input.exportId);
    if (
      record === undefined ||
      record.revision !== input.revision ||
      record.status !== 'running' ||
      claim?.claimToken !== input.claimToken ||
      claim.objectKey !== input.objectKey
    ) {
      throw new Error('export_lease_conflict');
    }
    record.status = 'succeeded';
    record.checksum = input.checksum;
    record.r2ObjectKey = input.objectKey;
    record.completedAt = new Date().toISOString();
    delete record.leaseUntil;
    record.revision += 1;
    this.claims.delete(input.exportId);
    if (this.throwAfterCompletion) {
      this.throwAfterCompletion = false;
      throw new Error('injected_completion_response_loss');
    }
  }

  async failExport(input: {
    exportId: string;
    revision: number;
    claimToken: string;
    errorCode: string;
  }): Promise<void> {
    const record = this.records.get(input.exportId);
    if (record === undefined || record.status === 'succeeded') return;
    const claim = this.claims.get(input.exportId);
    if (
      record.revision !== input.revision ||
      record.status !== 'running' ||
      claim?.claimToken !== input.claimToken
    ) {
      throw new Error('export_lease_conflict');
    }
    record.status = 'failed';
    record.errorMessage = input.errorCode;
    delete record.leaseUntil;
    record.revision += 1;
    this.claims.delete(input.exportId);
  }

  async listRetainableExports(
    _referenceTime: string,
    limit = MAX_EXPORT_RETENTION_WORK,
  ): Promise<ExportRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.status === 'succeeded' &&
          record.r2ObjectKey !== undefined &&
          record.expiredAt === undefined,
      )
      .sort((left, right) =>
        `${left.completedAt ?? ''}${left.id}`.localeCompare(
          `${right.completedAt ?? ''}${right.id}`,
        ),
      )
      .slice(0, limit);
  }

  async markExportExpired(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (record === undefined || record.expiredAt !== undefined) return false;
    record.expiredAt = new Date().toISOString();
    this.claims.delete(id);
    return true;
  }
}

function memoryBucket(): {
  bucket: R2Bucket;
  objects: Map<string, StoredObject>;
  putKeys: string[];
  deletedKeys: string[];
} {
  const objects = new Map<string, StoredObject>();
  const deletedKeys: string[] = [];
  const putKeys: string[] = [];
  const bucket = {
    head: async (key: string) => {
      const object = objects.get(key);
      return object === undefined
        ? null
        : ({ key, customMetadata: object.customMetadata } as unknown as R2Object);
    },
    get: async (key: string) => {
      const object = objects.get(key);
      return object === undefined
        ? null
        : ({ text: async () => object.body } as unknown as R2ObjectBody);
    },
    put: async (
      key: string,
      value: unknown,
      options?: { customMetadata?: Record<string, string> },
    ) => {
      putKeys.push(key);
      objects.set(key, {
        body: typeof value === 'string' ? value : String(value),
        customMetadata: options?.customMetadata ?? {},
      });
      return { key } as unknown as R2Object;
    },
    delete: async (input: string | string[]) => {
      for (const key of Array.isArray(input) ? input : [input]) {
        deletedKeys.push(key);
        objects.delete(key);
      }
    },
    list: async (options?: { prefix?: string }) => {
      const prefix = options?.prefix ?? '';
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort()
          .map((key) => ({ key })),
        truncated: false,
      } as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
  return { bucket, objects, putKeys, deletedKeys };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

async function assertCompleteStoredExport(
  store: MemoryExportStore,
  storage: ReturnType<typeof memoryBucket>,
): Promise<PortableExportManifest> {
  const record = store.records.get('exp-test');
  const manifestObject = storage.objects.get(record?.r2ObjectKey ?? '');
  expect(manifestObject).toBeDefined();
  const manifest = assertPortableExportManifest(JSON.parse(manifestObject?.body ?? 'null'));
  expect(manifest.checksum).toBe(await sha256(manifestChecksumPayload(manifest)));
  expect(record?.checksum).toBe(await sha256(manifestObject?.body ?? ''));
  expect(manifestObject?.customMetadata).toMatchObject({
    checksum: record?.checksum,
    manifestChecksum: manifest.checksum,
  });
  for (const reference of manifest.chunks) {
    const chunk = storage.objects.get(reference.key);
    expect(chunk).toBeDefined();
    expect(reference.checksum).toBe(await sha256(chunk?.body ?? ''));
    const parsedChunk = assertPortableExportChunk(JSON.parse(chunk?.body ?? 'null'));
    expect(parsedChunk).toMatchObject({
      exportId: manifest.exportId,
      entity: reference.entity,
      sequence: reference.sequence,
    });
    expect(parsedChunk.rows).toHaveLength(reference.rows);
  }
  return manifest;
}

describe('chunked portable exports', () => {
  it('bounds individual objects without imposing an export-wide row ceiling', () => {
    expect(() =>
      assertPortableExportChunk({
        schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
        exportId: 'exp-test',
        entity: 'events',
        sequence: 1,
        rows: Array.from({ length: MAX_PORTABLE_EXPORT_ROWS_PER_CHUNK + 1 }),
      }),
    ).toThrow();
    expect(() =>
      serializePortableExportObject('a'.repeat(MAX_PORTABLE_EXPORT_OBJECT_BYTES)),
    ).toThrow('portable_export_object_too_large');
  });

  it('reads more than 1,000 rows from one D1 entity as consecutive bounded chunks', async () => {
    const actors = Array.from({ length: MAX_PORTABLE_EXPORT_ROWS_PER_CHUNK + 1 }, (_, index) => ({
      __export_cursor: index + 1,
      id: `actor-${index}`,
      identity: `access:actor-${index}`,
      display_name: `Actor ${index}`,
      role: index === 0 ? 'admin' : 'operator',
      active: 1,
      revision: 1,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
      created_by: 'actor-0',
      updated_by: 'actor-0',
    }));
    const database = {
      prepare(sql: string) {
        let parameters: unknown[] = [];
        const statement = {
          bind: (...values: unknown[]) => {
            parameters = values;
            return statement;
          },
          all: async () => {
            if (!sql.includes('FROM actors')) return { results: [], success: true };
            const [cursor, ceiling, limit] = parameters as number[];
            return {
              results: actors
                .filter((row) => row.__export_cursor > cursor! && row.__export_cursor <= ceiling!)
                .slice(0, limit),
              success: true,
            };
          },
        };
        return statement;
      },
      batch: async (statements: unknown[]) =>
        statements.map((_, index) => ({
          success: true,
          results: [{ max_rowid: index === 0 ? actors.length : 0 }],
        })),
    } as unknown as D1Database;

    const chunks: PortableExportChunk[] = [];
    for await (const chunk of new D1Exports(database).readPortableExportChunks('exp-many')) {
      chunks.push(chunk);
    }

    const actorChunks = chunks.filter((chunk) => chunk.entity === 'actors');
    expect(actorChunks.map((chunk) => [chunk.sequence, chunk.rows.length])).toEqual([
      [1, MAX_PORTABLE_EXPORT_ROWS_PER_CHUNK],
      [2, 1],
    ]);
    expect(chunks).toHaveLength(PORTABLE_EXPORT_ENTITIES.length + 1);
  });

  it('writes one validated chunk per entity and a checksummed manifest last', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();

    await new R2ExportWriter(store, storage.bucket).write('exp-test');

    expect(store.sourceValidationCalls).toBe(1);
    expect(store.renewalCalls).toBe(PORTABLE_EXPORT_ENTITIES.length);
    expect(store.records.get('exp-test')?.status).toBe('succeeded');
    expect(storage.putKeys.at(-1)).toBe(store.records.get('exp-test')?.r2ObjectKey);
    const manifest = await assertCompleteStoredExport(store, storage);
    expect(manifest.chunks).toHaveLength(PORTABLE_EXPORT_ENTITIES.length);
    expect(manifest.chunks.map((chunk) => chunk.entity)).toEqual(PORTABLE_EXPORT_ENTITIES);
  });

  it('rejects an invalid entity row before writing that chunk and cleans the claim prefix', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    store.invalidChunk = true;

    await expect(new R2ExportWriter(store, storage.bucket).write('exp-test')).rejects.toThrow(
      'export_processing_failed',
    );

    expect(store.records.get('exp-test')?.status).toBe('failed');
    expect(storage.objects.size).toBe(0);
  });

  it('removes every claim-owned object when D1 completion fails', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    store.failNextCompletion = true;

    await expect(new R2ExportWriter(store, storage.bucket).write('exp-test')).rejects.toThrow(
      'export_processing_failed',
    );

    expect(store.records.get('exp-test')?.status).toBe('failed');
    expect(storage.objects.size).toBe(0);
    expect(storage.deletedKeys).toHaveLength(PORTABLE_EXPORT_ENTITIES.length + 1);

    await new R2ExportWriter(store, storage.bucket).write('exp-test');
    expect(storage.objects.size).toBe(PORTABLE_EXPORT_ENTITIES.length + 1);
    await assertCompleteStoredExport(store, storage);
  });

  it('keeps all authoritative objects when D1 completion succeeded but its response was lost', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    store.throwAfterCompletion = true;

    await expect(new R2ExportWriter(store, storage.bucket).write('exp-test')).rejects.toThrow(
      'export_processing_failed',
    );

    expect(store.records.get('exp-test')?.status).toBe('succeeded');
    expect(storage.deletedKeys).toEqual([]);
    await assertCompleteStoredExport(store, storage);
  });

  it('reclaims a stale lease and deletes the superseded claim prefix', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    const stale = await store.claimExport('exp-test', '2026-08-01T00:00:00.000Z');
    if (stale === null) throw new Error('Expected a stale claim.');
    const stalePrefix = stale.objectKey.slice(0, -'manifest.json'.length);
    await storage.bucket.put(`${stalePrefix}events-000001.json`, '{}');
    await storage.bucket.put(stale.objectKey, '{}');
    const record = store.records.get('exp-test');
    if (record === undefined) throw new Error('Expected an export record.');
    record.leaseUntil = '2000-01-01T00:00:00.000Z';

    await new R2ExportWriter(store, storage.bucket).write('exp-test');

    expect(record.status).toBe('succeeded');
    expect(record.attempts).toBe(2);
    expect([...storage.objects.keys()].some((key) => key.startsWith(stalePrefix))).toBe(false);
    await assertCompleteStoredExport(store, storage);
  });

  it('cleans a superseded schema 1.1 object without adopting an unrelated stable key', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    const stale = await store.claimExport('exp-test', '2026-08-01T00:00:00.000Z');
    if (stale === null) throw new Error('Expected a stale claim.');
    const legacyKey = `exports/exp-test/${stale.revision}-${stale.claimToken}.json`;
    store.claims.set('exp-test', {
      revision: stale.revision,
      objectKey: legacyKey,
      claimToken: stale.claimToken,
    });
    await storage.bucket.put(legacyKey, '{"schemaVersion":"1.1"}', {
      customMetadata: {
        exportId: 'exp-test',
        claimToken: stale.claimToken,
        revision: String(stale.revision),
      },
    });
    await storage.bucket.put('exports/exp-test.json', '{"unrelated":true}');
    const record = store.records.get('exp-test');
    if (record === undefined) throw new Error('Expected an export record.');
    record.leaseUntil = '2000-01-01T00:00:00.000Z';

    await new R2ExportWriter(store, storage.bucket).write('exp-test');

    expect(storage.objects.has(legacyKey)).toBe(false);
    expect(storage.objects.has('exports/exp-test.json')).toBe(true);
    await assertCompleteStoredExport(store, storage);
  });

  it('fences a losing final attempt while a stale recovery claim completes', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    const record = store.records.get('exp-test');
    if (record === undefined) throw new Error('Expected an export record.');
    record.attempts = MAX_EXPORT_ATTEMPTS - 1;

    let releaseLoser: (() => void) | undefined;
    let completionReached: (key: string) => void = () => undefined;
    const reached = new Promise<string>((resolve) => {
      completionReached = resolve;
    });
    store.beforeCompletion = async (input) => {
      record.leaseUntil = '2000-01-01T00:00:00.000Z';
      completionReached(input.objectKey);
      await new Promise<void>((resolve) => {
        releaseLoser = resolve;
      });
    };

    const loser = new R2ExportWriter(store, storage.bucket).write('exp-test');
    const loserManifest = await reached;
    const loserPrefix = loserManifest.slice(0, -'manifest.json'.length);
    await new R2ExportWriter(store, storage.bucket).write('exp-test');
    releaseLoser?.();
    await expect(loser).rejects.toThrow('export_processing_failed');

    expect(record.status).toBe('succeeded');
    expect(record.attempts).toBe(MAX_EXPORT_ATTEMPTS);
    expect([...storage.objects.keys()].some((key) => key.startsWith(loserPrefix))).toBe(false);
    await assertCompleteStoredExport(store, storage);
  });

  it('deletes every object below each retained manifest prefix before expiring D1 records', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    const writer = new R2ExportWriter(store, storage.bucket);
    for (let index = 0; index < MAX_EXPORT_RETENTION_WORK + 2; index += 1) {
      const id = `expired-${String(index).padStart(3, '0')}`;
      const prefix = `exports/${id}/2-token-${index}/`;
      const manifestKey = `${prefix}manifest.json`;
      store.records.set(id, {
        id,
        schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
        status: 'succeeded',
        attempts: 1,
        revision: 2,
        createdAt: '2025-01-01T00:00:00.000Z',
        completedAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
        requestedBy: 'actor-admin',
        r2ObjectKey: manifestKey,
        checksum: `sha256:${'a'.repeat(64)}`,
      });
      await storage.bucket.put(manifestKey, '{}');
      await storage.bucket.put(`${prefix}events-000001.json`, '{}');
    }

    await expect(writer.pruneRetention('actor-admin', new Date('2026-08-01'))).resolves.toBe(
      MAX_EXPORT_RETENTION_WORK,
    );
    await expect(writer.pruneRetention('actor-admin', new Date('2026-08-01'))).resolves.toBe(2);

    expect(storage.objects.size).toBe(0);
    expect(storage.deletedKeys).toHaveLength((MAX_EXPORT_RETENTION_WORK + 2) * 2);
  });
});

describe('outbox export acknowledgement', () => {
  it('retries delivery until authoritative D1 completion is confirmed', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    const writer = new R2ExportWriter(store, storage.bucket);
    store.failNextCompletion = true;
    let outboxStatus: 'pending' | 'dispatching' | 'published' = 'pending';
    const repository = {
      getExport: store.getExport.bind(store),
      claimExport: store.claimExport.bind(store),
      renewExportLease: store.renewExportLease.bind(store),
      validatePortableExportSource: store.validatePortableExportSource.bind(store),
      readPortableExportChunks: store.readPortableExportChunks.bind(store),
      completeExport: store.completeExport.bind(store),
      failExport: store.failExport.bind(store),
      listRetainableExports: store.listRetainableExports.bind(store),
      markExportExpired: store.markExportExpired.bind(store),
      getOutboxEventStatus: async () => outboxStatus,
      claimOutboxEvent: async (eventId: string) => {
        if (outboxStatus !== 'pending') return { kind: 'stale' as const };
        outboxStatus = 'dispatching';
        return {
          kind: 'claimed' as const,
          eventId,
          eventType: 'export.requested',
          payload: { exportId: 'exp-test' },
        };
      },
      completeOutboxEvent: async () => {
        outboxStatus = 'published';
      },
      releaseOutboxEvent: async () => {
        outboxStatus = 'pending';
      },
    } as unknown as OutboxPersistencePort & ExportPersistencePort;
    const messageCalls: string[] = [];
    const batch = {
      messages: [
        {
          body: { eventId: 'event-export', dispatchToken: crypto.randomUUID() },
          ack: () => messageCalls.push('ack'),
          retry: () => messageCalls.push('retry'),
        },
      ],
    } as unknown as MessageBatch<unknown>;

    await consumeOutboxBatch(batch, repository, writer);
    await consumeOutboxBatch(batch, repository, writer);

    expect(messageCalls).toEqual(['retry', 'ack']);
    expect(outboxStatus).toBe('published');
    expect(store.records.get('exp-test')?.status).toBe('succeeded');
  });
});
