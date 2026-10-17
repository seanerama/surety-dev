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

A scratch copy of the case outside the repository passes every assertion of (f) and (g) on this branch at `efe0a42`. Its one change is that, before the owner's R3 change, it scripts the `check_correction` kind as a role adding one smoke check (`smoke-r3`, `node --check server.mjs`, requested `tightening`):

```
# pass 1
# fail 0
```

(Phase 2's `LATER_AUTHORING` script does not work as the correction. Its `smoke-later` file then exists before phase 2's authoring, and that authoring's proposal is left empty.)

## What the test can do

Script the R3 change's correction as a correction of R3.1's own check (`accept-r3`, covering R3.1), for example with `fx.scripted.kindScript('check_correction', …)` before the owner's change. Or answer that correction `reject`, so it leaves and the batch is raised.

## Sources

- D6 §4.5: an approved change registers the Verifier's `check_correction` for the affected criteria.
- The driver's ruling on objection 166 (and its extension, objection 169): a design batch is not raised while a correction is pending.
- harness/design/drive.mjs `designScripts`; harness/design/reference.mjs, the design checks' definitions (`covers: {criteria: ['R2.2']}`, `['R3.2']`).

## Decision

Upheld by the driver under the owner's delegation, 2026-10-17. **The case scripts a valid correction for the spec in force** (Verifier, `verify/m6-s44b` from `9d29f1e`).

The engine is right. A correction that covers criteria the approved specification lacks is `CHECK_DEFINITION_INVALID`, and under the rulings on objections 166 and 169 a pending correction defers the design batch. The fault is in the fixture: `designScripts` scripts every `check_correction` as the reference design's criteria checks (R2.2, R2.3, R3.2), and `designModel`'s design has no criterion.

M515 (f), before the owner's R3 change, now runs `fx.scripted.kindScript('check_correction', R3_CORRECTION)`. `R3_CORRECTION` is the Verifier's correction for the criterion that change affects, and it does two things:

- it adds one acceptance check, `accept-r3-list`, which covers R3.1, with gates `stage` and `alpha_authorize`;
- it adds its program, `.surety/checks/tests/mobile-list.test.mjs`, which asserts that `mobile/App.js` imports `FlatList` from `react-native`. The scripted Android Builder's `APP_JS` satisfies that.

It is requested as `tightening`. It adds files and rewrites none of `authoringFiles()`, so phase 2's `LATER_AUTHORING` neither reverts it nor collides with it (the objection's note on `smoke-later`). Nothing else in (f) or (g) changed: the covering revision's batch carries human tests only and needs no further correction.

`designScripts` itself is left as it is. Its correction script is right for the cases whose design carries those criteria (slices 40 to 42).

**Run:** as objection 180's decision records, three runs of M515 alone against `build/m6-s44` at `5844799`. M515 (f)/(g) passed in all three runs. The only failure, also in all three, was M515 (e)/(b), at the missing `surety design asset add`, which this engine lacks.
