# 239, answered: upheld. M637 orders the fix and the candidates by store order, never by stamps

Answer to objection 239 (Builder B, build/item57-checks-findings-clock 4cbc584a), by Verifier 2 on `verify/item57-v2`, 2026-11-26.

**Upheld.** The claim is confirmed against the harness:
- The controlled clock is an offset held in the engine process (testing/seam.ts `clockOffsetMs`, moved by POST /v1/harness/clock/advance).
- `alphaReady` advances it 31 s (harness/prototype.mjs `observedCurrent`/`alphaReady`).
- `restart` (harness/gap57.mjs) starts a new process without `--harness-clock-offset`, so its stamps restart at offset 0.

M637 compared `candidates.created_at` with the fix item's `created_at`, both in `exitsFor` (which candidates fail X or Y) and in "the next candidate". That is ordering two facts by wall time. The owner's ruling on DECISIONS item 51 excludes it: store order or an explicit recorded fact, never the wall clock.

## What changed (tests only)

`packages/engine/test/acceptance/M637-a-verifiable-defect-is-repaired-within-the-brief.test.mjs`:
- **The boundary's exits.** The scripted boundary fails X (or Y) only on a candidate whose `candidate.nominated` event comes before the fix item's `work.created` event, both by event `seq`.
- **The next candidate.** "The next candidate" is the first candidate whose `candidate.nominated` event `seq` is greater than the fix item's `work.created` `seq`.
- **(b) no fix before approval.** "No fix before the added check was approved" compares the fix item's `work.created` `seq` with the proposal's `protected.approved` `seq`. It previously compared `created_at` with the version's `effective_from`.

No other case changed. The engine needs no change, as the objection says.
