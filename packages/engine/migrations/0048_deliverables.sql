-- The downloadable Alpha deliverable (the owner's instruction of 2026-10-29;
-- SHAPES.md §4): a versioned zip package of a candidate's sealed artifact,
-- bound to the candidate and its artifact digest, written once under
-- $SURETY_HOME/artifacts/<project>/<digest>.zip and recorded here; a read
-- re-verifies its size and SHA-256. A row never changes and is never
-- removed.

CREATE TABLE deliverables (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  candidate TEXT NOT NULL REFERENCES candidates(id),
  revision TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('zip')),
  version TEXT NOT NULL,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  sha256 TEXT NOT NULL,
  entries INTEGER NOT NULL CHECK (entries >= 0),
  -- The sealed artifact's manifest the package was built from, which every
  -- read checks the package's entries against.
  manifest TEXT NOT NULL,
  output_kind TEXT NOT NULL CHECK (output_kind IN ('static_site', 'node_service', 'unknown')),
  built_at TEXT NOT NULL,
  UNIQUE (candidate, artifact_digest)
);
CREATE INDEX deliverables_by_candidate ON deliverables(candidate);
CREATE TRIGGER deliverables_no_update BEFORE UPDATE ON deliverables
BEGIN SELECT RAISE(ABORT, 'deliverables: a package row never changes'); END;
CREATE TRIGGER deliverables_no_delete BEFORE DELETE ON deliverables
BEGIN SELECT RAISE(ABORT, 'deliverables: a package row is never removed'); END;
