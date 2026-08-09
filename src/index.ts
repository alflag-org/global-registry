import { createApp } from './api/app';
import { D1GlobalRegistryRepository } from './adapters/d1/repository';
import { consumeOutboxBatch } from './adapters/queue/outbox-consumer';
import { R2ExportWriter } from './adapters/r2/exporter';
import { R2ObservationArchiver } from './adapters/r2/observation-archiver';
import { MAX_OBSERVATION_ARCHIVE_WORK } from './application/limits';

const app = createApp();

async function runScheduledMaintenance(event: ScheduledController, env: Env): Promise<void> {
  if (env.BACKUP_ACTOR_ID === 'unset') {
    console.warn(JSON.stringify({ message: 'scheduled backup skipped: BACKUP_ACTOR_ID is unset' }));
    return;
  }
  if (env.EXPORTS_BUCKET === undefined || env.EVENT_QUEUE === undefined) {
    console.warn(
      JSON.stringify({
        message: 'scheduled backup skipped: asynchronous storage bindings are unavailable',
      }),
    );
    return;
  }
  const repository = new D1GlobalRegistryRepository(env.DB);
  const backupActor = await repository.getActor(env.BACKUP_ACTOR_ID);
  if (backupActor === null || !backupActor.active || backupActor.role !== 'admin') {
    console.error(
      JSON.stringify({
        message: 'scheduled backup skipped: configured actor must be an active admin',
      }),
    );
    return;
  }
  const scheduledAt = new Date(event.scheduledTime);
  const exportWriter = new R2ExportWriter(repository, env.EXPORTS_BUCKET);
  await new R2ObservationArchiver(repository, env.EXPORTS_BUCKET).archiveExpired(
    backupActor.id,
    scheduledAt,
    MAX_OBSERVATION_ARCHIVE_WORK,
  );
  await exportWriter.pruneRetention(backupActor.id, scheduledAt);
  await repository.createScheduledExport(backupActor.id, scheduledAt.toISOString().slice(0, 10));
  await repository.dispatchPendingOutbox(env.EVENT_QUEUE);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const response = await app.fetch(request, env, ctx);
    const url = new URL(request.url);
    const mutatingMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
    if (
      response.ok &&
      mutatingMethod &&
      url.pathname.startsWith('/api/v1/') &&
      env.EVENT_QUEUE !== undefined
    ) {
      ctx.waitUntil(new D1GlobalRegistryRepository(env.DB).dispatchPendingOutbox(env.EVENT_QUEUE));
    }
    return response;
  },

  async queue(batch, env): Promise<void> {
    const repository = new D1GlobalRegistryRepository(env.DB);
    const exportWriter =
      env.EXPORTS_BUCKET === undefined
        ? undefined
        : new R2ExportWriter(repository, env.EXPORTS_BUCKET);
    await consumeOutboxBatch(batch, repository, exportWriter);
  },

  async scheduled(event, env, ctx): Promise<void> {
    ctx.waitUntil(runScheduledMaintenance(event, env));
  },
} satisfies ExportedHandler<Env>;
