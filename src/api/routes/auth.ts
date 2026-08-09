import type { OpenAPIHono } from '@hono/zod-openapi';
import { getSessionRoute, toSessionResponse } from '../contracts/auth';
import type { ApiEnvironment } from '../environment';
import { accessPrincipal, mappedActor } from '../environment';

export function registerAuthRoutes(app: OpenAPIHono<ApiEnvironment>): void {
  app.openapi(getSessionRoute, (c) =>
    c.json(toSessionResponse(accessPrincipal(c), mappedActor(c)), 200),
  );
}
