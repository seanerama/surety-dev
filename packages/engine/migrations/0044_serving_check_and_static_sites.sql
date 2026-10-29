-- Static sites on local_service and the engine's serving check (the owner's
-- instruction and rulings of 2026-10-29; SHAPES.md §§2, 3):
--   - the check kind `post_deploy_serving`, the engine's own program;
--   - the proposer `engine` of a protected proposal: the serving check the
--     engine itself proposes for a static configuration's project, through
--     the ordinary classification, approval and application;
--   - an artifact's output kind, derived from its sealed tree when it is
--     sealed (static_site, node_service or unknown; null for an artifact
--     recorded before this migration, read as unknown);
--   - a deployment verification's and an alpha_complete evaluation's
--     `serving`: serving verified by the passed serving check, never
--     functional or visual acceptance.
--
-- `checks` and `protected_proposals` are rebuilt because SQLite cannot widen
-- a CHECK constraint in place (as 0032 did); every row is kept as it is.

PRAGMA foreign_keys = OFF;

-- ---- checks ----
CREATE TABLE checks_0044 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  protected_version TEXT NOT NULL REFERENCES protected_versions(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'acceptance', 'smoke', 'integration', 'security_lint', 'property', 'failure_recovery', 'sensitivity_floor',
    'post_deploy_identity', 'post_deploy_behavior', 'post_deploy_serving')),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  gate_kinds TEXT NOT NULL,
  tier_floor TEXT CHECK (tier_floor IN ('T1', 'T2', 'T3')),
  definition_path TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  requirement_ids TEXT NOT NULL DEFAULT '[]',
  sensitive_areas TEXT NOT NULL DEFAULT '[]',
  phase INTEGER,
  runner_class TEXT NOT NULL CHECK (runner_class IN ('direct', 'container', 'remote')),
  requires TEXT NOT NULL DEFAULT '[]',
  origin TEXT NOT NULL DEFAULT 'acceptance' CHECK (origin IN ('acceptance', 'developer')),
  criteria TEXT NOT NULL DEFAULT '[]',
  definition TEXT NOT NULL DEFAULT '{}',
  input_manifest TEXT NOT NULL DEFAULT '[]',
  UNIQUE (protected_version, key)
);
INSERT INTO checks_0044 SELECT * FROM checks;
DROP TABLE checks;
ALTER TABLE checks_0044 RENAME TO checks;
CREATE INDEX checks_by_key ON checks(project, key);

-- ---- protected_proposals ----
CREATE TABLE protected_proposals_0044 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  proposed_by TEXT NOT NULL CHECK (proposed_by IN ('verifier_run', 'human', 'engine')),
  run TEXT REFERENCES runs(id),
  base_revision TEXT NOT NULL,
  tree_id TEXT NOT NULL,
  diff_hash TEXT NOT NULL,
  affected_checks TEXT NOT NULL DEFAULT '[]',
  rationale TEXT REFERENCES records(id),
  requested_change_kind TEXT NOT NULL CHECK (requested_change_kind IN ('initial', 'tightening', 'loosening', 'unclassifiable')),
  classified_change_kind TEXT CHECK (classified_change_kind IN ('initial', 'tightening', 'loosening', 'unclassifiable')),
  status TEXT NOT NULL CHECK (status IN ('captured', 'classified', 'awaiting_human', 'approved', 'applied', 'rejected')),
  approver TEXT,
  approver_authority TEXT CHECK (approver_authority IN ('role', 'reviewer', 'human')),
  approved_at TEXT,
  resulting_version TEXT REFERENCES protected_versions(id),
  changes_required_set INTEGER NOT NULL DEFAULT 0 CHECK (changes_required_set IN (0, 1)),
  recommendations TEXT NOT NULL DEFAULT '[]',
  classification TEXT,
  approval_binding TEXT,
  adopted_tests TEXT,
  boundary_errors TEXT,
  fingerprint_changes TEXT,
  deferred_criteria TEXT,
  classified_tree TEXT,
  UNIQUE (project, seq)
);
INSERT INTO protected_proposals_0044 SELECT * FROM protected_proposals;
DROP TABLE protected_proposals;
ALTER TABLE protected_proposals_0044 RENAME TO protected_proposals;

-- ---- added columns ----
ALTER TABLE artifacts ADD COLUMN output_kind TEXT CHECK (output_kind IN ('static_site', 'node_service', 'unknown'));
ALTER TABLE deployment_verifications ADD COLUMN serving TEXT;
ALTER TABLE gate_evaluations ADD COLUMN serving TEXT;
