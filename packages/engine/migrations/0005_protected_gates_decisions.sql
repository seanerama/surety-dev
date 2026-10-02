-- Slice 5: the protected path, gates and decisions (D1 A.3, §§2.4, 3.3, 3.4,
-- 5, 7.9, 9, 10; build spec §6 corrections 3, 4, 5, 8, 17, 18, 22; RN R1,
-- R2, R4, R7; SEAM.md §§65-85). The approved baseline enters M1 as a fixture
-- (build spec §3): requirements and modules are its parts the gate reads.
-- Columns marked engine-owned are not in A.3.

CREATE TABLE requirements (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  text_ref TEXT NOT NULL,
  assigned_phase INTEGER,
  status TEXT NOT NULL,
  verified_by TEXT,
  confirmed_by TEXT,
  UNIQUE (project, key)
);

CREATE TABLE modules (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  paths TEXT NOT NULL,
  sensitive_areas TEXT NOT NULL DEFAULT '[]',
  tier_override TEXT CHECK (tier_override IN ('T1', 'T2', 'T3')),
  UNIQUE (project, name)
);

-- D1 §3.3; RN R2. One row per protected version; exactly one effective
-- version per project. `roots` (engine-owned): the protected roots the
-- version's governed file names.
CREATE TABLE protected_versions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  check_ids TEXT NOT NULL DEFAULT '[]',
  change_kind TEXT NOT NULL CHECK (change_kind IN ('initial', 'tightening', 'loosening', 'unclassifiable')),
  proposal TEXT REFERENCES protected_proposals(id),
  approved_by TEXT NOT NULL,
  approver_authority TEXT NOT NULL CHECK (approver_authority IN ('role', 'reviewer', 'human')),
  approved_at TEXT NOT NULL,
  applied_by_operation TEXT REFERENCES operations(id),
  authorized INTEGER NOT NULL CHECK (authorized IN (0, 1)),
  effective_from TEXT,
  superseded_by TEXT REFERENCES protected_versions(id),
  roots TEXT NOT NULL,
  UNIQUE (project, seq)
);
CREATE UNIQUE INDEX protected_versions_one_effective ON protected_versions(project)
  WHERE authorized = 1 AND effective_from IS NOT NULL AND superseded_by IS NULL;
CREATE UNIQUE INDEX protected_versions_one_per_proposal ON protected_versions(proposal) WHERE proposal IS NOT NULL;

-- D1 §3.3; Review B04. `changes_required_set` (engine-owned): the tree
-- changes the value of required_checks in the governed file.
CREATE TABLE protected_proposals (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  proposed_by TEXT NOT NULL CHECK (proposed_by IN ('verifier_run', 'human')),
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
  UNIQUE (project, seq)
);

-- D1 §3.3. `runner_class` and `requires` (engine-owned): the runner class an
-- execution must be bound to, and which of environment and artifact_digest
-- it must match (SEAM.md §§67, 71).
CREATE TABLE checks (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  protected_version TEXT NOT NULL REFERENCES protected_versions(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'acceptance', 'smoke', 'integration', 'security_lint', 'property', 'failure_recovery', 'sensitivity_floor',
    'post_deploy_identity', 'post_deploy_behavior')),
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
  UNIQUE (protected_version, key)
);
CREATE INDEX checks_by_key ON checks(project, key);

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  adapter TEXT NOT NULL,
  adapter_config_ref TEXT NOT NULL,
  verify_spec TEXT NOT NULL
);

-- D1 §3.3; correction 17: `invalidated_at` is durable and separate from an
-- evaluation's staleness.
CREATE TABLE check_results (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  "check" TEXT NOT NULL REFERENCES checks(id),
  candidate TEXT NOT NULL REFERENCES candidates(id),
  source_revision TEXT NOT NULL,
  protected_version TEXT NOT NULL REFERENCES protected_versions(id),
  runner_class TEXT NOT NULL CHECK (runner_class IN ('direct', 'container', 'remote')),
  runner_id TEXT NOT NULL,
  environment TEXT REFERENCES environments(id),
  artifact_digest TEXT,
  execution_seq INTEGER NOT NULL,
  execution_established INTEGER NOT NULL CHECK (execution_established IN (0, 1)),
  signaled INTEGER NOT NULL CHECK (signaled IN (0, 1)),
  deadline_hit INTEGER NOT NULL CHECK (deadline_hit IN (0, 1)),
  exit_status INTEGER,
  output TEXT REFERENCES records(id),
  started_at TEXT,
  finished_at TEXT,
  invalidated_at TEXT,
  UNIQUE (project, execution_seq)
);
CREATE INDEX check_results_by_candidate ON check_results(candidate);

-- Reuse entries (correction 18; SEAM.md §73). Engine-owned.
CREATE TABLE evidence_reuse (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  candidate TEXT NOT NULL REFERENCES candidates(id),
  "check" TEXT NOT NULL REFERENCES checks(id),
  check_result TEXT REFERENCES check_results(id),
  record TEXT REFERENCES records(id),
  assessed INTEGER NOT NULL CHECK (assessed IN (0, 1))
);

-- Validation-scope approvals of a proposal (E13; F §3.3), a baseline
-- approval M1 takes as a fixture. Engine-owned.
CREATE TABLE scope_approvals (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('validation_scope')),
  proposal TEXT NOT NULL REFERENCES protected_proposals(id)
);

-- Whether one revision is an ancestor of another, as git said once (an
-- immutable fact), so that a transaction can build a scope without git.
-- Engine-owned.
CREATE TABLE revision_ancestry (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  ancestor TEXT NOT NULL,
  descendant TEXT NOT NULL,
  is_ancestor INTEGER NOT NULL CHECK (is_ancestor IN (0, 1)),
  UNIQUE (project, ancestor, descendant)
);

-- D1 §3.4; correction 8. `stage` and `authorization` on the evaluation are
-- engine-owned.
CREATE TABLE acceptance_scopes (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  candidate TEXT NOT NULL REFERENCES candidates(id),
  gate_kind TEXT NOT NULL CHECK (gate_kind IN ('stage', 'phase', 'alpha_authorize', 'alpha_complete', 'beta_authorize', 'beta_complete', 'live_authorize', 'live_complete')),
  operation TEXT REFERENCES operations(id),
  attempt TEXT REFERENCES operation_attempts(id),
  phase INTEGER,
  stage TEXT REFERENCES stages(id),
  spec_revision TEXT,
  architecture_revision TEXT,
  policy_revision TEXT REFERENCES policy_revisions(id),
  effective_protected_version TEXT NOT NULL REFERENCES protected_versions(id),
  source_revision TEXT NOT NULL,
  delivered_requirement_ids TEXT NOT NULL,
  partial_requirement_ids TEXT NOT NULL,
  sensitivity_categories TEXT NOT NULL,
  required_check_ids TEXT NOT NULL,
  runner_classes TEXT NOT NULL,
  required_signoffs TEXT NOT NULL,
  environment TEXT REFERENCES environments(id),
  artifact_digest TEXT,
  evidence_reuse TEXT NOT NULL DEFAULT '[]',
  validated INTEGER NOT NULL CHECK (validated IN (0, 1)),
  scope_hash TEXT NOT NULL,
  acceptance_content_hash TEXT NOT NULL
);

CREATE TABLE gate_evaluations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  scope TEXT NOT NULL REFERENCES acceptance_scopes(id),
  candidate TEXT NOT NULL REFERENCES candidates(id),
  gate_kind TEXT NOT NULL CHECK (gate_kind IN ('stage', 'phase', 'alpha_authorize', 'alpha_complete', 'beta_authorize', 'beta_complete', 'live_authorize', 'live_complete')),
  computed_at TEXT NOT NULL,
  inputs_hash TEXT NOT NULL,
  inputs_snapshot TEXT NOT NULL,
  check_states TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('satisfied', 'not_satisfied')),
  reasons TEXT NOT NULL,
  satisfiers TEXT NOT NULL,
  stale INTEGER NOT NULL CHECK (stale IN (0, 1)),
  stage TEXT REFERENCES stages(id),
  authorization TEXT
);
CREATE INDEX gate_evaluations_by_candidate ON gate_evaluations(candidate, gate_kind);

-- RN R1; correction 4: created `proposed`, issued by a satisfied evaluation.
-- `generation` and `binding_hash` are engine-owned.
CREATE TABLE deployment_authorizations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  candidate TEXT NOT NULL REFERENCES candidates(id),
  environment TEXT NOT NULL REFERENCES environments(id),
  artifact_digest TEXT NOT NULL,
  source_delivery_mapping TEXT NOT NULL,
  config_identity TEXT NOT NULL,
  target_set TEXT NOT NULL,
  policy_revision TEXT REFERENCES policy_revisions(id),
  protected_version TEXT NOT NULL REFERENCES protected_versions(id),
  evaluation TEXT REFERENCES gate_evaluations(id),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'issued', 'consumed', 'superseded')),
  generation INTEGER NOT NULL,
  binding_hash TEXT NOT NULL,
  UNIQUE (candidate, binding_hash)
);

-- D1 §3.4; Review B02. `proposed_change` (engine-owned): a disposition or a
-- severity change a role proposed beyond its authority, awaiting the human;
-- `disposition_seq`: the project's execution sequence when the disposition
-- was recorded, so a resolution needs an execution recorded after it.
CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'lineage', 'candidate')),
  subject_id TEXT NOT NULL,
  candidate TEXT REFERENCES candidates(id),
  source_run TEXT REFERENCES runs(id),
  source_role TEXT,
  category TEXT NOT NULL CHECK (category IN ('defect', 'requirement_conflict', 'contract_conflict', 'security', 'hygiene')),
  message TEXT NOT NULL,
  "check" TEXT,
  proposed_severity TEXT NOT NULL CHECK (proposed_severity IN ('critical', 'high', 'medium', 'low')),
  effective_severity TEXT NOT NULL CHECK (effective_severity IN ('critical', 'high', 'medium', 'low')),
  severity_history TEXT NOT NULL DEFAULT '[]',
  sensitive_area TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'dispositioned', 'resolved')),
  disposition TEXT CHECK (disposition IN ('fix', 'defer', 'accept')),
  disposition_authority TEXT CHECK (disposition_authority IN ('role', 'reviewer', 'human')),
  disposition_by TEXT,
  disposition_at TEXT,
  disposition_seq INTEGER,
  linked_issue TEXT,
  defer_target TEXT,
  reevaluations TEXT NOT NULL DEFAULT '[]',
  alpha_exception TEXT,
  resolution_verification TEXT,
  proposed_disposition TEXT,
  proposed_severity_change TEXT,
  UNIQUE (project, seq)
);

CREATE TABLE applicability_assessments (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  finding TEXT NOT NULL REFERENCES findings(id),
  candidate TEXT NOT NULL REFERENCES candidates(id),
  proposed_by_run TEXT NOT NULL REFERENCES runs(id),
  assessed_by_run TEXT REFERENCES runs(id),
  authorized_by TEXT,
  evidence TEXT NOT NULL REFERENCES records(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'assessed', 'approved', 'rejected'))
);

CREATE TABLE signoffs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  candidate TEXT NOT NULL REFERENCES candidates(id),
  revision TEXT NOT NULL,
  role TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('candidate', 'module', 'security')),
  module TEXT,
  run TEXT NOT NULL REFERENCES runs(id),
  acceptance_content_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  decision TEXT NOT NULL REFERENCES decisions(id),
  actor TEXT NOT NULL,
  consequence TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  acceptance_content_hash TEXT,
  result_hash TEXT,
  policy_revision TEXT REFERENCES policy_revisions(id),
  protected_delta_shown TEXT,
  consumed_at TEXT NOT NULL
);

-- D1 §3.4, §10.5; Review B12. `operation` is the operation the effect made,
-- set when the effect begins; `kind` and `plan` are engine-owned.
CREATE TABLE effect_intents (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  decision TEXT NOT NULL REFERENCES decisions(id),
  approval TEXT REFERENCES approvals(id),
  operation TEXT REFERENCES operations(id),
  preconditions TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'executing', 'done', 'invalidated')),
  invalidated_reason TEXT,
  kind TEXT NOT NULL,
  plan TEXT NOT NULL
);
CREATE UNIQUE INDEX effect_intents_one_per_decision ON effect_intents(decision);

-- D1 §10.4. `key` is unique to a decision and its generation.
CREATE TABLE notification_intents (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'delivered', 'failed', 'unknown')),
  attempts INTEGER NOT NULL
);

-- Engine-owned columns on earlier tables: a run's report (findings,
-- sign-offs, ...) is recorded once.
ALTER TABLE runs ADD COLUMN report_recorded INTEGER NOT NULL DEFAULT 0 CHECK (report_recorded IN (0, 1));
-- Engine-owned: the acceptance content of the run's subject candidate,
-- fixed when the run is claimed. What a Reviewer signs off is what it was
-- given to review (E41 item 4).
ALTER TABLE runs ADD COLUMN content_hash TEXT;
