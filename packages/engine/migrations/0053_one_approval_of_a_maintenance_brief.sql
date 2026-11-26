-- One approval of an ordinary maintenance brief (DECISIONS item 57; the
-- owner's rulings D1 to D8 and WO1 Q1 of 2026-11-26). The schema only; what
-- writes and reads it is the engine's code, slice by slice.
--
-- Three closed enumerations grow, so four tables are rebuilt (SQLite cannot
-- widen a CHECK constraint in place, as 0045 and 0047 did); every row is kept
-- as it is:
--   - Authority += `policy` (protected_versions, protected_proposals,
--     findings): a check tightening applied and a fix registered under the
--     approved brief's authority (D2, D3), never recorded as the owner's;
--   - DecisionKind += `deployment_target_approval` (decisions): a deployment
--     to an environment other than the one the approved brief names (D4);
--   - FindingScope += `plan` (findings), with the plan and the specification
--     revision it is bound to and the scope the role reported, kept when it
--     is stored otherwise (D6).
-- The one trigger whose body names a rebuilt table is dropped for the
-- rebuild and recreated after it, unchanged.
--
-- Columns added:
--   - approvals.delegation (D7): who performed an answer the owner
--     authorized, as the caller stated it, canonical JSON {performed_by,
--     agent, instructed_by, instruction, scope}; NULL for every approval
--     recorded before this migration (not recorded, never inferred) and for
--     the owner's own act it is {"performed_by":"owner"};
--   - prototype_iterations.target_environment, target_config,
--     target_config_identity (D4): the environment the approved brief names
--     and its configuration as bound when the brief was approved;
--     preparation_authority and preparation_allowance (D8): who authorized
--     the iteration's preparation (`owner`, the decision, or `allowance`, the
--     project's preparation allowance, with its snapshot); clock_basis (D5):
--     `recorded` when the iteration's excluded intervals are recorded, NULL
--     for an iteration recorded before this migration;
--   - deployment_requests.restore (WO1 Q1): the restore of an earlier Alpha
--     a request is, canonical JSON {iteration, candidate, evaluation, scope,
--     spec_revision, protected_version}; NULL for every other request.
--
-- Tables added:
--   - prototype_clock_exclusions (D5): the intervals the runtime clock does
--     not charge, recorded when the facts change, never inferred; at most
--     one open interval per iteration and reason;
--   - delegated_actions (D1, D2, D3, D4, D7, D8): each act the engine
--     performed under an authority the owner gave beforehand (the brief's
--     decision, the preparation allowance, the policy revision), with what
--     authorized it, who performed it, its scope and its basis. Records
--     written before this migration (plan_bundles.approvals.policy_authorized,
--     deployment_requests.requested_by) stay as they were written.

PRAGMA foreign_keys = OFF;

DROP TRIGGER trust_entries_activation;

-- ---- decisions ----
CREATE TABLE decisions_0053 (
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
    'prototype_preparation_approval', 'deployment_target_approval')),
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
INSERT INTO decisions_0053 SELECT * FROM decisions;
DROP TABLE decisions;
ALTER TABLE decisions_0053 RENAME TO decisions;
CREATE INDEX decisions_by_subject ON decisions(subject_id, kind);
CREATE INDEX decisions_open ON decisions(project, status);
CREATE UNIQUE INDEX decisions_engine_identity ON decisions(kind, subject_type, subject_id, semantic_generation, scope) WHERE project IS NULL;

-- ---- protected_versions ----
CREATE TABLE protected_versions_0053 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  check_ids TEXT NOT NULL DEFAULT '[]',
  change_kind TEXT NOT NULL CHECK (change_kind IN ('initial', 'tightening', 'loosening', 'unclassifiable')),
  proposal TEXT REFERENCES protected_proposals(id),
  approved_by TEXT NOT NULL,
  approver_authority TEXT NOT NULL CHECK (approver_authority IN ('role', 'reviewer', 'human', 'policy')),
  approved_at TEXT NOT NULL,
  applied_by_operation TEXT REFERENCES operations(id),
  authorized INTEGER NOT NULL CHECK (authorized IN (0, 1)),
  effective_from TEXT,
  superseded_by TEXT REFERENCES protected_versions(id),
  roots TEXT NOT NULL,
  discovery_errors TEXT NOT NULL DEFAULT '[]',
  governed TEXT,
  fingerprint_scheme TEXT NOT NULL DEFAULT 'pairs' CHECK (fingerprint_scheme IN ('pairs', 'manifest', 'unreadable')),
  authorized_revision TEXT,
  UNIQUE (project, seq)
);
INSERT INTO protected_versions_0053 (
  id, created_at, project, seq, fingerprint, check_ids, change_kind, proposal, approved_by, approver_authority, approved_at,
  applied_by_operation, authorized, effective_from, superseded_by, roots, discovery_errors, governed, fingerprint_scheme, authorized_revision)
SELECT
  id, created_at, project, seq, fingerprint, check_ids, change_kind, proposal, approved_by, approver_authority, approved_at,
  applied_by_operation, authorized, effective_from, superseded_by, roots, discovery_errors, governed, fingerprint_scheme, authorized_revision
FROM protected_versions;
DROP TABLE protected_versions;
ALTER TABLE protected_versions_0053 RENAME TO protected_versions;
CREATE UNIQUE INDEX protected_versions_one_effective ON protected_versions(project)
  WHERE authorized = 1 AND effective_from IS NOT NULL AND superseded_by IS NULL;
CREATE UNIQUE INDEX protected_versions_one_per_proposal ON protected_versions(proposal) WHERE proposal IS NOT NULL;

-- ---- protected_proposals ----
CREATE TABLE protected_proposals_0053 (
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
  approver_authority TEXT CHECK (approver_authority IN ('role', 'reviewer', 'human', 'policy')),
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
INSERT INTO protected_proposals_0053 SELECT * FROM protected_proposals;
DROP TABLE protected_proposals;
ALTER TABLE protected_proposals_0053 RENAME TO protected_proposals;

-- ---- findings ----
CREATE TABLE findings_0053 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'lineage', 'candidate', 'plan')),
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
  disposition_authority TEXT CHECK (disposition_authority IN ('role', 'reviewer', 'human', 'policy')),
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
  proposed_alpha_exception TEXT,
  criterion TEXT,
  remediation TEXT,
  created_seq INTEGER,
  -- D6: a finding of scope `plan` is bound to the phase plan and the
  -- specification revision whose coverage it reports; NULL otherwise.
  bound_plan TEXT REFERENCES phase_plans(id),
  bound_spec_revision TEXT REFERENCES spec_revisions(id),
  -- The scope the role reported and why the finding is stored otherwise;
  -- NULL when it is stored as reported, and for every finding recorded
  -- before this migration.
  scope_reason TEXT,
  UNIQUE (project, seq)
);
INSERT INTO findings_0053 (
  id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, "check",
  proposed_severity, effective_severity, severity_history, sensitive_area, status, disposition, disposition_authority,
  disposition_by, disposition_at, disposition_seq, linked_issue, defer_target, reevaluations, alpha_exception,
  resolution_verification, proposed_disposition, proposed_severity_change, proposed_alpha_exception, criterion, remediation, created_seq)
SELECT
  id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, "check",
  proposed_severity, effective_severity, severity_history, sensitive_area, status, disposition, disposition_authority,
  disposition_by, disposition_at, disposition_seq, linked_issue, defer_target, reevaluations, alpha_exception,
  resolution_verification, proposed_disposition, proposed_severity_change, proposed_alpha_exception, criterion, remediation, created_seq
FROM findings;
DROP TABLE findings;
ALTER TABLE findings_0053 RENAME TO findings;

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

-- ---- added columns ----
ALTER TABLE approvals ADD COLUMN delegation TEXT;

ALTER TABLE prototype_iterations ADD COLUMN target_environment TEXT REFERENCES environments(id);
ALTER TABLE prototype_iterations ADD COLUMN target_config TEXT REFERENCES environment_configs(id);
ALTER TABLE prototype_iterations ADD COLUMN target_config_identity TEXT;
ALTER TABLE prototype_iterations ADD COLUMN preparation_authority TEXT CHECK (preparation_authority IN ('owner', 'allowance'));
ALTER TABLE prototype_iterations ADD COLUMN preparation_allowance TEXT;
ALTER TABLE prototype_iterations ADD COLUMN clock_basis TEXT CHECK (clock_basis IN ('recorded'));

ALTER TABLE deployment_requests ADD COLUMN restore TEXT;

-- ---- prototype_clock_exclusions (D5) ----
CREATE TABLE prototype_clock_exclusions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  iteration TEXT NOT NULL REFERENCES prototype_iterations(id),
  reason TEXT NOT NULL CHECK (reason IN ('parked_on_blocker', 'paused', 'engine_stall', 'provider_refusal')),
  -- What the interval is about (a work item, a decision, a run, the
  -- project's pause) and its id.
  cause_kind TEXT,
  cause_id TEXT,
  from_at TEXT NOT NULL,
  from_seq INTEGER,
  -- NULL while the interval is open.
  to_at TEXT,
  to_seq INTEGER,
  seconds INTEGER CHECK (seconds IS NULL OR seconds >= 0)
);
CREATE INDEX prototype_clock_exclusions_by_iteration ON prototype_clock_exclusions(iteration, from_at);
CREATE UNIQUE INDEX prototype_clock_exclusions_one_open ON prototype_clock_exclusions(iteration, reason) WHERE to_at IS NULL;

-- ---- delegated_actions (D1, D2, D3, D4, D7, D8) ----
CREATE TABLE delegated_actions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  iteration TEXT REFERENCES prototype_iterations(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'plan_published', 'tightening_applied', 'fix_registered', 'deployment_requested',
    'preparation_by_allowance', 'deployment_target_approved')),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  authorized_by_kind TEXT NOT NULL CHECK (authorized_by_kind IN ('decision', 'allowance', 'policy_revision')),
  authorized_by TEXT,
  performed_by TEXT NOT NULL,
  -- Canonical JSON: the bounds the act was within, and what the engine
  -- computed to establish it.
  scope TEXT NOT NULL DEFAULT '{}',
  basis TEXT NOT NULL DEFAULT '{}',
  -- The store order of the act: the highest event seq when it was recorded.
  seq INTEGER
);
CREATE INDEX delegated_actions_by_iteration ON delegated_actions(project, iteration);
CREATE INDEX delegated_actions_by_subject ON delegated_actions(subject_type, subject_id);
