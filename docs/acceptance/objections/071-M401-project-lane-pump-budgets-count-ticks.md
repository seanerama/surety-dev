# 071: the project-lane journey's waits count ticks, and a tick there is much shorter than one check execution

Row: M401 (a) to (g) (part 1) and (h) to (l) (part 2), on the project lane
Test: harness/journey/project.mjs `toPhaseTwoPublished` (`phaseCompleted(fx, ctx, 1, { max: 240 })`, `authoringReady(…, { max: 60 })`, `nextPhasePublished(…, { max: 60 })`); harness/journey/drive.mjs `changeRequest` (`pump(…, { max: 60 })`)
Filed by: Builder, slice 31b, 2026-10-12

## Claim

On the project lane, `pump` ticks, waits for the project's runs to end, and sleeps 250 ms. Check executions are not runs, so while only checks are executing, a pump round takes about 0.5 s. One check execution takes about 9 to 10 s on this workstation, measured in a part 1 run kept with `SURETY_KEEP_TMP=1`:

```
23:04:09.4 candidate.nominated, six check.registered
23:04:19.8 check.launched   23:04:20.2 check.result
23:04:28.4 check.launched   23:04:28.9 check.result
23:04:37.3 check.launched   …   (one every 8 to 9 s)
```

Before each check domain the engine writes a host `qualification_evidence` record, about 8.5 s, and the check itself takes about 0.4 s. On this host only one domain is admitted at a time. MemAvailable is 13.7 GB, and the envelope needs `host_reserve_memory` + 2 × `domain_memory_max` (8 GiB) for a second domain. So no role run is dispatched while a check executes. Both parts fail in their `before` hooks on this budget, not on an engine state that stops moving:

- **Part 1** reaches phase 1's phase checks: both stages `verified`, six `phase`-trigger executions registered, three recorded. Then `phaseCompleted(…, { max: 240 })` runs out after 277 engine ticks in about 2.5 minutes:

  ```
  phase 1 to complete: not reached within 240 ticks
  ```

  Phase 1 has 12 check executions on the project lane, six at stage 2's nomination and six at the phase (D6 §5.8 re-runs the regression set on the phase candidate, and SEAM §357 reads it so). That is about 110 s of checks alone.

- **Part 2**: the kernel-lane seed and the switch go through. The project-lane start carries on the kernel-lane home, phase 2's authoring is applied, and six `protected_application` executions are registered. `changeRequest` submits CR-1 (201), and `pump(…, { max: 60 })` runs out about 30 s later:

  ```
  spec version 2 to be approved: not reached within 60 ticks
  ```

  At that point the `spec_change` work is `eligible`, and the engine's own `dispatchBlocker` returns null for it. Two of the six checks have recorded, and the Spec Writer is waiting for the one domain slot.

Part 1's earlier failure, the Vision turn that never settled, was an engine fault and is fixed on this branch. A turn's result file on the real boundary was parsed as a run's result, so its run failed `invalid_result`. A later turn's launch was then refused, because `authorizeLaunch` admitted only a `claimed` run. With that fixed, what remains in both parts is time.

What I believe the harness needs: waits on the project lane bounded by time, not by a tick count (the per-file timeout is 600 s by default, which SEAM §356 says the driver may raise). Or tick maxima sized for about 10 s per check execution with one domain at a time (phase 1 alone has about 12 executions plus about 10 role runs). Nothing in the engine is stuck at the point each wait gives up.

## Sources

- SEAM.md §§356, 357 (the timing estimate: "about 5 s a role launch or a check execution in a real domain"; this host measures about 9 s a check execution, most of it the host qualification before the domain).
- D6 §5.8 (the phase's regression set run on the phase candidate); D6 §6.4 (the envelope: one domain at a time on this host).
- src/store/transitions/envelope.ts (admission); src/trust/checks.ts (the host qualification and its `qualification_evidence` record).
