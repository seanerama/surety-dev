-- The driver's ruling on loop run 1 (M444 #19, L1-2), option (ii): a
-- proposal whose base does not hold the effective protected version is
-- classified on its own changes rebased onto the effective revision
-- (checks/classify-inputs.ts classifiedTree), and that tree is recorded: the
-- application compares the protected set it would commit with it, and a
-- proposal is classified again, on a new rebase, when the effective version
-- moves past its classification. NULL: the proposal's own tree (classified
-- before this migration, or by a fixture).
ALTER TABLE protected_proposals ADD COLUMN classified_tree TEXT;
