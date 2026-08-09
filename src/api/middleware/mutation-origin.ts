import type { MiddlewareHandler } from 'hono';
import { AuthorizationError } from '../../domain/errors/global-registry-error';
import type { ApiEnvironment } from '../environment';

const MUTATING_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

export const mutationOrigin: MiddlewareHandler<ApiEnvironment> = async (c, next) => {
  if (!MUTATING_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  if (c.req.header('sec-fetch-site')?.toLowerCase() === 'cross-site') {
    throw new AuthorizationError(
      'cross_site_mutation',
      'Cross-site browser mutation requests are not permitted.',
    );
  }

  const origin = c.req.header('origin');
  if (origin !== undefined && origin !== new URL(c.req.url).origin) {
    throw new AuthorizationError(
      'cross_site_mutation',
      'Browser mutation requests must use the Global Registry origin.',
    );
  }

  await next();
};
