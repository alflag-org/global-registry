import type { MiddlewareHandler } from 'hono';
import { AuthorizationError } from '../../domain/errors/global-registry-error';
import type { ActorRole } from '../../domain/models/global-registry';
import { requireActorRole } from '../actor-authorization';
import type { ApiEnvironment } from '../environment';
import { mappedActor } from '../environment';

export function authorization(...roles: ActorRole[]): MiddlewareHandler<ApiEnvironment> {
  return async (c, next) => {
    const actor = mappedActor(c);
    if (actor === null) {
      throw new AuthorizationError(
        'actor_not_registered',
        'Cloudflare Access identity is not mapped to a Global Registry actor.',
      );
    }
    if (roles.length > 0) requireActorRole(actor, ...roles);
    await next();
  };
}
