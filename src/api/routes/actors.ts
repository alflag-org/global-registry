import type { OpenAPIHono } from '@hono/zod-openapi';
import { ActorService } from '../../application/actors';
import { NotFoundError } from '../../domain/errors/global-registry-error';
import {
  createActorRoute,
  getActorRoute,
  listActorsRoute,
  toActorListResponse,
  toActorResponse,
  updateActorRoute,
} from '../contracts/actors';
import type { ApiEnvironment } from '../environment';
import { actor, repository } from '../environment';

export function registerActorRoutes(app: OpenAPIHono<ApiEnvironment>): void {
  app.openapi(listActorsRoute, async (c) => {
    const { limit } = c.req.valid('query');
    return c.json(toActorListResponse(await repository(c).listActors(limit)), 200);
  });

  app.openapi(getActorRoute, async (c) => {
    const { id } = c.req.valid('param');
    const found = await repository(c).getActor(id);
    if (found === null) throw new NotFoundError('Actor', id);
    return c.json(toActorResponse(found), 200);
  });

  app.openapi(createActorRoute, async (c) => {
    const body = c.req.valid('json');
    const created = await new ActorService(repository(c)).create({
      ...body,
      actorId: actor(c).id,
    });
    return c.json(toActorResponse(created), 201);
  });

  app.openapi(updateActorRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const updated = await new ActorService(repository(c)).update({
      id,
      expectedRevision: body.expectedRevision,
      actorId: actor(c).id,
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      ...(body.role === undefined ? {} : { role: body.role }),
      ...(body.active === undefined ? {} : { active: body.active }),
    });
    return c.json(toActorResponse(updated), 200);
  });
}
