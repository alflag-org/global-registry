import type { OpenAPIHono } from '@hono/zod-openapi';
import { PolicyService } from '../../application/policies';
import { NotFoundError } from '../../domain/errors/global-registry-error';
import { ensureJsonObject } from '../../domain/models/json';
import {
  createPolicyVersionRoute,
  getPolicyVersionRoute,
  listPoliciesRoute,
  toPolicyListResponse,
  toPolicySummaryResponse,
  toPolicyVersionResponse,
  updatePolicyStatusRoute,
} from '../contracts/policies';
import type { ApiEnvironment } from '../environment';
import { actor, repository } from '../environment';

export function registerPolicyRoutes(app: OpenAPIHono<ApiEnvironment>): void {
  app.openapi(createPolicyVersionRoute, async (c) => {
    const body = c.req.valid('json');
    const policy = await new PolicyService(repository(c)).createVersion({
      namespace: body.namespace,
      key: body.key,
      resourceKind: body.resourceKind,
      spec: ensureJsonObject(body.spec, 'spec'),
      actorId: actor(c).id,
      ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }),
    });
    return c.json(toPolicyVersionResponse(policy), 201);
  });

  app.openapi(listPoliciesRoute, async (c) => {
    const { limit } = c.req.valid('query');
    return c.json(toPolicyListResponse(await repository(c).listPolicies(limit)), 200);
  });

  app.openapi(updatePolicyStatusRoute, async (c) => {
    const { namespace, key } = c.req.valid('param');
    const body = c.req.valid('json');
    const policy = await new PolicyService(repository(c)).updateStatus({
      namespace,
      key,
      status: body.status,
      expectedRevision: body.expectedRevision,
      actorId: actor(c).id,
    });
    return c.json(toPolicySummaryResponse(policy), 200);
  });

  app.openapi(getPolicyVersionRoute, async (c) => {
    const { namespace, key, version } = c.req.valid('param');
    const policy = await repository(c).getPolicyVersion(namespace, key, version);
    if (policy === null) {
      throw new NotFoundError('Policy version', `${namespace}/${key}@${version}`);
    }
    return c.json(toPolicyVersionResponse(policy), 200);
  });
}
