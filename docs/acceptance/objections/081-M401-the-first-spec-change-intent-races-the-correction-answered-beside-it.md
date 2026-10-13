# 081: M401 (h) S8 needs CR-1's first application intent to win a race against a protected application answered in the same pump round

Row: M401 (h) (the 31b review's S8)
Test: packages/engine/test/acceptance/M401-a-spec-change-application-is-done-once.test.mjs, case "after the applied change: intent done, intent.done once, not begun again by later ticks", line 24, `assert.equal(now.status, 'done', …)` on the **first** `spec_change_application` intent (`const [intent] = intentRows(…)`).

Filed by: Builder, slice 34, 2026-10-13

## What happens

The seed's `changeRequest` pump answers every routed decision open in a round, one after the other. In this case, two are open in the same round:

- `check_correction_unclassifiable`, phase 1's authoring proposal (seq 409 in the run below);
- `spec_change`, CR-1 (seq 414).

Each answer records an effect intent, and both effects start at once. CR-1's `spec_change` manifest binds the effective `protected_version` (D6 §4.5; contract/decisions.json). The protected application finishes first and changes that version. CR-1's intent then begins and revalidates, as D1 §10.5 requires. It is invalidated `EFFECT_PRECONDITION_CHANGED`, and the question is raised again. The pump approves the new generation, and that intent is applied and `done`:

```
eff_…5NYJ…  spec_change_application  invalidated  EFFECT_PRECONDITION_CHANGED
eff_…JFB7…  spec_change_application  done
437 intent.done         (the protected application)
452 intent.invalidated  (CR-1's first intent)
453 decision.raised     spec_change, semantic_generation 2
548 intent.done         (CR-1's second intent)
```

Before slice 34, CR-1's application began without any git work when the head was an ancestor of the proposal. It made its `ref_update` before the protected application finished, so the first intent won. Under the coordinator's ruling 2, the application now writes TPL §11's row for version n+1 in an engine commit. It reads the proposal's spec, writes the blob and the tree, and computes the commit before its journal intent. That is enough for the protected application to finish first, every time on this host (two of two runs).

## Claim

The engine does what D1 §10.5 says. An intent whose precondition changed between the consumption and the effect is invalidated and asked again, never executed. Making the first intent win would mean revalidating before the change log row's commit is prepared, and not again after it. That would let a protected version that changed in between pass unseen.

The case asserts "done once, not begun again" for whichever intent happens to be first. I believe it should:

- take the intent that was applied (the one whose operation finalized, or the newest `spec_change_application` of the request); or
- answer the authoring proposal and let its application finish before CR-1 is answered (for example, pump the correction alone first).

Either way it still pins S8: that intent is `done`, `intent.done` once, `intent.executing` once, and nothing is begun again by later ticks.

## Sources

- D1 §10.5, as M2 to M4 built it (queue.ts `revalidateIntent`): the preconditions are read again immediately before the effect, and an intent whose preconditions changed is invalidated with EFFECT_PRECONDITION_CHANGED.
- D6 §4.5: "its manifest binds the current spec version, the side ref's revision, the effective protected version and the impact's hash, so any change stales it".
- The coordinator's ruling 2 (slice 34): the change log row in one journaled engine commit at a spec change's approval too.
