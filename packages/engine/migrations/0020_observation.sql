-- M4 slice 27: tear down and observe (D4 §§4.6, 6.1 to 6.3, A.3; J6; E120
-- item 2; E121 CD2; SEAM.md §§290 to 298). Columns marked engine-owned are
-- not in D4 A.3.

-- D4 A.3 `environments`, added (engine-owned):
--   expected_revision  the environment's expected-state revision: moved by
--                      every change the engine makes to what the environment
--                      is expected to run (an attempt, a preemption, a
--                      finalization, an operation's end, a domain's closure);
--                      an observation compares against it (D4 §6.2; AR N01);
--   logs_requested_at  a log collection asked for and not yet recorded
--                      (D4 §6.1; SEAM.md §294).
ALTER TABLE environments ADD COLUMN expected_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE environments ADD COLUMN logs_requested_at TEXT;

-- D1 A.3, D4 §6.2: one job per configured environment, made with its first
-- configuration version (SEAM.md §291). `next_due` is the engine's clock;
-- `error_class` the last observation's failure, or `freshness_bound`;
-- `lapse_reported` (engine-owned) the last successful observation (or the
-- job's creation) whose lapse past the freshness bound was reported, so a
-- lapse is reported once (the slice-27 review, m6).
CREATE TABLE observation_jobs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  environment TEXT NOT NULL UNIQUE REFERENCES environments(id),
  cadence_s INTEGER NOT NULL,
  next_due TEXT NOT NULL,
  last_success_at TEXT,
  last_attempt_at TEXT,
  error_class TEXT,
  lapse_reported TEXT
);
-- Existing configured environments have one, due one cadence from now.
INSERT INTO observation_jobs (id, created_at, project, environment, cadence_s, next_due, last_success_at, last_attempt_at, error_class)
  SELECT 'obsj_' || substr(e.id, 5), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), e.project, e.id, 30,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 seconds'), NULL, NULL, NULL
  FROM environments e WHERE e.prefix IS NOT NULL;

-- D1 A.3, D4 §6.2, A.3: every observation, append-only. `facts` (engine-
-- owned): each fact with its own source timestamp (SEAM.md §291).
-- `installed` (engine-owned): 0 when a change the engine made meanwhile
-- left the comparison stale, so it was kept as history only, with
-- `stale_reason`.
CREATE TABLE observation_history (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  environment TEXT NOT NULL REFERENCES environments(id),
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('healthy', 'degraded', 'down', 'unknown')),
  detail TEXT,
  read_interval TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  deployment_generation INTEGER,
  facts TEXT NOT NULL,
  installed INTEGER NOT NULL CHECK (installed IN (0, 1)),
  stale_reason TEXT
);
CREATE INDEX observation_history_by_environment ON observation_history(environment, observed_at);
CREATE TRIGGER observation_history_no_update BEFORE UPDATE ON observation_history
BEGIN SELECT RAISE(ABORT, 'observation_history is append-only'); END;
CREATE TRIGGER observation_history_no_delete BEFORE DELETE ON observation_history
BEGIN SELECT RAISE(ABORT, 'observation_history is append-only'); END;

-- D4 §6.3, A.2, A.3 (J6): IntegritySubject gains `environment`, OobDisposition
-- `teardown` and `acknowledge`. Added columns:
--   environment   the environment of a subject `environment`;
--   acknowledged  {at, actor, unresolved_until_replacement} (D4 A.3);
--   resource      (engine-owned) the unit or path the change is of;
--   change        (engine-owned) stopped, restarted, unexpected_unit or
--                 identity_differs;
--   observation   (engine-owned) the observation_history row that found it,
--                 null when an operation's read did;
--   closed_by     (engine-owned) what closed it: the observation_history row
--                 that no longer found it, or the operation that replaced
--                 what runs.
-- SQLite cannot relax a CHECK in place: rebuilt as 0017 rebuilt `leases`,
-- every row kept with its meaning.
CREATE TABLE out_of_band_changes_0020 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('ref', 'checkout', 'repository', 'environment')),
  ref TEXT REFERENCES ref_registry(id),
  checkout TEXT REFERENCES managed_checkouts(id),
  expected TEXT NOT NULL,
  found TEXT,
  detected_at TEXT NOT NULL,
  disposition TEXT CHECK (disposition IN ('discard', 'adopt', 'stash', 'teardown', 'acknowledge')),
  decision TEXT NOT NULL REFERENCES decisions(id),
  closed_at TEXT,
  environment TEXT REFERENCES environments(id),
  acknowledged TEXT,
  resource TEXT,
  change TEXT CHECK (change IN ('stopped', 'restarted', 'unexpected_unit', 'identity_differs')),
  observation TEXT,
  closed_by TEXT
);
INSERT INTO out_of_band_changes_0020 (id, created_at, project, subject_kind, ref, checkout, expected, found, detected_at, disposition, decision, closed_at)
  SELECT id, created_at, project, subject_kind, ref, checkout, expected, found, detected_at, disposition, decision, closed_at FROM out_of_band_changes;
DROP TABLE out_of_band_changes;
ALTER TABLE out_of_band_changes_0020 RENAME TO out_of_band_changes;
CREATE INDEX out_of_band_changes_by_environment ON out_of_band_changes(environment) WHERE environment IS NOT NULL;
-- An environment's change names its environment, resource and change.
CREATE TRIGGER out_of_band_changes_environment_subject BEFORE INSERT ON out_of_band_changes
WHEN NEW.subject_kind = 'environment' AND (NEW.environment IS NULL OR NEW.resource IS NULL OR NEW.change IS NULL)
BEGIN SELECT RAISE(ABORT, 'an environment out-of-band change names its environment, resource and change'); END;

-- D4 §6.1, A.2 RecordKind `deployment_logs` (engine-owned table): each
-- collected log, its record, the generation it is of, the source time of
-- what was read and when it was collected (SEAM.md §294).
CREATE TABLE environment_logs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  environment TEXT NOT NULL REFERENCES environments(id),
  record TEXT NOT NULL REFERENCES records(id),
  generation INTEGER,
  at TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  bytes INTEGER NOT NULL
);
CREATE TRIGGER environment_logs_no_update BEFORE UPDATE ON environment_logs
BEGIN SELECT RAISE(ABORT, 'environment_logs is append-only'); END;

-- D4 §4.6 step 2 (the slice-27 review, m4): an execution a preempting
-- teardown cancelled while it ran is `quarantined` when its termination is
-- not observed, as any running execution would be, and `cancelled` again
-- once its closure is observed; no other change of a terminal status.
DROP TRIGGER check_executions_terminal;
CREATE TRIGGER check_executions_terminal BEFORE UPDATE OF status ON check_executions
WHEN OLD.status IN ('recorded', 'interrupted', 'cancelled') AND NEW.status <> OLD.status
  AND NOT (OLD.status = 'cancelled' AND NEW.status = 'quarantined' AND OLD.finished_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'check_executions: a terminal execution never changes status'); END;
