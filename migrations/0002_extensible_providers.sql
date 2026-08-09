-- Rebuild the provider table to remove the fixed driver enumeration. D1 keeps
-- foreign keys enabled during migrations, so the three referencing tables are
-- rebuilt in the same deferred transaction and retain every existing row.
PRAGMA defer_foreign_keys = ON;
PRAGMA legacy_alter_table = ON;

ALTER TABLE provider_bindings RENAME TO provider_bindings_legacy_0002;
ALTER TABLE provider_binding_history RENAME TO provider_binding_history_legacy_0002;
ALTER TABLE operation_changes RENAME TO operation_changes_legacy_0002;
ALTER TABLE providers RENAME TO providers_legacy_0002;

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  driver TEXT NOT NULL CHECK (
    length(driver) BETWEEN 1 AND 128
    AND driver = lower(driver)
    AND substr(driver, 1, 1) GLOB '[a-z0-9]'
    AND substr(driver, -1, 1) GLOB '[a-z0-9]'
    AND driver NOT GLOB '*[^a-z0-9._-]*'
  ),
  credential_ref TEXT NOT NULL CHECK (
    length(credential_ref) BETWEEN 1 AND 128
    AND substr(credential_ref, 1, 1) GLOB '[A-Z]'
    AND credential_ref NOT GLOB '*[^A-Z0-9_]*'
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'retired')),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json) AND json_type(capabilities_json) = 'object'),
  configuration_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(configuration_json) AND json_type(configuration_json) = 'object'),
  mappings_json TEXT NOT NULL CHECK (json_valid(mappings_json) AND json_type(mappings_json) = 'object'),
  binding_revision INTEGER NOT NULL DEFAULT 0 CHECK (binding_revision >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO providers (
  id, driver, credential_ref, status, capabilities_json, configuration_json,
  mappings_json, binding_revision, revision, created_at, updated_at
)
SELECT
  id, driver, credential_ref, status, capabilities_json, '{}', mappings_json,
  binding_revision, revision, created_at, updated_at
FROM providers_legacy_0002;

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

INSERT INTO provider_bindings (
  resource_id, provider_id, provider_resource_type, provider_resource_id,
  provider_resource_name, locator_json, active, bound_at, bound_by
)
SELECT
  resource_id, provider_id, provider_resource_type, provider_resource_id,
  provider_resource_name, locator_json, active, bound_at, bound_by
FROM provider_bindings_legacy_0002;

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

INSERT INTO provider_binding_history (
  id, resource_id, provider_id, provider_resource_type, provider_resource_id,
  provider_resource_name, locator_json, bound_at, unbound_at, bound_by,
  unbound_by, operation_id
)
SELECT
  id, resource_id, provider_id, provider_resource_type, provider_resource_id,
  provider_resource_name, locator_json, bound_at, unbound_at, bound_by,
  unbound_by, operation_id
FROM provider_binding_history_legacy_0002;

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

INSERT INTO operation_changes (
  operation_id, position, action, resource_id, provider_id,
  provider_resource_type, provider_resource_id, relationship_id,
  target_resource_id, relationship_type
)
SELECT
  operation_id, position, action, resource_id, provider_id,
  provider_resource_type, provider_resource_id, relationship_id,
  target_resource_id, relationship_type
FROM operation_changes_legacy_0002;

DROP TABLE provider_bindings_legacy_0002;
DROP TABLE provider_binding_history_legacy_0002;
DROP TABLE operation_changes_legacy_0002;
DROP TABLE providers_legacy_0002;

CREATE INDEX idx_providers_status ON providers(status);
CREATE INDEX idx_bindings_provider ON provider_bindings(provider_id);
CREATE INDEX idx_operation_changes_resource ON operation_changes(resource_id, operation_id);

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

CREATE TRIGGER providers_no_hard_delete
BEFORE DELETE ON providers
BEGIN
  SELECT RAISE(ABORT, 'providers must be retired, not deleted');
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

PRAGMA legacy_alter_table = OFF;
PRAGMA defer_foreign_keys = OFF;
