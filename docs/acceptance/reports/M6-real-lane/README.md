# M6's real runs (rows M519 and M535): the commands for Sean

**Draft by the Verifier of M6 slice 46, 2026-10-17.** Run only by Sean's command, or by the driver under his standing delegation (E144 item 2), on his subscription token (BS6 §12). Nothing here has been run with a real `claude`. **M519 first; M535 only after every defect M519 finds is fixed on `main` and M535's own dress rehearsal has passed on the revision it runs** (E156 Q5): the file refuses to start otherwise (section 5). The files are `packages/engine/test/acceptance/M519-the-real-run-design-before-build-and-at-alpha.test.mjs` and `M535-the-real-run-web-an-android-simulation-and-a-held-logo.test.mjs` (manifest `real`); what they do is their headers and `harness/real/m6-lane.mjs`; the seam is SEAM §§541 to 543.

**What it costs: guesses, not promises** (E156 Q5; D7 §13 has no Designer figure). M519, V1's visual brief with a Designer before build and a review at Alpha: **perhaps 10 to 18 USD** (V1 without a Designer was 8.61 USD; a Designer session on Opus of several turns adds perhaps 1 to 4 USD per target per session, and the review is a second Designer session). M535, two targets and a held logo: **perhaps 15 to 25 USD**. Before either, once per run directory: two qualification attempts (Opus `session_headless` with the continuation canary, Sonnet `one_shot_headless`), under 0.50 USD together; M519 pays them and M535 reuses them in the same run directory. **The caps:** each run (a session is one run) 2 000 000 billable tokens; each Designer session 3 000 000 (`designer_session_budget_billable_tokens`, A.7's trial default); the project's day limit **40 USD (M519) and 50 USD (M535)** in estimates, per UTC day; the day bound on unknown usage 4 000 000 tokens. The raised bounds are one widening you confirm (`policy_widening`). Drawn from your subscription's usage limits, which your own Claude use shares. The runs measure the Designer's usage and the preview's `memory.peak`; a default changes only by your recorded decision on those measurements (E156 Q4).

## 1. Before each run

1. **The subscription token** in a file of its own, 0600, outside the repository, `~/.claude` and the run directory, never pasted into a command line or a chat (M5's, if still valid; otherwise `claude setup-token` as M5's README §1). It is passed by path only (`SURETY_REAL_CREDENTIAL_REF`).
2. **The pinned binary**: Claude Code's own file (`~/.local/share/claude/versions/<version>`), not the `~/.local/bin/claude` link.
3. **A built, clean checkout of `main`** with slice 45 merged and M537 passing (its files), `npm run build`. A checkout with uncommitted changes to tracked files is refused.
4. **The dress rehearsal of that run's file**, on that same revision, in a run directory of its own, by the driver or by you; never evidence. The package-driven fakes play every role from its package, **the Designer's among them** (M537; `harness/standin/package-fakes.cjs`), on the rehearsal's Pantry (`harness/real/m6-content.mjs`); the harness answers the decisions, types the sessions, previews, opens and closes the relay itself, and records itself as the performer `rehearsal`:

   ```
   npm run build
   bash packages/engine/test/acceptance/harness/standin/build-rehearsal-claude.sh "$HOME/surety-m6-rehearsal-claude"
   install -m 600 /dev/null "$HOME/surety-m6-rehearsal.key"
   printf 'sk-ant-api03-rehearsal-%s\n' "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$HOME/surety-m6-rehearsal.key"
   export SURETY_REAL_RUN_DIR=$HOME/s6r-w      # short: <run dir>/home must be at most 56 bytes
   mkdir -p -m 700 "$SURETY_REAL_RUN_DIR"
   SURETY_REAL_REHEARSAL=1 \
   SURETY_REAL_CREDENTIAL_REF=$HOME/surety-m6-rehearsal.key \
   SURETY_REAL_AUTH_MODE=api_key \
   SURETY_REAL_CLAUDE_BINARY=$HOME/surety-m6-rehearsal-claude \
   SURETY_REAL_CONFIRM_SPEND='I accept the M6 real run M519 (design before build and at Alpha, web) on my Claude subscription, a guess of 10 to 18 USD, capped at 2000000 tokens a run, 3000000 a Designer session and 40 USD a day' \
   node --test --test-reporter=spec packages/engine/test/acceptance/M519-the-real-run-design-before-build-and-at-alpha.test.mjs \
     2>&1 | tee -a "$SURETY_REAL_RUN_DIR/runner.log"
   ```

   and for M535 the same in `$HOME/s6r-x` with M535's confirmation (section 2) and file. **A rehearsal whose every case passes writes `<its run dir>/rehearsal-passed.json`** (`{file, revision, dirty, at}`); the paid run reads it through `SURETY_M519_REHEARSAL_DIR` or `SURETY_M535_REHEARSAL_DIR` and refuses unless it names this exact, clean revision.
5. From a login session with the user manager running; no `surety-*` unit loaded; the machine otherwise quiet; `wsl --shutdown` at a pause first if the clock is stepping (rule 17).
6. **M535 only:** the brief `docs/acceptance/reports/M6-real-lane/m535-brief.md` is Waterlog, **approved by you with three edits** (E162 item 3), applied there: Android notifications are out of this version (future work: the app asks for no permission and has no notification screen); the held-logo sequence is mandatory (hold the first proposal, build with the placeholder, approve the logo through an asset-only approval, verify that it propagates); Android is source plus a labelled simulation, its cross-target behaviour unverified until a native runtime is exercised. One phase, the simple API and no persistence stay. Approving the brief replaces neither your specification and design approvals nor this section's prerequisites. (`SURETY_M535_BRIEF` still points at another file if you choose.) M519 reads V1's visual brief at `~/surety-m5-physics-idea-visual.md` (or `SURETY_M519_BRIEF`); it does not change the brief: your Spec Writer session writes `**Targets:** web` into the specification. Both projects' Alpha runs `node server.mjs` on `PORT` (the runner's configuration of `alpha`, printed as its setup): say so in the specification's environment.

## 2. The commands

One run directory for both runs, so that the attempts are paid once; set it **once**, short, outside the repository, and keep it for every rerun:

```
export SURETY_REAL_RUN_DIR=$HOME/s6-$(date -u +%m%d)
mkdir -p -m 700 "$SURETY_REAL_RUN_DIR"
npm run build
```

M519:

```
SURETY_M519_REHEARSAL_DIR=$HOME/s6r-w \
SURETY_REAL_CREDENTIAL_REF=$HOME/.config/surety/claude-subscription.token \
SURETY_REAL_AUTH_MODE=subscription_token \
SURETY_REAL_CLAUDE_BINARY=$HOME/.local/share/claude/versions/<version> \
SURETY_REAL_CONFIRM_SPEND='I accept the M6 real run M519 (design before build and at Alpha, web) on my Claude subscription, a guess of 10 to 18 USD, capped at 2000000 tokens a run, 3000000 a Designer session and 40 USD a day' \
SURETY_REAL_WAIT_MINUTES=180 \
node --test --test-reporter=spec packages/engine/test/acceptance/M519-the-real-run-design-before-build-and-at-alpha.test.mjs \
  2>&1 | tee -a "$SURETY_REAL_RUN_DIR/runner-M519.log"
```

M535, after section 5's condition holds, the same run directory, with `SURETY_M535_REHEARSAL_DIR=$HOME/s6r-x` (and `SURETY_M519_RUN_DIR` only if M519 ran elsewhere), its own confirmation `'I accept the M6 real run M535 (web and a labelled android simulation, a held logo) on my Claude subscription, a guess of 15 to 25 USD, capped at 2000000 tokens a run, 3000000 a Designer session and 50 USD a day'`, and its file.

**Never `run-tests.mjs --lane real`:** it runs every `real` file, M2 to M5's paid ones included. Each file run alone keeps every guard: it refuses before starting anything without `SURETY_REAL_RUN_DIR`, the token's reference (a 0600 file, never read by you or the driver), the pinned binary and its own confirmation, and (M535) without section 5's condition.

**Each step's end** is judged by BS6 §4.1 rule 25 as amended (E162 item 1): the step fails, naming them, if a question raised before its end is still open (but those it hands to the next step, recorded in its value as `handed_over`, each open and unanswered with its options and what it is about), or if a design-held stage is accounted for by nothing (no open question, no Designer session, no engine work, no unexpired deferral); an engine-driven wait (the build, the asset change, Alpha) fails at once, naming what is held, when the project has nothing runnable, nothing in flight and nothing asked. **An intentional wait is never a pass:** a step that ends with a `later` deferral you chose still running, or with your Designer session open on a held stage, is recorded `waiting` in `state.json` (not `done`, not passed) and halts the run directory like a failure, naming the wait; when the wait is over, rerun that step by name. Then the project is paused and its runs in flight drained (up to 45 minutes) before the engine stops.

**A rerun** names the step: `SURETY_REAL_RERUN=<step>`; that step and those after it in the file's order run again, the steps before it are not run or paid again. A rerun refuses while any unit of the run home's prefix is loaded, and, when it resumes after a step that did not complete, while the journey's project has work of an earlier attempt that could be dispatched or a run not ended (a UI stage the engine holds `design_pending` is held, not such work: SEAM §550). A step's per-act record (section 3) covers every attempt of it from its first start (`observed/step-attempts.json`): a rerun adds its own acts and never drops an earlier attempt's (SEAM §551). A judgement that halted the run directory (`judge:<label>` in `state.json`) is cleared by naming it, for instance `SURETY_REAL_RERUN='judge:M519 (c)'`; no step runs again, and the judgement is made afresh.

| Step | What | Paid |
|---|---|---|
| `m6_attempt` | the Opus attempt (`session_headless`, the continuation canary) and the Sonnet attempt (`one_shot_headless`), each after **your** `qualification_approval` (M5's inner steps `m5_attempt_opus`, `m5_attempt_sonnet`) | yes |
| `m6_activation` | **your** `trust_activation` of each entry; launches nothing | no |
| `m6w_create`, `m6x_create` | the project with its brief; its policy (Opus sessions with the Designer's, Sonnet one-shots, `design: both`, `autonomy: phase`, the day limit; the runner's setup, printed); then the run bound, the unknown-usage bound and `alpha_deploy: on_phase_complete`, one widening **you confirm** | no |
| `m6w_spec`, `m6x_spec` | **your** Spec Writer session (with `**Targets:**`, and for M535 `**Cross-platform:** yes`), your `spec_approval` | Opus |
| `m6w_architecture`, `m6x_architecture` | alpha's configuration (the runner's setup, printed); **your** Architect session (surfaces, targets, technologies, interface shapes), your `architecture_approval` and `plan_approval`; `design_due` and the phase's toolchain proposal handed to the next steps | Opus |
| `m6w_qualify`, `m6x_qualify` | **your** `surety qualify-adapter local_service` | no |
| `m6w_design`, `m6x_design` | `design_due` (answer `open`); **your** Designer session; **your** preview inspection through the relay; the batched `design_approval` and `spec_change` (M535: **the logo held**); the criteria's checks (your answer to the correction); `design_ready`; the preview torn down by the approval. M535: then the runner's own read of the approved design's preview and export (not your inspection) | Opus, Sonnet |
| `m6w_build`, `m6x_build` | M519: the phase built and complete. M535: the UI stages built with the placeholder logo, their bindings recorded | Sonnet |
| `m6x_asset` | **your** `surety design assets submit` (or first your own file by `surety design asset add`), your asset-only `design_approval`; `asset_updated` work, `asset_version_changed` obligations, parity passing on the new `slot@version` | Sonnet |
| `m6w_alpha`, `m6x_alpha` | Alpha requested under policy at the phase's completion, deployed and verified; `design_due` (`alpha_review`) handed to the review, and any `finding_disposition` still open (such as a Designer's `requirement_conflict` you left open), recorded in the step's value open and unanswered and printed at its end (SEAM.md §559) | no |
| `m6w_review`, `m6x_review` | **your** look at the Alpha (`surety env open alpha`); `design_due` (`open`); **your** review-mode Designer session; **your** `design_verdicts` confirmation (or edits, strikes); **your** answer to every question carried in (printed at its start): the review hands over nothing and does not end while one is open, except, under errata E179 alone, the continuation's two Designer `requirement_conflict` questions (R10, R7) you acknowledge yourself with `owner-act.mjs <run dir> question_acknowledged` (the decision id, the requirement, its implications, its deferred follow-up): each holding no gate stays open, recorded open and acknowledged, and the run is then "completed under E179", not M535 (j) as written, and not clean (SEAM.md §560) | Opus |
| `m6w_teardown`, `m6x_teardown` | in the build-to-review engine's `finally`: a preview still serving stopped (the runner's setup, printed), Alpha torn down, nothing of the prefix left | no |

Two placements differ from BS6 §12's list (SEAM §541): the qualification comes before the design, because the preview needs a qualified `local_service` adapter (A.6 `design_preview_unavailable`, `adapter_unqualified`); and the build, the asset change, Alpha and the review run in one engine, so that a deployment is never split across two engines and Alpha still serves when the review fetches it. **M535's asset change is mandatory** (E162 item 3): hold the logo at the first approval (the UI stages build with the placeholder), and approve it (or your own file) through the asset-only approval once the runner prints `m6x_asset`, which follows the UI stages' bindings; the step passes only when the change has propagated (the effective version moved, the `asset_updated` work integrated, the `asset_version_changed` obligations resolved, parity passing on the new `slot@version`). If the phase completes first, Alpha deploys with the placeholder and the record says which candidate it was; the asset change still follows.

## 3. What you do, who did it, and how it is recorded (E156 Q6; rule 26)

Every command you type and every decision you answer is printed on your terminal and in `<run dir>/WAITING.txt`, with the CLI line or the curl line; the test waits `SURETY_REAL_WAIT_MINUTES` for its effect. It never answers or types for you outside the rehearsal.

**The store's `human` actor alone does not show who acted.** So every owner act the store records (a decision answered by the owner's route, an owner turn in a session, an owner command) is written to `<run dir>/observed/acts-<row>.json` with its **performer** and the evidence for it:

- **Your own acts:** record each, in your own words, **in your own terminal**, at the act (just before or just after it):

  ```
  node docs/acceptance/reports/M6-real-lane/owner-act.mjs "$SURETY_REAL_RUN_DIR" <act>
  ```

  It refuses unless its input and output are your terminal, asks what you looked at or did (a few words at least), and appends `{act, at, words, entered_via, tty, uid, user}` to `observed/owner-acts.jsonl`. Nobody else types these words for you.
- **The driver's acts on your instruction:** the driver records your words verbatim and the act:

  ```
  node docs/acceptance/reports/M6-real-lane/driver-act.mjs "$SURETY_REAL_RUN_DIR" <act> --instruction "<your words>" [--step <s>] [--decision <id>] [--option <o>]
  ```

- **Performer:** `sean` with your entry since the step started; `driver` with the driver's; `unknown` with neither (or with both, which is a conflict and is said so); `rehearsal` under the rehearsal. The runner waits `SURETY_REAL_ACT_RECORD_MINUTES` (15 by default) for a record at each step's end, then writes `unknown`, never assumes you. M519 (i) and M535 (l) fail on an `unknown`.

**M535's four central acts are yours, not the driver's** (E156 Q6): `designer_feedback` (your own turns in the Designer session), `preview_inspection` (`surety design preview`, `surety env open design-preview`, the web mockup and the android simulation in **your** browser, `surety env close design-preview`), `combined_approval` (the batch, the logo held) and `review_confirmation` (`design_verdicts`). Each needs your own entry; the step waits `SURETY_REAL_WAIT_MINUTES` for it, then fails naming the act. For the preview inspection the record adds the relay's openings and closings for `design-preview`; neither the relay nor the preview server records the paths it serves, so `relay_requests` is recorded `unknown` with why.

The act names: `spec_session`, `spec_approval`, `architect_session`, `architecture_approval`, `plan_approval`, `policy_widening`, `qualify_adapter`, `design_due`, `designer_feedback`, `preview_inspection`, `combined_approval`, `correction_approval`, `asset_add`, `asset_submit`, `asset_approval`, `review_session`, `review_confirmation`, `finding_disposition`, `deploy`; and `question_acknowledged` (errata E179 only: your acknowledgement of an open question you leave open at the review's end, which asks for its decision id, requirement, implications and deferred follow-up; SEAM.md §560).

## 4. M519's findings

Every defect M519 finds is recorded, by the driver or by you, with the step it stopped and whether a workaround passed it:

```
node docs/acceptance/reports/M6-real-lane/finding.mjs "$SURETY_REAL_RUN_DIR" add --step m6w_design --what "<the defect>" [--workaround "<what was done instead>"]
node docs/acceptance/reports/M6-real-lane/finding.mjs "$SURETY_REAL_RUN_DIR" resolve F1 --commit <the fix's commit on main>
node docs/acceptance/reports/M6-real-lane/finding.mjs "$SURETY_REAL_RUN_DIR" list
```

A step passed only by a workaround is **not passed** (E156 Q5): M519 (j) fails on it, and M535 refuses to start. Its fix goes to `main` (a Builder branch merged by the driver, with its acceptance case where a row covers it); then the step is rerun on that revision (`SURETY_REAL_RERUN=<step>`), which clears the workaround with the step's record.

## 5. Before M535 starts (E156 Q5)

M535 refuses, before any engine starts and before anything is paid, unless:

- M519's `state.json` (this run directory, or `SURETY_M519_RUN_DIR`) records every journey step `m6w_create` to `m6w_teardown` passed, none passed only by a workaround;
- every M519 finding is resolved by a commit the checked-out revision contains (none found is fine);
- `SURETY_M535_REHEARSAL_DIR/rehearsal-passed.json` records M535's rehearsal passed on this exact revision, from a clean checkout;
- the checkout is clean.

## 6. What is kept

`state.json`; `observed/M519.json`, `observed/M535.json` (each step's value, the setup notes, the start condition, the preview read-back); `observed/acts-M519.json`, `observed/acts-M535.json`; `observed/owner-acts.jsonl`, `observed/driver-acts.jsonl`; `observed/findings-M519.jsonl`; `observed/pace-M519.json`, `observed/pace-M535.json`; `export-M535/` (the approved tree with `SIMULATIONS.txt`); the run log. The Verifier copies them, with the design trees at each approved revision, the review files, the evidence records' digests (never your device screenshots' bytes unless you say so) and the sessions' transcript records (searched for the token by its file, the value never shown), to `docs/acceptance/reports/M6-real-lane/<date>/`, and completes the M6 report (M540). Revoke the token afterwards if you made a new one.

## 7. If a teardown leaves anything

The run directory halts and prints each unit, cgroup or file of the run home's prefix by its exact name. Rerun the teardown alone with `SURETY_REAL_RERUN=m6w_teardown` (or `m6x_teardown`) and the file's own variables: the build-to-review step then starts its engine, finds its steps done, and runs only the teardown in its `finally`. To stop a unit yourself, by its exact name only: `systemctl --user stop -- <name>`. Nothing is cleaned by the test, and nothing by pattern.
