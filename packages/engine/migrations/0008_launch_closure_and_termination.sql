-- M2 slice 11: the execution boundary's rules in the store (D2 §§3.1 to 3.5,
-- A.3, A.4). The columns of A.3 were added by 0007; this migration adds what
-- the boundary records of a domain's termination, and the constraints that
-- keep the launch state and the domain status to their tables.

-- When the domain's termination was established, and the identity of the one
-- creation of its cgroup directory (its inode): a directory removed and made
-- again at the recorded path is another cgroup and never terminates the
-- domain (D2 §3.4).
ALTER TABLE execution_domains ADD COLUMN terminated_at TEXT;
ALTER TABLE execution_domains ADD COLUMN cgroup_inode INTEGER;

-- LaunchState (D2 A.4): authorizable→authorized, authorizable→closed,
-- authorized→closed; closed has no exit. An authorized launch names what it
-- was bound to.
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

-- DomainStatus (D2 A.4): terminated only once the launch is closed;
-- terminated has no exit.
CREATE TRIGGER execution_domains_terminated_needs_closure BEFORE UPDATE OF status ON execution_domains
WHEN NEW.status = 'terminated' AND OLD.status <> 'terminated' AND NEW.launch_state <> 'closed'
BEGIN SELECT RAISE(ABORT, 'execution_domains: a domain is terminated only after its launch is closed'); END;

CREATE TRIGGER execution_domains_terminated_final BEFORE UPDATE OF status ON execution_domains
WHEN OLD.status = 'terminated' AND NEW.status <> 'terminated'
BEGIN SELECT RAISE(ABORT, 'execution_domains: a terminated domain is never repopulated'); END;

-- How the domain's backend ended, as the boundary established it (D2 §1.6):
-- copied onto the invocation's terminal observation (`exit_class`,
-- `exit_evidence`, 0007) when the run ends.
ALTER TABLE execution_domains ADD COLUMN exit_class TEXT
  CHECK (exit_class IN ('engine_signaled', 'unknown', 'resource_limit', 'foreign_signal', 'clean', 'error_exit'));
ALTER TABLE execution_domains ADD COLUMN exit_evidence TEXT;

-- The sandbox profile a work item's runs are dispatched under (D2 §§2.8,
-- 3.8): `role` unless set; `probe` only by the probe suite, or by a test
-- fixture standing for it (SEAM.md §127). Not part of D1 A.3; engine-owned.
ALTER TABLE work_items ADD COLUMN profile TEXT CHECK (profile IS NULL OR profile IN ('role', 'probe', 'check'));
