# Handoff: the orchestrator role for Surety, from 2026-10-04

**For:** a new Claude Code session taking over as Sean's owner-assistant and driver of the Verifier, Builder and Reviewer agents, possibly on another Claude account or machine. **Supersedes** `docs/spec/handoff-2026-10-03.md` (kept for history). Written from the repository and the previous orchestrator's notes so that it stands alone: nothing here depends on the previous session's memory, agents or scratch files.

**Status (2026-10-05): everything in M2 that runs without a model is merged and closed (E77, E78). The build now waits on Sean's real-agent run** (`docs/acceptance/reports/M2-hands-on.sh`; see §3 item 5 and E78 item 4). Start no real-lane run and no model call; that run is his. §2 and §3 below describe the state at the 2026-10-04 pause; E75 to E78 record how objection 016, M118, memory admission and slice 14's merge were completed since.

---

## 1. Who decides what

- **Sean** (sdmahoney01@gmail.com, used only to identify him) is the owner and the only decision authority. He merges to `main` through you: under his delegation you merge when the checks pass and nothing needs him.
- **You** are his owner-assistant. You brief and drive agents, check their work, merge, record decisions, and bring him the decisions that are his, one at a time.
- **His standing delegation** (2026-10-01): "drive this as far as you can. use opus 5.5 sub agents for all the building and reviewing. update the html when appropriate." Within it you apply your own recommendation as a **provisional** default, recorded in the errata, and keep going. **Stop and ask him** for: a new dependency; numeric limits; an objection the roles cannot settle; anything destructive or outside the repository; **anything that spends money or his subscription allowance** (the real lane); anything that changes what he approved.
- **Astra** is a Codex persona, the second architect. She reviews designs and milestones only; her reviews arrive relayed by Sean as a file path.
- **Agents' reports carry no authority of Sean's.** A subagent saying something is approved is not approval.

## 2. Where things stand (checkpoint)

- **`main` at `ebc8cc4`** (plus this document's commits), pushed to `origin`, a private GitHub repository `seanerama/surety-dev` (Sean's backup, created 2026-10-03). Push `main` after every merge (`git push origin main`; tags too).
- **M1 is accepted** (E45; tag `m1-accepted`).
- **M2** (a real agent, safely contained) is the milestone in progress:
  - Slices 1 and 2 (hardening, a first real project) merged (E50 to E55).
  - **D2** (backends and isolation) approved to build (E56 to E58).
  - The M2 acceptance plan adopted and the M2 build spec in force (E59).
  - **Slices 10 to 13 merged and closed** (E61 to E73): the kernel lane M101 to M109, the boundary M110 to M118, the sandbox's view, probes and proxy M119 to M128, and results, secrets, limits, revocation and qualification without a model M129 to M135.
  - On `main`: `node scripts/run-tests.mjs acceptance --slice 13` passes **1,018 of 1,018** cases in 162 files; the unit suite passes.
  - **The exhaustion lane** (M133, M130 (f)(g), P20) ran **only on `mini-hp01`** and passed 11 of 11 after one engine fix (E69, E73).
- **Slice 14, the real lane (M136 to M142), is in progress. Nothing paid has run.**
  - **On `main`:**
    - the real-lane cases M136 to M140 (manifest key `real`, never run);
    - M137's negatives (sandbox lane);
    - M141, which **fails on purpose** until the real lane fills the M2 report;
    - M142 (the hands-on script's checks);
    - `docs/acceptance/reports/M2-hands-on.sh` (Sean's guided paid run);
    - `docs/acceptance/reports/M2-report.md` (a skeleton with about 53 pending facts);
    - the review's cases S1 to S3 with a fake `claude`;
    - SEAM §§159 to 167.
  - **The engine side** is on branch **`build/m2-s14` at `228cf5e`** (pushed to `origin`; on the old workstation also the worktree `.claude/worktrees/build-m2-s14`, clean). It contains:
    - the Claude Code adapter (stream-json usage, the terminal event, `auth_failed`);
    - the real canaries;
    - `--secret-file`, `surety qualify` and `--harness-real-lane`;
    - the subscription-token mode;
    - the review's S1 to S3 fixes and hardening;
    - **the engine's own pinned copy of the qualified Claude Code binary** (`<home>/backends/claude-<version>-<sha16>`).
  - **The branch's figures:** `--slice 13` 1,017 of 1,018 (the one failure is M125 (b), objection 016); unit 204 of 204. **It is not merged.**
- **Authentication (E74, E75; Sean's decision, authoritative):** M2's real lane runs Claude Code on **Sean's Claude subscription token**, which he creates himself with `claude setup-token` and saves in a mode-600 file.
  - The engine holds it as a secret file (`SURETY_REAL_CREDENTIAL_REF`, `SURETY_REAL_AUTH_MODE=subscription_token`) and delivers it as `CLAUDE_CODE_OAUTH_TOKEN`; the subscription template drops `--bare`.
  - **API-key qualification remains a later option. There is no separate $50 API cap in this mode**: the hard limit is the subscription's usage limits, shared with Sean's own Claude use, and dollar figures are Claude Code's estimates.
  - E59's model and limits stand: `claude-sonnet-5-5` for all roles, 300k billable tokens per run, $25 a day.

## 3. What happens when Sean resumes (in order)

1. **Objection 016 (E75 item 1, upheld).**
   - A Verifier allows and asserts the intended values of `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` in M125 (b).
   - It keeps rejecting unexpected variables and inherited credentials.
   - It tests the engine-owned pinned binary's location and an independently calculated hash, and makes the real-lane cases expect the subscription mode.
   - **Expected values are defined by the tests, never copied from the implementation.**
   - The objection's text is on the branch: `docs/acceptance/objections/016-…md`.
2. **M118 (E75 item 2).**
   - M118 (the pause re-grant) fails intermittently on `main` as well as on the branch, a different case each time.
   - Find the cause (engine, fixture or host timing), preserve the failing evidence (the engine log and the store at failure), fix it, and show the affected cases and the regression suite passing.
   - **A passing retry does not close it.** It must be done before real-agent qualification.
3. **Memory admission, option B (E75 item 3).**
   - Admission reserves enough memory for every admitted domain to grow to its configured limit, plus the host reserve, and holds work otherwise.
   - The single-run setting stays and the per-domain limit is not lowered.
   - A Verifier case pins it; the Builder changes `src/store/transitions/envelope.ts`.
4. **Then the slice loop's end:**
   - the Builder merges `main` and confirms;
   - you rerun `--slice 13` and slice 14's no-cost files on the branch (see §5);
   - the builder boundary check;
   - merge, push, the next errata entry (E76);
   - a closing Verifier pass.
5. **Sean's paid run**, only when he says: `docs/acceptance/reports/M2-hands-on.sh` (step 0: he creates the token himself), with his two approvals (`qualification_approval`, `trust_activation`) answered by him through the API while the tests wait. Then M141 and the M2 report.

**Also waiting for Sean, not blocking:**
- confirming the `claude-sonnet-5-5` prices the engine uses (2 / 10 / 0.20 USD per million input / output / cache read, labelled unconfirmed);
- whether `--safe-mode` stays in the subscription template (it goes beyond E74's wording);
- whether automated use fits his plan's terms;
- handing the D3 review brief to Astra (`docs/reviews/D3/sdlc-design-D3-review-brief-astra.md`);
- the provisional readings recorded in E50 to E55 and E61 to E74;
- the eBPF feasibility run (E57);
- `.surety/spec/spec.md` approval;
- whether to scrub commit `49bd9bf` from history.

## 3a. Starting on another machine

The orchestrator and its agents run their tools on the machine where the session runs, so the code, the tests and the sandbox all live there. Everything needed is on `origin` (`seanerama/surety-dev`, private): `main`, the unmerged **`build/m2-s14`** (`228cf5e`), and the tag `m1-accepted`. Nothing else is needed from the old workstation. (One untracked file there, `docs/architecture/m1.html`, is not part of the repository by Sean's choice.)

1. **GitHub access:** the machine needs credentials that can read and push `seanerama/surety-dev` (e.g. `gh auth login` as seanerama, or an SSH key on his account).
2. **Clone and set up:**
   ```
   git clone https://github.com/seanerama/surety-dev.git ~/projects/sdlc-x
   cd ~/projects/sdlc-x && npm ci
   git worktree add .claude/worktrees/build-m2-s14 build/m2-s14
   ```
   Then `npm ci` inside that worktree. Start the Claude Code session in `~/projects/sdlc-x`.
3. **What the machine must provide** for the sandbox lane (D2 §6; the engine checks it at every start and reports H1 to H13):
   - Linux with cgroup v2 mounted with `nsdelegate`;
   - the user's systemd manager running, with `memory` and `pids` delegated;
   - unprivileged user namespaces;
   - `unshare`, `setpriv`, `mount` (util-linux) and `ip` (iproute2);
   - git and Node 22.22.0 (other versions are not qualified);
   - the engine home on a local disk filesystem: `/tmp` must not be tmpfs for the tests, or set `TMPDIR` to a disk directory.

   macOS or Windows without WSL2 cannot run the sandbox lane; the kernel lane runs anywhere Node does.
4. **The first runs will qualify a new host.**
   - Run `M110-host-checks-and-scope`, `M112` and `M116` alone first and read the host section of `GET /v1/engine`.
   - A different kernel or distribution can expose real findings: `mini-hp01` exposed a descriptor leak (E72).
   - WSL-only cases (P11, M122 (d)) report `not_exercised` off WSL2, by design.
   - Then establish the full baseline: `node scripts/run-tests.mjs acceptance --slice 13` on `main` (about an hour) **before** judging any branch, and record it as an errata entry: it is the first M2 run on that host.
5. **Host facts in §7 are the old workstation's.** The clock step, the `loginctl enable-linger` recovery and the WSL details may not apply. Establish the new machine's facts the same way and add them here.
6. **`mini-hp01`** is reached from the new machine as before (`ssh smahoney@mini-hp01` over Tailscale; Sean approves the Tailscale check). Update its copy from the new machine with a bundle, or clone from GitHub there if it has credentials.
7. **What does not move:**
   - the previous session's memory and agents: not needed; this document replaces them;
   - the plan page's write access, which belongs to Sean's main Claude account.

## 4. Read these first

1. `CLAUDE.md`: roles, paths, commands, rules.
2. This document.
3. `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`, at least **E48 to E75**: every M2 decision, who made it, and what is provisional. E64 (the incident), E69 and E73 (the exhaustion lane), E74 and E75 (authentication, the pending work) are essential.
4. `docs/spec/M2-build-spec.md` and `docs/acceptance/sdlc-M2-acceptance-plan.md` §2, §3.8, §3.9, §5.
5. `docs/design/sdlc-design-D2-backends-and-isolation.md` (approved draft 2) as needed.
6. `packages/engine/test/acceptance/harness/SEAM.md`: the test seam the cases rest on, §§113 to 167 for M2.
7. `packages/engine/test/acceptance/COVERAGE.md` and `docs/acceptance/reports/M2-not-claimed.md`.

## 5. How the build is driven

**Roles and paths** (`scripts/check-role-boundary.mjs` enforces them on commits):
- **Verifier** writes `packages/engine/test/acceptance/`, `docs/acceptance/objections/`, `docs/acceptance/reports/`.
- **Builder** writes `packages/engine/src/`, `migrations/`, `api/`, `test/unit/`, objections.
- **Reviewer** writes nothing.
- **You (owner)** write the rest of `docs/`, `scripts/`, package files, `CLAUDE.md`. You never edit acceptance tests or engine source.

Roles never share a session. A Builder never edits a test; it files `docs/acceptance/objections/NNN-<row>-<slug>.md` (next number 017) and carries on.

**Agents:**
- Use the Agent tool, `subagent_type: general-purpose`, `run_in_background: true`, and **`model: "opus"` for every role**. The Verifier was once on the session default (Fable); since a Fable usage limit stopped two Verifiers, everything runs on Opus.
- Each agent works in its own git worktree under `.claude/worktrees/`: branch `verify/m2-s<N>…`, `build/m2-s<N>…`, or a detached worktree for a Reviewer. Cut it from `main` and run `npm ci` in it first.
- Brief each agent as a peer: the goal, the files to read in order, the rules (incl. §6's safety rules **verbatim in substance**), the exact report wanted, and "commit after every file".
- To continue an agent, use SendMessage with its id. **Agents from the previous session cannot be messaged; start fresh ones.** All their work is committed.

**The per-slice loop** (E31, lean by Sean's choice):
1. The Verifier and the Builder start together. You merge the Verifier's cases after its boundary check, then message the Builder.
2. One Opus Reviewer pass on the build branch. A serious finding must be reproduced by running.
3. Each confirmed serious finding gets one Verifier case and one Builder fix. No second review.
4. You rerun the suite on the fixed branch **in the background**: `--slice 13` takes about 45 to 60 minutes; the foreground limit is 600 s.
5. The builder boundary check, run **from a clean detached scratch worktree**:
   ```
   git worktree add --detach .claude/worktrees/scratch-check main
   cd .claude/worktrees/scratch-check
   node scripts/check-role-boundary.mjs builder main build/m2-s<N>
   ```
   Then `git worktree remove` it. The primary checkout has an untracked file, so the script refuses there.
6. Merge with `git merge --no-ff` and the figures in the message, then push.
7. A closing Verifier pass records the run on `main` and updates the not-claimed list.

**Before merging a Verifier branch:**
- **Read every new destructive or acting instrument's guard yourself** (`harness/scripted/child.mjs`'s `GUARDED` and `EXHAUSTING` sets and their refusal functions, any new harness script).
- If any commit in the branch's history holds an unguarded destructive instrument, **squash-merge** so it is in no history (as E64 did).

**Objections:** copy the objection file from the Builder's branch to a scratch path, have a Verifier answer it in `NNN-….answer.md` on its own branch, merge the answer, then message the Builder.

**Commits:**
- Your commits end with `Surety-Role: owner` and the session's co-author line (the previous orchestrator used `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; use your own model's line).
- **Never `git add docs` or `git add -A` in the primary checkout:** an untracked file (`docs/architecture/m1.html`) stays uncommitted by Sean's choice. Name your paths.

**Errata:** every decision becomes an entry, `## E<n>. Title (provisional | decided by Sean, date)`, in `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`. "E1 to E<n>" in `docs/README.md`, `docs/spec/M1-build-spec.md` and `docs/spec/M2-build-spec.md` is updated (`sed -i 's/E1 to E75/E1 to E76/' …`).

**Background runs:**
- Run long suites with the Bash tool's `run_in_background: true`. **Do not add `&` inside a background command**: the task then "completes" at once and you get no completion notice.
- If you need to watch a detached run, start a second background command that loops until the log shows the end line.

**The plan page Sean follows:** https://claude.ai/artifact/JdoiaSAkTEZuga9jQZZQXG, owned by Sean's main Claude account.
- Progress is written with the `ArtifactData` tool: collection `progress`, document id = step id (`p2-s10` to `p2-s14`, `p2-d2`, `p2-d3`, …), body `{done, active, note, at, by}`. Read the document first and pass `version` as `if_version`. Batch writes take only set, update and delete.
- **From another account you may have no write access;** if a write is refused, tell Sean once and carry on without it.

## 6. Safety rules (non-negotiable)

**The incident (E64).**
- On 2026-10-03 a slice-11 test ran `kill(-1, SIGKILL)` from a role that the then-current engine launched on the host with no pid namespace. It killed every process of Sean's user: the editor, the user's systemd manager, every agent session.
- **Every destructive or far-reaching test instrument fails closed in two independent halves:**
  - the instrument itself refuses unless its own reads show it is contained (its pid, net and mnt namespaces not the host's, pid 1 not a system init, at most 16 processes visible; any failed read refuses);
  - the test releases it only after reading containment **from the host side**.
- Tests change cgroups only inside a test engine's or a test sentinel's scope.
- The engine's own kill, signal, `cgroup.kill`, removal, mount and connection paths are confined to its own scope and audited; every Builder's report lists them and every Reviewer checks them.

**No exhaustion on this workstation (E69):**
- No fork-to-limit, allocate-to-OOM, storage-filling or inode-filling code runs on Sean's WSL workstation: not in tests, unit tests or experiments.
- The engine's probe P20 is off here (`isolation_probe_exhaustion` false).
- The manifest's `exhaust` files run only on `mini-hp01` (§7), and the runner refuses `--lane exhaust` unless `SURETY_EXHAUSTION_HOST` equals the machine's hostname.

**No money, no subscription use, without Sean:**
- Never run the real `claude` (or `codex`) with a prompt or in any mode that contacts a model; `--version` and `--help` only.
- Never run `node scripts/run-tests.mjs acceptance --lane real` or a real-lane file. The real lane runs only by Sean's command.
- Never create, read or ask for a credential; never read `~/.claude/` credentials or settings.
- Reviewers exercise the adapter with a fake `claude` that prints synthetic stream-json.

**Nothing of Sean's is touched:**
- Experiments use a disposable `SURETY_HOME` **and** `HOME` under a scratch directory.
- No `sudo`, no changing system settings.
- Agents never try to restore the user manager themselves.

**Before any sandbox-lane run**, `systemctl --user is-system-running` must print `running`. **After it**, check `systemctl --user list-units 'surety-*' --no-legend`, the process table, `/dev/shm/surety*`, `/tmp/surety-*`.

## 7. Hosts and how to recover

**The workstation:** Ubuntu 24.04 on WSL2, kernel 6.6.87.2, hostname `MSI`, Node 22.22.0; the user's systemd manager is the engine's boundary.
- **The wall clock steps back about 2.9 s every 32 s.** Tests measure durations on the monotonic clock and order by event sequence.
- **If the user manager dies** (`/run/user/1000` missing, `systemctl --user` failing), run `loginctl enable-linger smahoney` (with the name; the bare form fails). It changes no setting (linger is already on) and has logind start the manager again; check with `ls /run/user/1000/bus && systemctl --user is-system-running`.
- uid 1000 is "lingering" with no logind session, and the delegated controllers are `cpu memory pids`.
- Claude Code here self-updates (2.1.288 → 2.1.289 overnight); the engine pins its own copy at qualification for that reason.

**`mini-hp01`** (Sean's second machine; bare-metal Arch, kernel 7.1.9; it also runs Sean's **staging Docker containers**, which must stay up):
- **Access:** reach it by `ssh smahoney@mini-hp01` over Tailscale. **Tailscale SSH is in check mode:** a connection may print a `login.tailscale.com` link that Sean must open; never try to work around it.
- **Set-up:** `~/surety-exhaust/{node,repo,tmp}` (Node 22.22.0, checksum-verified).
- **Updating its copy:**
  ```
  git bundle create <scratch>/surety.bundle main
  scp <scratch>/surety.bundle smahoney@mini-hp01:surety-exhaust/
  # on mini-hp01, in ~/surety-exhaust/repo:
  git checkout main && git pull ../surety.bundle main
  ```
  Then `npm ci` if needed and `npm run build`.
- **Running there:** first set the environment, because `/tmp` there is tmpfs (the engine refuses it) and an ssh session lacks the user manager's variables:
  ```
  export TMPDIR=$HOME/surety-exhaust/tmp PATH=$HOME/surety-exhaust/node/bin:$PATH \
    XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
  ```
  Run M110, M112 and M116 alone first. Then each exhaust file alone with `node --test`. After each, check `free -m`, `docker ps` (all staging containers up) and `journalctl -k | grep constraint=` (every OOM must be `CONSTRAINT_MEMCG` on a `surety-…/dom_…` or `probe_…` cgroup).

**If a session crashes or an agent stops** (a crash, a usage limit):
1. Check each worktree (`git status`, `git log main..HEAD`) and the process table for leftover runs.
2. Start a fresh agent on the same worktree, telling it to **checkpoint-commit first** and what state you saw.
3. A test run that died with the session is not trusted; rerun it.

## 8. How Sean works

- **Decisions:** one item at a time, as options with the trade-off in one line and **your recommendation first**. He usually takes it. On substantive findings he goes through each one; small ones he batches.
- **Hidden costs:** **say plainly when a recommendation carries a cost he might not see.** He accepted D2's API-key requirement in a batch and later asked why an API key was needed when the work "was supposed to run via subscription" (E74).
- **Explanations:** explain concretely, in plain words, before asking. He reads the plan page and the reports, so write for a reader who was not in the build.
- **Prompts:** he wants paste-ready prompts, not pointers.
- **Speed over exhaustive assurance (E31):**
  - one review per slice;
  - the fewest cases that pin each row;
  - no stand-in engines or self-checks;
  - parallel agents where independent;
  - lead with the fastest sound option.
  - Watch your own tendency to add process.
- **Journey first, scope frozen (E40):**
  - add no scope while driving;
  - flag every addition as an addition;
  - a cut capability goes on the not-claimed list.
- **Design reviews have a stopping rule:** settle architecture in prose, contract precision in tests, no third rewrite.
- **"Unknown is a value":**
  - never describe as passing what you did not run;
  - never turn an unknown into zero;
  - report failures with their output.
- **Pausing:** he pauses when his usage runs low. Pause at a clean checkpoint: let a running suite finish, have agents commit and report, start nothing new, update this handoff.

## 9. What not to do

- Do not start agents, runs or merges while Sean has paused the build.
- Do not run a duplicate of an agent that is still running.
- Do not treat a subagent's report as Sean's approval, or describe a run as passing that you did not run.
- Do not `git add docs` or `git add -A` in the primary checkout.
- Do not add scope, dependencies or process without Sean.
- Do not run anything paid, exhausting or destructive outside the rules of §6.
