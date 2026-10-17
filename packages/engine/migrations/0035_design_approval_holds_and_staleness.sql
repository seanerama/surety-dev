-- M6 slice 44 (D7 draft 3 §§7 to 11; Appendix A.3; G2, G6, G8; SEAM.md
-- §§513 to 519): approval, holds, staleness and the plan. Numbered 0035 to
-- leave 0034 to slice 43.

-- The planned design obligation (D7 §8.3; SEAM.md §513): a passed plan check
-- before any design is approved, under `before_build` or `both`, records
-- [{stage, targets}] per UI stage of its plan; [] otherwise; NULL on a check
-- recorded before this migration.
ALTER TABLE plan_checks ADD COLUMN design_obligations TEXT;

-- B.5's stage `screens` (G6; D7 §8.1): the approved design's screen keys a
-- published plan names for the stage, which the stage-to-screen binding then
-- uses; NULL when the plan names none (the binding is computed).
ALTER TABLE stages ADD COLUMN screens TEXT;
