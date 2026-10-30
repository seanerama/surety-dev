-- Provider refusals and the hold they put on a prototype iteration (C2k,
-- the owner's ruling B of 2026-10-30: "Track provider refusal separately
-- from token consumption and internal reservations. Implement a documented
-- recovery path so a quota error doesn't require manually widening multiple
-- limits just to retry. Preserve history; don't assume every missing usage
-- report means zero usage.").
--
-- 1. ledger_rows.cost_status gains `provider_refused`: the original row of an
--    invocation whose provider refused its turn (Codex's usage_limit class:
--    a quota or rate-limit error, no item run, no usage reported). Such a row
--    is neither measured consumption nor an unknown-usage allowance: its
--    counts and cost stay null (unknown, never 0) and it carries no
--    allowance; its raw_usage keeps the refusal ({kind, message}). Every
--    other row is unchanged.
--    The table is rebuilt because SQLite cannot widen a CHECK in place (as
--    0039 did). Every existing row is copied as it is, column by column:
--    history is not rewritten (the unknown allowance a quota failure was
--    charged before this migration, e.g. on MAIN's run
--    run_01M66EEYSGTJXRTZPP91KZD17S, stays as recorded). Its indexes and
--    triggers are made again, unchanged.
--
-- 2. prototype_iterations gains the provider-refusal hold, which the
--    runtime limit does not count (store/transitions/prototype.ts
--    heldSeconds):
--      provider_hold_since  when the current hold began (the refused run's
--                           end), NULL while the iteration is not held;
--      provider_hold_run    the refused run whose work the hold keeps held;
--      provider_hold_ms     the milliseconds of holds already ended, 0 for
--                           every existing iteration (none was held).

-- ---- ledger_rows ----
CREATE TABLE ledger_rows_0051 (
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
  cost_status TEXT NOT NULL CHECK (cost_status IN ('reported', 'estimated', 'unknown', 'measured_zero', 'provider_refused')),
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
INSERT INTO ledger_rows_0051 (id, created_at, project, invocation, run, turn, role, provider, model_requested, model_observed, raw_usage, normalization_version,
  billable_in, cached_in, out, usage_complete, cost_status, cost_usd, day_utc, corrects, correction_seq, unknown_allowance_tokens, account)
SELECT id, created_at, project, invocation, run, turn, role, provider, model_requested, model_observed, raw_usage, normalization_version,
  billable_in, cached_in, out, usage_complete, cost_status, cost_usd, day_utc, corrects, correction_seq, unknown_allowance_tokens, account
FROM ledger_rows ORDER BY rowid;
DROP TABLE ledger_rows;
ALTER TABLE ledger_rows_0051 RENAME TO ledger_rows;

CREATE UNIQUE INDEX ledger_rows_one_original_per_invocation ON ledger_rows(invocation) WHERE corrects IS NULL;
CREATE INDEX ledger_rows_by_project ON ledger_rows(project, day_utc);
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

-- ---- prototype_iterations ----
ALTER TABLE prototype_iterations ADD COLUMN provider_hold_since TEXT;
ALTER TABLE prototype_iterations ADD COLUMN provider_hold_run TEXT REFERENCES runs(id);
ALTER TABLE prototype_iterations ADD COLUMN provider_hold_ms INTEGER NOT NULL DEFAULT 0 CHECK (provider_hold_ms >= 0);
