import type { MiddlewareHandler } from 'hono';
import { authenticateAccessPrincipal } from '../../adapters/access/access';
import type { ApiEnvironment } from '../environment';

export const accessPrincipal: MiddlewareHandler<ApiEnvironment> = async (c, next) => {
  c.set('accessPrincipal', await authenticateAccessPrincipal(c.req.raw, c.env));
  await next();
};
