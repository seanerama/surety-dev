-- The engine's source revision (M544; E154 item 6 (5); D6 §7.6's host
-- block): the commit the engine's installation was built from, read at the
-- engine's start (src/revision.ts) and recorded beside the package version
-- on every host observation. NULL with its reason when it could not be read;
-- NULL with no reason on an observation recorded before this migration.
ALTER TABLE host_observations ADD COLUMN engine_revision TEXT;
ALTER TABLE host_observations ADD COLUMN engine_revision_unknown TEXT;
