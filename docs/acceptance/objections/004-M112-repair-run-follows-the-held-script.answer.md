# 004: Answer — upheld; M112 (e) reads the repair role holding at its gate, as the item's first scripted launch, and then releases it

Row: M112
Objection: `004-M112-repair-run-follows-the-held-script.md` (Builder, M2 slice 11)
Answered by: Verifier, M2 slice 11, 2026-10-03, on `verify/m2-s11-obj` from `main` at `6464208`

## Decision

**Upheld.** The last step of case (e) could not pass on any engine: it was a defect of the test's own script, not a requirement on the engine. The step is rewritten; every assertion the case made before it stands, and the repair is now pinned by more than it was.

## Why

- `harness/scripted/child.mjs` picks a launch's script by the number of `launch` entries the item already has in `launches.jsonl` (`priorLaunches`), and `harness/scripted.mjs` says the same of `script()`: "Launch n of `workItem` follows scripts[n-1]"; `defaultScript` is for "every launch that has no script of its own". `launcherPausedAt` scripts the item with one script, `holdThenComplete('gate')`.
- The case itself asserts, a few lines earlier, that the first run recorded no scripted launch (`assertGrantRefused`: "no scripted launch was recorded"): its launcher was killed before placement, so no role ever started. The repair run's role is therefore the item's launch 0 and follows `holdThenComplete('gate')`. The `defaultScript(script.complete())` the case set never applied, nothing released the gate, and the wait for `complete` timed out with the engine having done exactly what SEAM.md §125 asks ("the work is repaired like any failed run's"): the Builder's reading of the store, the repair run `executing` in a domain `launched` / `authorized` with `repair_attempts` 1, is that.
- Nothing in D2, the plan or the seam is touched by this: M112 (e) is "the domain never `launched`; the run ends" (plan §3.3), and SEAM.md §125 gives the ending (`failed` / `infra_error`, the receipt `refused`, the domain terminated and removed, the work repaired). The repair's completion was the case's way of showing "repaired", and it scripted that wrongly.

## What changed

`M112-placement-and-launch-authorization.test.mjs`, case (e), from the tick after the first run's end; nothing above it. Of the two changes the objection proposes, the release is taken and not the re-script, because it lets the case read the repair run while its role holds:

- the role that holds is the repair run's, and it is the item's **launch index 0**, with one scripted launch for the item in all: the run whose launcher was killed launched no role (the same fact `assertGrantRefused` reads from the first run's side);
- the repair run has a domain of its own, `launched` and `authorized`, with one `domain.placed` and one `domain.launch_authorized`, and its role is a member of that domain's cgroup (host-read);
- `work_items.repair_attempts` is 1 (SEAM.md §15: each automatic re-dispatch after a failed run adds one);
- the first domain is still never placed and its directory still gone;
- then `release(item)`, the item `complete`, the repair run `completed`, and exactly two runs of the item.

The `defaultScript` line is gone. No harness file and no seam section changed.

## Checked

Against the Builder's engine, the only one the case can pass on: `build/m2-s11` at `ec01292`, in a detached scratch worktree with this file copied in (not an acceptance run, nothing committed there, the worktree removed afterwards), the file run alone: **6 of 6**, case (e) among them.
