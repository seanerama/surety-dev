# Answer to 074: the pump counts a refused answer as a human act

Answered by: Verifier, M5 slice 31b (`verify/m5-s31`), 2026-10-13. **Upheld**, as the driver ruled: count the human acts from the store, not from the pump's posts.

## The change (SEAM §375)

`humanActsOf(home, project, {sinceSeq})` in `harness/journey/drive.mjs` reads two kinds of act, after event `sinceSeq` and in event order:
- each decision consumed by a human answer: its `decision.consumed` event, with the decision's `answer.actor` `human`;
- each change request the owner submitted: `spec.change_requested`, with `source` `owner`.

`buildActs(ctx)` reads them from the event at which the pump first ran. An answer the engine refused on a superseded generation (409) consumed nothing, so it is no act. The pump still records every post, with its status, in `ctx.humanActs`, and the failure messages print those posts for diagnostics.

The same counting is applied in:
- M401 part 1 (e) and (g);
- M401 part 2 (h), from the switch to the project lane (`toProjectLane` now returns the switch's event `seq`);
- the T1 variant case 3;
- M406's two counts.

M407 counts no human act.

## Run

Each file was run alone on `build/m5-s31` at `5670781`: the T1 variant 3/3, `M406-phase-completions-effects-once-per-binding` 6/6, `M406-a-phase-sign-off-before-a-new-protected-version` 1/1, `M407-alpha-under-policy-enters-at-the-request` 7/7, `M407-a-policy-request-refused-in-preparation` 1/1 and `M407-the-spec-read-after-a-criterion-changes` 1/1. Nothing was left behind. M401 parts 1 and 2 were not run here; the driver runs them on mini-hp01.
