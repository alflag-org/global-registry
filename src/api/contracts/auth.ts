import { createRoute, z } from '@hono/zod-openapi';
import type { AccessPrincipal } from '../../adapters/access/access';
import { canonicalActorIdentitySchema } from '../../domain/actor/identity';
import type { Actor } from '../../domain/models/global-registry';
import { actorRecordSchema } from '../../domain/models/schemas';
import {
  accessPrincipalRouteMetadata,
  jsonResponse,
  nullableSchema,
  parseResponse,
} from './common';
import { principalTypeSchema } from './actors';
import { standardErrorResponses } from './errors';

const sessionActorSchema = actorRecordSchema
  .pick({
    id: true,
    displayName: true,
    role: true,
    active: true,
    revision: true,
  })
  .extend({
    id: actorRecordSchema.shape.id.openapi({ readOnly: true }),
    revision: actorRecordSchema.shape.revision.openapi({ readOnly: true }),
  })
  .strict()
  .openapi('SessionActor');

const sessionResponseSchema = z
  .object({
    identity: canonicalActorIdentitySchema.openapi({ readOnly: true }),
    principalType: principalTypeSchema.openapi({ readOnly: true }),
    mapped: z.boolean().openapi({ readOnly: true }),
    actor: nullableSchema(sessionActorSchema).openapi({ readOnly: true }),
  })
  .strict()
  .openapi('AuthSession');

export const getSessionRoute = createRoute({
  method: 'get',
  path: '/api/v1/auth/session',
  operationId: 'getSession',
  tags: ['Authentication'],
  summary: 'Get the current Access session',
  description:
    'Returns the verified Cloudflare Access principal and its optional active Registry actor mapping. This operation requires a valid Access principal but does not require an existing actor mapping.',
  ...accessPrincipalRouteMetadata(),
  responses: {
    200: jsonResponse(sessionResponseSchema, 'The current principal and optional actor mapping.', {
      identity: 'access:08c81811-8b6d-46ad-a28b-886387378f32',
      principalType: 'human',
      mapped: true,
      actor: {
        id: 'actor-a28ca7c4',
        displayName: 'Registry Administrator',
        role: 'admin',
        active: true,
        revision: 1,
      },
    }),
    ...standardErrorResponses(),
  },
});

export function toSessionResponse(principal: AccessPrincipal, actor: Actor | null) {
  return parseResponse(sessionResponseSchema, {
    identity: principal.identity,
    principalType: principal.type,
    mapped: actor !== null,
    actor:
      actor === null
        ? null
        : {
            id: actor.id,
            displayName: actor.displayName,
            role: actor.role,
            active: actor.active,
            revision: actor.revision,
          },
  });
}
