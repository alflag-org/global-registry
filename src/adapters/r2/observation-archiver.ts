import {
  MAX_OBSERVATION_ARCHIVE_WORK,
  type ExpiredObservation,
  type ObservationArchivePersistencePort,
} from '../../application/ports';

function archiveKey(observation: ExpiredObservation): string {
  return `observations/${observation.resourceKey}/${observation.id}.json`;
}

/** Moves expired observation payloads to R2 while leaving an auditable D1 pointer. */
export class R2ObservationArchiver {
  constructor(
    private readonly repository: ObservationArchivePersistencePort,
    private readonly bucket: R2Bucket,
  ) {}

  async archiveExpired(
    actorId: string,
    referenceTime: Date,
    limit = MAX_OBSERVATION_ARCHIVE_WORK,
  ): Promise<number> {
    const observations = await this.repository.listExpiredObservations(
      referenceTime.toISOString(),
      Math.min(Math.max(limit, 1), MAX_OBSERVATION_ARCHIVE_WORK),
    );
    let archived = 0;
    for (const observation of observations) {
      const key = archiveKey(observation);
      await this.bucket.put(
        key,
        JSON.stringify({
          schemaVersion: '1.0',
          archivedAt: referenceTime.toISOString(),
          observation,
        }),
        {
          httpMetadata: { contentType: 'application/json; charset=utf-8' },
          customMetadata: {
            observationId: observation.id,
            resourceKey: observation.resourceKey,
          },
        },
      );
      if (
        await this.repository.markObservationArchived({
          id: observation.id,
          resourceKey: observation.resourceKey,
          r2ObjectKey: key,
          actorId,
        })
      ) {
        archived += 1;
      }
    }
    return archived;
  }
}
