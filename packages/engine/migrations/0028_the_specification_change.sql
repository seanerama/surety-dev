-- M5 slice 36 (D6 §4.2 to §4.7; A.2, A.3; K8; B05; reading 6): the
-- specification change. `RefKind` gains `spec_change` (the side ref
-- `refs/surety/spec-change/<seq>`); a request from a finding names it; the
-- Verifier's applicability assessment on a correction is recorded with its
-- provenance; and a requirement's phase follows the current roadmap: an
-- update of `assigned_phase` the roadmap does not give is refused.

PRAGMA foreign_keys = OFF;

-- ---- ref_registry: RefKind gains `spec_change` (D6 A.2) ---------------------------------
CREATE TABLE ref_registry_0028 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('integration', 'lineage', 'nomination', 'recovery', 'oob', 'keep', 'spec_change')),
  expected_oid TEXT NOT NULL,
  immutable INTEGER NOT NULL CHECK (immutable IN (0, 1)),
  UNIQUE (project, ref)
);
INSERT INTO ref_registry_0028 ("id", "created_at", "project", "ref", "kind", "expected_oid", "immutable")
SELECT "id", "created_at", "project", "ref", "kind", "expected_oid", "immutable" FROM ref_registry;
DROP TABLE ref_registry;
ALTER TABLE ref_registry_0028 RENAME TO ref_registry;

PRAGMA foreign_keys = ON;

-- ---- spec_change_requests: a request from a finding names it (D6 A.3) --------------------
ALTER TABLE spec_change_requests ADD COLUMN finding TEXT REFERENCES findings(id);

-- ---- assessments: the Verifier's applicability assessment (D6 §4.5; A.3) ----------------
-- On a correction item of a specification change, the Verifier's claim that a
-- check applies unchanged to the changed meaning of the criteria it names. It
-- resolves the open obligations of that check it covers; fresh evidence under
-- the current generation is still required (D6 §4.5).
CREATE TABLE assessments (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT NOT NULL REFERENCES runs(id),
  work_item TEXT NOT NULL REFERENCES work_items(id),
  request TEXT REFERENCES spec_change_requests(id),
  check_key TEXT NOT NULL,
  "check" TEXT REFERENCES checks(id),
  criteria TEXT NOT NULL,
  rationale TEXT NOT NULL REFERENCES records(id),
  provenance TEXT NOT NULL CHECK (provenance IN ('claimed')),
  obligations TEXT NOT NULL DEFAULT '[]'
);

-- ---- requirements: the phase is the roadmap's (D6 §4.5, §4.7; reading 6) -----------------
-- Once a project has a roadmap, `assigned_phase` changes only to the phase
-- the current (latest) roadmap revision assigns the key, or to null for a key
-- it does not name. The engine writes the roadmap revision first.
CREATE TRIGGER requirements_assigned_phase_follows_roadmap BEFORE UPDATE OF assigned_phase ON requirements
WHEN NEW.assigned_phase IS NOT OLD.assigned_phase
  AND EXISTS (SELECT 1 FROM roadmap_revisions r WHERE r.project = NEW.project)
  AND NOT (
    (NEW.assigned_phase IS NOT NULL AND EXISTS (
      SELECT 1 FROM json_each((SELECT r.phases FROM roadmap_revisions r WHERE r.project = NEW.project ORDER BY r.version DESC LIMIT 1)) p,
        json_each(p.value, '$.requirement_ids') k
      WHERE json_extract(p.value, '$.number') = NEW.assigned_phase AND k.value = NEW.key))
    OR (NEW.assigned_phase IS NULL AND NOT EXISTS (
      SELECT 1 FROM json_each((SELECT r.phases FROM roadmap_revisions r WHERE r.project = NEW.project ORDER BY r.version DESC LIMIT 1)) p,
        json_each(p.value, '$.requirement_ids') k
      WHERE k.value = NEW.key))
  )
BEGIN
  SELECT RAISE(ABORT, 'requirements.assigned_phase follows the current roadmap revision');
END;

-- ---- execution_domains: when supervision was lost, in the store's order -----------------
-- (D1's monotonic rule; the slice-36 review's M2): the highest event seq at
-- the loss, so a result is judged before or after it by the order the store
-- recorded them, never by wall time. `supervision_lost_at` stays as data.
ALTER TABLE execution_domains ADD COLUMN supervision_lost_seq INTEGER;
