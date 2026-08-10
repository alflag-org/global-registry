import type { OpenAPIHono } from '@hono/zod-openapi';
import { OperationService } from '../../application/operations';
import { ResourceService } from '../../application/resources';
import { NotFoundError } from '../../domain/errors/global-registry-error';
import { isDestructiveLifecycleTransition } from '../../domain/lifecycle/lifecycle';
import { ensureJsonObject } from '../../domain/models/json';
import { requireOperationRole } from '../actor-authorization';
import {
  createResourceRoute,
  getResourceRoute,
  listResourceEventsRoute,
  listResourcesRoute,
  toResourceDetailResponse,
  toResourceListResponse,
  toResourceResponse,
  transitionResourceRoute,
  updateResourceRoute,
} from '../contracts/resources';
import { toAuditEventListResponse } from '../contracts/observations';
import type { ApiEnvironment } from '../environment';
import { actor, repository } from '../environment';

export function registerResourceRoutes(app: OpenAPIHono<ApiEnvironment>): void {
  app.openapi(createResourceRoute, async (c) => {
    const body = c.req.valid('json');
    const created = await new ResourceService(repository(c)).create({
      actorId: actor(c).id,
      key: body.key,
      kind: body.kind,
      kindVersion: body.kindVersion,
      name: body.name,
      placement: ensureJsonObject(body.placement, 'placement'),
      specOverrides: ensureJsonObject(body.specOverrides, 'specOverrides'),
      ...(body.profile === undefined ? {} : { profile: body.profile }),
      ...(body.policy === undefined ? {} : { policy: body.policy }),
    });
    return c.json(toResourceResponse(created), 201);
  });

  app.openapi(listResourcesRoute, async (c) => {
    const query = c.req.valid('query');
    const limit = query.limit ?? 50;
    const items = await repository(c).listResources({
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.lifecycleState === undefined ? {} : { lifecycleState: query.lifecycleState }),
      limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    const nextCursor = items.length === limit ? (items.at(-1)?.key ?? null) : null;
    return c.json(toResourceListResponse(items, nextCursor), 200);
  });

  app.openapi(getResourceRoute, async (c) => {
    const { key } = c.req.valid('param');
    const query = c.req.valid('query');
    const detail = await repository(c).getResourceDetail(key, {
      relationshipLimit: query.relationshipLimit,
      driftLimit: query.driftLimit,
      ...(query.relationshipCursor === undefined
        ? {}
        : { relationshipCursor: query.relationshipCursor }),
      ...(query.driftCursor === undefined ? {} : { driftCursor: query.driftCursor }),
    });
    if (detail === null) throw new NotFoundError('Resource', key);
    return c.json(toResourceDetailResponse(detail), 200);
  });

  app.openapi(updateResourceRoute, async (c) => {
    const { key } = c.req.valid('param');
    const body = c.req.valid('json');
    const updated = await new ResourceService(repository(c)).update({
      actorId: actor(c).id,
      key,
      expectedRevision: body.expectedRevision,
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.placement === undefined
        ? {}
        : { placement: ensureJsonObject(body.placement, 'placement') }),
      ...(body.specOverrides === undefined
        ? {}
        : { specOverrides: ensureJsonObject(body.specOverrides, 'specOverrides') }),
    });
    return c.json(toResourceResponse(updated), 200);
  });

  app.openapi(transitionResourceRoute, async (c) => {
    const { key } = c.req.valid('param');
    const body = c.req.valid('json');
    const current = await repository(c).getResource(key);
    if (current === null) throw new NotFoundError('Resource', key);
    const definition = await repository(c).getResourceKindDefinition(
      current.kind,
      current.kindVersion,
    );
    if (definition === null) {
      throw new NotFoundError('Resource kind definition', `${current.kind}@${current.kindVersion}`);
    }
    requireOperationRole(actor(c), {
      destructive: isDestructiveLifecycleTransition(
        definition,
        current.lifecycleState,
        body.targetState,
      ),
    });
    const resource = await new OperationService(repository(c)).transition({
      key,
      targetState: body.targetState,
      expectedRevision: body.expectedRevision,
      operationId: body.operationId,
      fencingToken: body.fencingToken,
      actorId: actor(c).id,
    });
    return c.json(toResourceResponse(resource), 200);
  });

  app.openapi(listResourceEventsRoute, async (c) => {
    const { key } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    if ((await repository(c).getResource(key)) === null) {
      throw new NotFoundError('Resource', key);
    }
    return c.json(
      toAuditEventListResponse(await repository(c).listResourceEvents(key, limit)),
      200,
    );
  });
}
