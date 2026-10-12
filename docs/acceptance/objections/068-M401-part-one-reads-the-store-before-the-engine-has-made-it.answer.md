# Answer to 068: M401 part 1 reads the store before the engine has made it

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`, from `main` at `a6947c7`), 2026-10-12. **Upheld: a harness defect** in `harness/journey/project.mjs` (SEAM §357).

`journeyEngine`'s project-lane start read the active host qualification, to know which row this start's self-test is not, before any engine had created the home's store. That read is now `previousQualification(fx)`, which answers `null` while the store file does not exist and reads the row once it does. `toProjectLane` uses the same function, though part 2's store always exists by then.

The other files were checked:
- **M401 part 2** reads the qualification only in `toProjectLane`, after its kernel-lane seed has made the store, so it did not hit this.
- **The T1 variant** starts a kernel-lane `scriptedEngine` and never reads a qualification, which is why it passes 3/3.

No assertion changed. Not run, as the driver asked: the slice's first project-lane runs are the driver's (§356).
