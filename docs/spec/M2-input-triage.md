# Before a real agent runs: triage of what M1 does not claim

**Status:** confirmed by Sean, 2026-10-03 (errata E48). Owner's document. Written after Astra's milestone assessment (errata E46) asked that the eighteen real behaviours no test establishes be prioritised deliberately before real-agent use.

Source: `docs/acceptance/reports/M1-not-claimed.md`, class B. Each row below is one of those eighteen (two have since been built, errata E47). The bucket says when it should be settled. "Settled" means a test and a build, or a recorded decision that it stays unbuilt, never silence.

| Bucket | Meaning |
|---|---|
| **A. Before a real agent** | Could let unverified or tampered work through a gate, or defeat a person's decision, once a real agent produces real commits. Built as the first slice of M2, before any backend runs. |
| **B. In M2** | Needed for a first real project to be usable and legible, but not a gate-integrity risk. Built in M2 alongside the backend. |
| **C. With its design, or later** | Depends on a design that does not exist yet (D3's check runner, a real notification channel), or needs a situation M2's single small project will not produce. |

## The triage

| Plan row | Behaviour, in short | Bucket | Why |
|---|---|---|---|
| M24 | A candidate whose marker has been moved or deleted, and not resolved, has its gates blocked | **A** | A gate could pass, and an authorization be issued, for tampered-with code. One case. |
| M28 | A Builder's result replayed onto a moved branch is validated again against the protected set in force at integration | **A** | A file that became protected while the Builder ran could be changed without the required approval. One case; needs a protected change landing mid-run. |
| M45 to M55, part | A decision's answer is refused as out of date when any fact its preview rested on has changed: the untested facts for the three protected-check corrections and the policy widening | **A** | These are the decisions that change what the engine may do to code. A person could approve something other than what takes effect. About four cases. |
| M49 to M55 | The answer "reject" leaves things as they were and closes the question, for all seven kinds that offer it | **A** | A first real run will say no at some point; nothing establishes what happens. Seven small cases. |
| M41 | A check result is not reused for a later candidate if the protected checks changed in between | **A** | A pass from a test that no longer exists in that form could satisfy a gate. One case. |
| M45 to M55, rest | The remaining untested preview facts (a blocked item's evidence and continuation; a finding's status, evidence and scope; an exclusion's ancestry) | **B** | Same class of defect, lower stakes: these answers do not change code. About seven cases. |
| M25, M46 | "Adopt" for edits found in the developer's checkout | **B** | Offered today and answered 501. A developer editing the checkout during a run is the first accident a real project will have. |
| M70 | The status line's other causes of "refused" (unreadable repository, unresolved outside change, store failure) and "unknown" | **B** | Astra's third priority: the status line must point at the real problem. Three or four cases. |
| M70 | The remaining reads: operations, one decision by id | **B** | Visibility into pending git operations. Work items and gate reasons were built on 2026-10-03 (E47). |
| M61 | A usage write that keeps failing stops the run and marks its usage incomplete | **B** | The rule is decided (E37 item 3) and untested. One case. |
| M15 | A commit or branch update that overruns its time limit while the engine runs is recorded as unknown and blocks the project | **B** | Needs the harness to hold only git writes. One case; the recovery side is tested. |
| M20 | A git command's output over the cap fails cleanly | **C** | Needs a repository large enough to exceed 64 KiB of output. Later, with a larger project. |
| M27 | The set of work a nomination marks as verified is frozen when the nomination begins | **C** | A rare race needing two pause points; the finalizer-freezing rule is recorded (E33 item 2). Later. |
| M31, M32 | Recovery classifies a workspace whose repository entry was removed by hand | **C** | Arises only after a manual clean-up. Later. |
| M43 | A module's tier override and a sensitive area's own required checks | **C** | Belongs to D3, the check-runner design, which defines what a sensitive area requires. |
| M11 | A requirement-versus-contract contradiction goes to a person instead of being repaired again | **C** | The design names two routes and M1 builds neither; a decision for the D3 or spec-change design. |
| M58 | What follows a notification plainly refused by its channel | **C** | No design says; decide with the first real channel. |
| M70 | A record file replaced by a real device file is refused | **C** | Needs administrator rights to test. Accepted as untested; a link to a device is tested. |
| M72 | The event stream filtered to one project | **C** | Named by the design, not by the plan. Later, with the UI. |

## Counts

Bucket A: 5 entries, about 14 cases. Bucket B: 6 entries, about 15 cases. Bucket C: 8 entries.

## Recommendation

Make bucket A the first slice of M2, "hardening before a backend", built under the M1 procedure (Verifier, Builder, one review) while D2 and D3 are designed. Bucket B follows in M2 proper, in the order above. Bucket C is recorded here and in the not-claimed list; each entry names the design or situation that reopens it.
