import { createRoute, z } from '@hono/zod-openapi';
import type { ResourceKindDefinitionVersion } from '../../domain/models/global-registry';
import { resourceKindDefinitionVersionRecordSchema } from '../../domain/models/schemas';
import {
  resourceKindDefinitionInputSchema,
  resourceKindSchema,
} from '../../domain/resource-kind/schemas';
import type { ResourceKindDefinitionSummary } from '../../application/resource-kind-definitions';
import {
  jsonRequest,
  jsonResponse,
  pageLimitSchema,
  parseResponse,
  protectedRouteMetadata,
  revisionSchema,
  versionParentStatusSchema,
} from './common';
import { standardErrorResponses } from './errors';

const createResourceKindDefinitionRequestSchema = resourceKindDefinitionInputSchema
  .extend({ expectedRevision: revisionSchema.optional() })
  .strict()
  .openapi('CreateResourceKindDefinitionVersionRequest');

const updateResourceKindDefinitionStatusRequestSchema = z
  .object({ status: versionParentStatusSchema, expectedRevision: revisionSchema })
  .strict()
  .openapi('UpdateResourceKindDefinitionStatusRequest');

const definitionVersionResponseSchema = resourceKindDefinitionVersionRecordSchema.openapi(
  'ResourceKindDefinitionVersion',
);

const definitionSummaryResponseSchema = z
  .object({
    key: resourceKindSchema,
    version: revisionSchema,
    status: versionParentStatusSchema,
    revision: revisionSchema,
  })
  .strict()
  .openapi('ResourceKindDefinitionSummary');

const definitionListResponseSchema = z
  .object({ items: z.array(definitionSummaryResponseSchema) })
  .strict()
  .openapi('ResourceKindDefinitionList');

const listQuerySchema = z
  .object({ limit: pageLimitSchema.optional() })
  .strict()
  .openapi('ListResourceKindDefinitionsQuery');

const keyParamsSchema = z
  .object({
    key: resourceKindSchema.openapi({
      param: { name: 'key', in: 'path', required: true },
      example: 'example.internal-appliance',
    }),
  })
  .openapi('ResourceKindDefinitionKeyPathParameters');

const versionParamsSchema = keyParamsSchema
  .extend({
    version: z.coerce
      .number()
      .int()
      .positive()
      .openapi({
        param: { name: 'version', in: 'path', required: true },
        example: 1,
      }),
  })
  .openapi('ResourceKindDefinitionVersionPathParameters');

const definitionExample = {
  key: 'example.internal-appliance',
  version: 1,
  states: ['absent', 'ready', 'retired'],
  initialState: 'absent',
  terminalStates: ['retired'],
  transitions: [
    { from: 'absent', to: 'ready', destructive: false },
    { from: 'ready', to: 'retired', destructive: true },
  ],
  placementMode: 'located',
  specificationMode: 'opaque',
  relationshipRules: [
    { relationshipType: 'depends_on', targetKinds: ['example.internal-appliance'] },
  ],
  parentStatus: 'active',
  revision: 1,
  createdAt: '2026-08-10T01:00:00.000Z',
  createdBy: 'actor-admin',
} as const;

export const createResourceKindDefinitionVersionRoute = createRoute({
  method: 'post',
  path: '/api/v1/resource-kind-definitions',
  operationId: 'createResourceKindDefinitionVersion',
  tags: ['Resource kind definitions'],
  summary: 'Create a Resource kind definition version',
  description:
    'Creates an extensible Resource kind or appends an immutable lifecycle definition version using optimistic locking. Requires the admin role.',
  ...protectedRouteMetadata('admin'),
  request: {
    body: jsonRequest(
      createResourceKindDefinitionRequestSchema,
      'The stable kind key, lifecycle graph, placement behavior, relationship rules, and optional expected revision.',
      {
        key: definitionExample.key,
        states: definitionExample.states,
        initialState: definitionExample.initialState,
        terminalStates: definitionExample.terminalStates,
        transitions: definitionExample.transitions,
        placementMode: definitionExample.placementMode,
        relationshipRules: definitionExample.relationshipRules,
      },
    ),
  },
  responses: {
    201: jsonResponse(
      definitionVersionResponseSchema,
      'The newly created immutable definition version.',
      definitionExample,
    ),
    ...standardErrorResponses(),
  },
});

export const listResourceKindDefinitionsRoute = createRoute({
  method: 'get',
  path: '/api/v1/resource-kind-definitions',
  operationId: 'listResourceKindDefinitions',
  tags: ['Resource kind definitions'],
  summary: 'List Resource kind definitions',
  description: 'Lists current definition versions and statuses.',
  ...protectedRouteMetadata(),
  request: { query: listQuerySchema },
  responses: {
    200: jsonResponse(definitionListResponseSchema, 'Resource kind definition summaries.', {
      items: [
        {
          key: definitionExample.key,
          version: 1,
          status: 'active',
          revision: 1,
        },
      ],
    }),
    ...standardErrorResponses(),
  },
});

export const getResourceKindDefinitionVersionRoute = createRoute({
  method: 'get',
  path: '/api/v1/resource-kind-definitions/{key}/versions/{version}',
  operationId: 'getResourceKindDefinitionVersion',
  tags: ['Resource kind definitions'],
  summary: 'Get a Resource kind definition version',
  description: 'Returns one immutable Resource kind definition version.',
  ...protectedRouteMetadata(),
  request: { params: versionParamsSchema },
  responses: {
    200: jsonResponse(
      definitionVersionResponseSchema,
      'The requested definition.',
      definitionExample,
    ),
    ...standardErrorResponses(),
  },
});

export const updateResourceKindDefinitionStatusRoute = createRoute({
  method: 'patch',
  path: '/api/v1/resource-kind-definitions/{key}',
  operationId: 'updateResourceKindDefinitionStatus',
  tags: ['Resource kind definitions'],
  summary: 'Update Resource kind definition status',
  description:
    'Changes definition status with optimistic locking. Retired definitions cannot be reactivated. Requires the admin role.',
  ...protectedRouteMetadata('admin'),
  request: {
    params: keyParamsSchema,
    body: jsonRequest(
      updateResourceKindDefinitionStatusRequestSchema,
      'The target status and expected current revision.',
      { status: 'deprecated', expectedRevision: 1 },
    ),
  },
  responses: {
    200: jsonResponse(definitionSummaryResponseSchema, 'The updated definition summary.', {
      key: definitionExample.key,
      version: 1,
      status: 'deprecated',
      revision: 2,
    }),
    ...standardErrorResponses(),
  },
});

export function toResourceKindDefinitionVersionResponse(definition: ResourceKindDefinitionVersion) {
  return parseResponse(definitionVersionResponseSchema, definition);
}

export function toResourceKindDefinitionSummaryResponse(definition: ResourceKindDefinitionSummary) {
  return parseResponse(definitionSummaryResponseSchema, definition);
}

export function toResourceKindDefinitionListResponse(definitions: ResourceKindDefinitionSummary[]) {
  return parseResponse(definitionListResponseSchema, {
    items: definitions.map(toResourceKindDefinitionSummaryResponse),
  });
}
