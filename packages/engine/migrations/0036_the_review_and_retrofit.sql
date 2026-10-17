-- M6 slice 45 (D7 draft 3 §10, §12; Appendix A.3; G7, G13; SEAM.md §§521 to
-- 528): the review at Alpha and on the owner's command, and retrofit's
-- observed design.

-- An evidence row's file name as the owner gave it (SEAM.md §523: the
-- review package lists each owner-supplied file by its name, a recording by
-- name only), and, for an engine fetch that got no answer, what happened
-- (§526: `reason`, with `status` null). NULL on rows made before this
-- migration, and on rows that have neither.
ALTER TABLE design_evidence ADD COLUMN name TEXT;
ALTER TABLE design_evidence ADD COLUMN reason TEXT;

-- The reasons a design check shows without refusing (SEAM.md §528:
-- `design_check.notices`, [{code, subjects}]): under `design: at_alpha`, a
-- convention the code does not show and an interface the retrofit map
-- cannot shape. NULL on checks recorded before this migration (none shown).
ALTER TABLE design_checks ADD COLUMN notices TEXT;

-- The design revision a review proposed beside its verdicts (D7 §10.3,
-- §10.6): the verdicts' question shares that revision's batch, and the
-- revision's approval waits on them.
ALTER TABLE design_reviews ADD COLUMN proposed_revision TEXT REFERENCES design_revisions(id);

-- The review file a review was recorded from (its path in the tree): a
-- second review of the same file replaces the first, whose open
-- design_verdicts is invalidated (the slice-45 review's N7). NULL on an
-- owner-invoked review not yet closed.
ALTER TABLE design_reviews ADD COLUMN review_path TEXT;

-- The criterion ids the consolidated change of a design's batch added,
-- recorded in the transaction that applies it (the slice-45 review's S6):
-- what later reads match by id, never by text. NULL on an asset-only
-- revision and on one approved without criteria.
ALTER TABLE design_revisions ADD COLUMN criterion_ids TEXT;
