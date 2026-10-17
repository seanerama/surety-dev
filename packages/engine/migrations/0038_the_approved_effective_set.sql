-- E162 item 4 (D7 §6.4 as clarified): every design approval durably
-- identifies its own effective asset set, unchanged assets and placeholders
-- included. Recorded on the approved revision in the transaction that
-- approves it, after the set has moved: `effective_assets` is the whole set
-- as that approval left it, [{slot, variant, slot_version, source, digest}]
-- ordered by slot then variant, one entry per selected slot and variant;
-- `effective_assets_digest` is the sha256 of its canonical JSON (the same
-- set gives the same digest, whichever approval recorded it). Written once,
-- by the approval; `design_effective_assets` stays the current set. NULL on
-- a revision not approved, and on revisions approved before this migration.
ALTER TABLE design_revisions ADD COLUMN effective_assets TEXT;
ALTER TABLE design_revisions ADD COLUMN effective_assets_digest TEXT;
