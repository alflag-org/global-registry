import { parseJsonObject } from '../../domain/models/json';
import type {
  Actor,
  AuditEvent,
  Drift,
  ExportRecord,
  Health,
  Operation,
  OperationStep,
  Provider,
  ProviderBinding,
  Resource,
  ResourceRelationship,
} from '../../domain/models/global-registry';
import type {
  ActorRow,
  BindingRow,
  DriftRow,
  EventRow,
  ExportRow,
  HealthRow,
  OperationRow,
  OperationStepRow,
  ProviderRow,
  RelationshipRow,
  ResourceRow,
} from './types';

function optional<T>(key: string, value: T | null): Record<string, T> {
  return value === null ? {} : { [key]: value };
}

export function mapActor(row: ActorRow): Actor {
  return {
    id: row.id,
    identity: row.identity,
    displayName: row.display_name,
    role: row.role,
    active: row.active === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapResource(row: ResourceRow): Resource {
  const profile =
    row.profile_key === null || row.profile_version === null
      ? null
      : { key: row.profile_key, version: row.profile_version };
  const policy =
    row.policy_namespace === null || row.policy_key === null || row.policy_version === null
      ? null
      : {
          namespace: row.policy_namespace,
          key: row.policy_key,
          version: row.policy_version,
        };
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    name: row.name,
    ...optional('profile', profile),
    ...optional('policy', policy),
    placement: parseJsonObject(row.placement_json, 'resource placement'),
    specOverrides: parseJsonObject(row.spec_overrides_json, 'resource spec overrides'),
    spec: parseJsonObject(row.effective_spec_json, 'resource effective spec'),
    lifecycleState: row.lifecycle_state,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    driver: row.driver,
    credentialRef: row.credential_ref,
    status: row.status,
    capabilities: parseJsonObject(row.capabilities_json, 'provider capabilities'),
    configuration: parseJsonObject(row.configuration_json, 'provider configuration'),
    mappings: parseJsonObject(row.mappings_json, 'provider mappings'),
    bindingRevision: row.binding_revision,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapBinding(row: BindingRow): ProviderBinding {
  return {
    resourceId: row.resource_id,
    providerId: row.provider_id,
    providerResourceType: row.provider_resource_type,
    providerResourceId: row.provider_resource_id,
    ...optional('providerResourceName', row.provider_resource_name),
    locator: parseJsonObject(row.locator_json, 'binding locator'),
    boundAt: row.bound_at,
    boundBy: row.bound_by,
  };
}

export function mapRelationship(row: RelationshipRow): ResourceRelationship {
  return {
    id: row.id,
    sourceResourceId: row.source_resource_id,
    targetResourceId: row.target_resource_id,
    relationshipType: row.relationship_type,
    revision: row.revision,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export function mapHealth(row: HealthRow): Health {
  return {
    resourceId: row.resource_id,
    status: row.status,
    ...optional('reason', row.reason),
    observedAt: row.observed_at,
    observedBy: row.observed_by,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export function mapDrift(row: DriftRow): Drift {
  return {
    id: row.id,
    resourceId: row.resource_id,
    severity: row.severity,
    status: row.status,
    expected: parseJsonObject(row.expected_json, 'drift expected state'),
    observed: parseJsonObject(row.observed_json, 'drift observed state'),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    ...optional('resolvedAt', row.resolved_at),
  };
}

export function mapOperation(row: OperationRow): Operation {
  return {
    id: row.id,
    actorId: row.actor_id,
    kind: row.kind,
    status: row.status,
    plan: parseJsonObject(row.plan_json, 'operation plan'),
    planHash: row.plan_hash,
    destructive: row.destructive === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapOperationStep(row: OperationStepRow): OperationStep {
  return {
    id: row.id,
    operationId: row.operation_id,
    position: row.position,
    name: row.name,
    status: row.status,
    gate: parseJsonObject(row.gate_json, 'operation step gate'),
    evidence: parseJsonObject(row.evidence_json, 'operation step evidence'),
    revision: row.revision,
    ...optional('startedAt', row.started_at),
    ...optional('completedAt', row.completed_at),
  };
}

export function mapEvent(row: EventRow): AuditEvent {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    ...optional('resourceKey', row.resource_key),
    ...optional('operationId', row.operation_id),
    actorId: row.actor_id,
    payload: parseJsonObject(row.payload_json, 'event payload'),
    occurredAt: row.occurred_at,
  };
}

export function mapExport(row: ExportRow): ExportRecord {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    ...optional('checksum', row.checksum),
    ...optional('r2ObjectKey', row.r2_object_key),
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    attempts: row.attempts,
    ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }),
    ...optional('completedAt', row.completed_at),
    requestedBy: row.requested_by,
    ...optional('errorMessage', row.error_message),
    ...optional('expiredAt', row.expired_at),
  };
}
