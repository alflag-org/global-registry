import type {
  ChangeOperationStatusCommand,
  ChangeOperationStepCommand,
  CompleteOperationCommand,
  OperationDetail,
  PersistOperationCommand,
  TransitionResourceCommand,
} from '../../application/operations';
import type {
  OutboxClaimResult,
  OutboxDispatchMessage,
  ResourceDetailQuery,
} from '../../application/ports';
import type {
  Actor,
  AuditEvent,
  CreateResource,
  Drift,
  ExportRecord,
  Health,
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
  UpdateResource,
} from '../../domain/models/global-registry';
import { D1Resources, type ResourceDetail } from './resources';
import { D1Providers, type CreateProviderInput, type UpdateProviderInput } from './providers';
import { D1Profiles, type CreateProfileInput, type ProfileSummary } from './profiles';
import { D1Policies, type CreatePolicyInput, type PolicySummary } from './policies';
import { D1Bindings, type RemoveBindingInput, type ReplaceBindingInput } from './bindings';
import {
  type CreateRelationshipInput,
  D1Relationships,
  type RemoveRelationshipInput,
} from './relationships';
import { D1Operations } from './operations';
import { D1Events } from './events';
import { D1Actors, type CreateActorInput, type UpdateActorInput } from './actors';
import {
  type CreateDriftInput,
  type CreateObservationInput,
  D1Observations,
  type ExpiredObservation,
  type PutHealthInput,
  type UpdateDriftInput,
} from './observations';
import { D1Exports } from './exports';

export class D1GlobalRegistryRepository {
  private readonly resources: D1Resources;
  private readonly providers: D1Providers;
  private readonly profiles: D1Profiles;
  private readonly policies: D1Policies;
  private readonly bindings: D1Bindings;
  private readonly relationships: D1Relationships;
  private readonly operations: D1Operations;
  private readonly events: D1Events;
  private readonly actors: D1Actors;
  private readonly observations: D1Observations;
  private readonly exports: D1Exports;

  constructor(db: D1Database) {
    this.resources = new D1Resources(db);
    this.providers = new D1Providers(db);
    this.profiles = new D1Profiles(db);
    this.policies = new D1Policies(db);
    this.bindings = new D1Bindings(db, this.resources, this.providers);
    this.relationships = new D1Relationships(db, this.resources);
    this.operations = new D1Operations(db, this.resources);
    this.events = new D1Events(db);
    this.actors = new D1Actors(db);
    this.observations = new D1Observations(db, this.resources);
    this.exports = new D1Exports(db);
  }

  async getActorByIdentity(identity: string): Promise<Actor | null> {
    return this.actors.getByIdentity(identity);
  }

  async getActor(id: string): Promise<Actor | null> {
    return this.actors.get(id);
  }

  async listActors(limit?: number): Promise<Actor[]> {
    return this.actors.list(limit);
  }

  async createActor(input: CreateActorInput): Promise<Actor> {
    return this.actors.create(input);
  }

  async updateActor(input: UpdateActorInput): Promise<Actor> {
    return this.actors.update(input);
  }

  async getResource(key: string): Promise<Resource | null> {
    return this.resources.get(key);
  }

  async getResourceById(id: string): Promise<Resource | null> {
    return this.resources.getById(id);
  }

  async listResources(query: ResourceQuery = {}): Promise<Resource[]> {
    return this.resources.list(query);
  }

  async getResourceDetail(
    key: string,
    query?: ResourceDetailQuery,
  ): Promise<ResourceDetail | null> {
    return this.resources.getDetail(key, query);
  }

  async createResource(input: CreateResource): Promise<Resource> {
    return this.resources.create(input);
  }

  async updateResource(input: UpdateResource): Promise<Resource> {
    return this.resources.update(input);
  }

  async getProvider(id: string): Promise<Provider | null> {
    return this.providers.get(id);
  }

  async listProviders(limit?: number): Promise<Provider[]> {
    return this.providers.list(limit);
  }

  async listBindingsForProvider(
    providerId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{
    items: Array<{ binding: ProviderBinding; resource: Resource }>;
    nextCursor?: string;
  }> {
    return this.providers.listBindings(providerId, cursor, limit);
  }

  async createProvider(input: CreateProviderInput): Promise<Provider> {
    return this.providers.create(input);
  }

  async updateProvider(input: UpdateProviderInput): Promise<Provider> {
    return this.providers.update(input);
  }

  async createProfileVersion(input: CreateProfileInput): Promise<ProfileVersion> {
    return this.profiles.createVersion(input);
  }

  async getProfileVersion(key: string, version: number): Promise<ProfileVersion | null> {
    return this.profiles.getVersion(key, version);
  }

  async getProfileSummary(key: string): Promise<ProfileSummary | null> {
    return this.profiles.getSummary(key);
  }

  async updateProfileStatus(input: {
    key: string;
    status: ProfileVersion['parentStatus'];
    expectedRevision: number;
    actorId: string;
  }): Promise<ProfileSummary> {
    return this.profiles.updateStatus(input);
  }

  async listProfiles(limit?: number): Promise<ProfileSummary[]> {
    return this.profiles.list(limit);
  }

  async createPolicyVersion(input: CreatePolicyInput): Promise<PolicyVersion> {
    return this.policies.createVersion(input);
  }

  async getPolicyVersion(
    namespace: string,
    key: string,
    version: number,
  ): Promise<PolicyVersion | null> {
    return this.policies.getVersion(namespace, key, version);
  }

  async getPolicySummary(namespace: string, key: string): Promise<PolicySummary | null> {
    return this.policies.getSummary(namespace, key);
  }

  async updatePolicyStatus(input: {
    namespace: string;
    key: string;
    status: PolicyVersion['parentStatus'];
    expectedRevision: number;
    actorId: string;
  }): Promise<PolicySummary> {
    return this.policies.updateStatus(input);
  }

  async listPolicies(limit?: number): Promise<PolicySummary[]> {
    return this.policies.list(limit);
  }

  async getBinding(resourceKey: string): Promise<ProviderBinding | null> {
    return this.bindings.get(resourceKey);
  }

  async replaceBinding(input: ReplaceBindingInput): Promise<ProviderBinding> {
    return this.bindings.replace(input);
  }

  async removeBinding(input: RemoveBindingInput): Promise<void> {
    await this.bindings.remove(input);
  }

  async getRelationship(id: string): Promise<ResourceRelationship | null> {
    return this.relationships.get(id);
  }

  async createRelationship(input: CreateRelationshipInput): Promise<ResourceRelationship> {
    return this.relationships.create(input);
  }

  async removeRelationship(input: RemoveRelationshipInput): Promise<void> {
    await this.relationships.remove(input);
  }

  async getHealth(resourceKey: string): Promise<Health | null> {
    return this.observations.getHealth(resourceKey);
  }

  async putHealth(input: PutHealthInput): Promise<Health> {
    return this.observations.putHealth(input);
  }

  async createObservation(input: CreateObservationInput): Promise<Observation> {
    return this.observations.create(input);
  }

  async listExpiredObservations(referenceTime: string, limit = 100): Promise<ExpiredObservation[]> {
    return this.observations.listExpired(referenceTime, limit);
  }

  async markObservationArchived(input: {
    id: string;
    resourceKey: string;
    r2ObjectKey: string;
    actorId: string;
  }): Promise<boolean> {
    return this.observations.markArchived(input);
  }

  async createDrift(input: CreateDriftInput): Promise<Drift> {
    return this.observations.createDrift(input);
  }

  async getDrift(id: string): Promise<Drift | null> {
    return this.observations.getDrift(id);
  }

  async updateDrift(input: UpdateDriftInput): Promise<Drift> {
    return this.observations.updateDrift(input);
  }

  async listDrifts(status?: Drift['status'], limit?: number): Promise<Drift[]> {
    return this.observations.listDrifts(status, limit);
  }

  async createOperation(input: PersistOperationCommand): Promise<Operation> {
    return this.operations.create(input);
  }

  async getOperation(id: string): Promise<Operation | null> {
    return this.operations.get(id);
  }

  async getOperationDetail(id: string): Promise<OperationDetail | null> {
    return this.operations.getDetail(id);
  }

  async listOperations(status?: OperationStatus, limit?: number): Promise<Operation[]> {
    return this.operations.list(status, limit);
  }

  async acquireLocks(input: {
    operationId: string;
    scopes: string[];
    leaseSeconds: number;
    actorId: string;
  }): Promise<LockLease[]> {
    return this.operations.acquireLocks(input);
  }

  async renewLocks(input: {
    operationId: string;
    scopes: string[];
    leaseSeconds: number;
    actorId: string;
  }): Promise<LockLease[]> {
    return this.operations.renewLocks(input);
  }

  async releaseLocks(input: {
    operationId: string;
    scopes: string[];
    actorId: string;
  }): Promise<void> {
    await this.operations.releaseLocks(input);
  }

  async transition(input: TransitionResourceCommand): Promise<Resource> {
    return this.operations.transition(input);
  }

  async completeOperation(input: CompleteOperationCommand): Promise<Operation> {
    return this.operations.complete(input);
  }

  async updateOperationStatus(input: ChangeOperationStatusCommand): Promise<Operation> {
    return this.operations.updateStatus(input);
  }

  async updateOperationStep(input: ChangeOperationStepCommand): Promise<OperationStep> {
    return this.operations.updateStep(input);
  }

  async listResourceEvents(resourceKey: string, limit?: number): Promise<AuditEvent[]> {
    return this.events.listForResource(resourceKey, limit);
  }

  async listOperationEvents(operationId: string, limit?: number): Promise<AuditEvent[]> {
    return this.events.listForOperation(operationId, limit);
  }

  async listEvents(limit = 100): Promise<AuditEvent[]> {
    return this.events.list(limit);
  }

  async createExport(actorId: string): Promise<ExportRecord> {
    return this.exports.create(actorId);
  }

  async createScheduledExport(actorId: string, day: string): Promise<ExportRecord> {
    return this.exports.createScheduled(actorId, day);
  }

  async getExport(id: string): Promise<ExportRecord | null> {
    return this.exports.get(id);
  }

  async listRetainableExports(referenceTime: string, limit?: number): Promise<ExportRecord[]> {
    return this.exports.listRetainable(referenceTime, limit);
  }

  async markExportExpired(id: string, actorId: string): Promise<boolean> {
    return this.exports.markExpired(id, actorId);
  }

  async dispatchPendingOutbox(queue: Queue<OutboxDispatchMessage>): Promise<void> {
    await this.events.dispatchPendingOutbox(queue);
  }

  async claimOutboxEvent(eventId: string, dispatchToken: string): Promise<OutboxClaimResult> {
    return this.events.claimOutboxEvent(eventId, dispatchToken);
  }

  async getOutboxEventStatus(
    eventId: string,
  ): Promise<'pending' | 'dispatching' | 'published' | 'failed' | null> {
    return this.events.getOutboxEventStatus(eventId);
  }

  async completeOutboxEvent(eventId: string, dispatchToken: string): Promise<void> {
    await this.events.completeOutboxEvent(eventId, dispatchToken);
  }

  async releaseOutboxEvent(eventId: string, dispatchToken: string, message: string): Promise<void> {
    await this.events.releaseOutboxEvent(eventId, dispatchToken, message);
  }

  async claimExport(
    id: string,
    claimedAt?: string,
  ): Promise<{
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
  } | null> {
    return this.exports.claim(id, claimedAt);
  }

  async completeExport(input: {
    exportId: string;
    revision: number;
    checksum: string;
    objectKey: string;
    claimToken: string;
  }): Promise<void> {
    await this.exports.complete(input);
  }

  async failExport(input: {
    exportId: string;
    revision: number;
    claimToken: string;
    errorCode: string;
  }): Promise<void> {
    await this.exports.fail(input);
  }

  async buildPortableSnapshot() {
    return this.exports.buildPortableSnapshot();
  }
}
