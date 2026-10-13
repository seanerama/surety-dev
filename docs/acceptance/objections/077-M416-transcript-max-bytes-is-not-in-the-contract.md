# 077: M416 (e) sets `transcript_max_bytes` as a project policy key, which the contract does not list and M73 forbids

Rows: M416 (e); M73 (the closed configuration, key by key)
Tests:
- packages/engine/test/acceptance/M416-the-transcript-and-its-speakers.test.mjs:73-89 ("(e) turn_max_bytes: 413 turn_too_large; transcript_max_bytes: the next turn refused with its reason"), line 77: `changePolicy(fx.engine, p.id, { transcript_max_bytes: 1048576 })`, which asserts 200.
- packages/engine/test/acceptance/M73-executable-contract.test.mjs:234-241: for `engine` and `project`, the exported contract's configuration keys must deep-equal `contract/config.json`'s.

Filed by: Builder, slice 33, 2026-10-13 (before any slice-33 code; found by reading)

## The conflict

SEAM.md §390 says `transcript_max_bytes` is a project policy key (D6 A.7: project, 8 MiB, 1 to 64 MiB). The slice-33 additions to `contract/config.json` list `backend_vision`, `backend_spec_writer` and the six `model_<role>` keys, but not `transcript_max_bytes`. Nor do they list `turn_max_bytes` (engine), `deadline_vision` or `deadline_spec_writer` (project), which D6 A.7 also adds.

So the engine can do one of two things, and each fails a test:
- If it adds `transcript_max_bytes` to its project configuration, M416 (e)'s policy change is accepted. But the exported contract's project keys then differ from `config.json`'s, and M73 fails ("the project configuration keys").
- If it doesn't add the key, the policy route refuses the change with 400 `unknown_field`, and M416 (e) fails at line 77.

M07 is not affected: it compares project keys one by one, not as a set.

`turn_max_bytes` causes no conflict. M416 (e) posts a turn over 64 KiB and never sets the key, so the engine can hold the bound at D6's default without exporting it. `deadline_vision` causes none either, because M415 (b) reads the 30-minute deadline and sets no key.

## What I believe is right

Add `transcript_max_bytes` to `contract/config.json`'s `project` block: default 8388608, min 1048576, max 67108864, unit `bytes`, from D6 A.7. Optionally add the other three A.7 keys in the same change: `turn_max_bytes` (engine; 65536, 4096 to 1048576, `bytes`), and `deadline_vision` and `deadline_spec_writer` (project; 1800, 300 to 10800, `s`). The engine then exports exactly those keys, and M416 (e) and M73 both hold.

Until this is answered, the Builder exports none of these four keys. It enforces `turn_max_bytes` and the role deadlines at D6's defaults. M416 (e) is expected to fail at line 77, and M73 to keep passing.
