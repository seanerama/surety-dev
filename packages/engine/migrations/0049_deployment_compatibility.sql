-- Deployment compatibility (the owner's instruction of 2026-10-29: before a
-- build begins, whether the selected target can host the intended output,
-- or the capability it lacks; the static-preview shapes, §5). One row per
-- evaluation, made when a plan is published, when an environment is
-- configured and when a candidate is nominated, in the transaction of
-- each (deploy/compatibility.ts), each with its
-- `deployment.compatibility_evaluated` event. Information
-- only: nothing is gated or held on it.
--
--   trigger      plan_published, environment_configured or
--                candidate_nominated
--   basis        the canonical inputs it was computed from (the approved
--                specification and architecture revisions, the current
--                candidate and its revision, each environment with its
--                prefix and current configuration); a read serves the
--                newest row whose basis is the store's now and that was made
--                from the current candidate's tree as read, and otherwise
--                computes the answer for that read without writing
--   candidate    the current candidate when it was evaluated, or NULL
--   tree         that candidate's tree as the main thread read it from the
--                object store before the act (its output kind and why, or
--                why it could not be read), JSON; NULL with no candidate or
--                none read
--   output_kind  static_site, node_service or unknown
--   evaluation   the served object: { evaluated_at, output_kind,
--                environments: [{ environment, name, adapter, mode, state,
--                missing_capability, reason }], hosting_required, reason }
-- Numbered 0049 (0046 on verify/static-preview; renumbered at the
-- integration after the rapid prototype's 0044 to 0046): the static-preview
-- slice takes 0047 (the serving check and static sites) and 0048
-- (deliverables).
CREATE TABLE deployment_compatibility (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  "trigger" TEXT NOT NULL CHECK ("trigger" IN ('plan_published', 'environment_configured', 'candidate_nominated')),
  basis TEXT NOT NULL,
  candidate TEXT REFERENCES candidates(id),
  tree TEXT,
  output_kind TEXT NOT NULL CHECK (output_kind IN ('static_site', 'node_service', 'unknown')),
  evaluation TEXT NOT NULL
);
CREATE INDEX deployment_compatibility_by_project ON deployment_compatibility(project);

CREATE TRIGGER deployment_compatibility_final BEFORE UPDATE ON deployment_compatibility
BEGIN SELECT RAISE(ABORT, 'deployment_compatibility: an evaluation is written once'); END;
CREATE TRIGGER deployment_compatibility_no_delete BEFORE DELETE ON deployment_compatibility
BEGIN SELECT RAISE(ABORT, 'deployment_compatibility: an evaluation is never deleted'); END;
