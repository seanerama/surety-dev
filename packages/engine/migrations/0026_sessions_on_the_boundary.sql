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
ALTER TABLE work_items ADD COLUMN held TEXT CHECK (held IS NULL OR held IN (
  'resource_envelope', 'chain_boundary', 'depends_on', 'authoring_readiness', 'open_decision', 'session_busy'));

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
