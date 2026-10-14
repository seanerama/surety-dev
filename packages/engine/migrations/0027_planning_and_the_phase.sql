-- M5 slice 35 (D6 §5.3 to §5.8; A.2, A.3, A.5; K4, K5; B03, B04, B06, B08):
-- planning and the phase. A stage may be `cancelled` (early replacement's
-- swap); a phase plan records what its replacement kept, retained, cancelled
-- and superseded, and what became stale; a bundle names the generation it
-- replaces; a plan check records the uncertainty it computed, the Architect's
-- declarations beside the computed routing, and the complete diff of every
-- changed artifact.

PRAGMA foreign_keys = OFF;

-- ---- stages: StageStatus gains `cancelled` (D6 A.5: planned → cancelled) -----------------
CREATE TABLE stages_0027 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  phase_plan TEXT NOT NULL REFERENCES phase_plans(id),
  number INTEGER NOT NULL,
  goal TEXT NOT NULL,
  modules TEXT NOT NULL,
  requirement_ids TEXT NOT NULL,
  implements TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'building', 'integrated', 'verified', 'cancelled')),
  integrated_revision TEXT,
  work_item TEXT REFERENCES work_items(id),
  adrs TEXT NOT NULL DEFAULT '[]',
  tasks TEXT NOT NULL DEFAULT '[]',
  depends_on TEXT NOT NULL DEFAULT '[]',
  validation TEXT NOT NULL DEFAULT '{"criteria":[],"kinds":[],"sensitive_areas":[]}',
  integration_obligations TEXT NOT NULL DEFAULT '[]',
  generation INTEGER NOT NULL DEFAULT 1,
  execution_inputs_digest TEXT,
  conformance INTEGER NOT NULL DEFAULT 0 CHECK (conformance IN (0, 1)),
  parked_at TEXT,
  cancelled_at TEXT,
  source_revision TEXT,
  conformance_source_digest TEXT,
  conformance_state TEXT CHECK (conformance_state IS NULL OR conformance_state IN ('source_bound', 'nominated', 'verifying', 'conformed', 'blocked')),
  UNIQUE (phase_plan, number)
);
INSERT INTO stages_0027 ("id", "created_at", "project", "phase_plan", "number", "goal", "modules", "requirement_ids", "implements", "status", "integrated_revision", "work_item",
  "adrs", "tasks", "depends_on", "validation", "integration_obligations", "generation", "execution_inputs_digest", "conformance", "parked_at", "cancelled_at",
  "source_revision", "conformance_source_digest", "conformance_state")
SELECT "id", "created_at", "project", "phase_plan", "number", "goal", "modules", "requirement_ids", "implements", "status", "integrated_revision", "work_item",
  "adrs", "tasks", "depends_on", "validation", "integration_obligations", "generation", "execution_inputs_digest", "conformance", "parked_at", "cancelled_at",
  "source_revision", "conformance_source_digest", "conformance_state" FROM stages;
DROP TABLE stages;
ALTER TABLE stages_0027 RENAME TO stages;

PRAGMA foreign_keys = ON;

-- ---- phase_plans.replacement (D6 §5.7; B08) ---------------------------------------------
-- An early replacement's record, on the plan that replaced: {replaces,
-- generation, trigger {source, id, generation}, evidence, stale, kept[],
-- retained[], cancelled[], superseded[]}. NULL for a plan that replaced none.
ALTER TABLE phase_plans ADD COLUMN replacement TEXT;

-- ---- plan_bundles.replaces (D6 §5.7; B08) -------------------------------------------------
-- {phase_plan, generation}: the active generation an early replacement names;
-- its publication is a compare-and-swap on it. NULL for any other bundle.
ALTER TABLE plan_bundles ADD COLUMN replaces TEXT;

-- ---- plan_checks: computed uncertainty, the declarations, the diff (D6 §5.2, §5.4; B03) ----
-- `uncertain`: why the check itself routes to the human (`phase_size`, F §9.2),
-- never a refusal. `declared`: the Architect's {conformance, adrs_changed,
-- roadmap_revision, notes}, recorded and overridden by the computed routing.
-- `diff`: the record holding every changed artifact, approved and proposed,
-- in full.
ALTER TABLE plan_checks ADD COLUMN uncertain TEXT NOT NULL DEFAULT '[]';
ALTER TABLE plan_checks ADD COLUMN declared TEXT;
ALTER TABLE plan_checks ADD COLUMN diff TEXT REFERENCES records(id);

-- ---- work_items.trigger_evidence (D6 §5.7: "with the triggering evidence on its trigger") --
-- An early replan's: {phase_plan, generation} it replaces, the trigger's
-- evidence, what it made stale, and a rejected proposal's note. Engine-owned;
-- NULL for every other item. The subject keeps D1 A.3's closed keys.
ALTER TABLE work_items ADD COLUMN trigger_evidence TEXT;

-- ---- work_items.end_cause (D6 §5.7; the driver's ruling 10) -------------------------------
-- Why a work item ended other than by its own path: `superseded` for a
-- stage's Builder whose run an early replacement superseded (its late
-- integration history, its work complete and never verified);
-- `plan_replaced` for idle work the swap cancelled. NULL otherwise.
ALTER TABLE work_items ADD COLUMN end_cause TEXT CHECK (end_cause IS NULL OR end_cause IN ('superseded', 'plan_replaced'));
