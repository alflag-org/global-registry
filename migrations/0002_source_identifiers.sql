-- Reject legacy noncanonical identities before enforcing the new invariant.
-- Correct these through the API first so identity changes remain audited.
CREATE TABLE source_identifier_check (
  source TEXT CHECK(source IS NULL OR
    (length(source) BETWEEN 1 AND 200 AND source GLOB '[a-z0-9]*' AND source NOT GLOB '*[^a-z0-9._-]*'))
) STRICT;
INSERT INTO source_identifier_check SELECT source FROM devices;
INSERT INTO source_identifier_check SELECT source FROM virtual_machines;
DROP TABLE source_identifier_check;

CREATE TRIGGER devices_source_insert BEFORE INSERT ON devices
WHEN NEW.source IS NOT NULL AND NOT (
  length(NEW.source) BETWEEN 1 AND 200 AND NEW.source GLOB '[a-z0-9]*'
  AND NEW.source NOT GLOB '*[^a-z0-9._-]*')
BEGIN SELECT RAISE(ABORT, 'source must be a canonical lowercase identifier'); END;

CREATE TRIGGER devices_source_update BEFORE UPDATE ON devices
WHEN NEW.source IS NOT NULL AND NOT (
  length(NEW.source) BETWEEN 1 AND 200 AND NEW.source GLOB '[a-z0-9]*'
  AND NEW.source NOT GLOB '*[^a-z0-9._-]*')
BEGIN SELECT RAISE(ABORT, 'source must be a canonical lowercase identifier'); END;

CREATE TRIGGER virtual_machines_source_insert BEFORE INSERT ON virtual_machines
WHEN NEW.source IS NOT NULL AND NOT (
  length(NEW.source) BETWEEN 1 AND 200 AND NEW.source GLOB '[a-z0-9]*'
  AND NEW.source NOT GLOB '*[^a-z0-9._-]*')
BEGIN SELECT RAISE(ABORT, 'source must be a canonical lowercase identifier'); END;

CREATE TRIGGER virtual_machines_source_update BEFORE UPDATE ON virtual_machines
WHEN NEW.source IS NOT NULL AND NOT (
  length(NEW.source) BETWEEN 1 AND 200 AND NEW.source GLOB '[a-z0-9]*'
  AND NEW.source NOT GLOB '*[^a-z0-9._-]*')
BEGIN SELECT RAISE(ABORT, 'source must be a canonical lowercase identifier'); END;

CREATE INDEX prefixes_location_id ON prefixes(location_id);
