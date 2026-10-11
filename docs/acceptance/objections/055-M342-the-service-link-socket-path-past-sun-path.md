# 055: the engine binds a post-deploy check's service link at a path longer than a unix socket address can hold, so under a long SURETY_HOME every post_deploy check is interrupted and the deployment is never verified

Row: M342 (an engine defect found by the dress rehearsal; no acceptance test is objected to)
Test: packages/engine/test/acceptance/M342-the-real-deployment-journey.test.mjs, cases "(b)" and "(c)", run as the rehearsal (SURETY_REAL_REHEARSAL=1) on main ae302a8 with the harness fix debd1c3
Filed by: Verifier, M4 slice 30, 2026-10-11

## Claim

`ServiceHost.startLink` (`packages/engine/src/deploy/service-host.ts:522`) binds the link of a post-deploy check at

```
$SURETY_HOME/run/<environment>-g<generation>-link-<last 10 of the check domain>.sock
```

with no check of its length. A pathname socket's address holds at most 107 bytes (`sun_path`). Node's `net.Server.listen(path)` does not refuse a longer path. It binds the socket at the path cut to 107 bytes and still calls the listening callback. The engine then hands the full path to the check's mount plan (`checks/run.ts`, `buildCheckPlan({ linkSocket: this.link.path })`). Its `lstat` fails with ENOENT, and the check execution ends `interrupted` while `materializing`. The reason recorded is wrong: "the engine restarted before the check's exit report was recorded", although no engine restarted. The two infra retries fail the same way. The round's verification is recorded `unknown` (`missing: check_result`). `alpha_complete` is `not_satisfied` (CHECK_NOT_PASSED, DEPLOY_VERIFICATION_UNKNOWN), and the candidate never reaches `alpha_deployed`.

Nothing is turned into a pass: the engine keeps the unknown as unknown, as it should. The defect is that a home whose link path does not fit is accepted, and the qualification, the deployment, both identity reads and the teardown all succeed in it. The post-deploy check alone can never run there, and the record blames an engine restart.

The fixed part of the name is 54 bytes: `env_` + 26 + `-g1-link-` + 10 + `.sock`. `/run/` is 5 more. So the link fits only while `$SURETY_HOME` is at most 48 bytes, and one byte less for each further digit of the generation (g10 onwards).

## Evidence

Rehearsal run directory `/home/smahoney/surety-m4-rehearsal-20261011T180141Z` (named exactly as `docs/acceptance/reports/M4-real-lane/README.md` §1 step 4 makes it; never evidence for M4). Its home is `…/home`, 56 bytes. The link path was 115 bytes:

```
/home/smahoney/surety-m4-rehearsal-20261011T180141Z/home/run/env_01M4P237NMF945C8BDB99JP4FD-g1-link-asc1asnq44.sock
```

From its `store.db` (read only):

- deploy `op_01M4P26AXE7A8YZYG086ASSZPX` succeeded. The unit `surety-58951b5c3cc6-env_01M4P237NMF945C8BDB99JP4FD-g1.service` was active, the reconcile read was `applied`, and both identity reads of round `vr_01M4P26BK5YA83KTB0JX32N5NW` were `match`.
- events 647, 653, 659, `check.interrupted` for `cx_01M4P26BPXZAW525KFRQM2Y6TF`, `cx_01M4P26C3ANKE21BCJGGT0FZTR` and `cx_01M4P26CCCV0YC8SNDH2SYAG6W`, each `from: materializing`, `why: "ENOENT: no such file or directory, lstat '/home/smahoney/surety-m4-rehearsal-20261011T180141Z/home/run/env_01M4P237NMF945C8BDB99JP4FD-g1-link-<10>.sock': the engine restarted before the check's exit report was recorded"`. Each execution has `started_at` null and an empty `service_link_log`.
- `dv_01M4P26CZV9TK3EQ3AQT16HWHT`: `outcome: unknown`, `missing: [{kind: check_result, id: cx_01M4P26CCCV0YC8SNDH2SYAG6W}]`. Event 665 is `gate.evaluated alpha_complete not_satisfied [CHECK_NOT_PASSED, DEPLOY_VERIFICATION_UNKNOWN]`.

Node's behaviour, reproduced alone on this host (node v22.22.0): a server listening at a 115-byte path fires its listening callback with no error. `lstat` of that path is ENOENT, and the directory holds a socket under the name cut to 107 bytes.

The workspace checks of the same journey (direct runner, no link) passed, and the adapter's qualification (`aq_01M4P25MBC58NB9REFHGWEP4Q1`, current) has no case that opens a service link, so neither met the limit.

## What it changes now

- **The rehearsal as the README names it cannot pass on this host**: `$HOME/surety-m4-rehearsal-<YYYYMMDDTHHMMSSZ>/home` is 56 bytes.
- **Sean's real run as the README names it fits, narrowly**: `$HOME/surety-m4-real-<YYYYMMDD>/home` is 43 bytes, giving a 102-byte link path for g1 (5 bytes to spare). A longer `SURETY_REAL_RUN_DIR`, a longer `$HOME`, or a generation past g99 would meet the same failure.

## For the Builder and Sean

How the engine should behave is a design decision for Sean, not a test change:

- refuse at engine start a home whose longest socket path cannot fit; or
- bind the link at a shorter path (for example a short name under the run directory, or a short per-home directory); or
- refuse the check with a reason that names the cause instead of an engine restart.

Any of these can then be pinned by an acceptance test: a post-deploy check under a `SURETY_HOME` long enough to put the link past 107 bytes either runs or is refused with a truthful reason, never `interrupted` as a restart. The harness does not work around the defect. The README's rehearsal directory is left as it is.

## Confirmation

A diagnostic rehearsal, identical except that its run directory is shorter (`/home/smahoney/surety-m4-rh-202610111814`; home 45 bytes, link 104 bytes; the same scratch checkout of main ae302a8 with debd1c3), passed 4 of 4. The post-deploy check `operation` was recorded through the link with exit 0 and one accepted link entry, verification `verified`, `alpha_deployed`, the teardown applied, and nothing of the prefix left. It is not the README's command and not evidence for M4. It shows that the run directory's length is the only difference.
