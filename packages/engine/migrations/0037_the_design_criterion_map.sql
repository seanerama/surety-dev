-- M6 slice 46 (D7 §7.1, §7.2, §8.4; the slice-46 review's B1): each design
-- criterion of an approved design, by its index in criteria.json, mapped to
-- the specification criterion its consolidated change wrote, in the
-- transaction that applies the change: [{index, requirement, kind, id,
-- requirement_key, targets, how, why?}], `id` null where none could be
-- mapped (with why). What the Verifier's and the Builder's packages and the
-- review read, never the text again. NULL on an asset-only revision, on one
-- approved without criteria, and on revisions approved before it.
ALTER TABLE design_revisions ADD COLUMN criterion_map TEXT;
