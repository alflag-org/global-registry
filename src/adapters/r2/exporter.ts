import {
  assertValidRegistrySnapshot,
  MAX_EXPORT_RETENTION_WORK,
  PORTABLE_EXPORT_SCHEMA_VERSION,
  serializePortableSnapshot,
  type ExportPersistencePort,
} from '../../application/ports';

async function checksum(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export class R2ExportWriter {
  constructor(
    private readonly repository: ExportPersistencePort,
    private readonly bucket: R2Bucket,
  ) {}

  async write(exportId: string): Promise<void> {
    const attempt = await this.repository.claimExport(exportId);
    if (attempt === null) {
      const exportRecord = await this.repository.getExport(exportId);
      if (exportRecord?.status === 'succeeded') return;
      throw new Error('export_lease_unavailable');
    }
    let completionAccepted = false;
    try {
      if (attempt.supersededClaim !== undefined) {
        await this.deleteOwnedObject({
          exportId,
          revision: attempt.supersededClaim.revision,
          objectKey: attempt.supersededClaim.objectKey,
          claimToken: attempt.supersededClaim.claimToken,
        });
      }
      const snapshot = assertValidRegistrySnapshot(await this.repository.buildPortableSnapshot());
      const body = serializePortableSnapshot(snapshot);
      const digest = await checksum(body);
      await this.bucket.put(attempt.objectKey, body, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: {
          exportId,
          checksum: digest,
          schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
          claimToken: attempt.claimToken,
          revision: String(attempt.revision),
        },
      });
      const stored = await this.bucket.head(attempt.objectKey);
      if (
        stored === null ||
        stored.customMetadata?.exportId !== exportId ||
        stored.customMetadata?.checksum !== digest ||
        stored.customMetadata?.schemaVersion !== PORTABLE_EXPORT_SCHEMA_VERSION ||
        stored.customMetadata?.claimToken !== attempt.claimToken ||
        stored.customMetadata?.revision !== String(attempt.revision)
      ) {
        throw new Error('export_object_mismatch');
      }
      await this.repository.completeExport({
        exportId,
        revision: attempt.revision,
        checksum: digest,
        objectKey: attempt.objectKey,
        claimToken: attempt.claimToken,
      });
      completionAccepted = true;
      const completed = await this.repository.getExport(exportId);
      if (completed?.status !== 'succeeded') throw new Error('export_completion_unconfirmed');
    } catch (error) {
      const latest = await this.repository.getExport(exportId).catch(() => undefined);
      const authoritativeSucceeded = completionAccepted || latest?.status === 'succeeded';
      const ownsAuthoritativeObject =
        completionAccepted ||
        (latest?.status === 'succeeded' && latest.r2ObjectKey === attempt.objectKey);
      if (!completionAccepted && latest !== undefined && !ownsAuthoritativeObject) {
        await this.deleteOwnedObject(attempt);
      }
      if (!authoritativeSucceeded && latest !== undefined) {
        try {
          await this.repository.failExport({
            exportId,
            revision: attempt.revision,
            claimToken: attempt.claimToken,
            errorCode: 'export_processing_failed',
          });
        } catch {
          // A lost lease is intentionally left for stale-lease recovery.
        }
      }
      throw new Error('export_processing_failed', { cause: error });
    }
  }

  private async deleteOwnedObject(attempt: {
    exportId: string;
    revision: number;
    objectKey: string;
    claimToken: string;
  }): Promise<void> {
    try {
      const object = await this.bucket.head(attempt.objectKey);
      if (
        object === null ||
        (object.customMetadata?.exportId === attempt.exportId &&
          object.customMetadata?.claimToken === attempt.claimToken &&
          object.customMetadata?.revision === String(attempt.revision))
      ) {
        await this.bucket.delete(attempt.objectKey);
      }
    } catch {
      // The key contains this claim token, so a best-effort delete cannot target a newer claim.
      await this.bucket.delete(attempt.objectKey).catch(() => undefined);
    }
  }

  async pruneRetention(actorId: string, referenceTime: Date): Promise<number> {
    const records = await this.repository.listRetainableExports(
      referenceTime.toISOString(),
      MAX_EXPORT_RETENTION_WORK,
    );
    let deleted = 0;
    for (const record of records) {
      if (record.r2ObjectKey === undefined) continue;
      await this.bucket.delete(record.r2ObjectKey);
      await this.repository.markExportExpired(record.id, actorId);
      deleted += 1;
    }
    return deleted;
  }
}
