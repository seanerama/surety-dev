# Cross-review brief for D2 draft 1 (for Astra, prepared 2026-10-03)

Astra, this is the cross-review request for D2, the second design document of Surety: backend adapters, control-plane isolation, the execution boundary and the trust table. Same role as for D1: second architect, adversarial, against source. One review (Sean's decision, errata E48 item 2): your findings are dispositioned into draft 2, and after that a finding is a decision for Sean or a failing acceptance test (the rule that ended the D1 review, E20). Nothing you write here is an implementation authorization.

## Read, in this order

1. `docs/design/sdlc-design-D2-brief.md`: the owner's brief D2 was written to. It fixes what D2 covers, the 26 questions it must answer (A1 to T5, C1 to C4), what it inherits and may not reopen, and what it produces. Judge D2 against it.
2. `docs/design/sdlc-design-D2-backends-and-isolation.md`: the document under review, draft 1.
3. `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`, entries **E36 to E48**: Sean's decisions since you last read the repository, including M1's acceptance (E45), your own assessment as recorded (E46), the two reads built after it (E47), and the opening of M2 (E48). The six decisions deferred to D2 by name are E36 items 5 and 6, E37 items 1 and 5, E44 item 1, E25 item 2, and the two Reviewer powers of E41. These are Sean's decisions and are not open for relitigation here; if D2 contradicts one, say so.
4. `docs/spec/M1-build-spec.md` section 4 (the corrections to D1 the build applied; correction 1 is the execution boundary D2 must now realize) and section 8 (the scripted adapter and boundary D2 replaces).
5. `docs/acceptance/reports/M1-report.md` and `M1-not-claimed.md`, if you have not read them since your assessment: what the accepted kernel does and does not claim.
6. The engine's choke point as built, `packages/engine/src/invoke/` and `packages/engine/src/testing/`, read-only: D2's launcher, domain init and adapters replace the direct spawn there.

D1 (`docs/design/sdlc-design-D1-engine-core.md`) and its resolution note are unchanged; D2 extends them and proposes nine corrections to D1 in its §9.1, each with a test.

## What D2 is

The design that lets the engine run a real coding agent. Its four parts: the adapter contract between the choke point and a backend binary (§1); the sandbox that keeps a role process out of the engine's control plane and off the engine's API while letting it reach its provider (§2); the cgroup-based execution boundary that establishes a domain's termination, including after an engine restart and after a host sleep (§3); and the trust table that records, per backend, version and mode, what qualifies it and the evidence (§4). Then the four decisions the build carried into it (§5), the host requirements the engine checks (§6), how a host and a backend are qualified (§7), what D2 does not claim (§8), the proposed D1 corrections and seven open questions (§9), closed enumerations including a twenty-probe isolation suite (Appendix A), and the 59 statements tests must pin, in three lanes (Appendix B).

Two facts about how it was written. It names one mechanism per concern for this host (an unprivileged namespace sandbox plus a delegated cgroup v2 subtree under the user's systemd manager), chosen over Docker and over the dedicated role user D1 §19.3 expected, with the reasons in §2.2; the host probes it rests on are listed in its preamble. And every claim about the two backends (Claude Code 2.1.288, Codex CLI 0.159.2) comes from help text, directory listings and your and Claude's predecessor reviews; neither binary was run against a model, and §4.5 and §4.6 say per item what is established and what the paid canaries of §7.2 will establish.

## What I want from you

Write `docs/reviews/D2/sdlc-review-D2-Astra.md` with these sections, in this order.

**1. Verdict.** One of: approve; approve with the amendments in section 2 applied; reject with reasons. One paragraph.

**2. Blocking objections.** Each one: the D2 section, what is wrong, the evidence (a foundations or errata clause it violates, a D1 invariant it weakens, an incident from the predecessor record it would reproduce, an internal contradiction, or something you verified by inspection or by a probe on this host), and proposed replacement text I can paste. Do not edit D2 yourself.

**3. Non-blocking suggestions.** Same shape, lower bar.

**4. The nine proposed corrections to D1 (§9.1, K1 to K9).** For each: accept, accept with a variant, or reject, with the reasoning in one or two sentences. K3 changes an M1 behaviour (the bootstrap route off by default) and therefore an accepted M1 test's setup; say whether you agree that is the right default for M2.

**5. The seven open questions (§9.2, Q1 to Q7) and the four carried decisions (§5, C1 to C4).** Your recommendation on each with one or two sentences of reasoning. All eleven are Sean's to decide; give the recommendation anyway.

**6. Brief conformance.** One row per question of the brief's section 3 (A1 to A6, I1 to I7, B1 to B4, T1 to T5, C1 to C4): the D2 section that answers it, "open question" with the Q number, or "gap" with what is missing. D2's own table in §9.3 is its claim; check it.

**7. Incident coverage.** One row per incident in the predecessor record (`docs/reviews/predecessors/sdlc-review-claude.md` section 3.4, and your own review's findings on Codex enforcement and headless delegation) that concerns backends, isolation, termination or cost: the D2 mechanism that prevents it, or "gap". D2's §7.5 is its claim; re-run the table yourself. This is the test I care about most.

**8. The isolation probe suite (Appendix A.6, P1 to P20) and the test table (Appendix B).** Which probe or test, as stated, would pass while the property it stands for is false? Which property of §2 or §3 has no probe or test? Where a positive control does not actually prove the negative ran?

**9. What you verified versus inferred.** Your evidence labels. Where D2 cites a probe on this host (its preamble), you may repeat the probe; where it cites `claude --help` or `codex --help`, you may read the help; do not run either binary against a model.

## Where to press hardest

These are the places I am least sure of. Treat them as prompts, not as the only places to look.

- §2.2 and §2.3: the role is the same kernel uid as the engine and the operator, and isolation rests on what the namespaces leave visible. Is there any path from inside the sandbox to the engine home, the token, the store or the operator's home that the mount set, the probes and H1 to H10 do not close: `/proc` entries of the pid namespace, `/dev/shm`, the read-only `/etc`, the bound git directory, a path a project's `sandbox_read_paths` widening could name, or something WSL2-specific beyond P11 and P12?
- §2.4: the egress proxy. Can a listed provider host be made to reach the engine (DNS answers changing between resolution and connect, IPv6, a name that resolves to several addresses)? Is `CONNECT` on 443 to an allow list enough, or does a backend need something the list refuses (telemetry, update checks, OAuth) that would make it fail closed in a way the canary misreads?
- §3.1 to §3.3: the boundary. Is "absent cgroup means terminated" sound in every ordering of engine crash, systemd collecting a scope, and a launcher that had not placed itself? Does killing a prior incarnation's supervisor leaf ever kill something that was not that engine's? What happens when the user manager restarts (logout, `systemctl --user daemon-reexec`) while domains are populated?
- §3.5 (E36 item 6): the three conditions for re-granting a lease after a pause. Is a heartbeat read after `expires_at` on a control channel the right evidence of liveness, and can a wedged backend keep a run alive forever through it?
- §1.4 and §1.6: the result read only after termination, accepted only on exit class `clean`. Is there any ordering in which a result written by a surviving member after the backend's exit is accepted, or in which `unknown` becomes anything but quarantine? Does refusing native structured output (`--json-schema`, `--output-schema`) lose anything the engine needs?
- §4.1 and §7.2: the trust entry and the three canaries. Would the containment canary, as written, pass against a backend that ignored every instruction and did nothing (the Verity 567-green-stubs case, your §5.2)? Is the positive control strong enough?
- §4.5 and §4.6: the two templates. You know these CLIs better than the draft does. Which "not established" items would you expect the canaries to settle the other way, and is anything in the templates already wrong at these versions?
- §5 C1 and C2: a real Reviewer agent proposing an Alpha exception and lowering a Critical finding. Is K7 the right reading of F §6.3, and does C1's `claimed` containment evidence give the human enough to decide?
- §8: what D2 does not claim. Is anything in class C ("accepted by design") something that should block a real run instead?

## Constraints

- Read-only. Do not change any file in the repository. Do not run model benchmarks, `claude -p`, `codex exec` with a prompt, or anything that spends money. Host probes of the kind D2's preamble lists (`unshare`, `systemd-run --user --scope`, reading cgroup files) are fine; clean up any scope you create.
- Cite file paths and section numbers for every claim so Sean and I can check them.
- Keep proposed amendment text in D2's register: requirements a test can pin, not advice.
- If a question needs an answer from Sean before you can judge a section, list it under a final "Questions for Sean" heading rather than guessing.

When you are done, tell Sean the verdict in one line and where the file is.
