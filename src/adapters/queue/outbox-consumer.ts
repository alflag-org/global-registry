import type {
  ExportPersistencePort,
  OutboxDispatchMessage,
  OutboxPersistencePort,
} from '../../application/ports';

export interface ExportWriter {
  write(exportId: string): Promise<void>;
}

function dispatchMessageFromBody(body: unknown): OutboxDispatchMessage | null {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as { eventId?: unknown }).eventId !== 'string' ||
    typeof (body as { dispatchToken?: unknown }).dispatchToken !== 'string'
  ) {
    return null;
  }
  const message = body as { eventId: string; dispatchToken: string };
  if (
    message.eventId.length === 0 ||
    message.dispatchToken.length === 0 ||
    message.dispatchToken.length > 128
  ) {
    return null;
  }
  return message;
}

function exportIdFromPayload(payload: { readonly [key: string]: unknown }): string | null {
  return typeof payload.exportId === 'string' ? payload.exportId : null;
}

export async function consumeOutboxBatch(
  batch: MessageBatch<unknown>,
  repository: OutboxPersistencePort & ExportPersistencePort,
  exportWriter?: ExportWriter,
): Promise<void> {
  for (const message of batch.messages) {
    const dispatchMessage = dispatchMessageFromBody(message.body);
    if (dispatchMessage === null) {
      message.ack();
      continue;
    }
    const { eventId, dispatchToken } = dispatchMessage;
    let claimed = false;
    try {
      const claim = await repository.claimOutboxEvent(eventId, dispatchToken);
      if (claim.kind === 'stale') {
        message.ack();
        continue;
      }
      if (claim.kind === 'busy') {
        message.retry();
        continue;
      }
      claimed = true;
      const event = claim;
      if (event.eventType === 'export.requested') {
        const exportId = exportIdFromPayload(event.payload);
        if (exportId === null) throw new Error('Export event has no export ID.');
        if (exportWriter === undefined) throw new Error('outbox_storage_unavailable');
        await exportWriter.write(exportId);
        const completed = await repository.getExport(exportId);
        if (completed?.status !== 'succeeded') throw new Error('export_completion_unconfirmed');
      }
      await repository.completeOutboxEvent(eventId, dispatchToken);
      message.ack();
    } catch {
      console.error(
        JSON.stringify({
          message: 'outbox event failed',
          eventId,
          errorCode: 'outbox_processing_failed',
        }),
      );
      if (claimed) {
        try {
          await repository.releaseOutboxEvent(eventId, dispatchToken, 'outbox_processing_failed');
        } catch {
          // The explicit retry remains necessary if releasing the lease also fails.
        }
      }
      message.retry();
    }
  }
}
