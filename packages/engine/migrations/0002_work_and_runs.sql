-- Slice 2: work, runs and interruption (D1 A.3, §§3.2, 4, 8, 10, 16; build
-- spec §6 corrections 1, 2, 11, 12, 13). The tables the scheduler, the
-- invocation choke point and the run-end protocol write, and the two columns
-- the work-item transition function needs beyond A.3.
--
-- Columns that reference a table no slice has created yet (roadmap and spec
-- revisions, records, revisions) are added by the slice that creates that
-- table, as in 0001.

-- The status an item left when it entered awaiting_decision; leaving it for
-- executing, integrating or verifying is legal only back to this status
-- (correction 11). Engine-owned; not in A.3.
ALTER TABLE work_items ADD COLUMN continuation TEXT
  CHECK (continuation IN ('executing', 'integrating', 'verifying'));

-- Set when a run of the item ended failed and the item went back to eligible:
-- its next dispatch is an automatic re-dispatch and counts one repair attempt
-- (D1 §4.3). Engine-owned; not in A.3.
ALTER TABLE work_items ADD COLUMN repair_due INTEGER NOT NULL DEFAULT 0 CHECK (repair_due IN (0, 1));

CREATE INDEX work_items_by_status ON work_items(project, status);

CREATE TABLE phase_plans (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  phase_number INTEGER NOT NULL,
  prepared_against_revision TEXT NOT NULL,
  git_path TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT
);

CREATE TABLE stages (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  phase_plan TEXT NOT NULL REFERENCES phase_plans(id),
  number INTEGER NOT NULL,
  goal TEXT NOT NULL,
  modules TEXT NOT NULL,
  requirement_ids TEXT NOT NULL,
  implements TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'building', 'integrated', 'verified')),
  integrated_revision TEXT,
  work_item TEXT REFERENCES work_items(id),
  UNIQUE (phase_plan, number)
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT NOT NULL REFERENCES runs(id),
  path TEXT NOT NULL UNIQUE,
  base_revision TEXT NOT NULL,
  current_base TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('active', 'retained', 'quarantined', 'discarded')),
  checkpoints TEXT NOT NULL DEFAULT '[]',
  snapshot_tree TEXT,
  disposed_at TEXT
);

ALTER TABLE runs ADD COLUMN workspace TEXT REFERENCES workspaces(id);

CREATE INDEX runs_by_state ON runs(state);
CREATE INDEX runs_by_work_item ON runs(work_item);

CREATE TABLE process_ownership (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  domain TEXT NOT NULL REFERENCES execution_domains(id),
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  incarnation TEXT NOT NULL REFERENCES engine_incarnations(id),
  pgid INTEGER,
  pid INTEGER,
  pid_start_time TEXT,
  containment_id TEXT,
  descendants TEXT NOT NULL DEFAULT '[]',
  termination_confirmed_at TEXT,
  UNIQUE (domain)
);

-- D1 §3.2, §8.3. A lease is active (released_at null, closing 0), closing
-- (closing 1) or released. One unreleased holder per resource (D1 §6.2).
CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('run', 'integration', 'workspace', 'quarantine')),
  resource_id TEXT NOT NULL,
  owner_incarnation TEXT NOT NULL REFERENCES engine_incarnations(id),
  generation INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  closing INTEGER NOT NULL CHECK (closing IN (0, 1)),
  cleanup_authority INTEGER NOT NULL CHECK (cleanup_authority IN (0, 1))
);
CREATE UNIQUE INDEX leases_one_holder ON leases(resource_kind, resource_id) WHERE released_at IS NULL;
CREATE INDEX leases_by_resource ON leases(resource_id);

-- D1 §3.4, §10, A.8. Identity is unique across all statuses (D1 §6.2).
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'idea_accept', 'spec_approval', 'spec_change', 'architecture_approval', 'plan_approval',
    'check_correction_loosening', 'check_correction_unclassifiable', 'check_correction_tightening',
    'finding_disposition', 'finding_applicability_exclusion', 'severity_lower', 'blocker', 'out_of_band_change',
    'rollout_partial', 'publication_first_visibility', 'publication_subsequent', 'allowlist_widening', 'go_live',
    'management_opt_in', 'triage', 'adoption_mode', 'requirement_confirm', 'stop_confirm', 'abandon_confirm',
    'retire', 'reactivate', 'policy_widening')),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  semantic_generation INTEGER NOT NULL,
  scope TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  dependency_manifest TEXT NOT NULL,
  transition_schema_version INTEGER NOT NULL,
  preview_hash TEXT NOT NULL,
  evidence TEXT NOT NULL,
  blocked_while_open TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  target_seconds INTEGER,
  escalated_at TEXT,
  batch_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'consumed', 'invalidated')),
  answer TEXT,
  consumed_at TEXT,
  invalidated_reason TEXT,
  UNIQUE (project, seq),
  UNIQUE (project, kind, subject_type, subject_id, semantic_generation, scope)
);
CREATE INDEX decisions_by_subject ON decisions(subject_id, kind);
CREATE INDEX decisions_open ON decisions(project, status);
