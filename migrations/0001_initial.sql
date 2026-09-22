-- Fresh installation only. D1 owns the migration ledger.
PRAGMA foreign_keys = ON;

CREATE TABLE locations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name))>0),
  slug TEXT NOT NULL UNIQUE CHECK(length(trim(slug))>0),
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE devices (
  id TEXT PRIMARY KEY NOT NULL,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(trim(name))>0),
  role TEXT NOT NULL CHECK(length(trim(role))>0),
  manufacturer TEXT,
  model TEXT,
  serial_number TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT,
  source_scope TEXT,
  source_id TEXT,
  CHECK ((source IS NULL AND source_scope IS NULL AND source_id IS NULL) OR (source IS NOT NULL AND length(trim(source)) > 0 AND source_scope IS NOT NULL AND length(trim(source_scope)) > 0 AND source_id IS NOT NULL AND length(trim(source_id)) > 0)),
  UNIQUE (source, source_scope, source_id)
) STRICT;

CREATE TABLE virtual_machines (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name))>0),
  host_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  vcpu INTEGER CHECK(vcpu > 0),
  memory_mb INTEGER CHECK(memory_mb > 0),
  disk_mb INTEGER CHECK(disk_mb > 0),
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT,
  source_scope TEXT,
  source_id TEXT,
  CHECK ((source IS NULL AND source_scope IS NULL AND source_id IS NULL) OR (source IS NOT NULL AND length(trim(source)) > 0 AND source_scope IS NOT NULL AND length(trim(source_scope)) > 0 AND source_id IS NOT NULL AND length(trim(source_id)) > 0)),
  UNIQUE (source, source_scope, source_id)
) STRICT;

CREATE TABLE interfaces (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  virtual_machine_id TEXT REFERENCES virtual_machines(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(trim(name))>0),
  mac_address TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((device_id IS NOT NULL) != (virtual_machine_id IS NOT NULL)),
  UNIQUE(device_id,name),
  UNIQUE(virtual_machine_id,name)
) STRICT;

CREATE TABLE vlans (
  id TEXT PRIMARY KEY NOT NULL,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  vid INTEGER NOT NULL CHECK(vid BETWEEN 1 AND 4094),
  name TEXT NOT NULL CHECK(length(trim(name))>0),
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(location_id,vid),
  UNIQUE(id,location_id)
) STRICT;

CREATE TABLE prefixes (
  id TEXT PRIMARY KEY NOT NULL,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  vlan_id TEXT,
  cidr TEXT NOT NULL UNIQUE,
  name TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  family INTEGER NOT NULL CHECK(family IN (4,6)),
  prefix_length INTEGER NOT NULL CHECK(prefix_length BETWEEN 0 AND CASE family WHEN 4 THEN 32 ELSE 128 END),
  range_start TEXT NOT NULL CHECK(length(range_start)=32),
  range_end TEXT NOT NULL CHECK(length(range_end)=32 AND range_end>=range_start),
  FOREIGN KEY(vlan_id,location_id) REFERENCES vlans(id,location_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE ip_addresses (
  id TEXT PRIMARY KEY NOT NULL,
  prefix_id TEXT NOT NULL REFERENCES prefixes(id) ON DELETE RESTRICT,
  interface_id TEXT REFERENCES interfaces(id) ON DELETE SET NULL,
  address TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('assigned','reserved')),
  dns_name TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  family INTEGER NOT NULL CHECK(family IN (4,6)),
  address_key TEXT NOT NULL CHECK(length(address_key)=32),
  UNIQUE(family,address_key)
) STRICT;

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create','update','delete','allocate','release')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK(after_json IS NULL OR json_valid(after_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX devices_location_id ON devices(location_id);
CREATE INDEX virtual_machines_host_device_id ON virtual_machines(host_device_id);
CREATE INDEX prefixes_vlan_id_location_id ON prefixes(vlan_id,location_id);
CREATE INDEX prefixes_family_range_start_range_end ON prefixes(family,range_start,range_end);
CREATE INDEX ip_addresses_prefix_id ON ip_addresses(prefix_id);
CREATE INDEX ip_addresses_interface_id ON ip_addresses(interface_id);
CREATE INDEX ip_addresses_family_address_key ON ip_addresses(family,address_key);
CREATE INDEX audit_log_entity_type_entity_id_created_at ON audit_log(entity_type,entity_id,created_at);
CREATE INDEX audit_log_created_at ON audit_log(created_at);

CREATE TRIGGER ip_membership_insert BEFORE INSERT ON ip_addresses
WHEN NOT EXISTS (SELECT 1 FROM prefixes p WHERE p.id=NEW.prefix_id AND p.family=NEW.family AND NEW.address_key BETWEEN p.range_start AND p.range_end)
BEGIN SELECT RAISE(ABORT, 'relationship: IP must belong to its Prefix'); END;

CREATE TRIGGER ip_membership_update BEFORE UPDATE ON ip_addresses
WHEN NOT EXISTS (SELECT 1 FROM prefixes p WHERE p.id=NEW.prefix_id AND p.family=NEW.family AND NEW.address_key BETWEEN p.range_start AND p.range_end)
BEGIN SELECT RAISE(ABORT, 'relationship: IP must belong to its Prefix'); END;

CREATE TRIGGER prefix_membership_update BEFORE UPDATE ON prefixes
WHEN EXISTS (SELECT 1 FROM ip_addresses a WHERE a.prefix_id=OLD.id AND (a.family!=NEW.family OR a.address_key NOT BETWEEN NEW.range_start AND NEW.range_end))
BEGIN SELECT RAISE(ABORT, 'relationship: Prefix must contain its registered IPs'); END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
