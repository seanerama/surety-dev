-- Slice 4: records and stream chunk receipts, and the record references of
-- a run (D1 A.3, §§3.6, 14; build spec §6 correction 21; SEAM.md §§56-58,
-- 62). The ledger tables exist since 0001.

-- The structured result the engine accepted, which slice 3 kept in
-- runs.result, is engine-owned and keeps its content under another name:
-- runs.result is A.3's reference to the result record.
ALTER TABLE runs RENAME COLUMN result TO result_value;

-- A record is a row here and a file under $SURETY_HOME/records/, `path`
-- relative to that directory. A stream is registered before its first chunk
-- receipt, unpublished, with its hash and length unknown (correction 21:
-- A.3 marks both required, which a pre-publication identity cannot keep). A
-- published record has both. `path` is null once the record has expired.
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'transcript', 'tool_output', 'check_output', 'result', 'raw_user_report', 'parked_result',
    'proposal_rationale', 'assessment_evidence', 'containment_evidence', 'recovery_plan')),
  path TEXT,
  sha256 TEXT,
  bytes INTEGER,
  redaction_version TEXT NOT NULL,
  published INTEGER NOT NULL CHECK (published IN (0, 1)),
  post_scan TEXT NOT NULL CHECK (post_scan IN ('pending', 'clean', 'hit')),
  -- References findings, which slice 5 creates.
  post_scan_finding TEXT,
  retain_until TEXT,
  -- Engine-owned: the run whose output the record holds, when it was
  -- published, and since when its referenced bytes are known to be missing
  -- or corrupt.
  run TEXT REFERENCES runs(id),
  published_at TEXT,
  missing_at TEXT,
  CHECK (published = 0 OR (sha256 IS NOT NULL AND bytes IS NOT NULL))
);
CREATE INDEX records_by_run ON records(run);
CREATE INDEX records_by_project ON records(project, published);

-- One receipt per durable chunk of a stream (D1 §14.1): written only once
-- its bytes are synced in the stream's file. Append-only.
CREATE TABLE stream_chunk_receipts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  record TEXT NOT NULL REFERENCES records(id),
  "offset" INTEGER NOT NULL CHECK ("offset" >= 0),
  length INTEGER NOT NULL CHECK (length >= 1),
  sha256 TEXT NOT NULL,
  UNIQUE (record, "offset")
);

CREATE TRIGGER stream_chunk_receipts_no_update BEFORE UPDATE ON stream_chunk_receipts
BEGIN SELECT RAISE(ABORT, 'stream_chunk_receipts is append-only'); END;
CREATE TRIGGER stream_chunk_receipts_no_delete BEFORE DELETE ON stream_chunk_receipts
BEGIN SELECT RAISE(ABORT, 'stream_chunk_receipts is append-only'); END;

ALTER TABLE runs ADD COLUMN transcript TEXT REFERENCES records(id);
ALTER TABLE runs ADD COLUMN result TEXT REFERENCES records(id);

CREATE INDEX ledger_rows_by_project ON ledger_rows(project, day_utc);
