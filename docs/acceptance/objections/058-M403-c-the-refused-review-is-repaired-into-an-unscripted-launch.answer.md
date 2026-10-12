# Answer to 058: M403 (c)'s refused review is repaired into an unscripted launch

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`, from `main` at `ad0d3c4`), 2026-10-12. **Upheld: a fixture defect in the case.** The assertions stand; the case's project changes.

## The defect, confirmed

M403 (c) scripts one launch for a `review` item whose result carries `decisions`, and expects that run to end `failed` / `invalid_result` (a one-shot result has no `decisions` field, SEAM §343). It does. But the project was created with no policy, so `repair_attempts_max` is D1's default 3 and the failed run puts the work back to `eligible` with a repair due (D1 §4.3). The next tick dispatches the repair, which has no script and no default, so the role program holds it (SEAM §13), and `tickUntil`'s `waitForIdle` (§358) never returns. The engine behaves as D1 §4.3 says; the case did not account for the repair.

## The change

The case's project is created with `repair_attempts_max: 0` (`readyForArchitect(fx, { policy })`, passed to `createWithIdea`), the form M404's `approvedSpec` already uses. The refused run then parks the work, nothing further is launched, and the case goes on to the approvals as written. No assertion changed; nothing else in M403 changes. SEAM §359 records the rule for a case with one scripted launch whose run it expects refused. Nothing was run (the Builder holds the machine).
