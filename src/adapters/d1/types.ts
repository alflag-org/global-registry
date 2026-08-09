import type {
  ActorRole,
  DriftStatus,
  HealthStatus,
  OperationStatus,
  ResourceKind,
  ResourceLifecycleState,
  RelationshipType,
} from '../../domain/models/global-registry';

export interface ActorRow {
  id: string;
  identity: string;
  display_name: string;
  role: ActorRole;
  active: number;
  revision: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
}

export interface ResourceRow {
  id: string;
  key: string;
  kind: ResourceKind;
  name: string;
  profile_key: string | null;
  profile_version: number | null;
  policy_namespace: string | null;
  policy_key: string | null;
  policy_version: number | null;
  placement_json: string;
  spec_overrides_json: string;
  effective_spec_json: string;
  lifecycle_state: ResourceLifecycleState;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ProviderRow {
  id: string;
  driver: string;
  credential_ref: string;
  status: 'active' | 'disabled' | 'retired';
  capabilities_json: string;
  mappings_json: string;
  binding_revision: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ProfileRow {
  key: string;
  resource_kind: ResourceKind;
  status: 'active' | 'deprecated' | 'retired';
  current_version: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ProfileVersionRow {
  profile_key: string;
  version: number;
  spec_json: string;
  created_at: string;
  created_by: string;
}

export interface PolicyRow {
  namespace: string;
  key: string;
  status: 'active' | 'deprecated' | 'retired';
  current_version: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface PolicyVersionRow {
  namespace: string;
  policy_key: string;
  version: number;
  resource_kind: ResourceKind;
  spec_json: string;
  created_at: string;
  created_by: string;
}

export interface BindingRow {
  resource_id: string;
  provider_id: string;
  provider_resource_type: string;
  provider_resource_id: string;
  provider_resource_name: string | null;
  locator_json: string;
  active: number;
  bound_at: string;
  bound_by: string;
}

export interface BindingHistoryRow {
  id: string;
  resource_id: string;
  provider_id: string;
  provider_resource_type: string;
  provider_resource_id: string;
  provider_resource_name: string | null;
  locator_json: string;
  bound_at: string;
  unbound_at: string;
  bound_by: string;
  unbound_by: string;
  operation_id: string | null;
}

export interface RelationshipRow {
  id: string;
  source_resource_id: string;
  target_resource_id: string;
  relationship_type: RelationshipType;
  revision: number;
  created_at: string;
  created_by: string;
}

export interface RelationshipHistoryRow {
  id: string;
  relationship_id: string;
  source_resource_id: string;
  target_resource_id: string;
  relationship_type: RelationshipType;
  relationship_revision: number;
  created_at: string;
  created_by: string;
  removed_at: string;
  removed_by: string;
  operation_id: string;
}

export interface HealthRow {
  resource_id: string;
  status: HealthStatus;
  reason: string | null;
  observed_at: string;
  observed_by: string;
  revision: number;
  updated_at: string;
}

export interface ObservationRow {
  id: string;
  resource_id: string;
  observer_id: string;
  observed_at: string;
  facts_json: string;
  expires_at: string;
  archived_at: string | null;
  r2_object_key: string | null;
  created_at: string;
}

export interface DriftRow {
  id: string;
  resource_id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: DriftStatus;
  fingerprint: string;
  expected_json: string;
  observed_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  resolved_at: string | null;
}

export interface OperationRow {
  id: string;
  actor_id: string;
  kind: string;
  status: OperationStatus;
  plan_json: string;
  plan_hash: string;
  destructive: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface OperationResourceRow {
  operation_id: string;
  resource_id: string;
  resource_key: string;
  source_state: ResourceLifecycleState;
  target_state: ResourceLifecycleState;
  resource_revision: number;
}

export interface OperationChangeRow {
  operation_id: string;
  position: number;
  action: 'binding.replace' | 'binding.remove' | 'relationship.create' | 'relationship.remove';
  resource_id: string;
  provider_id: string | null;
  provider_resource_type: string | null;
  provider_resource_id: string | null;
  relationship_id: string | null;
  target_resource_id: string | null;
  relationship_type: RelationshipType | null;
}

export interface OperationStepRow {
  id: string;
  operation_id: string;
  position: number;
  name: string;
  status: 'planned' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'skipped';
  gate_json: string;
  evidence_json: string;
  revision: number;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface LockRow {
  scope: string;
  operation_id: string;
  actor_id: string;
  fencing_token: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface LockGenerationRow {
  scope: string;
  generation: number;
}

export interface EventRow {
  event_id: string;
  event_type: string;
  resource_key: string | null;
  operation_id: string | null;
  actor_id: string;
  payload_json: string;
  occurred_at: string;
}

export interface OutboxRow {
  id: string;
  event_id: string;
  topic: string;
  payload_json: string;
  status: 'pending' | 'dispatching' | 'published' | 'failed';
  consumer_attempts: number;
  producer_attempts: number;
  created_at: string;
  published_at: string | null;
  last_error: string | null;
  revision: number;
  updated_at: string;
  dispatch_token: string | null;
}

export interface ExportRow {
  id: string;
  schema_version: string;
  checksum: string | null;
  r2_object_key: string | null;
  claim_token: string | null;
  claim_object_key: string | null;
  r2_claim_token: string | null;
  status: 'planned' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  lease_until: string | null;
  revision: number;
  created_at: string;
  completed_at: string | null;
  requested_by: string;
  error_message: string | null;
  expired_at: string | null;
  updated_at: string;
}
