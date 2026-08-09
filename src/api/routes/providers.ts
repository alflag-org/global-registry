import type { OpenAPIHono } from '@hono/zod-openapi';
import { ProviderService } from '../../application/providers';
import { NotFoundError } from '../../domain/errors/global-registry-error';
import { ensureJsonObject } from '../../domain/models/json';
import {
  createProviderRoute,
  getProviderRoute,
  listProvidersRoute,
  toProviderListResponse,
  toProviderResponse,
  updateProviderRoute,
} from '../contracts/providers';
import type { ApiEnvironment } from '../environment';
import { actor, repository } from '../environment';

export function registerProviderRoutes(app: OpenAPIHono<ApiEnvironment>): void {
  app.openapi(createProviderRoute, async (c) => {
    const body = c.req.valid('json');
    const provider = await new ProviderService(repository(c)).create({
      id: body.id,
      driver: body.driver,
      credentialRef: body.credentialRef,
      status: body.status,
      capabilities: ensureJsonObject(body.capabilities, 'capabilities'),
      configuration: ensureJsonObject(body.configuration, 'configuration'),
      mappings: ensureJsonObject(body.mappings, 'mappings'),
      actorId: actor(c).id,
    });
    return c.json(toProviderResponse(provider), 201);
  });

  app.openapi(listProvidersRoute, async (c) => {
    const { limit } = c.req.valid('query');
    return c.json(toProviderListResponse(await repository(c).listProviders(limit)), 200);
  });

  app.openapi(getProviderRoute, async (c) => {
    const { id } = c.req.valid('param');
    const provider = await repository(c).getProvider(id);
    if (provider === null) throw new NotFoundError('Provider', id);
    return c.json(toProviderResponse(provider), 200);
  });

  app.openapi(updateProviderRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const provider = await new ProviderService(repository(c)).update({
      id,
      expectedRevision: body.expectedRevision,
      actorId: actor(c).id,
      ...(body.driver === undefined ? {} : { driver: body.driver }),
      ...(body.credentialRef === undefined ? {} : { credentialRef: body.credentialRef }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.capabilities === undefined
        ? {}
        : { capabilities: ensureJsonObject(body.capabilities, 'capabilities') }),
      ...(body.configuration === undefined
        ? {}
        : { configuration: ensureJsonObject(body.configuration, 'configuration') }),
      ...(body.mappings === undefined
        ? {}
        : { mappings: ensureJsonObject(body.mappings, 'mappings') }),
    });
    return c.json(toProviderResponse(provider), 200);
  });
}
