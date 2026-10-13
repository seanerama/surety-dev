-- M5 slice 32 (D6 §8; A.2, A.3, A.5; K10, K11; B10 to B13; Sean,
-- 2026-10-12): the adoption's immutable source revision A, the adopted
-- repository's releases, the claims table, the conformance stage's
-- lifecycle and source binding, the conformance-phase `fix` remediation,
-- the adopted tests on an authoring proposal, and a candidate's recorded
-- application-source projection.

-- ---- projects.adoption: A is immutable once recorded (B11; D6-R01) ------------------------
-- `adoption` (JSON) holds {pinned_revision, branch, signals, recommended_mode,
-- mode, source_digest, ...}. Its `pinned_revision` is written in the
-- transaction that intends the bootstrap commit and is never changed after.
CREATE TRIGGER projects_adoption_pinned_immutable BEFORE UPDATE OF adoption ON projects
WHEN json_extract(OLD.adoption, '$.pinned_revision') IS NOT NULL
  AND json_extract(NEW.adoption, '$.pinned_revision') IS NOT json_extract(OLD.adoption, '$.pinned_revision')
BEGIN SELECT RAISE(ABORT, 'projects: the adoption''s pinned revision A is immutable'); END;

-- ---- releases: tags of an adopted repository (E6; D6 §8.1 step 1, §8.3) -------------------
-- A tag the repository carries is a release Surety did not make:
-- `external_unverified`, no artifact, no candidate progress.
CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  revision TEXT,
  state TEXT NOT NULL CHECK (state IN ('external_unverified')),
  artifact TEXT,
  candidate TEXT REFERENCES candidates(id),
  UNIQUE (project, name)
);
CREATE TRIGGER releases_external_no_candidate BEFORE UPDATE ON releases
WHEN NEW.state = 'external_unverified' AND (NEW.candidate IS NOT NULL OR NEW.artifact IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'releases: an external_unverified release has no artifact and no candidate'); END;

-- An environment the adopted repository's signals name (`adoption_signal`),
-- recorded by name, never configured or read by the engine.
ALTER TABLE environments ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('adoption_signal'));

-- ---- spec_claims: TPL §12 "Claims and reality" (K10) ---------------------------------------
CREATE TABLE spec_claims (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  spec_revision TEXT NOT NULL REFERENCES spec_revisions(id),
  ordinal INTEGER NOT NULL,
  claim_source TEXT NOT NULL,
  claim TEXT NOT NULL,
  observed TEXT NOT NULL,
  requirement TEXT REFERENCES requirements(id),
  UNIQUE (spec_revision, ordinal)
);

-- ---- the conformance stage (K11; B11; A.3, A.5) --------------------------------------------
ALTER TABLE stages ADD COLUMN source_revision TEXT;
ALTER TABLE stages ADD COLUMN conformance_source_digest TEXT;
ALTER TABLE stages ADD COLUMN conformance_state TEXT CHECK (conformance_state IS NULL OR conformance_state IN ('source_bound', 'nominated', 'verifying', 'conformed', 'blocked'));

-- The application-source projection digest of a candidate's revision (the
-- tree outside `.surety/`, by path, mode and blob), as the engine read it;
-- NULL while unread.
ALTER TABLE candidates ADD COLUMN source_digest TEXT;

-- ---- the conformance-phase `fix` (B12): the proposed remediation recorded ------------------
ALTER TABLE findings ADD COLUMN remediation TEXT;

-- ---- adopted tests on an authoring proposal (B13; B.7) -------------------------------------
ALTER TABLE protected_proposals ADD COLUMN adopted_tests TEXT;
-- The proposal check's import-boundary refusals (D6 §8.3): each import under
-- the protected root that resolves outside it undeclared.
ALTER TABLE protected_proposals ADD COLUMN boundary_errors TEXT;

-- ---- spec_change_requests: a retrofit replan's request (D6 §8.3; B.7) --------------------
-- An Architect's replan in retrofit may ask for criteria of descriptive
-- requirements its phase touches; each is an ordinary request, its source
-- `replan`, approved by the owner like any.
PRAGMA foreign_keys = OFF;
CREATE TABLE spec_change_requests_0025 (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  spec_revision TEXT REFERENCES spec_revisions(id),
  text TEXT REFERENCES records(id),
  request_text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('owner', 'finding', 'replan')),
  status TEXT NOT NULL CHECK (status IN ('requested', 'proposed', 'approved', 'rejected', 'failed')),
  work_item TEXT REFERENCES work_items(id),
  proposal_revision TEXT,
  proposal_blob TEXT,
  side_ref TEXT,
  impact TEXT REFERENCES records(id),
  impact_value TEXT,
  approved_revision TEXT REFERENCES spec_revisions(id),
  failure TEXT,
  last_refusal TEXT,
  -- `replan`: the run whose result asked for it, and the keys it names.
  run TEXT REFERENCES runs(id),
  keys TEXT,
  UNIQUE (project, seq)
);
INSERT INTO spec_change_requests_0025 ("id", "created_at", "project", "seq", "spec_revision", "text", "request_text", "source", "status", "work_item", "proposal_revision", "proposal_blob", "side_ref", "impact", "impact_value", "approved_revision", "failure", "last_refusal")
SELECT "id", "created_at", "project", "seq", "spec_revision", "text", "request_text", "source", "status", "work_item", "proposal_revision", "proposal_blob", "side_ref", "impact", "impact_value", "approved_revision", "failure", "last_refusal" FROM spec_change_requests;
DROP TABLE spec_change_requests;
ALTER TABLE spec_change_requests_0025 RENAME TO spec_change_requests;
PRAGMA foreign_keys = ON;
