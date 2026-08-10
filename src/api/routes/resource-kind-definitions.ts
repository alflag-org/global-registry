import type { OpenAPIHono } from '@hono/zod-openapi';
import { ResourceKindDefinitionService } from '../../application/resource-kind-definitions';
import { NotFoundError } from '../../domain/errors/global-registry-error';
import {
  createResourceKindDefinitionVersionRoute,
  getResourceKindDefinitionVersionRoute,
  listResourceKindDefinitionsRoute,
  toResourceKindDefinitionListResponse,
  toResourceKindDefinitionSummaryResponse,
  toResourceKindDefinitionVersionResponse,
  updateResourceKindDefinitionStatusRoute,
} from '../contracts/resource-kind-definitions';
import type { ApiEnvironment } from '../environment';
import { actor, repository } from '../environment';

export function registerResourceKindDefinitionRoutes(app: OpenAPIHono<ApiEnvironment>): void {
  app.openapi(createResourceKindDefinitionVersionRoute, async (c) => {
    const body = c.req.valid('json');
    const definition = await new ResourceKindDefinitionService(repository(c)).createVersion({
      key: body.key,
      states: body.states,
      initialState: body.initialState,
      terminalStates: body.terminalStates,
      transitions: body.transitions,
      placementMode: body.placementMode,
      relationshipRules: body.relationshipRules,
      actorId: actor(c).id,
      ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }),
    });
    return c.json(toResourceKindDefinitionVersionResponse(definition), 201);
  });

  app.openapi(listResourceKindDefinitionsRoute, async (c) => {
    const { limit } = c.req.valid('query');
    return c.json(
      toResourceKindDefinitionListResponse(await repository(c).listResourceKindDefinitions(limit)),
      200,
    );
  });

  app.openapi(getResourceKindDefinitionVersionRoute, async (c) => {
    const { key, version } = c.req.valid('param');
    const definition = await repository(c).getResourceKindDefinition(key, version);
    if (definition === null) {
      throw new NotFoundError('Resource kind definition', `${key}@${version}`);
    }
    return c.json(toResourceKindDefinitionVersionResponse(definition), 200);
  });

  app.openapi(updateResourceKindDefinitionStatusRoute, async (c) => {
    const { key } = c.req.valid('param');
    const body = c.req.valid('json');
    const definition = await new ResourceKindDefinitionService(repository(c)).updateStatus({
      key,
      status: body.status,
      expectedRevision: body.expectedRevision,
      actorId: actor(c).id,
    });
    return c.json(toResourceKindDefinitionSummaryResponse(definition), 200);
  });
}
