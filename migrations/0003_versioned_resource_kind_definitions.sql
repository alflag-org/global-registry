-- Resource ontology becomes data: immutable definition versions own lifecycle,
-- placement, relationship, and specification-validation behavior.
PRAGMA defer_foreign_keys = TRUE;

DROP TRIGGER providers_retirement_requires_no_bindings;

ALTER TABLE resource_relationships RENAME TO resource_relationships_legacy_0003;
ALTER TABLE provider_bindings RENAME TO provider_bindings_legacy_0003;
ALTER TABLE provider_binding_history RENAME TO provider_binding_history_legacy_0003;
ALTER TABLE health RENAME TO health_legacy_0003;
ALTER TABLE observations RENAME TO observations_legacy_0003;
ALTER TABLE drifts RENAME TO drifts_legacy_0003;
ALTER TABLE operation_resources RENAME TO operation_resources_legacy_0003;
ALTER TABLE operation_changes RENAME TO operation_changes_legacy_0003;
ALTER TABLE resource_relationship_history RENAME TO resource_relationship_history_legacy_0003;
ALTER TABLE resources RENAME TO resources_legacy_0003;
ALTER TABLE profile_versions RENAME TO profile_versions_legacy_0003;
ALTER TABLE profiles RENAME TO profiles_legacy_0003;
ALTER TABLE policy_versions RENAME TO policy_versions_legacy_0003;

CREATE TABLE resource_kind_definitions (
  key TEXT PRIMARY KEY CHECK (
    key = lower(key)
    AND length(key) BETWEEN 1 AND 128
    AND key NOT GLOB '*[^a-z0-9._-]*'
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'retired')),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE resource_kind_definition_versions (
  kind_key TEXT NOT NULL REFERENCES resource_kind_definitions(key) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  states_json TEXT NOT NULL CHECK (
    json_valid(states_json) AND json_type(states_json) = 'array'
  ),
  initial_state TEXT NOT NULL CHECK (length(initial_state) BETWEEN 1 AND 128),
  terminal_states_json TEXT NOT NULL CHECK (
    json_valid(terminal_states_json) AND json_type(terminal_states_json) = 'array'
  ),
  transitions_json TEXT NOT NULL CHECK (
    json_valid(transitions_json) AND json_type(transitions_json) = 'array'
  ),
  placement_mode TEXT NOT NULL CHECK (placement_mode IN ('root', 'located')),
  specification_mode TEXT NOT NULL CHECK (specification_mode IN ('standard', 'opaque')),
  relationship_rules_json TEXT NOT NULL CHECK (
    json_valid(relationship_rules_json) AND json_type(relationship_rules_json) = 'array'
  ),
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES actors(id) ON DELETE RESTRICT,
  PRIMARY KEY (kind_key, version)
);

INSERT INTO resource_kind_definitions (
  key, status, current_version, revision, created_at, updated_at
) VALUES
  ('location', 'active', 1, 1, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'),
  ('network', 'active', 1, 1, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'),
  ('compute', 'active', 1, 1, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'),
  ('volume', 'active', 1, 1, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'),
  ('service_cluster', 'active', 1, 1, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'),
  ('service_instance', 'active', 1, 1, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'),
  ('endpoint', 'active', 1, 1, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'),
  ('backup_repository', 'active', 1, 1, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');

INSERT INTO resource_kind_definition_versions (
  kind_key, version, states_json, initial_state, terminal_states_json,
  transitions_json, placement_mode, specification_mode,
  relationship_rules_json, created_at, created_by
) VALUES
  (
    'location', 1,
    '["absent","ready","retired"]', 'absent', '["retired"]',
    '[{"from":"absent","to":"ready","destructive":false},{"from":"ready","to":"retired","destructive":true}]',
    'root', 'standard',
    '[{"relationshipType":"depends_on","targetKinds":["location"]},{"relationshipType":"replacement_for","targetKinds":["location"]}]',
    '2026-08-10T00:00:00.000Z', NULL
  ),
  (
    'network', 1,
    '["absent","ready","retired"]', 'absent', '["retired"]',
    '[{"from":"absent","to":"ready","destructive":false},{"from":"ready","to":"retired","destructive":true}]',
    'located', 'standard',
    '[{"relationshipType":"depends_on","targetKinds":["network"]},{"relationshipType":"replacement_for","targetKinds":["network"]}]',
    '2026-08-10T00:00:00.000Z', NULL
  ),
  (
    'compute', 1,
    '["absent","allocated","bootstrapped","configured","ready","stopped","retired"]',
    'absent', '["retired"]',
    '[{"from":"absent","to":"allocated","destructive":false},{"from":"allocated","to":"bootstrapped","destructive":false},{"from":"bootstrapped","to":"configured","destructive":false},{"from":"configured","to":"ready","destructive":false},{"from":"ready","to":"stopped","destructive":false},{"from":"stopped","to":"ready","destructive":false},{"from":"stopped","to":"retired","destructive":true}]',
    'located', 'standard',
    '[{"relationshipType":"uses_network","targetKinds":["network"]},{"relationshipType":"uses_volume","targetKinds":["volume"]},{"relationshipType":"backed_up_to","targetKinds":["backup_repository"]},{"relationshipType":"depends_on","targetKinds":["compute"]},{"relationshipType":"replacement_for","targetKinds":["compute"]}]',
    '2026-08-10T00:00:00.000Z', NULL
  ),
  (
    'volume', 1,
    '["absent","ready","retired"]', 'absent', '["retired"]',
    '[{"from":"absent","to":"ready","destructive":false},{"from":"ready","to":"retired","destructive":true}]',
    'located', 'standard',
    '[{"relationshipType":"depends_on","targetKinds":["volume"]},{"relationshipType":"replacement_for","targetKinds":["volume"]}]',
    '2026-08-10T00:00:00.000Z', NULL
  ),
  (
    'service_cluster', 1,
    '["absent","configured","initialized","integrated","ready","serving","draining","offline","stopped","retired"]',
    'absent', '["retired"]',
    '[{"from":"absent","to":"configured","destructive":false},{"from":"configured","to":"initialized","destructive":false},{"from":"initialized","to":"integrated","destructive":false},{"from":"integrated","to":"ready","destructive":false},{"from":"ready","to":"serving","destructive":false},{"from":"serving","to":"draining","destructive":false},{"from":"draining","to":"offline","destructive":false},{"from":"offline","to":"ready","destructive":false},{"from":"offline","to":"stopped","destructive":false},{"from":"stopped","to":"ready","destructive":false},{"from":"stopped","to":"retired","destructive":true}]',
    'located', 'standard',
    '[{"relationshipType":"depends_on","targetKinds":["service_cluster"]},{"relationshipType":"replacement_for","targetKinds":["service_cluster"]}]',
    '2026-08-10T00:00:00.000Z', NULL
  ),
  (
    'service_instance', 1,
    '["absent","configured","initialized","integrated","ready","serving","draining","offline","stopped","retired"]',
    'absent', '["retired"]',
    '[{"from":"absent","to":"configured","destructive":false},{"from":"configured","to":"initialized","destructive":false},{"from":"initialized","to":"integrated","destructive":false},{"from":"integrated","to":"ready","destructive":false},{"from":"ready","to":"serving","destructive":false},{"from":"serving","to":"draining","destructive":false},{"from":"draining","to":"offline","destructive":false},{"from":"offline","to":"ready","destructive":false},{"from":"offline","to":"stopped","destructive":false},{"from":"stopped","to":"ready","destructive":false},{"from":"stopped","to":"retired","destructive":true}]',
    'located', 'standard',
    '[{"relationshipType":"member_of","targetKinds":["service_cluster"]},{"relationshipType":"hosted_on","targetKinds":["compute"]},{"relationshipType":"exposes_endpoint","targetKinds":["endpoint"]},{"relationshipType":"depends_on","targetKinds":["service_instance"]},{"relationshipType":"replacement_for","targetKinds":["service_instance"]}]',
    '2026-08-10T00:00:00.000Z', NULL
  ),
  (
    'endpoint', 1,
    '["absent","configured","ready","serving","offline","retired"]',
    'absent', '["retired"]',
    '[{"from":"absent","to":"configured","destructive":false},{"from":"configured","to":"ready","destructive":false},{"from":"ready","to":"serving","destructive":false},{"from":"serving","to":"offline","destructive":false},{"from":"offline","to":"ready","destructive":false},{"from":"offline","to":"retired","destructive":true}]',
    'located', 'standard',
    '[{"relationshipType":"depends_on","targetKinds":["endpoint"]},{"relationshipType":"replacement_for","targetKinds":["endpoint"]}]',
    '2026-08-10T00:00:00.000Z', NULL
  ),
  (
    'backup_repository', 1,
    '["absent","ready","retired"]', 'absent', '["retired"]',
    '[{"from":"absent","to":"ready","destructive":false},{"from":"ready","to":"retired","destructive":true}]',
    'located', 'standard',
    '[{"relationshipType":"depends_on","targetKinds":["backup_repository"]},{"relationshipType":"replacement_for","targetKinds":["backup_repository"]}]',
    '2026-08-10T00:00:00.000Z', NULL
  );

CREATE TABLE profiles (
  key TEXT PRIMARY KEY,
  resource_kind TEXT NOT NULL,
  resource_kind_version INTEGER NOT NULL DEFAULT 1 CHECK (resource_kind_version > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'retired')),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (resource_kind, resource_kind_version)
    REFERENCES resource_kind_definition_versions(kind_key, version) ON DELETE RESTRICT
);

CREATE TABLE profile_versions (
  profile_key TEXT NOT NULL REFERENCES profiles(key) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json) AND json_type(spec_json) = 'object'),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  PRIMARY KEY (profile_key, version)
);

CREATE TABLE policy_versions (
  namespace TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  resource_kind TEXT NOT NULL,
  resource_kind_version INTEGER NOT NULL DEFAULT 1 CHECK (resource_kind_version > 0),
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json) AND json_type(spec_json) = 'object'),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  PRIMARY KEY (namespace, policy_key, version),
  FOREIGN KEY (namespace, policy_key) REFERENCES policies(namespace, key) ON DELETE RESTRICT,
  FOREIGN KEY (resource_kind, resource_kind_version)
    REFERENCES resource_kind_definition_versions(kind_key, version) ON DELETE RESTRICT
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE CHECK (key = lower(key) AND length(key) BETWEEN 1 AND 128),
  kind TEXT NOT NULL,
  kind_version INTEGER NOT NULL DEFAULT 1 CHECK (kind_version > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 256),
  profile_key TEXT,
  profile_version INTEGER,
  policy_namespace TEXT,
  policy_key TEXT,
  policy_version INTEGER,
  placement_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(placement_json) AND json_type(placement_json) = 'object'),
  spec_overrides_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(spec_overrides_json) AND json_type(spec_overrides_json) = 'object'),
  effective_spec_json TEXT NOT NULL CHECK (json_valid(effective_spec_json) AND json_type(effective_spec_json) = 'object'),
  lifecycle_state TEXT NOT NULL DEFAULT 'absent' CHECK (length(lifecycle_state) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((profile_key IS NULL AND profile_version IS NULL) OR (profile_key IS NOT NULL AND profile_version IS NOT NULL)),
  CHECK ((policy_namespace IS NULL AND policy_key IS NULL AND policy_version IS NULL) OR (
    policy_namespace IS NOT NULL AND policy_key IS NOT NULL AND policy_version IS NOT NULL
  )),
  FOREIGN KEY (kind, kind_version)
    REFERENCES resource_kind_definition_versions(kind_key, version) ON DELETE RESTRICT,
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

CREATE TABLE operation_resources (
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  source_state TEXT NOT NULL CHECK (length(source_state) BETWEEN 1 AND 128),
  target_state TEXT NOT NULL CHECK (length(target_state) BETWEEN 1 AND 128),
  resource_revision INTEGER NOT NULL CHECK (resource_revision > 0),
  PRIMARY KEY (operation_id, resource_id)
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

INSERT INTO profiles (
  key, resource_kind, resource_kind_version, status, current_version,
  revision, created_at, updated_at
)
SELECT key, resource_kind, 1, status, current_version, revision, created_at, updated_at
FROM profiles_legacy_0003;

INSERT INTO profile_versions (
  profile_key, version, spec_json, created_at, created_by
)
SELECT profile_key, version, spec_json, created_at, created_by
FROM profile_versions_legacy_0003;

INSERT INTO policy_versions (
  namespace, policy_key, version, resource_kind, resource_kind_version,
  spec_json, created_at, created_by
)
SELECT namespace, policy_key, version, resource_kind, 1, spec_json, created_at, created_by
FROM policy_versions_legacy_0003;

INSERT INTO resources (
  id, key, kind, kind_version, name, profile_key, profile_version,
  policy_namespace, policy_key, policy_version, placement_json,
  spec_overrides_json, effective_spec_json, lifecycle_state, revision,
  created_at, updated_at
)
SELECT
  id, key, kind, 1, name, profile_key, profile_version,
  policy_namespace, policy_key, policy_version, placement_json,
  spec_overrides_json, effective_spec_json, lifecycle_state, revision,
  created_at, updated_at
FROM resources_legacy_0003;

INSERT INTO resource_relationships
SELECT * FROM resource_relationships_legacy_0003;

INSERT INTO provider_bindings
SELECT * FROM provider_bindings_legacy_0003;

INSERT INTO provider_binding_history
SELECT * FROM provider_binding_history_legacy_0003;

INSERT INTO health
SELECT * FROM health_legacy_0003;

INSERT INTO observations
SELECT * FROM observations_legacy_0003;

INSERT INTO drifts
SELECT * FROM drifts_legacy_0003;

INSERT INTO operation_resources
SELECT * FROM operation_resources_legacy_0003;

INSERT INTO operation_changes
SELECT * FROM operation_changes_legacy_0003;

INSERT INTO resource_relationship_history
SELECT * FROM resource_relationship_history_legacy_0003;

DROP TABLE resource_relationships_legacy_0003;
DROP TABLE provider_bindings_legacy_0003;
DROP TABLE provider_binding_history_legacy_0003;
DROP TABLE health_legacy_0003;
DROP TABLE observations_legacy_0003;
DROP TABLE drifts_legacy_0003;
DROP TABLE operation_resources_legacy_0003;
DROP TABLE operation_changes_legacy_0003;
DROP TABLE resource_relationship_history_legacy_0003;
DROP TABLE resources_legacy_0003;
DROP TABLE profile_versions_legacy_0003;
DROP TABLE profiles_legacy_0003;
DROP TABLE policy_versions_legacy_0003;

CREATE INDEX idx_resource_kind_definitions_status
ON resource_kind_definitions(status, key);
CREATE INDEX idx_resources_kind ON resources(kind, kind_version);
CREATE INDEX idx_resources_lifecycle ON resources(lifecycle_state);
CREATE INDEX idx_relationships_source ON resource_relationships(source_resource_id);
CREATE INDEX idx_relationships_target ON resource_relationships(target_resource_id);
CREATE INDEX idx_relationship_history_relationship
ON resource_relationship_history(relationship_id, removed_at);
CREATE INDEX idx_bindings_provider ON provider_bindings(provider_id);
CREATE INDEX idx_observations_resource_expires ON observations(resource_id, expires_at);
CREATE INDEX idx_observations_retention
ON observations(expires_at, id) WHERE archived_at IS NULL;
CREATE INDEX idx_drifts_resource_status ON drifts(resource_id, status);
CREATE UNIQUE INDEX idx_drifts_active_fingerprint
ON drifts(resource_id, fingerprint) WHERE status <> 'resolved';
CREATE INDEX idx_operation_changes_resource ON operation_changes(resource_id, operation_id);

CREATE TRIGGER resource_kind_definitions_retirement_is_terminal
BEFORE UPDATE OF status ON resource_kind_definitions
WHEN OLD.status = 'retired' AND NEW.status <> 'retired'
BEGIN
  SELECT RAISE(ABORT, 'retired resource kind definition status is terminal');
END;

CREATE TRIGGER resource_kind_definitions_key_immutable
BEFORE UPDATE OF key ON resource_kind_definitions
BEGIN
  SELECT RAISE(ABORT, 'resource kind definition key is immutable');
END;

CREATE TRIGGER resource_kind_definitions_no_hard_delete
BEFORE DELETE ON resource_kind_definitions
BEGIN
  SELECT RAISE(ABORT, 'resource kind definitions must be retired, not deleted');
END;

CREATE TRIGGER resource_kind_definition_versions_append_only_update
BEFORE UPDATE ON resource_kind_definition_versions
BEGIN
  SELECT RAISE(ABORT, 'resource kind definition versions are immutable');
END;

CREATE TRIGGER resource_kind_definition_versions_append_only_delete
BEFORE DELETE ON resource_kind_definition_versions
BEGIN
  SELECT RAISE(ABORT, 'resource kind definition versions are immutable');
END;

CREATE TRIGGER profiles_retirement_is_terminal
BEFORE UPDATE OF status ON profiles
WHEN OLD.status = 'retired' AND NEW.status <> 'retired'
BEGIN
  SELECT RAISE(ABORT, 'retired profile status is terminal');
END;

CREATE TRIGGER resources_key_immutable
BEFORE UPDATE OF key ON resources
BEGIN
  SELECT RAISE(ABORT, 'resource key is immutable');
END;

CREATE TRIGGER resources_no_hard_delete
BEFORE DELETE ON resources
BEGIN
  SELECT RAISE(ABORT, 'resources cannot be hard deleted');
END;

CREATE TRIGGER profiles_no_hard_delete
BEFORE DELETE ON profiles
BEGIN
  SELECT RAISE(ABORT, 'profiles must be retired, not deleted');
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
  SELECT RAISE(ABORT, 'relationship history is append-only');
END;

CREATE TRIGGER resource_relationship_history_append_only_delete
BEFORE DELETE ON resource_relationship_history
BEGIN
  SELECT RAISE(ABORT, 'relationship history is append-only');
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

CREATE TRIGGER providers_retirement_requires_no_bindings
BEFORE UPDATE OF status ON providers
WHEN NEW.status = 'retired' AND OLD.status <> 'retired'
  AND EXISTS (SELECT 1 FROM provider_bindings WHERE provider_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'provider with active bindings cannot be retired');
END;

PRAGMA defer_foreign_keys = FALSE;
