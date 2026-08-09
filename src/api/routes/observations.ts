import type { OpenAPIHono } from '@hono/zod-openapi';
import { ObservationService } from '../../application/observations';
import { ensureJsonObject } from '../../domain/models/json';
import {
  createDriftRoute,
  createObservationRoute,
  listAuditEventsRoute,
  listDriftsRoute,
  putResourceHealthRoute,
  toAuditEventListResponse,
  toDriftListResponse,
  toDriftResponse,
  toHealthResponse,
  toObservationResponse,
  updateDriftRoute,
} from '../contracts/observations';
import type { ApiEnvironment } from '../environment';
import { actor, repository } from '../environment';

export function registerObservationRoutes(app: OpenAPIHono<ApiEnvironment>): void {
  app.openapi(putResourceHealthRoute, async (c) => {
    const { key: resourceKey } = c.req.valid('param');
    const body = c.req.valid('json');
    const health = await new ObservationService(repository(c)).putHealth({
      resourceKey,
      status: body.status,
      observedAt: body.observedAt,
      expectedRevision: body.expectedRevision,
      actorId: actor(c).id,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
    return c.json(toHealthResponse(health), 200);
  });

  app.openapi(createObservationRoute, async (c) => {
    const { key: resourceKey } = c.req.valid('param');
    const body = c.req.valid('json');
    const observation = await new ObservationService(repository(c)).createObservation({
      resourceKey,
      observedAt: body.observedAt,
      facts: ensureJsonObject(body.facts, 'facts'),
      retentionHours: body.retentionHours,
      actorId: actor(c).id,
    });
    return c.json(toObservationResponse(observation), 201);
  });

  app.openapi(createDriftRoute, async (c) => {
    const body = c.req.valid('json');
    const drift = await new ObservationService(repository(c)).createDrift({
      resourceKey: body.resourceKey,
      severity: body.severity,
      expected: ensureJsonObject(body.expected, 'expected'),
      observed: ensureJsonObject(body.observed, 'observed'),
      actorId: actor(c).id,
    });
    return c.json(toDriftResponse(drift), 201);
  });

  app.openapi(listDriftsRoute, async (c) => {
    const { limit, status } = c.req.valid('query');
    return c.json(toDriftListResponse(await repository(c).listDrifts(status, limit)), 200);
  });

  app.openapi(updateDriftRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const drift = await new ObservationService(repository(c)).updateDrift({
      id,
      ...body,
      actorId: actor(c).id,
    });
    return c.json(toDriftResponse(drift), 200);
  });

  app.openapi(listAuditEventsRoute, async (c) => {
    const { limit } = c.req.valid('query');
    return c.json(
      toAuditEventListResponse(await repository(c).listEvents(Math.min(limit ?? 100, 500))),
      200,
    );
  });
}
