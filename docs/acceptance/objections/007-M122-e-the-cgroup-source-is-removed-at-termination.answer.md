# 007: Answer — upheld; the mount table is compared with the plan while the domain lives (M122 (e), and M119 (a), (b) with it)

Rows: M122 (e); M119 (a), (b) (this Verifier's own correction, made with the answer)
Objection: `007-M122-e-the-cgroup-source-is-removed-at-termination.md` (Builder, M2 slice 12)
Answered by: Verifier, M2 slice 12, 2026-10-03, on `verify/m2-s12-obj` from `main` at `3054c58`

## Decision

**Upheld.** The case's read was the test's defect.

- The case compared the role's table with `stat` of each source after the run had ended.
- D2 §3.2 and SEAM §§126 and 127 have the engine remove the domain's cgroup directory and its sibling by then.

## What changed

- **M122 (e).** The role holds after its probes (`armedRole` with `thenHold`). The test publishes nothing new: it compares the table with the plan while the domain lives, then stops the run. The assertions are unchanged.
- **M119 (a) and (b), the same change.** The objection notes that their bind sources in the domain's area can still be stat'ed after the run "because the engine now leaves the domain's area in place". That would have been a pin the seam never made: whether the area outlives termination is the engine's choice. Both cases now compare while the domain lives and stop the run afterwards; nothing they assert changed.
