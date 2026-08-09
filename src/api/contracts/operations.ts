import { createRoute, z } from '@hono/zod-openapi';
import type { OperationDetail } from '../../application/operations';
import {
  type LockLease,
  type Operation,
  type OperationStep,
} from '../../domain/models/global-registry';
import {
  lockLeaseRecordSchema,
  operationRecordSchema,
  operationResourcePlanSchema as domainOperationResourcePlanSchema,
  operationStepPlanSchema as domainOperationStepPlanSchema,
  operationStepRecordSchema,
  operationStepStatusSchema as domainOperationStepStatusSchema,
} from '../../domain/models/schemas';
import { operationChangeSchema } from '../../domain/operation/schemas';
import {
  MAX_LOCK_SCOPES,
  MAX_OPERATION_CHANGES,
  MAX_OPERATION_RESOURCES,
  MAX_OPERATION_STEPS,
} from '../../domain/operation/limits';
import { auditEventListResponseSchema } from './observations';
import {
  fencingSchema,
  auditPageLimitSchema,
  identifierSchema,
  jsonObjectSchema,
  jsonRequest,
  jsonResponse,
  noContentResponse,
  operationStatusSchema,
  operationRouteMetadata,
  pageLimitSchema,
  parseResponse,
  protectedRouteMetadata,
} from './common';
import { standardErrorResponses } from './errors';

const operationStepStatusSchema = domainOperationStepStatusSchema.openapi('OperationStepStatus');

const operationResponseSchema = operationRecordSchema
  .extend({
    id: operationRecordSchema.shape.id.openapi({ readOnly: true }),
    actorId: operationRecordSchema.shape.actorId.openapi({ readOnly: true }),
    plan: jsonObjectSchema.openapi({ readOnly: true }),
    planHash: operationRecordSchema.shape.planHash.openapi({ readOnly: true }),
    destructive: operationRecordSchema.shape.destructive.openapi({ readOnly: true }),
    revision: operationRecordSchema.shape.revision.openapi({ readOnly: true }),
    createdAt: operationRecordSchema.shape.createdAt.openapi({ readOnly: true }),
    updatedAt: operationRecordSchema.shape.updatedAt.openapi({ readOnly: true }),
  })
  .strict()
  .openapi('Operation');

const operationResourcePlanSchema =
  domainOperationResourcePlanSchema.openapi('OperationResourcePlan');

const operationStepPlanSchema = domainOperationStepPlanSchema
  .extend({
    gate: jsonObjectSchema.default({}),
    evidence: jsonObjectSchema.optional(),
  })
  .strict()
  .openapi('OperationStepPlan');

const operationStepResponseSchema = operationStepRecordSchema
  .extend({
    id: operationStepRecordSchema.shape.id.openapi({ readOnly: true }),
    operationId: operationStepRecordSchema.shape.operationId.openapi({ readOnly: true }),
    position: operationStepRecordSchema.shape.position.openapi({ readOnly: true }),
    name: operationStepRecordSchema.shape.name.openapi({ readOnly: true }),
    status: operationStepStatusSchema,
    gate: jsonObjectSchema.openapi({ readOnly: true }),
    evidence: jsonObjectSchema,
    revision: operationStepRecordSchema.shape.revision.openapi({ readOnly: true }),
    startedAt: operationStepRecordSchema.shape.startedAt
      .unwrap()
      .nullable()
      .openapi({ readOnly: true }),
    completedAt: operationStepRecordSchema.shape.completedAt
      .unwrap()
      .nullable()
      .openapi({ readOnly: true }),
  })
  .strict()
  .openapi('OperationStep');

const operationDetailResponseSchema = z
  .object({
    operation: operationResponseSchema,
    resources: z.array(operationResourcePlanSchema),
    steps: z.array(operationStepResponseSchema),
  })
  .strict()
  .openapi('OperationDetail');

const lockLeaseResponseSchema = lockLeaseRecordSchema
  .extend({
    scope: lockLeaseRecordSchema.shape.scope.openapi({ readOnly: true }),
    operationId: lockLeaseRecordSchema.shape.operationId.openapi({ readOnly: true }),
    fencingToken: lockLeaseRecordSchema.shape.fencingToken.openapi({ readOnly: true }),
    expiresAt: lockLeaseRecordSchema.shape.expiresAt.openapi({ readOnly: true }),
  })
  .strict()
  .openapi('LockLease');

const lockLeaseListResponseSchema = z
  .object({ items: z.array(lockLeaseResponseSchema) })
  .strict()
  .openapi('LockLeaseList');

const operationListResponseSchema = z
  .object({ items: z.array(operationResponseSchema) })
  .strict()
  .openapi('OperationList');

const createOperationRequestSchema = z
  .object({
    kind: z.string().min(1).max(128),
    intent: jsonObjectSchema.default({}),
    destructive: z.boolean().default(false),
    resources: z.array(operationResourcePlanSchema).min(1).max(MAX_OPERATION_RESOURCES),
    changes: z.array(operationChangeSchema).max(MAX_OPERATION_CHANGES).default([]),
    steps: z.array(operationStepPlanSchema).max(MAX_OPERATION_STEPS).default([]),
  })
  .strict()
  .openapi('CreateOperationRequest');

const acquireOperationLocksRequestSchema = z
  .object({
    scopes: z.array(z.string().min(3).max(256)).min(1).max(MAX_LOCK_SCOPES),
    leaseSeconds: z.number().int().min(30).max(3600).default(300),
  })
  .strict()
  .openapi('AcquireOperationLocksRequest');

const updateOperationStepRequestSchema = fencingSchema
  .extend({
    status: operationStepStatusSchema,
    evidence: jsonObjectSchema.default({}),
  })
  .strict()
  .openapi('UpdateOperationStepRequest');

const operationIdParamsSchema = z
  .object({
    id: identifierSchema.openapi({
      param: { name: 'id', in: 'path', required: true },
      example: 'operation-b75ecf35',
    }),
  })
  .openapi('OperationIdPathParameters');

const operationStepParamsSchema = z
  .object({
    id: identifierSchema.openapi({
      param: { name: 'id', in: 'path', required: true },
      example: 'operation-b75ecf35',
    }),
    stepId: identifierSchema.openapi({
      param: { name: 'stepId', in: 'path', required: true },
      example: 'step-48d932c0',
    }),
  })
  .openapi('OperationStepPathParameters');

const listOperationsQuerySchema = z
  .object({
    limit: pageLimitSchema.optional(),
    status: operationStatusSchema
      .optional()
      .openapi({ param: { name: 'status', in: 'query' }, example: 'running' }),
  })
  .strict()
  .openapi('ListOperationsQuery');

const operationExample = {
  id: 'operation-b75ecf35',
  actorId: 'actor-provisioner',
  kind: 'provision-resource',
  status: 'planned',
  plan: {
    kind: 'provision-resource',
    intent: {},
    resources: [
      {
        resourceKey: 'web-01',
        sourceState: 'absent',
        targetState: 'allocated',
        resourceRevision: 1,
      },
    ],
    changes: [],
    steps: [],
    destructive: false,
  },
  planHash: `sha256:${'a'.repeat(64)}`,
  destructive: false,
  revision: 1,
  createdAt: '2026-07-28T01:00:00.000Z',
  updatedAt: '2026-07-28T01:00:00.000Z',
} as const;

const fencingExample = {
  expectedRevision: 1,
  lockScope: 'resource/web-01',
  fencingToken: 1,
} as const;

export const createOperationRoute = createRoute({
  method: 'post',
  path: '/api/v1/operations',
  operationId: 'createOperation',
  tags: ['Operations'],
  summary: 'Create an operation plan',
  description:
    'Creates an immutable operation plan after resource revision, lifecycle, and change validation. Non-destructive plans allow provisioner or operator; destructive plans require operator.',
  ...operationRouteMetadata(),
  request: {
    body: jsonRequest(
      createOperationRequestSchema,
      'The immutable operation intent, affected resources, planned changes, and steps.',
      {
        kind: operationExample.kind,
        intent: {},
        destructive: false,
        resources: operationExample.plan.resources,
        changes: [],
        steps: [],
      },
    ),
  },
  responses: {
    201: jsonResponse(operationResponseSchema, 'The newly created operation.', operationExample),
    ...standardErrorResponses(),
  },
});

export const listOperationsRoute = createRoute({
  method: 'get',
  path: '/api/v1/operations',
  operationId: 'listOperations',
  tags: ['Operations'],
  summary: 'List operations',
  description:
    'Lists operations, optionally filtered by status. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: { query: listOperationsQuerySchema },
  responses: {
    200: jsonResponse(operationListResponseSchema, 'Operations matching the requested status.', {
      items: [operationExample],
    }),
    ...standardErrorResponses(),
  },
});

export const getOperationRoute = createRoute({
  method: 'get',
  path: '/api/v1/operations/{id}',
  operationId: 'getOperation',
  tags: ['Operations'],
  summary: 'Get operation details',
  description:
    'Returns an operation, its resource plan, and execution steps. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: { params: operationIdParamsSchema },
  responses: {
    200: jsonResponse(operationDetailResponseSchema, 'The requested operation detail.', {
      operation: operationExample,
      resources: operationExample.plan.resources,
      steps: [],
    }),
    ...standardErrorResponses(),
  },
});

export const acquireOperationLocksRoute = createRoute({
  method: 'post',
  path: '/api/v1/operations/{id}/locks',
  operationId: 'acquireOperationLocks',
  tags: ['Operations'],
  summary: 'Acquire operation locks',
  description:
    'Acquires ordered lock leases and monotonically increasing fencing tokens. The operation role rule applies: provisioner or operator for non-destructive operations, operator for destructive operations.',
  ...operationRouteMetadata(),
  request: {
    params: operationIdParamsSchema,
    body: jsonRequest(
      acquireOperationLocksRequestSchema,
      'The lock scopes and requested lease duration.',
      { scopes: ['resource/web-01'], leaseSeconds: 300 },
    ),
  },
  responses: {
    201: jsonResponse(lockLeaseListResponseSchema, 'The acquired lock leases.', {
      items: [
        {
          scope: 'resource/web-01',
          operationId: operationExample.id,
          fencingToken: 1,
          expiresAt: '2026-07-28T01:05:00.000Z',
        },
      ],
    }),
    ...standardErrorResponses(),
  },
});

export const renewOperationLocksRoute = createRoute({
  method: 'post',
  path: '/api/v1/operations/{id}/locks/renew',
  operationId: 'renewOperationLocks',
  tags: ['Operations'],
  summary: 'Renew operation locks',
  description:
    'Renews only lock scopes already planned for the operation. The operation owner must perform the renewal.',
  ...operationRouteMetadata(),
  request: {
    params: operationIdParamsSchema,
    body: jsonRequest(
      acquireOperationLocksRequestSchema,
      'The owned lock scopes and requested lease duration.',
      { scopes: ['resource/web-01'], leaseSeconds: 300 },
    ),
  },
  responses: {
    200: jsonResponse(lockLeaseListResponseSchema, 'The renewed lock leases.', {
      items: [
        {
          scope: 'resource/web-01',
          operationId: operationExample.id,
          fencingToken: 2,
          expiresAt: '2026-07-28T01:10:00.000Z',
        },
      ],
    }),
    ...standardErrorResponses(),
  },
});

const releaseOperationLocksRequestSchema = z
  .object({ scopes: acquireOperationLocksRequestSchema.shape.scopes })
  .strict()
  .openapi('ReleaseOperationLocksRequest');

export const releaseOperationLocksRoute = createRoute({
  method: 'post',
  path: '/api/v1/operations/{id}/locks/release',
  operationId: 'releaseOperationLocks',
  tags: ['Operations'],
  summary: 'Release operation locks',
  description: 'Releases only lock scopes owned by the operation creator.',
  ...operationRouteMetadata(),
  request: {
    params: operationIdParamsSchema,
    body: jsonRequest(releaseOperationLocksRequestSchema, 'The owned lock scopes to release.', {
      scopes: ['resource/web-01'],
    }),
  },
  responses: {
    204: noContentResponse,
    ...standardErrorResponses(),
  },
});

export const startOperationRoute = createRoute({
  method: 'post',
  path: '/api/v1/operations/{id}/start',
  operationId: 'startOperation',
  tags: ['Operations'],
  summary: 'Start an operation',
  description:
    'Moves a planned operation to running under an active lock. The operation role rule applies: provisioner or operator for non-destructive operations, operator for destructive operations.',
  ...operationRouteMetadata(),
  request: {
    params: operationIdParamsSchema,
    body: jsonRequest(
      fencingSchema,
      'The expected operation revision and active lock fence.',
      fencingExample,
    ),
  },
  responses: {
    200: jsonResponse(operationResponseSchema, 'The running operation.', {
      ...operationExample,
      status: 'running',
      revision: 2,
    }),
    ...standardErrorResponses(),
  },
});

export const updateOperationStepRoute = createRoute({
  method: 'patch',
  path: '/api/v1/operations/{id}/steps/{stepId}',
  operationId: 'updateOperationStep',
  tags: ['Operations'],
  summary: 'Update an operation step',
  description:
    'Changes a step status and evidence while the operation is running under an active lock. The operation role rule applies: provisioner or operator for non-destructive operations, operator for destructive operations.',
  ...operationRouteMetadata(),
  request: {
    params: operationStepParamsSchema,
    body: jsonRequest(
      updateOperationStepRequestSchema,
      'The target step status, evidence, expected revision, and active lock fence.',
      { ...fencingExample, status: 'succeeded', evidence: { taskId: 'runner-42' } },
    ),
  },
  responses: {
    200: jsonResponse(operationStepResponseSchema, 'The updated operation step.', {
      id: 'step-48d932c0',
      operationId: operationExample.id,
      position: 0,
      name: 'Allocate provider resource',
      status: 'succeeded',
      gate: {},
      evidence: { taskId: 'runner-42' },
      revision: 2,
      startedAt: '2026-07-28T01:01:00.000Z',
      completedAt: '2026-07-28T01:02:00.000Z',
    }),
    ...standardErrorResponses(),
  },
});

function operationStatusRoute(input: {
  path:
    | '/api/v1/operations/{id}/complete'
    | '/api/v1/operations/{id}/fail'
    | '/api/v1/operations/{id}/cancel';
  operationId: 'completeOperation' | 'failOperation' | 'cancelOperation';
  summary: string;
  description?: string;
  targetStatus: 'succeeded' | 'failed' | 'cancelled';
}) {
  return createRoute({
    method: 'post',
    path: input.path,
    operationId: input.operationId,
    tags: ['Operations'],
    summary: input.summary,
    description:
      input.description ??
      'Changes the operation terminal status under an active lock and optimistic revision check. The operation role rule applies: provisioner or operator for non-destructive operations, operator for destructive operations.',
    ...operationRouteMetadata(),
    request: {
      params: operationIdParamsSchema,
      body: jsonRequest(
        fencingSchema,
        'The expected operation revision and active lock fence.',
        fencingExample,
      ),
    },
    responses: {
      200: jsonResponse(
        operationResponseSchema,
        `The operation after transition to ${input.targetStatus}.`,
        { ...operationExample, status: input.targetStatus, revision: 3 },
      ),
      ...standardErrorResponses(),
    },
  });
}

export const completeOperationRoute = operationStatusRoute({
  path: '/api/v1/operations/{id}/complete',
  operationId: 'completeOperation',
  summary: 'Complete an operation',
  description:
    'Verifies every planned resource lifecycle target, step terminal status, and Registry-visible change against authoritative D1 state before entering succeeded status. The active lock, fencing token, optimistic revision, and operation role rule also apply.',
  targetStatus: 'succeeded',
});

export const failOperationRoute = operationStatusRoute({
  path: '/api/v1/operations/{id}/fail',
  operationId: 'failOperation',
  summary: 'Fail an operation',
  targetStatus: 'failed',
});

export const cancelOperationRoute = operationStatusRoute({
  path: '/api/v1/operations/{id}/cancel',
  operationId: 'cancelOperation',
  summary: 'Cancel an operation',
  targetStatus: 'cancelled',
});

export const listOperationEventsRoute = createRoute({
  method: 'get',
  path: '/api/v1/operations/{id}/events',
  operationId: 'listOperationEvents',
  tags: ['Operations', 'Audit'],
  summary: 'List operation audit events',
  description:
    'Lists audit events associated with one operation. Requires an active mapped Registry actor.',
  ...protectedRouteMetadata(),
  request: {
    params: operationIdParamsSchema,
    query: z
      .object({ limit: auditPageLimitSchema.optional() })
      .strict()
      .openapi('ListOperationEventsQuery'),
  },
  responses: {
    200: jsonResponse(auditEventListResponseSchema, 'Audit events for the requested operation.', {
      items: [
        {
          eventId: 'evt-737fdc83',
          eventType: 'operation.created',
          resourceKey: null,
          operationId: operationExample.id,
          actorId: operationExample.actorId,
          payload: { operationId: operationExample.id },
          occurredAt: operationExample.createdAt,
        },
      ],
    }),
    ...standardErrorResponses(),
  },
});

export function toOperationResponse(operation: Operation) {
  return parseResponse(operationResponseSchema, operation);
}

export function toOperationStepResponse(step: OperationStep) {
  return parseResponse(operationStepResponseSchema, {
    ...step,
    startedAt: step.startedAt ?? null,
    completedAt: step.completedAt ?? null,
  });
}

export function toOperationDetailResponse(detail: OperationDetail) {
  return parseResponse(operationDetailResponseSchema, {
    operation: toOperationResponse(detail.operation),
    resources: detail.resources,
    steps: detail.steps.map(toOperationStepResponse),
  });
}

export function toOperationListResponse(operations: Operation[]) {
  return parseResponse(operationListResponseSchema, {
    items: operations.map(toOperationResponse),
  });
}

export function toLockLeaseListResponse(locks: LockLease[]) {
  return parseResponse(lockLeaseListResponseSchema, { items: locks });
}
