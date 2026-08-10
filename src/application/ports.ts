import type { CreateActorCommand, UpdateActorCommand } from '../domain/actor/schemas';
export {
  MAX_EXPORT_ATTEMPTS,
  MAX_EXPORT_RETENTION_AGE_DAYS,
  MAX_EXPORT_RETENTION_WORK,
  MAX_OBSERVATION_ARCHIVE_WORK,
  MAX_OUTBOX_CONSUMER_ATTEMPTS,
  MAX_OUTBOX_DISPATCH_WORK,
  MAX_OUTBOX_PRODUCER_ATTEMPTS,
  MAX_PORTABLE_EXPORT_BYTES,
  MAX_PORTABLE_EXPORT_ROWS_PER_TABLE,
  MAX_PORTABLE_EXPORT_TOTAL_ROWS,
  PORTABLE_EXPORT_QUERY_LIMIT,
  PORTABLE_EXPORT_SCHEMA_VERSION,
} from './limits';
export type { ProfileSummary } from './profiles';
export type { PolicySummary } from './policies';
import type { ProfileSummary } from './profiles';
import type { PolicySummary } from './policies';
import type { CreateResource, UpdateResource } from '../domain/models/global-registry';
export { assertValidRegistrySnapshot } from './registry-validation';
export { serializePortableSnapshot } from './registry-snapshot';
export type { PortableRegistrySnapshot } from './registry-snapshot';
import type { PortableRegistrySnapshot } from './registry-snapshot';
import type {
  ChangeOperationStatusCommand,
  ChangeOperationStepCommand,
  CompleteOperationCommand,
  OperationDetail,
  PersistOperationCommand,
  TransitionResourceCommand,
} from './operations';
import type {
  Actor,
  AuditEvent,
  Drift,
  ExportRecord,
  Health,
  HealthStatus,
  JsonObject,
  LockLease,
  Observation,
  Operation,
  OperationStatus,
  OperationStep,
  PolicyVersion,
  Provider,
  ProviderBinding,
  ProfileVersion,
  Resource,
  ResourceQuery,
  ResourceRelationship,
} from '../domain/models/global-registry';

export type CreateActorInput = CreateActorCommand & { id?: string };
export type UpdateActorInput = UpdateActorCommand;

export interface CreateProviderInput {
  id: string;
  driver: string;
  credentialRef: string;
  status: Provider['status'];
  capabilities: JsonObject;
  mappings: JsonObject;
  actorId: string;
}

export interface UpdateProviderInput {
  id: string;
  expectedRevision: number;
  expectedBindingRevision: number;
  expectedBoundResourceCount: number;
  actorId: string;
  driver?: string;
  credentialRef?: string;
  status?: Provider['status'];
  capabilities?: JsonObject;
  mappings?: JsonObject;
  expectedBoundResources: Array<{ id: string; key: string; revision: number }>;
}

export interface CreateProfileInput {
  key: string;
  resourceKind: Resource['kind'];
  spec: JsonObject;
  actorId: string;
  expectedRevision?: number;
}

export interface CreatePolicyInput {
  namespace: string;
  key: string;
  resourceKind: Resource['kind'];
  spec: JsonObject;
  actorId: string;
  expectedRevision?: number;
}

export interface ReplaceBindingInput {
  resourceKey: string;
  providerId: string;
  providerResourceType: string;
  providerResourceId: string;
  providerResourceName?: string;
  locator: JsonObject;
  expectedRevision: number;
  expectedProviderRevision: number;
  expectedProviderBindingRevision: number;
  operationId: string;
  fencingToken: number;
  actorId: string;
}

export interface RemoveBindingInput {
  resourceKey: string;
  expectedRevision: number;
  operationId: string;
  fencingToken: number;
  actorId: string;
}

export interface CreateRelationshipInput {
  sourceKey: string;
  targetKey: string;
  relationshipType: ResourceRelationship['relationshipType'];
  expectedRevision: number;
  operationId: string;
  fencingToken: number;
  actorId: string;
}

export interface RemoveRelationshipInput {
  id: string;
  expectedRevision: number;
  operationId: string;
  fencingToken: number;
  actorId: string;
}

export interface PutHealthInput {
  resourceKey: string;
  status: HealthStatus;
  reason?: string;
  observedAt: string;
  expectedRevision: number;
  actorId: string;
}

export interface CreateObservationInput {
  resourceKey: string;
  observedAt: string;
  facts: JsonObject;
  retentionHours: number;
  actorId: string;
}

export interface CreateDriftInput {
  resourceKey: string;
  severity: Drift['severity'];
  expected: JsonObject;
  observed: JsonObject;
  actorId: string;
}

export interface UpdateDriftInput {
  id: string;
  status: Drift['status'];
  expectedRevision: number;
  actorId: string;
}

export interface ExpiredObservation {
  id: string;
  resourceId: string;
  resourceKey: string;
  observerId: string;
  observedAt: string;
  facts: JsonObject;
  expiresAt: string;
  createdAt: string;
}

export interface ResourceDetail {
  resource: Resource;
  binding: ProviderBinding | null;
  health: Health | null;
  relationships: ResourceRelationship[];
  drifts: Drift[];
  relationshipsNextCursor?: string;
  driftsNextCursor?: string;
}

export interface ResourceDetailQuery {
  relationshipCursor?: string;
  driftCursor?: string;
  relationshipLimit?: number;
  driftLimit?: number;
}

export interface OutboxDispatchMessage {
  eventId: string;
  dispatchToken: string;
}

export type OutboxClaimResult =
  | {
      kind: 'claimed';
      eventId: string;
      eventType: string;
      payload: JsonObject;
    }
  | { kind: 'stale' }
  | { kind: 'busy' };

export interface ProviderBindingPage {
  items: Array<{ binding: ProviderBinding; resource: Resource }>;
  nextCursor?: string;
}

export interface ExportAttempt {
  exportId: string;
  revision: number;
  attempt: number;
  objectKey: string;
  claimToken: string;
  supersededClaim?: {
    revision: number;
    objectKey: string;
    claimToken: string;
  };
  recovery: boolean;
}

export interface ExportPersistencePort {
  getExport(id: string): Promise<ExportRecord | null>;
  claimExport(id: string, now?: string): Promise<ExportAttempt | null>;
  buildPortableSnapshot(): Promise<PortableRegistrySnapshot>;
  completeExport(input: {
    exportId: string;
    revision: number;
    checksum: string;
    objectKey: string;
    claimToken: string;
  }): Promise<void>;
  failExport(input: {
    exportId: string;
    revision: number;
    claimToken: string;
    errorCode: string;
  }): Promise<void>;
  listRetainableExports(referenceTime: string, limit?: number): Promise<ExportRecord[]>;
  markExportExpired(id: string, actorId: string): Promise<boolean>;
}

export interface ObservationArchivePersistencePort {
  listExpiredObservations(referenceTime: string, limit?: number): Promise<ExpiredObservation[]>;
  markObservationArchived(input: {
    id: string;
    resourceKey: string;
    r2ObjectKey: string;
    actorId: string;
  }): Promise<boolean>;
}

export interface OutboxPersistencePort {
  getOutboxEventStatus(
    eventId: string,
  ): Promise<'pending' | 'dispatching' | 'published' | 'failed' | null>;
  claimOutboxEvent(eventId: string, dispatchToken: string): Promise<OutboxClaimResult>;
  completeOutboxEvent(eventId: string, dispatchToken: string): Promise<void>;
  releaseOutboxEvent(eventId: string, dispatchToken: string, errorCode: string): Promise<void>;
}

/** Application-facing persistence contract. Adapters implement this port. */
export interface RegistryRepository {
  getActorByIdentity(identity: string): Promise<Actor | null>;
  getActor(id: string): Promise<Actor | null>;
  listActors(limit?: number): Promise<Actor[]>;
  createActor(input: CreateActorInput): Promise<Actor>;
  updateActor(input: UpdateActorInput): Promise<Actor>;

  getResource(key: string): Promise<Resource | null>;
  getResourceById(id: string): Promise<Resource | null>;
  listResources(query?: ResourceQuery): Promise<Resource[]>;
  getResourceDetail(key: string, query?: ResourceDetailQuery): Promise<ResourceDetail | null>;
  createResource(input: CreateResource): Promise<Resource>;
  updateResource(input: UpdateResource): Promise<Resource>;

  getProvider(id: string): Promise<Provider | null>;
  listProviders(limit?: number): Promise<Provider[]>;
  listBindingsForProvider(
    providerId: string,
    cursor?: string,
    limit?: number,
  ): Promise<ProviderBindingPage>;
  createProvider(input: CreateProviderInput): Promise<Provider>;
  updateProvider(input: UpdateProviderInput): Promise<Provider>;

  createProfileVersion(input: CreateProfileInput): Promise<ProfileVersion>;
  getProfileVersion(key: string, version: number): Promise<ProfileVersion | null>;
  getProfileSummary(key: string): Promise<ProfileSummary | null>;
  updateProfileStatus(input: {
    key: string;
    status: ProfileVersion['parentStatus'];
    expectedRevision: number;
    actorId: string;
  }): Promise<ProfileSummary>;
  listProfiles(limit?: number): Promise<ProfileSummary[]>;

  createPolicyVersion(input: CreatePolicyInput): Promise<PolicyVersion>;
  getPolicyVersion(namespace: string, key: string, version: number): Promise<PolicyVersion | null>;
  getPolicySummary(namespace: string, key: string): Promise<PolicySummary | null>;
  updatePolicyStatus(input: {
    namespace: string;
    key: string;
    status: PolicyVersion['parentStatus'];
    expectedRevision: number;
    actorId: string;
  }): Promise<PolicySummary>;
  listPolicies(limit?: number): Promise<PolicySummary[]>;

  getBinding(resourceKey: string): Promise<ProviderBinding | null>;
  replaceBinding(input: ReplaceBindingInput): Promise<ProviderBinding>;
  removeBinding(input: RemoveBindingInput): Promise<void>;

  getRelationship(id: string): Promise<ResourceRelationship | null>;
  createRelationship(input: CreateRelationshipInput): Promise<ResourceRelationship>;
  removeRelationship(input: RemoveRelationshipInput): Promise<void>;

  getHealth(resourceKey: string): Promise<Health | null>;
  putHealth(input: PutHealthInput): Promise<Health>;
  createObservation(input: CreateObservationInput): Promise<Observation>;
  listExpiredObservations(referenceTime: string, limit?: number): Promise<ExpiredObservation[]>;
  markObservationArchived(input: {
    id: string;
    resourceKey: string;
    r2ObjectKey: string;
    actorId: string;
  }): Promise<boolean>;
  createDrift(input: CreateDriftInput): Promise<Drift>;
  getDrift(id: string): Promise<Drift | null>;
  updateDrift(input: UpdateDriftInput): Promise<Drift>;
  listDrifts(status?: Drift['status'], limit?: number): Promise<Drift[]>;

  createOperation(input: PersistOperationCommand): Promise<Operation>;
  getOperation(id: string): Promise<Operation | null>;
  getOperationDetail(id: string): Promise<OperationDetail | null>;
  listOperations(status?: OperationStatus, limit?: number): Promise<Operation[]>;
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

  listResourceEvents(resourceKey: string, limit?: number): Promise<AuditEvent[]>;
  listOperationEvents(operationId: string, limit?: number): Promise<AuditEvent[]>;
  listEvents(limit?: number): Promise<AuditEvent[]>;

  createExport(actorId: string): Promise<ExportRecord>;
  getExport(id: string): Promise<ExportRecord | null>;
}
