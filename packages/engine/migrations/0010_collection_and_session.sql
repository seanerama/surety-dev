-- M2 slice 13: what was collected from a run's volatile filesystem, and the
-- provider session id bound to a receipt before launch (D2 §§1.4, 1.7, 2.5,
-- 4.3; K4; A.3).

-- What collection found after termination (D2 §§1.4, 4.3; AR B08), JSON
-- `{result, provider_files, ...}` with each of `collected`, `unaccepted`,
-- `invalid`, `absent`, `refused_secret`, `truncated` or `missing`. Null until
-- the run's end records it; a run whose volatile filesystem was lost before
-- collection (an engine crash, a termination that was never established) is
-- recorded `missing`, never as an empty success.
ALTER TABLE runs ADD COLUMN collection TEXT;

-- Claude Code's `--session-id` (D2 §1.7): a UUID derived from the invocation
-- id, recorded on the receipt in the dispatch transaction, before the
-- domain is placed; for correlation only. Null for a backend whose template
-- takes none.
ALTER TABLE invocation_receipts ADD COLUMN provider_session_id TEXT;

-- Once bound, it is the receipt's for good: a resumed run is a new receipt
-- with a session id of its own (D2 §1.7), never this one changed.
CREATE TRIGGER invocation_receipts_session_id_fixed BEFORE UPDATE OF provider_session_id ON invocation_receipts
WHEN OLD.provider_session_id IS NOT NULL AND (NEW.provider_session_id IS NULL OR NEW.provider_session_id <> OLD.provider_session_id)
BEGIN SELECT RAISE(ABORT, 'invocation_receipts: a provider session id, once bound, never changes'); END;

-- The approved texts a context package carries (D2 §1.3; F §3.10.8; E67 item
-- 7, Sean): a requirement's approved text; the approved baseline's ADRs and
-- project-wide constraints, each by key with its text; the ADRs a stage
-- cites (JSON list of keys). Engine-owned.
ALTER TABLE requirements ADD COLUMN text TEXT;
ALTER TABLE stages ADD COLUMN adrs TEXT NOT NULL DEFAULT '[]';
CREATE TABLE baseline_texts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('adr', 'constraint')),
  key TEXT NOT NULL,
  text TEXT NOT NULL,
  UNIQUE (project, kind, key)
);
