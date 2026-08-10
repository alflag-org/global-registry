import { z } from 'zod';
import {
  actorRecordSchema,
  auditEventRecordSchema,
  driftRecordSchema,
  exportRecordSchema,
  healthRecordSchema,
  jsonObjectSchema,
  keySchema,
  operationRecordSchema,
  operationStepRecordSchema,
  policySpecSchema,
  profileSpecSchema,
  providerBindingRecordSchema,
  providerRecordSchema,
  resourceKindSchema,
  resourceLifecycleStateSchema,
  resourceRecordSchema,
  resourceRelationshipRecordSchema,
  revisionSchema,
  timestampSchema,
} from '../domain/models/schemas';
import { RELATIONSHIP_TYPES, VERSION_PARENT_STATUSES } from '../domain/models/global-registry';
import {
  MAX_PORTABLE_EXPORT_OBJECT_BYTES,
  MAX_PORTABLE_EXPORT_ROWS_PER_CHUNK,
  PORTABLE_EXPORT_SCHEMA_VERSION,
} from './limits';

const identifierSchema = z.string().trim().min(1).max(512);
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const parentStatusSchema = z.enum(VERSION_PARENT_STATUSES);
const relationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);

export const portableActorSchema = actorRecordSchema
  .extend({
    createdBy: identifierSchema,
    updatedBy: identifierSchema,
  })
  .strict();

export const portableProfileSchema = z
  .object({
    key: keySchema,
    resourceKind: resourceKindSchema,
    status: parentStatusSchema,
    currentVersion: revisionSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const portableProfileVersionSchema = z
  .object({
    profileKey: keySchema,
    version: revisionSchema,
    spec: profileSpecSchema,
    createdAt: timestampSchema,
    createdBy: identifierSchema,
  })
  .strict();

export const portablePolicySchema = z
  .object({
    namespace: keySchema,
    key: keySchema,
    status: parentStatusSchema,
    currentVersion: revisionSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const portablePolicyVersionSchema = z
  .object({
    namespace: keySchema,
    policyKey: keySchema,
    version: revisionSchema,
    resourceKind: resourceKindSchema,
    spec: policySpecSchema,
    createdAt: timestampSchema,
    createdBy: identifierSchema,
  })
  .strict();

export const portableBindingSchema = providerBindingRecordSchema
  .extend({ active: z.literal(true) })
  .strict();

export const portableRelationshipHistorySchema = z
  .object({
    id: identifierSchema,
    relationshipId: identifierSchema,
    sourceResourceId: identifierSchema,
    targetResourceId: identifierSchema,
    relationshipType: relationshipTypeSchema,
    relationshipRevision: revisionSchema,
    createdAt: timestampSchema,
    createdBy: identifierSchema,
    removedAt: timestampSchema,
    removedBy: identifierSchema,
    operationId: identifierSchema,
  })
  .strict();

export const portableBindingHistorySchema = z
  .object({
    id: identifierSchema,
    resourceId: identifierSchema,
    providerId: identifierSchema,
    providerResourceType: z.string().trim().min(1).max(128),
    providerResourceId: z.string().trim().min(1).max(256),
    providerResourceName: z.string().trim().min(1).max(256).optional(),
    locator: jsonObjectSchema,
    boundAt: timestampSchema,
    unboundAt: timestampSchema,
    boundBy: identifierSchema,
    unboundBy: identifierSchema,
    operationId: identifierSchema.optional(),
  })
  .strict();

export const portableHealthSchema = healthRecordSchema
  .extend({ revision: revisionSchema })
  .strict();

export const portableObservationSchema = z
  .object({
    id: identifierSchema,
    resourceId: identifierSchema,
    observerId: identifierSchema,
    observedAt: timestampSchema,
    facts: jsonObjectSchema,
    expiresAt: timestampSchema,
    archivedAt: timestampSchema.optional(),
    r2ObjectKey: z.string().trim().min(1).max(1024).optional(),
    createdAt: timestampSchema,
  })
  .strict();

export const portableDriftSchema = driftRecordSchema
  .extend({
    fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export const portableOperationResourceSchema = z
  .object({
    operationId: identifierSchema,
    resourceId: identifierSchema,
    resourceKey: keySchema,
    sourceState: resourceLifecycleStateSchema,
    targetState: resourceLifecycleStateSchema,
    resourceRevision: revisionSchema,
  })
  .strict();

export const portableOperationStepSchema = operationStepRecordSchema
  .extend({ updatedAt: timestampSchema })
  .strict();

export const portableOperationChangeSchema = z
  .object({
    operationId: identifierSchema,
    position: nonnegativeIntegerSchema,
    action: z.enum([
      'binding.replace',
      'binding.remove',
      'relationship.create',
      'relationship.remove',
    ]),
    resourceId: identifierSchema,
    providerId: identifierSchema.optional(),
    providerResourceType: z.string().trim().min(1).max(128).optional(),
    providerResourceId: z.string().trim().min(1).max(256).optional(),
    relationshipId: identifierSchema.optional(),
    targetResourceId: identifierSchema.optional(),
    relationshipType: relationshipTypeSchema.optional(),
  })
  .strict();

export const portableLockSchema = z
  .object({
    scope: z.string().trim().min(3).max(256),
    operationId: identifierSchema,
    actorId: identifierSchema,
    fencingToken: revisionSchema,
    expiresAt: timestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const portableLockGenerationSchema = z
  .object({ scope: z.string().trim().min(3).max(256), generation: nonnegativeIntegerSchema })
  .strict();

export const portableOutboxSchema = z
  .object({
    id: identifierSchema,
    eventId: identifierSchema,
    topic: z.string().trim().min(1).max(256),
    payload: jsonObjectSchema,
    status: z.enum(['pending', 'dispatching', 'published', 'failed']),
    consumerAttempts: nonnegativeIntegerSchema,
    producerAttempts: nonnegativeIntegerSchema,
    createdAt: timestampSchema,
    publishedAt: timestampSchema.optional(),
    lastError: z.string().trim().min(1).max(128).optional(),
    revision: revisionSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const portableExportSchema = exportRecordSchema
  .extend({
    attempts: nonnegativeIntegerSchema,
    leaseUntil: timestampSchema.optional(),
    updatedAt: timestampSchema,
  })
  .strict();

export const registrySnapshotSchema = z
  .object({
    schemaVersion: z.literal(PORTABLE_EXPORT_SCHEMA_VERSION),
    exportedAt: timestampSchema,
    actors: z.array(portableActorSchema),
    providers: z.array(providerRecordSchema),
    profiles: z.array(portableProfileSchema),
    profileVersions: z.array(portableProfileVersionSchema),
    policies: z.array(portablePolicySchema),
    policyVersions: z.array(portablePolicyVersionSchema),
    resources: z.array(resourceRecordSchema),
    relationships: z.array(resourceRelationshipRecordSchema),
    relationshipHistory: z.array(portableRelationshipHistorySchema),
    bindings: z.array(portableBindingSchema),
    bindingHistory: z.array(portableBindingHistorySchema),
    health: z.array(portableHealthSchema),
    observations: z.array(portableObservationSchema),
    drifts: z.array(portableDriftSchema),
    operations: z.array(operationRecordSchema),
    operationResources: z.array(portableOperationResourceSchema),
    operationSteps: z.array(portableOperationStepSchema),
    operationChanges: z.array(portableOperationChangeSchema),
    locks: z.array(portableLockSchema),
    lockGenerations: z.array(portableLockGenerationSchema),
    events: z.array(auditEventRecordSchema),
    outbox: z.array(portableOutboxSchema),
    exports: z.array(portableExportSchema),
  })
  .strict();

export type PortableRegistrySnapshot = z.output<typeof registrySnapshotSchema>;

export const PORTABLE_EXPORT_ENTITIES = [
  'actors',
  'providers',
  'profiles',
  'profileVersions',
  'policies',
  'policyVersions',
  'resources',
  'relationships',
  'relationshipHistory',
  'bindings',
  'bindingHistory',
  'health',
  'observations',
  'drifts',
  'operations',
  'operationResources',
  'operationSteps',
  'operationChanges',
  'locks',
  'lockGenerations',
  'events',
  'outbox',
  'exports',
] as const;

export type PortableExportEntity = (typeof PORTABLE_EXPORT_ENTITIES)[number];

const portableEntitySchema: Record<PortableExportEntity, z.ZodType> = {
  actors: portableActorSchema,
  providers: providerRecordSchema,
  profiles: portableProfileSchema,
  profileVersions: portableProfileVersionSchema,
  policies: portablePolicySchema,
  policyVersions: portablePolicyVersionSchema,
  resources: resourceRecordSchema,
  relationships: resourceRelationshipRecordSchema,
  relationshipHistory: portableRelationshipHistorySchema,
  bindings: portableBindingSchema,
  bindingHistory: portableBindingHistorySchema,
  health: portableHealthSchema,
  observations: portableObservationSchema,
  drifts: portableDriftSchema,
  operations: operationRecordSchema,
  operationResources: portableOperationResourceSchema,
  operationSteps: portableOperationStepSchema,
  operationChanges: portableOperationChangeSchema,
  locks: portableLockSchema,
  lockGenerations: portableLockGenerationSchema,
  events: auditEventRecordSchema,
  outbox: portableOutboxSchema,
  exports: portableExportSchema,
};

const portableExportEntitySchema = z.enum(PORTABLE_EXPORT_ENTITIES);
const checksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export interface PortableExportChunk {
  schemaVersion: typeof PORTABLE_EXPORT_SCHEMA_VERSION;
  exportId: string;
  entity: PortableExportEntity;
  sequence: number;
  rows: unknown[];
}

export interface PortableExportChunkReference {
  entity: PortableExportEntity;
  sequence: number;
  key: string;
  rows: number;
  checksum: string;
}

export interface PortableExportManifest {
  schemaVersion: typeof PORTABLE_EXPORT_SCHEMA_VERSION;
  exportId: string;
  exportedAt: string;
  checksum: string;
  chunks: PortableExportChunkReference[];
}

const portableExportChunkHeaderSchema = z
  .object({
    schemaVersion: z.literal(PORTABLE_EXPORT_SCHEMA_VERSION),
    exportId: identifierSchema,
    entity: portableExportEntitySchema,
    sequence: z.number().int().positive(),
    rows: z.array(z.unknown()).max(MAX_PORTABLE_EXPORT_ROWS_PER_CHUNK),
  })
  .strict();

const portableExportChunkReferenceSchema = z
  .object({
    entity: portableExportEntitySchema,
    sequence: z.number().int().positive(),
    key: z.string().trim().min(1).max(1024),
    rows: z.number().int().nonnegative().max(MAX_PORTABLE_EXPORT_ROWS_PER_CHUNK),
    checksum: checksumSchema,
  })
  .strict();

const portableExportManifestSchema = z
  .object({
    schemaVersion: z.literal(PORTABLE_EXPORT_SCHEMA_VERSION),
    exportId: identifierSchema,
    exportedAt: timestampSchema,
    checksum: checksumSchema,
    chunks: z.array(portableExportChunkReferenceSchema),
  })
  .strict();

export function assertPortableExportChunk(value: unknown): PortableExportChunk {
  const chunk = portableExportChunkHeaderSchema.parse(value);
  const rows = portableEntitySchema[chunk.entity].array().parse(chunk.rows);
  return { ...chunk, rows };
}

export function assertPortableExportManifest(value: unknown): PortableExportManifest {
  const manifest = portableExportManifestSchema.parse(value);
  let entityIndex = 0;
  let expectedSequence = 1;
  for (const [chunkIndex, chunk] of manifest.chunks.entries()) {
    const currentEntity = PORTABLE_EXPORT_ENTITIES[entityIndex];
    if (chunk.entity !== currentEntity || chunk.sequence !== expectedSequence) {
      throw new Error('portable_export_manifest_sequence_invalid');
    }
    const next = manifest.chunks[chunkIndex + 1];
    if (next?.entity === currentEntity) {
      if (chunk.rows !== MAX_PORTABLE_EXPORT_ROWS_PER_CHUNK) {
        throw new Error('portable_export_manifest_chunk_boundary_invalid');
      }
      expectedSequence += 1;
      continue;
    }
    entityIndex += 1;
    expectedSequence = 1;
  }
  if (entityIndex !== PORTABLE_EXPORT_ENTITIES.length) {
    throw new Error('portable_export_manifest_entities_incomplete');
  }
  if (new Set(manifest.chunks.map((chunk) => chunk.key)).size !== manifest.chunks.length) {
    throw new Error('portable_export_manifest_chunk_key_duplicate');
  }
  return manifest;
}

export function serializePortableExportObject(value: unknown): string {
  const body = JSON.stringify(sortJsonValue(value));
  if (new TextEncoder().encode(body).byteLength > MAX_PORTABLE_EXPORT_OBJECT_BYTES) {
    throw new Error('portable_export_object_too_large');
  }
  return body;
}

export function manifestChecksumPayload(
  manifest: Omit<PortableExportManifest, 'checksum'> | PortableExportManifest,
): string {
  return serializePortableExportObject({
    schemaVersion: manifest.schemaVersion,
    exportId: manifest.exportId,
    exportedAt: manifest.exportedAt,
    chunks: manifest.chunks,
  });
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJsonValue(child)]),
  );
}
