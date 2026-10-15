# 112: M407 alpha-under-policy (d)(f) under K2 (candidate 2 superseded before its Alpha completes), and M401's journey to Alpha (h) under ruling (A)

Rows: M407 (d), (f); M401 (h)
Tests:
- packages/engine/test/acceptance/M407-alpha-under-policy-enters-at-the-request.test.mjs, cases (d) and (f);
- packages/engine/test/acceptance/M401-the-journey-from-phase-two-to-alpha.test.mjs, case (h).
Filed by: Builder, slice 37, 2026-10-14 (the driver's rulings on both)

## M407 (d), and (f) after it

**Observed.** On the workstation, the file fails intermittently at 01470fb to 42c58ba: in 2 of 3, 2 of 4 and 1 of 3 runs. It passed 8/8 at 4144687. The difference is only timing: the per-tick integration lease row that M303 (a) removed. With that row, the race below falls the other way.

**Mechanism** (from a failing store):
1. Phase 1's Alpha deploy of candidate 2 registers round 1 under pv2 at 47.345. The round decides `verified` at 48.731.
2. At 48.988, phase 2's authoring applies a tightening, pv3, built beside it under D6 K2. Round 1's deciding result is invalidated (`protected_version_superseded`). The post-deploy check `operation` is re-instanced under pv3 with the same key.
3. At 49.258, `alpha_complete` for candidate 2 is first evaluated and refused, with these reasons:
   - CHECK_NOT_PASSED on `operation`@pv3;
   - DEPLOY_VERIFICATION_MISSING: the round is not on the effective version, and its deciding result is lost;
   - SIGNOFF_MISSING: the content changed.
   The round had already decided, so M315's rebinding of an open round does not apply. Slice 25's Q3 stands: refused, with no automatic round.
4. At seq 1116, phase 2's first nomination supersedes candidate 2 with candidate 3. D4 §5.5 refuses `alpha_complete` for a superseded candidate, so candidate 2's Alpha cannot complete whatever is verified again.

In the passing runs, the completion lands before both pv3 and candidate 3. The case assumes phase 2 does not apply a protected version, or nominate, while phase 1's Alpha completes. Under K2, phase 2's work runs beside it. (f) fails after (d), on the same project.

**Proposed.** (d) holds phase 2's work while phase 1's Alpha completes: for example, phase 2's plan approval is answered only after `alpha_deployed`. Otherwise (d) accepts candidate 2's completion refused for supersession, and asserts Alpha on the candidate the policy requests next.

## M401's journey to Alpha (h)

**Observed.** One batch run at 17195cf failed with "an obligation for the checks covering R4.1": only accept-r2's (R2.1) obligation was recorded for CR-1. It passed 5/5 on reruns, and no failing store was kept, so this is filed on the mechanism, at the driver's ruling.

**Mechanism.**
1. Phase 2's check authoring captures its proposal. It is classified unclassifiable and awaits the owner (`awaiting_human`, exempt from Q2's hold).
2. CR-1 is proposed while accept-r4 is not yet applied, so CR-1's impact does not list it.
3. If the pump answers the authoring proposal before CR-1's approval, the protected version moves. CR-1's decision re-raises with accept-r4 in the impact, and (h) finds the R4.1 obligation.
4. If the pump answers it after CR-1's approval, ruling (A) records no late obligation: the owner approved the earlier-authored proposal knowingly. Its decision names "authored against specification version N; the approved change since touched <criteria>".

**Proposed.** In ordering 4, (h) accepts no R4.1 obligation, provided the authoring decision's question names the touched criteria (R4.1) as above. In ordering 3, (h) expects the obligations as now.

## Sources

- D6 K2; D4 §5.3 item 7, §5.5; slice 25's Q3; M315; SEAM §267.
- The driver's ruling (A) on CR-1 (slice 37); objections 107 and 109.
