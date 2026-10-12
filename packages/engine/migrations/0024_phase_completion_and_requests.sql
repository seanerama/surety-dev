-- M5 slice 31b (D6 §§4, 5.6, 5.8, 6.8; A.2, A.3; K5, K8, K9; B05, B06, B14):
-- the phase sign-off and its binding, the specification change's thin path
-- (its requests and the obligations an approval records), a check result's
-- invalidation reason, and the deployment request with its key.

PRAGMA foreign_keys = OFF;

-- ---- signoffs: scope `phase` (D6 §5.8, A.2) with its binding; any role --------------------
CREATE TABLE signoffs_0024 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  candidate TEXT NOT NULL REFERENCES candidates(id),
  revision TEXT NOT NULL,
  role TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('candidate', 'module', 'security', 'phase')),
  module TEXT,
  run TEXT NOT NULL REFERENCES runs(id),
  acceptance_content_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  -- `phase` only: {acceptance_hash, protected_version, spec_revision,
  -- plan_generation, phase_plan}; a sign-off bound to a replaced plan or
  -- candidate counts for nothing (B06).
  binding TEXT,
  phase_plan TEXT REFERENCES phase_plans(id)
);
INSERT INTO signoffs_0024 ("id", "created_at", "project", "candidate", "revision", "role", "scope", "module", "run", "acceptance_content_hash", "recorded_at")
SELECT "id", "created_at", "project", "candidate", "revision", "role", "scope", "module", "run", "acceptance_content_hash", "recorded_at" FROM signoffs;
DROP TABLE signoffs;
ALTER TABLE signoffs_0024 RENAME TO signoffs;

PRAGMA foreign_keys = ON;

-- ---- the specification change (D6 §4.2 to §4.5; K8; B05) -----------------------------------
CREATE TABLE spec_change_requests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  spec_revision TEXT REFERENCES spec_revisions(id),
  text TEXT REFERENCES records(id),
  source TEXT NOT NULL CHECK (source IN ('owner', 'finding')),
  status TEXT NOT NULL CHECK (status IN ('requested', 'proposed', 'approved', 'rejected', 'failed')),
  work_item TEXT REFERENCES work_items(id),
  -- The proposed revision on its side ref, its blob, and the impact record.
  proposal_revision TEXT,
  proposal_blob TEXT,
  side_ref TEXT,
  impact TEXT REFERENCES records(id),
  impact_value TEXT,
  approved_revision TEXT REFERENCES spec_revisions(id),
  UNIQUE (project, seq)
);

CREATE TABLE check_obligations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  "check" TEXT NOT NULL REFERENCES checks(id),
  key TEXT NOT NULL,
  criteria TEXT NOT NULL,
  generation INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('spec_changed')),
  request TEXT REFERENCES spec_change_requests(id),
  resolved_by TEXT,
  resolved_at TEXT
);

ALTER TABLE check_results ADD COLUMN invalidated_reason TEXT;

-- ---- the deployment request (D6 §6.8, A.3; K9; B14) ----------------------------------------
CREATE TABLE deployment_requests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  -- {project, completion_binding, candidate, environment_configuration}, canonical.
  request_key TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK (requested_by IN ('human', 'policy')),
  candidate TEXT NOT NULL REFERENCES candidates(id),
  environment TEXT NOT NULL REFERENCES environments(id),
  authorization TEXT REFERENCES deployment_authorizations(id),
  work_item TEXT REFERENCES work_items(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'not_issued', 'deployed', 'failed', 'not_verified', 'unknown')),
  UNIQUE (project, request_key)
);
