-- M5 slice 33 (D6 §2; A.2, A.3; B01; N01; SEAM.md §§388 to 395): sessions
-- on the real boundary. A session's checkpoint base, the reason an eligible
-- item is held, the memory maximum a domain was admitted at, and the
-- integrity route's offer for a session workspace left uncommitted.

-- ---- runs.current_base (D6 §2.4; D1 §7.4) -------------------------------------------------
-- A session's last checkpoint: the integration commit its workspace stands
-- on, advanced by each save that commits. NULL for a one-shot run, whose
-- workspace row carries its own.
ALTER TABLE runs ADD COLUMN current_base TEXT;

-- ---- work_items.held (D6 A.2 HoldReason; N01) ----------------------------------------------
-- Why an eligible item was not dispatched at the last tick that looked at
-- it, or NULL. Engine-owned; cleared when the item is claimed. A status is
-- not changed by it.
ALTER TABLE work_items ADD COLUMN held TEXT CHECK (held IN (
  'resource_envelope', 'chain_boundary', 'depends_on', 'authoring_readiness', 'open_decision', 'session_busy'));

-- ---- invocation_receipts.deadline_at (D6 §2.1; M415 (b)) --------------------------------
-- The deadline the invocation was dispatched under: a session turn's
-- `deadline_<role>` (the run's own deadline_at is the idle deadline between
-- turns), a one-shot's its run's. NULL for a receipt written before.
ALTER TABLE invocation_receipts ADD COLUMN deadline_at TEXT;

-- ---- execution_domains.memory_max (D6 A.3; K2) ---------------------------------------------
-- The memory maximum the domain was admitted at, recorded at admission: the
-- value the envelope counts for it. Slice 33 records the configured
-- `domain_memory_max` (the driver's ruling (b), 2026-10-13); the per-profile
-- maxima are slice 37's. NULL for a domain admitted before this migration.
ALTER TABLE execution_domains ADD COLUMN memory_max INTEGER CHECK (memory_max IS NULL OR memory_max > 0);

-- ---- out_of_band_changes: a session's retained workspace (D6 §2.4; D1 §7.6) ---------------
-- Resume offers a retained, uncommitted workspace through the checkout
-- integrity route as subject `workspace`, answered `stash` or `discard` and
-- never adopted. SQLite cannot relax a CHECK in place: rebuilt as 0020
-- rebuilt it, every row kept with its meaning.
CREATE TABLE out_of_band_changes_0026 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('ref', 'checkout', 'repository', 'environment', 'workspace')),
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
  closed_by TEXT,
  workspace TEXT REFERENCES workspaces(id)
);
INSERT INTO out_of_band_changes_0026 (id, created_at, project, subject_kind, ref, checkout, expected, found, detected_at, disposition, decision, closed_at,
    environment, acknowledged, resource, change, observation, closed_by)
  SELECT id, created_at, project, subject_kind, ref, checkout, expected, found, detected_at, disposition, decision, closed_at,
    environment, acknowledged, resource, change, observation, closed_by FROM out_of_band_changes;
DROP TABLE out_of_band_changes;
ALTER TABLE out_of_band_changes_0026 RENAME TO out_of_band_changes;
CREATE INDEX out_of_band_changes_by_environment ON out_of_band_changes(environment) WHERE environment IS NOT NULL;
CREATE TRIGGER out_of_band_changes_environment_subject BEFORE INSERT ON out_of_band_changes
WHEN NEW.subject_kind = 'environment' AND (NEW.environment IS NULL OR NEW.resource IS NULL OR NEW.change IS NULL)
BEGIN SELECT RAISE(ABORT, 'an environment out-of-band change names its environment, resource and change'); END;
-- A workspace's change names its workspace, and is never adopted (D6 §2.4).
CREATE TRIGGER out_of_band_changes_workspace_subject BEFORE INSERT ON out_of_band_changes
WHEN NEW.subject_kind = 'workspace' AND NEW.workspace IS NULL
BEGIN SELECT RAISE(ABORT, 'a workspace out-of-band change names its workspace'); END;
CREATE TRIGGER out_of_band_changes_workspace_never_adopted BEFORE UPDATE OF disposition ON out_of_band_changes
WHEN NEW.subject_kind = 'workspace' AND NEW.disposition IS NOT NULL AND NEW.disposition NOT IN ('stash', 'discard')
BEGIN SELECT RAISE(ABORT, 'a session workspace is stashed or discarded, never adopted'); END;
CREATE TRIGGER out_of_band_changes_workspace_never_adopted_insert BEFORE INSERT ON out_of_band_changes
WHEN NEW.subject_kind = 'workspace' AND NEW.disposition IS NOT NULL AND NEW.disposition NOT IN ('stash', 'discard')
BEGIN SELECT RAISE(ABORT, 'a session workspace is stashed or discarded, never adopted'); END;

-- ---- session_transcripts: append-only (D6 §2.3, A.3; B01; SEAM.md §390) --------------------
-- An entry once written keeps its turn, speaker, time and text; its text
-- record may be named once where the admission wrote none yet (the owner's
-- entry, whose record is written after the admission so that a refused turn
-- leaves none). Entries are only appended; a transcript is never deleted.
CREATE TRIGGER session_transcripts_append_only BEFORE UPDATE ON session_transcripts
WHEN NEW.id IS NOT OLD.id OR NEW.run IS NOT OLD.run OR NEW.project IS NOT OLD.project OR NEW.created_at IS NOT OLD.created_at
  OR json_valid(NEW.entries) = 0
  OR json_array_length(NEW.entries) < json_array_length(OLD.entries)
  OR EXISTS (
    SELECT 1 FROM json_each(OLD.entries) o
    WHERE json_extract(NEW.entries, '$[' || o.key || '].turn') IS NOT json_extract(o.value, '$.turn')
      OR json_extract(NEW.entries, '$[' || o.key || '].speaker') IS NOT json_extract(o.value, '$.speaker')
      OR json_extract(NEW.entries, '$[' || o.key || '].at') IS NOT json_extract(o.value, '$.at')
      OR json_extract(NEW.entries, '$[' || o.key || '].text') IS NOT json_extract(o.value, '$.text')
      OR (json_extract(o.value, '$.text_ref') IS NOT NULL AND json_extract(NEW.entries, '$[' || o.key || '].text_ref') IS NOT json_extract(o.value, '$.text_ref')))
BEGIN SELECT RAISE(ABORT, 'session_transcripts is append-only'); END;
CREATE TRIGGER session_transcripts_no_delete BEFORE DELETE ON session_transcripts
BEGIN SELECT RAISE(ABORT, 'session_transcripts is append-only'); END;

-- ---- the continuation canary and session qualification (D6 §2.6; D2 §7.2; D6-S09) ---------
-- An attempt's mode: `one_shot_headless`, D2's three canaries; or
-- `session_headless`, which adds the continuation canary (and runs it alone
-- for `session_entry`, an active entry it qualifies for sessions).
ALTER TABLE qualification_attempts ADD COLUMN mode TEXT NOT NULL DEFAULT 'one_shot_headless' CHECK (mode IN ('one_shot_headless', 'session_headless'));
ALTER TABLE qualification_attempts ADD COLUMN session_entry TEXT REFERENCES trust_entries(id);
-- The continuation canary's session run, dispatched under its attempt's
-- authority alone (K10): its turns' receipts name the attempt, no entry.
ALTER TABLE runs ADD COLUMN qualification_attempt TEXT REFERENCES qualification_attempts(id);
-- `session_qualified` is no longer frozen with what one-shot qualification
-- established, nor held at 0 by the table: it is written true by an attempt
-- whose continuation canary passed (validateEntry), or set true once on an
-- active entry by a succeeded session attempt for it on the entry's own
-- model, binary and help (the review's M2), and is never withdrawn
-- in place (a changed dependency revokes the entry, D2 §7.3). SQLite cannot
-- relax a CHECK in place: rebuilt as 0011 rebuilt it, every row kept.
CREATE TABLE trust_entries_0026 (
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
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);
INSERT INTO trust_entries_0026 SELECT * FROM trust_entries;
DROP TABLE trust_entries;
ALTER TABLE trust_entries_0026 RENAME TO trust_entries;

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
  cost_reporting, enforceable_boundaries, result_channel, provider_files, term_to_exit_ms,
  qualification_attempt, evidence, evidence_fingerprint ON trust_entries
BEGIN SELECT RAISE(ABORT, 'trust_entries: what was qualified does not change; a change is a new attempt'); END;
CREATE TRIGGER trust_entries_session_qualified BEFORE UPDATE OF session_qualified ON trust_entries
WHEN NEW.session_qualified IS NOT OLD.session_qualified
BEGIN
  SELECT RAISE(ABORT, 'trust_entries: session_qualified is never withdrawn in place; the entry is revoked')
  WHERE OLD.session_qualified = 1;
  SELECT RAISE(ABORT, 'trust_entries: session_qualified only from a succeeded session attempt for this entry whose continuation canary passed')
  WHERE NOT EXISTS (
    SELECT 1 FROM qualification_attempts a
    WHERE a.session_entry = NEW.id AND a.mode = 'session_headless' AND a.status = 'succeeded'
      AND a.model = NEW.model AND a.binary_sha256 = NEW.binary_sha256 AND a.help_sha256 = NEW.help_sha256
      AND EXISTS (SELECT 1 FROM json_each(a.canaries) c WHERE json_extract(c.value, '$.kind') = 'continuation' AND json_extract(c.value, '$.passed') = 1));
END;
-- An entry written session_qualified names an attempt whose continuation
-- canary passed (D6 §2.6; D6-S09).
CREATE TRIGGER trust_entries_insert_session_qualified BEFORE INSERT ON trust_entries
WHEN NEW.session_qualified = 1 AND NOT EXISTS (
  SELECT 1 FROM qualification_attempts a, json_each(a.canaries) c
  WHERE a.id = NEW.qualification_attempt AND json_extract(c.value, '$.kind') = 'continuation' AND json_extract(c.value, '$.passed') = 1)
BEGIN SELECT RAISE(ABORT, 'trust_entries: session_qualified only from a passing continuation canary'); END;
CREATE TRIGGER trust_entries_no_delete BEFORE DELETE ON trust_entries
BEGIN SELECT RAISE(ABORT, 'trust_entries: an entry is revoked, never deleted'); END;
