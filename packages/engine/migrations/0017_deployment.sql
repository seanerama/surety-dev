-- M4 slice 23: the walking deployment (D4 §§1, 3 to 6, A.3; J1, J3, J4,
-- J5, J9; E111 to E115; BS4 §§3, 7). Columns marked engine-owned are not in
-- D4 A.3. Observation jobs and history, the service domain's owner (J2),
-- the checks' `secrets` and an environment subject of out-of-band changes
-- belong to later slices.

-- D4 §3.2, A.3: owner-written configuration versions. Immutable but for
-- `status`, which the engine moves at start (RV5) and by a new version.
-- `project` (engine-owned): the environment's project.
CREATE TABLE environment_configs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  environment TEXT NOT NULL REFERENCES environments(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  content TEXT NOT NULL,
  config_identity TEXT NOT NULL,
  secret_digests TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('current', 'secrets_changed', 'superseded')),
  written_by TEXT NOT NULL,
  written_at TEXT NOT NULL,
  UNIQUE (environment, version)
);
CREATE UNIQUE INDEX environment_configs_one_current ON environment_configs(environment) WHERE status <> 'superseded';

CREATE TRIGGER environment_configs_no_delete BEFORE DELETE ON environment_configs
BEGIN SELECT RAISE(ABORT, 'environment_configs: a version is never deleted'); END;
CREATE TRIGGER environment_configs_immutable BEFORE UPDATE OF id, created_at, project, environment, version, content, config_identity, secret_digests, written_by, written_at ON environment_configs
BEGIN SELECT RAISE(ABORT, 'environment_configs: a version is never edited; a change is a new version'); END;
CREATE TRIGGER environment_configs_superseded_final BEFORE UPDATE OF status ON environment_configs
WHEN OLD.status = 'superseded' AND NEW.status <> 'superseded'
BEGIN SELECT RAISE(ABORT, 'environment_configs: a superseded version stays superseded'); END;

-- D4 A.3 `environments`, added. `prefix`: the unit-name prefix, fixed when
-- the environment is created at its first configuration version (D4 §9.3).
ALTER TABLE environments ADD COLUMN current_config TEXT REFERENCES environment_configs(id);
ALTER TABLE environments ADD COLUMN deployment_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE environments ADD COLUMN current_generation INTEGER;
ALTER TABLE environments ADD COLUMN prefix TEXT;
-- Engine-owned: an ordinary teardown the operator asked for, not yet
-- intended (it waits for the environment lease, D4 §4.6).
ALTER TABLE environments ADD COLUMN teardown_requested_at TEXT;
CREATE UNIQUE INDEX environments_configured_name ON environments(project, name) WHERE prefix IS NOT NULL;

-- D4 §3.1, A.3: sealed bytes, one row per digest per project. `manifest`
-- (inline, engine-owned): the canonical manifest, the complete sorted list
-- of [path, type, mode, size, sha256].
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  digest TEXT NOT NULL,
  manifest TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sealed', 'failed')),
  sealed_at TEXT,
  refusal TEXT,
  bytes INTEGER NOT NULL,
  entries INTEGER NOT NULL,
  failed_at TEXT,
  UNIQUE (project, digest)
);
CREATE TRIGGER artifacts_no_delete BEFORE DELETE ON artifacts
BEGIN SELECT RAISE(ABORT, 'artifacts: a recorded artifact is never deleted'); END;
CREATE TRIGGER artifacts_immutable BEFORE UPDATE ON artifacts
WHEN NEW.digest IS NOT OLD.digest OR NEW.manifest IS NOT OLD.manifest OR NEW.path IS NOT OLD.path OR NEW.project IS NOT OLD.project
  OR NEW.bytes IS NOT OLD.bytes OR NEW.entries IS NOT OLD.entries
BEGIN SELECT RAISE(ABORT, 'artifacts: the sealed bytes are never redescribed'); END;
CREATE TRIGGER artifacts_failed_final BEFORE UPDATE OF status ON artifacts
WHEN OLD.status = 'failed' AND NEW.status <> 'failed'
BEGIN SELECT RAISE(ABORT, 'artifacts: a failed artifact is never sealed again'); END;

-- D4 §3.1 (RV3), A.3: one source-to-artifact mapping, immutable.
CREATE TABLE artifact_mappings (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  artifact TEXT NOT NULL REFERENCES artifacts(id),
  dev_revision TEXT NOT NULL,
  delivery_commit TEXT,
  config_version TEXT NOT NULL REFERENCES environment_configs(id),
  artifact_spec_fingerprint TEXT NOT NULL,
  builder TEXT NOT NULL,
  UNIQUE (artifact, dev_revision, config_version, artifact_spec_fingerprint, builder)
);
CREATE TRIGGER artifact_mappings_no_update BEFORE UPDATE ON artifact_mappings
BEGIN SELECT RAISE(ABORT, 'artifact_mappings is immutable'); END;
CREATE TRIGGER artifact_mappings_no_delete BEFORE DELETE ON artifact_mappings
BEGIN SELECT RAISE(ABORT, 'artifact_mappings is immutable'); END;

-- D4 §2.6, A.3. `label` (engine-owned): a label its writer gives the row, as
-- the runner qualification's fixture labels its own (E92 item 2).
CREATE TABLE adapter_qualifications (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  adapter TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  engine_build TEXT NOT NULL,
  host_qualification TEXT REFERENCES host_qualifications(id),
  profile_fingerprint TEXT NOT NULL,
  cases TEXT NOT NULL,
  evidence TEXT REFERENCES records(id),
  status TEXT NOT NULL CHECK (status IN ('current', 'lapsed')),
  qualified_at TEXT NOT NULL,
  lapsed_at TEXT,
  lapsed_reason TEXT,
  label TEXT
);
CREATE UNIQUE INDEX adapter_qualifications_one_current ON adapter_qualifications(adapter, adapter_version) WHERE status = 'current';
CREATE TRIGGER adapter_qualifications_never_current_again BEFORE UPDATE OF status ON adapter_qualifications
WHEN OLD.status = 'lapsed' AND NEW.status <> 'lapsed'
BEGIN SELECT RAISE(ABORT, 'adapter_qualifications: a lapsed row is never current again'); END;

-- D4 §4.7, A.3 `operations`, added. `authorization` (engine-owned): the
-- deployment authorization a deploy operation consumed.
ALTER TABLE operations ADD COLUMN orchestration_deadline_at TEXT;
ALTER TABLE operations ADD COLUMN orchestration_stage TEXT CHECK (orchestration_stage IN ('effect', 'verification', 'completion', 'ended'));
ALTER TABLE operations ADD COLUMN "authorization" TEXT REFERENCES deployment_authorizations(id);
CREATE UNIQUE INDEX operations_one_per_authorization ON operations("authorization") WHERE "authorization" IS NOT NULL;

-- D4 §§3.4, 4.2, A.3 `operation_attempts`, added.
ALTER TABLE operation_attempts ADD COLUMN deployment_generation INTEGER;
ALTER TABLE operation_attempts ADD COLUMN capability TEXT;
ALTER TABLE operation_attempts ADD COLUMN launch_state TEXT CHECK (launch_state IN ('authorizable', 'authorized', 'closed'));
ALTER TABLE operation_attempts ADD COLUMN init_instance TEXT;
ALTER TABLE operation_attempts ADD COLUMN app_instance TEXT;
ALTER TABLE operation_attempts ADD COLUMN receipt TEXT;

CREATE TRIGGER operation_attempts_app_instance_once BEFORE UPDATE OF app_instance ON operation_attempts
WHEN OLD.app_instance IS NOT NULL AND NEW.app_instance IS NOT OLD.app_instance
BEGIN SELECT RAISE(ABORT, 'operation_attempts: the original application instance is recorded once and never rebound'); END;
CREATE TRIGGER operation_attempts_launch_state BEFORE UPDATE OF launch_state ON operation_attempts
WHEN NEW.launch_state IS NOT OLD.launch_state
BEGIN
  SELECT RAISE(ABORT, 'operation_attempts: a closed launch is never reopened') WHERE OLD.launch_state = 'closed';
  SELECT RAISE(ABORT, 'operation_attempts: only an authorizable launch is authorized') WHERE NEW.launch_state = 'authorized' AND OLD.launch_state IS NOT 'authorizable';
END;

-- D4 §4.2, A.3 (AR B03, E112): an attempt's frozen intent. `operation` and
-- `resources` (engine-owned): its operation, and for a teardown the exact
-- resources it may stop and remove. `preconditions` (inline, engine-owned):
-- the precondition manifest, each fact and the dependency it read.
CREATE TABLE attempt_intents (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  operation TEXT NOT NULL REFERENCES operations(id),
  attempt TEXT NOT NULL UNIQUE REFERENCES operation_attempts(id),
  generation INTEGER NOT NULL,
  create_units TEXT NOT NULL,
  prior TEXT NOT NULL,
  cleanup TEXT NOT NULL,
  resources TEXT NOT NULL DEFAULT '[]',
  preconditions TEXT NOT NULL,
  retry_decision TEXT REFERENCES decisions(id)
);
CREATE TRIGGER attempt_intents_no_update BEFORE UPDATE ON attempt_intents
BEGIN SELECT RAISE(ABORT, 'attempt_intents is frozen with its attempt'); END;
CREATE TRIGGER attempt_intents_no_delete BEFORE DELETE ON attempt_intents
BEGIN SELECT RAISE(ABORT, 'attempt_intents is frozen with its attempt'); END;

-- J1: the journal of the deployment kinds, the sibling of git's with the
-- same shape and the same append-only events. Its probe is the adapter's
-- reconcile; its finalizer creates one verification round.
CREATE TABLE deploy_journal_state (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  operation TEXT NOT NULL UNIQUE REFERENCES operations(id),
  journal_kind TEXT NOT NULL CHECK (journal_kind IN ('deploy_apply', 'teardown_apply')),
  state TEXT NOT NULL CHECK (state IN ('intended', 'applied', 'confirmed', 'failed', 'ambiguous', 'finalized')),
  last_event_seq INTEGER NOT NULL
);
CREATE TABLE deploy_journal_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  operation TEXT NOT NULL REFERENCES operations(id),
  seq INTEGER NOT NULL,
  journal_kind TEXT NOT NULL CHECK (journal_kind IN ('deploy_apply', 'teardown_apply')),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('intended', 'applied', 'confirmed', 'failed', 'ambiguous', 'finalized')),
  payload TEXT NOT NULL,
  UNIQUE (operation, seq)
);
CREATE TRIGGER deploy_journal_events_no_update BEFORE UPDATE ON deploy_journal_events
BEGIN SELECT RAISE(ABORT, 'deploy_journal_events is append-only'); END;
CREATE TRIGGER deploy_journal_events_no_delete BEFORE DELETE ON deploy_journal_events
BEGIN SELECT RAISE(ABORT, 'deploy_journal_events is append-only'); END;

-- D4 §5.3, A.3 (AR B05, E114): a verification round, registered before any
-- read. `environment`, `deadline_at` (CD1: a later round's own deadline;
-- null for the first, bound by the operation's), `step`, `reads` and
-- `executions` (engine-owned): its environment, how far it has gone, the
-- identity reads it made and the executions it registered.
CREATE TABLE verification_rounds (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  operation TEXT NOT NULL REFERENCES operations(id),
  attempt TEXT NOT NULL REFERENCES operation_attempts(id),
  round INTEGER NOT NULL CHECK (round >= 1),
  candidate TEXT NOT NULL REFERENCES candidates(id),
  mapping TEXT NOT NULL REFERENCES artifact_mappings(id),
  environment TEXT NOT NULL REFERENCES environments(id),
  deployment_generation INTEGER NOT NULL,
  config_identity TEXT NOT NULL,
  protected_version TEXT NOT NULL REFERENCES protected_versions(id),
  required_checks TEXT NOT NULL,
  adapter_qualification TEXT REFERENCES adapter_qualifications(id),
  status TEXT NOT NULL CHECK (status IN ('open', 'decided', 'superseded')),
  superseded_reason TEXT,
  registered_at TEXT NOT NULL,
  deadline_at TEXT,
  step TEXT NOT NULL CHECK (step IN ('first_read', 'checks', 'second_read', 'done')),
  reads TEXT NOT NULL DEFAULT '[]',
  executions TEXT NOT NULL DEFAULT '[]',
  UNIQUE (attempt, round)
);
CREATE TRIGGER verification_rounds_bindings_frozen BEFORE UPDATE ON verification_rounds
WHEN NEW.operation IS NOT OLD.operation OR NEW.attempt IS NOT OLD.attempt OR NEW.round IS NOT OLD.round OR NEW.candidate IS NOT OLD.candidate
  OR NEW.mapping IS NOT OLD.mapping OR NEW.deployment_generation IS NOT OLD.deployment_generation OR NEW.config_identity IS NOT OLD.config_identity
  OR NEW.protected_version IS NOT OLD.protected_version OR NEW.required_checks IS NOT OLD.required_checks
  OR NEW.adapter_qualification IS NOT OLD.adapter_qualification OR NEW.deadline_at IS NOT OLD.deadline_at
BEGIN SELECT RAISE(ABORT, 'verification_rounds: a round''s bindings are frozen at its registration'); END;
CREATE TRIGGER verification_rounds_status BEFORE UPDATE OF status ON verification_rounds
WHEN OLD.status <> 'open' AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'verification_rounds: a decided or superseded round never changes'); END;

-- D1 A.3 and D4 A.3: one verification row per round.
CREATE TABLE deployment_verifications (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  environment TEXT NOT NULL REFERENCES environments(id),
  operation TEXT NOT NULL REFERENCES operations(id),
  attempt TEXT NOT NULL REFERENCES operation_attempts(id),
  round TEXT NOT NULL UNIQUE REFERENCES verification_rounds(id),
  deployment_generation INTEGER NOT NULL,
  candidate TEXT NOT NULL REFERENCES candidates(id),
  target_set TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  mapping TEXT NOT NULL REFERENCES artifact_mappings(id),
  config_identity TEXT NOT NULL,
  protected_version TEXT NOT NULL REFERENCES protected_versions(id),
  identity_reads TEXT NOT NULL,
  behavioral_results TEXT NOT NULL,
  adapter_qualification TEXT REFERENCES adapter_qualifications(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('verified', 'failed', 'unknown')),
  missing TEXT,
  computed_at TEXT NOT NULL,
  invalidated_at TEXT,
  invalidated_reason TEXT CHECK (invalidated_reason IN ('later_attempt', 'generation_superseded', 'round_superseded'))
);
CREATE TRIGGER deployment_verifications_no_delete BEFORE DELETE ON deployment_verifications
BEGIN SELECT RAISE(ABORT, 'deployment_verifications: obsolete evidence is kept as history'); END;
CREATE TRIGGER deployment_verifications_outcome_fixed BEFORE UPDATE ON deployment_verifications
WHEN NEW.outcome IS NOT OLD.outcome OR NEW.identity_reads IS NOT OLD.identity_reads OR NEW.behavioral_results IS NOT OLD.behavioral_results
  OR NEW.round IS NOT OLD.round OR NEW.deployment_generation IS NOT OLD.deployment_generation
  OR (OLD.invalidated_at IS NOT NULL AND (NEW.invalidated_at IS NOT OLD.invalidated_at OR NEW.invalidated_reason IS NOT OLD.invalidated_reason))
BEGIN SELECT RAISE(ABORT, 'deployment_verifications: a computed row is never relabelled'); END;

-- D4 A.3 `environment_records`, added: what the running service was
-- launched with (§3.2).
ALTER TABLE environment_records ADD COLUMN running TEXT;

-- D4 §5.1, A.3 `check_results`, added: the result's deployment binding.
ALTER TABLE check_results ADD COLUMN deployment TEXT;

-- J2: LeaseKind gains `environment`. Rebuilt as 0012 did, rows kept.
CREATE TABLE leases_0017 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('run', 'integration', 'workspace', 'quarantine', 'check', 'environment')),
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
INSERT INTO leases_0017 SELECT id, created_at, resource_kind, resource_id, owner_incarnation, generation, acquired_at, renewed_at, expires_at, released_at, closing, cleanup_authority FROM leases;
DROP TABLE leases;
ALTER TABLE leases_0017 RENAME TO leases;
CREATE UNIQUE INDEX leases_one_holder ON leases(resource_kind, resource_id) WHERE released_at IS NULL;
CREATE INDEX leases_by_resource ON leases(resource_id);

-- D4 A.2 RecordKind gains the deployment's records (the precondition
-- manifest of D4 §4.1; the logs and link records of later slices). Rebuilt
-- as 0007 did, rows kept.
CREATE TABLE records_0017 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'transcript', 'tool_output', 'check_output', 'result', 'raw_user_report', 'parked_result',
    'proposal_rationale', 'assessment_evidence', 'containment_evidence', 'recovery_plan',
    'provider_files', 'egress_log', 'qualification_evidence', 'unaccepted_result',
    'deployment_logs', 'service_link_log', 'deploy_precondition_manifest')),
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
INSERT INTO records_0017 SELECT * FROM records;
DROP TABLE records;
ALTER TABLE records_0017 RENAME TO records;
CREATE INDEX records_by_run ON records(run);
CREATE INDEX records_by_project ON records(project, published);
