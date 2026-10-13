# 074: the journey pump counts an answer the engine refused (409, a stale preview) as a human act

Row: M401 (m) (the T1 variant, case 3), and every journey file that reads `ctx.humanActs` (M401 (g), (h))
Test: packages/engine/test/acceptance/harness/journey/drive.mjs, `pump`: `ctx.humanActs.push({ kind: d.kind, id: d.id, option, status: res.status, … })` for every answer posted, whatever its status; M401-the-t1-variant-on-the-scripted-backend.test.mjs:104-109 compares the kinds
Filed by: Builder, slice 31b, 2026-10-13

## Claim

`pump` reads the open decisions and posts the owner's answer to each with the preview hash it read. A decision can be raised again in its next generation between that read and the post. D1 §4.6 and §8.1 step 6 do that when a bound dependency changes: for a `check_correction_*`, the integration revision, the effective protected version or the spec revision (SEAM.md §§77, 101; D3 §3.3). The post is then answered 409, and the pump answers the new generation on its next round.

The pump records both posts in `ctx.humanActs`, and the T1 variant compares the list of kinds. On the mini-hp01 probe the acts were:

```
check_correction_unclassifiable dec_…6SFJ approve 200   (the toolchain proposal)
spec_change_request             scr_…6AY  submit  201
spec_change                     dec_…R159 approve 200
check_correction_unclassifiable dec_…FE2  approve 409   (CR-1's correction, a generation that had just been superseded)
check_correction_unclassifiable dec_…C2Y  approve 200   (the same proposal's next generation, 0.5 s later)
```

Only one owner act took effect on CR-1's correction. The 409 left nothing in the store, no approval and no intent, as D1 requires of a refused answer. The engine raised no question D3 does not call for. The correction's decision was raised again because a bound input moved while phase 2's work went on. On the T1 lane that is most likely the integration revision, as phase 2's Builders integrate beside the correction.

On this workstation the T1 variant passed in eight runs at the fixed head (three of the file itself, four of a copy that prints the acts, one kept for the pace read). In the four that printed them, every act was answered 200. The race needs the re-raise to fall between the pump's read and its post, which the faster host hit once.

What I believe the harness should do: count as a human act only an answer the engine accepted (2xx), or count the decisions consumed by a human actor from the store (`decisions.status = 'consumed'` with `answer.actor = 'human'`). A refused 409 on a stale preview is not an act the owner made.

## Sources

- D1 §4.6 (a decision raised again in its next generation when a dependency changes; an answer on a stale preview refused), §8.1 step 6; D3 §3.3; SEAM.md §§77, 101.
- The mini-hp01 probe log `p31b-M401-the-t1-variant-on-the-scripted-backend.log` (the coordinator's).
