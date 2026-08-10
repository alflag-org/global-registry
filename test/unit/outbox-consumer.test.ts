import { describe, expect, it, vi } from 'vitest';
import type {
  ExportPersistencePort,
  OutboxClaimResult,
  OutboxPersistencePort,
} from '../../src/application/ports';
import { consumeOutboxBatch } from '../../src/adapters/queue/outbox-consumer';

function message(body: unknown) {
  const calls: string[] = [];
  return {
    body,
    calls,
    ack: () => calls.push('ack'),
    retry: () => calls.push('retry'),
  };
}

function repository(
  claim: (eventId: string, dispatchToken: string) => Promise<OutboxClaimResult>,
  overrides: Record<string, unknown> = {},
) {
  return {
    getExport: async () => null,
    claimExport: async () => null,
    renewExportLease: async () => undefined,
    validatePortableExportSource: async () => undefined,
    readPortableExportChunks: async function* () {},
    completeExport: async () => undefined,
    failExport: async () => undefined,
    listRetainableExports: async () => [],
    markExportExpired: async () => false,
    getOutboxEventStatus: async () => null,
    claimOutboxEvent: claim,
    completeOutboxEvent: async () => undefined,
    releaseOutboxEvent: async () => undefined,
    ...overrides,
  } as unknown as OutboxPersistencePort & ExportPersistencePort;
}

function batch(messages: ReturnType<typeof message>[]) {
  return { messages } as unknown as MessageBatch<unknown>;
}

describe('outbox consumer claim outcomes', () => {
  it('acknowledges malformed, empty, and oversized deliveries without repository access', async () => {
    const claim = vi.fn();
    const malformed = message(null);
    const emptyEvent = message({ eventId: '', dispatchToken: 'token' });
    const oversizedToken = message({ eventId: 'event', dispatchToken: 'x'.repeat(129) });

    await consumeOutboxBatch(batch([malformed, emptyEvent, oversizedToken]), repository(claim));

    expect(malformed.calls).toEqual(['ack']);
    expect(emptyEvent.calls).toEqual(['ack']);
    expect(oversizedToken.calls).toEqual(['ack']);
    expect(claim).not.toHaveBeenCalled();
  });

  it('acknowledges stale and published duplicates and retries a busy current lease', async () => {
    const claim = vi.fn(
      async (_eventId: string, dispatchToken: string): Promise<OutboxClaimResult> =>
        dispatchToken === 'busy' ? { kind: 'busy' } : { kind: 'stale' },
    );
    const stale = message({ eventId: 'stale-event', dispatchToken: 'stale' });
    const published = message({ eventId: 'published-event', dispatchToken: 'published' });
    const busy = message({ eventId: 'current-event', dispatchToken: 'busy' });

    await consumeOutboxBatch(batch([stale, published, busy]), repository(claim));

    expect(stale.calls).toEqual(['ack']);
    expect(published.calls).toEqual(['ack']);
    expect(busy.calls).toEqual(['retry']);
  });

  it('retries a transient claim failure without releasing an unclaimed lease', async () => {
    const release = vi.fn(async () => undefined);
    const claim = vi.fn(async () => {
      throw new Error('storage temporarily unavailable');
    });
    const current = message({ eventId: 'event', dispatchToken: 'current' });

    await consumeOutboxBatch(batch([current]), repository(claim, { releaseOutboxEvent: release }));

    expect(current.calls).toEqual(['retry']);
    expect(release).not.toHaveBeenCalled();
  });

  it('releases a current claim when processing fails before completion', async () => {
    const release = vi.fn(async () => undefined);
    const claim = vi.fn(async (eventId: string): Promise<OutboxClaimResult> => ({
      kind: 'claimed',
      eventId,
      eventType: 'export.requested',
      payload: { exportId: 'export-1' },
    }));
    const current = message({ eventId: 'event', dispatchToken: 'current' });

    await consumeOutboxBatch(batch([current]), repository(claim, { releaseOutboxEvent: release }));

    expect(current.calls).toEqual(['retry']);
    expect(release).toHaveBeenCalledWith('event', 'current', 'outbox_processing_failed');
  });

  it('acknowledges a successfully completed current claim', async () => {
    const complete = vi.fn(async () => undefined);
    const claim = vi.fn(async (eventId: string): Promise<OutboxClaimResult> => ({
      kind: 'claimed',
      eventId,
      eventType: 'other.event',
      payload: {},
    }));
    const current = message({ eventId: 'event', dispatchToken: 'current' });

    await consumeOutboxBatch(
      batch([current]),
      repository(claim, { completeOutboxEvent: complete }),
    );

    expect(current.calls).toEqual(['ack']);
    expect(complete).toHaveBeenCalledWith('event', 'current');
  });
});
