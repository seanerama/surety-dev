# 106: M433 (f) runs a correction beside a proposed specification change, which the driver's Q2 ruling excludes; M425 (e) opens a session while the replan whose approval it read is still ending; M441's per-stage duration meets the host's clock stepping back

Rows: M433, M425, M441
Filed by: Builder, slice 37, 2026-10-14

## Claims

Each file was run alone on `build/m5-s37` at 1243c9c.

**M433-old-generation-runs-and-what-resolves-an-obligation (f).** The case makes a second `check_correction` (`rediscovery`, `subject: {}`) in `beforeAnswer`: while CR's specification change is proposed, before the owner's answer. It waits for that correction to hold at its gate: "the other correction holding: not reached within 20 rounds".

The driver's Q2 ruling (slice 37) holds every protected writer of a project from dispatch (`depends_on`) while a specification change of it is being proposed, or is proposed and unapplied. That is so the change's impact is asked about once. The correction is held, as ruled.

I propose the case make `rediscovery` after the change is applied, or answer the change first and then run it under the new generation. Its (g) half reads the rediscovery's evidence as "deciding nothing", and that still holds either way.

**M425-plan-references-and-approvals (e).** The case reads proposal A's routed `plan_approval` (`nextReplanOutcome`) and at once opens the owner's Architect session. The approval is raised in the replan's finalization, before its `run.ended`. The session is refused 409 `session_busy` ("Project … has a one_shot run (run_…, architect) that has not ended"), because D6 §2.7 allows no session beside a one-shot run. With integrations now ordered under the integration lease (the review's M3), the replan's end can come a moment later than before.

I propose the case wait for the replan's run to end before opening the session.

**M441-the-pace-read-after-the-journey (a) per stage.** "stage 1 of phase 1: integrated_to_first_evaluation † ({"unknown":"its first stage evaluation was recorded before its integration"})". In the kept store the stage's `work.integrated` is event seq 529 at 16:00:07.875, and its first stage `gate.evaluated` is seq 696 at 16:00:07.664. The evaluation was inserted after the integration, at a wall time 0.2 s earlier: this host's clock steps back (E148).

The pace read measures a duration only from wall times and reports a negative one as `unknown`, never a value. The case asserts a number.

I propose it accept `unknown` with that reason, or the read could carry the step as its own reason. Whether a duration across a clock step should instead be measured another way is a question for the driver; I have not changed the engine for it.

## Sources

- The driver's Q2 ruling (slice 37); D6 §2.7, §4.4, §7.6; E148; the slice-37 review's M3.
