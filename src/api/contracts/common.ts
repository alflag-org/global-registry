import { z } from '@hono/zod-openapi';
import type { ActorRole } from '../../domain/models/global-registry';
import {
  driftStatusSchema as domainDriftStatusSchema,
  healthStatusSchema as domainHealthStatusSchema,
  identifierSchema as domainIdentifierSchema,
  jsonObjectSchema as domainJsonObjectSchema,
  keySchema as domainKeySchema,
  nonnegativeRevisionSchema as domainNonnegativeRevisionSchema,
  operationStatusSchema as domainOperationStatusSchema,
  policyReferenceSchema as domainPolicyReferenceSchema,
  relationshipTypeSchema as domainRelationshipTypeSchema,
  resourceKindSchema as domainResourceKindSchema,
  resourceLifecycleStateSchema as domainResourceLifecycleStateSchema,
  revisionSchema as domainRevisionSchema,
  timestampSchema as domainTimestampSchema,
  versionedReferenceSchema,
  versionParentStatusSchema as domainVersionParentStatusSchema,
} from '../../domain/models/schemas';
import { operationRolePolicy } from '../actor-authorization';
import { authorization } from '../middleware/authorization';
import {
  DEFAULT_AUDIT_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  MAX_AUDIT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../../domain/models/pagination';

const cloudflareAccessSecurity: Array<Record<string, string[]>> = [{ CloudflareAccess: [] }];

export function protectedRouteMetadata<const Roles extends ActorRole[]>(...roles: Roles) {
  return {
    middleware: [authorization(...roles)],
    security: cloudflareAccessSecurity,
    'x-required-roles': roles,
  };
}

export function operationRouteMetadata() {
  return {
    ...protectedRouteMetadata(...operationRolePolicy.defaultRoles),
    'x-conditional-required-roles': [
      {
        when: operationRolePolicy.destructiveCondition,
        roles: operationRolePolicy.destructiveRoles,
      },
    ],
  };
}

export function accessPrincipalRouteMetadata() {
  return {
    security: cloudflareAccessSecurity,
    'x-required-roles': [] as ActorRole[],
  };
}

export const identifierSchema = domainIdentifierSchema;
export const keySchema = domainKeySchema;
export const revisionSchema = domainRevisionSchema;
export const nonnegativeRevisionSchema = domainNonnegativeRevisionSchema;
export const timestampSchema = domainTimestampSchema.openapi({ format: 'date-time' });
export const resourceKindSchema = domainResourceKindSchema;
export const resourceLifecycleStateSchema = domainResourceLifecycleStateSchema;
export const healthStatusSchema = domainHealthStatusSchema;
export const driftStatusSchema = domainDriftStatusSchema;
export const operationStatusSchema = domainOperationStatusSchema;
export const relationshipTypeSchema = domainRelationshipTypeSchema;
export const versionParentStatusSchema = domainVersionParentStatusSchema;

export const jsonObjectSchema = domainJsonObjectSchema.openapi('JsonObject', {
  description: 'A JSON object with maximum nesting depth 64 and maximum node count 10000.',
  type: 'object',
  additionalProperties: { $ref: '#/components/schemas/JsonValue' },
});

export const profileReferenceSchema = versionedReferenceSchema.openapi('ProfileReference');

export const policyReferenceSchema = domainPolicyReferenceSchema.openapi('PolicyReference');

export const fencingSchema = z
  .object({
    expectedRevision: revisionSchema,
    lockScope: z.string().min(3).max(256),
    fencingToken: revisionSchema,
  })
  .strict()
  .openapi('FencingRequest');

export const pageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .default(DEFAULT_PAGE_SIZE)
  .openapi({
    param: { name: 'limit', in: 'query' },
    example: 50,
  });

export const auditPageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_AUDIT_PAGE_SIZE)
  .default(DEFAULT_AUDIT_PAGE_SIZE)
  .openapi({
    param: { name: 'limit', in: 'query' },
    example: 100,
  });

export function jsonRequest<T extends z.ZodType>(schema: T, description: string, example: unknown) {
  return {
    required: true,
    description,
    content: {
      'application/json': {
        schema,
        example,
      },
    },
  };
}

export function jsonResponse<T extends z.ZodType>(
  schema: T,
  description: string,
  example: unknown,
) {
  return {
    description,
    content: {
      'application/json': {
        schema,
        example,
      },
    },
  };
}

export const noContentResponse = {
  description: 'The mutation completed successfully and returned no response body.',
};

export function parseResponse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  return schema.parse(value);
}

export function nullableSchema<T extends z.ZodType>(schema: T) {
  return z.union([schema, z.null()]);
}
