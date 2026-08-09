import type { OpenAPIHono } from '@hono/zod-openapi';
import { RelationshipService } from '../../application/relationships';
import {
  createRelationshipRoute,
  removeRelationshipRoute,
  toResourceRelationshipResponse,
} from '../contracts/relationships';
import type { ApiEnvironment } from '../environment';
import { actor, repository } from '../environment';

export function registerRelationshipRoutes(app: OpenAPIHono<ApiEnvironment>): void {
  app.openapi(createRelationshipRoute, async (c) => {
    const body = c.req.valid('json');
    const relationship = await new RelationshipService(repository(c)).create({
      ...body,
      actorId: actor(c).id,
    });
    return c.json(toResourceRelationshipResponse(relationship), 201);
  });

  app.openapi(removeRelationshipRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    await new RelationshipService(repository(c)).remove({
      id,
      ...body,
      actorId: actor(c).id,
    });
    return c.body(null, 204);
  });
}
