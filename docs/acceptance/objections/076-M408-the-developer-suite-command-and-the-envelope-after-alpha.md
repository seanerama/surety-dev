# 076: M408's journey stalls twice on the project lane. The fixture's developer suite `node --test test/` fails under Node 22, and after Alpha no role domain fits the as-built envelope on a 15 GiB host

Row: M408 (a) to (h), the project-lane journey
Test: packages/engine/test/acceptance/M408-the-retrofit-journey.test.mjs (the `before` hook); fixture packages/engine/test/acceptance/harness/retrofit/products.mjs (`authoringFiles`, the `suite` definition)
Filed by: Builder, slice 32, 2026-10-13, at the driver's request (mini-hp01 cancelled the journey after 1,246 s in its `before` hook)

## What was run

On this workstation, at build/m5-s32 3fe5ba7, I ran `M408-the-retrofit-journey` alone with `SURETY_KEEP_TMP=1` and `--test-timeout=3600000`. No other test file was running; `systemctl --user is-system-running` read `running`; there were 0 units before and after. I read the kept home's store, then removed the home.

## 1. The developer suite fails under Node 22, so conformance is blocked

The journey's `before` hook failed with:

```
phase 1 to complete: not reached within 1200 s on the project lane (2886 ticks; human acts so far: [{"kind":"check_correction_unclassifiable",…,"status":200,…}])
```

Every step up to phase 1 took about 4 s: adoption, the mode, both sessions, the confirmations, the conformance plan's publication, authoring readiness, and the nomination of c-1 (11:58:42Z). c-1's checks ran once:

- `accept-r1`, `accept-r2`, `accept-r3` and `smoke` passed.
- `suite` exited 1.

The only stage gate (11:59:20Z) was not satisfied. Its reason was `CHECK_NOT_PASSED`, naming `suite` with state `failed`. The stage became `conformance_state` `blocked`, as D6 §8.1 step 5 requires for a failing required check. From then until the 1,200 s bound, the store recorded nothing but ticks, API acts and environment observations. There were no open decisions and no held work. Conformance stayed visibly blocked.

`suite`'s output record:

```
# Error: Cannot find module '/surety/workspace/test'
…
not ok 1 - test
  location: '/surety/workspace/test:1:1'
```

The definition's command is `["node", "--test", "test/"]` (products.mjs `authoringFiles`, `defs('suite')`). Since Node 21, `--test`'s arguments are file patterns. A bare directory is loaded as a module and fails; it is not searched. Reproduced outside the engine with Node v22.22.0, the pinned version:

| Command, in a directory with `test/a.test.mjs` | Result |
|---|---|
| `node --test test/` | fail 1 ("Cannot find module …/test") |
| `node --test` | pass 1 |
| `node --test 'test/**/*.test.mjs'` | pass 1 |

The kernel lane never shows this, because its verdicts are scripted (SEAM §382's limit). M408 (i) passed on mini-hp01, but only because it expects conformance blocked anyway: `suite` fails there too.

What I believe the fixture should have: the `suite` command `["node", "--test", "test/*.test.mjs"]`, or another pattern that names files. If the README's "run the tests with `node --test test/`" is meant as one of its true claims, it needs the same change, since under Node 22 it is also false.

## 2. After Alpha, no role domain fits the envelope as built on this host

I ran the journey again with only the `suite` command changed, as a scratch probe outside the acceptance tree, timing each step of the `before` hook:

| Step | Took |
|---|---|
| adopt, mode, Spec Writer session, confirmations, Architect session | 2 s |
| check authoring (the toolchain approved by the owner) | 2 s |
| phase 1: conformance on c-1, the phase gate, `completed_at` | 81 s |
| `alpha` configured and the adapter qualified | 10 s |
| `surety deploy c-1` | 1 s |
| c-1 `alpha_deployed` | 9 s |
| phase 2 published by the replan | not reached in 1,200 s |

The Alpha barrier opened correctly: `conformance.alpha_barrier_opened`, and one `replan` was created at 12:21:28Z. That replan was never dispatched. The project's work read gives its dispatch hold as:

```
"dispatch_hold": {"code": "resource_envelope", "reason": "admitting a domain needs host_reserve_memory (2147483648) beyond domain_memory_max (8589934592) for each of the 2 admitted domains and 536870912 for the services, 19864223744 bytes; the host has 13839470592 (13816471552 available and 22999040 held by the running domains).", …}
```

This is the envelope as built. Each domain is counted at `domain_memory_max`, 8 GiB, so the running Alpha service plus the replan's role domain need about 19.9 GB, and this 15 GiB host has 13.8 GB. The per-profile maxima of K2 and B09 (`role_memory_max` at 4 GiB) are slice 37's (M438, M451). M401's journey never meets this, because it deploys Alpha last. M408 must run a role domain after Alpha: the change-phase replan and phase 2's Builder.

The engine is right to hold the replan. Admitting it would break the envelope. On this workstation the journey can only finish if:
- the host has about 20 GB available; or
- the project lane lowers `domain_memory_max` for this file through the harness's own configuration; or
- slice 37's per-profile maxima land.

I don't know mini-hp01's memory, so I can't say whether it meets this second stall after the first is fixed.

With both changed, the journey passes. In a third probe I changed the `suite` command and set the engine's `domain_memory_max` to 4 GiB after `journeyEngine` started it, then restarted the engine with its self-test. The probe passed **8 of 8, (a) to (h)**, with the teardown applied and 0 units left. The journey took 4 min 14 s (12:43:03Z to 12:47:17Z):

| Step | Took |
|---|---|
| adopt to the check authoring approved | 4 s |
| phase 1 complete | 77 s |
| `alpha` and the qualification | 9 s |
| deploy and `alpha_deployed` | 10 s |
| phase 2 published by the replan | 1 s |
| phase 2 complete | 152 s |
| teardown | under 1 s |

The whole file, engine starts included, took 5 min 27 s. So on this host the journey fits its 1,200 s bounds easily once neither stall is in the way.

## 3. The stall bound does not catch a held journey

The pump's `PROJECT_STALL_MS` (180 s) resets on any new event. A blocked or held journey still records `engine.tick`, `api.act` and `environment.observed` events, so each wait above ran to its full 1,200 s instead of failing in 3 minutes with the reason. This is a harness choice, not a fault, and I note it for the driver. A stall read over events other than those three would fail fast here.

## Sources

- D6 §8.1 steps 5 and 6 (a failing required check blocks conformance; the Alpha barrier, then the replan).
- K2, B09 (the envelope as built; per-profile maxima are slice 37's); BS5 §4.1 rule 12.
- SEAM §§356, 375, 382, 386 (the project lane's bounds and limits).
- Node.js 22 `--test` argument semantics, reproduced as above.
