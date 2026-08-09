import {
  assertPortableExportManifest,
  manifestChecksumPayload,
  MAX_EXPORT_RETENTION_WORK,
  PORTABLE_EXPORT_SCHEMA_VERSION,
  serializePortableExportObject,
  type ExportPersistencePort,
  type PortableExportChunkReference,
  type PortableExportManifest,
} from '../../application/ports';

const MANIFEST_FILENAME = 'manifest.json';
const R2_DELETE_BATCH_SIZE = 1_000;

async function checksum(value: string): Promise<{ digest: ArrayBuffer; value: string }> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return {
    digest,
    value: `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
  };
}

function manifestPrefix(manifestKey: string): string | null {
  return manifestKey.endsWith(MANIFEST_FILENAME)
    ? manifestKey.slice(0, -MANIFEST_FILENAME.length)
    : null;
}

function chunkObjectKey(prefix: string, entity: string, sequence: number): string {
  return `${prefix}${entity}-${String(sequence).padStart(6, '0')}.json`;
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
        await this.deleteOwnedObjects({
          exportId,
          revision: attempt.supersededClaim.revision,
          objectKey: attempt.supersededClaim.objectKey,
          claimToken: attempt.supersededClaim.claimToken,
        });
      }
      const prefix = manifestPrefix(attempt.objectKey);
      if (prefix === null) throw new Error('export_manifest_key_invalid');

      await this.repository.validatePortableExportSource();
      const chunks: PortableExportChunkReference[] = [];
      for await (const chunk of this.repository.readPortableExportChunks(exportId)) {
        const key = chunkObjectKey(prefix, chunk.entity, chunk.sequence);
        const body = serializePortableExportObject(chunk);
        const integrity = await checksum(body);
        await this.bucket.put(key, body, {
          httpMetadata: { contentType: 'application/json; charset=utf-8' },
          sha256: integrity.digest,
          customMetadata: {
            objectType: 'portable-export-chunk',
            exportId,
            entity: chunk.entity,
            sequence: String(chunk.sequence),
            rows: String(chunk.rows.length),
            checksum: integrity.value,
            schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
            claimToken: attempt.claimToken,
            revision: String(attempt.revision),
          },
        });
        await this.assertStoredObject(key, {
          objectType: 'portable-export-chunk',
          exportId,
          entity: chunk.entity,
          sequence: String(chunk.sequence),
          rows: String(chunk.rows.length),
          checksum: integrity.value,
          schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
          claimToken: attempt.claimToken,
          revision: String(attempt.revision),
        });
        chunks.push({
          entity: chunk.entity,
          sequence: chunk.sequence,
          key,
          rows: chunk.rows.length,
          checksum: integrity.value,
        });
        await this.repository.renewExportLease({
          exportId,
          revision: attempt.revision,
          objectKey: attempt.objectKey,
          claimToken: attempt.claimToken,
        });
      }

      const manifestWithoutChecksum: Omit<PortableExportManifest, 'checksum'> = {
        schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
        exportId,
        exportedAt: new Date().toISOString(),
        chunks,
      };
      const manifestIntegrity = await checksum(manifestChecksumPayload(manifestWithoutChecksum));
      const manifest = assertPortableExportManifest({
        ...manifestWithoutChecksum,
        checksum: manifestIntegrity.value,
      });
      const body = serializePortableExportObject(manifest);
      const bodyIntegrity = await checksum(body);
      await this.bucket.put(attempt.objectKey, body, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        sha256: bodyIntegrity.digest,
        customMetadata: {
          objectType: 'portable-export-manifest',
          exportId,
          checksum: bodyIntegrity.value,
          manifestChecksum: manifestIntegrity.value,
          chunks: String(chunks.length),
          schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
          claimToken: attempt.claimToken,
          revision: String(attempt.revision),
        },
      });
      await this.assertStoredObject(attempt.objectKey, {
        objectType: 'portable-export-manifest',
        exportId,
        checksum: bodyIntegrity.value,
        manifestChecksum: manifestIntegrity.value,
        chunks: String(chunks.length),
        schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
        claimToken: attempt.claimToken,
        revision: String(attempt.revision),
      });
      await this.repository.completeExport({
        exportId,
        revision: attempt.revision,
        checksum: bodyIntegrity.value,
        objectKey: attempt.objectKey,
        claimToken: attempt.claimToken,
      });
      completionAccepted = true;
      const completed = await this.repository.getExport(exportId);
      if (completed?.status !== 'succeeded') throw new Error('export_completion_unconfirmed');
    } catch (error) {
      const latest = await this.repository.getExport(exportId).catch(() => undefined);
      const authoritativeSucceeded = completionAccepted || latest?.status === 'succeeded';
      const ownsAuthoritativeObjects =
        completionAccepted ||
        (latest?.status === 'succeeded' && latest.r2ObjectKey === attempt.objectKey);
      if (!completionAccepted && latest !== undefined && !ownsAuthoritativeObjects) {
        await this.deleteOwnedObjects(attempt);
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

  private async assertStoredObject(key: string, expected: Record<string, string>): Promise<void> {
    const stored = await this.bucket.head(key);
    if (
      stored === null ||
      Object.entries(expected).some(([name, value]) => stored.customMetadata?.[name] !== value)
    ) {
      throw new Error('export_object_mismatch');
    }
  }

  private async deleteOwnedObjects(attempt: {
    exportId: string;
    revision: number;
    objectKey: string;
    claimToken: string;
  }): Promise<void> {
    const prefix = manifestPrefix(attempt.objectKey);
    if (prefix !== null) {
      await this.deletePrefix(prefix);
      return;
    }
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
      await this.bucket.delete(attempt.objectKey).catch(() => undefined);
    }
  }

  private async deletePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    let truncated = true;
    while (truncated) {
      const page = await this.bucket.list({
        prefix,
        limit: R2_DELETE_BATCH_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const keys = page.objects.map((object) => object.key);
      if (keys.length > 0) await this.bucket.delete(keys);
      if (page.truncated) {
        cursor = page.cursor;
        if (cursor === undefined) throw new Error('export_object_listing_invalid');
      } else {
        truncated = false;
      }
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
      const prefix = manifestPrefix(record.r2ObjectKey);
      if (prefix === null) await this.bucket.delete(record.r2ObjectKey);
      else await this.deletePrefix(prefix);
      await this.repository.markExportExpired(record.id, actorId);
      deleted += 1;
    }
    return deleted;
  }
}
