-- The workspace assistant's usage account (the assistant design of
-- 2026-10-27, its O4(a) as Sean approved it): the shared accounting tables
-- carry an explicit account identity. `account` is 'project' (the project
-- the row's `project` column names, as every row was until now) or
-- 'workspace_assistant', the one engine-scope account of this home, which is
-- not a project. Only an assistant row has no project, run or grant; a
-- project row keeps every column it had NOT NULL, so D1 §16's invariants (a
-- receipt per invocation, one original ledger row per invocation, every
-- invocation with its row or an explicit unknown) hold for both accounts,
-- and every reader that filters `WHERE project = ?` excludes the assistant's
-- rows unchanged.
--
-- The rule is enforced by the store itself, not only by its writers:
--   - a CHECK on each table: 'project' needs its project (and, on a receipt,
--     its run and grant; on a ledger row, its run and a project role);
--     'workspace_assistant' has none of them, no turn, no qualification
--     attempt, and the ledger role `workspace_assistant`;
--   - BEFORE INSERT triggers: an observation, a usage observation, a ledger
--     row, a domain and a process ownership are of their receipt's (or
--     domain's) account.
-- `process_ownership` is rebuilt with the five tables the design names
-- because an assistant turn's domain is an ordinary execution domain, owned
-- by the incarnation that launched it, which recovery reads (D1 §16.1).
--
-- Six tables are rebuilt because SQLite cannot relax a NOT NULL or a CHECK
-- in place (as 0018 and 0032 did). Every existing row is copied as it is,
-- column by column, with `account` 'project'; every index and trigger of a
-- rebuilt table is made again, unchanged except
-- `invocation_receipts_turn_matches_run`, which judges a project receipt
-- only (an assistant receipt has no run and no turn, by the CHECK).

-- ---- invocation_receipts ----
CREATE TABLE invocation_receipts_0039 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT REFERENCES projects(id),
  run TEXT REFERENCES runs(id),
  turn TEXT REFERENCES turns(id),
  provider TEXT NOT NULL,
  model_requested TEXT NOT NULL,
  "grant" TEXT REFERENCES capability_grants(id),
  budget_snapshot TEXT NOT NULL,
  trust_entry TEXT REFERENCES trust_entries(id),
  qualification_attempt TEXT REFERENCES qualification_attempts(id),
  provider_session_id TEXT,
  deadline_at TEXT,
  account TEXT NOT NULL DEFAULT 'project' CHECK (account IN ('project', 'workspace_assistant')),
  CHECK (
    (account = 'project' AND project IS NOT NULL AND run IS NOT NULL AND "grant" IS NOT NULL)
    OR (account = 'workspace_assistant' AND project IS NULL AND run IS NULL AND "grant" IS NULL AND turn IS NULL AND qualification_attempt IS NULL)
  )
);
INSERT INTO invocation_receipts_0039 (id, created_at, project, run, turn, provider, model_requested, "grant", budget_snapshot, trust_entry, qualification_attempt, provider_session_id, deadline_at, account)
SELECT id, created_at, project, run, turn, provider, model_requested, "grant", budget_snapshot, trust_entry, qualification_attempt, provider_session_id, deadline_at, 'project'
FROM invocation_receipts;
DROP TABLE invocation_receipts;
ALTER TABLE invocation_receipts_0039 RENAME TO invocation_receipts;

-- Build spec §6 correction 10, unchanged.
CREATE UNIQUE INDEX invocation_receipts_one_per_one_shot_run ON invocation_receipts(run) WHERE turn IS NULL;
CREATE UNIQUE INDEX invocation_receipts_one_per_turn ON invocation_receipts(turn) WHERE turn IS NOT NULL;
-- The assistant account's admission reads its receipts (its turns under way).
CREATE INDEX invocation_receipts_of_the_assistant ON invocation_receipts(account) WHERE account = 'workspace_assistant';

CREATE TRIGGER invocation_receipts_no_update BEFORE UPDATE ON invocation_receipts
BEGIN SELECT RAISE(ABORT, 'invocation_receipts is append-only'); END;
CREATE TRIGGER invocation_receipts_no_delete BEFORE DELETE ON invocation_receipts
BEGIN SELECT RAISE(ABORT, 'invocation_receipts is append-only'); END;
CREATE TRIGGER invocation_receipts_session_id_fixed BEFORE UPDATE OF provider_session_id ON invocation_receipts
WHEN OLD.provider_session_id IS NOT NULL AND (NEW.provider_session_id IS NULL OR NEW.provider_session_id <> OLD.provider_session_id)
BEGIN SELECT RAISE(ABORT, 'invocation_receipts: a provider session id, once bound, never changes'); END;
-- A project receipt's turn belongs to its run, and turn nullability agrees
-- with the run's kind (one_shot <=> no turn), as before.
CREATE TRIGGER invocation_receipts_turn_matches_run BEFORE INSERT ON invocation_receipts
WHEN NEW.account = 'project'
BEGIN
  SELECT RAISE(ABORT, 'invocation_receipts: turn nullability disagrees with the run kind')
  WHERE (NEW.turn IS NULL) IS NOT (COALESCE((SELECT kind FROM runs WHERE id = NEW.run), '') = 'one_shot');
  SELECT RAISE(ABORT, 'invocation_receipts: the turn belongs to another run')
  WHERE NEW.turn IS NOT NULL AND COALESCE((SELECT run FROM turns WHERE id = NEW.turn), '') <> NEW.run;
END;

-- ---- invocation_status_observations ----
CREATE TABLE invocation_status_observations_0039 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT REFERENCES projects(id),
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('dispatch_started', 'refused', 'launched', 'ended', 'unknown')),
  at TEXT NOT NULL, exit_class TEXT
  CHECK (exit_class IN ('engine_signaled', 'unknown', 'resource_limit', 'foreign_signal', 'clean', 'error_exit')), exit_evidence TEXT, incarnation TEXT,
  account TEXT NOT NULL DEFAULT 'project' CHECK (account IN ('project', 'workspace_assistant')),
  CHECK ((account = 'project' AND project IS NOT NULL) OR (account = 'workspace_assistant' AND project IS NULL)),
  UNIQUE (invocation, seq)
);
INSERT INTO invocation_status_observations_0039 (id, created_at, project, invocation, seq, status, at, exit_class, exit_evidence, incarnation, account)
SELECT id, created_at, project, invocation, seq, status, at, exit_class, exit_evidence, incarnation, 'project'
FROM invocation_status_observations;
DROP TABLE invocation_status_observations;
ALTER TABLE invocation_status_observations_0039 RENAME TO invocation_status_observations;

CREATE TRIGGER invocation_status_observations_no_update BEFORE UPDATE ON invocation_status_observations
BEGIN SELECT RAISE(ABORT, 'invocation_status_observations is append-only'); END;
CREATE TRIGGER invocation_status_observations_no_delete BEFORE DELETE ON invocation_status_observations
BEGIN SELECT RAISE(ABORT, 'invocation_status_observations is append-only'); END;
CREATE TRIGGER invocation_status_observations_account BEFORE INSERT ON invocation_status_observations
BEGIN
  SELECT RAISE(ABORT, 'invocation_status_observations: an observation is of its receipt''s account')
  WHERE (NEW.account = 'workspace_assistant' AND COALESCE((SELECT account FROM invocation_receipts WHERE id = NEW.invocation), '') <> 'workspace_assistant')
     OR (NEW.account = 'project' AND COALESCE((SELECT account FROM invocation_receipts WHERE id = NEW.invocation), 'project') <> 'project');
END;

-- ---- usage_observations ----
CREATE TABLE usage_observations_0039 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT REFERENCES projects(id),
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  seq INTEGER NOT NULL,
  semantics TEXT NOT NULL CHECK (semantics IN ('cumulative', 'delta')),
  raw TEXT NOT NULL,
  at TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT 'project' CHECK (account IN ('project', 'workspace_assistant')),
  CHECK ((account = 'project' AND project IS NOT NULL) OR (account = 'workspace_assistant' AND project IS NULL)),
  UNIQUE (invocation, seq)
);
INSERT INTO usage_observations_0039 (id, created_at, project, invocation, seq, semantics, raw, at, account)
SELECT id, created_at, project, invocation, seq, semantics, raw, at, 'project'
FROM usage_observations;
DROP TABLE usage_observations;
ALTER TABLE usage_observations_0039 RENAME TO usage_observations;

CREATE TRIGGER usage_observations_no_update BEFORE UPDATE ON usage_observations
BEGIN SELECT RAISE(ABORT, 'usage_observations is append-only'); END;
CREATE TRIGGER usage_observations_no_delete BEFORE DELETE ON usage_observations
BEGIN SELECT RAISE(ABORT, 'usage_observations is append-only'); END;
CREATE TRIGGER usage_observations_account BEFORE INSERT ON usage_observations
BEGIN
  SELECT RAISE(ABORT, 'usage_observations: a usage observation is of its receipt''s account')
  WHERE (NEW.account = 'workspace_assistant' AND COALESCE((SELECT account FROM invocation_receipts WHERE id = NEW.invocation), '') <> 'workspace_assistant')
     OR (NEW.account = 'project' AND COALESCE((SELECT account FROM invocation_receipts WHERE id = NEW.invocation), 'project') <> 'project');
END;

-- ---- execution_domains ----
CREATE TABLE execution_domains_0039 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT REFERENCES projects(id),
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
  state TEXT GENERATED ALWAYS AS (status) VIRTUAL, supervision_lost_at TEXT, memory_max INTEGER CHECK (memory_max IS NULL OR memory_max > 0), supervision_lost_seq INTEGER, memory_peak INTEGER CHECK (memory_peak IS NULL OR memory_peak > 0), peak_recorded_at TEXT,
  account TEXT NOT NULL DEFAULT 'project' CHECK (account IN ('project', 'workspace_assistant')),
  CHECK ((invocation IS NOT NULL) + (check_execution IS NOT NULL) + (attempt IS NOT NULL) = 1),
  -- A project domain's run is there exactly when its invocation is; an
  -- assistant domain is an invocation's, in the role profile, with no run.
  CHECK (
    (account = 'project' AND project IS NOT NULL AND (run IS NOT NULL) = (invocation IS NOT NULL))
    OR (account = 'workspace_assistant' AND project IS NULL AND run IS NULL AND invocation IS NOT NULL AND profile = 'role')
  ),
  CHECK ((profile = 'check') = (check_execution IS NOT NULL)),
  CHECK ((profile = 'service') = (attempt IS NOT NULL))
);
INSERT INTO execution_domains_0039 (id, created_at, project, run, invocation, status, profile, cgroup_path, placed_at, launch_state, launch_binding, launch_authorized_at,
  launch_closed_at, observation, observed_at, resource_events, terminated_at, cgroup_inode, exit_class, exit_evidence, plan_fingerprint, mount_plan, mount_plan_record,
  check_execution, attempt, launched_by_incarnation, app_exit, reservation, unit, invocation_id, runtime_dir, supervision_lost_at, memory_max, supervision_lost_seq,
  memory_peak, peak_recorded_at, account)
SELECT id, created_at, project, run, invocation, status, profile, cgroup_path, placed_at, launch_state, launch_binding, launch_authorized_at,
  launch_closed_at, observation, observed_at, resource_events, terminated_at, cgroup_inode, exit_class, exit_evidence, plan_fingerprint, mount_plan, mount_plan_record,
  check_execution, attempt, launched_by_incarnation, app_exit, reservation, unit, invocation_id, runtime_dir, supervision_lost_at, memory_max, supervision_lost_seq,
  memory_peak, peak_recorded_at, 'project'
FROM execution_domains;
DROP TABLE execution_domains;
ALTER TABLE execution_domains_0039 RENAME TO execution_domains;

CREATE INDEX execution_domains_by_run ON execution_domains(run);
CREATE INDEX execution_domains_by_check_execution ON execution_domains(check_execution);
CREATE UNIQUE INDEX execution_domains_by_attempt ON execution_domains(attempt) WHERE attempt IS NOT NULL;

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
CREATE TRIGGER execution_domains_attempt_fixed BEFORE UPDATE OF attempt, runtime_dir ON execution_domains
WHEN NEW.attempt IS NOT OLD.attempt OR (OLD.runtime_dir IS NOT NULL AND NEW.runtime_dir IS NOT OLD.runtime_dir)
BEGIN SELECT RAISE(ABORT, 'execution_domains: a service domain''s attempt and runtime directory are fixed'); END;
CREATE TRIGGER execution_domains_supervision_lost_once BEFORE UPDATE OF supervision_lost_at ON execution_domains
WHEN OLD.supervision_lost_at IS NOT NULL AND NEW.supervision_lost_at IS NOT OLD.supervision_lost_at
BEGIN SELECT RAISE(ABORT, 'execution_domains: a lost supervision is never regained'); END;
CREATE TRIGGER execution_domains_account BEFORE INSERT ON execution_domains
BEGIN
  SELECT RAISE(ABORT, 'execution_domains: a domain is of its receipt''s account')
  WHERE (NEW.account = 'workspace_assistant' AND COALESCE((SELECT account FROM invocation_receipts WHERE id = NEW.invocation), '') <> 'workspace_assistant')
     OR (NEW.account = 'project' AND NEW.invocation IS NOT NULL AND COALESCE((SELECT account FROM invocation_receipts WHERE id = NEW.invocation), 'project') <> 'project');
END;

-- ---- ledger_rows ----
CREATE TABLE ledger_rows_0039 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT REFERENCES projects(id),
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  run TEXT REFERENCES runs(id),
  turn TEXT REFERENCES turns(id),
  role TEXT NOT NULL CHECK (role IN (
    'vision', 'spec_writer', 'architect', 'builder', 'verifier', 'reviewer', 'release_operator', 'mechanic', 'designer', 'workspace_assistant')),
  provider TEXT NOT NULL,
  model_requested TEXT NOT NULL,
  model_observed TEXT,
  raw_usage TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  billable_in INTEGER,
  cached_in INTEGER,
  out INTEGER,
  usage_complete INTEGER NOT NULL CHECK (usage_complete IN (0, 1)),
  cost_status TEXT NOT NULL CHECK (cost_status IN ('reported', 'estimated', 'unknown', 'measured_zero')),
  cost_usd REAL,
  day_utc TEXT NOT NULL,
  corrects TEXT REFERENCES ledger_rows(id),
  correction_seq INTEGER, unknown_allowance_tokens INTEGER CHECK (unknown_allowance_tokens IS NULL OR unknown_allowance_tokens >= 0),
  account TEXT NOT NULL DEFAULT 'project' CHECK (account IN ('project', 'workspace_assistant')),
  CHECK (
    (account = 'project' AND project IS NOT NULL AND run IS NOT NULL AND role <> 'workspace_assistant')
    OR (account = 'workspace_assistant' AND project IS NULL AND run IS NULL AND turn IS NULL AND role = 'workspace_assistant')
  ),
  UNIQUE (invocation, correction_seq)
);
INSERT INTO ledger_rows_0039 (id, created_at, project, invocation, run, turn, role, provider, model_requested, model_observed, raw_usage, normalization_version,
  billable_in, cached_in, out, usage_complete, cost_status, cost_usd, day_utc, corrects, correction_seq, unknown_allowance_tokens, account)
SELECT id, created_at, project, invocation, run, turn, role, provider, model_requested, model_observed, raw_usage, normalization_version,
  billable_in, cached_in, out, usage_complete, cost_status, cost_usd, day_utc, corrects, correction_seq, unknown_allowance_tokens, 'project'
FROM ledger_rows;
DROP TABLE ledger_rows;
ALTER TABLE ledger_rows_0039 RENAME TO ledger_rows;

-- D1 §6.2: one original (uncorrected) charge per invocation, of either account.
CREATE UNIQUE INDEX ledger_rows_one_original_per_invocation ON ledger_rows(invocation) WHERE corrects IS NULL;
CREATE INDEX ledger_rows_by_project ON ledger_rows(project, day_utc);
-- The assistant account's day is read by account.
CREATE INDEX ledger_rows_by_account ON ledger_rows(account, day_utc);
CREATE TRIGGER ledger_rows_no_update BEFORE UPDATE ON ledger_rows
BEGIN SELECT RAISE(ABORT, 'ledger_rows is append-only'); END;
CREATE TRIGGER ledger_rows_no_delete BEFORE DELETE ON ledger_rows
BEGIN SELECT RAISE(ABORT, 'ledger_rows is append-only'); END;
CREATE TRIGGER ledger_rows_account BEFORE INSERT ON ledger_rows
BEGIN
  SELECT RAISE(ABORT, 'ledger_rows: a row is of its receipt''s account')
  WHERE (NEW.account = 'workspace_assistant' AND COALESCE((SELECT account FROM invocation_receipts WHERE id = NEW.invocation), '') <> 'workspace_assistant')
     OR (NEW.account = 'project' AND COALESCE((SELECT account FROM invocation_receipts WHERE id = NEW.invocation), 'project') <> 'project');
END;

-- ---- process_ownership ----
CREATE TABLE process_ownership_0039 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT REFERENCES projects(id),
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
  account TEXT NOT NULL DEFAULT 'project' CHECK (account IN ('project', 'workspace_assistant')),
  CHECK ((account = 'project' AND project IS NOT NULL) OR (account = 'workspace_assistant' AND project IS NULL AND invocation IS NOT NULL)),
  UNIQUE (domain),
  CHECK ((invocation IS NULL) <> (check_execution IS NULL))
);
INSERT INTO process_ownership_0039 (id, created_at, project, domain, invocation, incarnation, pgid, pid, pid_start_time, containment_id, descendants, termination_confirmed_at, check_execution, account)
SELECT id, created_at, project, domain, invocation, incarnation, pgid, pid, pid_start_time, containment_id, descendants, termination_confirmed_at, check_execution, 'project'
FROM process_ownership;
DROP TABLE process_ownership;
ALTER TABLE process_ownership_0039 RENAME TO process_ownership;

CREATE TRIGGER process_ownership_account BEFORE INSERT ON process_ownership
BEGIN
  SELECT RAISE(ABORT, 'process_ownership: an ownership is of its domain''s account')
  WHERE NEW.account IS NOT COALESCE((SELECT account FROM execution_domains WHERE id = NEW.domain), NEW.account);
END;
