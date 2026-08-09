import { createRoute, z } from '@hono/zod-openapi';
import type { ResourceRelationship } from '../../domain/models/global-registry';
import { resourceRelationshipRecordSchema } from '../../domain/models/schemas';
import {
  identifierSchema,
  jsonRequest,
  jsonResponse,
  keySchema,
  noContentResponse,
  parseResponse,
  protectedRouteMetadata,
  relationshipTypeSchema,
  revisionSchema,
} from './common';
import { standardErrorResponses } from './errors';

export const resourceRelationshipResponseSchema = resourceRelationshipRecordSchema
  .extend({
    id: resourceRelationshipRecordSchema.shape.id.openapi({ readOnly: true }),
    sourceResourceId: resourceRelationshipRecordSchema.shape.sourceResourceId.openapi({
      readOnly: true,
    }),
    targetResourceId: resourceRelationshipRecordSchema.shape.targetResourceId.openapi({
      readOnly: true,
    }),
    revision: resourceRelationshipRecordSchema.shape.revision.openapi({ readOnly: true }),
    createdAt: resourceRelationshipRecordSchema.shape.createdAt.openapi({ readOnly: true }),
    createdBy: resourceRelationshipRecordSchema.shape.createdBy.openapi({ readOnly: true }),
  })
  .strict()
  .openapi('ResourceRelationship');

const createRelationshipRequestSchema = z
  .object({
    sourceKey: keySchema,
    targetKey: keySchema,
    relationshipType: relationshipTypeSchema,
    expectedRevision: revisionSchema,
    operationId: identifierSchema,
    fencingToken: revisionSchema,
  })
  .strict()
  .openapi('CreateRelationshipRequest');

const removeRelationshipRequestSchema = z
  .object({
    expectedRevision: revisionSchema,
    operationId: identifierSchema,
    fencingToken: revisionSchema,
  })
  .strict()
  .openapi('RemoveRelationshipRequest');

const relationshipIdParamsSchema = z
  .object({
    id: identifierSchema.openapi({
      param: { name: 'id', in: 'path', required: true },
      example: 'relationship-a9e8de71',
    }),
  })
  .openapi('RelationshipIdPathParameters');

const relationshipExample = {
  id: 'relationship-a9e8de71',
  sourceResourceId: 'resource-6fd894bf',
  targetResourceId: 'resource-1c372c6e',
  relationshipType: 'uses_network',
  revision: 1,
  createdAt: '2026-07-28T01:00:00.000Z',
  createdBy: 'actor-a28ca7c4',
} as const;

export const createRelationshipRoute = createRoute({
  method: 'post',
  path: '/api/v1/relationships',
  operationId: 'createRelationship',
  tags: ['Relationships'],
  summary: 'Create a resource relationship',
  description:
    'Creates a planned relationship after resource revision, operation, fencing, and topology validation. Requires provisioner or operator.',
  ...protectedRouteMetadata('provisioner', 'operator'),
  request: {
    body: jsonRequest(
      createRelationshipRequestSchema,
      'The source, target, relationship type, expected revision, operation, and fencing token.',
      {
        sourceKey: 'web-01',
        targetKey: 'frontend-network',
        relationshipType: 'uses_network',
        expectedRevision: 2,
        operationId: 'operation-b75ecf35',
        fencingToken: 1,
      },
    ),
  },
  responses: {
    201: jsonResponse(
      resourceRelationshipResponseSchema,
      'The newly created resource relationship.',
      relationshipExample,
    ),
    ...standardErrorResponses(),
  },
});

export const removeRelationshipRoute = createRoute({
  method: 'delete',
  path: '/api/v1/relationships/{id}',
  operationId: 'removeRelationship',
  tags: ['Relationships'],
  summary: 'Remove a resource relationship',
  description:
    'Removes a relationship under the planned destructive operation and valid fencing token. Requires operator.',
  ...protectedRouteMetadata('operator'),
  request: {
    params: relationshipIdParamsSchema,
    body: jsonRequest(
      removeRelationshipRequestSchema,
      'The expected relationship revision, destructive operation, and fencing token.',
      {
        expectedRevision: 1,
        operationId: 'operation-b75ecf35',
        fencingToken: 2,
      },
    ),
  },
  responses: {
    204: noContentResponse,
    ...standardErrorResponses(),
  },
});

export function toResourceRelationshipResponse(relationship: ResourceRelationship) {
  return parseResponse(resourceRelationshipResponseSchema, relationship);
}
