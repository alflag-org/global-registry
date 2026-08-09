import { createRoute, z } from '@hono/zod-openapi';
import type {
  Drift,
  Health,
  ProviderBinding,
  Resource,
  ResourceRelationship,
} from '../../domain/models/global-registry';
import { RESOURCE_KINDS } from '../../domain/models/global-registry';
import { MAX_RESOURCE_DETAIL_PAGE_SIZE } from '../../domain/models/pagination';
import {
  resourceRecordSchema,
  resourceSpecOverridesSchema as domainResourceSpecOverridesSchema,
  resourceSpecSchema as domainResourceSpecSchema,
} from '../../domain/models/schemas';
import { placementSchema, resourceSpecOverrideSchemas } from '../../domain/resource/schemas';
import { auditEventListResponseSchema } from './observations';
import { providerBindingResponseSchema, toProviderBindingResponse } from './bindings';
import {
  driftResponseSchema,
  healthResponseSchema,
  toDriftResponse,
  toHealthResponse,
} from './observations';
import {
  resourceRelationshipResponseSchema,
  toResourceRelationshipResponse,
} from './relationships';
import {
  identifierSchema,
  auditPageLimitSchema,
  jsonRequest,
  jsonResponse,
  keySchema,
  nullableSchema,
  operationRouteMetadata,
  pageLimitSchema,
  parseResponse,
  policyReferenceSchema,
  profileReferenceSchema,
  protectedRouteMetadata,
  resourceKindSchema,
  resourceLifecycleStateSchema,
  revisionSchema,
} from './common';
import { standardErrorResponses } from './errors';

const resourceSpecSchema = domainResourceSpecSchema.openapi('ResourceSpec');

const resourceSpecOverridesSchema =
  domainResourceSpecOverridesSchema.openapi('ResourceSpecOverrides');

function createResourceVariant<const Kind extends (typeof RESOURCE_KINDS)[number]>(kind: Kind) {
  return z
    .object({
      key: keySchema,
      kind: z.literal(kind),
      name: z.string().min(1).max(256),
      placement: placementSchema.default({}),
      specOverrides: resourceSpecOverrideSchemas[kind],
      profile: profileReferenceSchema.optional(),
      policy: policyReferenceSchema.optional(),
    })
    .strict();
}

const createResourceRequestSchema = z
  .discriminatedUnion('kind', [
    createResourceVariant(RESOURCE_KINDS[0]),
    createResourceVariant(RESOURCE_KINDS[1]),
    createResourceVariant(RESOURCE_KINDS[2]),
    createResourceVariant(RESOURCE_KINDS[3]),
    createResourceVariant(RESOURCE_KINDS[4]),
    createResourceVariant(RESOURCE_KINDS[5]),
    createResourceVariant(RESOURCE_KINDS[6]),
    createResourceVariant(RESOURCE_KINDS[7]),
  ])
  .openapi('CreateResourceRequest');

const updateResourceRequestSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    placement: placementSchema.optional(),
    specOverrides: resourceSpecOverridesSchema.optional(),
    expectedRevision: revisionSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.placement !== undefined ||
      value.specOverrides !== undefined,
    'At least one mutable resource field is required.',
  )
  .openapi('UpdateResourceRequest');

const transitionResourceRequestSchema = z
  .object({
    targetState: resourceLifecycleStateSchema,
    expectedRevision: revisionSchema,
    operationId: identifierSchema,
    fencingToken: revisionSchema,
  })
  .strict()
  .openapi('TransitionResourceRequest');

const resourceResponseSchema = resourceRecordSchema
  .extend({
    id: resourceRecordSchema.shape.id.openapi({ readOnly: true }),
    key: resourceRecordSchema.shape.key.openapi({ readOnly: true }),
    kind: resourceRecordSchema.shape.kind.openapi({ readOnly: true }),
    profile: nullableSchema(profileReferenceSchema),
    policy: nullableSchema(policyReferenceSchema),
    specOverrides: resourceSpecOverridesSchema,
    spec: resourceSpecSchema.openapi({ readOnly: true }),
    lifecycleState: resourceRecordSchema.shape.lifecycleState.openapi({ readOnly: true }),
    revision: resourceRecordSchema.shape.revision.openapi({ readOnly: true }),
    createdAt: resourceRecordSchema.shape.createdAt.openapi({ readOnly: true }),
    updatedAt: resourceRecordSchema.shape.updatedAt.openapi({ readOnly: true }),
  })
  .strict()
  .openapi('Resource');

const resourceListResponseSchema = z
  .object({
    items: z.array(resourceResponseSchema),
    nextCursor: keySchema.nullable(),
  })
  .strict()
  .openapi('PaginatedResources');

const resourceDetailResponseSchema = z
  .object({
    resource: resourceResponseSchema,
    binding: nullableSchema(providerBindingResponseSchema),
    health: nullableSchema(healthResponseSchema),
    relationships: z.array(resourceRelationshipResponseSchema),
    drifts: z.array(driftResponseSchema),
    relationshipsNextCursor: identifierSchema.nullable(),
    driftsNextCursor: identifierSchema.nullable(),
  })
  .strict()
  .openapi('ResourceDetail');

const resourceKeyParamsSchema = z
  .object({
    key: keySchema.openapi({
      param: { name: 'key', in: 'path', required: true },
      example: 'web-01',
    }),
  })
  .openapi('ResourceKeyPathParameters');

const resourceListQuerySchema = z
  .object({
    kind: resourceKindSchema
      .optional()
      .openapi({ param: { name: 'kind', in: 'query' }, example: 'compute' }),
    lifecycleState: resourceLifecycleStateSchema
      .optional()
      .openapi({ param: { name: 'lifecycleState', in: 'query' }, example: 'ready' }),
    limit: pageLimitSchema.optional(),
    cursor: keySchema
      .optional()
      .openapi({ param: { name: 'cursor', in: 'query' }, example: 'web-01' }),
  })
  .strict()
  .openapi('ListResourcesQuery');

const resourceDetailQuerySchema = z
  .object({
    relationshipLimit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_RESOURCE_DETAIL_PAGE_SIZE)
      .default(50)
      .openapi({
        param: { name: 'relationshipLimit', in: 'query' },
        example: 50,
      }),
    relationshipCursor: identifierSchema
      .optional()
      .openapi({ param: { name: 'relationshipCursor', in: 'query' }, example: 'rel-01' }),
    driftLimit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_RESOURCE_DETAIL_PAGE_SIZE)
      .default(50)
      .openapi({
        param: { name: 'driftLimit', in: 'query' },
        example: 50,
      }),
    driftCursor: identifierSchema
      .optional()
      .openapi({ param: { name: 'driftCursor', in: 'query' }, example: 'drift-01' }),
  })
  .strict()
  .openapi('ResourceDetailQuery');

const resourceExample = {
  id: 'resource-6fd894bf',
  key: 'web-01',
  kind: 'compute',
  name: 'Web 01',
  profile: null,
  policy: null,
  placement: { locationKey: 'site-01' },
  specOverrides: {
    substrate: 'vm',
    architecture: 'amd64',
    vcpu: 2,
    memoryMiB: 4096,
  },
  spec: {
    substrate: 'vm',
    architecture: 'amd64',
    vcpu: 2,
    memoryMiB: 4096,
  },
  lifecycleState: 'absent',
  revision: 1,
  createdAt: '2026-07-28T01:00:00.000Z',
  updatedAt: '2026-07-28T01:00:00.000Z',
} as const;

export const createResourceRoute = createRoute({
  method: 'post',
  path: '/api/v1/resources',
  operationId: 'createResource',
  tags: ['Resources'],
  summary: 'Create a resource',
  description:
    'Creates a resource after strict kind-specific specification, profile, policy, and placement validation. Requires the admin role.',
  ...protectedRouteMetadata('admin'),
  request: {
    body: jsonRequest(
      createResourceRequestSchema,
      'The immutable resource key, kind, placement, and specification overrides.',
      {
        key: 'web-01',
        kind: 'compute',
        name: 'Web 01',
        placement: { locationKey: 'site-01' },
        specOverrides: resourceExample.specOverrides,
      },
    ),
  },
  responses: {
    201: jsonResponse(resourceResponseSchema, 'The newly created resource.', resourceExample),
    ...standardErrorResponses(),
  },
});

export const listResourcesRoute = createRoute({
  method: 'get',
  path: '/api/v1/resources',
  operationId: 'listResources',
  tags: ['Resources'],
  summary: 'List resources',
  description:
    'Lists resources using stable keyset pagination. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: { query: resourceListQuerySchema },
  responses: {
    200: jsonResponse(resourceListResponseSchema, 'A page of resources and the next cursor.', {
      items: [resourceExample],
      nextCursor: null,
    }),
    ...standardErrorResponses(),
  },
});

export const getResourceRoute = createRoute({
  method: 'get',
  path: '/api/v1/resources/{key}',
  operationId: 'getResource',
  tags: ['Resources'],
  summary: 'Get resource details',
  description:
    'Returns a resource together with its binding, health, relationships, and drift records. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: { params: resourceKeyParamsSchema, query: resourceDetailQuerySchema },
  responses: {
    200: jsonResponse(resourceDetailResponseSchema, 'The requested resource detail.', {
      resource: resourceExample,
      binding: null,
      health: null,
      relationships: [],
      drifts: [],
      relationshipsNextCursor: null,
      driftsNextCursor: null,
    }),
    ...standardErrorResponses(),
  },
});

export const updateResourceRoute = createRoute({
  method: 'patch',
  path: '/api/v1/resources/{key}',
  operationId: 'updateResource',
  tags: ['Resources'],
  summary: 'Update a resource',
  description:
    'Updates mutable resource fields with optimistic locking. Profile and policy references are immutable after resource creation; create a new operation when rematerialization is required. Requires the admin role.',
  ...protectedRouteMetadata('admin'),
  request: {
    params: resourceKeyParamsSchema,
    body: jsonRequest(
      updateResourceRequestSchema,
      'Mutable resource fields and the expected current revision.',
      { name: 'Web Frontend 01', expectedRevision: 1 },
    ),
  },
  responses: {
    200: jsonResponse(resourceResponseSchema, 'The updated resource.', {
      ...resourceExample,
      name: 'Web Frontend 01',
      revision: 2,
    }),
    ...standardErrorResponses(),
  },
});

export const transitionResourceRoute = createRoute({
  method: 'post',
  path: '/api/v1/resources/{key}/transitions',
  operationId: 'transitionResource',
  tags: ['Resources', 'Operations'],
  summary: 'Transition a resource lifecycle state',
  description:
    'Applies a planned lifecycle transition under a valid operation lock and fencing token. Non-destructive transitions allow provisioner or operator; transitions to retired require operator.',
  ...operationRouteMetadata(),
  request: {
    params: resourceKeyParamsSchema,
    body: jsonRequest(
      transitionResourceRequestSchema,
      'The target state, expected resource revision, operation, and fencing token.',
      {
        targetState: 'allocated',
        expectedRevision: 1,
        operationId: 'operation-b75ecf35',
        fencingToken: 1,
      },
    ),
  },
  responses: {
    200: jsonResponse(resourceResponseSchema, 'The resource after the lifecycle transition.', {
      ...resourceExample,
      lifecycleState: 'allocated',
      revision: 2,
    }),
    ...standardErrorResponses(),
  },
});

export const listResourceEventsRoute = createRoute({
  method: 'get',
  path: '/api/v1/resources/{key}/events',
  operationId: 'listResourceEvents',
  tags: ['Resources', 'Audit'],
  summary: 'List resource audit events',
  description:
    'Lists audit events associated with one resource. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: {
    params: resourceKeyParamsSchema,
    query: z
      .object({ limit: auditPageLimitSchema.optional() })
      .strict()
      .openapi('ListResourceEventsQuery'),
  },
  responses: {
    200: jsonResponse(auditEventListResponseSchema, 'Audit events for the requested resource.', {
      items: [
        {
          eventId: 'evt-c84eb8a1',
          eventType: 'resource.created',
          resourceKey: 'web-01',
          operationId: null,
          actorId: 'actor-a28ca7c4',
          payload: { key: 'web-01' },
          occurredAt: '2026-07-28T01:00:00.000Z',
        },
      ],
    }),
    ...standardErrorResponses(),
  },
});

export function toResourceResponse(resource: Resource) {
  return parseResponse(resourceResponseSchema, {
    ...resource,
    profile: resource.profile ?? null,
    policy: resource.policy ?? null,
  });
}

export function toResourceListResponse(items: Resource[], nextCursor: string | null) {
  return parseResponse(resourceListResponseSchema, {
    items: items.map(toResourceResponse),
    nextCursor,
  });
}

interface ResourceDetailValue {
  resource: Resource;
  binding: ProviderBinding | null;
  health: Health | null;
  relationships: ResourceRelationship[];
  drifts: Drift[];
  relationshipsNextCursor?: string;
  driftsNextCursor?: string;
}

export function toResourceDetailResponse(detail: ResourceDetailValue) {
  return parseResponse(resourceDetailResponseSchema, {
    resource: toResourceResponse(detail.resource),
    binding: detail.binding === null ? null : toProviderBindingResponse(detail.binding),
    health: detail.health === null ? null : toHealthResponse(detail.health),
    relationships: detail.relationships.map(toResourceRelationshipResponse),
    drifts: detail.drifts.map(toDriftResponse),
    relationshipsNextCursor: detail.relationshipsNextCursor ?? null,
    driftsNextCursor: detail.driftsNextCursor ?? null,
  });
}
