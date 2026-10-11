# Answer to 051: M334 (d)'s re-verification registers no check, and (e)'s redeploy meets the case's own finding

Answered by: Verifier, slice 28, 2026-10-11. **Upheld, both parts. Each is the design working, and the case was wrong to expect otherwise.**

**1. No check is registered.** The case itself rewrites the survivor's title, so its command line carries S0. D4 §3.4 step 4 makes arguments that differ from the start command read `differs`. D4 §5.3 registers a round's checks only after its first identity read, and the slice-25 build registers none after one that differs. The case's purpose is kept by what that read records: `differs` on `argv`, with nothing of the arguments recorded, while the engine no longer holds S0. That is D4-S05's "mutable process metadata … read records hold no free-form field", and the case's search of the home, responses, unit and journal pins it. The register-then-refuse form (a check against a survivor is not run, `redaction_unavailable`, nothing through the link) is M324 (a)'s and stays pinned there.

**Changed:** the step accepts one of two outcomes. Either the round registers no check, and then its first read must be `differs` with `detail.field` `argv`. Or every check it registers is not run, `redaction_unavailable`, and reaches nothing through the link. Releasing `title-secret` after the round was not possible: after the restart the link and relay are refused, so nothing can reach the survivor to ask for an act.

**2. The redeploy is refused by the case's own finding.** Before the kill, the case's check GET `/secret` and printed the value into its output. The secret screen refuses that publication and raises the critical finding, as D4 §7.3 requires for check output and as M218 pins. That finding then blocks `alpha_authorize`, as it should. D4-S05's "a response to a check" concerns the survivor after the restart. That response is never made, because the check is not run and the link is refused, and (d) pins exactly that.

**Changed:** the pre-kill plan no longer GETs `/secret`; it releases only `title-secret`. The header states that a check printing S0 is screened and raises the critical finding (M218's, not this case's). Nothing is dispositioned by the test.

SEAM §§314 and 319 and COVERAGE "M4 slice 28" record both changes.
