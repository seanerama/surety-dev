# 105: after the slice-37 review's fixes, cases that assume a script is set before the item's requested tick, that a tightening's question waits for its Reviewer, or that every hold reason has a measured idle time

Rows: M15, M401, M436, M441
Filed by: Builder, slice 37, 2026-10-14

## How these were found

Run on `build/m5-s37` at 04ee954 (verify/m5-s37 at 4913434 merged), each file alone. The case-by-case cause is read from kept stores (`SURETY_KEEP_TMP=1`).

## The cases

**M15-lease-supervision, "a lease nobody renews expires…" (K1, K2).**
- What fails: the case adds `item`, then `next`, and only then `fx.scripted.defaultScript(script.complete())`. `next`'s `work_eligible` requests a tick, and K2 dispatches it beside `item` before its script exists. Its role runs with no script (`HOLD_FOREVER`), so it never completes, and the clock advance past `lease_ttl` then recovers both runs. In the kept store both items end `held`, both runs `recovered`, and `run.started` of `next`'s run is at seq 41.
- Error: "the next item of the project to be dispatched and to complete was not reached after 6 ticks".
- Status: it passed earlier today, because the script came in first by timing.
- Proposal: set the default script before the items are added.

**M401-the-t1-variant (m) and M436-the-phase-profile-on-the-project-lane (e): phase 2's authoring is a tightening.**
- What fails: under `classifier_authority: authoritative`, its proposal raises the owner's `check_correction_tightening` question and the Reviewer's review work.
  - Under K2 the Reviewer's run is no longer the next thing to run. In M401 the pump answers the question first (it is in `ROUTED_KINDS`), so the act counts as a human one.
  - In M436 (e), "only the toolchain's correction raised" sees the question raised at all.
- Proposals: M401's pump leaves `check_correction_tightening` to the Reviewer under `authoritative`. M436 (e) counts the owner's acts, not the questions raised.
- M401's T1 run also counts a third `check_correction_unclassifiable`, the correction's second proposal. A proposal approved and then found to conflict with the moved head is now rejected naming the conflict, and its item repairs (the driver's ruling: never awaiting nothing). The repair's proposal is a new question. I propose the journey count CR-1's correction acts by request rather than as exactly one.

**M441-the-pace-read-after-the-journey (a): N6.**
- What fails: "idle.resource_envelope a number ({"unknown":"no closed resource_envelope hold interval was recorded"})".
- Cause: the review's N6 (mandatory: unknown-as-zero) makes a hold reason with no closed interval `unknown`, never 0.
- Proposal: the case accepts `unknown` for a reason no item was held for, and asserts a number only where an interval was recorded.

## Not in this objection

- M441-the-pace-read-after-the-journey's `alpha_deployed` stall and its two consumed `spec_change` decisions. Phase 2's check authoring applied a new protected version after the owner approved the change, so the approved application's impact changed and the owner was asked again (manifests of decisions 8 to 10 in the kept store). This is put to the driver as a design question.
- M433-old-generation's third case (`409` on the owner's approval). It follows from counting `awaiting_decision` as owner-held in the class rule, and is put to the driver.

## Sources

- D6 K1, K2; D3 §3.3 (authoritative tightening); D6 §7.6 and the slice-37 review's N6; SEAM §441.
