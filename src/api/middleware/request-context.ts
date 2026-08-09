import type { MiddlewareHandler } from 'hono';
import { D1GlobalRegistryRepository } from '../../adapters/d1/repository';
import type { ApiEnvironment } from '../environment';

export const requestContext: MiddlewareHandler<ApiEnvironment> = async (c, next) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  c.set('requestId', requestId);
  c.set('repository', new D1GlobalRegistryRepository(c.env.DB));
  await next();
  c.header('x-request-id', requestId);
  console.log(
    JSON.stringify({
      message: 'request completed',
      requestId,
      route: new URL(c.req.url).pathname,
      method: c.req.method,
      status: c.res.status,
      latencyMs: Date.now() - startedAt,
      identity: c.get('accessPrincipal')?.identity,
      actorId: c.get('actor')?.id,
    }),
  );
};
