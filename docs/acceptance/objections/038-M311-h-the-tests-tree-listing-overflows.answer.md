# 038: answer

Row: M311
Answered by: Verifier, M4 slice 24, 2026-10-10, on `verify/m4-s24-obj2`

## Upheld; the harness's git output bound is 64 MiB

The objection is right. `listTree` runs `git ls-tree -r -z --full-tree` through `gitQuiet`, which called `execFileSync` with Node's default `maxBuffer` of 1 MiB. A revision of 20,000-odd entries lists to more than that, so the `before` hook ended in `spawnSync git ENOBUFS` before any deployment, and M311 (h) measured nothing. The engine had no part in it.

**The change** (`harness/repos.mjs`). `gitQuiet` passes `maxBuffer: opts.maxBuffer ?? 64 MiB`. That is roughly forty times the listing at `artifact_max_entries`, and the same bound serves every other test-side git call, none of which comes near it. The test file is unchanged: its revision, its two environments at exactly `artifact_max_entries` and `artifact_max_bytes`, its assertions and the half-deadline note for Sean all stand.

On `build/m4-s24` at `9b2a25d` with this change cherry-picked, after `npm run build`, `M311-the-identity-reads-duration.test.mjs` run alone with `node --test --test-timeout=600000`: the listing no longer fails, and the file goes past it to the deployment. **It did not pass.** The file was cancelled at its 600 s timeout, with 0 passed and 0 failed. Read from the test home's store afterwards: the `entries` artifact sealed at 20,000 entries (120,130 bytes) and its unit launched, with the application instance recorded. The deploy attempt then went `ambiguous`. Every one of its 54 reconciliation reads, from 07:54:32Z to 08:03:18Z, failed with `{"failure": "deadline"}`, each about 10 s apart. The round was never registered and no post-deploy check ran, so no duration was recorded at 20,000 entries, and the `bytes` environment was never reached.

**This is not the test's to fix.** At `artifact_max_entries` the engine's identity read does not complete within `adapter_read_deadline` (10,000 ms), let alone half of it. Row M311 (h) sends anything over half of the deadline to Sean (BS4 §11.3; E121 item 3). Whether the bound, the deadline or the read changes is his decision. Until then (h) is a failing acceptance test.

The cancelled run left the test home's engine and unit running. They are reported by exact name, not cleaned up: `surety-4d1fa72ab2328fb0-inc_01M4JCV5ZKJFNNR2K5K6QHB90F.scope` and `surety-4d1fa72ab232-env_01M4JCW8MQFRZD1FZJJ5NPBCX2-g1.service`, home `/tmp/surety-acc-s2-Ue0unu`. A run of this file needs a per-file timeout above its own 900 s bounds, so that its `after` hook (the guard and the cleanup) runs on a failure.

## Sources
- Node's `child_process.execFileSync`: `maxBuffer` defaults to 1024 * 1024 bytes; output beyond it ends the call with `ENOBUFS`.
- M4 plan §3.2, M311 (h): "the read's duration on the fixture artifact, at `artifact_max_entries` small files and at `artifact_max_bytes` bytes … recorded; either over half of `adapter_read_deadline` goes to Sean".
