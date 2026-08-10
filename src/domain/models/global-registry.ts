export const STANDARD_RESOURCE_KINDS = [
  'location',
  'network',
  'compute',
  'volume',
  'service_cluster',
  'service_instance',
  'endpoint',
  'backup_repository',
] as const;

export type StandardResourceKind = (typeof STANDARD_RESOURCE_KINDS)[number];
export type ResourceKind = string;

export const STANDARD_RESOURCE_LIFECYCLE_STATES = [
  'absent',
  'allocated',
  'bootstrapped',
  'configured',
  'initialized',
  'integrated',
  'ready',
  'serving',
  'draining',
  'offline',
  'stopped',
  'retired',
] as const;

export type ResourceLifecycleState = string;

export const RESOURCE_SPECIFICATION_MODES = ['standard', 'opaque'] as const;
export type ResourceSpecificationMode = (typeof RESOURCE_SPECIFICATION_MODES)[number];

export const RESOURCE_PLACEMENT_MODES = ['root', 'located'] as const;
export type ResourcePlacementMode = (typeof RESOURCE_PLACEMENT_MODES)[number];

export const ACTOR_ROLES = [
  'admin',
  'provisioner',
  'observer',
  'validator',
  'operator',
  'readonly',
] as const;

export type ActorRole = (typeof ACTOR_ROLES)[number];

export const HEALTH_STATUSES = ['unknown', 'healthy', 'degraded', 'unhealthy'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const DRIFT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type DriftStatus = (typeof DRIFT_STATUSES)[number];

export const DRIFT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
type DriftSeverity = (typeof DRIFT_SEVERITIES)[number];

export const OPERATION_STATUSES = [
  'planned',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const OPERATION_STEP_STATUSES = [
  'planned',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'skipped',
] as const;
type OperationStepStatus = (typeof OPERATION_STEP_STATUSES)[number];

export const RELATIONSHIP_TYPES = [
  'member_of',
  'hosted_on',
  'uses_network',
  'uses_volume',
  'exposes_endpoint',
  'depends_on',
  'backed_up_to',
  'replacement_for',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface VersionedReference {
  key: string;
  version: number;
}

export interface PolicyReference extends VersionedReference {
  namespace: string;
}

export interface Resource {
  id: string;
  key: string;
  kind: ResourceKind;
  kindVersion: number;
  name: string;
  profile?: VersionedReference;
  policy?: PolicyReference;
  placement: JsonObject;
  specOverrides: JsonObject;
  spec: JsonObject;
  lifecycleState: ResourceLifecycleState;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Provider {
  id: string;
  driver: string;
  credentialRef: string;
  status: 'active' | 'disabled' | 'retired';
  capabilities: JsonObject;
  configuration: JsonObject;
  mappings: JsonObject;
  bindingRevision: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export const VERSION_PARENT_STATUSES = ['active', 'deprecated', 'retired'] as const;
export type VersionParentStatus = (typeof VERSION_PARENT_STATUSES)[number];

export interface ResourceLifecycleTransition {
  from: ResourceLifecycleState;
  to: ResourceLifecycleState;
  destructive: boolean;
}

export interface ResourceKindRelationshipRule {
  relationshipType: RelationshipType;
  targetKinds: readonly string[];
}

export interface ResourceKindDefinitionVersion {
  key: ResourceKind;
  version: number;
  states: readonly ResourceLifecycleState[];
  initialState: ResourceLifecycleState;
  terminalStates: readonly ResourceLifecycleState[];
  transitions: readonly ResourceLifecycleTransition[];
  placementMode: ResourcePlacementMode;
  specificationMode: ResourceSpecificationMode;
  relationshipRules: readonly ResourceKindRelationshipRule[];
  parentStatus: VersionParentStatus;
  revision: number;
  createdAt: string;
  createdBy?: string;
}

export interface ProfileVersion {
  key: string;
  version: number;
  resourceKind: ResourceKind;
  resourceKindVersion: number;
  spec: JsonObject;
  parentStatus: VersionParentStatus;
  revision: number;
  createdAt: string;
}

export interface PolicyVersion {
  namespace: string;
  key: string;
  version: number;
  resourceKind: ResourceKind;
  resourceKindVersion: number;
  spec: JsonObject;
  parentStatus: VersionParentStatus;
  revision: number;
  createdAt: string;
}

export interface Actor {
  id: string;
  identity: string;
  displayName: string;
  role: ActorRole;
  active: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderBinding {
  resourceId: string;
  providerId: string;
  providerResourceType: string;
  providerResourceId: string;
  providerResourceName?: string;
  locator: JsonObject;
  boundAt: string;
  boundBy: string;
}

export interface ResourceRelationship {
  id: string;
  sourceResourceId: string;
  targetResourceId: string;
  relationshipType: RelationshipType;
  revision: number;
  createdAt: string;
  createdBy: string;
}

export interface Health {
  resourceId: string;
  status: HealthStatus;
  reason?: string;
  observedAt: string;
  observedBy: string;
  revision: number;
  updatedAt: string;
}

export interface Observation {
  id: string;
  resourceId: string;
  observerId: string;
  observedAt: string;
  facts: JsonObject;
  expiresAt: string;
  archivedAt?: string;
  r2ObjectKey?: string;
  createdAt: string;
}

export interface Drift {
  id: string;
  resourceId: string;
  severity: DriftSeverity;
  status: DriftStatus;
  expected: JsonObject;
  observed: JsonObject;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  resolvedAt?: string;
}

export interface OperationStep {
  id: string;
  operationId: string;
  position: number;
  name: string;
  status: OperationStepStatus;
  gate: JsonObject;
  evidence: JsonObject;
  revision: number;
  startedAt?: string;
  completedAt?: string;
}

export interface Operation {
  id: string;
  actorId: string;
  kind: string;
  status: OperationStatus;
  plan: JsonObject;
  planHash: string;
  destructive: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface LockLease {
  scope: string;
  operationId: string;
  fencingToken: number;
  expiresAt: string;
}

export interface AuditEvent {
  eventId: string;
  eventType: string;
  resourceKey?: string;
  operationId?: string;
  actorId: string;
  payload: JsonObject;
  occurredAt: string;
}

export const EXPORT_STATUSES = ['planned', 'running', 'succeeded', 'failed'] as const;
type ExportStatus = (typeof EXPORT_STATUSES)[number];

export interface ExportRecord {
  id: string;
  schemaVersion: string;
  checksum?: string;
  r2ObjectKey?: string;
  status: ExportStatus;
  attempts: number;
  leaseUntil?: string;
  revision: number;
  createdAt: string;
  completedAt?: string;
  requestedBy: string;
  errorMessage?: string;
  expiredAt?: string;
}

export interface CreateResource {
  actorId: string;
  key: string;
  kind: ResourceKind;
  kindVersion: number;
  initialState: ResourceLifecycleState;
  name: string;
  placement: JsonObject;
  specOverrides: JsonObject;
  spec: JsonObject;
  profile?: VersionedReference;
  policy?: PolicyReference;
  profileGuard?: ParentReferenceGuard;
  policyGuard?: ParentReferenceGuard;
}

export interface UpdateResource {
  actorId: string;
  key: string;
  name: string;
  placement: JsonObject;
  specOverrides: JsonObject;
  spec: JsonObject;
  profile: VersionedReference | null;
  policy: PolicyReference | null;
  profileGuard?: ParentReferenceGuard;
  policyGuard?: ParentReferenceGuard;
  boundProviderGuard?: BoundProviderGuard;
  expectedRevision: number;
}

interface ParentReferenceGuard {
  expectedRevision: number;
  expectedStatus: VersionParentStatus;
}

interface BoundProviderGuard {
  providerId: string;
  expectedRevision: number;
}

export interface OperationStepPlan {
  position: number;
  name: string;
  gate: JsonObject;
  evidence?: JsonObject;
}

export interface ResourceQuery {
  kind?: ResourceKind;
  lifecycleState?: ResourceLifecycleState;
  limit?: number;
  cursor?: string;
}
