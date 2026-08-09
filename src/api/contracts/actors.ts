import { createRoute, z } from '@hono/zod-openapi';
import type { Actor } from '../../domain/models/global-registry';
import { PRINCIPAL_TYPES, principalTypeFromIdentity } from '../../domain/actor/identity';
import { actorCreateInputSchema, actorUpdateInputSchema } from '../../domain/actor/schemas';
import { actorRecordSchema } from '../../domain/models/schemas';
import {
  identifierSchema,
  jsonRequest,
  jsonResponse,
  pageLimitSchema,
  parseResponse,
  protectedRouteMetadata,
} from './common';
import { standardErrorResponses } from './errors';

export const principalTypeSchema = z.enum(PRINCIPAL_TYPES).openapi('PrincipalType');

const actorResponseRecordSchema = actorRecordSchema
  .pick({
    id: true,
    identity: true,
  })
  .extend({
    principalType: principalTypeSchema.openapi({ readOnly: true }),
  })
  .extend(
    actorRecordSchema.omit({
      id: true,
      identity: true,
    }).shape,
  );

const actorResponseSchema = actorResponseRecordSchema
  .extend({
    id: actorRecordSchema.shape.id.openapi({ readOnly: true }),
    identity: actorRecordSchema.shape.identity.openapi({ readOnly: true }),
    revision: actorRecordSchema.shape.revision.openapi({ readOnly: true }),
    createdAt: actorRecordSchema.shape.createdAt.openapi({ readOnly: true }),
    updatedAt: actorRecordSchema.shape.updatedAt.openapi({ readOnly: true }),
  })
  .strict()
  .openapi('Actor');

const actorListResponseSchema = z
  .object({
    items: z.array(actorResponseSchema),
  })
  .strict()
  .openapi('ActorList');

const createActorRequestSchema = actorCreateInputSchema.openapi('CreateActorRequest');

const updateActorRequestSchema = actorUpdateInputSchema.openapi('UpdateActorRequest');

const actorIdParamsSchema = z
  .object({
    id: identifierSchema.openapi({
      param: { name: 'id', in: 'path', required: true },
      example: 'actor-a28ca7c4',
    }),
  })
  .openapi('ActorIdPathParameters');

const listActorsQuerySchema = z
  .object({ limit: pageLimitSchema.optional() })
  .strict()
  .openapi('ListActorsQuery');

const actorExample = {
  id: 'actor-a28ca7c4',
  identity: 'access:08c81811-8b6d-46ad-a28b-886387378f32',
  principalType: 'human',
  displayName: 'Registry Administrator',
  role: 'admin',
  active: true,
  revision: 1,
  createdAt: '2026-07-28T01:00:00.000Z',
  updatedAt: '2026-07-28T01:00:00.000Z',
} as const;

export const listActorsRoute = createRoute({
  method: 'get',
  path: '/api/v1/actors',
  operationId: 'listActors',
  tags: ['Actors'],
  summary: 'List registry actors',
  description:
    'Lists human and service actors mapped to Cloudflare Access identities. Requires the admin role.',
  ...protectedRouteMetadata('admin'),
  request: { query: listActorsQuerySchema },
  responses: {
    200: jsonResponse(actorListResponseSchema, 'Registry actors ordered by display name.', {
      items: [actorExample],
    }),
    ...standardErrorResponses(),
  },
});

export const getActorRoute = createRoute({
  method: 'get',
  path: '/api/v1/actors/{id}',
  operationId: 'getActor',
  tags: ['Actors'],
  summary: 'Get a registry actor',
  description:
    'Returns one human or service actor by immutable actor identifier. Requires the admin role.',
  ...protectedRouteMetadata('admin'),
  request: { params: actorIdParamsSchema },
  responses: {
    200: jsonResponse(actorResponseSchema, 'The requested registry actor.', actorExample),
    ...standardErrorResponses(),
  },
});

export const createActorRoute = createRoute({
  method: 'post',
  path: '/api/v1/actors',
  operationId: 'createActor',
  tags: ['Actors'],
  summary: 'Create a registry actor',
  description:
    'Creates an immutable canonical Access identity mapping. Requires the admin role. The identity cannot be changed later.',
  ...protectedRouteMetadata('admin'),
  request: {
    body: jsonRequest(
      createActorRequestSchema,
      'The canonical identity, display name, and initial role.',
      {
        identity: actorExample.identity,
        displayName: actorExample.displayName,
        role: actorExample.role,
      },
    ),
  },
  responses: {
    201: jsonResponse(actorResponseSchema, 'The newly created registry actor.', actorExample),
    ...standardErrorResponses(),
  },
});

export const updateActorRoute = createRoute({
  method: 'patch',
  path: '/api/v1/actors/{id}',
  operationId: 'updateActor',
  tags: ['Actors'],
  summary: 'Update a registry actor',
  description:
    'Updates mutable actor fields with optimistic locking. Requires the admin role. The mutation cannot remove the final active admin or cause an unsafe self-lockout.',
  ...protectedRouteMetadata('admin'),
  request: {
    params: actorIdParamsSchema,
    body: jsonRequest(
      updateActorRequestSchema,
      'Mutable fields and the expected current revision.',
      {
        displayName: 'Registry Platform Administrator',
        expectedRevision: 1,
      },
    ),
  },
  responses: {
    200: jsonResponse(actorResponseSchema, 'The updated registry actor.', {
      ...actorExample,
      displayName: 'Registry Platform Administrator',
      revision: 2,
    }),
    ...standardErrorResponses(),
  },
});

export function toActorResponse(actor: Actor) {
  return parseResponse(actorResponseSchema, {
    ...actor,
    principalType: principalTypeFromIdentity(actor.identity),
  });
}

export function toActorListResponse(actors: Actor[]) {
  return parseResponse(actorListResponseSchema, { items: actors.map(toActorResponse) });
}
