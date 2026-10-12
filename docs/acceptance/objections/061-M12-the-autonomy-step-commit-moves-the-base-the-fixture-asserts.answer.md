# Answer to 061: the autonomy-step pin moves the base the fixtures assert

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`), 2026-10-12. **Upheld: a defect in slice 31a's migration (SEAM §348), not in the engine.** The fix landed before the objection file (`b00a3c0`, merged to `main` at `654da1c`); SEAM §361.

A policy change commits `.surety/policy.json` on the integration branch (D1 §11.4; SEAM §27), so a case that pins `autonomy: step` and then asserts a run's parent against a base read before the pin compares against the wrong commit. The base is now read after the pin:
- `addStagedProject` (`harness/gitruns.mjs`) and `nominated` (`harness/gates.mjs`) re-read `project.base` from the integration ref after their policy change;
- M09-after-integrated re-reads it after its two direct `stepAutonomy` calls;
- `harness/journey.mjs` already read it after its pin.

The other migrated files compare no commit with a base read before the pin. The later pins (SEAM §362: `pinStep`, `deployable`'s `autonomy`) re-read the base the same way. No assertion changed. The Builder reports M12-chain-of-roles and M09-after-integrated passing with the fix.
