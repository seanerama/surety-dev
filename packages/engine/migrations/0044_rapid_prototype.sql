-- Rapid prototype to Alpha, slice E1 (the owner's request
-- docs/spec/surety-rapid-prototype-feature-request.md; the director's
-- proposal of 2026-10-28 and the owner's rulings R4, R7 and R9).
--
-- The project's execution mode: `planned` (every project before this
-- migration, and the default) or `rapid_prototype`, chosen once at
-- POST /v1/projects/new and never inferred.
ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'planned' CHECK (mode IN ('planned', 'rapid_prototype'));

-- A prototype iteration (R7): a durable identity to which work, usage and
-- deployment are attributed through stable relationships, never through
-- time windows. `seq` counts a project's iterations from 1; `predecessor`
-- links an iteration made by Iterate to the one it follows. `status` is the
-- owner-facing state as the engine recorded it (nothing is derived from
-- time): open while preparing, awaiting_brief_approval, building or
-- awaiting_owner; ended at alpha_ready, failed, stopped, limit_reached or
-- discarded. Its historical outcome is kept apart from whether its Alpha is
-- available now, which only a fresh observation says (the iteration read).
--
--   brief_spec_revision  the spec revision the brief is (durable brief version)
--   brief_decision       the decision that approved it
--   plan_bundle, phase_plan, candidate, deployment_request
--                        what the iteration built and deployed, once known
--   limits_json          the five prototype_* policy keys, snapshotted when
--                        the iteration was created (engine-owned JSON)
--   outcome_reason, next_step
--                        why it ended as it did, and what the owner can do
CREATE TABLE prototype_iterations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  predecessor TEXT REFERENCES prototype_iterations(id),
  mode TEXT NOT NULL CHECK (mode IN ('planned', 'rapid_prototype')),
  status TEXT NOT NULL CHECK (status IN ('preparing', 'awaiting_brief_approval', 'building', 'awaiting_owner', 'alpha_ready', 'failed', 'stopped', 'limit_reached', 'discarded')),
  brief_spec_revision TEXT REFERENCES spec_revisions(id),
  brief_decision TEXT REFERENCES decisions(id),
  plan_bundle TEXT REFERENCES plan_bundles(id),
  phase_plan TEXT REFERENCES phase_plans(id),
  candidate TEXT REFERENCES candidates(id),
  deployment_request TEXT REFERENCES deployment_requests(id),
  limits_json TEXT NOT NULL,
  outcome_reason TEXT,
  next_step TEXT,
  approved_at TEXT,
  alpha_at TEXT,
  ended_at TEXT
);
CREATE UNIQUE INDEX prototype_iterations_by_project_seq ON prototype_iterations(project, seq);

-- The iteration a run was dispatched for: set once, in the transaction that
-- creates the run, when its project's current iteration is open; NULL for
-- every other run (planned projects, and every run before this migration).
-- A session's invocations reach it through their run.
ALTER TABLE runs ADD COLUMN iteration TEXT REFERENCES prototype_iterations(id);
CREATE INDEX runs_by_iteration ON runs(iteration);
