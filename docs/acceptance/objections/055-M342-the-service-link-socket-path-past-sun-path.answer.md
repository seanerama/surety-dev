# Answer to 055: the service link's socket path past `sun_path`

Answered by: Verifier, M4 slice 30 (`verify/m4-055`, from `main` at `b9c835b`), 2026-10-11. **Upheld: an engine defect.** No acceptance test is objected to, and none changes; the defect gains its own cases.

## The defect, confirmed

`ServiceHost.startLink` (`packages/engine/src/deploy/service-host.ts`, the `name` at line 523) binds a post-deploy check's link at `$SURETY_HOME/run/<env>-g<n>-link-<10>.sock`, 59 bytes past the home for `g1`, with no check of its length. A pathname socket address holds 107 bytes (`man 7 unix`). Node's `listen(path)` binds a longer path cut to 107 bytes and still reports it listening. The check's mount plan then `lstat`s the recorded path (`invoke/sandbox/mounts.ts`, `bind`), which does not exist, and `checks/run.ts` line 214 records the execution `interrupted` with the reason "the engine restarted before the check's exit report was recorded", though no engine restarted. The round's verification is `unknown`, `alpha_complete` is not satisfied, and the candidate never reaches `alpha_deployed`. Reproduced under a 52-byte home in the sandbox lane (below): the same reason, the 111-byte path, three times (the execution and its two infrastructure retries), with one engine incarnation.

## The driver's ruling, which the Builder implements

- the link socket gets a short name;
- every socket path is length-checked before bind and connect, and refused loudly with a named code (such as `socket_path_too_long`), never truncated;
- the engine refuses to start, in the existing start-refusal form, when its home is too long for its socket paths.

## The cases (SEAM §340; COVERAGE "M4 slice 30: objection 055")

`packages/engine/test/acceptance/M314-the-service-link-under-a-long-home.test.mjs`, sandbox lane, manifest slice `30` and the `sandbox` list:

- **(a)** a home of exactly 52 bytes (the old link path would be 111 bytes; the README's real run is 43, the rehearsal that found this was 56): a deploy; the link check holds; the source its recorded `mount_plan` binds at `/.init/link.sock` lies under the home, is at most 107 bytes, and exists as a socket; released with one `GET /hello`: 200 through the link, an `accepted` entry in the link log, the round `verified`.
- **(b)** a home of 120 bytes, which no socket path can fit: refused at start in SEAM §1's form (exit status 6, one JSON refusal line with `code`, `reason`, `what_to_do` and `subject`, no stack trace), the refusal about a socket path (`/socket/i` in its code or reason) and naming a byte limit; no socket under the home; no unit of the home's prefix, neither a service unit nor the incarnation scope. The exact code is the Builder's to name; SEAM §340 will name it once the engine has it.
- **(c)** read after (a): the home has one incarnation, no `check.interrupted` event cites "the engine restarted", and no execution of the candidate is `interrupted`.

**On `main` at `b9c835b`** (the file alone with `node --test --test-concurrency=1`, twice, with the busy check and the unit, `/tmp` and `/dev/shm` reads before and after; nothing left): **0 of 3**. (a) stops at the first post-deploy execution, `interrupted` from `materializing` with the restart reason naming the 111-byte path; (c) finds three such events under one incarnation; (b)'s engine starts on the 120-byte home and runs until the test's TERM 30 s later, nothing refused.

## For Sean

The rehearsal directory `docs/acceptance/reports/M4-real-lane/README.md` names (`$HOME/surety-m4-rehearsal-<stamp>/home`, 56 bytes) must start once the fix is in: the limit the engine computes has to admit it, or the README's name is Sean's to shorten. The case holds the engine to 52 bytes, not 56, so that the Builder's limit has room for the service's `run/<env>-g<n>/in.sock` (50 bytes past the home for `g1` to `g9`); whether 56 fits after the fix is for the rehearsal to show, not this file.
