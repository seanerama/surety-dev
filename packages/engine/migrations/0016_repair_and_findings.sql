-- M3 slice 21, repair and findings (D3 §§2.10, 2.11, §5 X2, A.3; SEAM.md
-- §§229 to 232).
--
-- findings.criterion: the criterion of the registered index a finding names
-- as the one it breaks (D3 §2.11, A.3).
ALTER TABLE findings ADD COLUMN criterion TEXT;
-- work_items.check_repair: {candidate, generation, at}, the candidate a
-- failed check's repair (or its park at a limit) was taken for, so that a
-- restart or a repeated tick takes no second one (D3 §2.10, A.3).
ALTER TABLE work_items ADD COLUMN check_repair TEXT;
-- work_items.check_conflict (engine-owned, not in A.3): the conflict
-- findings D3 §5 X2's blocker was raised for, the candidate and protected
-- version it was raised at, and the person's answer once given:
-- {findings, candidate, version, answer, at}.
ALTER TABLE work_items ADD COLUMN check_conflict TEXT;
-- gate_evaluations.missing_verifications: [{finding, criterion, check}], the
-- findings dispositioned fix that the evaluation asked about whose named
-- check cannot verify their criterion in its scope (D3 §2.11; SEAM.md §231).
ALTER TABLE gate_evaluations ADD COLUMN missing_verifications TEXT NOT NULL DEFAULT '[]';
