# Answer to 064: phase 2's check authoring is unclassifiable under default inputs

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`, from `main` at `5db0b99`), 2026-10-12. **Upheld: a fixture defect.** The journey's human-act counts stand.

## The reading

D3 §3.1 settles it. Under default inputs, "any new protected file changes every default-input check's [fingerprint], and the proposal is unclassifiable". On the other hand, "a new check whose files lie outside every existing check's inputs leaves their fingerprints unchanged", and "declared inputs are what make the remaining tightenings provable".

D6 §1 step 10 says phase 2's "check authoring adds the phase's checks as a tightening". The cases count it that way too:
- M406 (a): "no human act within the phase but the toolchain proposal";
- M401 (g);
- the T1 variant's human-act list.

The fixture had left out what makes that true.

## The change

Every reference check now declares `inputs`, the protected files it reads, and nothing more (`harness/journey/reference.mjs`; SEAM §369):

| Checks | `inputs` |
|---|---|
| each program-based check: `accept-r1` to `accept-r4`, the four integration checks, `phase-regression` | the wrapper and its own test file |
| `lint` | `lint.mjs` |
| `operation` | its post-deploy program |
| `smoke` | `[]`: it runs `node --check src/sum.mjs` and reads no protected file |

Phase 2's new files then lie outside every phase-1 check's manifest. Its authoring is a strict addition, a tightening that the Reviewer approves under `authoritative`.

## Run

Each file alone, on a scratch copy of `build/m5-s31` at `d0f476e` with this branch's tests. No unit or engine was left behind by either run.

- **M406: 6/6.**
- **M407: 1/7, a 31b gap.** Its failures are the policy's deployment request, which the engine does not make yet (`deployment_requests`, 0 rows).
- **M401's T1 variant: 0/3, a 31b gap.** It stops at `POST …/spec/change-requests`, which answers 404 (no route yet).

## A related finding, not changed here (for Sean)

CR-1's scripted correction (`CORRECTED_SERVICE_TEST`) rewrites `service.test.mjs`. That file is in `accept-r2`'s input manifest, so by the same rule ("any change in an existing check's input manifest", "a changed input file is unclassifiable, not judged") the correction is `unclassifiable` and goes to the owner.

SEAM §353 and the cases assume otherwise:
- SEAM §353 calls it a tightening applied under `authoritative`.
- M401 part 2 (h) and the T1 variant list the human acts after CR-1 as its submission and approval only.

Two ways out, both a decision for Sean:
1. Count the correction as a routed human act (D6 §1 step 6 allows "an unclassifiable check correction").
2. Write the correction as a new check covering R2.1's new text, a strict addition, leaving `accept-r2` as it was. That is honest only if the obligation is resolved by a new check rather than a corrected one, which D6 §4.5 and B05 leave to slice 36.

I have not changed either the fixture or the counts.
