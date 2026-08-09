import { createRoute, z } from '@hono/zod-openapi';
import {
  DRIFT_SEVERITIES,
  type AuditEvent,
  type Drift,
  type Health,
  type Observation,
} from '../../domain/models/global-registry';
import {
  auditEventRecordSchema,
  driftRecordSchema,
  healthRecordSchema,
  observationRecordSchema,
} from '../../domain/models/schemas';
import {
  auditPageLimitSchema,
  driftStatusSchema,
  healthStatusSchema,
  identifierSchema,
  jsonObjectSchema,
  jsonRequest,
  jsonResponse,
  keySchema,
  pageLimitSchema,
  nonnegativeRevisionSchema,
  parseResponse,
  protectedRouteMetadata,
  revisionSchema,
  timestampSchema,
} from './common';
import { standardErrorResponses } from './errors';

export const healthResponseSchema = healthRecordSchema
  .extend({
    resourceId: healthRecordSchema.shape.resourceId.openapi({ readOnly: true }),
    reason: healthRecordSchema.shape.reason.unwrap().nullable(),
    observedAt: timestampSchema,
    observedBy: healthRecordSchema.shape.observedBy.openapi({ readOnly: true }),
    revision: healthRecordSchema.shape.revision.openapi({ readOnly: true }),
    updatedAt: healthRecordSchema.shape.updatedAt.openapi({ readOnly: true }),
  })
  .strict()
  .openapi('ResourceHealth');

const observationResponseSchema = observationRecordSchema
  .extend({
    id: observationRecordSchema.shape.id.openapi({ readOnly: true }),
    resourceId: observationRecordSchema.shape.resourceId.openapi({ readOnly: true }),
    observerId: observationRecordSchema.shape.observerId.openapi({ readOnly: true }),
    observedAt: timestampSchema,
    facts: jsonObjectSchema,
    expiresAt: observationRecordSchema.shape.expiresAt.openapi({ readOnly: true }),
    archivedAt: observationRecordSchema.shape.archivedAt
      .unwrap()
      .nullable()
      .openapi({ readOnly: true }),
    r2ObjectKey: observationRecordSchema.shape.r2ObjectKey
      .unwrap()
      .nullable()
      .openapi({ readOnly: true }),
    createdAt: observationRecordSchema.shape.createdAt.openapi({ readOnly: true }),
  })
  .strict()
  .openapi('Observation');

export const driftResponseSchema = driftRecordSchema
  .extend({
    id: driftRecordSchema.shape.id.openapi({ readOnly: true }),
    resourceId: driftRecordSchema.shape.resourceId.openapi({ readOnly: true }),
    expected: jsonObjectSchema,
    observed: jsonObjectSchema,
    revision: driftRecordSchema.shape.revision.openapi({ readOnly: true }),
    createdAt: driftRecordSchema.shape.createdAt.openapi({ readOnly: true }),
    updatedAt: driftRecordSchema.shape.updatedAt.openapi({ readOnly: true }),
    createdBy: driftRecordSchema.shape.createdBy.openapi({ readOnly: true }),
    resolvedAt: driftRecordSchema.shape.resolvedAt.unwrap().nullable().openapi({ readOnly: true }),
  })
  .strict()
  .openapi('Drift');

const auditEventResponseSchema = auditEventRecordSchema
  .extend({
    eventId: auditEventRecordSchema.shape.eventId.openapi({ readOnly: true }),
    resourceKey: auditEventRecordSchema.shape.resourceKey.unwrap().nullable(),
    operationId: auditEventRecordSchema.shape.operationId.unwrap().nullable(),
    actorId: auditEventRecordSchema.shape.actorId.openapi({ readOnly: true }),
    payload: jsonObjectSchema,
    occurredAt: auditEventRecordSchema.shape.occurredAt.openapi({ readOnly: true }),
  })
  .strict()
  .openapi('AuditEvent');

export const auditEventListResponseSchema = z
  .object({ items: z.array(auditEventResponseSchema) })
  .strict()
  .openapi('AuditEventList');

const driftListResponseSchema = z
  .object({ items: z.array(driftResponseSchema) })
  .strict()
  .openapi('DriftList');

const putHealthRequestSchema = z
  .object({
    status: healthStatusSchema,
    reason: z.string().min(1).max(512).optional(),
    observedAt: timestampSchema,
    expectedRevision: nonnegativeRevisionSchema,
  })
  .strict()
  .openapi('PutResourceHealthRequest');

const createObservationRequestSchema = z
  .object({
    observedAt: timestampSchema,
    facts: jsonObjectSchema,
    retentionHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .default(24 * 7),
  })
  .strict()
  .openapi('CreateObservationRequest');

const createDriftRequestSchema = z
  .object({
    resourceKey: keySchema,
    severity: z.enum(DRIFT_SEVERITIES),
    expected: jsonObjectSchema,
    observed: jsonObjectSchema,
  })
  .strict()
  .openapi('CreateDriftRequest');

const updateDriftRequestSchema = z
  .object({
    status: driftStatusSchema,
    expectedRevision: revisionSchema,
  })
  .strict()
  .openapi('UpdateDriftRequest');

const observationResourceParamsSchema = z
  .object({
    key: keySchema.openapi({
      param: { name: 'key', in: 'path', required: true },
      example: 'web-01',
    }),
  })
  .openapi('ObservationResourcePathParameters');

const driftIdParamsSchema = z
  .object({
    id: identifierSchema.openapi({
      param: { name: 'id', in: 'path', required: true },
      example: 'drift-d56c48a6',
    }),
  })
  .openapi('DriftIdPathParameters');

const listDriftsQuerySchema = z
  .object({
    limit: pageLimitSchema.optional(),
    status: driftStatusSchema
      .optional()
      .openapi({ param: { name: 'status', in: 'query' }, example: 'open' }),
  })
  .strict()
  .openapi('ListDriftsQuery');

const listAuditEventsQuerySchema = z
  .object({ limit: auditPageLimitSchema.optional() })
  .strict()
  .openapi('ListAuditEventsQuery');

const healthExample = {
  resourceId: 'resource-6fd894bf',
  status: 'healthy',
  reason: null,
  observedAt: '2026-07-28T01:00:00.000Z',
  observedBy: 'actor-observer',
  revision: 1,
  updatedAt: '2026-07-28T01:00:00.000Z',
} as const;

const observationExample = {
  id: 'observation-4e2cc8f8',
  resourceId: 'resource-6fd894bf',
  observerId: 'actor-observer',
  observedAt: '2026-07-28T01:00:00.000Z',
  facts: { power: 'running' },
  expiresAt: '2026-08-04T01:00:00.000Z',
  archivedAt: null,
  r2ObjectKey: null,
  createdAt: '2026-07-28T01:00:00.000Z',
} as const;

const driftExample = {
  id: 'drift-d56c48a6',
  resourceId: 'resource-6fd894bf',
  severity: 'high',
  status: 'open',
  expected: { lifecycle: 'ready' },
  observed: { lifecycle: 'absent' },
  revision: 1,
  createdAt: '2026-07-28T01:00:00.000Z',
  updatedAt: '2026-07-28T01:00:00.000Z',
  createdBy: 'actor-observer',
  resolvedAt: null,
} as const;

export const putResourceHealthRoute = createRoute({
  method: 'put',
  path: '/api/v1/resources/{key}/health',
  operationId: 'putResourceHealth',
  tags: ['Observations'],
  summary: 'Record resource health',
  description:
    'Creates or updates the latest health observation using optimistic locking. Requires the observer role.',
  ...protectedRouteMetadata('observer'),
  request: {
    params: observationResourceParamsSchema,
    body: jsonRequest(
      putHealthRequestSchema,
      'The observed health state, time, and expected health revision.',
      {
        status: 'healthy',
        observedAt: healthExample.observedAt,
        expectedRevision: 0,
      },
    ),
  },
  responses: {
    200: jsonResponse(healthResponseSchema, 'The current resource health.', healthExample),
    ...standardErrorResponses(),
  },
});

export const createObservationRoute = createRoute({
  method: 'post',
  path: '/api/v1/resources/{key}/observations',
  operationId: 'createObservation',
  tags: ['Observations'],
  summary: 'Create a resource observation',
  description: 'Stores time-bound observed facts for a resource. Requires the observer role.',
  ...protectedRouteMetadata('observer'),
  request: {
    params: observationResourceParamsSchema,
    body: jsonRequest(
      createObservationRequestSchema,
      'Observed facts, observation time, and retention period.',
      {
        observedAt: observationExample.observedAt,
        facts: observationExample.facts,
        retentionHours: 168,
      },
    ),
  },
  responses: {
    201: jsonResponse(
      observationResponseSchema,
      'The newly stored observation.',
      observationExample,
    ),
    ...standardErrorResponses(),
  },
});

export const createDriftRoute = createRoute({
  method: 'post',
  path: '/api/v1/drifts',
  operationId: 'createDrift',
  tags: ['Drift'],
  summary: 'Create a drift record',
  description:
    'Records a difference between expected and observed resource state. Requires the observer role.',
  ...protectedRouteMetadata('observer'),
  request: {
    body: jsonRequest(
      createDriftRequestSchema,
      'The affected resource, severity, expected state, and observed state.',
      {
        resourceKey: 'web-01',
        severity: 'high',
        expected: driftExample.expected,
        observed: driftExample.observed,
      },
    ),
  },
  responses: {
    201: jsonResponse(driftResponseSchema, 'The newly created drift record.', driftExample),
    ...standardErrorResponses(),
  },
});

export const listDriftsRoute = createRoute({
  method: 'get',
  path: '/api/v1/drifts',
  operationId: 'listDrifts',
  tags: ['Drift'],
  summary: 'List drift records',
  description:
    'Lists drift records, optionally filtered by status. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: { query: listDriftsQuerySchema },
  responses: {
    200: jsonResponse(driftListResponseSchema, 'Drift records matching the requested status.', {
      items: [driftExample],
    }),
    ...standardErrorResponses(),
  },
});

export const updateDriftRoute = createRoute({
  method: 'patch',
  path: '/api/v1/drifts/{id}',
  operationId: 'updateDrift',
  tags: ['Drift'],
  summary: 'Update a drift status',
  description:
    'Changes drift acknowledgement or resolution status with optimistic locking. Requires the observer role.',
  ...protectedRouteMetadata('observer'),
  request: {
    params: driftIdParamsSchema,
    body: jsonRequest(
      updateDriftRequestSchema,
      'The target drift status and expected current revision.',
      { status: 'acknowledged', expectedRevision: 1 },
    ),
  },
  responses: {
    200: jsonResponse(driftResponseSchema, 'The updated drift record.', {
      ...driftExample,
      status: 'acknowledged',
      revision: 2,
    }),
    ...standardErrorResponses(),
  },
});

export const listAuditEventsRoute = createRoute({
  method: 'get',
  path: '/api/v1/events',
  operationId: 'listAuditEvents',
  tags: ['Audit'],
  summary: 'List audit events',
  description: 'Lists recent append-only audit events. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: { query: listAuditEventsQuerySchema },
  responses: {
    200: jsonResponse(
      auditEventListResponseSchema,
      'Recent audit events ordered by occurrence time.',
      {
        items: [
          {
            eventId: 'evt-c84eb8a1',
            eventType: 'resource.created',
            resourceKey: 'web-01',
            operationId: null,
            actorId: 'actor-a28ca7c4',
            payload: { key: 'web-01' },
            occurredAt: '2026-07-28T01:00:00.000Z',
          },
        ],
      },
    ),
    ...standardErrorResponses(),
  },
});

export function toHealthResponse(health: Health) {
  return parseResponse(healthResponseSchema, { ...health, reason: health.reason ?? null });
}

export function toObservationResponse(observation: Observation) {
  return parseResponse(observationResponseSchema, {
    ...observation,
    archivedAt: observation.archivedAt ?? null,
    r2ObjectKey: observation.r2ObjectKey ?? null,
  });
}

export function toDriftResponse(drift: Drift) {
  return parseResponse(driftResponseSchema, {
    ...drift,
    resolvedAt: drift.resolvedAt ?? null,
  });
}

function toAuditEventResponse(event: AuditEvent) {
  return parseResponse(auditEventResponseSchema, {
    ...event,
    resourceKey: event.resourceKey ?? null,
    operationId: event.operationId ?? null,
  });
}

export function toAuditEventListResponse(events: AuditEvent[]) {
  return parseResponse(auditEventListResponseSchema, {
    items: events.map(toAuditEventResponse),
  });
}

export function toDriftListResponse(drifts: Drift[]) {
  return parseResponse(driftListResponseSchema, { items: drifts.map(toDriftResponse) });
}
