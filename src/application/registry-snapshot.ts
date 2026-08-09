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
  MAX_PORTABLE_EXPORT_BYTES,
  MAX_PORTABLE_EXPORT_ROWS_PER_TABLE,
  MAX_PORTABLE_EXPORT_TOTAL_ROWS,
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
    schemaVersion: z.literal(PORTABLE_EXPORT_SCHEMA_VERSION),
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

export function assertPortableExportRowCapacity(
  rowSets: ReadonlyArray<ReadonlyArray<unknown>>,
): void {
  const totalRows = rowSets.reduce((total, rows) => total + rows.length, 0);
  if (
    rowSets.some((rows) => rows.length > MAX_PORTABLE_EXPORT_ROWS_PER_TABLE) ||
    totalRows > MAX_PORTABLE_EXPORT_TOTAL_ROWS
  ) {
    throw new Error('portable_export_capacity_exceeded');
  }
}

export function serializePortableSnapshot(snapshot: PortableRegistrySnapshot): string {
  const body = JSON.stringify(sortJsonValue(snapshot));
  if (new TextEncoder().encode(body).byteLength > MAX_PORTABLE_EXPORT_BYTES) {
    throw new Error('portable_export_capacity_exceeded');
  }
  return body;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJsonValue(child)]),
  );
}
