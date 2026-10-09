# Surety M2 build specification

**Status:** in force from 2026-10-03 (E59), with the M2 acceptance plan adopted the same day. **Owner:** Sean. **Changes:** by the owner only.
**Readers:** the sessions that verify, build and review M2, and Sean.

M1 built the kernel on a scripted stand-in for a coding agent (`docs/spec/M1-build-spec.md`; accepted, E45). M2 slices 1 and 2 closed the kernel's known gaps (E50 to E55). M2 proper, this document, makes the engine run **one real coding agent on one small project**, inside isolation the host qualifies and the engine observes. Everything the M1 spec fixes about roles, constraints and procedure stays in force; this document says only what M2 adds or changes.

Read sections 1 to 5 before doing anything. Sections 6 to 10 are reference for the slice you are working on.

---

## 1. What M2 is

M2 is the engine running **Claude Code in one-shot headless mode** as a real backend, on this WSL2 host, under D2: a namespace sandbox the engine builds without privilege, a cgroup execution boundary delegated by the user's systemd, a trust table written only by qualification attempts the owner approves, and an egress proxy that reaches the provider and nothing else. M2 has no sessions, no deployment, no publication and no user interface; Codex is designed (D2 §4.6) and may be qualified if cheap, but M2's end does not need it.

M2 is accepted when: `npm test` exits zero on `main` for the kernel and sandbox lanes, which requires every M2 acceptance row to have executable tests and none skipped; the real lane's rows (the three canaries and the real-backend journey) have passed under a qualification attempt Sean approved, with their records retained; the host qualification and the trust entry for Claude Code are `active` with their evidence; and the M2 acceptance report is written (section 10). Nothing less is acceptance.

Accepting M2 supports one claim: on this host, with the recorded versions and limits, the engine ran one real backend through the complete journey (plan, build, verification, review, the stage gate and an issued Alpha authorization) with the engine making every commit, the backend unable to reach the control plane, every process it started observed gone, and its usage recorded as the provider reported it. It does not support the claims that any other host, backend, version or mode is qualified, that sessions work, or that Surety can deploy anything.

## 2. Sources and which one wins

The M1 spec's table (its section 2) stands, with these added. Where sources disagree, the later decision wins: the errata over D2, D2 over D1, the adopted M2 acceptance plan over both for what a row requires, and the merged tests over the plan for contract detail (E20).

| Short name | Document | What it is |
|---|---|---|
| **D2** | `docs/design/sdlc-design-D2-backends-and-isolation.md` | Draft 2, approved to build (E58): the adapter contract, isolation, the boundary, the trust table, qualification; ten corrections to D1 (K1 to K10); Appendix B's 73 test statements in three lanes. |
| **D2 brief** | `docs/design/sdlc-design-D2-brief.md` | What D2 had to answer; the inheritance rules. |
| **Review** | `docs/reviews/D2/sdlc-review-D2-Astra.md` with `sdlc-review-D2-dispositions.md` | Astra's cross-review and Sean's dispositions (E56). Her section 8 says what each probe and statement must not let through; draft 2 applied it. |
| **Observer** | `docs/design/sdlc-design-D2-ebpf-note.md` | The optional eBPF execution observer, a qualification-only prototype (E57). |
| **M2 plan** | `docs/acceptance/sdlc-M2-acceptance-plan.md` | The M2 acceptance matrix: 42 rows M101 to M142 with 210 named cases, derived by a Verifier from D2 Appendix B and the real-backend journey; adopted 2026-10-03 (E59). |
| **E** | the errata, E48 to E58 | M2's opening, the two slices, the review dispositions, the D2 approval with the architect's variants. |
| **SEAM** | `packages/engine/test/acceptance/harness/SEAM.md` | The test contract as it stands (§§1 to 112); M2 extends it. |

## 3. Scope

**In M2:**

- The three parts of the adapter contract (D2 §1): the launcher, the domain init and the per-backend adapter, with the scripted backend as one more adapter.
- The sandbox (D2 §2): the validated mount plan, the enumerated `/etc`, the engine-constructed git metadata view, the volatile filesystem per domain, the egress proxy with address binding, the secret screen, the bootstrap route off by default (K3).
- The execution boundary (D2 §3): the incarnation scope, launch authorization and closure, termination with closure and emptiness, recovery that closes before it trusts absence, the fresh challenge after a pause, the resource envelope, the `role` and `probe` profiles.
- The trust table and qualification (D2 §4, §7): host qualification at every start, qualification attempts with the owner's approval, the three canaries, `trust_activation`, lapse and revocation, the separate reporting and enforcement of budget boundaries, retained partial usage, the unknown allowance (C4).
- The carried decisions C1 to C3 (D2 §5): the Alpha exception proposal, the Reviewer's restricted powers (K7, K8), the withdrawal of the token-reading acceptance.
- The isolation probe suite (D2 A.6), twenty probes with seeded targets and controls.
- The Claude Code adapter and template (D2 §4.5) qualified on this host; the Codex adapter (D2 §4.6) built behind the same contract and qualified only if its attempt is cheap, otherwise left `proposed`-less.
- The optional execution observer (D2 §3.9), as a qualification aid, after Sean's feasibility run.
- The real-backend journey: plan row M01's journey with the real backend in place of the scripted adapter, both paths (`.surety/spec/spec.md` R12).
- The K3 change to the accepted M1 bootstrap case, by the Verifier.
- The M2 acceptance report and the hands-on walkthrough Sean runs.

**Not in M2** (each refused by the engine, with a test that it is):

- Sessions (`session_headless` never `active`; D2 §1.8).
- Any backend, version, mode or host without an active entry and a current host qualification.
- Deployment, publication, the UI and its bootstrap (Q6), the Mechanic, adoption.
- D3's check runner and diff classifier; D2 §3.8 leaves them the `check` profile.
- Filter drivers, Git LFS, partial clones, repositories with alternates (Q4, E58 item 3).
- Credential injection by the proxy (Q2), BPF-based enforcement or production monitoring (E57), a hard spending maximum enforced by the engine (`hard_cap_unenforceable`).
- Bucket C of the triage (`docs/spec/M2-input-triage.md`), unchanged.

## 4. Roles and how work moves

The M1 spec's section 4 stands: the same three roles with the same paths, Sean the owner, the lean procedure of E31 and E40, objections as before. M2 adds:

- **Three lanes** (D2 Appendix B). `kernel`: runs as M1's tests do, on the scripted adapter and boundary; `sandbox`: the scripted backend inside the real sandbox and boundary, no model and no network beyond the proxy; `real`: a real backend binary against a model, paid. The manifest marks each file's lane. `node scripts/run-tests.mjs acceptance` runs the kernel and sandbox lanes; the real lane runs only through a qualification attempt (`surety qualify`) that Sean approves, never by the test runner alone.
- **Who may run the real lane.** Only Sean, through the attempt's approval. A Verifier writes the real-lane cases and runs them against a scripted stand-in for the attempt; a Builder never runs a real backend; the driver reruns the kernel and sandbox lanes before every merge as before and reports the real lane's records as Sean produced them.
- **The Reviewer's rule** (E31) stands: anything called serious is reproduced by running the engine. In the sandbox lane that includes running the sandbox itself; a Reviewer may run the probe suite and scratch sandboxes, never a model.
- **Host steps are Sean's:** the eBPF loader's privilege (E57), the dedicated API key and its provider-side cap (Q1, Q2), and whatever a host check reports as a remedy. A session reports the need and waits.

## 5. Fixed technical constraints

The M1 spec's section 5 stands, with these added or sharpened:

- **Dependencies:** unchanged; `better-sqlite3` is the engine's only runtime dependency. `unshare`, `setpriv`, `ip` (H6), the user's systemd (H3) and the observer's loader (H13) are host requirements the engine checks for and reports, never packages.
- **No privilege:** the engine, the launcher and the domain init run as uid 1000 without capabilities on the host; the sandbox is built in unprivileged namespaces (D2 §2.2). Nothing in `src/` calls `sudo` or expects root. The observer's loader is the one privileged component and lives outside the engine's process tree (D2 §3.9).
- **Backend spawns** happen only inside `packages/engine/src/invoke/` (D1 §15.4), through the launcher; a repository lint enforces it.
- **Volatile storage:** every location a role can write is one bounded tmpfs per domain charged to the domain's memory with swap excluded (D2 §2.3, E58 item 1); the engine home stays on a permitted disk filesystem (E36 item 7).
- **Egress:** `CONNECT` to port 443 on allow-listed names only, through the engine's proxy; no TLS termination (D2 §2.4).
- **Templates:** the Claude Code and Codex templates of D2 §4.5 and §4.6 are the adapters' fixed text; a change is a template version change and revokes entries (D2 §7.3).
- **Qualified versions:** those the trust entries record; the report names them. The host facts of E48 and D2's preamble (kernel 6.6.87.2, cgroup v2 with `nsdelegate`, user systemd, util-linux 2.39.3, Claude Code 2.1.288, Codex 0.159.2) are the starting point, not a qualification.

## 6. Design in force: D1 with its corrections, and D2

D1 draft 3 with the M1 spec's section 6 corrections stands. D2 draft 2 is in force as approved (E58), and its §9.1 corrections K1 to K10 apply to D1 with the variants Astra proposed and Sean accepted. The architect's variants recorded in E58 are part of the design. Where D2 says "the Verifier fixes it in the seam", the Verifier does, as in M1.

No further prose draft of D2 (E20, E48 item 2): a finding during the build is a decision for Sean recorded in the errata, or a failing acceptance test.

## 7. Repository layout

Additions to the M1 spec's section 7, under `packages/engine/`:

```
src/invoke/
  choke.ts                the choke point (unchanged role)
  launcher.ts             engine code spawned per invocation: placement, authorization, sandbox build, exec of the init
  domain-init.ts          process 1 of the sandbox: loopback, forwarder, control channel, backend start, signal relay, exit report
  sandbox/                the mount plan and its validation, the profiles (role, probe), the volatile filesystem, namespaces
  proxy/                  the egress proxy: allow list, resolution and address validation, limits, the egress log
  adapters/               scripted.ts, claude.ts, codex.ts: template rendering, stream parsing, collection
src/boundary/             the cgroup boundary: scope, domains, launch state, termination, observation, the resource envelope
src/trust/                trust entries, qualification attempts, host qualification, the canaries, lapse and revocation
src/testing/              the seam, extended for the sandbox lane (section 8)
test/acceptance/
  manifest.json           gains a lane per file
  harness/sandbox/        helpers for the sandbox lane: seeded targets, controls, the probe program, scope and cgroup reads
  harness/real/           helpers for the real lane: the attempt stand-in, record readers; never a model call
```

The Builder may arrange modules differently if the lint and the boundary script still hold; the names above are the starting point.

## 8. The test seam

The M1 seam stands for the kernel lane. M2 adds the sandbox lane, where the engine's real mechanisms are under test and the seam must not stand in for them:

- **In the sandbox lane the scripted backend runs inside the real sandbox and the real boundary.** The scripted adapter's child is the backend; the scripted execution boundary is not used. Barriers, the controlled clock and fault injection stay available (they are engine-side), and gain the launch boundaries of D2 §3.2 (before placement, before authorization, after authorization before exec) and the proxy's and collector's steps.
- **Probes** (D2 A.6) are a program the engine ships for the `probe` profile, driven by the test: each attempt against a target the test seeded and verified from the host side, with its control; results reported to the domain init over the channel it accepts only from that executable (D2 §7.2). A test never trusts a transcript for an attempt.
- **Reads the sandbox lane needs:** the domain's cgroup files (`cgroup.events`, `cgroup.procs`, the resource counters), the incarnation's scope, the mount table of a sandbox, the proxy's `egress_log`, the volatile filesystem's bounds; the Verifier fixes how a test reads each (through the API where D2 gives a read, through the filesystem otherwise) in the seam.
- **The real lane's stand-in:** a qualification attempt can be driven end to end with the scripted backend standing in for the real binary (the attempt's static checks against a scripted "binary", the three canaries scripted); this proves the attempt, the approval, the entry's writing and activation, lapse and revocation, without a model. The real canaries then run once under Sean's approval, and their records are the evidence the report cites.
- **Rules unchanged:** harness mode by startup flag only; outside it every seam call is a no-op and the scripted backend is refused; one module reaches the seam. **One rule sharpened:** no production configuration can select the scripted boundary (D2 §5 C3, `D2-C06`).
- **Limits of the instruments** the M2 report must state: the sandbox lane proves the mechanisms on this host and kernel, not on another; the real lane's evidence is the attempt's records at the recorded versions; the observer, if present, adds evidence and never a claim by its absence.

## 9. Slices

From the adopted M2 acceptance plan, section 5 (`docs/acceptance/sdlc-M2-acceptance-plan.md`). Manifest slices continue from the two merged M2 slices (8 and 9). Each slice follows the M1 procedure with the lanes of section 4: Verifier on `verify/m2-s<N>`, Builder on `build/m2-s<N>` started at the same time and messaged when the cases reach `main`, one Reviewer pass, the driver's rerun of `--slice <N>` and the unit suite before each merge.

| Slice | Rows | Lane | Needs on the host | After it the engine |
|---|---|---|---|---|
| 10 | M101 to M109 | kernel | nothing new | refuses every real backend without an active entry and a current host qualification; refuses a finer budget boundary than an entry enforces and any hard maximum; carries C1 to C4 (the Alpha exception proposal, the Reviewer's restricted powers, the withdrawal of the token acceptance, estimated and unknown cost); serves the bootstrap route only when `ui_bootstrap` is true (K3; the accepted M68 case opts in, a default-off case added); the store schema of D2 A.3; the M74 spawn lint allows the boundary's own helpers |
| 11 | M110 to M118 | sandbox | a login session of uid 1000 with the user manager running; `unshare`, `setpriv`, `ip` | runs in its incarnation scope; checks the host (H1 to H12) at every start and reports the result; allocates domains with a launch state, places and authorizes a launcher, closes before it observes termination, recovers by closing and observing prior supervisor leaves, quarantines on `unknown`, re-grants a lease after a pause only on a fresh challenge; the scripted backend runs inside the real sandbox for the first time |
| 12 | M119 to M128 | sandbox | as 11; `cmd.exe` as the WSL control | builds and validates the mount plan, the enumerated `/etc`, the git metadata view, the handover of the workspace; passes every probe P1 to P19 with its seeded target and control (H9 passes for the first time); runs the egress proxy with address binding, limits and the egress log |
| 13 | M129 to M135 | sandbox | as 11 | reads the result only after termination with closure and on a clean exit; classifies exits by precedence; retains partial usage; screens for secrets before materialization and publication; bounds the volatile filesystem and the envelope (P20); writes and revokes trust entries; runs a qualification attempt end to end with scripted canaries and witnessed containment, without a model |
| 14 | M136 to M142 | real, then report | a dedicated Anthropic API key with its provider-side cap; Sean's `qualification_approval` and `trust_activation`; Sean's hands-on run | runs the three canaries for Claude Code on `claude-sonnet-5-5` under one authorized attempt, activates the entry, completes the real-backend journey on both paths (a seeded defect for path two, a mixed run as the recorded fallback), and is reported |

**What a Builder can build before any real backend is touched:** everything in slices 10 to 13 and the engine side of 14 (template rendering against a stand-in binary, the qualification transitions, scripted canaries, the attempt's spend estimate, the entry's fields). Nothing in slices 10 to 13 spends money or needs a key. The first paid invocation is M136's positive canary. The optional observer cases (M112, M116, M124, M128, M135) are written with their rows and report `not_exercised` until Sean's feasibility run and H13 pass.

**Known straddles:** M107 (K3) edits an accepted M1 test's setup, recorded in `COVERAGE.md` as a K3 change; M110's host checks need a harness switch so that the kernel lane's engine starts (every M1 test) do not run the probe suite; the real lane's two decisions are answered by Sean through the API, with the test waiting, never by a fixture.

## 10. Done, and what comes after

M2 is accepted when section 1's conditions hold. **The M2 acceptance report** (`docs/acceptance/reports/M2-report.md`, by the Verifier) records: the test, contract and engine revisions; the host's identity, kernel, systemd and tool versions; the host qualification row and every check's observed value; the trust entry for Claude Code with its evidence fingerprint and what the canaries established (key delivery, usage events and granularity, terminal events, the tool surface, persistence despite the flags, exit statuses, TERM-to-exit); the sandbox-lane and kernel-lane suite results; the real-lane records; the real-backend journey's commits, ledger rows and Stop; the observer's status; the limits qualified; and what M2 does not claim, in the form of `M1-not-claimed.md`. A hands-on walkthrough (`M2-hands-on.sh`) takes Sean through one real run: the engine's commits, the role's inability to read the engine home, the ledger's provider-reported usage, Stop ending the real process before the run is called ended.

**Still closed after M2:** sessions and continuation (T5); a second host; Codex unless its attempt ran; D3's check runner and diff classifier, which M3 needs; deployment (M4); bucket C of the triage.

## 11. Known open items

| Item | Why it matters | When it bites |
|---|---|---|
| Sean's eBPF feasibility run (E57) | The observer rows are optional until a loader with privilege exists; a root-run `bpftrace` against the scripted engine shows whether event delivery works on this kernel | Before the observer slice; blocks nothing else |
| A dedicated Anthropic API key with a provider-side cap (Q1, Q2) | The real lane cannot run without it; the cap is the only hard maximum M2 has | Before the first qualification attempt |
| H12's `host_reserve_*` defaults | D2 leaves the values to the tests; the Verifier fixes them in the seam | The envelope slice |
| The M1 bootstrap case (row M68) opts in (K3) | An accepted test changes; the Verifier records it in `COVERAGE.md` as a K3 change, not a weakening | The first kernel-lane slice |
| Codex qualification | Designed, optional; one attempt if Sean approves its spend | After Claude Code's entry is active |
| Foundations v1.1 text | E1 to E119 still unmerged | Whenever convenient |

## 12. Starting a session

The driver briefs each session directly (E48 to E55 record how). The standing rule for a session that finds its prompt names no role: it assists Sean and does not edit `packages/engine/src/` or `packages/engine/test/acceptance/` unless he asks.
