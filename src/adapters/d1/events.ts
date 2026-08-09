import { NotFoundError } from '../../domain/errors/global-registry-error';
import { parseJsonObject } from '../../domain/models/json';
import type { AuditEvent } from '../../domain/models/global-registry';
import {
  MAX_OUTBOX_CONSUMER_ATTEMPTS,
  MAX_OUTBOX_DISPATCH_WORK,
  MAX_OUTBOX_PRODUCER_ATTEMPTS,
} from '../../application/limits';
import type { OutboxClaimResult, OutboxDispatchMessage } from '../../application/ports';
import { boundedPageLimit, MAX_AUDIT_PAGE_SIZE } from '../../domain/models/pagination';
import { D1Client } from './client';
import { mapEvent } from './rows';
import type { EventRow, OutboxRow } from './types';

export const OUTBOX_LEASE_MS = 5 * 60 * 1000;

export class D1Events extends D1Client {
  async getOutboxEventStatus(
    eventId: string,
  ): Promise<'pending' | 'dispatching' | 'published' | 'failed' | null> {
    const row = await this.first<Pick<OutboxRow, 'status'>>(
      'SELECT status FROM outbox WHERE event_id = ?',
      eventId,
    );
    return row?.status ?? null;
  }

  async listForResource(resourceKey: string, limit?: number): Promise<AuditEvent[]> {
    return (
      await this.all<EventRow>(
        'SELECT * FROM events WHERE resource_key = ? ORDER BY occurred_at DESC LIMIT ?',
        resourceKey,
        boundedPageLimit(limit, MAX_AUDIT_PAGE_SIZE, 100),
      )
    ).map(mapEvent);
  }

  async listForOperation(operationId: string, limit?: number): Promise<AuditEvent[]> {
    return (
      await this.all<EventRow>(
        'SELECT * FROM events WHERE operation_id = ? ORDER BY occurred_at DESC LIMIT ?',
        operationId,
        boundedPageLimit(limit, MAX_AUDIT_PAGE_SIZE, 100),
      )
    ).map(mapEvent);
  }

  async list(limit?: number): Promise<AuditEvent[]> {
    return (
      await this.all<EventRow>(
        'SELECT * FROM events ORDER BY occurred_at DESC LIMIT ?',
        boundedPageLimit(limit, MAX_AUDIT_PAGE_SIZE, 100),
      )
    ).map(mapEvent);
  }

  async dispatchPendingOutbox(queue: Queue<OutboxDispatchMessage>): Promise<void> {
    const dispatchedAt = new Date().toISOString();
    const staleBefore = new Date(Date.parse(dispatchedAt) - OUTBOX_LEASE_MS).toISOString();
    await this.statement(
      `UPDATE outbox SET
         status = CASE WHEN consumer_attempts >= ? THEN 'failed' ELSE 'pending' END,
         dispatch_token = NULL,
         last_error = CASE WHEN consumer_attempts >= ? THEN 'outbox_consumer_retry_limit' ELSE last_error END,
         updated_at = ?, revision = revision + 1
       WHERE id IN (
         SELECT id FROM outbox
          WHERE status IN ('pending', 'dispatching')
            AND dispatch_token IS NOT NULL AND updated_at <= ?
          ORDER BY updated_at, id LIMIT ?
       )
         AND status IN ('pending', 'dispatching')
         AND dispatch_token IS NOT NULL AND updated_at <= ?`,
      MAX_OUTBOX_CONSUMER_ATTEMPTS,
      MAX_OUTBOX_CONSUMER_ATTEMPTS,
      dispatchedAt,
      staleBefore,
      MAX_OUTBOX_DISPATCH_WORK,
      staleBefore,
    ).run();
    await this.statement(
      `UPDATE outbox SET status = 'failed', last_error = 'outbox_consumer_retry_limit', updated_at = ?,
         dispatch_token = NULL, revision = revision + 1
       WHERE id IN (
         SELECT id FROM outbox
          WHERE status = 'pending' AND dispatch_token IS NULL
            AND consumer_attempts >= ?
          ORDER BY updated_at, id LIMIT ?
       )
         AND status = 'pending' AND dispatch_token IS NULL
         AND consumer_attempts >= ?`,
      dispatchedAt,
      MAX_OUTBOX_CONSUMER_ATTEMPTS,
      MAX_OUTBOX_DISPATCH_WORK,
      MAX_OUTBOX_CONSUMER_ATTEMPTS,
    ).run();
    await this.statement(
      `UPDATE outbox SET status = 'failed', last_error = 'outbox_producer_retry_limit', updated_at = ?,
         dispatch_token = NULL, revision = revision + 1
       WHERE id IN (
         SELECT id FROM outbox
          WHERE status = 'pending' AND dispatch_token IS NULL
            AND producer_attempts >= ?
          ORDER BY updated_at, id LIMIT ?
       )
         AND status = 'pending' AND dispatch_token IS NULL
         AND producer_attempts >= ?`,
      dispatchedAt,
      MAX_OUTBOX_PRODUCER_ATTEMPTS,
      MAX_OUTBOX_DISPATCH_WORK,
      MAX_OUTBOX_PRODUCER_ATTEMPTS,
    ).run();

    const dispatchToken = crypto.randomUUID();
    const leased = this.statement(
      `UPDATE outbox SET dispatch_token = ?, updated_at = ?, revision = revision + 1
       WHERE id IN (
         SELECT id FROM outbox
          WHERE status = 'pending' AND dispatch_token IS NULL
            AND producer_attempts < ? AND consumer_attempts < ?
          ORDER BY created_at, id LIMIT ?
       )
         AND status = 'pending' AND dispatch_token IS NULL
         AND producer_attempts < ? AND consumer_attempts < ?`,
      dispatchToken,
      dispatchedAt,
      MAX_OUTBOX_PRODUCER_ATTEMPTS,
      MAX_OUTBOX_CONSUMER_ATTEMPTS,
      MAX_OUTBOX_DISPATCH_WORK,
      MAX_OUTBOX_PRODUCER_ATTEMPTS,
      MAX_OUTBOX_CONSUMER_ATTEMPTS,
    );
    const leaseResult = await leased.run();
    if (leaseResult.meta.changes === 0) return;

    const rows = await this.all<Pick<OutboxRow, 'event_id'>>(
      `SELECT event_id FROM outbox
       WHERE status = 'pending' AND dispatch_token = ?
       ORDER BY created_at, id LIMIT ?`,
      dispatchToken,
      MAX_OUTBOX_DISPATCH_WORK,
    );
    const results = await Promise.allSettled(
      rows.map(async (row) => {
        try {
          await queue.send({ eventId: row.event_id, dispatchToken });
        } catch {
          await this.recordOutboxProducerFailure(row.event_id, dispatchToken);
          throw new Error('outbox_dispatch_failed');
        }
      }),
    );
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('outbox_dispatch_failed');
    }
  }

  private async recordOutboxProducerFailure(eventId: string, dispatchToken: string): Promise<void> {
    const releasedAt = new Date().toISOString();
    await this.statement(
      `UPDATE outbox SET
         producer_attempts = producer_attempts + 1,
         status = CASE WHEN producer_attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
         dispatch_token = NULL,
         last_error = CASE
           WHEN producer_attempts + 1 >= ? THEN 'outbox_producer_retry_limit'
           ELSE 'outbox_dispatch_failed'
         END,
         updated_at = ?, revision = revision + 1
       WHERE event_id = ? AND status = 'pending' AND dispatch_token = ?`,
      MAX_OUTBOX_PRODUCER_ATTEMPTS,
      MAX_OUTBOX_PRODUCER_ATTEMPTS,
      releasedAt,
      eventId,
      dispatchToken,
    ).run();
  }

  async claimOutboxEvent(eventId: string, dispatchToken: string): Promise<OutboxClaimResult> {
    const claimedAt = new Date().toISOString();
    const staleBefore = new Date(Date.parse(claimedAt) - OUTBOX_LEASE_MS).toISOString();
    const results = await this.db.batch([
      this.statement(
        `UPDATE outbox SET
           status = CASE WHEN consumer_attempts >= ? THEN 'failed' ELSE 'pending' END,
           last_error = CASE WHEN consumer_attempts >= ? THEN 'outbox_consumer_retry_limit' ELSE last_error END,
           dispatch_token = CASE WHEN consumer_attempts >= ? THEN NULL ELSE dispatch_token END,
           updated_at = ?, revision = revision + 1
         WHERE event_id = ? AND status = 'dispatching' AND dispatch_token = ? AND updated_at <= ?`,
        MAX_OUTBOX_CONSUMER_ATTEMPTS,
        MAX_OUTBOX_CONSUMER_ATTEMPTS,
        MAX_OUTBOX_CONSUMER_ATTEMPTS,
        claimedAt,
        eventId,
        dispatchToken,
        staleBefore,
      ),
      this.statement(
        `UPDATE outbox SET status = 'dispatching', consumer_attempts = consumer_attempts + 1,
           updated_at = ?
         WHERE event_id = ? AND status = 'pending' AND dispatch_token = ?
           AND consumer_attempts < ?`,
        claimedAt,
        eventId,
        dispatchToken,
        MAX_OUTBOX_CONSUMER_ATTEMPTS,
      ),
      this.statement(
        `UPDATE outbox SET status = 'failed', last_error = 'outbox_consumer_retry_limit', updated_at = ?,
           dispatch_token = NULL, revision = revision + 1
         WHERE event_id = ? AND status = 'pending' AND dispatch_token = ?
           AND consumer_attempts >= ?`,
        claimedAt,
        eventId,
        dispatchToken,
        MAX_OUTBOX_CONSUMER_ATTEMPTS,
      ),
      this.statement(
        'SELECT status, dispatch_token, consumer_attempts FROM outbox WHERE event_id = ?',
        eventId,
      ),
      this.statement(
        'SELECT event_id, event_type, payload_json FROM events WHERE event_id = ?',
        eventId,
      ),
    ]);
    const claimResult = results[1];
    const terminalResult = results[2];
    const outboxResult = results[3];
    const eventResult = results[4];
    if (
      claimResult === undefined ||
      terminalResult === undefined ||
      outboxResult === undefined ||
      eventResult === undefined
    ) {
      throw new Error('outbox_claim_result_missing');
    }
    const outboxRow = outboxResult.results[0] as
      Pick<OutboxRow, 'status' | 'dispatch_token' | 'consumer_attempts'> | undefined;
    if (claimResult.meta.changes === 1) {
      const row = eventResult.results[0] as
        Pick<EventRow, 'event_id' | 'event_type' | 'payload_json'> | undefined;
      if (row === undefined) {
        await this.releaseOutboxEvent(eventId, dispatchToken, 'outbox_event_missing');
        throw new NotFoundError('Outbox event', eventId);
      }
      return {
        kind: 'claimed',
        eventId: row.event_id,
        eventType: row.event_type,
        payload: parseJsonObject(row.payload_json, 'outbox event payload'),
      };
    }
    if (terminalResult.meta.changes === 1) return { kind: 'stale' };
    if (outboxRow?.status === 'dispatching' && outboxRow.dispatch_token === dispatchToken) {
      return { kind: 'busy' };
    }
    return { kind: 'stale' };
  }

  async completeOutboxEvent(eventId: string, dispatchToken: string): Promise<void> {
    const completedAt = new Date().toISOString();
    await this.statement(
      `UPDATE outbox SET status = 'published', published_at = ?, updated_at = ?, last_error = NULL,
         dispatch_token = NULL, revision = revision + 1
       WHERE event_id = ? AND status = 'dispatching' AND dispatch_token = ?`,
      completedAt,
      completedAt,
      eventId,
      dispatchToken,
    ).run();
  }

  async releaseOutboxEvent(
    eventId: string,
    dispatchToken: string,
    errorCode: string,
  ): Promise<void> {
    const releasedAt = new Date().toISOString();
    const safeErrorCode = /^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(errorCode)
      ? errorCode
      : 'outbox_processing_failed';
    await this.statement(
      `UPDATE outbox SET
         status = CASE WHEN consumer_attempts >= ? THEN 'failed' ELSE 'pending' END,
         dispatch_token = CASE WHEN consumer_attempts >= ? THEN NULL ELSE dispatch_token END,
         last_error = ?, updated_at = ?, revision = revision + 1
       WHERE event_id = ? AND status = 'dispatching' AND dispatch_token = ?`,
      MAX_OUTBOX_CONSUMER_ATTEMPTS,
      MAX_OUTBOX_CONSUMER_ATTEMPTS,
      safeErrorCode,
      releasedAt,
      eventId,
      dispatchToken,
    ).run();
  }
}
