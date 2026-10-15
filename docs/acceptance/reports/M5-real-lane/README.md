# M5's real runs (rows M443 and M444): the commands for Sean

**Draft by the Verifier of M5 slice 38, 2026-10-14.** Run only by Sean's command, or by the driver under his delegation (E144 item 2), on his subscription token (BS5 §12). Nothing here has been run with a real `claude`. The dress rehearsal of each file must pass on the revision you run, before you run it (section 1, step 4). The files are `packages/engine/test/acceptance/M443-the-real-journey-from-an-idea-to-alpha.test.mjs` and `M444-the-real-retrofit-journey.test.mjs` (manifest `real`); what they do is their headers and `harness/real/m5-lane.mjs`; the seam is SEAM §456.

**What it costs.** M443, the journey from an idea to Alpha: **about 5 USD** in Claude Code's own estimates (E139 item 7): three sessions of a few turns each on Opus (Vision optional), about twelve to sixteen one-shot runs on Sonnet. M444, the retrofit: **about 3 USD** (E140 N3): two sessions on Opus, three or four one-shots on Sonnet; about forty minutes of your time in the sessions. Before either, once per run directory: two qualification attempts, one per model (Opus in `session_headless` mode with the continuation canary; Sonnet in `one_shot_headless` mode), under 0.50 USD together. Drawn from your subscription's usage limits, which your own Claude use shares. The caps, your choice of 2026-10-14: each run (a session is one run, its turns added up) bounded by 2 000 000 billable tokens, and each project by a day limit in estimates of 30 USD (M443) and 20 USD (M444), with its day bound on unknown usage at 4 000 000 tokens, twice the run cap (the driver's ruling under your caps: a run whose usage is incomplete reserves the rest of its cap as unknown, and rehearsal 4 showed a day bound below the cap refusing every other item); the estimates stay about 5 and 3 USD. The run bound and the unknown-usage bound are raised in one change, a widening you confirm. **The day limits are per UTC day** (the engine's day is UTC): start each run early in the UTC day, so that a long journey does not straddle midnight UTC with its spending split across two days' limits. A session turn whose usage Claude Code does not report reserves the run's whole allowance and closes the session (D1 §13.3, kept by your decision); the report says so if it happens. An estimate, not a cap or an authorization. The tests print this before they start anything.

## 1. Before you run them

1. **A new subscription token** (M4's was to be revoked, E135 item 1), in a file of its own readable by you only, never pasted into a command line or a chat:

   ```
   claude setup-token
   install -m 600 /dev/null ~/.config/surety/claude-subscription.token
   $EDITOR ~/.config/surety/claude-subscription.token   # one line, save
   ```

   Outside the repository, `~/.claude` and the run directory.

2. **The pinned binary**: Claude Code's own file, for example `~/.local/share/claude/versions/<version>`, not the `~/.local/bin/claude` link.

3. **A built checkout on `main`** with slice 38 merged and M442 passing (its three files), `npm run build`.

4. **The dress rehearsal of each file**, on that same revision, each in a run directory of its own (the rehearsal's fake carries the project's content, which differs between the two journeys), by the driver or by you; never evidence:

   ```
   npm run build
   bash packages/engine/test/acceptance/harness/standin/build-rehearsal-claude.sh "$HOME/surety-m5-rehearsal-claude"   # needs cc and node (no xxd)
   install -m 600 /dev/null "$HOME/surety-m5-rehearsal.key"
   printf 'sk-ant-api03-rehearsal-%s\n' "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$HOME/surety-m5-rehearsal.key"
   export SURETY_REAL_RUN_DIR=$HOME/s5r-a     # short: the engine home inside it must be at most 56 bytes
   mkdir -p -m 700 "$SURETY_REAL_RUN_DIR"
   SURETY_REAL_REHEARSAL=1 \
   SURETY_REAL_CREDENTIAL_REF=$HOME/surety-m5-rehearsal.key \
   SURETY_REAL_AUTH_MODE=api_key \
   SURETY_REAL_CLAUDE_BINARY=$HOME/surety-m5-rehearsal-claude \
   SURETY_REAL_CONFIRM_SPEND='I accept the M5 real journey from an idea to Alpha (M443) on my Claude subscription, about 5 USD as estimated, capped at 2000000 tokens a run and 30 USD a day' \
   node --test --test-reporter=spec packages/engine/test/acceptance/M443-the-real-journey-from-an-idea-to-alpha.test.mjs \
     2>&1 | tee -a "$SURETY_REAL_RUN_DIR/runner.log"
   ```

   and the same for M444 in `$HOME/s5r-r` with its own confirmation (section 2). Under the switch the harness answers the decisions and runs your commands itself, after printing them; the two entries are fixture entries running the fake's script form with the package-driven fakes (SEAM §§171, 455, 456), which play every role from its package alone. The attempts end on the provider-tunnel control (no provider is reachable), recorded and not a halt.

5. From a login session with the user manager running; no `surety-*` unit loaded; the machine otherwise quiet (BS5 §4.1 rules 7 and 12); `wsl --shutdown` at a pause first if the clock is stepping (rule 17).

## 2. The commands

One run directory for both journeys, so that the attempts are paid once; set it **once**, short (the engine home `<run dir>/home` must be at most 56 bytes, E134), outside the repository, and keep it for every rerun:

```
export SURETY_REAL_RUN_DIR=$HOME/surety-m5-real-$(date -u +%Y%m%d)
mkdir -p -m 700 "$SURETY_REAL_RUN_DIR"
npm run build
```

M443 first:

```
SURETY_REAL_CREDENTIAL_REF=$HOME/.config/surety/claude-subscription.token \
SURETY_REAL_AUTH_MODE=subscription_token \
SURETY_REAL_CLAUDE_BINARY=$HOME/.local/share/claude/versions/<version> \
SURETY_REAL_CONFIRM_SPEND='I accept the M5 real journey from an idea to Alpha (M443) on my Claude subscription, about 5 USD as estimated, capped at 2000000 tokens a run and 30 USD a day' \
SURETY_REAL_WAIT_MINUTES=120 \
node --test --test-reporter=spec packages/engine/test/acceptance/M443-the-real-journey-from-an-idea-to-alpha.test.mjs \
  2>&1 | tee -a "$SURETY_REAL_RUN_DIR/runner.log"
```

Each run directory is marked a rehearsal's or a real run's when it is made (`state.json`'s `rehearsal`, `run-kind.json`): a real run refuses a rehearsal's directory, and a rehearsal a real run's.

Then M444, the same with its own confirmation, `'I accept the M5 real retrofit journey (M444) on my Claude subscription, about 3 USD as estimated, capped at 2000000 tokens a run and 20 USD a day'`, and its file.

Optional: `SURETY_REAL_IDEA_FILE=<your brief>` (M443's idea; without it the reference brief of `harness/journey/reference.mjs`, labelled). With your brief, nothing of the reference reaches the project: it is named `m5-real-<slug>` from the `name:` of the brief's ```` ```yaml surety-identity ```` block (`m5-real-idea` without one), its repository `repos/<slug>` starts from a README `# <name>`, and there is no reference change. `SURETY_REAL_VISION=run` (a Vision session; skipped and recorded by default); `SURETY_REAL_CHANGE_FILE=<your change request>` (with your own brief, without it you write the change in `<run dir>/change-request.md` before your command; with the reference brief, without it the reference CR-1).

**Why not `run-tests.mjs --lane real`:** it runs every `real` file, M2's, M3's and M4's paid ones included. Each file run alone keeps every guard: it refuses before starting anything without the run directory, the token's reference (a 0600 file), the pinned binary and its own confirmation.

**Each step's end** pauses the project and waits (up to 45 minutes) for its runs in flight to end before it stops the engine, so no run is cut off on the way; what it waited for is recorded. A step that finds work a recovery left `held` resumes it through the owner's route, printed as the runner's setup.

**A rerun** names the step: `SURETY_REAL_RERUN=<step>`; that step and those after it in the file's order run, the steps before it are not run or paid again. A halt by a failed judgement is `judge:M443 (c)` and the like, re-judged from the records at no cost. Every step pauses its project before its engine stops; a rerun refuses before it starts anything if earlier work could be dispatched, or while any unit of the run home's prefix is loaded.

| Step | What | Paid |
|---|---|---|
| `m5_attempt_opus` | the Opus attempt in `session_headless` mode, the continuation canary among its canaries, after your `qualification_approval` | yes |
| `m5_attempt_sonnet` | the Sonnet attempt in `one_shot_headless` mode, after your `qualification_approval` | yes |
| `m5_activation` | your `trust_activation` of each entry; launches nothing | no |
| `m5a_create` | the project created with its idea; its policy (Q6's models, the day limit, `phase_size`), the runner's setup, printed; then the run bound raised to your cap and `alpha_deploy: on_phase_complete`, one widening **you confirm** (`policy_widening`, E143 item 1) | no |
| `m5a_vision` | optional; skipped and recorded by default | Opus |
| `m5a_spec` | **your** Spec Writer session, then your `spec_approval` | Opus |
| `m5a_architecture` | alpha's configuration (the runner's setup, printed: `PUT …/environments/alpha/config`); **your** Architect session, then your `architecture_approval` and `plan_approval` | Opus |
| `m5a_phase1` | the authoring (your answer to the toolchain's proposal), two stages, phase verification, the replan | Sonnet |
| `m5a_change` | **your** `surety spec change-request`, your `spec_change` answer, the correction (your answer to its proposal) | Sonnet |
| `m5a_qualify` | **your** `surety qualify-adapter local_service` (alpha's configuration kept) | no |
| `m5a_phase2` | phase 2 to completion | Sonnet |
| `m5a_alpha` | the engine's request under policy at phase 2's completion, the deployment, the verification; the teardown (`m5a_teardown`) in its `finally` | no |
| `m5r_adopt` | the M4 repository copied, its head checked, the Surety records removed by one recorded commit; **your** `surety project adopt`; your `adoption_mode` (`full`); the policy (the runner's setup, printed), then the run bound raised to your cap, a widening **you confirm** (`policy_widening`) | no |
| `m5r_spec` | **your** retrofit Spec Writer session; your `requirement_confirm` for each requirement and your `spec_approval` | Opus |
| `m5r_architecture` | alpha's configuration (the runner's setup, printed); **your** Architect session; your approvals of the conformance plan | Opus |
| `m5r_conformance` | the authoring with adoption (your answer to the toolchain), the conformance stage with no Builder against A, phase verification | Sonnet |
| `m5r_qualify` | **your** `surety qualify-adapter local_service` (alpha's configuration kept) | no |
| `m5r_deploy` | **your** `surety deploy` of c-1, which opens the Alpha barrier; the teardown (`m5r_teardown`) in its `finally` | no |
| `m5r_replan` | the change-phase replan, after `alpha_complete` | Sonnet |
| `m5r_phase2` | one stage by a real Builder | Sonnet |

The qualification is placed before phase 2 (not after it, as BS5 §12's list reads) so that `on_phase_complete` can request Alpha at phase 2's completion; each teardown runs in its deployment's `finally`, so that no unit is loaded when a later step starts (SEAM §456).

## 3. What you do, and what the test waits for

Every command you type and every decision you answer is printed on your terminal and in `<run dir>/WAITING.txt`, with the command or the curl line; the test waits `SURETY_REAL_WAIT_MINUTES` for its effect, then stops with nothing further spent. It never answers or types them for you outside the rehearsal. The sessions are yours: the test prints `surety session open|say|show|save|close` for the run's home and waits for the decision your close raises. If you tell the driver to act for you, the driver records your words and the act (`acted_by: driver, on_instruction`), and the report says so.

## 4. If a teardown leaves anything

The run directory halts and prints each unit, cgroup or file of the run home's prefix by its exact name. The teardown is its own recorded step (`m5a_teardown`, `m5r_teardown`); run it again, alone, with this command, which starts the run home's engine, reads the prefix and asks the engine to tear `alpha` down (the engine stops a unit only by its exact name), and does nothing else: no model, no session, no other step, the earlier steps' records kept.

```
SURETY_REAL_RERUN=m5r_teardown \
SURETY_REAL_CREDENTIAL_REF=$HOME/.config/surety/claude-subscription.token \
SURETY_REAL_AUTH_MODE=subscription_token \
SURETY_REAL_CLAUDE_BINARY=$HOME/.local/share/claude/versions/<version> \
SURETY_REAL_CONFIRM_SPEND='I accept the M5 real retrofit journey (M444) on my Claude subscription, about 3 USD as estimated, capped at 2000000 tokens a run and 20 USD a day' \
node docs/acceptance/reports/M5-real-lane/teardown.mjs M444
```

(For M443: `SURETY_REAL_RERUN=m5a_teardown`, M443's confirmation, and `teardown.mjs M443`.) Or stop a unit yourself by its exact name: `systemctl --user stop -- <name>`. Never by pattern, never anything that restarts or reloads the user manager.

## 5. What it keeps

The run directory keeps the engine home, its records, the repositories, the disposable secret, `state.json`, `observed/` and `observed/pace-M443.json`, `observed/pace-M444.json`. The Verifier copies `state.json`, `observed/` and the sessions' transcript records to `docs/acceptance/reports/M5-real-lane/<date>/`, after searching them for the token by its file (the value never shown), and completes the M5 report (row M445). Then revoke the token in your Claude account's settings and delete its file.
