# M3's real run (row M239): the command for Sean

**Draft by the Verifier of M3 slice 22, 2026-10-08.** Run only by Sean's command (E92 item 3). Nothing here has been run with a real `claude`; the dress rehearsal with the fake is recorded in `packages/engine/test/acceptance/COVERAGE.md`, "M3 slice 22". The file is `packages/engine/test/acceptance/M239-the-real-check-journey.test.mjs` (manifest `real`); what it does is its header and `harness/real/checks-journey.mjs`.

**What it costs.** One real Verifier run writing the checks, one to three Builder runs for stage 1 (the first build and up to two repairs, if a check fails), then a Builder, a Verifier, a Reviewer and a fix Builder for path two: seven to nine runs of Claude Code (`claude-sonnet-5-5`), expected under 1 USD in Claude Code's own estimates, drawn from your subscription's usage allowance, which your own Claude use shares (plan question 5). If the run directory has no active entry, one new qualification attempt runs first (three canaries, about 0.05 USD). Each run is bounded by 300 000 billable tokens (3.00 USD at the dearest rate) and the project's day limit of 6 USD in estimates; the hard limit is your subscription's. The check executions call no model.

## 1. Before you run it

1. **A new subscription token** (E88 item 3: the M2 token was revoked). Make it yourself, keep it in a file of its own readable by you only, and never paste it into a command line or a chat:

   ```
   claude setup-token          # sign in in the browser it opens; it prints a long-lived token
   install -m 600 /dev/null ~/.config/surety/claude-subscription.token
   $EDITOR ~/.config/surety/claude-subscription.token   # paste the token, one line, save
   ```

   The file must be outside the repository, outside `~/.claude` and outside the run directory, mode 600, one line. The engine is given its path (`--secret-file`), never its value.

2. **The pinned binary**: Claude Code's own file, not the `~/.local/bin/claude` link, which moves when it updates itself, for example `~/.local/share/claude/versions/<version>`.

3. **A built checkout on `main`** with slice 22 merged, its Builder's half included: `M239-the-verifiers-check-writing-package.test.mjs` must pass first (the real Verifier writes the checks from its package alone; today the package does not say how), and the rehearsal (`SURETY_REAL_REHEARSAL=1` with the fake, SEAM §171) rerun on that revision, from a login session with the user manager running (`systemctl --user is-system-running` prints `running`), the machine otherwise quiet (BS3 §4 rule 6).

## 2. The command

Set the run directory **once**, as an exported variable, and keep it for every rerun: the run directory holds what has been done and paid for, and a new one starts from scratch and pays path one again. It must be outside the repository.

```
export SURETY_REAL_RUN_DIR=$HOME/surety-m3-real-20261009    # choose it once; do not change it between runs
mkdir -p -m 700 "$SURETY_REAL_RUN_DIR"
```

From the repository's root:

```
npm run build

SURETY_REAL_CREDENTIAL_REF=$HOME/.config/surety/claude-subscription.token \
SURETY_REAL_AUTH_MODE=subscription_token \
SURETY_REAL_CLAUDE_BINARY=$HOME/.local/share/claude/versions/<version> \
SURETY_REAL_CONFIRM_SPEND='I accept the M3 real lane on my Claude subscription, up to 25 USD a day as estimated' \
SURETY_REAL_WAIT_MINUTES=120 \
node --test --test-reporter=spec packages/engine/test/acceptance/M239-the-real-check-journey.test.mjs \
  2>&1 | tee -a "$SURETY_REAL_RUN_DIR/runner.log"
```

The runner's log goes **inside the run directory**, so M239 (d)'s search for the token reads it too.

**A rerun**, after a step ended "not established" or halted the directory: the same exported `SURETY_REAL_RUN_DIR`, the same command, with the step you choose to run again named first, for example:

```
SURETY_REAL_RERUN=m3_path_two \
SURETY_REAL_CREDENTIAL_REF=$HOME/.config/surety/claude-subscription.token \
SURETY_REAL_AUTH_MODE=subscription_token \
SURETY_REAL_CLAUDE_BINARY=$HOME/.local/share/claude/versions/<version> \
SURETY_REAL_CONFIRM_SPEND='I accept the M3 real lane on my Claude subscription, up to 25 USD a day as estimated' \
SURETY_REAL_WAIT_MINUTES=120 \
node --test --test-reporter=spec packages/engine/test/acceptance/M239-the-real-check-journey.test.mjs \
  2>&1 | tee -a "$SURETY_REAL_RUN_DIR/runner.log"
```

Steps already done are not run again (the attempt, the activation, path one when it passed); each case re-judges them from their records. Every path pauses its project before its engine stops, whatever happened; a rerun refuses, before it starts an engine or resumes a project, if any earlier work could be dispatched (an eligible item within the chain limit, or a run not ended), so a rerun never pays for work nobody asked for.

**Why not `run-tests.mjs --lane real`:** that runs every file the manifest lists under `real`, M2's five included, which would run M2's attempt and journey again and spend on them (M3 report, question 1). The file run alone keeps every guard: it refuses before starting anything without the run directory (outside the repository), the token's reference (a path to a private file), the pinned binary and the M3 confirmation, which differs from M2's.

**The checks' toolchain.** The governed file names one program, `node`: a copy of the engine's node binary in `$SURETY_REAL_RUN_DIR/toolchain/`, its SHA-256 pinned in `check_commands`; that directory is the checks' only read path, and their `PATH` is `/usr/bin:/bin`. A check the model writes reaches nothing else of your node installation or your home.

## 3. The approvals you give

The test never gives them for you. Each is printed with the decision's preview and the `curl` command that answers it (on your terminal, and in `<run dir>/WAITING.txt`); it waits `SURETY_REAL_WAIT_MINUTES`, then stops with nothing further spent.

1. **`qualification_approval`**, only if a new qualification attempt is needed: approving it runs the three canaries.
2. **`trust_activation`** of the entry the attempt wrote: activating it launches nothing; it lets the journey dispatch real roles.
3. **The classification's decision** about the checks the real Verifier wrote (`check_correction_tightening`, or `_loosening` or `_unclassifiable` if it changed more than definitions): read the proposal's classification and the checks it lists; approving applies them as the project's protected checks. A `reject` stops the run there.

Everything else (the chain boundary's `continue`, the review of path two) is answered by the test, as M2's journey did (SEAM §162).

## 4. What it keeps, and where it goes afterwards

The run directory keeps the engine home, its records, the repositories and `state.json`, with `observed/M239.json` (the paths, the executions, the gates, the finding) and the key search. A step that ends unexpectedly halts the directory; nothing paid runs after it until you name the step in `SURETY_REAL_RERUN` (as in the rerun command above). The Verifier then copies `state.json` and `observed/` here, under `docs/acceptance/reports/M3-real-lane/<date>/`, after searching them for the token, and completes the M3 report (row M240).

When M3 is done, revoke the token in your Claude account's settings and delete its file.
