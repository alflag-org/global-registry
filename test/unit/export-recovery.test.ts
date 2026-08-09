import { describe, expect, it } from 'vitest';
import {
  MAX_EXPORT_ATTEMPTS,
  MAX_EXPORT_RETENTION_WORK,
  MAX_PORTABLE_EXPORT_BYTES,
  MAX_PORTABLE_EXPORT_ROWS_PER_TABLE,
  MAX_PORTABLE_EXPORT_TOTAL_ROWS,
  PORTABLE_EXPORT_SCHEMA_VERSION,
} from '../../src/application/limits';
import type {
  ExportPersistencePort,
  OutboxPersistencePort,
  PortableRegistrySnapshot,
} from '../../src/application/ports';
import {
  assertPortableExportRowCapacity,
  serializePortableSnapshot,
} from '../../src/application/registry-snapshot';
import { R2ExportWriter } from '../../src/adapters/r2/exporter';
import { D1Exports } from '../../src/adapters/d1/exports';
import { consumeOutboxBatch } from '../../src/adapters/queue/outbox-consumer';
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
  invalidSnapshot = false;
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
    const objectKey = `exports/${encodeURIComponent(id)}/${record.revision}-${claimToken}.json`;
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

  async buildPortableSnapshot(): Promise<PortableRegistrySnapshot> {
    if (this.invalidSnapshot) {
      return {
        ...emptySnapshot(),
        exports: [{ bad: true }],
      } as unknown as PortableRegistrySnapshot;
    }
    return emptySnapshot();
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
      claim?.objectKey !== input.objectKey
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
  putCount: () => number;
  putKeys: string[];
  deletedKeys: string[];
} {
  const objects = new Map<string, StoredObject>();
  const deletedKeys: string[] = [];
  const putKeys: string[] = [];
  let puts = 0;
  const bucket = {
    head: async (key: string) => {
      const object = objects.get(key);
      return object === undefined
        ? null
        : ({ customMetadata: object.customMetadata } as unknown as R2Object);
    },
    get: async (key: string) => {
      const object = objects.get(key);
      return object === undefined
        ? null
        : ({
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(object.body));
                controller.close();
              },
            }),
          } as unknown as R2ObjectBody);
    },
    put: async (
      key: string,
      value: unknown,
      options?: { customMetadata?: Record<string, string> },
    ) => {
      puts += 1;
      putKeys.push(key);
      objects.set(key, {
        body: typeof value === 'string' ? value : String(value),
        customMetadata: options?.customMetadata ?? {},
      });
      return undefined as never;
    },
    delete: async (key: string) => {
      deletedKeys.push(key);
      objects.delete(key);
    },
  } as unknown as R2Bucket;
  return { bucket, objects, putCount: () => puts, putKeys, deletedKeys };
}

describe('retry-safe export completion', () => {
  it('enforces portable row and serialized-byte capacity at the boundary', () => {
    expect(() =>
      assertPortableExportRowCapacity([Array.from({ length: MAX_PORTABLE_EXPORT_ROWS_PER_TABLE })]),
    ).not.toThrow();
    expect(() =>
      assertPortableExportRowCapacity([
        Array.from({ length: MAX_PORTABLE_EXPORT_ROWS_PER_TABLE + 1 }),
      ]),
    ).toThrow('portable_export_capacity_exceeded');
    expect(() =>
      assertPortableExportRowCapacity(
        Array.from(
          { length: MAX_PORTABLE_EXPORT_TOTAL_ROWS / MAX_PORTABLE_EXPORT_ROWS_PER_TABLE },
          () => Array.from({ length: MAX_PORTABLE_EXPORT_ROWS_PER_TABLE }),
        ),
      ),
    ).not.toThrow();
    expect(() =>
      assertPortableExportRowCapacity(
        Array.from(
          { length: MAX_PORTABLE_EXPORT_TOTAL_ROWS / MAX_PORTABLE_EXPORT_ROWS_PER_TABLE },
          () => Array.from({ length: MAX_PORTABLE_EXPORT_ROWS_PER_TABLE }),
        ).concat([Array.from({ length: 1 })]),
      ),
    ).toThrow('portable_export_capacity_exceeded');

    const actor = {
      id: 'actor-capacity',
      identity: 'access:actor-capacity',
      displayName: '',
      role: 'admin' as const,
      active: true,
      revision: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      createdBy: 'actor-capacity',
      updatedBy: 'actor-capacity',
    };
    const emptyBody = serializePortableSnapshot({ ...emptySnapshot(), actors: [actor] });
    const padding = 'a'.repeat(
      MAX_PORTABLE_EXPORT_BYTES - new TextEncoder().encode(emptyBody).byteLength,
    );
    expect(
      new TextEncoder().encode(
        serializePortableSnapshot({
          ...emptySnapshot(),
          actors: [{ ...actor, displayName: padding }],
        }),
      ).byteLength,
    ).toBe(MAX_PORTABLE_EXPORT_BYTES);
    expect(() =>
      serializePortableSnapshot({
        ...emptySnapshot(),
        actors: [{ ...actor, displayName: `${padding}a` }],
      }),
    ).toThrow('portable_export_capacity_exceeded');
  });

  it('uses one D1 batch for the complete 23-table empty snapshot', async () => {
    const statements: string[] = [];
    let batchCalls = 0;
    const database = {
      prepare(sql: string) {
        statements.push(sql);
        const statement = {
          bind: () => statement,
        };
        return statement;
      },
      batch: async (batchStatements: unknown[]) => {
        batchCalls += 1;
        return batchStatements.map(() => ({ success: true, results: [] }));
      },
    } as unknown as D1Database;

    const snapshot = await new D1Exports(database).buildPortableSnapshot();

    expect(batchCalls).toBe(1);
    expect(statements).toHaveLength(23);
    expect(statements.every((statement) => statement.includes('LIMIT ?'))).toBe(true);
    expect(snapshot.actors).toEqual([]);
    expect(snapshot.exports).toEqual([]);
  });

  it('fails before row mapping when a bounded D1 query reports one extra row', async () => {
    const database = {
      prepare(sql: string) {
        const statement = {
          bind: () => statement,
        };
        void sql;
        return statement;
      },
      batch: async (batchStatements: unknown[]) =>
        batchStatements.map((_, index) => ({
          success: true,
          results:
            index === 0 ? Array.from({ length: MAX_PORTABLE_EXPORT_ROWS_PER_TABLE + 1 }) : [],
        })),
    } as unknown as D1Database;

    await expect(new D1Exports(database).buildPortableSnapshot()).rejects.toThrow(
      'portable_export_capacity_exceeded',
    );
  });

  it('reconciles an object after D1 completion fails following the R2 write', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    const writer = new R2ExportWriter(store, storage.bucket);
    store.failNextCompletion = true;

    await expect(writer.write('exp-test')).rejects.toThrow('export_processing_failed');
    expect(store.records.get('exp-test')?.status).toBe('failed');
    expect(storage.objects.size).toBe(0);
    const failedClaimKey = storage.putKeys[0];
    expect(failedClaimKey).toBeDefined();
    expect(storage.deletedKeys).toContain(failedClaimKey);

    await writer.write('exp-test');

    expect(store.records.get('exp-test')?.status).toBe('succeeded');
    expect(storage.putCount()).toBe(2);
    expect(storage.objects.size).toBe(1);
    expect(storage.putKeys[1]).not.toBe(failedClaimKey);
  });

  it('keeps the object when D1 completion succeeded but its response was lost', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    const writer = new R2ExportWriter(store, storage.bucket);
    store.throwAfterCompletion = true;

    await expect(writer.write('exp-test')).rejects.toThrow('export_processing_failed');

    const completed = store.records.get('exp-test');
    expect(completed?.status).toBe('succeeded');
    expect(completed?.r2ObjectKey).toBe(storage.putKeys[0]);
    expect(storage.objects.size).toBe(1);
    expect(storage.deletedKeys).not.toContain(storage.putKeys[0]);
  });

  it('reclaims a stale running lease and fences its prior object', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    const writer = new R2ExportWriter(store, storage.bucket);
    const attempt = await store.claimExport('exp-test', '2026-08-01T00:00:00.000Z');
    if (attempt === null) throw new Error('Expected an initial export lease.');
    const body = serializePortableSnapshot(await store.buildPortableSnapshot());
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const checksum = `sha256:${Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')}`;
    await storage.bucket.put(attempt.objectKey, body, {
      customMetadata: {
        exportId: 'exp-test',
        checksum,
        schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
        claimToken: attempt.claimToken,
        revision: String(attempt.revision),
      },
    });
    const record = store.records.get('exp-test');
    if (record === undefined) throw new Error('Expected an export record.');
    record.leaseUntil = '2000-01-01T00:00:00.000Z';

    await writer.write('exp-test');

    expect(record.status).toBe('succeeded');
    expect(record.attempts).toBe(2);
    expect(storage.putCount()).toBe(2);
    expect(storage.objects.size).toBe(1);
    expect(storage.deletedKeys).toContain(attempt.objectKey);
    expect(storage.putKeys[1]).not.toBe(attempt.objectKey);
  });

  it('recovers a stale running lease after the bounded write attempts are exhausted', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    const writer = new R2ExportWriter(store, storage.bucket);
    const record = store.records.get('exp-test');
    if (record === undefined) throw new Error('Expected an export record.');
    const staleClaim = await store.claimExport('exp-test', '2026-08-01T00:00:00.000Z');
    if (staleClaim === null) throw new Error('Expected a stale export lease.');
    record.attempts = MAX_EXPORT_ATTEMPTS;
    record.leaseUntil = '2000-01-01T00:00:00.000Z';
    const body = serializePortableSnapshot(await store.buildPortableSnapshot());
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const checksum = `sha256:${Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')}`;
    await storage.bucket.put(staleClaim.objectKey, body, {
      customMetadata: {
        exportId: 'exp-test',
        checksum,
        schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
        claimToken: staleClaim.claimToken,
        revision: String(staleClaim.revision),
      },
    });

    await writer.write('exp-test');

    expect(record.status).toBe('succeeded');
    expect(record.attempts).toBe(MAX_EXPORT_ATTEMPTS);
    expect(storage.putCount()).toBe(2);
    expect(storage.objects.size).toBe(1);
    expect(storage.deletedKeys).toContain(staleClaim.objectKey);
    expect(storage.putKeys[1]).not.toBe(staleClaim.objectKey);
  });

  it('fences a final-attempt loser while a stale recovery claim completes', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    const loserWriter = new R2ExportWriter(store, storage.bucket);
    const winnerWriter = new R2ExportWriter(store, storage.bucket);
    const record = store.records.get('exp-test');
    if (record === undefined) throw new Error('Expected an export record.');
    record.attempts = MAX_EXPORT_ATTEMPTS - 1;

    let releaseLoser: (() => void) | undefined;
    let loserCompletionReached: (input: { objectKey: string; claimToken: string }) => void = () =>
      undefined;
    const reached = new Promise<{ objectKey: string; claimToken: string }>((resolve) => {
      loserCompletionReached = resolve;
    });
    store.beforeCompletion = async (input) => {
      record.leaseUntil = '2000-01-01T00:00:00.000Z';
      loserCompletionReached({ objectKey: input.objectKey, claimToken: input.claimToken });
      await new Promise<void>((resolve) => {
        releaseLoser = resolve;
      });
    };

    const loserPromise = loserWriter.write('exp-test');
    const loserClaim = await reached;
    expect(record.attempts).toBe(MAX_EXPORT_ATTEMPTS);
    expect(storage.objects.has(loserClaim.objectKey)).toBe(true);

    await winnerWriter.write('exp-test');
    releaseLoser?.();
    await expect(loserPromise).rejects.toThrow('export_processing_failed');

    expect(record.status).toBe('succeeded');
    expect(record.attempts).toBe(MAX_EXPORT_ATTEMPTS);
    expect(storage.objects.size).toBe(1);
    expect(storage.objects.has(loserClaim.objectKey)).toBe(false);
    expect(storage.deletedKeys).toContain(loserClaim.objectKey);
    const winnerKey = record.r2ObjectKey;
    expect(winnerKey).toBeDefined();
    const winner = storage.objects.get(winnerKey ?? '');
    expect(winner).toBeDefined();
    const winnerDigest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(winner?.body ?? ''),
    );
    expect(winner?.customMetadata.checksum).toBe(
      `sha256:${Array.from(new Uint8Array(winnerDigest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('')}`,
    );
  });

  it('rejects an invalid snapshot before any R2 write', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    const writer = new R2ExportWriter(store, storage.bucket);
    store.invalidSnapshot = true;

    await expect(writer.write('exp-test')).rejects.toThrow('export_processing_failed');

    expect(storage.putCount()).toBe(0);
    expect(store.records.get('exp-test')?.status).toBe('failed');
  });

  it('does not adopt an unrelated object at an old stable-looking key', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    const writer = new R2ExportWriter(store, storage.bucket);
    const body = JSON.stringify({ schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const checksum = `sha256:${Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')}`;
    await storage.bucket.put('exports/exp-test.json', body, {
      customMetadata: {
        exportId: 'exp-test',
        checksum,
        schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
      },
    });

    await writer.write('exp-test');

    expect(storage.putCount()).toBe(2);
    expect(store.records.get('exp-test')?.status).toBe('succeeded');
    expect(storage.objects.has('exports/exp-test.json')).toBe(true);
  });

  it('processes retention in bounded ordered batches without skipping or repeating records', async () => {
    const store = new MemoryExportStore();
    const storage = memoryBucket();
    const writer = new R2ExportWriter(store, storage.bucket);
    for (let index = 0; index < MAX_EXPORT_RETENTION_WORK + 2; index += 1) {
      const id = `expired-${String(index).padStart(3, '0')}`;
      store.records.set(id, {
        id,
        schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
        status: 'succeeded',
        attempts: 1,
        revision: 2,
        createdAt: '2025-01-01T00:00:00.000Z',
        completedAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
        requestedBy: 'actor-admin',
        r2ObjectKey: `exports/${id}.json`,
        checksum: `sha256:${'a'.repeat(64)}`,
      });
    }

    await expect(
      writer.pruneRetention('actor-admin', new Date('2026-08-01T00:00:00.000Z')),
    ).resolves.toBe(MAX_EXPORT_RETENTION_WORK);
    await expect(
      writer.pruneRetention('actor-admin', new Date('2026-08-01T00:00:00.000Z')),
    ).resolves.toBe(2);

    expect(storage.deletedKeys).toHaveLength(MAX_EXPORT_RETENTION_WORK + 2);
    expect(new Set(storage.deletedKeys).size).toBe(storage.deletedKeys.length);
    expect(
      [...store.records.values()].filter(
        (record) => record.id.startsWith('expired-') && record.expiredAt === undefined,
      ),
    ).toHaveLength(0);
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
      buildPortableSnapshot: store.buildPortableSnapshot.bind(store),
      completeExport: store.completeExport.bind(store),
      failExport: store.failExport.bind(store),
      listRetainableExports: store.listRetainableExports.bind(store),
      markExportExpired: store.markExportExpired.bind(store),
      getOutboxEventStatus: async () => outboxStatus,
      claimOutboxEvent: async (eventId: string, _dispatchToken: string) => {
        if (outboxStatus !== 'pending') return { kind: 'stale' as const };
        outboxStatus = 'dispatching';
        return {
          kind: 'claimed' as const,
          eventId,
          eventType: 'export.requested',
          payload: { exportId: 'exp-test' },
        };
      },
      completeOutboxEvent: async (_eventId: string, _dispatchToken: string) => {
        outboxStatus = 'published';
      },
      releaseOutboxEvent: async (_eventId: string, _dispatchToken: string, _errorCode: string) => {
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

function emptySnapshot(): PortableRegistrySnapshot {
  return {
    schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
    exportedAt: '2026-08-01T00:00:00.000Z',
    actors: [],
    providers: [],
    profiles: [],
    profileVersions: [],
    policies: [],
    policyVersions: [],
    resources: [],
    relationships: [],
    relationshipHistory: [],
    bindings: [],
    bindingHistory: [],
    health: [],
    observations: [],
    drifts: [],
    operations: [],
    operationResources: [],
    operationSteps: [],
    operationChanges: [],
    locks: [],
    lockGenerations: [],
    events: [],
    outbox: [],
    exports: [],
  };
}
