-- M2 slice 10: the store schema of D2 A.3 (host qualifications, qualification
-- attempts, trust entries; the launch state of a domain; exit classes; the
-- unknown allowance) and the decision kinds and record kinds D2 A.2 adds.
--
-- SQLite cannot widen a CHECK constraint in place, so `decisions` and
-- `records` are rebuilt with the same columns, in the same order, and their
-- rows copied; the migration runner applies a batch with foreign keys off and
-- checks every foreign key before it commits (SEAM.md §5).

-- ---- decisions: qualification_approval and trust_activation (D2 A.2, A.7) ----

CREATE TABLE decisions_0007 (
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
    'retire', 'reactivate', 'policy_widening', 'qualification_approval', 'trust_activation')),
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
INSERT INTO decisions_0007 SELECT * FROM decisions;
DROP TABLE decisions;
ALTER TABLE decisions_0007 RENAME TO decisions;
CREATE INDEX decisions_by_subject ON decisions(subject_id, kind);
CREATE INDEX decisions_open ON decisions(project, status);

-- ---- records: the four kinds D2 A.2 adds ----

CREATE TABLE records_0007 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'transcript', 'tool_output', 'check_output', 'result', 'raw_user_report', 'parked_result',
    'proposal_rationale', 'assessment_evidence', 'containment_evidence', 'recovery_plan',
    'provider_files', 'egress_log', 'qualification_evidence', 'unaccepted_result')),
  path TEXT,
  sha256 TEXT,
  bytes INTEGER,
  redaction_version TEXT NOT NULL,
  published INTEGER NOT NULL CHECK (published IN (0, 1)),
  post_scan TEXT NOT NULL CHECK (post_scan IN ('pending', 'clean', 'hit')),
  -- References findings, which slice 5 creates.
  post_scan_finding TEXT,
  retain_until TEXT,
  -- Engine-owned: the run whose output the record holds, when it was
  -- published, and since when its referenced bytes are known to be missing
  -- or corrupt.
  run TEXT REFERENCES runs(id),
  published_at TEXT,
  missing_at TEXT,
  CHECK (published = 0 OR (sha256 IS NOT NULL AND bytes IS NOT NULL))
);
INSERT INTO records_0007 SELECT * FROM records;
DROP TABLE records;
ALTER TABLE records_0007 RENAME TO records;
CREATE INDEX records_by_run ON records(run);
CREATE INDEX records_by_project ON records(project, published);

-- ---- host_qualifications (D2 §§6, 7.1, A.3) ----
--
-- One row per qualifying start. `checks`, `probes`, `tool_versions` are JSON
-- text. Only the current incarnation's row can be active; every start lapses
-- the rows of earlier incarnations, and a lapsed row is never reactivated. No
-- row is active while the bootstrap exception is in force (D2 §2.6, N05).

CREATE TABLE host_qualifications (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  host_id TEXT NOT NULL,
  kernel TEXT NOT NULL,
  tool_versions TEXT NOT NULL,
  mechanism_fingerprint TEXT NOT NULL,
  checks TEXT NOT NULL,
  probes TEXT NOT NULL,
  bootstrap_exception INTEGER NOT NULL CHECK (bootstrap_exception IN (0, 1)),
  evidence TEXT NOT NULL REFERENCES records(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'lapsed')),
  incarnation TEXT NOT NULL REFERENCES engine_incarnations(id),
  qualified_at TEXT NOT NULL,
  lapsed_at TEXT,
  lapsed_reason TEXT,
  CHECK (status <> 'active' OR bootstrap_exception = 0),
  CHECK (status <> 'lapsed' OR lapsed_at IS NOT NULL)
);
CREATE UNIQUE INDEX host_qualifications_one_active ON host_qualifications(status) WHERE status = 'active';

-- active → lapsed only; a lapsed row is never reactivated (D2 A.4).
CREATE TRIGGER host_qualifications_never_reactivated BEFORE UPDATE OF status ON host_qualifications
WHEN OLD.status = 'lapsed' AND NEW.status <> 'lapsed'
BEGIN SELECT RAISE(ABORT, 'host_qualifications: a lapsed row is never reactivated'); END;

-- ---- qualification_attempts (D2 §7.2, K10, A.3) ----
--
-- `candidate_egress`, `canary_deadlines`, `spend`, `canaries` and
-- `unexpected_contacts` are JSON text.

CREATE TABLE qualification_attempts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  backend TEXT NOT NULL,
  version TEXT NOT NULL,
  binary_path TEXT NOT NULL,
  binary_sha256 TEXT NOT NULL,
  help_sha256 TEXT NOT NULL,
  template TEXT NOT NULL,
  template_version TEXT NOT NULL,
  model TEXT NOT NULL,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('api_key')),
  host_qualification TEXT NOT NULL REFERENCES host_qualifications(id),
  profile_fingerprint TEXT NOT NULL,
  fixture_project TEXT NOT NULL REFERENCES projects(id),
  candidate_egress TEXT NOT NULL,
  canary_deadlines TEXT NOT NULL,
  spend TEXT NOT NULL,
  decision TEXT REFERENCES decisions(id),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'authorized', 'running', 'succeeded', 'failed', 'invalidated')),
  canaries TEXT NOT NULL DEFAULT '[]',
  unexpected_contacts TEXT NOT NULL DEFAULT '[]',
  trust_entry TEXT REFERENCES trust_entries(id),
  invalidated_reason TEXT
);

-- ---- trust_entries (D2 §§4.1, 4.2, 7.3, A.3) ----
--
-- `capabilities`, `egress_hosts`, `enforceable_boundaries`, `provider_files`
-- and `evidence` are JSON text. The store refuses an active entry without
-- the consumed trust_activation decision that activated it (M102), an active
-- session-mode entry (D2 §1.8), an active entry whose canaries observed no
-- usage (D2 §4.2), and any isolation or boundary but D2's mechanisms (C3).

CREATE TABLE trust_entries (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  backend TEXT NOT NULL,
  version TEXT NOT NULL,
  binary_path TEXT NOT NULL,
  binary_sha256 TEXT NOT NULL,
  help_sha256 TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('one_shot_headless', 'session_headless')),
  template TEXT NOT NULL,
  template_version TEXT NOT NULL,
  model TEXT NOT NULL,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('api_key')),
  capabilities TEXT NOT NULL,
  host_id TEXT NOT NULL,
  host_qualification TEXT NOT NULL REFERENCES host_qualifications(id),
  isolation TEXT NOT NULL CHECK (isolation IN ('linux_namespaces_d2')),
  boundary TEXT NOT NULL CHECK (boundary IN ('cgroup2_user_delegated_d2')),
  profile_fingerprint TEXT NOT NULL,
  egress_hosts TEXT NOT NULL,
  usage_granularity TEXT NOT NULL CHECK (usage_granularity IN ('model_call', 'invocation', 'none')),
  usage_semantics TEXT CHECK (usage_semantics IN ('cumulative', 'delta')),
  cost_reporting TEXT NOT NULL CHECK (cost_reporting IN ('reported', 'tokens_only', 'none')),
  enforceable_boundaries TEXT NOT NULL,
  result_channel TEXT NOT NULL CHECK (result_channel IN ('file')),
  session_qualified INTEGER NOT NULL CHECK (session_qualified IN (0, 1)),
  provider_files TEXT NOT NULL,
  term_to_exit_ms INTEGER,
  qualification_attempt TEXT NOT NULL REFERENCES qualification_attempts(id),
  evidence TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'revoked')),
  activated_by TEXT REFERENCES decisions(id),
  revoked_at TEXT,
  revoked_reason TEXT,
  CHECK (status <> 'active' OR activated_by IS NOT NULL),
  CHECK (status <> 'active' OR mode = 'one_shot_headless'),
  CHECK (status <> 'active' OR usage_granularity <> 'none'),
  CHECK (session_qualified = 0),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);

-- `active` is reached only from `proposed`, only with the consumed
-- trust_activation decision about this entry (D2 §4.1, A.4); `revoked` has no
-- exit; nothing that defines what was qualified changes once written.
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
CREATE TRIGGER trust_entries_insert_not_active BEFORE INSERT ON trust_entries
WHEN NEW.status <> 'proposed'
BEGIN SELECT RAISE(ABORT, 'trust_entries: an entry is written proposed'); END;
CREATE TRIGGER trust_entries_revoked_final BEFORE UPDATE OF status ON trust_entries
WHEN OLD.status = 'revoked' AND NEW.status <> 'revoked'
BEGIN SELECT RAISE(ABORT, 'trust_entries: a revoked entry has no exit'); END;
CREATE TRIGGER trust_entries_qualified_fields_frozen BEFORE UPDATE OF
  backend, version, binary_path, binary_sha256, help_sha256, mode, template, template_version, model, auth_mode, capabilities,
  host_id, host_qualification, isolation, boundary, profile_fingerprint, egress_hosts, usage_granularity, usage_semantics,
  cost_reporting, enforceable_boundaries, result_channel, session_qualified, provider_files, term_to_exit_ms,
  qualification_attempt, evidence, evidence_fingerprint ON trust_entries
BEGIN SELECT RAISE(ABORT, 'trust_entries: what was qualified does not change; a change is a new attempt'); END;
CREATE TRIGGER trust_entries_no_delete BEFORE DELETE ON trust_entries
BEGIN SELECT RAISE(ABORT, 'trust_entries: an entry is revoked, never deleted'); END;

-- ---- columns D2 A.3 adds to earlier tables ----

ALTER TABLE engine_incarnations ADD COLUMN scope_cgroup TEXT;

ALTER TABLE execution_domains ADD COLUMN profile TEXT NOT NULL DEFAULT 'role' CHECK (profile IN ('role', 'probe', 'check'));
ALTER TABLE execution_domains ADD COLUMN cgroup_path TEXT;
ALTER TABLE execution_domains ADD COLUMN placed_at TEXT;
ALTER TABLE execution_domains ADD COLUMN launch_state TEXT NOT NULL DEFAULT 'authorizable' CHECK (launch_state IN ('authorizable', 'authorized', 'closed'));
ALTER TABLE execution_domains ADD COLUMN launch_binding TEXT;
ALTER TABLE execution_domains ADD COLUMN launch_authorized_at TEXT;
ALTER TABLE execution_domains ADD COLUMN launch_closed_at TEXT;
ALTER TABLE execution_domains ADD COLUMN observation TEXT CHECK (observation IN ('running', 'terminated', 'unknown'));
ALTER TABLE execution_domains ADD COLUMN observed_at TEXT;
ALTER TABLE execution_domains ADD COLUMN resource_events TEXT;

ALTER TABLE invocation_receipts ADD COLUMN trust_entry TEXT REFERENCES trust_entries(id);
ALTER TABLE invocation_receipts ADD COLUMN qualification_attempt TEXT REFERENCES qualification_attempts(id);

ALTER TABLE invocation_status_observations ADD COLUMN exit_class TEXT
  CHECK (exit_class IN ('engine_signaled', 'unknown', 'resource_limit', 'foreign_signal', 'clean', 'error_exit'));
ALTER TABLE invocation_status_observations ADD COLUMN exit_evidence TEXT;

-- C4: the run's budget_run_billable_tokens less the billable tokens observed,
-- not below zero, on the original row of an invocation whose usage is
-- incomplete; null when none is charged.
ALTER TABLE ledger_rows ADD COLUMN unknown_allowance_tokens INTEGER CHECK (unknown_allowance_tokens IS NULL OR unknown_allowance_tokens >= 0);

-- Engine-owned. A Reviewer's Alpha exception proposal awaiting the human
-- (D2 §5 C1), and what a run's report proposed that the engine refused before
-- raising anything, shown on the run read.
ALTER TABLE findings ADD COLUMN proposed_alpha_exception TEXT;
ALTER TABLE runs ADD COLUMN report_refusals TEXT;

-- Engine-owned. A Reviewer's approval of a tightening is a recommendation
-- until D3's classifier is qualified (D2 §5 C2, K8): recorded, never applied.
ALTER TABLE protected_proposals ADD COLUMN recommendations TEXT NOT NULL DEFAULT '[]';
