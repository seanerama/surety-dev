-- M5 slice 37 (D6 §§6.2 to 6.5, §7.6; A.2, A.3; K1, K2, K3, K7; B07, B09,
-- N01, N02; SEAM.md §§426 to 433): the build's execution and its pace. The
-- hold intervals and the chain's origin of a work item, a domain's memory
-- peak, check obligations a deferral records, a proposal's fingerprint
-- changes, a policy request's preparations, the host observation's trigger
-- and figures, and the role profile of a trust entry and an attempt.

-- ---- work_items.held_intervals (N01; the driver's ruling Q3) -------------------------------
-- [{from, to?, reason}], one interval per hold, never one per tick: opened
-- when an eligible item is first held for a reason, closed when the reason
-- changes or the item leaves `eligible` (work.hold_began, work.hold_ended).
ALTER TABLE work_items ADD COLUMN held_intervals TEXT;

-- ---- work_items.chain_origin (D6 §6.5; K3; N02; SEAM.md §429) -------------------------------
-- {trigger_source, trigger_id, trigger_generation} of the trigger of the
-- chain's first item; NULL for an item written before this migration.
ALTER TABLE work_items ADD COLUMN chain_origin TEXT;

-- ---- execution_domains.memory_peak (D6 §6.4, §7.6, A.3; K2; N01) ----------------------------
-- The cgroup's memory.peak read before the cgroup was removed; NULL when it
-- could not be read (never 0, never a value read later).
ALTER TABLE execution_domains ADD COLUMN memory_peak INTEGER CHECK (memory_peak IS NULL OR memory_peak > 0);
-- When the peak was recorded (domain.peak_recorded), as a value or unknown;
-- NULL until then. Once per domain.
ALTER TABLE execution_domains ADD COLUMN peak_recorded_at TEXT;

-- ---- check_obligations: deferred authoring (D6 §6.2, A.2, A.3; B07; SEAM.md §428) -----------
-- A deferral's obligation has no check yet and no key: rebuilt (SQLite
-- cannot relax NOT NULL or a CHECK in place), every row kept.
CREATE TABLE check_obligations_0029 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  "check" TEXT REFERENCES checks(id),
  key TEXT,
  criteria TEXT NOT NULL,
  generation INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('spec_changed', 'deferred_authoring', 'authoring_pending')),
  request TEXT REFERENCES spec_change_requests(id),
  resolved_by TEXT,
  resolved_at TEXT,
  -- deferred_authoring: {stage: <number>} or {interface: <name>}, the
  -- Verifier's reason, the follow-up's trigger identity and the plan.
  prerequisite TEXT,
  deferred_reason TEXT,
  follow_up TEXT,
  phase_plan TEXT REFERENCES phase_plans(id),
  CHECK (reason <> 'spec_changed' OR ("check" IS NOT NULL AND key IS NOT NULL)),
  CHECK (reason <> 'deferred_authoring' OR (prerequisite IS NOT NULL AND follow_up IS NOT NULL))
);
INSERT INTO check_obligations_0029 (id, created_at, project, "check", key, criteria, generation, reason, request, resolved_by, resolved_at)
  SELECT id, created_at, project, "check", key, criteria, generation, reason, request, resolved_by, resolved_at FROM check_obligations;
DROP TABLE check_obligations;
ALTER TABLE check_obligations_0029 RENAME TO check_obligations;

-- ---- protected_proposals.fingerprint_changes (D6 §6.2; B07; SEAM.md §428) -------------------
-- [{check, from, to}], one entry per existing check whose input fingerprint
-- the proposal moves; [] when none moves; NULL until it is classified.
ALTER TABLE protected_proposals ADD COLUMN fingerprint_changes TEXT;

-- ---- deployment_requests.preparation_attempts (D6 §6.8; the driver's ruling Q4) --------------
-- How many times the policy prepared the request; the row exists from the
-- first unexpected error of its preparation.
ALTER TABLE deployment_requests ADD COLUMN preparation_attempts INTEGER CHECK (preparation_attempts IS NULL OR preparation_attempts > 0);

-- ---- host_observations (D6 §7.6, A.3; N01; SEAM.md §431) ------------------------------------
-- Recorded at a project's first tick (`project_start`) or at a later engine
-- start (`engine_start`); NULL trigger for a row written before.
ALTER TABLE host_observations ADD COLUMN trigger TEXT CHECK (trigger IS NULL OR trigger IN ('project_start', 'engine_start'));
-- The host qualification in force then, or NULL (none).
ALTER TABLE host_observations ADD COLUMN host_qualification TEXT;
-- {id, binary_sha256, model} of the active entry the project's Builder
-- dispatch resolved to then, or NULL (none: the scripted backend).
ALTER TABLE host_observations ADD COLUMN backend_entry TEXT;
-- The peak number of domains running at once, as the scheduler observed it
-- during that incarnation.
ALTER TABLE host_observations ADD COLUMN peak_domains INTEGER;

-- ---- the role profile in the qualification identity (D6 §2.6; B09; SEAM.md §432) ------------
-- {memory_max, writable_bytes, writable_inodes, tasks_max}; NULL for an
-- entry or attempt written before, which qualifies no profile.
ALTER TABLE trust_entries ADD COLUMN profile TEXT;
ALTER TABLE qualification_attempts ADD COLUMN profile TEXT;
-- What was qualified does not change: an entry's profile, once written, is
-- frozen as the other qualified fields are.
CREATE TRIGGER trust_entries_profile_frozen BEFORE UPDATE OF profile ON trust_entries
WHEN OLD.profile IS NOT NULL OR NEW.profile IS NOT OLD.profile
BEGIN SELECT RAISE(ABORT, 'trust_entries: what was qualified does not change; a change is a new attempt'); END;
