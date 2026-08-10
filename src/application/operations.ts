import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../domain/errors/global-registry-error';
import {
  isDestructiveLifecycleTransition,
  validateLifecycleTransition,
} from '../domain/lifecycle/lifecycle';
import { ensureJsonObject } from '../domain/models/json';
import type {
  JsonObject,
  LockLease,
  Operation,
  OperationStatus,
  OperationStep,
  OperationStepPlan,
  Resource,
  ResourceLifecycleState,
} from '../domain/models/global-registry';
import type { OperationChange } from '../domain/operation/model';
import { validateOperationChanges } from '../domain/operation/validation';
import { assertOperationLimits, MAX_LOCK_SCOPES } from '../domain/operation/limits';
import { hashPlan } from './services/plan-hash';

interface OperationResourceCommand {
  resourceKey: string;
  sourceState: ResourceLifecycleState;
  targetState: ResourceLifecycleState;
  resourceRevision: number;
}

interface CreateOperationCommand {
  actorId: string;
  kind: string;
  intent: JsonObject;
  destructive: boolean;
  resources: OperationResourceCommand[];
  changes: OperationChange[];
  steps: OperationStepPlan[];
}

interface PersistOperationResource extends OperationResourceCommand {
  resourceId: string;
}

interface PersistOperationChange {
  change: OperationChange;
  position: number;
  resourceId: string;
  targetResourceId: string | null;
}

export interface PersistOperationCommand {
  actorId: string;
  kind: string;
  plan: JsonObject;
  planHash: string;
  destructive: boolean;
  resources: PersistOperationResource[];
  changes: PersistOperationChange[];
  steps: OperationStepPlan[];
}

export interface OperationDetail {
  operation: Operation;
  resources: OperationResourceCommand[];
  steps: OperationStep[];
}

export interface TransitionResourceCommand {
  key: string;
  resourceId: string;
  sourceState: ResourceLifecycleState;
  targetState: ResourceLifecycleState;
  expectedRevision: number;
  operationId: string;
  fencingToken: number;
  actorId: string;
}

export interface ChangeOperationStatusCommand {
  id: string;
  sourceStatus: OperationStatus;
  targetStatus: OperationStatus;
  expectedRevision: number;
  lockScope: string;
  fencingToken: number;
  actorId: string;
}

export interface CompleteOperationCommand {
  id: string;
  expectedRevision: number;
  lockScope: string;
  fencingToken: number;
  actorId: string;
}

export interface ChangeOperationStepCommand {
  operationId: string;
  stepId: string;
  sourceStatus: OperationStep['status'];
  status: OperationStep['status'];
  evidence: JsonObject;
  expectedRevision: number;
  lockScope: string;
  fencingToken: number;
  actorId: string;
}

interface OperationStore {
  getResource(key: string): Promise<Resource | null>;
  getOperation(id: string): Promise<Operation | null>;
  getOperationDetail(id: string): Promise<OperationDetail | null>;
  createOperation(input: PersistOperationCommand): Promise<Operation>;
  acquireLocks(input: {
    operationId: string;
    scopes: string[];
    leaseSeconds: number;
    actorId: string;
  }): Promise<LockLease[]>;
  renewLocks(input: {
    operationId: string;
    scopes: string[];
    leaseSeconds: number;
    actorId: string;
  }): Promise<LockLease[]>;
  releaseLocks(input: { operationId: string; scopes: string[]; actorId: string }): Promise<void>;
  transition(input: TransitionResourceCommand): Promise<Resource>;
  completeOperation(input: CompleteOperationCommand): Promise<Operation>;
  updateOperationStatus(input: ChangeOperationStatusCommand): Promise<Operation>;
  updateOperationStep(input: ChangeOperationStepCommand): Promise<OperationStep>;
}

const OPERATION_STATUS_TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> =
  {
    planned: ['running', 'cancelled'],
    running: ['failed', 'blocked', 'cancelled'],
    blocked: ['running', 'failed', 'cancelled'],
    succeeded: [],
    failed: [],
    cancelled: [],
  };

const STEP_STATUS_TRANSITIONS: Readonly<
  Record<OperationStep['status'], readonly OperationStep['status'][]>
> = {
  planned: ['running', 'succeeded', 'failed', 'blocked', 'skipped'],
  running: ['succeeded', 'failed', 'blocked'],
  blocked: ['running', 'failed', 'skipped'],
  succeeded: [],
  failed: [],
  skipped: [],
};

export class OperationService {
  constructor(private readonly store: OperationStore) {}

  async create(input: CreateOperationCommand): Promise<Operation> {
    assertOperationLimits(input);
    if (input.resources.length === 0) {
      throw new ValidationError(
        'operation_resources_required',
        'An operation must include at least one resource.',
      );
    }
    const changes = validateOperationChanges(input.changes);
    const resourceKeys = new Set<string>();
    const resources: PersistOperationResource[] = [];
    for (const planned of input.resources) {
      if (resourceKeys.has(planned.resourceKey)) {
        throw new ValidationError(
          'duplicate_operation_resource',
          'A resource can appear only once in an operation.',
        );
      }
      resourceKeys.add(planned.resourceKey);
      const resource = await this.store.getResource(planned.resourceKey);
      if (resource === null) throw new NotFoundError('Resource', planned.resourceKey);
      if (
        resource.revision !== planned.resourceRevision ||
        resource.lifecycleState !== planned.sourceState
      ) {
        throw new ConflictError(
          'operation_plan_stale',
          'Operation plan source revision or lifecycle state is stale.',
          {
            key: planned.resourceKey,
            expectedRevision: planned.resourceRevision,
            currentRevision: resource.revision,
            expectedState: planned.sourceState,
            currentState: resource.lifecycleState,
          },
        );
      }
      if (planned.sourceState !== planned.targetState) {
        validateLifecycleTransition(resource.kind, planned.sourceState, planned.targetState);
      }
      resources.push({ ...planned, resourceId: resource.id });
    }

    const positions = new Set<number>();
    for (const step of input.steps) {
      if (positions.has(step.position)) {
        throw new ValidationError(
          'duplicate_operation_step_position',
          'Operation step positions must be unique.',
        );
      }
      positions.add(step.position);
    }
    if (input.steps.some((step, index) => step.position !== index)) {
      throw new ValidationError(
        'operation_positions_invalid',
        'Operation steps and changes must use contiguous zero-based positions.',
      );
    }

    const resourceIds = new Map(
      resources.map((resource) => [resource.resourceKey, resource.resourceId]),
    );
    const resolvedChanges: PersistOperationChange[] = [];
    for (const [position, change] of changes.entries()) {
      const resourceId = resourceIds.get(change.resourceKey);
      if (resourceId === undefined) {
        throw new ValidationError(
          'operation_change_resource_missing',
          'Every operation change resource must be included in operation resources.',
          { resourceKey: change.resourceKey },
        );
      }
      let targetResourceId: string | null = null;
      if (change.action === 'relationship.create') {
        const target = await this.store.getResource(change.targetResourceKey);
        if (target === null) throw new NotFoundError('Resource', change.targetResourceKey);
        targetResourceId = target.id;
      }
      resolvedChanges.push({ change, position, resourceId, targetResourceId });
    }

    const destructive =
      input.destructive ||
      resources.some(({ targetState }) => isDestructiveLifecycleTransition(targetState));
    const plan = ensureJsonObject(
      {
        kind: input.kind,
        intent: input.intent,
        resources: input.resources,
        changes,
        steps: input.steps,
        destructive,
      },
      'operation plan',
    );
    return this.store.createOperation({
      actorId: input.actorId,
      kind: input.kind,
      plan,
      planHash: await hashPlan(plan),
      destructive,
      resources,
      changes: resolvedChanges,
      steps: input.steps,
    });
  }

  async acquireLocks(input: {
    operationId: string;
    scopes: string[];
    leaseSeconds: number;
    actorId: string;
  }): Promise<LockLease[]> {
    const operation = await this.loadOperation(input.operationId);
    if (operation.actorId !== input.actorId) {
      throw new ConflictError(
        'operation_owner_required',
        'Only the actor that created the operation may acquire its locks.',
      );
    }
    if (operation.status !== 'planned' && operation.status !== 'running') {
      throw new ConflictError(
        'operation_not_lockable',
        'Only planned or running operations may acquire locks.',
      );
    }
    const scopes = [...new Set(input.scopes)].sort();
    if (scopes.length === 0) {
      throw new ValidationError('lock_scopes_required', 'At least one lock scope is required.');
    }
    if (scopes.length > MAX_LOCK_SCOPES) {
      throw new ValidationError(
        'lock_scopes_limit',
        `An operation may lease at most ${MAX_LOCK_SCOPES} scopes at once.`,
      );
    }
    const plannedScopes = new Set(
      (await this.store.getOperationDetail(operation.id))?.resources.map(
        (resource) => `resource/${resource.resourceKey}`,
      ),
    );
    const unplannedScope = scopes.find((scope) => !plannedScopes.has(scope));
    if (unplannedScope !== undefined) {
      throw new ConflictError(
        'lock_scope_not_planned',
        'Every requested lock scope must belong to the operation plan.',
        { scope: unplannedScope },
      );
    }
    if (input.leaseSeconds < 30 || input.leaseSeconds > 3600) {
      throw new ValidationError(
        'invalid_lock_lease',
        'Lease duration must be between 30 and 3600 seconds.',
      );
    }
    return this.store.acquireLocks({
      operationId: operation.id,
      scopes,
      leaseSeconds: input.leaseSeconds,
      actorId: input.actorId,
    });
  }

  async renewLocks(input: {
    operationId: string;
    scopes: string[];
    leaseSeconds: number;
    actorId: string;
  }): Promise<LockLease[]> {
    const operation = await this.loadOperation(input.operationId);
    if (operation.actorId !== input.actorId) {
      throw new ConflictError(
        'operation_owner_required',
        'Only the actor that created the operation may renew its locks.',
      );
    }
    if (operation.status !== 'planned' && operation.status !== 'running') {
      throw new ConflictError(
        'operation_not_lockable',
        'Only planned or running operations may renew locks.',
      );
    }
    const scopes = [...new Set(input.scopes)].sort();
    if (scopes.length === 0 || scopes.length > MAX_LOCK_SCOPES) {
      throw new ValidationError('lock_scopes_limit', 'The requested lock scope set is invalid.');
    }
    if (input.leaseSeconds < 30 || input.leaseSeconds > 3600) {
      throw new ValidationError(
        'invalid_lock_lease',
        'Lease duration must be between 30 and 3600 seconds.',
      );
    }
    const plannedScopes = new Set(
      (await this.store.getOperationDetail(operation.id))?.resources.map(
        (resource) => `resource/${resource.resourceKey}`,
      ),
    );
    const unplannedScope = scopes.find((scope) => !plannedScopes.has(scope));
    if (unplannedScope !== undefined) {
      throw new ConflictError(
        'lock_scope_not_planned',
        'Every requested lock scope must belong to the operation plan.',
        { scope: unplannedScope },
      );
    }
    return this.store.renewLocks({ ...input, scopes });
  }

  async releaseLocks(input: {
    operationId: string;
    scopes: string[];
    actorId: string;
  }): Promise<void> {
    const operation = await this.loadOperation(input.operationId);
    if (operation.actorId !== input.actorId) {
      throw new ConflictError(
        'operation_owner_required',
        'Only the actor that created the operation may release its locks.',
      );
    }
    const scopes = [...new Set(input.scopes)].sort();
    if (scopes.length === 0 || scopes.length > MAX_LOCK_SCOPES) {
      throw new ValidationError('lock_scopes_limit', 'The requested lock scope set is invalid.');
    }
    return this.store.releaseLocks({ ...input, scopes });
  }

  async transition(input: {
    key: string;
    targetState: ResourceLifecycleState;
    expectedRevision: number;
    operationId: string;
    fencingToken: number;
    actorId: string;
  }): Promise<Resource> {
    const resource = await this.store.getResource(input.key);
    if (resource === null) throw new NotFoundError('Resource', input.key);
    if (resource.revision !== input.expectedRevision) {
      throw new ConflictError('revision_conflict', 'Resource revision is stale.', {
        key: input.key,
        expectedRevision: input.expectedRevision,
        currentRevision: resource.revision,
      });
    }
    validateLifecycleTransition(resource.kind, resource.lifecycleState, input.targetState);
    const detail = await this.store.getOperationDetail(input.operationId);
    if (detail === null) throw new NotFoundError('Operation', input.operationId);
    if (detail.operation.status !== 'running') {
      throw new ConflictError(
        'operation_not_running',
        'Lifecycle transitions require a running operation.',
        { operationId: input.operationId, status: detail.operation.status },
      );
    }
    const planned = detail.resources.some(
      (entry) =>
        entry.resourceKey === resource.key &&
        entry.resourceRevision === input.expectedRevision &&
        entry.sourceState === resource.lifecycleState &&
        entry.targetState === input.targetState,
    );
    if (!planned) {
      throw new ConflictError(
        'operation_plan_mismatch',
        'The lifecycle transition is not part of the operation plan.',
        { operationId: input.operationId, resourceKey: input.key },
      );
    }
    return this.store.transition({
      ...input,
      resourceId: resource.id,
      sourceState: resource.lifecycleState,
    });
  }

  async updateStatus(input: {
    id: string;
    targetStatus: OperationStatus;
    expectedRevision: number;
    lockScope: string;
    fencingToken: number;
    actorId: string;
  }): Promise<Operation> {
    const operation = await this.loadOperation(input.id);
    if (operation.revision !== input.expectedRevision) {
      throw new ConflictError('revision_conflict', 'Operation revision is stale.', {
        id: input.id,
        expectedRevision: input.expectedRevision,
        currentRevision: operation.revision,
      });
    }
    if (!OPERATION_STATUS_TRANSITIONS[operation.status].includes(input.targetStatus)) {
      throw new ConflictError(
        'operation_status_conflict',
        'Operation status transition is not permitted.',
        { from: operation.status, to: input.targetStatus },
      );
    }
    return this.store.updateOperationStatus({
      ...input,
      sourceStatus: operation.status,
    });
  }

  async complete(input: CompleteOperationCommand): Promise<Operation> {
    const operation = await this.loadOperation(input.id);
    if (operation.revision !== input.expectedRevision) {
      throw new ConflictError('revision_conflict', 'Operation revision is stale.', {
        id: input.id,
        expectedRevision: input.expectedRevision,
        currentRevision: operation.revision,
      });
    }
    if (operation.status !== 'running') {
      throw new ConflictError(
        'operation_status_conflict',
        'Only a running operation can be completed.',
        { from: operation.status, to: 'succeeded' },
      );
    }
    return this.store.completeOperation(input);
  }

  async updateStep(input: {
    operationId: string;
    stepId: string;
    status: OperationStep['status'];
    evidence: JsonObject;
    expectedRevision: number;
    lockScope: string;
    fencingToken: number;
    actorId: string;
  }): Promise<OperationStep> {
    const detail = await this.store.getOperationDetail(input.operationId);
    if (detail === null) throw new NotFoundError('Operation', input.operationId);
    if (detail.operation.status !== 'running') {
      throw new ConflictError(
        'operation_not_running',
        'Operation steps can change only while the operation is running.',
        { operationId: input.operationId, currentStatus: detail.operation.status },
      );
    }
    const step = detail.steps.find((entry) => entry.id === input.stepId);
    if (step === undefined) throw new NotFoundError('Operation step', input.stepId);
    if (step.revision !== input.expectedRevision) {
      throw new ConflictError('revision_conflict', 'Operation step revision is stale.', {
        id: input.stepId,
        expectedRevision: input.expectedRevision,
        currentRevision: step.revision,
      });
    }
    if (!STEP_STATUS_TRANSITIONS[step.status].includes(input.status)) {
      throw new ConflictError(
        'operation_step_status_conflict',
        'Operation step status transition is not permitted.',
        { from: step.status, to: input.status },
      );
    }
    return this.store.updateOperationStep({
      ...input,
      sourceStatus: step.status,
    });
  }

  private async loadOperation(id: string): Promise<Operation> {
    const operation = await this.store.getOperation(id);
    if (operation === null) throw new NotFoundError('Operation', id);
    return operation;
  }
}
