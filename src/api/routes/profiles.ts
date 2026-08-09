import type { OpenAPIHono } from '@hono/zod-openapi';
import { ProfileService } from '../../application/profiles';
import { NotFoundError } from '../../domain/errors/global-registry-error';
import { ensureJsonObject } from '../../domain/models/json';
import {
  createProfileVersionRoute,
  getProfileVersionRoute,
  listProfilesRoute,
  toProfileListResponse,
  toProfileSummaryResponse,
  toProfileVersionResponse,
  updateProfileStatusRoute,
} from '../contracts/profiles';
import type { ApiEnvironment } from '../environment';
import { actor, repository } from '../environment';

export function registerProfileRoutes(app: OpenAPIHono<ApiEnvironment>): void {
  app.openapi(createProfileVersionRoute, async (c) => {
    const body = c.req.valid('json');
    const profile = await new ProfileService(repository(c)).createVersion({
      key: body.key,
      resourceKind: body.resourceKind,
      resourceKindVersion: body.resourceKindVersion,
      spec: ensureJsonObject(body.spec, 'spec'),
      actorId: actor(c).id,
      ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }),
    });
    return c.json(toProfileVersionResponse(profile), 201);
  });

  app.openapi(listProfilesRoute, async (c) => {
    const { limit } = c.req.valid('query');
    return c.json(toProfileListResponse(await repository(c).listProfiles(limit)), 200);
  });

  app.openapi(updateProfileStatusRoute, async (c) => {
    const { key } = c.req.valid('param');
    const body = c.req.valid('json');
    const profile = await new ProfileService(repository(c)).updateStatus({
      key,
      status: body.status,
      expectedRevision: body.expectedRevision,
      actorId: actor(c).id,
    });
    return c.json(toProfileSummaryResponse(profile), 200);
  });

  app.openapi(getProfileVersionRoute, async (c) => {
    const { key, version } = c.req.valid('param');
    const profile = await repository(c).getProfileVersion(key, version);
    if (profile === null) {
      throw new NotFoundError('Profile version', `${key}@${version}`);
    }
    return c.json(toProfileVersionResponse(profile), 200);
  });
}
