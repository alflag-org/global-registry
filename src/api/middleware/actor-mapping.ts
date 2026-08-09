import type { MiddlewareHandler } from 'hono';
import { AuthorizationError } from '../../domain/errors/global-registry-error';
import type { ApiEnvironment } from '../environment';
import { accessPrincipal, repository } from '../environment';

export const actorMapping: MiddlewareHandler<ApiEnvironment> = async (c, next) => {
  const actor = await repository(c).getActorByIdentity(accessPrincipal(c).identity);
  if (actor !== null && !actor.active) {
    throw new AuthorizationError('actor_inactive', 'The mapped Global Registry actor is inactive.');
  }
  c.set('actor', actor);
  await next();
};
