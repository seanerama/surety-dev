-- M3 slice 15: the walking check (D3 §§1, 2.1 to 2.7, A.2, A.3, A.5; L1, L2,
-- L7; SEAM.md §§177 to 185). Columns marked engine-owned are not in D3 A.3.

-- D3 A.3: a check execution, registered from the project's one sequence
-- (L7) and run in a domain of profile `check` (L1). `key` and `trigger_key`
-- (engine-owned): the check's key, and the trigger identity
-- (source, id, generation, key), unique per project (D3 §2.5).
CREATE TABLE check_executions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  "check" TEXT NOT NULL REFERENCES checks(id),
  key TEXT NOT NULL,
  candidate TEXT NOT NULL REFERENCES candidates(id),
  source_revision TEXT NOT NULL,
  protected_version TEXT NOT NULL REFERENCES protected_versions(id),
  runner_class TEXT NOT NULL CHECK (runner_class IN ('direct', 'container', 'remote')),
  execution_seq INTEGER NOT NULL,
  "trigger" TEXT NOT NULL,
  trigger_key TEXT NOT NULL,
  retry_of TEXT REFERENCES check_executions(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'materializing', 'running', 'quarantined', 'collecting', 'recorded', 'interrupted', 'cancelled')),
  domain TEXT REFERENCES execution_domains(id),
  lease TEXT REFERENCES leases(id),
  runner_id TEXT,
  runner_qualification TEXT REFERENCES host_qualifications(id),
  environment TEXT REFERENCES environments(id),
  artifact_digest TEXT,
  deployment TEXT,
  candidate_protected_fingerprint TEXT,
  toolchain TEXT,
  init_reports TEXT NOT NULL DEFAULT '[]',
  not_run_reason TEXT CHECK (not_run_reason IN ('definition_invalid', 'toolchain_missing', 'materialization_failed', 'mount_plan_refused', 'isolation_unqualified', 'runner_unqualified', 'environment_unbound', 'exec_failed')),
  infra_retries INTEGER NOT NULL DEFAULT 0,
  result TEXT REFERENCES check_results(id),
  registered_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (project, execution_seq),
  UNIQUE (project, trigger_key)
);
CREATE INDEX check_executions_by_candidate ON check_executions(candidate);
CREATE INDEX check_executions_by_status ON check_executions(status);

-- CheckExecutionStatus (D3 A.5): recorded, interrupted and cancelled are terminal.
CREATE TRIGGER check_executions_terminal BEFORE UPDATE OF status ON check_executions
WHEN OLD.status IN ('recorded', 'interrupted', 'cancelled') AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'check_executions: a terminal execution never changes status'); END;

-- D3 A.3, added to check_results.
ALTER TABLE check_results ADD COLUMN execution TEXT REFERENCES check_executions(id);
ALTER TABLE check_results ADD COLUMN not_run_reason TEXT CHECK (not_run_reason IN ('definition_invalid', 'toolchain_missing', 'materialization_failed', 'mount_plan_refused', 'isolation_unqualified', 'runner_unqualified', 'environment_unbound', 'exec_failed'));
-- `orphans` null: the init's observation was not received or could not be
-- read; unknown, which never passes (L4).
ALTER TABLE check_results ADD COLUMN orphans INTEGER DEFAULT 0 CHECK (orphans IN (0, 1));
ALTER TABLE check_results ADD COLUMN output_dropped_bytes INTEGER;
ALTER TABLE check_results ADD COLUMN runner_qualification TEXT REFERENCES host_qualifications(id);
CREATE UNIQUE INDEX check_results_one_per_execution ON check_results(execution) WHERE execution IS NOT NULL;

-- D3 A.3, added to checks: the parsed definition and its input manifest.
ALTER TABLE checks ADD COLUMN origin TEXT NOT NULL DEFAULT 'acceptance' CHECK (origin IN ('acceptance', 'developer'));
ALTER TABLE checks ADD COLUMN criteria TEXT NOT NULL DEFAULT '[]';
ALTER TABLE checks ADD COLUMN definition TEXT NOT NULL DEFAULT '{}';
ALTER TABLE checks ADD COLUMN input_manifest TEXT NOT NULL DEFAULT '[]';

-- D3 A.3: a version's discovery errors. `governed` (engine-owned): the six
-- governed fields as discovery read them, with A.4's defaults.
ALTER TABLE protected_versions ADD COLUMN discovery_errors TEXT NOT NULL DEFAULT '[]';
ALTER TABLE protected_versions ADD COLUMN governed TEXT;

-- D3 A.3: what classification froze of a proposal; in slice 15 its
-- discovery (the classification itself is the fixture's).
ALTER TABLE protected_proposals ADD COLUMN classification TEXT;

-- D3 A.3, §4.5: the registered index's fields of a requirement.
ALTER TABLE requirements ADD COLUMN criteria TEXT;
ALTER TABLE requirements ADD COLUMN sensitive_areas TEXT NOT NULL DEFAULT '[]';

-- D3 A.3, §2.5: a registration the candidate is owed (L2).
ALTER TABLE candidates ADD COLUMN checks_due TEXT;

-- SEAM.md §183 (engine-owned): the per-check entries of an evaluation.
ALTER TABLE gate_evaluations ADD COLUMN checks TEXT NOT NULL DEFAULT '{}';

-- D3 A.3, §2.8: the runner's qualification on this host.
ALTER TABLE host_qualifications ADD COLUMN check_runner TEXT;

-- L1: a domain belongs to exactly one of an invocation (profiles role,
-- probe) or a check execution (profile check); `run` and `invocation` are
-- null exactly when `check_execution` is set. SQLite cannot relax NOT NULL
-- in place: the table is rebuilt, its rows and triggers kept.
CREATE TABLE execution_domains_0012 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT REFERENCES runs(id),
  invocation TEXT REFERENCES invocation_receipts(id),
  status TEXT NOT NULL CHECK (status IN ('allocated', 'launched', 'terminated', 'quarantined')),
  profile TEXT NOT NULL DEFAULT 'role' CHECK (profile IN ('role', 'probe', 'check')),
  cgroup_path TEXT,
  placed_at TEXT,
  launch_state TEXT NOT NULL DEFAULT 'authorizable' CHECK (launch_state IN ('authorizable', 'authorized', 'closed')),
  launch_binding TEXT,
  launch_authorized_at TEXT,
  launch_closed_at TEXT,
  observation TEXT CHECK (observation IN ('running', 'terminated', 'unknown')),
  observed_at TEXT,
  resource_events TEXT,
  terminated_at TEXT,
  cgroup_inode INTEGER,
  exit_class TEXT CHECK (exit_class IN ('engine_signaled', 'unknown', 'resource_limit', 'foreign_signal', 'clean', 'error_exit')),
  exit_evidence TEXT,
  plan_fingerprint TEXT,
  mount_plan TEXT,
  mount_plan_record TEXT REFERENCES records(id),
  check_execution TEXT REFERENCES check_executions(id),
  CHECK ((invocation IS NULL) <> (check_execution IS NULL)),
  CHECK ((run IS NULL) = (check_execution IS NOT NULL)),
  CHECK ((profile = 'check') = (check_execution IS NOT NULL))
);
INSERT INTO execution_domains_0012 (id, created_at, project, run, invocation, status, profile, cgroup_path, placed_at, launch_state, launch_binding, launch_authorized_at,
  launch_closed_at, observation, observed_at, resource_events, terminated_at, cgroup_inode, exit_class, exit_evidence, plan_fingerprint, mount_plan, mount_plan_record)
SELECT id, created_at, project, run, invocation, status, profile, cgroup_path, placed_at, launch_state, launch_binding, launch_authorized_at,
  launch_closed_at, observation, observed_at, resource_events, terminated_at, cgroup_inode, exit_class, exit_evidence, plan_fingerprint, mount_plan, mount_plan_record
FROM execution_domains;
DROP TABLE execution_domains;
ALTER TABLE execution_domains_0012 RENAME TO execution_domains;

CREATE TRIGGER execution_domains_launch_state BEFORE UPDATE OF launch_state ON execution_domains
WHEN NEW.launch_state <> OLD.launch_state
BEGIN
  SELECT RAISE(ABORT, 'execution_domains: a closed launch is never reopened')
  WHERE OLD.launch_state = 'closed';
  SELECT RAISE(ABORT, 'execution_domains: only an authorizable launch is authorized')
  WHERE NEW.launch_state = 'authorized' AND OLD.launch_state <> 'authorizable';
  SELECT RAISE(ABORT, 'execution_domains: an authorized launch names its binding')
  WHERE NEW.launch_state = 'authorized' AND NEW.launch_binding IS NULL;
END;

CREATE TRIGGER execution_domains_terminated_needs_closure BEFORE UPDATE OF status ON execution_domains
WHEN NEW.status = 'terminated' AND OLD.status <> 'terminated' AND NEW.launch_state <> 'closed'
BEGIN SELECT RAISE(ABORT, 'execution_domains: a domain is terminated only after its launch is closed'); END;

CREATE TRIGGER execution_domains_terminated_final BEFORE UPDATE OF status ON execution_domains
WHEN OLD.status = 'terminated' AND NEW.status <> 'terminated'
BEGIN SELECT RAISE(ABORT, 'execution_domains: a terminated domain is never repopulated'); END;

CREATE INDEX execution_domains_by_run ON execution_domains(run);
CREATE INDEX execution_domains_by_check_execution ON execution_domains(check_execution);

-- L1: ownership of a check execution's domain names the execution.
CREATE TABLE process_ownership_0012 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  domain TEXT NOT NULL REFERENCES execution_domains(id),
  invocation TEXT REFERENCES invocation_receipts(id),
  incarnation TEXT NOT NULL REFERENCES engine_incarnations(id),
  pgid INTEGER,
  pid INTEGER,
  pid_start_time TEXT,
  containment_id TEXT,
  descendants TEXT NOT NULL DEFAULT '[]',
  termination_confirmed_at TEXT,
  check_execution TEXT REFERENCES check_executions(id),
  UNIQUE (domain),
  CHECK ((invocation IS NULL) <> (check_execution IS NULL))
);
INSERT INTO process_ownership_0012 (id, created_at, project, domain, invocation, incarnation, pgid, pid, pid_start_time, containment_id, descendants, termination_confirmed_at)
SELECT id, created_at, project, domain, invocation, incarnation, pgid, pid, pid_start_time, containment_id, descendants, termination_confirmed_at FROM process_ownership;
DROP TABLE process_ownership;
ALTER TABLE process_ownership_0012 RENAME TO process_ownership;

-- L1: LeaseKind gains `check`.
CREATE TABLE leases_0012 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('run', 'integration', 'workspace', 'quarantine', 'check')),
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
INSERT INTO leases_0012 SELECT id, created_at, resource_kind, resource_id, owner_incarnation, generation, acquired_at, renewed_at, expires_at, released_at, closing, cleanup_authority FROM leases;
DROP TABLE leases;
ALTER TABLE leases_0012 RENAME TO leases;
CREATE UNIQUE INDEX leases_one_holder ON leases(resource_kind, resource_id) WHERE released_at IS NULL;
CREATE INDEX leases_by_resource ON leases(resource_id);
