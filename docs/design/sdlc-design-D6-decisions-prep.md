# D6: the decisions, decided (E139), and what draft 2 leaves to Sean

**Status: decided by Sean, 2026-10-12, recorded as E139** (`docs/foundations/sdlc-foundations-v1.1-errata-draft.md`), on draft 1's sheet (`design/d6` at `73b079d`). This sheet now records the decisions as made and applied in D6 draft 2 (`sdlc-design-D6-idea-to-alpha.md`), and lists the few things draft 2 leaves to Sean: numerics under the delegation in force, and one choice of artefact. The nine questions of draft 1 are removed; their decisions are in Part 2.

**What D6 is, in one paragraph.** Surety can take a hand-entered approved baseline through stages to a verified Alpha deployment, one stage at a time with a human `continue` after every role. D6 designs the part before that and the part that joins it up: **three conversational roles as engine sessions** (Vision, Spec Writer, Architect), each turn a metered one-shot invocation with the conversation in its context package, each product committed by the engine and approved by the owner; **the specification as a governed artifact** with a change request, a Spec Writer's proposed diff on a side ref, an exact impact analysis, the owner's approval, and invalidation that flows to checks, stages and gates; **planning as the foundations describe it**: a roadmap for the whole project, a mechanically checked plan for the next phase only, the Architect re-entering after each phase from durable records; **the engine driving the whole build**: checks authored per phase before any stage, stages ordered by their dependencies and run as many at once as the machine admits, an autonomy profile that runs a phase unattended within the floor, the phase gate, replanning, and a policy that requests the Alpha deployment D4 already performs; and, by Sean's decision, **the retrofit journey**: an existing repository adopted, the Spec Writer and Architect reading its code, the owner confirming what it does, a conformance phase with no Builder, and the build proceeding by phases. It states where a Surety-run build's time and tokens go, and the read that measures them for the benchmark after M5 (E130 item 9).

---

## Part 1. What draft 2 leaves to Sean

| # | In plain terms | Options | Recommendation and cost |
|---|---|---|---|
| N1 | The per-profile memory maxima under the engine's 8 GiB ceiling (K2, §6.4), which decide how many runs the envelope admits on this host | `role_memory_max` 4 GiB and `check_memory_max` 2 GiB as D6 proposes; or other values; the ceiling `domain_memory_max` 8 GiB unchanged either way | **As proposed.** With 12 GiB available: two role runs, or one beside a running Alpha service; at the ceiling, one and none. **Cost:** a Builder needing more than 4 GiB is killed at its limit and its run fails `infra_error`; the exit class and the recorded `memory.peak` say so and the project raises the value. No role domain's peak has yet been measured; `D6-X08` and the pace read measure it, and the defaults are revisited after the benchmark. |
| N2 | `max_concurrent_domains`, the hard cap beside the envelope | 4 (D6); 2 (today); 8 | **4.** On this host memory limits first; on a larger host the cap should not. **Cost:** none on this host. |
| N3 | The repository for the retrofit real run (§8.5, `D6-J04`) | (a) the repository the M4 real run's Builder wrote (one module, dependency-free Node); (b) a small repository of yours; (c) none, with the reason recorded | **(a)** unless you have a small real repository you would rather see described: (a) is known, tiny and already has a check. **Cost:** under about 3 USD estimated and about forty minutes of your time in two sessions; an estimate, not a cap. |
| N4 | `adoption_full_max_files`, the size under which `adoption_mode` recommends `full` (E6's threshold; F §9.2) | 2,000 tracked files (D6); another value | **2,000.** It is a recommendation on the decision, never the choice. **Cost:** none. |

## Part 2. The decisions, as recorded in E139 and applied in draft 2

| Q | Decision (E139) | Applied in |
|---|---|---|
| Q1 | (a) A turn is a fresh one-shot run carrying the transcript the engine holds; no provider-side resume | §2.2, §2.6, K6 |
| Q2 | (a) The replan is a one-shot run, mechanically checked, one repair, then a blocker offering a session; the initial architecture a session | §5.6, §3.4 |
| Q3 | (a) Default autonomy `phase`; §9.1's floor untouched | §6.5, K3 |
| Q4 | **Sean's own:** concurrency dynamic, sized to the machine: as many role runs as dependencies allow and the admission envelope admits; no per-project number. Several machines after M5 | §6.4, §7.2, §7.5, §7.6, K2 reworked; §11 class B (several machines) |
| Q5 | (a) `alpha_deploy: manual \| on_phase_complete`, default `manual` | §6.8, K9 |
| Q6 | (a) Sonnet for Builder, Verifier, Reviewer; Opus for Spec Writer and Architect | A.7; the real runs |
| Q7 | (a) The real journey fixture-C-sized: T2, two phases of two stages, one spec change, under about 5 USD estimated | §1, `D6-J02`; the retrofit real run added, `D6-J04`, §8.5 |
| Q8 | **(b), against the recommendation:** retrofit in M5, journey first, with its own acceptance and real run | §8 rewritten, K10, K11, `D6-R01` to `D6-R08`, `D6-J03`, `D6-J04`, §11 |
| Q9 | (a) The first toolchain proposal stays its own approval | §6.2 |
| K1–K9 | Accepted as a block; K2 reworked for Q4 | §12.1 |

## Part 3. What changed in draft 2 beyond the decisions

- **K10 and K11 are new, proposed** (§12.1): the index's optional `Origin` column and the claims table, `requirement_confirm`'s flow, `descriptive_unverified`'s exclusion from obligations, `external_unverified` releases (K10); the conformance stage with no Builder and the conformance-phase `fix` rule (K11). Both serve Q8 and change the kernel; both name their tests.
- **Readings 10 to 12** (§12.2): E6's "no change until conformance" against F §6.2's `fix`; adoption of tests as a copy under the protected root; D2's single domain memory against "as many as the host admits".
- **Appendix C** gains `D6-X08`, `D6-R01` to `D6-R08`, `D6-J03`, `D6-J04`, and reworks `D6-X05`, `D6-X06`, `D6-M01` for dynamic concurrency.

## Part 4. Process

- **Astra's cross-review** (E139 item 11): the brief is `docs/reviews/D6/sdlc-design-D6-review-brief-astra.md`; her findings are dispositioned by Sean into draft 3's numbered changes or become failing acceptance tests (E20).
- **The M5 build spec and acceptance plan** are drafted meanwhile from Appendix C, with C.2's migrations of accepted rows done by a Verifier (as D4 C.2, E118).
- **A plan question, not a design one:** whether the project lane's reference project is Verity's fixture C ported, so M5's journey and the benchmark's first fixture are one artefact.

## Part 5. What M5 would then be (for orientation)

Slices after M4's thirty, journey first (E40): the scripted first journey of §1 as the first target on the project lane; sessions on the real boundary with the continuation canary; the Spec Writer's parse-at-save and the spec approval; the Architect's products, the mechanical check and registration; the autonomy profile, dependencies, dynamic admission and the event-driven tick; the phase gate, phase verification and the replan; the spec change workflow; the deploy policy and the pace read; the retrofit journey of §8 on the project lane (adoption, retrofit mode, confirmations, the conformance stage, adopted tests); then the two real journeys on Sean's command (Q7, §8.5), the report and a hands-on. Nothing before the real journeys spends anything or touches anything outside a test's own disposable home.
