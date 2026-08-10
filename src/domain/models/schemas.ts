import { z } from 'zod';
import { actorCreateInputSchema } from '../actor/schemas';
import { providerDefinitionSchema } from '../provider/schemas';
import { placementSchema } from '../resource/schemas';
import {
  resourceKindDefinitionInputSchema,
  resourceKindRelationshipRuleSchema,
  resourceKindSchema,
  resourceLifecycleStateSchema,
  resourceLifecycleTransitionSchema,
} from '../resource-kind/schemas';
import {
  DRIFT_SEVERITIES,
  DRIFT_STATUSES,
  EXPORT_STATUSES,
  HEALTH_STATUSES,
  OPERATION_STATUSES,
  OPERATION_STEP_STATUSES,
  RELATIONSHIP_TYPES,
  RESOURCE_SPECIFICATION_MODES,
  VERSION_PARENT_STATUSES,
} from './global-registry';
import { isBoundedJsonObject, isBoundedJsonValue } from './json';
import type { JsonObject, JsonValue } from './global-registry';

export const identifierSchema = z.string().min(1).max(256);
export const keySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits, and hyphens.');
export const revisionSchema = z.number().int().positive();
export const nonnegativeRevisionSchema = z.number().int().nonnegative();
export const timestampSchema = z.string().datetime();
export { resourceKindSchema };
export { resourceLifecycleStateSchema };
export const healthStatusSchema = z.enum(HEALTH_STATUSES);
export const driftStatusSchema = z.enum(DRIFT_STATUSES);
export const operationStatusSchema = z.enum(OPERATION_STATUSES);
export const operationStepStatusSchema = z.enum(OPERATION_STEP_STATUSES);
export const relationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);
export const versionParentStatusSchema = z.enum(VERSION_PARENT_STATUSES);
const exportStatusSchema = z.enum(EXPORT_STATUSES);

export const jsonValueSchema = z.custom<JsonValue>((value) => isBoundedJsonValue(value), {
  message: 'JSON value exceeds the supported depth or node-count limit.',
});
export const jsonObjectSchema = z.custom<JsonObject>((value) => isBoundedJsonObject(value), {
  message: 'JSON object exceeds the supported depth or node-count limit.',
});

export const versionedReferenceSchema = z
  .object({
    key: keySchema,
    version: revisionSchema,
  })
  .strict();

export const policyReferenceSchema = z
  .object({
    namespace: keySchema,
    key: keySchema,
    version: revisionSchema,
  })
  .strict();

export const resourceSpecSchema = jsonObjectSchema;

export const resourceSpecOverridesSchema = jsonObjectSchema;

export const resourceRecordSchema = z
  .object({
    id: identifierSchema,
    key: keySchema,
    kind: resourceKindSchema,
    kindVersion: revisionSchema,
    name: z.string().min(1).max(256),
    profile: versionedReferenceSchema.optional(),
    policy: policyReferenceSchema.optional(),
    placement: placementSchema,
    specOverrides: resourceSpecOverridesSchema,
    spec: resourceSpecSchema,
    lifecycleState: resourceLifecycleStateSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const providerRecordSchema = providerDefinitionSchema
  .extend({
    bindingRevision: nonnegativeRevisionSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const profileSpecSchema = resourceSpecOverridesSchema;

export const profileVersionRecordSchema = z
  .object({
    key: keySchema,
    version: revisionSchema,
    resourceKind: resourceKindSchema,
    resourceKindVersion: revisionSchema,
    spec: profileSpecSchema,
    parentStatus: versionParentStatusSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
  })
  .strict();

export const policySpecSchema = jsonObjectSchema;

export const policyVersionRecordSchema = z
  .object({
    namespace: keySchema,
    key: keySchema,
    version: revisionSchema,
    resourceKind: resourceKindSchema,
    resourceKindVersion: revisionSchema,
    spec: policySpecSchema,
    parentStatus: versionParentStatusSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
  })
  .strict();

export const resourceKindDefinitionVersionRecordSchema = resourceKindDefinitionInputSchema
  .extend({
    version: revisionSchema,
    specificationMode: z.enum(RESOURCE_SPECIFICATION_MODES),
    parentStatus: versionParentStatusSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    createdBy: identifierSchema.optional(),
    transitions: z.array(resourceLifecycleTransitionSchema),
    relationshipRules: z.array(resourceKindRelationshipRuleSchema),
  })
  .strict();

export const actorRecordSchema = z
  .object({
    id: identifierSchema,
    ...actorCreateInputSchema.shape,
    active: z.boolean(),
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const providerBindingRecordSchema = z
  .object({
    resourceId: identifierSchema,
    providerId: keySchema,
    providerResourceType: z.string().min(1).max(128),
    providerResourceId: z.string().min(1).max(256),
    providerResourceName: z.string().min(1).max(256).optional(),
    locator: jsonObjectSchema,
    boundAt: timestampSchema,
    boundBy: identifierSchema,
  })
  .strict();

export const resourceRelationshipRecordSchema = z
  .object({
    id: identifierSchema,
    sourceResourceId: identifierSchema,
    targetResourceId: identifierSchema,
    relationshipType: relationshipTypeSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    createdBy: identifierSchema,
  })
  .strict();

export const healthRecordSchema = z
  .object({
    resourceId: identifierSchema,
    status: healthStatusSchema,
    reason: z.string().min(1).max(512).optional(),
    observedAt: timestampSchema,
    observedBy: identifierSchema,
    revision: nonnegativeRevisionSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const observationRecordSchema = z
  .object({
    id: identifierSchema,
    resourceId: identifierSchema,
    observerId: identifierSchema,
    observedAt: timestampSchema,
    facts: jsonObjectSchema,
    expiresAt: timestampSchema,
    archivedAt: timestampSchema.optional(),
    r2ObjectKey: z.string().min(1).max(1024).optional(),
    createdAt: timestampSchema,
  })
  .strict();

export const driftRecordSchema = z
  .object({
    id: identifierSchema,
    resourceId: identifierSchema,
    severity: z.enum(DRIFT_SEVERITIES),
    status: driftStatusSchema,
    expected: jsonObjectSchema,
    observed: jsonObjectSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    createdBy: identifierSchema,
    resolvedAt: timestampSchema.optional(),
  })
  .strict();

export const operationResourcePlanSchema = z
  .object({
    resourceKey: keySchema,
    sourceState: resourceLifecycleStateSchema,
    targetState: resourceLifecycleStateSchema,
    resourceRevision: revisionSchema,
  })
  .strict();

export const operationStepPlanSchema = z
  .object({
    position: z.number().int().nonnegative(),
    name: z.string().min(1).max(256),
    gate: jsonObjectSchema,
    evidence: jsonObjectSchema.optional(),
  })
  .strict();

export const operationStepRecordSchema = z
  .object({
    id: identifierSchema,
    operationId: identifierSchema,
    position: z.number().int().nonnegative(),
    name: z.string().min(1).max(256),
    status: operationStepStatusSchema,
    gate: jsonObjectSchema,
    evidence: jsonObjectSchema,
    revision: revisionSchema,
    startedAt: timestampSchema.optional(),
    completedAt: timestampSchema.optional(),
  })
  .strict();

export const operationRecordSchema = z
  .object({
    id: identifierSchema,
    actorId: identifierSchema,
    kind: z.string().min(1).max(128),
    status: operationStatusSchema,
    plan: jsonObjectSchema,
    planHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    destructive: z.boolean(),
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const lockLeaseRecordSchema = z
  .object({
    scope: z.string().min(3).max(256),
    operationId: identifierSchema,
    fencingToken: revisionSchema,
    expiresAt: timestampSchema,
  })
  .strict();

export const auditEventRecordSchema = z
  .object({
    eventId: identifierSchema,
    eventType: z.string().min(1).max(256),
    resourceKey: keySchema.optional(),
    operationId: identifierSchema.optional(),
    actorId: identifierSchema,
    payload: jsonObjectSchema,
    occurredAt: timestampSchema,
  })
  .strict();

export const exportRecordSchema = z
  .object({
    id: identifierSchema,
    schemaVersion: z.string().min(1).max(64),
    checksum: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    r2ObjectKey: z.string().min(1).max(1024).optional(),
    status: exportStatusSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    requestedBy: identifierSchema,
    errorMessage: z.string().min(1).max(2048).optional(),
    expiredAt: timestampSchema.optional(),
  })
  .strict();
