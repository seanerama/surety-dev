# 181: in M515 (f)/(g), the correction of the owner's R3 change is scripted as the design criteria's checks, for criteria the specification does not have; it cannot be approved, and the covering design's batch waits behind it

Row: M515 (f), (g) (slice 44)
Test: packages/engine/test/acceptance/M515-staleness-the-design-class.test.mjs, case "(f) the undispatched Android stage bound to a stale screen held design_stale, the web stage proceeding; (g) a covering revision approved: …"
Filed by: Builder, slice 44, 2026-10-17

## Claim

The case's fixture is `designedPantry(fx, {variant: late})`. It scripts the roles through `scriptVariant`, which calls `designScripts(fx)`. `designScripts` sets the `check_correction` kind's script to the reference design's criteria checks (reference.mjs: `accept-r2-tokens` covering R2.2, `parity-web`, `parity-android` covering R3.2). The case's design is `designModel`'s, with no criterion, so R2.2 and R3.2 never exist.

The owner's change rewording R3 (version 3) affects R3.1's check, so the engine registers its `check_correction` (D6 §4.5). That one-shot runs the script above. Its proposal covers criteria the approved specification lacks. The classifier records `discovery_error` on each `covers/criteria/0`, and `approve` carries the blocker `CHECK_DEFINITION_INVALID`. Observed (kept home, this branch at `da3b646`):

```
check_correction_unclassifiable open, options [["approve", ["CHECK_DEFINITION_INVALID"]], ["reject", []]]
protected_proposals: affected_checks accept-r2-tokens, parity-android, parity-web (added); elements discovery_error at …#/covers/criteria/0
spec_change work (the covering design's batch): awaiting_decision, blocker {reason: 'design_batch_deferred', pending_corrections: [that proposal]}
```

The harness answers `approve` on every tick and is refused 409 every time. The proposal stays pending. Under the driver's ruling on objection 166, a pending correction defers the design batch, so `untilBatch` times out at (g): "the batch to be raised: not reached within 40 ticks".

Everything the case asserts for (f) passes before that point on this branch: S2 is stale; the Android stage is held `design_stale` and not dispatched; the web stage is dispatched; `design_due` names the held stage and `S2/android`; and `assertNoSilentHold` holds. The failure is in (g)'s setup.

The same `designScripts` correction script was in the slice-43 base (`9d29f1e`), and the same 409 loop shows in that base's run of this case.

How far the case gets depends on timing. In a second run on this branch it failed earlier, at "phase 2 published: not reached within 60 ticks", with the same correction pending and refused 409 on every tick: phase 1's R3 obligation is unresolved while the correction cannot be approved.

## What the test can do

Script the R3 change's correction as a correction of R3.1's own check (`accept-r3`, covering R3.1), for example with `fx.scripted.kindScript('check_correction', …)` before the owner's change. Or answer that correction `reject`, so it leaves and the batch is raised.

## Sources

- D6 §4.5: an approved change registers the Verifier's `check_correction` for the affected criteria.
- The driver's ruling on objection 166 (and its extension, objection 169): a design batch is not raised while a correction is pending.
- harness/design/drive.mjs `designScripts`; harness/design/reference.mjs, the design checks' definitions (`covers: {criteria: ['R2.2']}`, `['R3.2']`).
