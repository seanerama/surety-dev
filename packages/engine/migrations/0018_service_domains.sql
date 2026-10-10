-- M4 slice 24: the service domain (D4 §§3.4, 4.7, 9.2, A.3; J2; E110; E121
-- item 4; SEAM.md §259). A domain belongs to exactly one of an invocation
-- (profiles role, probe), a check execution (profile check) or a deployment
-- attempt (profile service). Columns marked engine-owned are not in D4 A.3.
--   attempt                  the deployment attempt the domain serves (J2);
--   launched_by_incarnation  the incarnation that granted its launch, from
--                            which supervision is derived (§9.2);
--   app_exit                 {at, code, signal} as the init reported it
--                            while attached;
--   reservation              {memory, check_capacity} held while it runs
--                            (§4.7);
--   unit, invocation_id      (engine-owned) its unit and the invocation the
--                            manager reported at its launcher's placement;
--   runtime_dir              (engine-owned) its runtime directory under
--                            $SURETY_HOME/run/, recorded before it is made;
--   state                    (engine-owned) the status under the name the
--                            seam reads (SEAM.md §259); generated, not stored.
-- SQLite cannot relax a CHECK in place: the table is rebuilt, its rows,
-- triggers and indexes kept.
CREATE TABLE execution_domains_0018 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT REFERENCES runs(id),
  invocation TEXT REFERENCES invocation_receipts(id),
  status TEXT NOT NULL CHECK (status IN ('allocated', 'launched', 'terminated', 'quarantined')),
  profile TEXT NOT NULL DEFAULT 'role' CHECK (profile IN ('role', 'probe', 'check', 'service')),
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
  attempt TEXT REFERENCES operation_attempts(id),
  launched_by_incarnation TEXT REFERENCES engine_incarnations(id),
  app_exit TEXT,
  reservation TEXT,
  unit TEXT,
  invocation_id TEXT,
  runtime_dir TEXT,
  state TEXT GENERATED ALWAYS AS (status) VIRTUAL,
  CHECK ((invocation IS NOT NULL) + (check_execution IS NOT NULL) + (attempt IS NOT NULL) = 1),
  CHECK ((run IS NOT NULL) = (invocation IS NOT NULL)),
  CHECK ((profile = 'check') = (check_execution IS NOT NULL)),
  CHECK ((profile = 'service') = (attempt IS NOT NULL))
);
INSERT INTO execution_domains_0018 (id, created_at, project, run, invocation, status, profile, cgroup_path, placed_at, launch_state, launch_binding, launch_authorized_at,
  launch_closed_at, observation, observed_at, resource_events, terminated_at, cgroup_inode, exit_class, exit_evidence, plan_fingerprint, mount_plan, mount_plan_record, check_execution)
SELECT id, created_at, project, run, invocation, status, profile, cgroup_path, placed_at, launch_state, launch_binding, launch_authorized_at,
  launch_closed_at, observation, observed_at, resource_events, terminated_at, cgroup_inode, exit_class, exit_evidence, plan_fingerprint, mount_plan, mount_plan_record, check_execution
FROM execution_domains;
DROP TABLE execution_domains;
ALTER TABLE execution_domains_0018 RENAME TO execution_domains;

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

-- A service domain's owner and runtime directory are fixed with it.
CREATE TRIGGER execution_domains_attempt_fixed BEFORE UPDATE OF attempt, runtime_dir ON execution_domains
WHEN NEW.attempt IS NOT OLD.attempt OR (OLD.runtime_dir IS NOT NULL AND NEW.runtime_dir IS NOT OLD.runtime_dir)
BEGIN SELECT RAISE(ABORT, 'execution_domains: a service domain''s attempt and runtime directory are fixed'); END;

CREATE INDEX execution_domains_by_run ON execution_domains(run);
CREATE INDEX execution_domains_by_check_execution ON execution_domains(check_execution);
CREATE UNIQUE INDEX execution_domains_by_attempt ON execution_domains(attempt) WHERE attempt IS NOT NULL;

-- D4 §3.4 step 3: the init's report and the host read disagreed (engine-
-- owned): what each said. Nothing is bound; reconcile reads `conflicting`.
ALTER TABLE operation_attempts ADD COLUMN app_disagreement TEXT;
