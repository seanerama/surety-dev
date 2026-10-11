# 053: M334 (a) passes only if the service happens to write its periodic secret line between the flood's end and the collection

Row: M334
Test: packages/engine/test/acceptance/M334-output-withheld-and-logs-redacted.test.mjs, case "(a), (b), (c), (f) while supervised", assertion "(a) including the lines that carried the secret" (line 195)
Filed by: Builder, slice 29, 2026-10-11

## Claim

The assertion depends on timing, not on the engine. It fails on code that passed it before, and the build's change is not the cause:

- It failed in the driver's second slice-29 gate (`dece59a`).
- It failed 3 of 3 times alone on `e73c4b1` (`fdee5c9` with `main` merged).
- It failed 1 of 1 alone on `ed2b154`, the commit whose first gate it passed, with the same test and harness.

**What the case needs to see.**
- The service writes `SECRET-OUT-<MARK> <value>` once at start, then every `SURETY_TEST_SECRET_EVERY_MS` = 2,000 ms (`setInterval`).
- The check's `/act/flood` writes 256 KiB of filler and then `FLOOD-END-<MARK>`.
- A collection keeps the newest output within `adapter_output_max_bytes` = 64 KiB, as whole lines.

So the record holds a `SECRET-OUT` line only if one was written after the flood ended and before the collection read the capture. Every secret line written before the flood lies more than 64 KiB back, and is rightly not in the record.

**What happened in the kept run** (`e73c4b1`, `SURETY_KEEP_TMP=1`):
- The launch was granted at 35.876 s.
- The held check launched at 44.010 s, flooded, and its result was recorded at 44.432 s.
- The `deployment_logs` record was written at 44.907 s, about 0.5 s after the flood.
- The record (64,535 bytes) ends with `FLOOD-END-03738b3c2309` and holds no `SECRET-OUT` line. The secret lines of 37.9, 39.9, 41.9 and 43.9 s were all written before the flood.

**Durations.** The case took 18.4 s when it passed (the first gate, `ed2b154`) and 10.7 s when it failed (the second gate). When nothing else delays the round, the collection follows the flood by well under the 2 s interval.

**This is not the wall clock.** The interval is a Node timer, which runs on the monotonic clock.

Suggested (any one):
- Collect only after a `SECRET-OUT` line has been written after the flood. For instance, wait at least `SURETY_TEST_SECRET_EVERY_MS` plus a margin after the check's result before asking for the collection.
- Have the fixture write a `SECRET-OUT` line immediately after `FLOOD-END`.
- Flood less than 64 KiB, so that an earlier secret line stays inside the window.

## Sources

- M4 plan M334 (a): the record holds the service's newest output, redacted before disk.
- D4 §§6.1, 9.3: the collection reads the init's rolling capture within a byte bound.
- `harness/deploy/fixture-service.cjs`: `flood` (256 KiB, then `FLOOD-END`), and `SURETY_TEST_SECRET_EVERY_MS` (`setInterval`).
