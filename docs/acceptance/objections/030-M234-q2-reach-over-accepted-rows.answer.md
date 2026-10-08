# 030: answer

Row: M234 (Q2's reach), over accepted rows M42, M43, M44, M51, M105, M106, M206, M207, M223
Answered by: Verifier, M3 slice 21, 2026-10-08, on `verify/m3-s21-obj`

## Upheld; the tests changed

The objection is right. D3 §2.10 sends back "a `fix` item and a `stage_build` item in `verifying`" in every transition that records a result, and SEAM.md §228 makes a fixture result a recorded result. The engine is not narrowed. The driver ruled that Q2 is decided (E90 item 2). By E92 item 2 (3), the accepted tests a decided correction changes are updated by the Verifier in the slice that brings it, with no compatibility setting. The question left for Sean in `COVERAGE.md` ("M3 slice 21") and SEAM.md §234 is answered that way.

**The instrument.** A case that is not about the repair sets `repair_attempts_max` 0, so Q2 parks the work instead of sending it back. The limit is set **before the build**, so the policy commit of `.surety/policy.json` is already in the first candidate and nothing moves the integration branch afterwards. `harness/gates.mjs` `nominated` gains a `policy` option for this.

**The changes, case by case:**
- **M42, the fourth case.** `clean` passes `{ repair_attempts_max: 0 }`. `regress` failing on candidate 1 parks the stage's work. Every assertion is unchanged: the fix, its resolution by the evaluation, the fix's path, the reopening.
- **M43, "T2: the candidate's review is queued…".** `repair_attempts_max` 0. **This case contradicted Q2, so it now pins it.** Once the failure takes the stage's work out of `verifying`, the ticks no longer evaluate that candidate's `stage` gate. Without the limit, the repair's candidate supersedes it instead. So the case asks for the evaluation:
  - after the failure, the evaluation is not satisfied (`CHECK_NOT_PASSED`) and queues no review;
  - after the pass, the engine queues the review in that evaluation, not a fixture's, with the trigger `("verification", c, 1)`.

  The chain boundary, "once" across ticks and a restart, and "none before the verification" are unchanged. What is lost is that a tick's own evaluation queues the review. SEAM.md §70 says the engine registers the review "within the ticks that follow" the last pass, and names no condition on the stage's work. Whether it should do so for a candidate whose stage work Q2 parked is a design question for Sean. The case does not read it.
- **M44, "a stage's work is complete only when its stage gate is satisfied…".** **This case contradicted Q2 ("a failed execution completes nothing", read as the work staying `verifying`), so it now pins Q2:**
  - the failure sends the stage back (`eligible`, `repair_attempts` 1);
  - the stage's Builder is scripted for the repair run, which asks for the nomination;
  - on the repair's candidate, the verification completes and the work does not;
  - a passing execution completes the work at a tick, `satisfied`;
  - the path is the stage path twice up to `verifying`, then `complete`;
  - no authorization is issued and nothing is deployed for either candidate.
- **M51, all six cases** (`findingOf`): `repair_attempts_max` 0. No assertion changed.
- **M105 (a) to (f)** (`reviewed`): `repair_attempts_max` 0. No assertion changed.
- **M106 (a), (d)** (`withFindings`): `repair_attempts_max` 0. No assertion changed.
- **M206 (e):** `repair_attempts_max` 0. No assertion changed.
- **M207, bounded history, (c)/(b):** `changePolicy` with `repair_attempts_max` 0 between `discoveredProject` and `nominateStage`. No assertion changed.
- **M223 (sandbox), (a)/(c)/(b):** `repair_attempts_max` 0 after `checkProject`, before the plan, so the broken fix is parked. No assertion changed.

SEAM.md §234 and `COVERAGE.md` ("M3 slice 21") record each change. Against `build/m3-s21` at `05646e3`, each file was run alone: M42 7/7, M43 7/7, M44 6/6, M51 6/6, M105 7/7, M106 4/4, M206 3/3, M207 1/1, M223 1/1.

## Sources
- D3 §2.10; E90 item 2 (Q2 (a)); E92 item 2 (3); SEAM.md §§70, 228, 229, 234.
