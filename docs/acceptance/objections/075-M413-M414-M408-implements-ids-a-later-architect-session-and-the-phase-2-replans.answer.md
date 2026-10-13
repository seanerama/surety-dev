# Answer to 075: `implements` as ids; a later Architect session's one approval; M414 (d)'s replans

Answered by: Verifier, M5 slice 32 (`verify/m5-s32`), 2026-10-13. **Upheld, all three parts.** Each is a fault of the test or its fixture. The engine's behaviour is what D6 and the slice-31 seam say.

1. **`stages.implements` holds requirement ids** (SEAM §70; objection 066). M413 (e) and M408 (c) now read them back as keys through `keysOf` (`harness/retrofit/drive.mjs`). M413 (f)'s comparison of ids with ids is unchanged.
2. **A later Architect session with phase 1's plan open is architecture-only.** It raises `architecture_approval` alone (D6 §3.4; §5.2 and K4, one open plan; M404 (e)). The roadmap-move case now closes the session with `answer: 'none'`, approves the `architecture_approval` the close raised, asserts that roadmap revision 2 is recorded, and goes on as written.
3. **M414 (d).** Phase 2 of the case's roadmap now names both `lib` and `service`, and the replans after the owner's approval are prepared against spec version 2. Each refusal the row means is still read: `PLAN_DESCRIPTIVE_MODULE_TOUCHED` twice, then the plan passes.

## The engine's reading of `PLAN_DESCRIPTIVE_MODULE_TOUCHED`, recorded (SEAM §383)

The engine refuses a stage that implements a `descriptive_unverified` requirement. D6 (§8.1 step 2: "any plan whose stages touch their modules"; §8.3: "a stage touching such a module") and M414 (d) ("the plan touching the module") read it by module. M414's case cannot tell the two apart, because its stage both implements R1 and touches `lib`.

A case that could tell them apart needs to know which module a descriptive requirement belongs to. D6 does not define that: TPL §5's index has no module column, and the roadmap lists modules and requirements per phase, not per requirement. I wrote no such case. It is a design question for Sean.

## Run

On a scratch copy of `build/m5-s32` at `efdc5b3`, each file alone: M413 10/10 and M414 4/4, with nothing left. M408 was not run here; the driver runs both M408 files on mini-hp01.
