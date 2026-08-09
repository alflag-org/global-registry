import type { OpenAPIHono } from '@hono/zod-openapi';
import { OperationService } from '../../application/operations';
import { NotFoundError } from '../../domain/errors/global-registry-error';
import { isDestructiveLifecycleTransition } from '../../domain/lifecycle/lifecycle';
import { ensureJsonObject } from '../../domain/models/json';
import { requireOperationRole } from '../actor-authorization';
import {
  acquireOperationLocksRoute,
  cancelOperationRoute,
  completeOperationRoute,
  createOperationRoute,
  failOperationRoute,
  getOperationRoute,
  listOperationEventsRoute,
  listOperationsRoute,
  releaseOperationLocksRoute,
  renewOperationLocksRoute,
  startOperationRoute,
  toLockLeaseListResponse,
  toOperationDetailResponse,
  toOperationListResponse,
  toOperationResponse,
  toOperationStepResponse,
  updateOperationStepRoute,
} from '../contracts/operations';
import { toAuditEventListResponse } from '../contracts/observations';
import type { ApiEnvironment } from '../environment';
import { actor, operationForMutation, repository } from '../environment';

export function registerOperationRoutes(app: OpenAPIHono<ApiEnvironment>): void {
  app.openapi(createOperationRoute, async (c) => {
    const body = c.req.valid('json');
    let destructive = body.destructive;
    for (const planned of body.resources) {
      if (planned.sourceState === planned.targetState) continue;
      const resource = await repository(c).getResource(planned.resourceKey);
      if (resource === null) throw new NotFoundError('Resource', planned.resourceKey);
      const definition = await repository(c).getResourceKindDefinition(
        resource.kind,
        resource.kindVersion,
      );
      if (definition === null) {
        throw new NotFoundError(
          'Resource kind definition',
          `${resource.kind}@${resource.kindVersion}`,
        );
      }
      destructive ||= isDestructiveLifecycleTransition(
        definition,
        planned.sourceState,
        planned.targetState,
      );
    }
    requireOperationRole(actor(c), { destructive });
    const operation = await new OperationService(repository(c)).create({
      actorId: actor(c).id,
      kind: body.kind,
      intent: ensureJsonObject(body.intent, 'operation intent'),
      destructive,
      resources: body.resources.map((resource) => ({ ...resource })),
      changes: body.changes,
      steps: body.steps.map((step) => ({
        position: step.position,
        name: step.name,
        gate: ensureJsonObject(step.gate, 'operation step gate'),
        ...(step.evidence === undefined
          ? {}
          : {
              evidence: ensureJsonObject(step.evidence, 'operation step evidence'),
            }),
      })),
    });
    return c.json(toOperationResponse(operation), 201);
  });

  app.openapi(listOperationsRoute, async (c) => {
    const { limit, status } = c.req.valid('query');
    return c.json(toOperationListResponse(await repository(c).listOperations(status, limit)), 200);
  });

  app.openapi(getOperationRoute, async (c) => {
    const { id } = c.req.valid('param');
    const detail = await repository(c).getOperationDetail(id);
    if (detail === null) throw new NotFoundError('Operation', id);
    return c.json(toOperationDetailResponse(detail), 200);
  });

  app.openapi(acquireOperationLocksRoute, async (c) => {
    const { id: operationId } = c.req.valid('param');
    await operationForMutation(c, operationId);
    const body = c.req.valid('json');
    const locks = await new OperationService(repository(c)).acquireLocks({
      operationId,
      ...body,
      actorId: actor(c).id,
    });
    return c.json(toLockLeaseListResponse(locks), 201);
  });

  app.openapi(renewOperationLocksRoute, async (c) => {
    const { id: operationId } = c.req.valid('param');
    await operationForMutation(c, operationId);
    const body = c.req.valid('json');
    const locks = await new OperationService(repository(c)).renewLocks({
      operationId,
      ...body,
      actorId: actor(c).id,
    });
    return c.json(toLockLeaseListResponse(locks), 200);
  });

  app.openapi(releaseOperationLocksRoute, async (c) => {
    const { id: operationId } = c.req.valid('param');
    await operationForMutation(c, operationId);
    const body = c.req.valid('json');
    await new OperationService(repository(c)).releaseLocks({
      operationId,
      ...body,
      actorId: actor(c).id,
    });
    return c.body(null, 204);
  });

  app.openapi(startOperationRoute, async (c) => {
    const { id } = c.req.valid('param');
    await operationForMutation(c, id);
    const body = c.req.valid('json');
    const operation = await new OperationService(repository(c)).updateStatus({
      id,
      targetStatus: 'running',
      expectedRevision: body.expectedRevision,
      lockScope: body.lockScope,
      fencingToken: body.fencingToken,
      actorId: actor(c).id,
    });
    return c.json(toOperationResponse(operation), 200);
  });

  app.openapi(updateOperationStepRoute, async (c) => {
    const { id: operationId, stepId } = c.req.valid('param');
    await operationForMutation(c, operationId);
    const body = c.req.valid('json');
    const step = await new OperationService(repository(c)).updateStep({
      operationId,
      stepId,
      status: body.status,
      evidence: ensureJsonObject(body.evidence, 'operation step evidence'),
      expectedRevision: body.expectedRevision,
      lockScope: body.lockScope,
      fencingToken: body.fencingToken,
      actorId: actor(c).id,
    });
    return c.json(toOperationStepResponse(step), 200);
  });

  app.openapi(completeOperationRoute, async (c) => {
    const { id } = c.req.valid('param');
    await operationForMutation(c, id);
    const body = c.req.valid('json');
    const operation = await new OperationService(repository(c)).complete({
      id,
      expectedRevision: body.expectedRevision,
      lockScope: body.lockScope,
      fencingToken: body.fencingToken,
      actorId: actor(c).id,
    });
    return c.json(toOperationResponse(operation), 200);
  });

  app.openapi(failOperationRoute, async (c) => {
    const { id } = c.req.valid('param');
    await operationForMutation(c, id);
    const body = c.req.valid('json');
    const operation = await new OperationService(repository(c)).updateStatus({
      id,
      targetStatus: 'failed',
      expectedRevision: body.expectedRevision,
      lockScope: body.lockScope,
      fencingToken: body.fencingToken,
      actorId: actor(c).id,
    });
    return c.json(toOperationResponse(operation), 200);
  });

  app.openapi(cancelOperationRoute, async (c) => {
    const { id } = c.req.valid('param');
    await operationForMutation(c, id);
    const body = c.req.valid('json');
    const operation = await new OperationService(repository(c)).updateStatus({
      id,
      targetStatus: 'cancelled',
      expectedRevision: body.expectedRevision,
      lockScope: body.lockScope,
      fencingToken: body.fencingToken,
      actorId: actor(c).id,
    });
    return c.json(toOperationResponse(operation), 200);
  });

  app.openapi(listOperationEventsRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    if ((await repository(c).getOperation(id)) === null) {
      throw new NotFoundError('Operation', id);
    }
    return c.json(
      toAuditEventListResponse(await repository(c).listOperationEvents(id, limit)),
      200,
    );
  });
}
