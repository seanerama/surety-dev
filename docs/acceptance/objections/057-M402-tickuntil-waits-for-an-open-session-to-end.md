# 057: tickUntil waits for every run to end, and an open session's run never does

Row: M402, M403, M404, M405 (every case that calls `say`, `sayAndSettle`, or `tickUntil` while a session is open)
Test: packages/engine/test/acceptance/harness/runs.mjs, `tickUntil` and `waitForIdle`; reached from harness/sessions.mjs `say`
Filed by: Builder, slice 31a, 2026-10-12

## Claim

`say` waits for a turn to settle with `tickUntil`. After every tick, `tickUntil` calls `waitForIdle(home, project)`, which waits until every run of the project has `state` `ended`, or is quarantined.

A session is one run of kind `session` that lives across its turns (D6 §2.1). That run does not end until the session closes: between turns it is `claimed` or `executing` with `session_state` `open_idle`. So `waitForIdle` times out after 30 s on the first tick of every turn. On this branch M402 (b), (c) and (f) fail this way after the turn has already settled:

```
error: 'timed out after 30000 ms waiting for every run of proj_… to end'
```

The same applies to every `tickUntil`, `tick` plus `waitForIdle`, and `waitPublished` in M403 to M405 that runs while a session is open.

What I believe the harness should require: a session run counts as idle when its turn is settled, meaning `kind` is `session` and `session_state` is `allocated` or `open_idle`. A `turn_running` session is still waited for, which is what a turn's settlement means. In `waitForIdle`, for example:

```js
runsOfProject(home, p).every((r) => r.state === 'ended' || r.quarantined === 1 || (r.kind === 'session' && ['allocated', 'open_idle'].includes(r.session_state)))
```

I ran M402 to M405 against a scratch copy of the acceptance directory with only that line changed. I never edited the tracked harness. The per-file results are in the slice-31a report.

## Sources

- D6 §2.1: "A session is a run of kind `session` … The session states and transitions are D1 A.5's, unchanged: `allocated → turn_running ⇄ open_idle → saving → open_idle`, `open_idle | saving → closing → finalizing → ended`."
- SEAM.md §344, store rows: "`runs` of kind `session` with `session_state` and `idle_generation`".
- harness/runs.mjs `waitForIdle`: `r.state === 'ended' || r.quarantined === 1`.
