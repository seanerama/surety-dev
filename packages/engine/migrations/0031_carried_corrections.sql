-- M6 slice 39, the corrections carried from M5 (E154 item 6; E156 Q1).

-- The engine's source revision (M544; E154 item 6 (5); D6 §7.6's host
-- block): the commit the engine's installation was built from, read at the
-- engine's start (src/revision.ts) and recorded beside the package version
-- on every host observation. NULL with its reason when it could not be read;
-- NULL with no reason on an observation recorded before this migration.
ALTER TABLE host_observations ADD COLUMN engine_revision TEXT;
ALTER TABLE host_observations ADD COLUMN engine_revision_unknown TEXT;

-- A replan held for its prerequisite results (M543; M444F-1; SEAM.md §474):
-- the HoldReason `prerequisite_results`. The column's CHECK is widened by
-- remaking the column (SQLite keeps a column's CHECK in the table's
-- definition): renamed, added again with the wider CHECK, its values
-- copied, the old one dropped. Nothing references the column but the table.
ALTER TABLE work_items RENAME COLUMN held TO held_0031;
ALTER TABLE work_items ADD COLUMN held TEXT CHECK (held IN (
  'resource_envelope', 'chain_boundary', 'depends_on', 'authoring_readiness', 'open_decision', 'session_busy', 'prerequisite_results'));
UPDATE work_items SET held = held_0031;
ALTER TABLE work_items DROP COLUMN held_0031;
