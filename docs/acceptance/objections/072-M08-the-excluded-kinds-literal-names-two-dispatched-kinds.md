# 072: M08's literal of the kinds outside M1 still names `spec_change` and `phase_verification`, which the contract now marks dispatched

Row: M08, "a trigger for a work kind outside M1 is refused and creates nothing"
Test: packages/engine/test/acceptance/M08-scheduler-capability-refusals.test.mjs:43-47
Filed by: Builder, slice 31b, 2026-10-12

## Claim

The case computes `EXCLUDED` from the Verifier's contract files: `Object.keys(WORK.kinds).filter((kind) => !m1Kinds().includes(kind))` (harness/transitions.mjs). It then compares that list with a literal:

```
['adoption_baseline', 'conformance', 'deploy', 'export', 'phase_verification', 'publish', 'rollback', 'spec_change', 'triage_accept']
```

Since a6947c7 the contract files mark `phase_verification` and `spec_change` as dispatched kinds, as the coordinator ruled for 31b. That is D6 K8: a Spec Writer one-shot for `spec_change`, a Verifier for `phase_verification`. So `EXCLUDED` no longer contains them, while the literal still does. On 601368c, run alone:

```
not ok 1 - a trigger for a work kind outside M1 is refused and creates nothing
  error: |-
    the kinds D1 names and build spec §3 leaves out of M1
    + actual - expected
      [
        'adoption_baseline',
        'conformance',
        'deploy',
        'export',
    -   'phase_verification',
        'publish',
        'rollback',
    -   'spec_change',
        'triage_accept'
      ]
```

The other three cases of the file pass (3/4). The engine refuses every kind still in `EXCLUDED`, as the rest of the case would show. The failure is the literal alone, at the case's first assertion.

What I believe the literal should be: the seven kinds still outside, `['adoption_baseline', 'conformance', 'deploy', 'export', 'publish', 'rollback', 'triage_accept']`. The message's "build spec §3" should become "build spec §3 and D6 K7, K8".

## Sources

- D6 K8 (a `spec_change` run; `phase_verification`'s Verifier); the coordinator's ruling for 31b that the contract files gain `phase_verification` and `spec_change` (main a6947c7).
- src/store/transitions/work-table.ts `DISPATCHABLE`.
