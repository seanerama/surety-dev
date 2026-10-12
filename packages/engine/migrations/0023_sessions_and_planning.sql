-- M5 slice 31a (D6 draft 3 §§2, 3, 5; Appendix A.3; K4, K6, K7): sessions as
-- runs of settled turns, the idea record, the specification's revisions and
-- semantic representation, the Architect's revisions, the prospective bundle
-- and its plan check, K4's plan and stage fields, and `check_authoring` work.
--
-- Three tables are rebuilt because SQLite cannot change a CHECK constraint
-- or a NOT NULL in place (as 0017 to 0019 did): `runs`, whose `work_item`
-- a session run has none of (the driver's provisional reading of D1 A.3,
-- slice 31: nullable for kind `session` only); `work_items`, whose kind
-- gains `check_authoring`; `records`, whose kind gains the three D6 adds.

PRAGMA foreign_keys = OFF;

-- The one trigger whose body names `runs` (0001): dropped for the rebuild and
-- recreated after it, unchanged.
DROP TRIGGER invocation_receipts_turn_matches_run;

-- ---- runs: work_item nullable for sessions; the idle generation (B01) ------------------

CREATE TABLE runs_0023 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  work_item TEXT REFERENCES work_items(id),
  role TEXT NOT NULL CHECK (role IN (
    'vision', 'spec_writer', 'architect', 'builder', 'verifier', 'reviewer', 'release_operator', 'mechanic')),
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
  turn_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project, seq),
  CHECK (kind = 'session' OR work_item IS NOT NULL)
);
INSERT INTO runs_0023 (
  id, created_at, project, seq, work_item, role, kind, state, session_state, outcome, reason_class, reason_text, backend, backend_version,
  model_requested, model_observed, "grant", base_revision, deadline_at, started_at, finished_at, parent_run, provider_session_id, quarantined,
  workspace, result_value, reason_detail, chain, transcript, result, report_recorded, content_hash, alpha_exception_outcomes, collection)
SELECT
  id, created_at, project, seq, work_item, role, kind, state, session_state, outcome, reason_class, reason_text, backend, backend_version,
  model_requested, model_observed, "grant", base_revision, deadline_at, started_at, finished_at, parent_run, provider_session_id, quarantined,
  workspace, result_value, reason_detail, chain, transcript, result, report_recorded, content_hash, alpha_exception_outcomes, collection
FROM runs;
DROP TABLE runs;
ALTER TABLE runs_0023 RENAME TO runs;
CREATE INDEX runs_by_state ON runs(state);
CREATE INDEX runs_by_work_item ON runs(work_item);
CREATE TRIGGER invocation_receipts_turn_matches_run BEFORE INSERT ON invocation_receipts
BEGIN
  SELECT RAISE(ABORT, 'invocation_receipts: turn nullability disagrees with the run kind')
  WHERE (NEW.turn IS NULL) IS NOT (COALESCE((SELECT kind FROM runs WHERE id = NEW.run), '') = 'one_shot');
  SELECT RAISE(ABORT, 'invocation_receipts: the turn belongs to another run')
  WHERE NEW.turn IS NOT NULL AND COALESCE((SELECT run FROM turns WHERE id = NEW.turn), '') <> NEW.run;
END;

-- ---- work_items: check_authoring (K7); the boundary passed (K3) ------------------------

CREATE TABLE work_items_0023 (
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
  boundary_passed_at TEXT,
  UNIQUE (project, seq),
  UNIQUE (project, trigger_source, trigger_id, trigger_generation)
);
INSERT INTO work_items_0023 (
  id, created_at, project, seq, kind, subject, status, blocker, depends_on, trigger_source, trigger_id, trigger_generation, trigger_consumed_at,
  repair_attempts, no_progress_count, progress_key, preflight_refusals, prior_status, dispatch_hold, continuation, repair_due, chain, continue_from,
  profile, qualification_attempt, canary_kind, check_repair, check_conflict)
SELECT
  id, created_at, project, seq, kind, subject, status, blocker, depends_on, trigger_source, trigger_id, trigger_generation, trigger_consumed_at,
  repair_attempts, no_progress_count, progress_key, preflight_refusals, prior_status, dispatch_hold, continuation, repair_due, chain, continue_from,
  profile, qualification_attempt, canary_kind, check_repair, check_conflict
FROM work_items;
DROP TABLE work_items;
ALTER TABLE work_items_0023 RENAME TO work_items;
CREATE INDEX work_items_by_status ON work_items(project, status);

-- ---- records: the three kinds D6 A.2 adds ----------------------------------------------

CREATE TABLE records_0023 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'transcript', 'tool_output', 'check_output', 'result', 'raw_user_report', 'parked_result',
    'proposal_rationale', 'assessment_evidence', 'containment_evidence', 'recovery_plan',
    'provider_files', 'egress_log', 'qualification_evidence', 'unaccepted_result',
    'deployment_logs', 'service_link_log', 'deploy_precondition_manifest',
    'session_transcript', 'spec_impact', 'plan_check')),
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
INSERT INTO records_0023 SELECT * FROM records;
DROP TABLE records;
ALTER TABLE records_0023 RENAME TO records;
CREATE INDEX records_by_run ON records(run);
CREATE INDEX records_by_project ON records(project, published);

PRAGMA foreign_keys = ON;

-- ---- turns: settlement (B01) ----------------------------------------------------------

ALTER TABLE turns ADD COLUMN settled_at TEXT;
ALTER TABLE turns ADD COLUMN usage_status TEXT CHECK (usage_status IS NULL OR usage_status IN ('recorded', 'unknown'));
ALTER TABLE turns ADD COLUMN outcome TEXT CHECK (outcome IS NULL OR outcome IN ('replied', 'failed', 'unknown'));
-- The role's accepted reply as the engine took it (B.7), or the failure.
ALTER TABLE turns ADD COLUMN reply TEXT;

-- ---- the session transcript (D6 §2.3; A.3): one record per session ----------------------
-- `entries` [{turn, speaker, at, text_ref →records, text}], appended by engine
-- transitions only (B01): `speaker` and `turn` are theirs, never a role's.

CREATE TABLE session_transcripts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT NOT NULL UNIQUE REFERENCES runs(id),
  entries TEXT NOT NULL DEFAULT '[]'
);

-- ---- projects: the idea record, the spec-evidence generation ---------------------------

-- null: no idea record (M1's create); 1 at the create with `idea`; n+1 at each
-- accepted Vision product. `idea_history` keeps every binding (reading 5).
ALTER TABLE projects ADD COLUMN idea_version INTEGER;
ALTER TABLE projects ADD COLUMN idea_history TEXT NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN idea_blob TEXT;
ALTER TABLE projects ADD COLUMN idea_identity TEXT;
ALTER TABLE projects ADD COLUMN spec_evidence_generation INTEGER NOT NULL DEFAULT 0;

-- ---- the specification (D6 §3.2, §4.1; B04) -------------------------------------------

-- One row per save and per approved revision: the representation of B.2
-- parsed from the committed blob, with the engine's findings.
CREATE TABLE spec_semantics (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT REFERENCES runs(id),
  git_blob TEXT NOT NULL,
  semantic_digest TEXT,
  representation TEXT,
  findings TEXT NOT NULL DEFAULT '[]',
  readable INTEGER NOT NULL CHECK (readable IN (0, 1))
);
CREATE INDEX spec_semantics_by_project ON spec_semantics(project, created_at);

CREATE TABLE spec_revisions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  git_path TEXT NOT NULL,
  git_blob TEXT NOT NULL,
  semantic_digest TEXT NOT NULL,
  semantics TEXT REFERENCES spec_semantics(id),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  supersedes TEXT REFERENCES spec_revisions(id),
  decision TEXT REFERENCES decisions(id),
  UNIQUE (project, version)
);

ALTER TABLE requirements ADD COLUMN spec_revision TEXT REFERENCES spec_revisions(id);
ALTER TABLE requirements ADD COLUMN human_test INTEGER NOT NULL DEFAULT 0 CHECK (human_test IN (0, 1));
ALTER TABLE requirements ADD COLUMN descriptive INTEGER NOT NULL DEFAULT 0 CHECK (descriptive IN (0, 1));
ALTER TABLE requirements ADD COLUMN withdrawn_at TEXT;
ALTER TABLE requirements ADD COLUMN origin TEXT NOT NULL DEFAULT 'intended' CHECK (origin IN ('intended', 'observed'));
ALTER TABLE requirements ADD COLUMN defect INTEGER NOT NULL DEFAULT 0 CHECK (defect IN (0, 1));
ALTER TABLE requirements ADD COLUMN reverse_engineered INTEGER NOT NULL DEFAULT 0 CHECK (reverse_engineered IN (0, 1));
ALTER TABLE requirements ADD COLUMN confirmed_at TEXT;
ALTER TABLE requirements ADD COLUMN criteria_text TEXT;

-- ---- the Architect's revisions (D6 §3.3, §5.1) ----------------------------------------

CREATE TABLE architecture_revisions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  spec_revision TEXT REFERENCES spec_revisions(id),
  -- {path: blob} of every architecture, module-map and ADR file published.
  blobs TEXT NOT NULL,
  module_map TEXT NOT NULL,
  mapping_from_spec TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  decision TEXT REFERENCES decisions(id),
  UNIQUE (project, version)
);

CREATE TABLE roadmap_revisions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  architecture_revision TEXT REFERENCES architecture_revisions(id),
  git_path TEXT NOT NULL,
  git_blob TEXT NOT NULL,
  phases TEXT NOT NULL,
  moved_requirements TEXT,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  UNIQUE (project, version)
);

-- ---- the prospective bundle and the plan check (D6 §3.4, §5.3 to §5.5; B02, B03) -------

-- The bundle's id is the id of the `records` row (kind plan_check) the close
-- wrote with the bundle's content (A.3 `phase_plans.bundle →records`).
CREATE TABLE plan_bundles (
  id TEXT PRIMARY KEY REFERENCES records(id),
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT REFERENCES runs(id),
  -- What the bundle is checked against: the approved spec revision (or none
  -- yet) and the integration head whose tree holds the blobs.
  spec_revision TEXT REFERENCES spec_revisions(id),
  head TEXT NOT NULL,
  -- null for an architecture-only bundle (a later Architect session, D6 §3.4).
  phase_number INTEGER,
  -- {path: blob} of every proposed artifact, and the artifacts as parsed by
  -- Appendix B's closed schemas (what publication writes from).
  blobs TEXT NOT NULL,
  artifacts TEXT NOT NULL,
  -- The versions publication will allocate: {architecture, roadmap, plan_generation}.
  versions TEXT NOT NULL,
  plan_check TEXT REFERENCES plan_checks(id),
  batch_key TEXT,
  -- The consumed approvals, by decision kind: {architecture_approval, plan_approval}.
  approvals TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('proposed', 'published', 'stale', 'refused')),
  published_at TEXT,
  stale_reason TEXT
);
CREATE INDEX plan_bundles_by_project ON plan_bundles(project, status);

CREATE TABLE plan_checks (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  bundle TEXT REFERENCES plan_bundles(id),
  plan TEXT REFERENCES phase_plans(id),
  phase_number INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'refused')),
  reasons TEXT NOT NULL,
  conformance TEXT NOT NULL CHECK (conformance IN ('within_baseline', 'uncertain')),
  changes_architecture TEXT NOT NULL,
  changes_adrs TEXT NOT NULL,
  changes_roadmap TEXT NOT NULL,
  changes_goals INTEGER NOT NULL CHECK (changes_goals IN (0, 1)),
  roadmap_revision INTEGER NOT NULL CHECK (roadmap_revision IN (0, 1)),
  needs_spec_change INTEGER NOT NULL CHECK (needs_spec_change IN (0, 1)),
  routing TEXT CHECK (routing IS NULL OR routing IN ('registered', 'human')),
  -- The planned obligations per scope, as a record (A.3 →records) and inline.
  planned_obligations TEXT REFERENCES records(id),
  obligations TEXT NOT NULL,
  evidence TEXT
);

-- ---- phase_plans and stages: K4's fields; the generation and the binding (B02, B06, B08)

ALTER TABLE phase_plans ADD COLUMN prepared_against_spec TEXT REFERENCES spec_revisions(id);
ALTER TABLE phase_plans ADD COLUMN prepared_against_architecture TEXT REFERENCES architecture_revisions(id);
ALTER TABLE phase_plans ADD COLUMN prepared_against_roadmap TEXT REFERENCES roadmap_revisions(id);
ALTER TABLE phase_plans ADD COLUMN roadmap_revision TEXT REFERENCES roadmap_revisions(id);
ALTER TABLE phase_plans ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE phase_plans ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));
ALTER TABLE phase_plans ADD COLUMN bundle TEXT REFERENCES plan_bundles(id);
ALTER TABLE phase_plans ADD COLUMN "check" TEXT REFERENCES plan_checks(id);
ALTER TABLE phase_plans ADD COLUMN routing TEXT CHECK (routing IS NULL OR routing IN ('registered', 'human'));
ALTER TABLE phase_plans ADD COLUMN status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('proposed', 'published', 'completed', 'replaced', 'stale'));
ALTER TABLE phase_plans ADD COLUMN published_at TEXT;
ALTER TABLE phase_plans ADD COLUMN authoring_ready_at TEXT;
ALTER TABLE phase_plans ADD COLUMN authoring_ready_by TEXT;
ALTER TABLE phase_plans ADD COLUMN completed_at TEXT;
ALTER TABLE phase_plans ADD COLUMN completion_binding TEXT;
ALTER TABLE phase_plans ADD COLUMN planned_obligations TEXT REFERENCES records(id);
ALTER TABLE phase_plans ADD COLUMN verification TEXT;
ALTER TABLE phase_plans ADD COLUMN replaced_by TEXT REFERENCES phase_plans(id);
ALTER TABLE phase_plans ADD COLUMN check_authoring TEXT REFERENCES work_items(id);

ALTER TABLE stages ADD COLUMN tasks TEXT NOT NULL DEFAULT '[]';
ALTER TABLE stages ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';
ALTER TABLE stages ADD COLUMN validation TEXT NOT NULL DEFAULT '{"criteria":[],"kinds":[],"sensitive_areas":[]}';
ALTER TABLE stages ADD COLUMN integration_obligations TEXT NOT NULL DEFAULT '[]';
ALTER TABLE stages ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE stages ADD COLUMN execution_inputs_digest TEXT;
ALTER TABLE stages ADD COLUMN conformance INTEGER NOT NULL DEFAULT 0 CHECK (conformance IN (0, 1));
ALTER TABLE stages ADD COLUMN parked_at TEXT;
ALTER TABLE stages ADD COLUMN cancelled_at TEXT;
