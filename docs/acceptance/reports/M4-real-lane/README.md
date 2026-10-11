# M4's real run (row M342): the command for Sean

**Draft by the Verifier of M4 slice 30, 2026-10-11.** Run only by Sean's command (E95 Q10; BS4 §12). Nothing here has been run with a real `claude`, and the dress rehearsal with the fake has not been run yet either: it must pass on the revision you run, before you run this (section 1, step 4). The file is `packages/engine/test/acceptance/M342-the-real-deployment-journey.test.mjs` (manifest `real`); what it does is its header and `harness/real/deploy-journey.mjs`; the seam is SEAM §335.

**What it costs.** One real Verifier run writing the checks, one to three Builder runs (the first build and up to two repairs, if a check fails): two to four runs of Claude Code (`claude-sonnet-5-5`), expected **under 1 USD** in Claude Code's own estimates (M3's runs cost 0.04 to 0.07 USD each), drawn from your subscription's usage allowance, which your own Claude use shares. The run directory is new, so one new qualification attempt runs first (three canaries, about 0.06 USD in M3's run). **At most**, in billable tokens alone: each run is bounded by 300 000 billable tokens, 3.00 USD at the dearest rate; the journey's four role runs 12.00 USD, stopped earlier by the project's day limit of 6 USD in estimates; the attempt's three canaries 9.00 USD, within the fixture project's day limit of 10 USD; plus cache reads and any overshoot until a run's deadline. The only hard maximum is your subscription's own limits. An estimate, not a cap or an authorization (D4 §9.4). **Your two commands cost nothing:** the qualification, the deployment, the identity reads, the checks and the teardown call no model. The test prints this statement before it starts anything.

## 1. Before you run it

1. **A new subscription token** (M3's was revoked, E109 item 3). Make it yourself, keep it in a file of its own readable by you only, and never paste it into a command line or a chat:

   ```
   claude setup-token          # sign in in the browser it opens; it prints a long-lived token
   install -m 600 /dev/null ~/.config/surety/claude-subscription.token
   $EDITOR ~/.config/surety/claude-subscription.token   # paste the token, one line, save
   ```

   The file must be outside the repository, outside `~/.claude` and outside the run directory, mode 600, one line. The engine is given its path (`--secret-file`), never its value.

2. **The pinned binary**: Claude Code's own file, not the `~/.local/bin/claude` link, which moves when it updates itself, for example `~/.local/share/claude/versions/<version>`.

3. **A built checkout on `main`** with slices 29 and 30 merged, the Builder's half of slice 30 included: `M342-the-deploy-command.test.mjs` (the `surety deploy` command you will type) and `M342-the-verifiers-deployment-check-package.test.mjs` (the real Verifier writes the deployment's check from its package alone; today the package does not say how) must pass first.

4. **The dress rehearsal** with the fake backend (SEAM §171), passed on that same revision, by the driver or by you, never evidence:

   ```
   npm run build
   bash packages/engine/test/acceptance/harness/standin/build-rehearsal-claude.sh "$HOME/surety-m4-rehearsal-claude"   # the native fake (needs cc and xxd)
   install -m 600 /dev/null "$HOME/surety-m4-rehearsal.key"
   printf 'sk-ant-api03-rehearsal-%s\n' "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$HOME/surety-m4-rehearsal.key"
   export SURETY_REAL_RUN_DIR=$HOME/surety-m4-rehearsal-$(date -u +%Y%m%dT%H%M%SZ)
   mkdir -p -m 700 "$SURETY_REAL_RUN_DIR"
   SURETY_REAL_REHEARSAL=1 \
   SURETY_REAL_CREDENTIAL_REF=$HOME/surety-m4-rehearsal.key \
   SURETY_REAL_AUTH_MODE=api_key \
   SURETY_REAL_CLAUDE_BINARY=$HOME/surety-m4-rehearsal-claude \
   SURETY_REAL_CONFIRM_SPEND='I accept the M4 real lane on my Claude subscription, up to 25 USD a day as estimated' \
   node --test --test-reporter=spec packages/engine/test/acceptance/M342-the-real-deployment-journey.test.mjs \
     2>&1 | tee -a "$SURETY_REAL_RUN_DIR/runner.log"
   ```

   The key is made up, in a file of its own outside the run directory (it authenticates nothing; the rehearsal's only provider name resolves nowhere; the fixture entry the rehearsal installs records the `api_key` mode only, SEAM §171). Under the switch the harness answers the approvals and runs your two commands itself, after printing them. Nothing of a rehearsal is evidence for M4.

5. From a login session with the user manager running (`systemctl --user is-system-running` prints `running`); no `surety-*` unit loaded (`systemctl --user list-units --all 'surety-*'` prints nothing); the machine otherwise quiet (BS4 §4.1 rules 7 and 12).

## 2. The command

Set the run directory **once**, as an exported variable, and keep it for every rerun: the run directory holds what has been done and paid for, and a new one starts from scratch and pays the attempt and the roles again. It must be outside the repository.

```
export SURETY_REAL_RUN_DIR=$HOME/surety-m4-real-$(date -u +%Y%m%d)    # choose it once; do not change it between runs
mkdir -p -m 700 "$SURETY_REAL_RUN_DIR"
```

From the repository's root:

```
npm run build

SURETY_REAL_CREDENTIAL_REF=$HOME/.config/surety/claude-subscription.token \
SURETY_REAL_AUTH_MODE=subscription_token \
SURETY_REAL_CLAUDE_BINARY=$HOME/.local/share/claude/versions/<version> \
SURETY_REAL_CONFIRM_SPEND='I accept the M4 real lane on my Claude subscription, up to 25 USD a day as estimated' \
SURETY_REAL_WAIT_MINUTES=120 \
node --test --test-reporter=spec packages/engine/test/acceptance/M342-the-real-deployment-journey.test.mjs \
  2>&1 | tee -a "$SURETY_REAL_RUN_DIR/runner.log"
```

The runner's log goes **inside the run directory**, so M342 (d)'s search for the token reads it too.

**Why not `run-tests.mjs --lane real`:** that runs every file the manifest lists under `real`, M2's five and M3's M239 included, which would run their attempts and journeys again and spend on them (question 5, as recommended). The file run alone keeps every guard: it refuses before starting anything without the run directory (outside the repository), the token's reference (a path to a private file), the pinned binary and the M4 confirmation, which differs from M2's and M3's.

**A rerun**, after a step ended "not established" or halted the directory: the same exported `SURETY_REAL_RUN_DIR`, the same command, with the step to run again named first. **That step and the steps after it run; the steps before it are not run again and not paid again.** The steps, in order:

| Step | What | Paid |
|---|---|---|
| `m4_attempt` | the qualification attempt: three canaries, after your `qualification_approval` | yes, about 0.06 USD |
| `m4_activation` | your `trust_activation` of the entry it wrote; launches nothing | no |
| `m4_checks` | a real Verifier writes the checks; your answer to their classification | one Verifier run |
| `m4_build` | a real Builder builds the service; the engine runs the workspace checks | one to three Builder runs |
| `m4_qualify` | **your** `surety qualify-adapter local_service` | no |
| `m4_deploy` | **your** `surety deploy`; the engine deploys, verifies and completes; then the teardown | no |
| `m4_teardown` | the engine's teardown of `alpha`; nothing of the run home's prefix left | no |

For example, a deployment problem is rerun at no cost:

```
SURETY_REAL_RERUN=m4_deploy \
SURETY_REAL_CREDENTIAL_REF=$HOME/.config/surety/claude-subscription.token \
SURETY_REAL_AUTH_MODE=subscription_token \
SURETY_REAL_CLAUDE_BINARY=$HOME/.local/share/claude/versions/<version> \
SURETY_REAL_CONFIRM_SPEND='I accept the M4 real lane on my Claude subscription, up to 25 USD a day as estimated' \
SURETY_REAL_WAIT_MINUTES=120 \
node --test --test-reporter=spec packages/engine/test/acceptance/M342-the-real-deployment-journey.test.mjs \
  2>&1 | tee -a "$SURETY_REAL_RUN_DIR/runner.log"
```

A halt by a failed judgement is named `judge:M342 (c)` and the like; naming it clears the halt and re-judges from the records, at no cost. Every step pauses its project before its engine stops; a rerun refuses, before it starts an engine, if earlier work of the journey could be dispatched, **or while any unit of the run home's prefix is loaded** (BS4 §12).

## 3. What you do, and what the test waits for

The test never does these for you. Each is printed with what it is and the command (on your terminal, and in `<run dir>/WAITING.txt`); it waits `SURETY_REAL_WAIT_MINUTES`, then stops with nothing further spent.

1. **`qualification_approval`**: approving it runs the three canaries.
2. **`trust_activation`** of the entry the attempt wrote: activating it launches nothing; it lets the journey dispatch real roles.
3. **The classification's decision** about the checks the real Verifier wrote (`check_correction_tightening`, or `_loosening` or `_unclassifiable`): read the proposal's classification and the checks it lists (workspace checks and a `post_deploy_behavior` check); approving applies them as the project's protected checks. A `reject` stops the run there. If the Verifier wrote no `post_deploy_behavior` check, you are not asked: the step ends "not established".
4. **`surety qualify-adapter local_service`**, your own command, in another terminal, printed as:

   ```
   SURETY_HOME=<run dir>/home <node> <repo>/packages/engine/dist/cli.js qualify-adapter local_service
   ```

   It deploys the engine's own fixture services under the run home's prefix, runs D4 §2.6's nine cases each beside its control, removes everything it created, prints its answer and exits 0 when the adapter is qualified. No model; about the time M338's run takes on this host. The test waits for the run to end.

5. **`surety deploy`**, your own command, after the test prints the environment `alpha`'s configuration (the engine's own node by path and hash, `node server.mjs`, a free port, and `REF_SECRET` from a disposable random file the runner made in the run directory, `secrets/ref_secret`, never one of your credentials):

   ```
   SURETY_HOME=<run dir>/home <node> <repo>/packages/engine/dist/cli.js deploy <candidate> --env alpha --project <project>
   ```

   It prints the issued authorization and the deploy work item, or the gate's reasons if refused (then the test goes on waiting; you may ask again). The engine then seals and deploys the candidate to a real user unit `surety-<h>-env_…-g1.service`, verifies it through the real Verifier's `post_deploy_behavior` check between two identity reads, and records `alpha_deployed`. The test reads the unit from the host while it runs (its properties, its cgroup, its journal), then tears the environment down, whatever happened.

Everything else (ticks, the configuration, the teardown) is the test's, through the engine.

## 4. If the teardown leaves anything

The test never stops a unit, never cleans by pattern. If the engine's teardown is not `applied`, or a unit, cgroup or runtime file of the run home's prefix is left, the run directory halts and the test prints each by its exact name. Then either rerun `SURETY_REAL_RERUN=m4_teardown` (the engine is asked again), or stop a unit yourself by its exact name:

```
systemctl --user stop -- surety-<h>-env_<id>-g<n>.service
systemctl --user reset-failed -- surety-<h>-env_<id>-g<n>.service    # only if it shows failed
```

Never `systemctl --user stop 'surety-*'`, and never anything that restarts or reloads the user manager.

## 5. What it keeps, and where it goes afterwards

The run directory keeps the engine home, its records, the repositories, the disposable secret and `state.json`, with `observed/attempt.json`, `observed/activation.json` and `observed/M342.json` (the checks, the build, the qualification, the deployment, the host reads, the teardown, the key search). The Verifier then copies `state.json` and `observed/` here, under `docs/acceptance/reports/M4-real-lane/<date>/`, after searching them for the token by its file (the value never shown), and completes the M4 report (row M343).

When M4 is done, revoke the token in your Claude account's settings and delete its file.
