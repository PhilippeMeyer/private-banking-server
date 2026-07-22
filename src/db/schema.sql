-- KYC screening service schema (SQLite dialect; portable enough to move to Postgres later)

-- One row per import run of a source list. Lets us know which version of a list
-- was active at the time any given screening happened (regulators will ask this).
CREATE TABLE IF NOT EXISTS list_versions (
  id              TEXT PRIMARY KEY,        -- uuid
  source          TEXT NOT NULL,           -- 'OFAC_SDN', 'OFAC_CONSOLIDATED', 'UN', 'EU', 'PEP', 'ADVERSE_MEDIA', 'CUSTOM'
  version_label   TEXT,                    -- source-provided version/date if available
  record_count    INTEGER NOT NULL,
  imported_at     TEXT NOT NULL,           -- ISO 8601
  checksum        TEXT,                    -- hash of raw payload, to detect no-op re-imports
  status          TEXT NOT NULL DEFAULT 'complete' -- 'complete' | 'failed' | 'partial'
);

-- Canonical, normalized entity records from every source, after mapping.
CREATE TABLE IF NOT EXISTS entities (
  id                TEXT PRIMARY KEY,      -- uuid, internal
  source            TEXT NOT NULL,         -- same enum as list_versions.source
  source_record_id  TEXT NOT NULL,         -- the ID the source assigns (e.g. OFAC uid)
  list_version_id   TEXT NOT NULL REFERENCES list_versions(id),
  entity_type       TEXT NOT NULL,         -- 'individual' | 'organization' | 'vessel' | 'aircraft'
  primary_name      TEXT NOT NULL,
  aliases           TEXT,                  -- JSON array of strings
  date_of_birth     TEXT,                  -- ISO date, nullable (often only year is known)
  place_of_birth    TEXT,
  nationalities     TEXT,                  -- JSON array
  id_numbers        TEXT,                  -- JSON array of {type, number, country}
  addresses         TEXT,                  -- JSON array
  risk_category     TEXT,                  -- 'sanctions' | 'pep' | 'adverse_media' | 'custom'
  programs          TEXT,                  -- JSON array, e.g. sanctions program codes
  raw_data          TEXT NOT NULL,         -- full original record as JSON, for audit/debug
  created_at        TEXT NOT NULL,
  UNIQUE(source, source_record_id, list_version_id)
);

CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(primary_name);
CREATE INDEX IF NOT EXISTS idx_entities_source ON entities(source);

-- Every screening request made against the service.
CREATE TABLE IF NOT EXISTS screenings (
  id                  TEXT PRIMARY KEY,    -- uuid
  subject_name        TEXT NOT NULL,
  subject_dob         TEXT,
  subject_nationality TEXT,
  subject_id_numbers  TEXT,                -- JSON array
  requested_by        TEXT,                -- calling system/user
  requested_at        TEXT NOT NULL,
  risk_score          REAL NOT NULL,
  risk_band           TEXT NOT NULL,       -- 'low' | 'medium' | 'high'
  matches             TEXT NOT NULL,       -- JSON array of {entityId, score, matchedOn}
  list_versions_used  TEXT NOT NULL        -- JSON array of list_version ids active at screening time
);

CREATE INDEX IF NOT EXISTS idx_screenings_subject_name ON screenings(subject_name);

-- Analyst disposition on a screening (true positive / false positive / escalated).
-- Kept separate from screenings so a screening's original result is never mutated.
CREATE TABLE IF NOT EXISTS dispositions (
  id             TEXT PRIMARY KEY,
  screening_id   TEXT NOT NULL REFERENCES screenings(id),
  decision       TEXT NOT NULL,           -- 'true_positive' | 'false_positive' | 'escalated' | 'pending'
  reviewed_by    TEXT NOT NULL,
  notes          TEXT,
  reviewed_at    TEXT NOT NULL
);

-- Immutable audit log. Every meaningful action writes here; never updated or deleted.
CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,             -- 'screening' | 'import' | 'disposition' | 'entity'
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL,             -- 'created' | 'reviewed' | 'imported' | 'rescreened'
  actor        TEXT,                      -- user/service that performed the action
  details      TEXT,                      -- JSON, free-form
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
