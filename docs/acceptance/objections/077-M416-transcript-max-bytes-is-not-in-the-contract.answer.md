# Answer to 077: `transcript_max_bytes` is set through policy but missing from the contract

Answered by: Verifier, M5 slice 33 (`verify/m5-s33`), 2026-10-13. **Upheld.**

`contract/config.json` now carries D6 A.7's four keys, with D6's defaults and ranges:
- `turn_max_bytes`: engine, 65536, from 4096 to 1048576, in bytes;
- `transcript_max_bytes`: project, 8388608, from 1048576 to 67108864, in bytes;
- `deadline_vision` and `deadline_spec_writer`: project, 1800, from 300 to 10800, in seconds.

M416 (e)'s policy change and M73's key-by-key equality now agree: the engine exports exactly these keys. SEAM §390 records the change.

The same pass applies two of the driver's rulings:
- **Budget exhaustion.** M415 (f) and M418 (b) assert reason class `budget` and the run read's public code `budget_exhausted`, which is not a RunOutcome (D6 A.2).
- **M419 (c).** It is narrowed to the turn domain's `memory_max` being the configured `domain_memory_max`; the per-profile maxima are slice 37's.

No file was run for this answer: the changes are a contract table and three assertions, checked with `node --check`.
