# Answer to 071: the project-lane journey's waits count ticks

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`), 2026-10-12. **Upheld.** One domain at a time, with its mount plan validated and recorded (D2 §2.3), stays as built. The waits change.

## The change (`harness/journey/drive.mjs` `pump`; SEAM §375)

On the project lane, `pump` is bounded by time, not by ticks:

- **Time:** a wait fails once `projectMs` has passed (`PROJECT_WAIT_MS`, 1,200 s by default).
- **Stall:** a wait also fails as soon as the store's `events` have not grown for `PROJECT_STALL_MS` (180 s). A stuck engine therefore fails with its last event seq and its tick count; it does not hang.
- **Per round:** each round's own tick and idle wait keep their 600 s bound.

`max` still bounds the kernel lane, which includes part 2's seed. Every project-lane wait goes through `pump`: `authoringReady`, `phaseCompleted`, `nextPhasePublished`, `changeRequest` and `alphaDeployed`.

## For the driver

§357's estimate (about 5 s a launch or an execution) is superseded by the measurement here of about 9 to 10 s. At that rate:

- Part 1 is some 6 to 8 minutes.
- Part 2 is some 8 to 11 minutes.

Both are above the runner's default 600 s per file. Raising `SURETY_TEST_TIMEOUT_MS` for these two files, or splitting them further, is the driver's to choose (§357's rule). Not run here: the Builder uses the project-lane M401 files on this machine.
