-- This is the complete initial schema. D1's own migration ledger is managed by
-- Wrangler; the application does not maintain a second schema-migration table.

CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 256),
  role TEXT NOT NULL CHECK (role IN ('admin', 'provisioner', 'observer', 'validator', 'operator', 'readonly')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT
);

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  driver TEXT NOT NULL CHECK (driver IN ('proxmox', 'cloudflare', 'aws', 'gcp')),
  credential_ref TEXT NOT NULL CHECK (
    length(credential_ref) BETWEEN 1 AND 128
    AND substr(credential_ref, 1, 1) GLOB '[A-Z]'
    AND credential_ref NOT GLOB '*[^A-Z0-9_]*'
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'retired')),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json) AND json_type(capabilities_json) = 'object'),
  mappings_json TEXT NOT NULL CHECK (json_valid(mappings_json) AND json_type(mappings_json) = 'object'),
  binding_revision INTEGER NOT NULL DEFAULT 0 CHECK (binding_revision >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE profiles (
  key TEXT PRIMARY KEY,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'location', 'network', 'compute', 'volume', 'service_cluster',
    'service_instance', 'endpoint', 'backup_repository'
  )),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'retired')),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE profile_versions (
  profile_key TEXT NOT NULL REFERENCES profiles(key) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json) AND json_type(spec_json) = 'object'),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  PRIMARY KEY (profile_key, version)
);

CREATE TABLE policies (
  namespace TEXT NOT NULL CHECK (length(trim(namespace)) BETWEEN 1 AND 128),
  key TEXT NOT NULL CHECK (length(trim(key)) BETWEEN 1 AND 128),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'retired')),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
);

CREATE TABLE policy_versions (
  namespace TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'location', 'network', 'compute', 'volume', 'service_cluster',
    'service_instance', 'endpoint', 'backup_repository'
  )),
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json) AND json_type(spec_json) = 'object'),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  PRIMARY KEY (namespace, policy_key, version),
  FOREIGN KEY (namespace, policy_key) REFERENCES policies(namespace, key) ON DELETE RESTRICT
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE CHECK (key = lower(key) AND length(key) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (kind IN (
    'location', 'network', 'compute', 'volume', 'service_cluster',
    'service_instance', 'endpoint', 'backup_repository'
  )),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 256),
  profile_key TEXT,
  profile_version INTEGER,
  policy_namespace TEXT,
  policy_key TEXT,
  policy_version INTEGER,
  placement_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(placement_json) AND json_type(placement_json) = 'object'),
  spec_overrides_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(spec_overrides_json) AND json_type(spec_overrides_json) = 'object'),
  effective_spec_json TEXT NOT NULL CHECK (json_valid(effective_spec_json) AND json_type(effective_spec_json) = 'object'),
  lifecycle_state TEXT NOT NULL DEFAULT 'absent' CHECK (lifecycle_state IN (
    'absent', 'allocated', 'bootstrapped', 'configured', 'ready',
    'initialized', 'integrated', 'serving', 'draining', 'offline',
    'stopped', 'retired'
  )),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((profile_key IS NULL AND profile_version IS NULL) OR (profile_key IS NOT NULL AND profile_version IS NOT NULL)),
  CHECK ((policy_namespace IS NULL AND policy_key IS NULL AND policy_version IS NULL) OR (
    policy_namespace IS NOT NULL AND policy_key IS NOT NULL AND policy_version IS NOT NULL
  )),
  FOREIGN KEY (profile_key, profile_version) REFERENCES profile_versions(profile_key, version),
  FOREIGN KEY (policy_namespace, policy_key, policy_version)
    REFERENCES policy_versions(namespace, policy_key, version)
);

CREATE TABLE resource_relationships (
  id TEXT PRIMARY KEY,
  source_resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  target_resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN (
    'member_of', 'hosted_on', 'uses_network', 'uses_volume',
    'exposes_endpoint', 'depends_on', 'backed_up_to', 'replacement_for'
  )),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  CHECK (source_resource_id <> target_resource_id),
  UNIQUE (source_resource_id, target_resource_id, relationship_type)
);

CREATE TABLE provider_bindings (
  resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE RESTRICT,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  provider_resource_type TEXT NOT NULL CHECK (length(trim(provider_resource_type)) BETWEEN 1 AND 128),
  provider_resource_id TEXT NOT NULL CHECK (length(trim(provider_resource_id)) BETWEEN 1 AND 256),
  provider_resource_name TEXT CHECK (provider_resource_name IS NULL OR length(trim(provider_resource_name)) BETWEEN 1 AND 256),
  locator_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(locator_json) AND json_type(locator_json) = 'object'),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active = 1),
  bound_at TEXT NOT NULL,
  bound_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  UNIQUE (provider_id, provider_resource_type, provider_resource_id)
);

CREATE TABLE provider_binding_history (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  provider_resource_type TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  provider_resource_name TEXT,
  locator_json TEXT NOT NULL CHECK (json_valid(locator_json) AND json_type(locator_json) = 'object'),
  bound_at TEXT NOT NULL,
  unbound_at TEXT NOT NULL,
  bound_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  unbound_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT
);

CREATE TABLE health (
  resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('unknown', 'healthy', 'degraded', 'unhealthy')),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 512),
  observed_at TEXT NOT NULL,
  observed_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  observer_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL,
  facts_json TEXT NOT NULL CHECK (json_valid(facts_json) AND json_type(facts_json) = 'object'),
  expires_at TEXT NOT NULL,
  archived_at TEXT,
  r2_object_key TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE drifts (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 71
    AND substr(fingerprint, 1, 7) = 'sha256:'
    AND substr(fingerprint, 8) NOT GLOB '*[^a-f0-9]*'
  ),
  expected_json TEXT NOT NULL CHECK (json_valid(expected_json) AND json_type(expected_json) = 'object'),
  observed_json TEXT NOT NULL CHECK (json_valid(observed_json) AND json_type(observed_json) = 'object'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  resolved_at TEXT,
  CHECK ((status = 'resolved' AND resolved_at IS NOT NULL) OR (status <> 'resolved' AND resolved_at IS NULL))
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (length(trim(kind)) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'succeeded', 'failed', 'blocked', 'cancelled')),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json) AND json_type(plan_json) = 'object'),
  plan_hash TEXT NOT NULL CHECK (
    length(plan_hash) = 71
    AND substr(plan_hash, 1, 7) = 'sha256:'
    AND substr(plan_hash, 8) NOT GLOB '*[^a-f0-9]*'
  ),
  destructive INTEGER NOT NULL DEFAULT 0 CHECK (destructive IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE operation_resources (
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  source_state TEXT NOT NULL CHECK (source_state IN (
    'absent', 'allocated', 'bootstrapped', 'configured', 'ready',
    'initialized', 'integrated', 'serving', 'draining', 'offline', 'stopped', 'retired'
  )),
  target_state TEXT NOT NULL CHECK (target_state IN (
    'absent', 'allocated', 'bootstrapped', 'configured', 'ready',
    'initialized', 'integrated', 'serving', 'draining', 'offline', 'stopped', 'retired'
  )),
  resource_revision INTEGER NOT NULL CHECK (resource_revision > 0),
  PRIMARY KEY (operation_id, resource_id)
);

CREATE TABLE operation_steps (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'succeeded', 'failed', 'blocked', 'skipped')),
  gate_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(gate_json) AND json_type(gate_json) = 'object'),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (operation_id, position),
  CHECK ((status IN ('succeeded', 'failed', 'blocked', 'skipped')) = (completed_at IS NOT NULL))
);

CREATE TABLE operation_changes (
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  action TEXT NOT NULL CHECK (action IN (
    'binding.replace', 'binding.remove', 'relationship.create', 'relationship.remove'
  )),
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  provider_id TEXT REFERENCES providers(id) ON DELETE RESTRICT,
  provider_resource_type TEXT,
  provider_resource_id TEXT,
  relationship_id TEXT,
  target_resource_id TEXT REFERENCES resources(id) ON DELETE RESTRICT,
  relationship_type TEXT CHECK (
    relationship_type IS NULL OR relationship_type IN (
      'member_of', 'hosted_on', 'uses_network', 'uses_volume',
      'exposes_endpoint', 'depends_on', 'backed_up_to', 'replacement_for'
    )
  ),
  PRIMARY KEY (operation_id, position),
  CHECK (
    (action = 'binding.replace' AND provider_id IS NOT NULL
      AND provider_resource_type IS NOT NULL AND provider_resource_id IS NOT NULL
      AND relationship_id IS NULL AND target_resource_id IS NULL AND relationship_type IS NULL)
    OR
    (action = 'binding.remove' AND provider_id IS NULL
      AND provider_resource_type IS NULL AND provider_resource_id IS NULL
      AND relationship_id IS NULL AND target_resource_id IS NULL AND relationship_type IS NULL)
    OR
    (action = 'relationship.create' AND provider_id IS NULL
      AND provider_resource_type IS NULL AND provider_resource_id IS NULL
      AND relationship_id IS NULL AND target_resource_id IS NOT NULL AND relationship_type IS NOT NULL)
    OR
    (action = 'relationship.remove' AND provider_id IS NULL
      AND provider_resource_type IS NULL AND provider_resource_id IS NULL
      AND relationship_id IS NOT NULL AND target_resource_id IS NULL AND relationship_type IS NULL)
  )
);

CREATE TABLE resource_relationship_history (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL,
  source_resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  target_resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN (
    'member_of', 'hosted_on', 'uses_network', 'uses_volume',
    'exposes_endpoint', 'depends_on', 'backed_up_to', 'replacement_for'
  )),
  relationship_revision INTEGER NOT NULL CHECK (relationship_revision > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  removed_at TEXT NOT NULL,
  removed_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT
);

CREATE TABLE resource_locks (
  scope TEXT PRIMARY KEY CHECK (length(trim(scope)) BETWEEN 3 AND 256),
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- This row is deliberately not deleted when the current lease is released.
-- Operations advance it before every successful grant or reacquisition.
CREATE TABLE resource_lock_generations (
  scope TEXT PRIMARY KEY CHECK (length(trim(scope)) BETWEEN 3 AND 256),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0)
);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) BETWEEN 1 AND 256),
  resource_key TEXT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  occurred_at TEXT NOT NULL
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id) ON DELETE RESTRICT,
  topic TEXT NOT NULL CHECK (length(trim(topic)) BETWEEN 1 AND 256),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatching', 'published', 'failed')),
  consumer_attempts INTEGER NOT NULL DEFAULT 0 CHECK (consumer_attempts >= 0),
  producer_attempts INTEGER NOT NULL DEFAULT 0 CHECK (producer_attempts >= 0),
  created_at TEXT NOT NULL,
  published_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  dispatch_token TEXT CHECK (dispatch_token IS NULL OR length(dispatch_token) BETWEEN 1 AND 128),
  CHECK (status <> 'dispatching' OR dispatch_token IS NOT NULL)
);

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 64),
  checksum TEXT CHECK (checksum IS NULL OR checksum GLOB 'sha256:*'),
  r2_object_key TEXT,
  claim_token TEXT CHECK (claim_token IS NULL OR length(claim_token) BETWEEN 1 AND 128),
  claim_object_key TEXT CHECK (claim_object_key IS NULL OR length(claim_object_key) BETWEEN 1 AND 512),
  r2_claim_token TEXT CHECK (r2_claim_token IS NULL OR length(r2_claim_token) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  requested_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) BETWEEN 1 AND 128),
  expired_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'running' AND claim_token IS NOT NULL AND claim_object_key IS NOT NULL)
    OR (status <> 'running' AND claim_token IS NULL AND claim_object_key IS NULL)
  ),
  CHECK (
    (r2_object_key IS NULL AND r2_claim_token IS NULL)
    OR (status = 'succeeded' AND expired_at IS NULL AND r2_object_key IS NOT NULL AND r2_claim_token IS NOT NULL)
  )
);

CREATE INDEX idx_actors_active_admin ON actors(id) WHERE role = 'admin' AND active = 1;
CREATE INDEX idx_resources_kind ON resources(kind);
CREATE INDEX idx_resources_lifecycle ON resources(lifecycle_state);
CREATE INDEX idx_relationships_source ON resource_relationships(source_resource_id);
CREATE INDEX idx_relationships_target ON resource_relationships(target_resource_id);
CREATE INDEX idx_relationship_history_relationship ON resource_relationship_history(relationship_id, removed_at);
CREATE INDEX idx_bindings_provider ON provider_bindings(provider_id);
CREATE INDEX idx_observations_resource_expires ON observations(resource_id, expires_at);
CREATE INDEX idx_observations_retention ON observations(expires_at, id) WHERE archived_at IS NULL;
CREATE INDEX idx_drifts_resource_status ON drifts(resource_id, status);
CREATE UNIQUE INDEX idx_drifts_active_fingerprint
  ON drifts(resource_id, fingerprint) WHERE status <> 'resolved';
CREATE INDEX idx_providers_status ON providers(status);
CREATE INDEX idx_operations_status ON operations(status);
CREATE INDEX idx_operation_steps_operation ON operation_steps(operation_id, position);
CREATE INDEX idx_operation_changes_resource ON operation_changes(resource_id, operation_id);
CREATE INDEX idx_events_resource_occurred ON events(resource_key, occurred_at DESC);
CREATE INDEX idx_events_operation_occurred ON events(operation_id, occurred_at DESC);
CREATE INDEX idx_outbox_pending
  ON outbox(status, dispatch_token, producer_attempts, created_at, id);
CREATE INDEX idx_outbox_stale_dispatch ON outbox(status, dispatch_token, updated_at, id);
CREATE INDEX idx_exports_retention ON exports(status, completed_at, expired_at);

CREATE TRIGGER resource_lock_generations_no_delete
BEFORE DELETE ON resource_lock_generations
BEGIN
  SELECT RAISE(ABORT, 'resource_lock_generation_delete_forbidden');
END;

CREATE TRIGGER resource_lock_generations_monotonic
BEFORE UPDATE OF generation ON resource_lock_generations
WHEN NEW.generation <= OLD.generation
BEGIN
  SELECT RAISE(ABORT, 'resource_lock_generation_must_advance');
END;

CREATE TRIGGER actors_insert_metadata_required
BEFORE INSERT ON actors
WHEN NEW.revision <> 1 OR NEW.created_by IS NULL OR NEW.updated_by IS NULL
  OR NEW.created_by <> NEW.updated_by OR NEW.created_at <> NEW.updated_at
BEGIN
  SELECT RAISE(ABORT, 'actor_insert_metadata_required');
END;

CREATE TRIGGER actors_canonical_identity_required
BEFORE INSERT ON actors
WHEN NOT (
    (NEW.identity GLOB 'access:*' OR NEW.identity GLOB 'service:*')
    AND length(NEW.identity) BETWEEN 8 AND 256
    AND length(substr(NEW.identity, instr(NEW.identity, ':') + 1)) > 0
    AND substr(NEW.identity, instr(NEW.identity, ':') + 1) =
      trim(substr(NEW.identity, instr(NEW.identity, ':') + 1))
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(0) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(1) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(2) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(3) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(4) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(5) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(6) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(7) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(8) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(9) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(10) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(11) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(12) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(13) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(14) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(15) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(16) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(17) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(18) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(19) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(20) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(21) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(22) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(23) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(24) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(25) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(26) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(27) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(28) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(29) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(30) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(31) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(127) AS BLOB)) = 0
  )
BEGIN
  SELECT RAISE(ABORT, 'actor_identity_not_canonical');
END;

CREATE TRIGGER actors_first_active_admin_required
BEFORE INSERT ON actors
WHEN NOT EXISTS (SELECT 1 FROM actors WHERE role = 'admin' AND active = 1)
  AND NOT (NEW.role = 'admin' AND NEW.active = 1)
BEGIN
  SELECT RAISE(ABORT, 'actor_active_admin_required');
END;

CREATE TRIGGER actors_immutable_fields
BEFORE UPDATE ON actors
WHEN NEW.id <> OLD.id OR NEW.identity <> OLD.identity OR NEW.created_at <> OLD.created_at
  OR NEW.created_by <> OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'actor_immutable_fields');
END;

CREATE TRIGGER actors_canonical_identity_update_required
BEFORE UPDATE OF identity ON actors
WHEN NOT (
    (NEW.identity GLOB 'access:*' OR NEW.identity GLOB 'service:*')
    AND length(NEW.identity) BETWEEN 8 AND 256
    AND length(substr(NEW.identity, instr(NEW.identity, ':') + 1)) > 0
    AND substr(NEW.identity, instr(NEW.identity, ':') + 1) =
      trim(substr(NEW.identity, instr(NEW.identity, ':') + 1))
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(0) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(1) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(2) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(3) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(4) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(5) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(6) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(7) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(8) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(9) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(10) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(11) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(12) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(13) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(14) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(15) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(16) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(17) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(18) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(19) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(20) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(21) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(22) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(23) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(24) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(25) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(26) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(27) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(28) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(29) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(30) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(31) AS BLOB)) = 0
    AND instr(CAST(NEW.identity AS BLOB), CAST(char(127) AS BLOB)) = 0
  )
BEGIN
  SELECT RAISE(ABORT, 'actor_identity_not_canonical');
END;

CREATE TRIGGER actors_update_metadata_required
BEFORE UPDATE ON actors
WHEN NEW.revision <> OLD.revision + 1 OR NEW.updated_by IS NULL
BEGIN
  SELECT RAISE(ABORT, 'actor_update_metadata_required');
END;

CREATE TRIGGER actors_self_lockout_required
BEFORE UPDATE OF role, active ON actors
WHEN OLD.role = 'admin' AND OLD.active = 1
  AND NOT (NEW.role = 'admin' AND NEW.active = 1)
  AND NEW.updated_by = OLD.id
  AND NOT EXISTS (SELECT 1 FROM actors WHERE id <> OLD.id AND role = 'admin' AND active = 1)
BEGIN
  SELECT RAISE(ABORT, 'actor_self_lockout_required');
END;

CREATE TRIGGER actors_last_active_admin_required
BEFORE UPDATE OF role, active ON actors
WHEN OLD.role = 'admin' AND OLD.active = 1
  AND NOT (NEW.role = 'admin' AND NEW.active = 1)
  AND NEW.updated_by <> OLD.id
  AND NOT EXISTS (SELECT 1 FROM actors WHERE id <> OLD.id AND role = 'admin' AND active = 1)
BEGIN
  SELECT RAISE(ABORT, 'actor_last_active_admin_required');
END;

CREATE TRIGGER actors_audit_after_insert
AFTER INSERT ON actors
BEGIN
  INSERT INTO events (event_id, event_type, actor_id, payload_json, occurred_at)
  VALUES (
    'evt_actor_' || NEW.id || '_' || NEW.revision,
    'actor.created', NEW.created_by,
    json_object(
      'actorId', NEW.id, 'identity', NEW.identity, 'displayName', NEW.display_name,
      'role', NEW.role, 'active', json(CASE WHEN NEW.active = 1 THEN 'true' ELSE 'false' END),
      'resultingRevision', NEW.revision
    ), NEW.created_at
  );
  INSERT INTO outbox (id, event_id, topic, payload_json, created_at, updated_at)
  SELECT 'out_actor_' || NEW.id || '_' || NEW.revision, event_id,
    'global-registry.actor.created', payload_json, NEW.created_at, NEW.created_at
  FROM events WHERE event_id = 'evt_actor_' || NEW.id || '_' || NEW.revision;
END;

CREATE TRIGGER actors_audit_after_update
AFTER UPDATE ON actors
BEGIN
  INSERT INTO events (event_id, event_type, actor_id, payload_json, occurred_at)
  VALUES (
    'evt_actor_' || NEW.id || '_' || NEW.revision,
    'actor.updated', NEW.updated_by,
    json_object(
      'actorId', NEW.id, 'identity', NEW.identity, 'displayName', NEW.display_name,
      'role', NEW.role, 'active', json(CASE WHEN NEW.active = 1 THEN 'true' ELSE 'false' END),
      'previousRevision', OLD.revision, 'resultingRevision', NEW.revision
    ), NEW.updated_at
  );
  INSERT INTO outbox (id, event_id, topic, payload_json, created_at, updated_at)
  SELECT 'out_actor_' || NEW.id || '_' || NEW.revision, event_id,
    'global-registry.actor.updated', payload_json, NEW.updated_at, NEW.updated_at
  FROM events WHERE event_id = 'evt_actor_' || NEW.id || '_' || NEW.revision;
END;

CREATE TRIGGER providers_retirement_requires_no_bindings
BEFORE UPDATE OF status ON providers
WHEN NEW.status = 'retired' AND OLD.status <> 'retired'
  AND EXISTS (SELECT 1 FROM provider_bindings WHERE provider_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'provider with active bindings cannot be retired');
END;

CREATE TRIGGER providers_retirement_is_terminal
BEFORE UPDATE OF status ON providers
WHEN OLD.status = 'retired' AND NEW.status <> 'retired'
BEGIN
  SELECT RAISE(ABORT, 'retired provider status is terminal');
END;

CREATE TRIGGER profiles_retirement_is_terminal
BEFORE UPDATE OF status ON profiles
WHEN OLD.status = 'retired' AND NEW.status <> 'retired'
BEGIN
  SELECT RAISE(ABORT, 'retired profile status is terminal');
END;

CREATE TRIGGER policies_retirement_is_terminal
BEFORE UPDATE OF status ON policies
WHEN OLD.status = 'retired' AND NEW.status <> 'retired'
BEGIN
  SELECT RAISE(ABORT, 'retired policy status is terminal');
END;

CREATE TRIGGER resources_key_immutable
BEFORE UPDATE OF key ON resources
WHEN OLD.key <> NEW.key
BEGIN
  SELECT RAISE(ABORT, 'resource key is immutable');
END;

CREATE TRIGGER resources_no_hard_delete
BEFORE DELETE ON resources
BEGIN
  SELECT RAISE(ABORT, 'resources must be retired, not deleted');
END;

CREATE TRIGGER providers_no_hard_delete
BEFORE DELETE ON providers
BEGIN
  SELECT RAISE(ABORT, 'providers must be retired, not deleted');
END;

CREATE TRIGGER profiles_no_hard_delete
BEFORE DELETE ON profiles
BEGIN
  SELECT RAISE(ABORT, 'profiles must be retired, not deleted');
END;

CREATE TRIGGER policies_no_hard_delete
BEFORE DELETE ON policies
BEGIN
  SELECT RAISE(ABORT, 'policies must be retired, not deleted');
END;

CREATE TRIGGER actors_no_hard_delete
BEFORE DELETE ON actors
BEGIN
  SELECT RAISE(ABORT, 'actors are authoritative history and cannot be deleted');
END;

CREATE TRIGGER operations_no_hard_delete
BEFORE DELETE ON operations
BEGIN
  SELECT RAISE(ABORT, 'operations are authoritative history and cannot be deleted');
END;

CREATE TRIGGER profile_versions_append_only_update
BEFORE UPDATE ON profile_versions
BEGIN
  SELECT RAISE(ABORT, 'profile versions are immutable');
END;

CREATE TRIGGER profile_versions_append_only_delete
BEFORE DELETE ON profile_versions
BEGIN
  SELECT RAISE(ABORT, 'profile versions are immutable');
END;

CREATE TRIGGER policy_versions_append_only_update
BEFORE UPDATE ON policy_versions
BEGIN
  SELECT RAISE(ABORT, 'policy versions are immutable');
END;

CREATE TRIGGER policy_versions_append_only_delete
BEFORE DELETE ON policy_versions
BEGIN
  SELECT RAISE(ABORT, 'policy versions are immutable');
END;

CREATE TRIGGER provider_binding_history_append_only_update
BEFORE UPDATE ON provider_binding_history
BEGIN
  SELECT RAISE(ABORT, 'provider binding history is append-only');
END;

CREATE TRIGGER provider_binding_history_append_only_delete
BEFORE DELETE ON provider_binding_history
BEGIN
  SELECT RAISE(ABORT, 'provider binding history is append-only');
END;

CREATE TRIGGER resource_relationship_history_append_only_update
BEFORE UPDATE ON resource_relationship_history
BEGIN
  SELECT RAISE(ABORT, 'resource relationship history is append-only');
END;

CREATE TRIGGER resource_relationship_history_append_only_delete
BEFORE DELETE ON resource_relationship_history
BEGIN
  SELECT RAISE(ABORT, 'resource relationship history is append-only');
END;

CREATE TRIGGER operation_plan_immutable
BEFORE UPDATE OF plan_json, plan_hash ON operations
WHEN OLD.plan_json <> NEW.plan_json OR OLD.plan_hash <> NEW.plan_hash
BEGIN
  SELECT RAISE(ABORT, 'operation plan is immutable');
END;

CREATE TRIGGER operation_resources_immutable_update
BEFORE UPDATE ON operation_resources
BEGIN
  SELECT RAISE(ABORT, 'operation resources are immutable');
END;

CREATE TRIGGER operation_resources_immutable_delete
BEFORE DELETE ON operation_resources
BEGIN
  SELECT RAISE(ABORT, 'operation resources are immutable');
END;

CREATE TRIGGER operation_changes_immutable_update
BEFORE UPDATE ON operation_changes
BEGIN
  SELECT RAISE(ABORT, 'operation changes are immutable');
END;

CREATE TRIGGER operation_changes_immutable_delete
BEFORE DELETE ON operation_changes
BEGIN
  SELECT RAISE(ABORT, 'operation changes are immutable');
END;

CREATE TRIGGER operation_steps_plan_immutable
BEFORE UPDATE OF operation_id, position, name, gate_json ON operation_steps
WHEN OLD.operation_id <> NEW.operation_id OR OLD.position <> NEW.position
  OR OLD.name <> NEW.name OR OLD.gate_json <> NEW.gate_json
BEGIN
  SELECT RAISE(ABORT, 'operation step plan is immutable');
END;

CREATE TRIGGER operation_steps_no_delete
BEFORE DELETE ON operation_steps
BEGIN
  SELECT RAISE(ABORT, 'operation steps are authoritative history and cannot be deleted');
END;

CREATE TRIGGER events_append_only_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_append_only_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
