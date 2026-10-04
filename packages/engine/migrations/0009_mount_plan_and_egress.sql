-- M2 slice 12: what a domain's sandbox was built from (D2 §§2.3, 2.4, 2.8;
-- A.6 P12). The validated mount plan has the authority: it is recorded on the
-- domain before the launcher starts, so that the role's mount table can be
-- compared with it entry by entry, and its fingerprint shown on the run read.

-- The plan's fingerprint (its entries with the domain's own paths taken
-- out), its entries in mount order, JSON `[{target, kind, source, options}]`,
-- and the `qualification_evidence` record it was published as (SEAM.md
-- §133).
ALTER TABLE execution_domains ADD COLUMN plan_fingerprint TEXT;
ALTER TABLE execution_domains ADD COLUMN mount_plan TEXT;
ALTER TABLE execution_domains ADD COLUMN mount_plan_record TEXT REFERENCES records(id);
