-- M2 slice 14 (E74 item 1, Sean): a second authentication mode.
--
-- D2 A.2's AuthMode gains `subscription_token` beside `api_key`: a long-lived
-- Claude subscription token (from `claude setup-token`), held by the engine
-- as a secret file exactly as a key is, delivered to Claude Code in
-- CLAUDE_CODE_OAUTH_TOKEN by its own template. An attempt and an entry record
-- the mode; an entry for one mode never authorizes the other.
--
-- SQLite cannot widen a CHECK constraint in place: both tables are rebuilt
-- with their rows, columns, constraints and triggers otherwise unchanged
-- (migrate.ts runs the batch with foreign keys off and checks every foreign
-- key before it commits). Nothing else changes.

CREATE TABLE qualification_attempts_0011 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  backend TEXT NOT NULL,
  version TEXT NOT NULL,
  binary_path TEXT NOT NULL,
  binary_sha256 TEXT NOT NULL,
  help_sha256 TEXT NOT NULL,
  template TEXT NOT NULL,
  template_version TEXT NOT NULL,
  model TEXT NOT NULL,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('api_key', 'subscription_token')),
  host_qualification TEXT REFERENCES host_qualifications(id),
  profile_fingerprint TEXT NOT NULL,
  fixture_project TEXT REFERENCES projects(id),
  candidate_egress TEXT NOT NULL,
  canary_deadlines TEXT NOT NULL,
  spend TEXT NOT NULL,
  decision TEXT REFERENCES decisions(id),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'authorized', 'running', 'succeeded', 'failed', 'invalidated')),
  canaries TEXT NOT NULL DEFAULT '[]',
  unexpected_contacts TEXT NOT NULL DEFAULT '[]',
  trust_entry TEXT REFERENCES trust_entries(id),
  invalidated_reason TEXT
);

INSERT INTO qualification_attempts_0011 SELECT * FROM qualification_attempts;

CREATE TABLE trust_entries_0011 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  backend TEXT NOT NULL,
  version TEXT NOT NULL,
  binary_path TEXT NOT NULL,
  binary_sha256 TEXT NOT NULL,
  help_sha256 TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('one_shot_headless', 'session_headless')),
  template TEXT NOT NULL,
  template_version TEXT NOT NULL,
  model TEXT NOT NULL,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('api_key', 'subscription_token')),
  capabilities TEXT NOT NULL,
  host_id TEXT NOT NULL,
  host_qualification TEXT REFERENCES host_qualifications(id),
  isolation TEXT NOT NULL CHECK (isolation IN ('linux-namespaces-1')),
  boundary TEXT NOT NULL CHECK (boundary IN ('cgroup2-delegated-scope-1')),
  profile_fingerprint TEXT NOT NULL,
  egress_hosts TEXT NOT NULL,
  usage_granularity TEXT NOT NULL CHECK (usage_granularity IN ('model_call', 'invocation', 'none')),
  usage_semantics TEXT CHECK (usage_semantics IN ('cumulative', 'delta')),
  cost_reporting TEXT NOT NULL CHECK (cost_reporting IN ('reported', 'tokens_only', 'none')),
  enforceable_boundaries TEXT NOT NULL,
  result_channel TEXT NOT NULL CHECK (result_channel IN ('file')),
  session_qualified INTEGER NOT NULL CHECK (session_qualified IN (0, 1)),
  provider_files TEXT NOT NULL,
  term_to_exit_ms INTEGER,
  qualification_attempt TEXT NOT NULL REFERENCES qualification_attempts(id),
  evidence TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'revoked')),
  activated_by TEXT REFERENCES decisions(id),
  revoked_at TEXT,
  revoked_reason TEXT,
  CHECK (status <> 'active' OR activated_by IS NOT NULL),
  CHECK (status <> 'active' OR mode = 'one_shot_headless'),
  CHECK (status <> 'active' OR usage_granularity <> 'none'),
  CHECK (session_qualified = 0),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);

INSERT INTO trust_entries_0011 SELECT * FROM trust_entries;

DROP TABLE trust_entries;
DROP TABLE qualification_attempts;
ALTER TABLE qualification_attempts_0011 RENAME TO qualification_attempts;
ALTER TABLE trust_entries_0011 RENAME TO trust_entries;

CREATE TRIGGER trust_entries_activation BEFORE UPDATE ON trust_entries
WHEN NEW.status = 'active' AND OLD.status <> 'active'
BEGIN
  SELECT RAISE(ABORT, 'trust_entries: only a proposed entry becomes active')
  WHERE OLD.status <> 'proposed';
  SELECT RAISE(ABORT, 'trust_entries: active needs the consumed trust_activation decision about this entry')
  WHERE NOT EXISTS (
    SELECT 1 FROM decisions d WHERE d.id = NEW.activated_by AND d.kind = 'trust_activation'
      AND d.subject_type = 'trust_entry' AND d.subject_id = NEW.id AND d.status = 'consumed');
END;
CREATE TRIGGER trust_entries_insert_not_active BEFORE INSERT ON trust_entries
WHEN NEW.status <> 'proposed'
BEGIN SELECT RAISE(ABORT, 'trust_entries: an entry is written proposed'); END;
CREATE TRIGGER trust_entries_revoked_final BEFORE UPDATE OF status ON trust_entries
WHEN OLD.status = 'revoked' AND NEW.status <> 'revoked'
BEGIN SELECT RAISE(ABORT, 'trust_entries: a revoked entry has no exit'); END;
CREATE TRIGGER trust_entries_qualified_fields_frozen BEFORE UPDATE OF
  backend, version, binary_path, binary_sha256, help_sha256, mode, template, template_version, model, auth_mode, capabilities,
  host_id, host_qualification, isolation, boundary, profile_fingerprint, egress_hosts, usage_granularity, usage_semantics,
  cost_reporting, enforceable_boundaries, result_channel, session_qualified, provider_files, term_to_exit_ms,
  qualification_attempt, evidence, evidence_fingerprint ON trust_entries
BEGIN SELECT RAISE(ABORT, 'trust_entries: what was qualified does not change; a change is a new attempt'); END;
CREATE TRIGGER trust_entries_no_delete BEFORE DELETE ON trust_entries
BEGIN SELECT RAISE(ABORT, 'trust_entries: an entry is revoked, never deleted'); END;
