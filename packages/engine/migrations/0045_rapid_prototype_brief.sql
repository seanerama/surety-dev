-- Rapid prototype to Alpha, slice E3 (the owner's rulings R1, R3 and R5 of
-- 2026-10-28): the brief, its preparation, and the first plan.
--
-- Four closed enumerations grow, so four tables are rebuilt (SQLite cannot
-- widen a CHECK constraint in place, as 0023 and 0032 did): `decisions`
-- (kind `prototype_preparation_approval`: the owner's bounded authorization
-- of one brief preparation run, R5), `records` (kind `prototype_brief`: the
-- brief as the console renders it), `work_items` (kind `brief_preparation`:
-- the Spec Writer's one-shot that prepares it), and `phase_plans` (routing
-- `policy_authorized`: a first plan published under the prototype policy,
-- R1, never recorded as a human approval). Every row is kept as it is; the
-- one trigger whose body names a rebuilt table is dropped for the rebuild and
-- recreated after it, unchanged.
--
-- And the iteration's current brief (two columns): the record that holds it
-- and the brief itself, as validated and completed by the engine, so that
-- what the engine checks against it (the first plan's bounds) reads the
-- store, not a file. A later preparation replaces both; the earlier record
-- stays, and the decision that bound it is invalidated.

PRAGMA foreign_keys = OFF;

DROP TRIGGER trust_entries_activation;

-- ---- decisions ----
CREATE TABLE decisions_0045 (
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
    'design_approval', 'design_due', 'design_verdicts',
    'prototype_preparation_approval')),
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
INSERT INTO decisions_0045 SELECT * FROM decisions;
DROP TABLE decisions;
ALTER TABLE decisions_0045 RENAME TO decisions;
CREATE INDEX decisions_by_subject ON decisions(subject_id, kind);
CREATE INDEX decisions_open ON decisions(project, status);
CREATE UNIQUE INDEX decisions_engine_identity ON decisions(kind, subject_type, subject_id, semantic_generation, scope) WHERE project IS NULL;

-- ---- records ----
CREATE TABLE records_0045 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'transcript', 'tool_output', 'check_output', 'result', 'raw_user_report', 'parked_result',
    'proposal_rationale', 'assessment_evidence', 'containment_evidence', 'recovery_plan',
    'provider_files', 'egress_log', 'qualification_evidence', 'unaccepted_result',
    'deployment_logs', 'service_link_log', 'deploy_precondition_manifest',
    'session_transcript', 'spec_impact', 'plan_check',
    'design_check', 'design_inventory', 'design_observation', 'design_evidence',
    'prototype_brief')),
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
INSERT INTO records_0045 SELECT * FROM records;
DROP TABLE records;
ALTER TABLE records_0045 RENAME TO records;
CREATE INDEX records_by_run ON records(run);
CREATE INDEX records_by_project ON records(project, published);

-- ---- work_items ----
CREATE TABLE work_items_0045 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'stage_build', 'fix', 'verification', 'review', 'phase_verification', 'replan', 'assessment',
    'spec_change', 'check_correction', 'check_authoring', 'triage_accept', 'export', 'publish', 'deploy', 'rollback',
    'adoption_baseline', 'conformance', 'brief_preparation')),
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
  boundary_passed_at TEXT, trigger_evidence TEXT, end_cause TEXT CHECK (end_cause IS NULL OR end_cause IN ('superseded', 'plan_replaced')), held_intervals TEXT, chain_origin TEXT, milestones_met TEXT, held TEXT CHECK (held IN (
  'resource_envelope', 'chain_boundary', 'depends_on', 'authoring_readiness', 'open_decision', 'session_busy', 'prerequisite_results',
  'design_pending', 'design_stale')),
  UNIQUE (project, seq),
  UNIQUE (project, trigger_source, trigger_id, trigger_generation)
);
INSERT INTO work_items_0045 SELECT * FROM work_items;
DROP TABLE work_items;
ALTER TABLE work_items_0045 RENAME TO work_items;
CREATE INDEX work_items_by_status ON work_items(project, status);

-- ---- phase_plans ----
CREATE TABLE phase_plans_0045 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  phase_number INTEGER NOT NULL,
  prepared_against_revision TEXT NOT NULL,
  git_path TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT
, prepared_against_spec TEXT REFERENCES spec_revisions(id), prepared_against_architecture TEXT REFERENCES architecture_revisions(id), prepared_against_roadmap TEXT REFERENCES roadmap_revisions(id), roadmap_revision TEXT REFERENCES roadmap_revisions(id), generation INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)), bundle TEXT REFERENCES plan_bundles(id), "check" TEXT REFERENCES plan_checks(id), routing TEXT CHECK (routing IS NULL OR routing IN ('registered', 'human', 'policy_authorized')), status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('proposed', 'published', 'completed', 'replaced', 'stale')), published_at TEXT, authoring_ready_at TEXT, authoring_ready_by TEXT, completed_at TEXT, completion_binding TEXT, planned_obligations TEXT REFERENCES records(id), verification TEXT, replaced_by TEXT REFERENCES phase_plans(id), check_authoring TEXT REFERENCES work_items(id), replacement TEXT);
INSERT INTO phase_plans_0045 SELECT * FROM phase_plans;
DROP TABLE phase_plans;
ALTER TABLE phase_plans_0045 RENAME TO phase_plans;

-- ---- the iteration's current brief ----
ALTER TABLE prototype_iterations ADD COLUMN brief_record TEXT REFERENCES records(id);
ALTER TABLE prototype_iterations ADD COLUMN brief_json TEXT;

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
