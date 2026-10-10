-- M4 slice 25: verify behaviourally (D4 §§5.1 to 5.3, 7.2, 7.3, 9.2, A.2,
-- A.3; E110, E114, E116, E121 CD1; SEAM.md §§265 to 271). Columns marked
-- engine-owned are not in D4 A.3.

-- D4 A.2 NotRunReason gains secret_not_allowed (§7.2) and
-- redaction_unavailable (§7.3), on the execution and on its result; the
-- execution gains its `service_link_log` record (engine-owned). SQLite
-- cannot relax a CHECK in place: both tables are rebuilt, their rows,
-- triggers and indexes kept, as 0012 and 0018 did.
CREATE TABLE check_executions_0019 (
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
  not_run_reason TEXT CHECK (not_run_reason IN ('definition_invalid', 'toolchain_missing', 'materialization_failed', 'mount_plan_refused', 'isolation_unqualified', 'runner_unqualified', 'environment_unbound', 'exec_failed', 'secret_not_allowed', 'redaction_unavailable')),
  infra_retries INTEGER NOT NULL DEFAULT 0,
  result TEXT REFERENCES check_results(id),
  registered_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  service_link_log TEXT REFERENCES records(id),
  UNIQUE (project, execution_seq),
  UNIQUE (project, trigger_key)
);
INSERT INTO check_executions_0019 (id, created_at, project, "check", key, candidate, source_revision, protected_version, runner_class, execution_seq, "trigger", trigger_key, retry_of,
  status, domain, lease, runner_id, runner_qualification, environment, artifact_digest, deployment, candidate_protected_fingerprint, toolchain, init_reports, not_run_reason,
  infra_retries, result, registered_at, started_at, finished_at)
SELECT id, created_at, project, "check", key, candidate, source_revision, protected_version, runner_class, execution_seq, "trigger", trigger_key, retry_of,
  status, domain, lease, runner_id, runner_qualification, environment, artifact_digest, deployment, candidate_protected_fingerprint, toolchain, init_reports, not_run_reason,
  infra_retries, result, registered_at, started_at, finished_at
FROM check_executions;
DROP TABLE check_executions;
ALTER TABLE check_executions_0019 RENAME TO check_executions;
CREATE INDEX check_executions_by_candidate ON check_executions(candidate);
CREATE INDEX check_executions_by_status ON check_executions(status);
CREATE TRIGGER check_executions_terminal BEFORE UPDATE OF status ON check_executions
WHEN OLD.status IN ('recorded', 'interrupted', 'cancelled') AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'check_executions: a terminal execution never changes status'); END;
-- D4 §5.2 (SEAM.md §268; the slice-25 review's m5): the execution's
-- `service_link_log` record (engine-owned), set once.
CREATE TRIGGER check_executions_service_link_log_once BEFORE UPDATE OF service_link_log ON check_executions
WHEN OLD.service_link_log IS NOT NULL AND NEW.service_link_log IS NOT OLD.service_link_log
BEGIN SELECT RAISE(ABORT, 'check_executions: an execution''s service link log is recorded once'); END;

CREATE TABLE check_results_0019 (
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
  execution TEXT REFERENCES check_executions(id),
  not_run_reason TEXT CHECK (not_run_reason IN ('definition_invalid', 'toolchain_missing', 'materialization_failed', 'mount_plan_refused', 'isolation_unqualified', 'runner_unqualified', 'environment_unbound', 'exec_failed', 'secret_not_allowed', 'redaction_unavailable')),
  orphans INTEGER DEFAULT 0 CHECK (orphans IN (0, 1)),
  output_dropped_bytes INTEGER,
  runner_qualification TEXT REFERENCES host_qualifications(id),
  deployment TEXT,
  UNIQUE (project, execution_seq)
);
INSERT INTO check_results_0019 (id, created_at, project, "check", candidate, source_revision, protected_version, runner_class, runner_id, environment, artifact_digest, execution_seq,
  execution_established, signaled, deadline_hit, exit_status, output, started_at, finished_at, invalidated_at, execution, not_run_reason, orphans, output_dropped_bytes,
  runner_qualification, deployment)
SELECT id, created_at, project, "check", candidate, source_revision, protected_version, runner_class, runner_id, environment, artifact_digest, execution_seq,
  execution_established, signaled, deadline_hit, exit_status, output, started_at, finished_at, invalidated_at, execution, not_run_reason, orphans, output_dropped_bytes,
  runner_qualification, deployment
FROM check_results;
DROP TABLE check_results;
ALTER TABLE check_results_0019 RENAME TO check_results;
CREATE INDEX check_results_by_candidate ON check_results(candidate);
CREATE UNIQUE INDEX check_results_one_per_execution ON check_results(execution) WHERE execution IS NOT NULL;

-- D4 §5.3 item 1, CD1 (SEAM.md §267). `origin` (engine-owned): who
-- registered the round: the finalizer (its first), the operator
-- (`POST …/operations/:o/verify`) or the engine superseding a round whose
-- bindings changed. `lease` (engine-owned): the generation of the
-- environment lease the round runs under; a round registered while its
-- operation no longer holds a lease takes one again (CD1). Both are fixed
-- once set.
ALTER TABLE verification_rounds ADD COLUMN origin TEXT NOT NULL DEFAULT 'finalizer' CHECK (origin IN ('finalizer', 'operator', 'supersession'));
ALTER TABLE verification_rounds ADD COLUMN lease INTEGER;
CREATE TRIGGER verification_rounds_origin_fixed BEFORE UPDATE OF origin ON verification_rounds
WHEN NEW.origin IS NOT OLD.origin
BEGIN SELECT RAISE(ABORT, 'verification_rounds: a round''s origin is fixed at its registration'); END;
CREATE TRIGGER verification_rounds_lease_once BEFORE UPDATE OF lease ON verification_rounds
WHEN OLD.lease IS NOT NULL AND NEW.lease IS NOT OLD.lease
BEGIN SELECT RAISE(ABORT, 'verification_rounds: a round''s lease is set once'); END;
CREATE TRIGGER verification_rounds_superseded_reason BEFORE UPDATE OF status ON verification_rounds
WHEN NEW.status = 'superseded' AND (NEW.superseded_reason IS NULL OR NEW.superseded_reason NOT IN ('protected_change', 'required_set_changed'))
BEGIN SELECT RAISE(ABORT, 'verification_rounds: a superseded round names why'); END;

-- D4 §9.2 (E110, E116): a service domain's control channel lost in this
-- incarnation (engine-owned): its supervision is `unknown` from then on, for
-- the rest of the domain's life; never cleared.
ALTER TABLE execution_domains ADD COLUMN supervision_lost_at TEXT;
CREATE TRIGGER execution_domains_supervision_lost_once BEFORE UPDATE OF supervision_lost_at ON execution_domains
WHEN OLD.supervision_lost_at IS NOT NULL AND NEW.supervision_lost_at IS NOT OLD.supervision_lost_at
BEGIN SELECT RAISE(ABORT, 'execution_domains: a lost supervision is never regained'); END;
