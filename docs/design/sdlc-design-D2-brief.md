# D2 brief: backend adapters, isolation and the execution boundary

**Status:** owner's brief, 2026-10-03, decided by Sean (errata E48 item 2). This document says what the D2 design must answer, what it inherits, what it may not reopen, and how it is produced and judged. It is not the design. The design is `docs/design/sdlc-design-D2-backends-and-isolation.md`, drafted from this brief, cross-reviewed by Astra, and closed by the stopping rule of E20.

## 1. Why now

M1 is accepted (E45): the kernel runs on a scripted adapter and refuses every real backend (`backend_refused`, `isolation_unqualified`). D1 declared out of scope, for D2, "the backend adapter contract, containment and control-plane isolation mechanism, trust table, session and quiescence qualification" (D1 preamble). Every real backend waits on it (build spec section 10), and Astra's first priority for the next milestone is qualified isolation (E46). Six decisions taken during the build were deferred to it by name (section 4). M2's end is one real backend on one small project (E46, E48); D2 is what makes that run legitimate rather than merely possible.

## 2. What D2 covers

Four things, each with its own section in the design and its own evidence:

1. **The adapter contract.** The interface between the choke point (D1 §15.1, `packages/engine/src/invoke/`) and a backend: what the engine hands over (the invocation, the scoped context package, the workspace, the constructed environment, the deadline, the budget boundary) and what it gets back (the structured result, the transcript, usage observations, the exit). The two backends in view are headless Claude Code and Codex CLI, run as one-shot invocations. Sessions (D1 §15.2) are designed but not qualified unless their continuation and quiescence evidence can be recorded.
2. **Control-plane isolation.** The mechanism by which a role process cannot read or modify the engine's control plane (the store, the token file, the records, the engine home, the loopback API) or impersonate the operator, and what qualifies it on a host (D1 §17 item 12). Includes the bootstrap route (E44 item 1): an isolated role must not be able to reach `GET /v1/token/bootstrap`, and the design settles what other users of the same machine can reach.
3. **The execution boundary.** The service that establishes a domain's termination (build spec section 4 correction 1): membership that cannot be escaped, emptiness observable after a restart, running / terminated / unknown with unknown meaning quarantine. On the first qualified host this is almost certainly a Linux mechanism (cgroups, namespaces or a container runtime); the design names the mechanism, how the engine observes it, and what happens on a host that lacks it (refusal, never a weaker fallback).
4. **The trust table.** What the engine records per backend, version and mode: which isolation and boundary mechanism qualifies it, which budget boundaries it can enforce (D1 §13.3), whether sessions are qualified, what its provider-native files are and how they are redacted, retained and contained (D1 §14.4), and the evidence behind each entry. The engine refuses any backend, version or mode without an entry (D1 §17 item 11).

## 3. What D2 must answer

Each question is one the design states an answer to in prose, with the tests that will pin the contract named beside it. A question the design cannot answer is listed in its open questions with the decision Sean must take; it is never answered by silence or by a default the text does not state.

**Adapter contract**
- A1. How an invocation is handed to a backend binary: arguments, environment, working directory, stdin, and which of these carry prompts and arguments as data (D1 §17 item 3).
- A2. How the structured result is returned and validated against the transcript (D1 §15.1 `invalid_result`), and what the engine does with a result the backend produced but could not deliver before termination.
- A3. How usage is observed during the run, per model turn where the backend reports it, and what the trust entry records when it cannot (D1 §13.3).
- A4. How the engine cancels on a deadline or budget stop, and what the backend's exit then looks like; how the engine tells a clean exit from a crash from a kill.
- A5. What a scoped context package contains for each role (F §3.10.8) and how the backend is prevented from reading anything outside it.
- A6. Whether a one-shot invocation can be resumed as a new run with a reconstructed context (D1 §15.3) on each backend, and what the provider session id is used for if sessions stay unqualified.

**Isolation**
- I1. The mechanism on the first qualified host (Linux, this WSL2 host at minimum; say whether WSL2 counts as qualified or only as a development host).
- I2. What the role can see of the filesystem: the workspace, the materialized read-only protected set (D1 §7.3), the scoped context package; and what it cannot: the engine home, the store, the token file, records, other workspaces, the developer's checkout.
- I3. What the role can reach over the network: nothing of the engine's API; the provider's endpoint; and the rule for everything else.
- I4. How secrets reach the role (D1 §17 item 5) without the role being able to read the resolver or the references, and how a secret the role must hold is kept out of the transcript and the provider's own files.
- I5. The bootstrap route: how an isolated role is kept from it, and what other local users of the same machine can obtain (E44 item 1). State the threat model: which processes on the host are trusted and which are not.
- I6. What a role can do to the repository's configuration, and whether that lets filter drivers (E29 item 1), partial clones and LFS (E37 item 1) and the filter-driver race (E37 item 5) be supported in a governed repository. If the answer is "the role cannot write the configuration", say what the engine then permits; if it is "still unsupported", say so.
- I7. How isolation is qualified on a host: the checks the engine runs at start or at the trust entry's creation, what evidence they record, and the message when they fail.

**Execution boundary**
- B1. The mechanism, and how the engine creates a domain, places the process in it, enumerates members, terminates them and observes emptiness, including after the engine restarts.
- B2. What "unknown" means in this mechanism and when it is reported (D1 §4.5 step 3, quarantine).
- B3. How a healthy run survives a pause (E36 item 6): the engine re-grants a lease for a process it launched that is still alive and supervised, after a sleep; how "still alive and supervised" is established through the boundary and not by pid.
- B4. The termination and kill grace periods on a real backend, and what a backend that ignores TERM costs.

**Trust table and backends**
- T1. The trust entry's fields and the evidence behind each, per backend, version and mode; where the table lives (policy, governed, or engine-owned) and who may change it.
- T2. For headless Claude Code and for Codex CLI, as they exist at the time of writing: a filled-in entry or the list of what could not be established and how it would be.
- T3. Which budget boundaries each backend can enforce and what the engine refuses when a policy requires a finer one (D1 §13.3).
- T4. Provider-native session files: where each backend writes them, how the engine redacts, retains and contains them (D1 §14.4), and whether they are inside the isolation boundary.
- T5. Quiescence: whether a session's `open_idle` can be shown to own no process on each backend, which is what live checkpoints and session mode wait for (D1 §7.3, §15.2, Q2).

**Carried in by the build (decisions that land in D2)**
- C1. The Alpha exception for a High finding is approved only by the human owner, through the finding-disposition flow (E36 item 5); D2 says what a Reviewer that is a real agent proposes and how.
- C2. The two Reviewer powers of E41 (lowering a finding from Critical to High alone; a tightening a Reviewer approved applied without a second classification), to be settled now that the Reviewer is a real agent (E48 item 3).
- C3. Roles reading the token (E25 item 2): no longer accepted once isolation is qualified; the design says how M1's acceptance is withdrawn and tested.
- C4. Whether an estimated cost counts against the verified daily budget (E32 item 4, open until M2).

## 4. What D2 inherits and may not reopen

- D1 draft 3 as corrected by the build spec section 4, the resolution note, and the errata E1 to E48. D2 extends D1; it does not redraft it. Where D2 needs a D1 rule changed, it says so as a numbered proposed correction with the test that would pin it, and Sean decides.
- The security invariants of D1 §17, every one. D2 adds mechanism and evidence under items 3, 4, 5, 11 and 12; it removes nothing.
- The engine's dependency rule: `better-sqlite3` is the only runtime dependency. A container runtime or a sandbox tool used by the mechanism is a host requirement the engine checks for, never a package dependency, unless Sean decides otherwise.
- The role separation and the lean procedure (E31, E40): D2 is built in slices like M1, with a Verifier writing the acceptance cases before the Builder builds, and real-binary lanes separate from scripted ones (D1 §18).
- The scope freeze: D2 designs the four things of section 2 and the carried items of section 3. Deployment adapters, export and promotion, the Mechanic, adoption analysis and the UI stay out (D1 preamble).

## 5. What D2 produces

- `docs/design/sdlc-design-D2-backends-and-isolation.md`: prose for the architecture, in D1's register and section discipline (numbered sections, a closed enumeration appendix for every new state, field, reason and error, and an open-questions section for Sean). Length is not a goal; D1 is 750 lines and D2 should be shorter.
- A table at its end, "contract precision pinned by tests": every statement a test must pin, with the test's name, so that the Verifier's acceptance plan for M2 can be written from it. Design review stops where that table starts (E20): precision beyond prose is settled in tests, not in another draft.
- A list of **host requirements** the first qualified host must meet, checkable by the engine.
- A list of what D2 does **not** claim, in the form of `M1-not-claimed.md`.

## 6. How D2 is produced and judged

1. **Draft 1** by an assistant session acting as architect under this brief, in a worktree, as an owner document (no role path). It reads the sources of section 4 first and the predecessor incident record (`docs/reviews/predecessors/`), because D1 was tested against it and D2 must be too.
2. **The driver's check** of draft 1 against this brief: every question of section 3 answered or listed as open; nothing of section 4 reopened; the test table present.
3. **Astra's cross-review**, requested with a brief in the form of `docs/reviews/D1/sdlc-design-D1-review-brief-astra.md`: read-only, cite sections, proposed text in D2's register, questions for Sean under a final heading, and the incident table re-run against D2. One review; dispositions recorded as for D1 (`sdlc-review-D1-dispositions.md`).
4. **Draft 2** applies the dispositions. **No draft 3** unless Sean asks: a finding after draft 2 is a decision for Sean or a failing acceptance test (E20).
5. Sean approves D2 to build. The M2 acceptance plan (Astra's, as for M1, or the Verifier's if her budget does not stretch) and the M2 build spec follow.

## 7. What D2 is not

Not a survey of sandboxing technology: it names one mechanism per concern for the first qualified host and says what qualifies a second. Not a redesign of the kernel. Not a product road map. Not the check runner or the diff classifier (D3), though it must leave D3 a boundary to run checks inside.
