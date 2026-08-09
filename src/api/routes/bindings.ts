import type { OpenAPIHono } from '@hono/zod-openapi';
import { BindingService } from '../../application/bindings';
import { ensureJsonObject } from '../../domain/models/json';
import {
  removeBindingRoute,
  replaceBindingRoute,
  toProviderBindingResponse,
} from '../contracts/bindings';
import type { ApiEnvironment } from '../environment';
import { actor, repository } from '../environment';

export function registerBindingRoutes(app: OpenAPIHono<ApiEnvironment>): void {
  app.openapi(replaceBindingRoute, async (c) => {
    const { key: resourceKey } = c.req.valid('param');
    const body = c.req.valid('json');
    const binding = await new BindingService(repository(c)).replace({
      resourceKey,
      providerId: body.providerId,
      providerResourceType: body.providerResourceType,
      providerResourceId: body.providerResourceId,
      ...(body.providerResourceName === undefined
        ? {}
        : { providerResourceName: body.providerResourceName }),
      locator: ensureJsonObject(body.locator, 'locator'),
      expectedRevision: body.expectedRevision,
      operationId: body.operationId,
      fencingToken: body.fencingToken,
      actorId: actor(c).id,
    });
    return c.json(toProviderBindingResponse(binding), 200);
  });

  app.openapi(removeBindingRoute, async (c) => {
    const { key: resourceKey } = c.req.valid('param');
    const body = c.req.valid('json');
    await new BindingService(repository(c)).remove({
      ...body,
      resourceKey,
      actorId: actor(c).id,
    });
    return c.body(null, 204);
  });
}
