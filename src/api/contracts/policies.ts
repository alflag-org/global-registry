import { createRoute, z } from '@hono/zod-openapi';
import type { PolicySummary } from '../../application/policies';
import type { PolicyVersion } from '../../domain/models/global-registry';
import { policyVersionRecordSchema } from '../../domain/models/schemas';
import {
  jsonRequest,
  jsonObjectSchema,
  jsonResponse,
  keySchema,
  pageLimitSchema,
  parseResponse,
  protectedRouteMetadata,
  resourceKindSchema,
  revisionSchema,
  versionParentStatusSchema,
} from './common';
import { standardErrorResponses } from './errors';

const listPoliciesQuerySchema = z
  .object({ limit: pageLimitSchema.optional() })
  .strict()
  .openapi('ListPoliciesQuery');

const createPolicyVersionRequestSchema = z
  .object({
    namespace: keySchema,
    key: keySchema,
    resourceKind: resourceKindSchema,
    resourceKindVersion: revisionSchema,
    spec: jsonObjectSchema,
    expectedRevision: revisionSchema.optional(),
  })
  .strict()
  .openapi('CreatePolicyVersionRequest');

const updatePolicyStatusRequestSchema = z
  .object({
    status: versionParentStatusSchema,
    expectedRevision: revisionSchema,
  })
  .strict()
  .openapi('UpdatePolicyStatusRequest');

const policySpecResponseSchema = jsonObjectSchema;

const policyVersionResponseSchema = policyVersionRecordSchema
  .extend({
    namespace: policyVersionRecordSchema.shape.namespace.openapi({ readOnly: true }),
    key: policyVersionRecordSchema.shape.key.openapi({ readOnly: true }),
    version: policyVersionRecordSchema.shape.version.openapi({ readOnly: true }),
    resourceKind: policyVersionRecordSchema.shape.resourceKind.openapi({ readOnly: true }),
    resourceKindVersion: policyVersionRecordSchema.shape.resourceKindVersion.openapi({
      readOnly: true,
    }),
    spec: policySpecResponseSchema,
    parentStatus: policyVersionRecordSchema.shape.parentStatus.openapi({ readOnly: true }),
    revision: policyVersionRecordSchema.shape.revision.openapi({ readOnly: true }),
    createdAt: policyVersionRecordSchema.shape.createdAt.openapi({ readOnly: true }),
  })
  .strict()
  .openapi('PolicyVersion');

const policySummaryResponseSchema = policyVersionRecordSchema
  .pick({
    namespace: true,
    key: true,
    resourceKind: true,
    resourceKindVersion: true,
    version: true,
  })
  .extend({
    namespace: policyVersionRecordSchema.shape.namespace.openapi({ readOnly: true }),
    key: policyVersionRecordSchema.shape.key.openapi({ readOnly: true }),
    resourceKind: policyVersionRecordSchema.shape.resourceKind.openapi({ readOnly: true }),
    resourceKindVersion: policyVersionRecordSchema.shape.resourceKindVersion.openapi({
      readOnly: true,
    }),
    version: policyVersionRecordSchema.shape.version.openapi({ readOnly: true }),
    status: versionParentStatusSchema,
  })
  .extend({
    revision: policyVersionRecordSchema.shape.revision.openapi({ readOnly: true }),
  })
  .strict()
  .openapi('PolicySummary');

const policyListResponseSchema = z
  .object({ items: z.array(policySummaryResponseSchema) })
  .strict()
  .openapi('PolicyList');

const policyKeyParamsSchema = z
  .object({
    namespace: keySchema.openapi({
      param: { name: 'namespace', in: 'path', required: true },
      example: 'compute',
    }),
    key: keySchema.openapi({
      param: { name: 'key', in: 'path', required: true },
      example: 'standard',
    }),
  })
  .openapi('PolicyKeyPathParameters');

const policyVersionParamsSchema = z
  .object({
    namespace: keySchema.openapi({
      param: { name: 'namespace', in: 'path', required: true },
      example: 'compute',
    }),
    key: keySchema.openapi({
      param: { name: 'key', in: 'path', required: true },
      example: 'standard',
    }),
    version: z.coerce
      .number()
      .int()
      .positive()
      .openapi({
        param: { name: 'version', in: 'path', required: true },
        example: 1,
      }),
  })
  .openapi('PolicyVersionPathParameters');

const policyVersionExample = {
  namespace: 'compute',
  key: 'standard',
  version: 1,
  resourceKind: 'compute',
  resourceKindVersion: 1,
  spec: { memoryMiB: { maximum: 8192 } },
  parentStatus: 'active',
  revision: 1,
  createdAt: '2026-07-28T01:00:00.000Z',
} as const;

const policySummaryExample = {
  namespace: policyVersionExample.namespace,
  key: policyVersionExample.key,
  resourceKind: policyVersionExample.resourceKind,
  resourceKindVersion: policyVersionExample.resourceKindVersion,
  version: 1,
  status: 'active',
  revision: 1,
} as const;

export const createPolicyVersionRoute = createRoute({
  method: 'post',
  path: '/api/v1/policies',
  operationId: 'createPolicyVersion',
  tags: ['Policies'],
  summary: 'Create a policy version',
  description:
    'Creates a policy or appends an immutable, kind-specific policy version using optimistic locking. Requires the admin role.',
  ...protectedRouteMetadata('admin'),
  request: {
    body: jsonRequest(
      createPolicyVersionRequestSchema,
      'The policy namespace, key, resource kind, strict constraints, and optional expected revision.',
      {
        namespace: policyVersionExample.namespace,
        key: policyVersionExample.key,
        resourceKind: policyVersionExample.resourceKind,
        resourceKindVersion: policyVersionExample.resourceKindVersion,
        spec: policyVersionExample.spec,
      },
    ),
  },
  responses: {
    201: jsonResponse(
      policyVersionResponseSchema,
      'The newly created immutable policy version.',
      policyVersionExample,
    ),
    ...standardErrorResponses(),
  },
});

export const listPoliciesRoute = createRoute({
  method: 'get',
  path: '/api/v1/policies',
  operationId: 'listPolicies',
  tags: ['Policies'],
  summary: 'List policies',
  description:
    'Lists current policy versions and lifecycle status. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: { query: listPoliciesQuerySchema },
  responses: {
    200: jsonResponse(policyListResponseSchema, 'All policy summaries.', {
      items: [policySummaryExample],
    }),
    ...standardErrorResponses(),
  },
});

export const updatePolicyStatusRoute = createRoute({
  method: 'patch',
  path: '/api/v1/policies/{namespace}/{key}',
  operationId: 'updatePolicyStatus',
  tags: ['Policies'],
  summary: 'Update policy status',
  description:
    'Changes policy lifecycle status with optimistic locking. Retired policies cannot be reactivated. Requires the admin role.',
  ...protectedRouteMetadata('admin'),
  request: {
    params: policyKeyParamsSchema,
    body: jsonRequest(
      updatePolicyStatusRequestSchema,
      'The target status and expected current revision.',
      { status: 'deprecated', expectedRevision: 1 },
    ),
  },
  responses: {
    200: jsonResponse(policySummaryResponseSchema, 'The updated policy summary.', {
      ...policySummaryExample,
      status: 'deprecated',
      revision: 2,
    }),
    ...standardErrorResponses(),
  },
});

export const getPolicyVersionRoute = createRoute({
  method: 'get',
  path: '/api/v1/policies/{namespace}/{key}/versions/{version}',
  operationId: 'getPolicyVersion',
  tags: ['Policies'],
  summary: 'Get a policy version',
  description: 'Returns one immutable policy version. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: { params: policyVersionParamsSchema },
  responses: {
    200: jsonResponse(
      policyVersionResponseSchema,
      'The requested immutable policy version.',
      policyVersionExample,
    ),
    ...standardErrorResponses(),
  },
});

export function toPolicyVersionResponse(policy: PolicyVersion) {
  return parseResponse(policyVersionResponseSchema, policy);
}

export function toPolicySummaryResponse(policy: PolicySummary) {
  return parseResponse(policySummaryResponseSchema, policy);
}

export function toPolicyListResponse(policies: PolicySummary[]) {
  return parseResponse(policyListResponseSchema, {
    items: policies.map(toPolicySummaryResponse),
  });
}
