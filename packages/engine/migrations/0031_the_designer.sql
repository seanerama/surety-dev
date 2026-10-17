-- M6 slice 40 (D7 draft 3 §§2 to 11; Appendix A.2, A.3; BS6 §3; SEAM.md
-- §§480 to 489): the Designer. The role `designer`; the decision kinds
-- `design_approval`, `design_due` and `design_verdicts`; the record kinds
-- `design_check`, `design_inventory`, `design_observation` and
-- `design_evidence`; the holds `design_pending` and `design_stale`; the
-- change-request sources `design` and `design_review`; the obligation reason
-- `asset_version_changed` (G14); and D7 A.3's tables.
--
-- Seven tables are rebuilt because SQLite cannot widen a CHECK constraint in
-- place (as 0023 did): `runs` and `ledger_rows` (role), `decisions` (kind),
-- `records` (kind), `work_items` (held), `spec_change_requests` (source) and
-- `check_obligations` (reason). Every row is kept as it is; the two triggers
-- whose bodies name a rebuilt table are dropped for the rebuild and recreated
-- after it, unchanged.

PRAGMA foreign_keys = OFF;

DROP TRIGGER invocation_receipts_turn_matches_run;
DROP TRIGGER trust_entries_activation;

-- ---- runs ----
CREATE TABLE runs_0031 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  work_item TEXT REFERENCES work_items(id),
  role TEXT NOT NULL CHECK (role IN (
    'vision', 'spec_writer', 'architect', 'builder', 'verifier', 'reviewer', 'release_operator', 'mechanic', 'designer')),
  kind TEXT NOT NULL CHECK (kind IN ('one_shot', 'session')),
  state TEXT NOT NULL CHECK (state IN (
    'created', 'claimed', 'executing', 'validating', 'proposal_captured', 'finalizing', 'ended')),
  session_state TEXT CHECK (session_state IN ('allocated', 'open_idle', 'turn_running', 'saving', 'closing')),
  outcome TEXT CHECK (outcome IN (
    'completed', 'failed', 'refused', 'timed_out', 'stopped', 'abandoned', 'recovered')),
  reason_class TEXT CHECK (reason_class IN (
    'diff_violation', 'ref_violation', 'invalid_result', 'infra_error', 'preflight_refused', 'deadline',
    'integration_conflict', 'budget', 'human_stop', 'human_abandon', 'recovered', 'none')),
  reason_text TEXT,
  backend TEXT NOT NULL,
  backend_version TEXT NOT NULL,
  model_requested TEXT NOT NULL,
  model_observed TEXT,
  "grant" TEXT REFERENCES capability_grants(id),
  base_revision TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  parent_run TEXT REFERENCES runs(id),
  provider_session_id TEXT,
  quarantined INTEGER NOT NULL CHECK (quarantined IN (0, 1)),
  workspace TEXT REFERENCES workspaces(id),
  result_value TEXT,
  reason_detail TEXT,
  chain INTEGER NOT NULL DEFAULT 1,
  transcript TEXT REFERENCES records(id),
  result TEXT REFERENCES records(id),
  report_recorded INTEGER NOT NULL DEFAULT 0 CHECK (report_recorded IN (0, 1)),
  content_hash TEXT,
  alpha_exception_outcomes TEXT,
  collection TEXT,
  -- D6 A.3 (B01): advanced at each turn's settlement; save, close and the
  -- next turn's admission compare-and-swap on it.
  idle_generation INTEGER NOT NULL DEFAULT 0,
  -- The session's notes for its next turn: what the last save found.
  session_notes TEXT,
  -- The number of turns a session has started.
  turn_count INTEGER NOT NULL DEFAULT 0, current_base TEXT, qualification_attempt TEXT REFERENCES qualification_attempts(id),
  UNIQUE (project, seq),
  CHECK (kind = 'session' OR work_item IS NOT NULL)
);
INSERT INTO runs_0031 SELECT * FROM runs;
DROP TABLE runs;
ALTER TABLE runs_0031 RENAME TO runs;
CREATE INDEX runs_by_state ON runs(state);
CREATE INDEX runs_by_work_item ON runs(work_item);

-- ---- ledger_rows ----
CREATE TABLE ledger_rows_0031 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  run TEXT NOT NULL REFERENCES runs(id),
  turn TEXT REFERENCES turns(id),
  role TEXT NOT NULL CHECK (role IN (
    'vision', 'spec_writer', 'architect', 'builder', 'verifier', 'reviewer', 'release_operator', 'mechanic', 'designer')),
  provider TEXT NOT NULL,
  model_requested TEXT NOT NULL,
  model_observed TEXT,
  raw_usage TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  billable_in INTEGER,
  cached_in INTEGER,
  out INTEGER,
  usage_complete INTEGER NOT NULL CHECK (usage_complete IN (0, 1)),
  cost_status TEXT NOT NULL CHECK (cost_status IN ('reported', 'estimated', 'unknown', 'measured_zero')),
  cost_usd REAL,
  day_utc TEXT NOT NULL,
  corrects TEXT REFERENCES ledger_rows(id),
  correction_seq INTEGER, unknown_allowance_tokens INTEGER CHECK (unknown_allowance_tokens IS NULL OR unknown_allowance_tokens >= 0),
  UNIQUE (invocation, correction_seq)
);
INSERT INTO ledger_rows_0031 SELECT * FROM ledger_rows;
DROP TABLE ledger_rows;
ALTER TABLE ledger_rows_0031 RENAME TO ledger_rows;
CREATE UNIQUE INDEX ledger_rows_one_original_per_invocation ON ledger_rows(invocation) WHERE corrects IS NULL;
CREATE INDEX ledger_rows_by_project ON ledger_rows(project, day_utc);
CREATE TRIGGER ledger_rows_no_update BEFORE UPDATE ON ledger_rows
BEGIN SELECT RAISE(ABORT, 'ledger_rows is append-only'); END;
CREATE TRIGGER ledger_rows_no_delete BEFORE DELETE ON ledger_rows
BEGIN SELECT RAISE(ABORT, 'ledger_rows is append-only'); END;

-- ---- decisions ----
CREATE TABLE decisions_0031 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT REFERENCES projects(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'idea_accept', 'spec_approval', 'spec_change', 'architecture_approval', 'plan_approval',
    'check_correction_loosening', 'check_correction_unclassifiable', 'check_correction_tightening',
    'finding_disposition', 'finding_applicability_exclusion', 'severity_lower', 'blocker', 'out_of_band_change',
    'rollout_partial', 'publication_first_visibility', 'publication_subsequent', 'allowlist_widening', 'go_live',
    'management_opt_in', 'triage', 'adoption_mode', 'requirement_confirm', 'stop_confirm', 'abandon_confirm',
    'retire', 'reactivate', 'policy_widening', 'qualification_approval', 'trust_activation',
    'design_approval', 'design_due', 'design_verdicts')),
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
  UNIQUE (project, kind, subject_type, subject_id, semantic_generation, scope),
  CHECK ((project IS NULL) = (kind IN ('qualification_approval', 'trust_activation')))
);
INSERT INTO decisions_0031 SELECT * FROM decisions;
DROP TABLE decisions;
ALTER TABLE decisions_0031 RENAME TO decisions;
CREATE INDEX decisions_by_subject ON decisions(subject_id, kind);
CREATE INDEX decisions_open ON decisions(project, status);
CREATE UNIQUE INDEX decisions_engine_identity ON decisions(kind, subject_type, subject_id, semantic_generation, scope) WHERE project IS NULL;

-- ---- records ----
CREATE TABLE records_0031 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'transcript', 'tool_output', 'check_output', 'result', 'raw_user_report', 'parked_result',
    'proposal_rationale', 'assessment_evidence', 'containment_evidence', 'recovery_plan',
    'provider_files', 'egress_log', 'qualification_evidence', 'unaccepted_result',
    'deployment_logs', 'service_link_log', 'deploy_precondition_manifest',
    'session_transcript', 'spec_impact', 'plan_check',
    'design_check', 'design_inventory', 'design_observation', 'design_evidence')),
  path TEXT,
  sha256 TEXT,
  bytes INTEGER,
  redaction_version TEXT NOT NULL,
  published INTEGER NOT NULL CHECK (published IN (0, 1)),
  post_scan TEXT NOT NULL CHECK (post_scan IN ('pending', 'clean', 'hit')),
  post_scan_finding TEXT,
  retain_until TEXT,
  run TEXT REFERENCES runs(id),
  published_at TEXT,
  missing_at TEXT,
  CHECK (published = 0 OR (sha256 IS NOT NULL AND bytes IS NOT NULL))
);
INSERT INTO records_0031 SELECT * FROM records;
DROP TABLE records;
ALTER TABLE records_0031 RENAME TO records;
CREATE INDEX records_by_run ON records(run);
CREATE INDEX records_by_project ON records(project, published);

-- ---- work_items ----
CREATE TABLE work_items_0031 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'stage_build', 'fix', 'verification', 'review', 'phase_verification', 'replan', 'assessment',
    'spec_change', 'check_correction', 'check_authoring', 'triage_accept', 'export', 'publish', 'deploy', 'rollback',
    'adoption_baseline', 'conformance')),
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'eligible', 'claimed', 'executing', 'integrating', 'integrated', 'verifying', 'complete',
    'awaiting_decision', 'held', 'parked', 'cancelled')),
  blocker TEXT,
  depends_on TEXT,
  trigger_source TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  trigger_generation INTEGER NOT NULL,
  trigger_consumed_at TEXT,
  repair_attempts INTEGER NOT NULL,
  no_progress_count INTEGER NOT NULL,
  progress_key TEXT,
  preflight_refusals INTEGER NOT NULL,
  prior_status TEXT CHECK (prior_status IN (
    'eligible', 'claimed', 'executing', 'integrating', 'integrated', 'verifying', 'complete',
    'awaiting_decision', 'held', 'parked', 'cancelled')),
  dispatch_hold INTEGER NOT NULL CHECK (dispatch_hold IN (0, 1)),
  continuation TEXT CHECK (continuation IN ('executing', 'integrating', 'verifying')),
  repair_due INTEGER NOT NULL DEFAULT 0 CHECK (repair_due IN (0, 1)),
  chain INTEGER NOT NULL DEFAULT 0,
  continue_from TEXT,
  profile TEXT CHECK (profile IS NULL OR profile IN ('role', 'probe', 'check')),
  qualification_attempt TEXT REFERENCES qualification_attempts(id),
  canary_kind TEXT CHECK (canary_kind IS NULL OR canary_kind IN ('positive', 'cancellation', 'containment')),
  check_repair TEXT,
  check_conflict TEXT,
  -- K3: the owner's `continue` at an autonomy boundary, recorded, so that the
  -- boundary does not fall again for the same item under `stage`.
  boundary_passed_at TEXT, held TEXT CHECK (held IN (
  'resource_envelope', 'chain_boundary', 'depends_on', 'authoring_readiness', 'open_decision', 'session_busy', 'design_pending', 'design_stale')), trigger_evidence TEXT, end_cause TEXT CHECK (end_cause IS NULL OR end_cause IN ('superseded', 'plan_replaced')), held_intervals TEXT, chain_origin TEXT, milestones_met TEXT,
  UNIQUE (project, seq),
  UNIQUE (project, trigger_source, trigger_id, trigger_generation)
);
INSERT INTO work_items_0031 SELECT * FROM work_items;
DROP TABLE work_items;
ALTER TABLE work_items_0031 RENAME TO work_items;
CREATE INDEX work_items_by_status ON work_items(project, status);

-- ---- spec_change_requests ----
CREATE TABLE spec_change_requests_0031 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  spec_revision TEXT REFERENCES spec_revisions(id),
  text TEXT REFERENCES records(id),
  request_text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('owner', 'finding', 'replan', 'design', 'design_review')),
  status TEXT NOT NULL CHECK (status IN ('requested', 'proposed', 'approved', 'rejected', 'failed')),
  work_item TEXT REFERENCES work_items(id),
  proposal_revision TEXT,
  proposal_blob TEXT,
  side_ref TEXT,
  impact TEXT REFERENCES records(id),
  impact_value TEXT,
  approved_revision TEXT REFERENCES spec_revisions(id),
  failure TEXT,
  last_refusal TEXT,
  -- `replan`: the run whose result asked for it, and the keys it names.
  run TEXT REFERENCES runs(id),
  keys TEXT, finding TEXT REFERENCES findings(id),
  UNIQUE (project, seq)
);
INSERT INTO spec_change_requests_0031 SELECT * FROM spec_change_requests;
DROP TABLE spec_change_requests;
ALTER TABLE spec_change_requests_0031 RENAME TO spec_change_requests;

-- ---- check_obligations ----
CREATE TABLE check_obligations_0031 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  "check" TEXT REFERENCES checks(id),
  key TEXT,
  criteria TEXT NOT NULL,
  generation INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('spec_changed', 'deferred_authoring', 'authoring_pending', 'asset_version_changed')),
  request TEXT REFERENCES spec_change_requests(id),
  resolved_by TEXT,
  resolved_at TEXT,
  -- deferred_authoring: {stage: <number>} or {interface: <name>}, the
  -- Verifier's reason, the follow-up's trigger identity and the plan.
  prerequisite TEXT,
  deferred_reason TEXT,
  follow_up TEXT,
  phase_plan TEXT REFERENCES phase_plans(id),
  CHECK (reason <> 'spec_changed' OR ("check" IS NOT NULL AND key IS NOT NULL)),
  CHECK (reason <> 'deferred_authoring' OR (prerequisite IS NOT NULL AND follow_up IS NOT NULL))
);
INSERT INTO check_obligations_0031 SELECT * FROM check_obligations;
DROP TABLE check_obligations;
ALTER TABLE check_obligations_0031 RENAME TO check_obligations;

CREATE TRIGGER invocation_receipts_turn_matches_run BEFORE INSERT ON invocation_receipts
BEGIN
  SELECT RAISE(ABORT, 'invocation_receipts: turn nullability disagrees with the run kind')
  WHERE (NEW.turn IS NULL) IS NOT (COALESCE((SELECT kind FROM runs WHERE id = NEW.run), '') = 'one_shot');
  SELECT RAISE(ABORT, 'invocation_receipts: the turn belongs to another run')
  WHERE NEW.turn IS NOT NULL AND COALESCE((SELECT run FROM turns WHERE id = NEW.turn), '') <> NEW.run;
END;
CREATE TRIGGER trust_entries_activation BEFORE UPDATE ON trust_entries
WHEN NEW.status = 'active' AND OLD.status <> 'active'
BEGIN
  SELECT RAISE(ABORT, 'trust_entries: only a proposed entry becomes active')
  WHERE OLD.status <> 'proposed';
  SELECT RAISE(ABORT, 'trust_entries: active needs the consumed trust_activation decision about this entry')
  WHERE NOT EXISTS (
    SELECT 1 FROM decisions d WHERE d.id = NEW.activated_by AND d.kind = 'trust_activation'
      AND d.subject_type = 'trust_entry' AND d.subject_id = NEW.id AND d.status = 'consumed');
END;

-- ---- the project's interface inventory (D7 §4; A.3 projects) -------------------------------

ALTER TABLE projects ADD COLUMN design_inventory_digest TEXT;
-- design_due's own state (D7 §11): {stage, note, later_until, review} as the
-- last answer or cause left it; NULL is `before_build` with nothing more.
ALTER TABLE projects ADD COLUMN design_due TEXT;

-- One row per inventory the engine derived and committed (D7 §4.2, §4.4):
-- the digest, what it was derived from, the engine's intent commit that
-- holds inventory.json, its fixtures and the placeholders, and when the
-- derivation was recorded (`design.inventory_derived`) after that commit.
CREATE TABLE design_inventories (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  inventory_digest TEXT NOT NULL,
  spec_revision TEXT REFERENCES spec_revisions(id),
  architecture_revision TEXT REFERENCES architecture_revisions(id),
  revision TEXT NOT NULL,
  inventory TEXT NOT NULL,
  manifest TEXT NOT NULL,
  -- the incarnation that committed it; the record is that incarnation's to
  -- make after its barrier, or recovery's after a restart
  incarnation TEXT,
  recorded_at TEXT,
  UNIQUE (project, inventory_digest)
);

-- ---- the design check (D7 §5.6; A.3 design_checks) -----------------------------------------

CREATE TABLE design_checks (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT REFERENCES runs(id),
  tree_revision TEXT NOT NULL,
  inventory_digest TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'refused')),
  reasons TEXT NOT NULL,
  hash TEXT NOT NULL,
  -- {path: blob} of the design tree checked
  blobs TEXT NOT NULL DEFAULT '{}'
);

-- ---- design revisions (D7 §5, §7.4; A.3 design_revisions) -----------------------------------

CREATE TABLE design_revisions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('full', 'asset_only', 'initial_review')),
  git_path TEXT NOT NULL DEFAULT '.surety/design/design.json',
  tree_blob TEXT,
  -- the commit holding the design tree the revision is
  revision TEXT NOT NULL,
  -- {path: blob} of every file of the design tree at that commit
  blobs TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('intended', 'observed')),
  targets TEXT NOT NULL,
  asset_manifest_version INTEGER,
  asset_manifest TEXT,
  selection TEXT,
  narrowings TEXT NOT NULL DEFAULT '[]',
  current_against_spec TEXT REFERENCES spec_revisions(id),
  spec_change_request TEXT REFERENCES spec_change_requests(id),
  architecture_revision TEXT REFERENCES architecture_revisions(id),
  inventory_digest TEXT,
  design_check TEXT REFERENCES design_checks(id),
  run TEXT REFERENCES runs(id),
  batch_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'approved_without_criteria', 'rejected', 'superseded')),
  assets_held TEXT NOT NULL DEFAULT '[]',
  -- the human tests' proposed phases (E156 Q3), as the approval showed them
  assignments TEXT,
  approved_by TEXT,
  approved_at TEXT,
  ready_at TEXT,
  supersedes TEXT REFERENCES design_revisions(id),
  findings TEXT NOT NULL DEFAULT '[]',
  -- what the engine read of the tree at the revision: design.json, the
  -- screens, navigation, criteria and the asset manifest
  content TEXT,
  -- the batch's effect released, once both answers are consumed and the
  -- barrier `design.approved` has passed (SEAM.md §486)
  batch_released_at TEXT
);

CREATE TABLE design_screens (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  design_revision TEXT NOT NULL REFERENCES design_revisions(id),
  key TEXT NOT NULL,
  target TEXT NOT NULL,
  requirements TEXT NOT NULL,
  interfaces TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('current', 'stale')),
  stale_reason TEXT,
  UNIQUE (design_revision, key)
);

CREATE TABLE design_assets (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  design_revision TEXT NOT NULL REFERENCES design_revisions(id),
  slot TEXT NOT NULL,
  slot_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  platforms TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('placeholder', 'proposed', 'approved')),
  provenance TEXT NOT NULL CHECK (provenance IN ('engine_placeholder', 'designer', 'owner', 'observed')),
  variants TEXT NOT NULL,
  held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1)),
  UNIQUE (design_revision, slot)
);

-- The effective asset set (D7 §6.4): per selected slot and variant the
-- latest approved slot@version, else the placeholder; replaced only by an
-- owner's approval. `revision` and `file` name the bytes in git.
CREATE TABLE design_effective_assets (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  slot TEXT NOT NULL,
  kind TEXT NOT NULL,
  variant TEXT NOT NULL,
  slot_version INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('approved', 'placeholder')),
  digest TEXT NOT NULL,
  format TEXT NOT NULL,
  revision TEXT NOT NULL,
  file TEXT NOT NULL,
  platforms TEXT NOT NULL,
  since_design_revision TEXT REFERENCES design_revisions(id),
  UNIQUE (project, slot, variant)
);

-- ---- asset bindings (D7 §6.5; G15; A.3 asset_bindings) -------------------------------------

CREATE TABLE asset_bindings (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  stage TEXT REFERENCES stages(id),
  work_item TEXT REFERENCES work_items(id),
  revision TEXT NOT NULL,
  target TEXT NOT NULL,
  slot TEXT NOT NULL,
  variant TEXT NOT NULL,
  path TEXT NOT NULL,
  form TEXT NOT NULL CHECK (form IN ('copy', 'derived')),
  source_slot_version INTEGER NOT NULL,
  declared_by TEXT NOT NULL CHECK (declared_by IN ('builder', 'architect')),
  superseded_by TEXT REFERENCES asset_bindings(id)
);

-- ---- the stage-to-screen binding (D7 §8.1; A.3 stage_screens) -------------------------------

CREATE TABLE stage_screens (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  stage TEXT NOT NULL REFERENCES stages(id),
  screen TEXT NOT NULL,
  target TEXT NOT NULL,
  design_revision TEXT NOT NULL REFERENCES design_revisions(id),
  UNIQUE (stage, screen, design_revision)
);

-- ---- check results' asset inputs (G14; A.3 check_results) -----------------------------------

ALTER TABLE check_results ADD COLUMN asset_inputs TEXT;
-- the effective slot@version an execution of a check reading assets is
-- given, fixed when it is registered (G14)
ALTER TABLE check_executions ADD COLUMN asset_inputs TEXT;

-- ---- the review (D7 §10; A.3 design_reviews, design_evidence) -------------------------------

CREATE TABLE design_reviews (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  design_revision TEXT REFERENCES design_revisions(id),
  run TEXT REFERENCES runs(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('alpha_complete', 'owner_command')),
  subject TEXT NOT NULL,
  review_blob TEXT,
  verdicts TEXT NOT NULL,
  confirmed_by TEXT,
  confirmation_decision TEXT REFERENCES decisions(id),
  change_request TEXT REFERENCES spec_change_requests(id),
  findings TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE design_evidence (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  review TEXT REFERENCES design_reviews(id),
  run TEXT REFERENCES runs(id),
  provenance TEXT NOT NULL CHECK (provenance IN ('engine_observed', 'owner_supplied', 'owner_reported')),
  format TEXT,
  digest TEXT,
  bytes INTEGER,
  target TEXT NOT NULL,
  screen TEXT,
  route TEXT,
  status INTEGER,
  truncated INTEGER,
  observed_on TEXT,
  record TEXT REFERENCES records(id)
);

-- ---- the preview (D7 §5.7; G4) ---------------------------------------------------------------

-- One row per preview generation of a project: the design revision sealed,
-- the deployment it made, and its teardown.
CREATE TABLE design_previews (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  generation INTEGER NOT NULL,
  revision TEXT NOT NULL,
  tree_digest TEXT NOT NULL,
  server_digest TEXT NOT NULL,
  unit TEXT,
  port INTEGER,
  status TEXT NOT NULL CHECK (status IN ('deploying', 'deployed', 'failed', 'torn_down')),
  mockups TEXT NOT NULL,
  deployed_at TEXT,
  torn_down_at TEXT,
  ttl_until TEXT,
  memory_peak INTEGER,
  UNIQUE (project, generation)
);
