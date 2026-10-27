-- The owner's policy submissions (POST /v1/projects/:p/policy) and what each
-- was answered (the usability batch of 2026-10-27, decision 6): so that a
-- client whose answer was lost can settle it without submitting again.
--
--   intent_id    the client's optional identifier of the submission; a
--                repeat with the same one and the same body is answered
--                the stored answer (no second revision), a different body
--                is refused policy_intent_conflict. NULL when none was sent.
--   fingerprint  sha256 of the canonical body without intent_id.
--   outcome      accepted (a revision intended through the journal, or a
--                governed edit captured as a proposal), unchanged (nothing
--                to commit), refused (a 4xx answered in its transaction:
--                confirm_required). A refusal thrown before anything is
--                written records nothing.
--   revision     the policy revision intended, or NULL.
--   operation    the journal's commit of `.surety/policy.json` (its git
--                commit operation), from which the revision's commit state
--                is read: pending until the ref update's finalizer records
--                the revision, then committed; failed if the journal fails
--                it.
--   status, answer  the HTTP status and body answered.
-- Recorded for every accepted submission and for every submission that
-- carried an intent_id. A submission is written once and never changes.
CREATE TABLE policy_submissions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  intent_id TEXT,
  fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'unchanged', 'refused')),
  revision INTEGER,
  operation TEXT REFERENCES operations(id),
  status INTEGER NOT NULL,
  answer TEXT NOT NULL,
  UNIQUE (project, intent_id)
);

CREATE TRIGGER policy_submissions_final BEFORE UPDATE ON policy_submissions
BEGIN SELECT RAISE(ABORT, 'policy_submissions: a submission is written once'); END;
CREATE TRIGGER policy_submissions_no_delete BEFORE DELETE ON policy_submissions
BEGIN SELECT RAISE(ABORT, 'policy_submissions: a submission is never deleted'); END;
