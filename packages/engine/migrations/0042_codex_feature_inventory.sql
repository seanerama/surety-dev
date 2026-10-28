-- Codex's feature inventory on its qualification attempt (D2 §4.6, row
-- D2-T13; C2b of Codex support, 2026-10-28): `codex features list`, run by
-- the attempt's static checks beside `--version` and `--help`, with the
-- same constructed environment, and recorded as the help is.
--
--   feature_inventory         its standard output, as the binary wrote it
--   feature_inventory_sha256  the SHA-256 of those bytes
--
-- Both NULL for a backend that has no such inventory (Claude Code, the
-- scripted backend) and for every attempt written before this migration.
-- The attempt's driver judges the inventory against the template
-- (src/invoke/adapters/codex-features.ts) before any canary is launched.
ALTER TABLE qualification_attempts ADD COLUMN feature_inventory TEXT;
ALTER TABLE qualification_attempts ADD COLUMN feature_inventory_sha256 TEXT;
