import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_OUTBOX_CONSUMER_ATTEMPTS,
  MAX_OUTBOX_DISPATCH_WORK,
  MAX_OUTBOX_PRODUCER_ATTEMPTS,
} from '../../src/application/limits';
import type { OutboxDispatchMessage } from '../../src/application/ports';
import { OUTBOX_LEASE_MS } from '../../src/adapters/d1/events';
import { D1GlobalRegistryRepository } from '../../src/adapters/d1/repository';

interface OutboxState {
  event_id: string;
  status: 'pending' | 'dispatching' | 'published' | 'failed';
  consumer_attempts: number;
  producer_attempts: number;
  dispatch_token: string | null;
  last_error: string | null;
}

interface SeededOutbox {
  eventId: string;
  dispatchToken: string | null;
  createdAt: string;
}

const bootstrapActorId = 'outbox-dispatch-bootstrap';

async function seedOutbox(
  input: {
    createdAt?: string;
    status?: 'pending' | 'dispatching';
    consumerAttempts?: number;
    producerAttempts?: number;
    dispatchToken?: string | null;
    updatedAt?: string;
  } = {},
): Promise<SeededOutbox> {
  const suffix = crypto.randomUUID();
  const eventId = `outbox-dispatch-event-${suffix}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const dispatchToken = input.dispatchToken ?? null;
  const timestamp = input.updatedAt ?? createdAt;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (
        event_id, event_type, resource_key, operation_id, actor_id, payload_json, occurred_at
      ) VALUES (?, 'outbox.dispatch.test', NULL, NULL, ?, '{}', ?)`,
    ).bind(eventId, bootstrapActorId, createdAt),
    env.DB.prepare(
      `INSERT INTO outbox (
        id, event_id, topic, payload_json, status, consumer_attempts, producer_attempts, created_at,
        published_at, last_error, revision, updated_at, dispatch_token
      ) VALUES (?, ?, 'outbox.dispatch.test', '{}', ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
    ).bind(
      `outbox-row-${suffix}`,
      eventId,
      input.status ?? 'pending',
      input.consumerAttempts ?? 0,
      input.producerAttempts ?? 0,
      createdAt,
      timestamp,
      dispatchToken,
    ),
  ]);
  return { eventId, dispatchToken, createdAt };
}

async function outboxState(eventId: string): Promise<OutboxState> {
  const row = await env.DB.prepare(
    `SELECT event_id, status, consumer_attempts, producer_attempts, dispatch_token, last_error
       FROM outbox WHERE event_id = ?`,
  )
    .bind(eventId)
    .first<OutboxState>();
  if (row === null) throw new Error(`Outbox row ${eventId} was not found.`);
  return row;
}

function queueFor(
  sent: OutboxDispatchMessage[],
  send: (message: OutboxDispatchMessage) => Promise<void> = async () => undefined,
): Queue<OutboxDispatchMessage> {
  return {
    send: vi.fn(async (message: OutboxDispatchMessage) => {
      sent.push(message);
      await send(message);
    }),
  } as unknown as Queue<OutboxDispatchMessage>;
}

async function waitForSent(sent: OutboxDispatchMessage[], count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (sent.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (sent.length < count) throw new Error(`Queue send did not reach ${count} messages.`);
}

describe.sequential('D1 outbox dispatch leasing', () => {
  const repository = new D1GlobalRegistryRepository(env.DB);

  beforeAll(async () => {
    const timestamp = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO actors (
        id, identity, display_name, role, active, revision,
        created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, 'admin', 1, 1, ?, ?, ?, ?)`,
    )
      .bind(
        bootstrapActorId,
        `service:${bootstrapActorId}`,
        'Outbox Dispatch Test Actor',
        timestamp,
        timestamp,
        bootstrapActorId,
        bootstrapActorId,
      )
      .run();
  });

  beforeEach(async () => {
    const publishedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE outbox
          SET status = 'published', dispatch_token = NULL, published_at = ?,
              last_error = NULL, updated_at = ?, revision = revision + 1`,
    )
      .bind(publishedAt, publishedAt)
      .run();
  });

  it('sends a pending row once across two pre-consumption dispatch calls', async () => {
    const seeded = await seedOutbox();
    const sent: OutboxDispatchMessage[] = [];
    const queue = queueFor(sent);

    await repository.dispatchPendingOutbox(queue);
    await repository.dispatchPendingOutbox(queue);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ eventId: seeded.eventId });
    expect(await outboxState(seeded.eventId)).toMatchObject({
      status: 'pending',
      dispatch_token: sent[0]?.dispatchToken,
    });
  });

  it('does not let overlapping dispatchers send the same live lease', async () => {
    const seeded = await seedOutbox();
    const sent: OutboxDispatchMessage[] = [];
    let releaseSend: () => void = () => undefined;
    const sendFinished = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const queue = queueFor(sent, async () => sendFinished);

    const first = repository.dispatchPendingOutbox(queue);
    await waitForSent(sent, 1);
    await repository.dispatchPendingOutbox(queue);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.eventId).toBe(seeded.eventId);

    releaseSend();
    await first;
  });

  it('releases only failed sends and retries them without redispatching successes', async () => {
    const failed = await seedOutbox({ createdAt: '2026-08-01T00:00:00.000Z' });
    const succeeded = await seedOutbox({ createdAt: '2026-08-01T00:01:00.000Z' });
    const sent: OutboxDispatchMessage[] = [];
    const firstQueue = queueFor(sent, async (message) => {
      if (message.eventId === failed.eventId) throw new Error('injected_queue_failure');
    });

    await expect(repository.dispatchPendingOutbox(firstQueue)).rejects.toThrow(
      'outbox_dispatch_failed',
    );
    expect(await outboxState(failed.eventId)).toMatchObject({
      status: 'pending',
      dispatch_token: null,
      last_error: 'outbox_dispatch_failed',
      consumer_attempts: 0,
      producer_attempts: 1,
    });
    expect(await outboxState(succeeded.eventId)).toMatchObject({
      status: 'pending',
      dispatch_token: sent.find((message) => message.eventId === succeeded.eventId)?.dispatchToken,
      last_error: null,
      consumer_attempts: 0,
      producer_attempts: 0,
    });

    const retrySent: OutboxDispatchMessage[] = [];
    await repository.dispatchPendingOutbox(queueFor(retrySent));
    expect(retrySent.map((message) => message.eventId)).toEqual([failed.eventId]);
  });

  it('does not redispatch a successful send before consumer completion', async () => {
    const seeded = await seedOutbox();
    const sent: OutboxDispatchMessage[] = [];
    const queue = queueFor(sent);

    await repository.dispatchPendingOutbox(queue);
    const message = sent[0];
    if (message === undefined) throw new Error('Expected a dispatched message.');
    expect(await repository.claimOutboxEvent(message.eventId, message.dispatchToken)).toMatchObject(
      {
        kind: 'claimed',
      },
    );
    await repository.dispatchPendingOutbox(queue);

    expect(sent).toHaveLength(1);
    expect(await outboxState(seeded.eventId)).toMatchObject({ status: 'dispatching' });
  });

  it('recovers an expired producer lease with a new token', async () => {
    const oldToken = crypto.randomUUID();
    const seeded = await seedOutbox({
      dispatchToken: oldToken,
      updatedAt: new Date(Date.now() - OUTBOX_LEASE_MS - 1_000).toISOString(),
    });
    const sent: OutboxDispatchMessage[] = [];

    await repository.dispatchPendingOutbox(queueFor(sent));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.eventId).toBe(seeded.eventId);
    expect(sent[0]?.dispatchToken).not.toBe(oldToken);
    expect(await outboxState(seeded.eventId)).toMatchObject({
      status: 'pending',
      dispatch_token: sent[0]?.dispatchToken,
    });
    expect(await repository.claimOutboxEvent(seeded.eventId, oldToken)).toEqual({ kind: 'stale' });
    expect(
      await repository.claimOutboxEvent(seeded.eventId, sent[0]?.dispatchToken ?? ''),
    ).toMatchObject({
      kind: 'claimed',
    });
  });

  it('acks stale, forged, and published deliveries while retrying only a busy current lease', async () => {
    const seeded = await seedOutbox();
    const sent: OutboxDispatchMessage[] = [];
    await repository.dispatchPendingOutbox(queueFor(sent));
    const currentToken = sent[0]?.dispatchToken;
    if (currentToken === undefined) throw new Error('Expected a current dispatch token.');

    expect(await repository.claimOutboxEvent(seeded.eventId, 'forged-token')).toEqual({
      kind: 'stale',
    });
    expect(await repository.claimOutboxEvent(seeded.eventId, currentToken)).toMatchObject({
      kind: 'claimed',
    });
    expect(await repository.claimOutboxEvent(seeded.eventId, currentToken)).toEqual({
      kind: 'busy',
    });

    await repository.completeOutboxEvent(seeded.eventId, currentToken);
    expect(await repository.claimOutboxEvent(seeded.eventId, currentToken)).toEqual({
      kind: 'stale',
    });
  });

  it('acknowledges an old token while a newer dispatching lease is current', async () => {
    const oldToken = crypto.randomUUID();
    const seeded = await seedOutbox({
      dispatchToken: oldToken,
      updatedAt: new Date(Date.now() - OUTBOX_LEASE_MS - 1_000).toISOString(),
    });
    const sent: OutboxDispatchMessage[] = [];
    await repository.dispatchPendingOutbox(queueFor(sent));
    const currentToken = sent[0]?.dispatchToken;
    if (currentToken === undefined) throw new Error('Expected a replacement dispatch token.');
    await env.DB.prepare(
      `UPDATE outbox SET status = 'dispatching', updated_at = ? WHERE event_id = ? AND dispatch_token = ?`,
    )
      .bind(new Date().toISOString(), seeded.eventId, currentToken)
      .run();

    expect(await repository.claimOutboxEvent(seeded.eventId, oldToken)).toEqual({ kind: 'stale' });
    expect(await repository.claimOutboxEvent(seeded.eventId, currentToken)).toEqual({
      kind: 'busy',
    });
  });

  it('terminalizes persistent producer failures without consuming consumer attempts', async () => {
    const seeded = await seedOutbox();
    for (let attempt = 1; attempt <= MAX_OUTBOX_PRODUCER_ATTEMPTS; attempt += 1) {
      const sent: OutboxDispatchMessage[] = [];
      await expect(
        repository.dispatchPendingOutbox(
          queueFor(sent, async () => {
            throw new Error('injected_queue_failure');
          }),
        ),
      ).rejects.toThrow('outbox_dispatch_failed');
      expect(await outboxState(seeded.eventId)).toMatchObject(
        attempt === MAX_OUTBOX_PRODUCER_ATTEMPTS
          ? {
              status: 'failed',
              dispatch_token: null,
              producer_attempts: attempt,
              consumer_attempts: 0,
              last_error: 'outbox_producer_retry_limit',
            }
          : {
              status: 'pending',
              dispatch_token: null,
              producer_attempts: attempt,
              consumer_attempts: 0,
              last_error: 'outbox_dispatch_failed',
            },
      );
    }
    const sent: OutboxDispatchMessage[] = [];
    await repository.dispatchPendingOutbox(queueFor(sent));
    expect(sent).toHaveLength(0);
    expect(await outboxState(seeded.eventId)).toMatchObject({ status: 'failed' });
  });

  it('preserves ordering, the batch bound, and retry terminalization', async () => {
    const terminal = await seedOutbox({
      createdAt: '2026-08-01T00:00:00.000Z',
      consumerAttempts: MAX_OUTBOX_CONSUMER_ATTEMPTS,
    });
    const eligible: SeededOutbox[] = [];
    for (let index = 0; index <= MAX_OUTBOX_DISPATCH_WORK; index += 1) {
      eligible.push(
        await seedOutbox({
          createdAt: new Date(Date.parse('2026-08-01T01:00:00.000Z') + index * 1_000).toISOString(),
        }),
      );
    }
    const sent: OutboxDispatchMessage[] = [];

    await repository.dispatchPendingOutbox(queueFor(sent));

    expect(sent.map((message) => message.eventId)).toEqual(
      eligible.slice(0, MAX_OUTBOX_DISPATCH_WORK).map((row) => row.eventId),
    );
    expect(sent).toHaveLength(MAX_OUTBOX_DISPATCH_WORK);
    expect(await outboxState(terminal.eventId)).toMatchObject({
      status: 'failed',
      consumer_attempts: MAX_OUTBOX_CONSUMER_ATTEMPTS,
      producer_attempts: 0,
      last_error: 'outbox_consumer_retry_limit',
      dispatch_token: null,
    });
    expect(await outboxState(eligible[MAX_OUTBOX_DISPATCH_WORK]?.eventId ?? '')).toMatchObject({
      status: 'pending',
      dispatch_token: null,
    });
  });
});
