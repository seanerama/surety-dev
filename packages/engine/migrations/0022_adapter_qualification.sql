-- M4 slice 29: the adapter qualification by command and its lapse (D4
-- §2.6, A.3; D4-A06, D4-A07; E129 item 8 as Sean decided it; the driver's
-- rulings on the slice-29 Builder's design; SEAM.md §§322 to 324).
-- Columns and tables marked engine-owned are not in D4 A.3.

-- One run of `surety qualify-adapter` (engine-owned; the driver's ruling: a
-- run that does not qualify is recorded only here). `cases`: D4 A.3's
-- entries, in D4 A.2's order, as recorded when the run ended. `environment`:
-- the qualification environment the run made for itself. A run is
-- `running` until it ends `qualified`, `unqualified` or `interrupted` (an
-- engine that stopped during it); an ended run never changes.
CREATE TABLE adapter_qualification_runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  adapter TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  environment TEXT REFERENCES environments(id),
  incarnation TEXT NOT NULL REFERENCES engine_incarnations(id),
  status TEXT NOT NULL CHECK (status IN ('running', 'qualified', 'unqualified', 'interrupted')),
  cases TEXT,
  evidence TEXT REFERENCES records(id),
  qualification TEXT REFERENCES adapter_qualifications(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK ((status = 'running') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX adapter_qualification_runs_one_running ON adapter_qualification_runs(adapter) WHERE status = 'running';
CREATE TRIGGER adapter_qualification_runs_ended_final BEFORE UPDATE ON adapter_qualification_runs
WHEN OLD.status <> 'running'
BEGIN SELECT RAISE(ABORT, 'adapter_qualification_runs: an ended run never changes'); END;
CREATE TRIGGER adapter_qualification_runs_no_delete BEFORE DELETE ON adapter_qualification_runs
BEGIN SELECT RAISE(ABORT, 'adapter_qualification_runs: a run is never deleted'); END;

-- The host qualification's facts a row was qualified under (engine-owned;
-- E129 item 8): {host_id, kernel, tool_versions, mechanism_fingerprint} of
-- the active host qualification at the run, as canonical JSON; null where
-- none was active (`unrun`). A row is current only while the active host
-- qualification has the same facts, never by the row's id, so a start on an
-- unchanged host keeps it current. Rows written before this migration take
-- the facts of the host qualification they name.
ALTER TABLE adapter_qualifications ADD COLUMN host_facts TEXT;
UPDATE adapter_qualifications SET host_facts = (
  SELECT json_object('host_id', h.host_id, 'kernel', h.kernel, 'tool_versions', json(h.tool_versions), 'mechanism_fingerprint', h.mechanism_fingerprint)
  FROM host_qualifications h WHERE h.id = adapter_qualifications.host_qualification
) WHERE host_qualification IS NOT NULL;
-- The run that qualified it (engine-owned); null for the harness fixture's.
ALTER TABLE adapter_qualifications ADD COLUMN run TEXT REFERENCES adapter_qualification_runs(id);
-- Which fact lapsed it, beside `lapsed_reason` (engine-owned): for
-- `host_qualification`, the member that differs.
ALTER TABLE adapter_qualifications ADD COLUMN lapsed_member TEXT;

-- A qualification environment (engine-owned): the run that made it. Such an
-- environment is driven by its run only: never by the Release Operator's
-- tick, and it has no observation job.
ALTER TABLE environments ADD COLUMN qualification_run TEXT REFERENCES adapter_qualification_runs(id);
