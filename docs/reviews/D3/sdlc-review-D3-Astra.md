# D3 draft 1 — Astra cross-review

2026-10-06. Reviewed against repository HEAD `fdc40703c83bdf85f5a057b09f4cde355e280ad4`. This is a design review, not implementation authorization. Recurring progress reviews remain paused.

Source names used below identify these files:

- **D3:** `docs/design/sdlc-design-D3-checks.md`, draft 1; **brief:** `docs/design/sdlc-design-D3-brief.md`.
- **D2:** `docs/design/sdlc-design-D2-backends-and-isolation.md`, draft 2; **D1:** `docs/design/sdlc-design-D1-engine-core.md`, draft 3.
- **BS:** `docs/spec/M1-build-spec.md`; **RN:** `docs/design/sdlc-design-D1-resolution-note.md`.
- **F:** `docs/foundations/sdlc-framework-foundations-v1.0.md`; **E:** `docs/foundations/sdlc-foundations-v1.1-errata-draft.md`.
- **SEAM:** `packages/engine/test/acceptance/harness/SEAM.md`.
- **CH:** `docs/reviews/predecessors/sdlc-review-claude.md`; **AH:** `docs/reviews/predecessors/sdlc-review-Astra.md`.
- **Decision preparation:** `docs/design/sdlc-design-D3-decisions-prep.md`.
- Paths beginning **`src/`** below are relative to **`packages/engine/`**.

## 1. Verdict

**Approve with the amendments in section 2 applied.** The separation between engine-observed execution, protected check definitions, structural classification and project-specific test adequacy is sound. Four architectural amendments are necessary: protect the input's pathname as well as its mounted inode; stop classifying source-hiding root additions as tightenings; make pending registrations authoritative over older results; and enforce the tier's check inventory and verification cadence. The remaining precision belongs in the acceptance cases in section 8, written before their implementation, under E20. I preserve Sean's E89 decisions: discarded writable overlays, the human route for Builder objections, and `direct` only for M3. This review approves neither deployment nor another runner class.

## 2. Blocking objections

### B01 — A read-only input bind does not make its pathname immutable

**D3 §§1.3–1.5, 2.2–2.4; Appendix C P06–P08.** The claimed property is stronger than the described mount construction. A file bound read-only beneath a writable directory remains read-only if that directory is renamed, but the old pathname becomes available for a replacement. D3 removes protected roots from the source lower layer; directories subsequently created as input mount targets can therefore exist only in the writable upper layer.

**Evidence — Observed this review.** Inside `unshare -Urm`, I mounted an overlay, created `view/checks/run/` in its upper layer, bound a protected file read-only at `view/checks/run/input`, dropped all capabilities, renamed `run` to `old`, recreated `run`, and wrote a replacement `input`. Both reads succeeded: the original mount still contained the protected expectation; the check's original pathname contained the replacement. With a parent originally present in the overlay lower layer, the attempted rename did not succeed in the same probe. The upper-directory case is sufficient to disprove the unconditional claim, and matches a layout permitted by D3 §2.4. This was a primitive probe, not an execution of the unbuilt D3 launcher.

There are two associated identity obligations. Directory inputs cannot mount the governed file merely because their directory contains it; D3 §§1.3 and 2.2 promise exact inputs and exclude that file. Also, `[path, blob id]` omits Git mode: I verified that a regular file containing `target` and a symlink to `target` have the same blob id. D3 §1.4 rejects links in the definitions directory, but does not establish an equivalent rule for all input assets. The existing `src/protected/set.ts` `protectedPairs` also discards mode. A resolved input must not silently become a link into mutable source while retaining its identity. These are failures of the protected path required by F §5.2 and D2 §2.3, not objections to E89's overlay decision.

**Proposed replacement/addition:**

> The `check` profile MUST enforce the identity of each protected input at its workspace pathname for the entire execution. Neither check code nor candidate code may rename, remove, exchange or replace the input or any ancestor in a way that changes what that pathname resolves to. A read-only bind beneath a writable ancestor is insufficient. The mount plan MUST provide an immutable namespace for protected inputs while retaining the discarded writable source overlay.
>
> Before mounting, the engine MUST expand inputs into a canonical manifest of paths, Git types, modes and object ids. A directory input is a projection of its permitted members, not a bind of an unfiltered directory. The governed file MUST be absent from every projection, including the candidate-source projection, even when it lies outside the configured roots. Undeclared protected content MUST be absent from every path visible to the domain. Link or special-file inputs and link traversal through mount-target ancestors MUST be refused unless their immutable resolution is explicitly supported and tested. For the first runner, refuse them. Every permitted type or mode distinction that changes execution or resolution MUST participate in protected/input identity; it MUST NOT compare unchanged on blob identity alone.
>
> P07 and P08 MUST exercise replacement through ancestors created in the overlay upper layer, overlapping directory inputs, the governed-file exclusion, and link aliases, with positive controls for ordinary source writes. Qualification MUST refuse a profile that cannot enforce these properties.

This amends the fingerprint contract as well as the profile; record that correction explicitly rather than claiming the as-built hash already supplies it.

### B02 — Adding a protected root can remove the source a retained check examines

**D3 §§1.5, 2.4, 3.1; Appendix C C02, C05, C06.** A check's declared protected inputs are not its entire execution input. Its visible candidate source also depends on `protected_paths`. The rule that a root addition is a tightening with declared inputs therefore does not prove the retained check unchanged.

**Evidence — Recommendation/inference, with an observed counterexample primitive.** Start with a valid check whose declared input is its unchanged protected runner. That runner discovers candidate tests in `tests/` and `src/`, refuses an empty suite, and propagates the test process's exit. Before the proposal it sees a passing baseline test and a failing source test. Add `src/` to `protected_paths`, change no check definition or declared input, and do not add `src/` to that check's inputs. Under §2.4 the candidate's `src/` is omitted; under §2.2 its protected replacement is not visible. Under §3.1 the only relevant element is `root_added`, a tightening. The retained check now returns zero after running the remaining baseline test. I reproduced this by hiding the source directory: two tests, one failure, exit 1 became one test, no failures or skips, exit 0. This counterexample survives an empty-suite guard. I did not run a D3 classifier; its classification follows the written rules. C06 currently requires this unsafe classification.

The same problem exists for checks whose behavior changes when a source configuration or fixture disappears; it is not confined to test discovery. Default inputs often force the human route, but declared inputs—the recommended way to enable agent-approved tightenings—expose the counterexample. F §5.3 and E13 require retained checks not to be weakened by that route.

**Proposed replacement:**

> A change to `protected_paths` that changes the source/protected namespace presented to an existing check MUST NOT classify as a tightening solely because its declared-input fingerprint is unchanged. In the first classifier, every root addition or root-layout change is `unclassifiable`; root removal remains at least `loosening`, with `unclassifiable` taking precedence when applicable. Agent approval of root additions is deferred until a classifier proves preservation of every retained check's visible source and protected-input namespace.
>
> Classification MUST account for every semantic difference in a definition, input manifest and governed field. A difference without an explicit classified rule is `unclassifiable`, including an unhandled `phase`, coverage-area, type or mode change; adding another strict element MUST NOT hide it. C06 MUST expect the conservative result for root additions and include a retained check whose behavior depends on the removed source path.

An ordinary new check with disjoint protected inputs and unchanged root layout may still be a tightening. This amendment does not require semantic analysis of test code.

### B03 — “No result while unknown” can expose an older pass

**D3 §§2.5–2.7; D1 §9.2; Appendix C R07, R11.** D3 says the later registration decides, and a quarantined execution makes the check `missing`. D1 §9.2 actually selects the highest sequence among matching **result rows**. A newer execution with no row cannot supersede an older passing result under that algorithm. D3's claim that this works with §9.2 unchanged is false.

**Evidence — Observed this review.** `src/store/transitions/gates.ts` `executionsOf` reads `check_results` and assessed reuse entries; `checkState` picks the largest result `execution_seq`. Register a rerun after a pass, leave it queued, running or quarantined, and that algorithm still selects the old pass. D3's tests can miss this if R07 begins with no results and R11 examines only the state after both executions finish. F §6.1 and D3's own latest-registration rule require the gate to wait.

**Proposed numbered correction to D1 §9.2:**

> Selection MUST first consider durable check registrations at the scope's complete bindings, not only completed result rows. A newer matching registration supersedes every earlier matching result or reuse selection. Until that registration has a usable recorded result, the check is `missing`, the gate is unsatisfied, and the gate read names the execution and its pending, quarantined or cancelled condition. It MUST NOT fall back to an earlier pass. When the latest registration has a recorded result, the existing skipped/failed/passed derivation applies, with L4. Superseded bindings remain ineligible as before.
>
> Registration and changes of its deciding status MUST stale dependent evaluations in the same store transition. Registration, fixture results and post-disposition execution comparisons MUST use the same durable project sequence. Cancellation without a result MUST NOT restore superseded evidence. No synthetic successful or skipped result is inserted to stand for unknown termination.

Keep the five `CheckState` values; the execution's status explains why `missing` is pending. Pin the disposition watermark as section 8 T06 specifies: moving allocation to registration also changes what “after disposition” must measure.

### B04 — Scope validation omits required check kinds and does not carry module tier into cadence

**D3 §§4.1–4.4, 2.5; L3.** Criterion coverage, one check per sensitive area and sign-offs do not establish the minimum check inventory in F §5.7. A T3 scope with one acceptance check covering all criteria and all sign-offs can satisfy §4.3 with no smoke, integration, security-lint, property or failure/recovery check. `tier_floor` only filters checks that already exist; it cannot detect an absent kind.

**Evidence — Observed this review / Recommendation/inference.** F §5.7 names the inventory; D1 §3.3's `CheckKind` ownership repeats it. D3 §4.3 has no corresponding completeness condition. In addition, `src/store/transitions/accept.ts`'s integration finalizer chooses automatic nomination using only `p.tier`; D3 §4.1 raises checks and sign-offs using module overrides, but does not change this cadence calculation. A T1 project with a T2 module can still require the Builder's `nominate` request instead of receiving the F §5.6 milestone verification. Finally, deriving all requirement sensitivity only from fully delivered obligations (§4.2) loses a sensitive requirement implemented across stages until its last stage, unless a module independently declares that area. F §5.6 applies the floor to sensitive behavior touched, not only to completed requirements.

**Proposed replacement/addition:**

> Scope validation MUST enforce the minimum applicable check-kind inventory of F §5.7 in addition to criterion and sensitivity coverage: T1 requires acceptance and smoke; T2 additionally requires integration and security lint; T3 additionally requires property and failure/recovery. Required sign-offs and security review remain separate obligations. At a supported validation point, a missing required kind MUST yield `ACCEPTANCE_SCOPE_INCOMPLETE` with that kind identified. A project's `required_checks`, `gate_kinds` or `tier_floor` declarations MUST NOT waive the inventory. Developer-origin evidence MUST NOT substitute for protected acceptance obligations.
>
> The effective scope tier MUST also determine the verification cadence of F §5.6. Integration of a stage whose modules raise it to T2 or T3 MUST trigger milestone nomination and verification even when the project's default is T1 and no role requests nomination. The required-check registration set, scope evaluation and acceptance content hash MUST derive from the same scope rules.
>
> Sensitivity at a stage MUST include the requirements that stage implements, including partially delivered requirements, and its modules. Requirement delivery and criterion-completeness claims remain governed by D1 §9.1; partial delivery MUST NOT suppress a sensitivity floor. Phase evaluation remains unsupported until its milestone, as already decided.

The scope cases must pin absent kinds, raised-tier nomination and a sensitive requirement spanning two stages, not just successful selection of checks already provided by a fixture.

## 3. Non-blocking suggestions

### N01 — Make `affected_checks` describe obligation changes too

**D3 §§1.6, 3.3; P09.** Added/removed/fingerprint-changed keys omit an existing check removed from `required_checks`: that field is deliberately not part of its fingerprint (§3.1). The displayed affected set can be empty for a proposal that removes a gate obligation. This is a review-information gap, not an additional authority bypass; the proposal still classifies as loosening and requires the scope approval (SEAM §69).

**Proposed text:**

> `affected_checks` MUST include keys whose definition, input identity, required membership or applicability changes. Each entry MUST state its reason; a required-set change MUST be visible even when the executable fingerprint is unchanged. P09 MUST include removal of an existing required key without a definition change.

### N02 — Separate a failed ref read from an observed ref change

**D3 §5 X1; X01.** Ref rereads are necessary. Treating any unreadable nomination ref as `OUT_OF_BAND_CHANGE`, however, equates a transient Git failure with evidence that someone changed a ref. D1 §7.6 gives integrity observations consequences beyond one refused evaluation. CH §3.4 incidents 8, 9 and 12 are warnings about conflating unknown state with a negative fact. `src/gates/prepare.ts` currently supplies facts before the transaction; the new read should preserve that distinction.

**Proposed text:**

> A ref observation MUST distinguish a successfully read value, verified absence, and an unsuccessful read. A differing value or verified deletion of a registered ref records out-of-band change. An unsuccessful read refuses the current evaluation with the unread fact named, schedules a bounded reread, and MUST NOT manufacture a changed-ref value or an adopt/discard decision. If the registry changed during the read, the engine MUST reconcile or reread against that generation before recording an external change.

This improves failure classification; all three unknown/error cases already have to keep the gate unsatisfied. Test precision is T16 below.

### N03 — Keep execution history close to the deciding result

**D3 §6 class C, A.7.** Keeping every execution is the right foundation for exposing flaky reruns. A separate executions route is less useful if the gate read shows only the final pass. An operator can otherwise miss repeated failures at the same bindings while looking at the approval screen. This does not justify forbidding every rerun after a pass: a diagnostic rerun is legitimate and B03 makes its pending state honest.

**Proposed text:**

> For each deciding execution the gate read MUST expose the count and identities of earlier executions at the same bindings, including failed attempts, and a link to their ordered history. A successful rerun MUST NOT erase or relabel an earlier failure. Operator requests MUST remain distinguishable from bounded infrastructure retries.

### N04 — Align the reference and milestone wording with the actual claims

**D3 preamble, §§1.1, 2.8, 5 X3, 6, A.4, Appendix B; E89.** The governed field defaults are promised but the nested `runner_config` defaults are not fully enumerated. Appendix B is a useful example, but its single acceptance check is not a complete tier-qualified project under F §5.7. The new E89 decision makes M3 the check-runner milestone; deployment is subsequent work, although the older brief calls it M3.

**Proposed text:**

> The generated schema MUST enumerate every omitted-field default and configuration unit; discovery MUST not derive a default from the host environment. Appendix B is a definition example, not a complete valid project's check inventory. References to the environment-bound runner describe a later deployment milestone; M3 builds the direct workspace check runner under E89.

## 4. Proposed corrections L1–L5

| Correction | Judgment | Reason and pinned condition |
|---|---|---|
| L1 | **Accept with a variant.** | Exclusive invocation/check ownership and a check lease are appropriate. The binding must apply to every launch, closure, recovery, resource and projection path, including a domain allocated before `started`; T07 pins that extension of D2 §§3.2–3.5. |
| L2 | **Accept with a variant.** | Scheduling checks after Gates is reasonable and the host envelope still limits all domains. Durable registration/invalidation must occur with the trigger, or an equivalent gate barrier must exist before Gates can consume older evidence; it cannot wait solely for the later tick step (B03; D3 §§2.5, 3.5). |
| L3 | **Accept with a variant.** | Criterion-level coverage and a reachable `uncertain` state improve D1 §9.1. Add the kind inventory, partial-requirement sensitivity and cadence obligations in B04. |
| L4 | **Accept.** | An exit-zero check with unfinished descendants has not completed its work. Observe descendants when the check's own process exits, before init teardown or forced closure makes the domain empty (D3 §2.6; T08). |
| L5 | **Accept.** | Human approval cannot make an invalid definition executable or make unknown coverage complete. Rejecting and producing a corrected proposal is consistent with D1 §7.9 and F §5.3; a spec change may also make a subsequently reclassified proposal valid (D3 §§3.4, 5 X2). |

B01's input identity and B03's registration selection require additional numbered corrections where they change D1's accepted contract. They must not be hidden as implementations of unchanged rules.

## 5. Open questions Q1–Q7

| Question | Recommendation | Reason |
|---|---|---|
| Q1 — cross-version reuse | **(a), no.** | Preserve finalizer invalidation and SEAM §§72, 103. Check execution consumes host resources and may be expensive, but M3 does not need the extra proof system required for cross-version reuse (D3 §3.5). |
| Q2 — failed stage check | **(a), automatic bounded repair. This changes the kernel.** | Staying `verifying` leaves a stage without the Reviewer route because review waits for passing checks. Reconcile durable current failure state, bind the repair to the current candidate/work generation, and count once per repair attempt rather than once per arbitrary arrival; see T13 (D3 §2.10; E36 item 3). |
| Q3 — default inputs | **(a), all protected files except the governed file.** | A conservative human fallback is preferable to mandatory declarations that merely encourage incomplete lists. Explicit inputs can improve usability once the namespace is actually enforced; neither choice fixes the root-layout counterexample without B01–B02 (D3 §§1.3, 3.1). |
| Q4 — ref reads | **(a), every supported gate. This changes the kernel.** | Stage satisfaction completes work too; there is no useful authority distinction here. Separate unreadable facts from observed edits and reconcile the registry generation, as N02/T16 require (D3 §5 X1; `src/gates/prepare.ts`). |
| Q5 — classifier authority | **(a), the operator setting bound to a qualified version.** | A new decision kind would duplicate authority over engine configuration. Qualification must include the amended classifier corpus; losing the version match must also prevent an already pending Reviewer application, not merely change how the next recommendation is displayed (D3 §3.3; D2 §5 C2; T10). |
| Q6 — mandatory program hash | **(a), optional for the initial workspace runner; always record it.** | A mandatory executable hash alone does not pin libraries, packages or mutable toolchain directories. Keep the limitation explicit and require the deployment design to decide its stronger reproducibility claim; do not present optional pinning as an immutable toolchain (D3 §§1.1, 2.6, 6). |
| Q7 — deployment modules | **(a), all present modules.** | A diff-only rule drops obligations for code retained from earlier candidates. The later deployment design must also account for enduring effects of deletions, such as stored personal data; disappearance of a module's files is not evidence that its external effects disappeared (D3 §§4.1, 5 X3). |

## 6. Brief conformance

These are answers to the brief's §3, not acceptance results.

| Brief item | D3 answer or gap |
|---|---|
| P1 — governed runtime schema | §§1.1–1.3, A.4, Appendix B. Answered; explicit defaults need N04/T01. |
| P2 — effective protected materialization | §§1.5, 2.2–2.4. **Gap:** pathname immutability and exact projections, B01. |
| P3 — non-executing discovery | §1.4; P03. Answered in architecture; bounded traversal and malformed entries need T01/T17. |
| P4 — proposal and affected checks | §1.6 reuses D1 §7.3/SEAM §68. Answered; affected membership needs N01. |
| R1 — tree, writes, toolchain, bindings | §§2.2–2.4; §5 X3 reserves deployment. Overlay departure accepted by E89; **gap B01**. Governed toolchain paths are a justified refinement of the brief. |
| R2 — launch, capture, records | §§2.1–2.3, 2.6; L1. Answered; trusted-report/record tests T07–T09 remain. |
| R3 — established execution and unknown | §2.6; L4. Closure architecture retained; **gap B03** in the gate implication; interrupted precedence needs T07. |
| R4 — sequence and bindings | §2.5. **Gap B03:** D1's result-only selector does not implement latest-registration authority. |
| R5 — triggers, scheduling, concurrency | §2.5; L2. Answered with B03's registration barrier and B04's module cadence; recovery identity needs T05. |
| R6 — not run and visible refusal | §2.7; R15. Answered; no-start versus interrupted-after-start requires T07. |
| R7 — qualified runner classes | §2.8; E89 item 2. Answered: direct now; others refuse. |
| R8 — developer evidence | §2.9. Answered: protected invocation, mutable developer tests, no criterion coverage. |
| R9 — failed-check repair | §2.10; **open question Q2** for stages. Fix route answered; durable reconciliation needs T13. |
| C1 — classification definition | §3.1. **Gap B02:** root addition can weaken an existing check; exhaustive semantic dispatch needs T03. |
| C2 — fallback and policy changes | §3.2. Conservative for changed code/governed execution fields; **gap B02** for root layout. |
| C3 — binding and authority | §3.3, K8; **open question Q5**. Same-class dependency changes and authority loss need T10. |
| C4 — approved criteria and contradictions | §§3.4, 4.5; L5. Answered structurally; the parser cannot judge semantic agreement with prose. |
| C5 — invalidation/reuse | §3.5; **open question Q1**. As-built all-version invalidation accurately described. |
| S1 — scope, tiers, phase, validation | §§4.1–4.3; L3; **open question Q7**. **Gap B04:** absent kinds, raised-tier cadence and sensitivity during partial delivery. Phase execution is explicitly deferred, not silently claimed. |
| S2 — sensitivity minimum | §4.4, Appendix B. Answered as required declared floor checks and human assessment of adequacy, not engine-shipped security tests; B04 corrects which scopes receive them. |
| S3 — criteria, coverage and delivery | §§4.3, 4.5. Answered; index identity and content-hash propagation need T10/T12. |
| X1 — gate's own ref reads | §5 X1; **open question Q4**; N02/T16 qualify read failures and concurrent registry changes. |
| X2 — M43 and M11 | §§4.1–4.4, 5 X2. M11's route accepted by E89; M43 incomplete until B04. |
| X3 — environment-bound check | §5 X3, A.3. Reserved bindings are appropriate; neither deployment execution nor secret delivery is approved here. |

The two departures from the brief are acceptable in purpose. A discarded source overlay preserves the repository/candidate write boundary and accommodates toolchains; it does not by itself prove protected inputs immutable (B01). Putting check toolchain paths in governed policy, rather than the role's mutable `sandbox_read_paths`, strengthens F §5.2 without relaxing D2's forbidden set (D3 §§1.1, 2.2; D2 §2.3; E89 item 2).

## 7. Incident coverage

CH rows below refer to `docs/reviews/predecessors/sdlc-review-claude.md` §3.4. A mechanism in this table is a design response, not evidence the unbuilt runner passed it. Rows outside check execution/evidence are omitted; their broader D2 coverage is not reopened.

| Incident or prior finding | D3 prevention, limitation or gap |
|---|---|
| CH 1 — tail swallowed failing lint | §§2.6, 2.8: the engine observes the check process's exit, not printed output or its own shell pipeline. **Residual gap:** a protected command can itself hide a child's nonzero status; J02 must include a broken-child/zero-parent mutant. Exit-only judgment cannot prove a wrapper honest. |
| CH 2 — hundreds of stub tests green while real enforcement did nothing | §2.8 and Appendix C's sandbox/project lanes exercise the actual boundary and toolchain without models. The kernel lane alone is insufficient; P07 currently lacks the ancestry example B01 exposes. |
| CH 3 — lane could never authenticate, attempt not established | §2.8 self-tests require observed start and positive controls; `failed`/`not_exercised` must never qualify a runner. This addresses the analogous check-runner failure, not the old provider authentication problem (R17; T18). |
| CH 7 — work delegated into an unowned lifetime | §§2.6, 2.8; L1/L4 reuse D2 domain closure and fail live descendants. Observe at own-process exit, not after teardown has hidden them (T07–T08). |
| CH 8 — no CI interpreted as red; duplicated summary tripped breaker | §§2.5–2.7 distinguish pending, not-run and failure, and dedupe triggers. **Gap until B03/T05/T13:** pending can expose an earlier pass; retry identity and repair counting need the durable contract. |
| CH 9 — unreachable source looked empty or came from wrong repository | §§1.4, 2.4, 4.3 refuse unreadable facts and freeze source/version bindings. X1 must distinguish an unreadable ref from a verified edit (N02); test two repositories with identical relative paths (T17). |
| CH 10 — approval reran the role or applied to wrong head | §3.3/K8 apply a stored proposal with revalidation rather than rerunning the role. **Test gap:** revalidation must reject material dependency changes even when the class remains identical (T10; SEAM §§101, 104). |
| CH 11 — contained role could not create durable work | §§2.5, 2.10, 5 X2 assign registrations, repairs and conflict work to the engine. A role report cannot write a result; registration/finalizer recovery must be atomic and idempotent (T05/T13/T14). |
| CH 12 — check registration delay and clock skew parked healthy work | §§2.5–2.7 provide durable pending executions and sequence ordering, with host holds distinct from failed checks. No grace period may advance the gate; no pending check should consume a Builder repair (B03; T04/T13). |
| CH 13 — same trigger replanned every tick | §2.5 trigger dedupe and §2.7 bounded recovery address repeated dispatch. Generation and original-trigger retry lineage need T05; timestamps must play no role. |
| CH 15 — accepted intent artifacts never committed | §1.6 and §3.5 reuse the engine-owned proposal/application finalizer; P04 preserves discovered rows after a crash. Extend the same atomic finalizer test to new-version check registrations (T05), not only stored discovery. |
| CH 16 — unknown provider got maximum trust | §2.8 refuses container/remote and unqualified direct execution; §3.3 defaults classifier authority to recommendation. Test a classifier update while an approval is pending, not just a fresh read of the setting (T10). |
| CH 17 — asynchronous/vacuous tests and skipped tests counted as passes | R08/R17 cover process completion and runner judgment; J02 covers the reference project's zero/skip guard. **Residual gap explicitly admitted by §6:** this is not a guarantee for arbitrary protected check programs. A live descendant, an empty suite, an early summary and candidate `process.exit(0)` are different mutants; test each (T08/T18). |
| CH 19 — safeguards hid a role never exercised | §2.8/A.3 record each self-test and control as passed/failed/not_exercised. Qualification must require all mandatory cases actually ran; optional eBPF observation cannot replace them (E57; T18). |
| CH 20 — network outage stalled a live worker for ~110 minutes | §§2.4, 2.6–2.7 reuse Git/exec deadlines and bounded retries; D2 §3.7 supplies resource limits. Main-thread discovery, materialization and shared cache growth still need explicit bounded-work tests (T17). |
| AH §5.15 and §12 — early summary before asynchronous suites; no-op skipped browser test | J02 and R17 establish only their actual negative cases. The project's guard must fail empty/all-skipped and early-exit cases, and the acceptance runner must await every selected case and fail absent mandatory lanes (T18; M2 acceptance plan §2.1). |
| AH §9.9 — the test runner is itself a gate | §§2.6, 2.8 and J01–J04 are the right separation: real exit mapping, hostile boundary cases, then a real project toolchain. **Gap until B03/B04:** an honest runner still does not prevent selecting old evidence or accepting an incomplete check inventory. |

I repeated the Node probe on this host: Node v22.22.0 exits zero for no tests and for an all-skipped suite, and nonzero for a test that schedules an uncaught exception after returning. That supports the narrow claim in D3's preamble; it does not qualify arbitrary project wrappers or all asynchronous failure modes (section 9).

## 8. Appendix C and the classifier

### 8.1 Rows that can pass without establishing their advertised property

Appendix C contains 53 named rows. The lanes are appropriate: scripted kernel evidence, real sandbox evidence, then a project's real toolchain. The following are concrete false-positive opportunities in the row statements or missing boundary cases. Add these to the Verifier's finite matrix before the relevant slice; they are contract tests, not a request for another prose round (E20; M2 acceptance plan §§2, 5).

| ID | Existing row(s) and weakness | Required case and observable result | Lane |
|---|---|---|---|
| T01 | P01–P03 test examples without covering all schema defaults, input entry types or aliasing. | Enumerate omitted/invalid defaults and units, duplicate keys/criteria, non-regular definitions, overlapping directory inputs and the governed-file exclusion. An invalid effective version blocks scope; invalid proposals cannot apply. Discovery runs no repository code and does not silently omit a required entry. D3 §§1.1–1.4/A.4. | kernel; sandbox for visibility |
| T02 | P06–P08 may attempt writes/rename only at the bind itself. | Reproduce B01 with an upper-only writable parent; attempt ancestor rename/exchange, symlink redirection and hard-link aliases. Observe the original pathname's bytes after every attempt and confirm a source write works but does not persist. Repeat with a directory input containing the governed file and a candidate whose root layout differs. | sandbox |
| T03 | C02/C05/C06 explicitly permit unsafe root additions; C02–C04 do not name every semantic field. | B02's retained runner must not receive agent-authorized source hiding. Enumerate every schema field's isolated delta, then combine each unknown delta with a new strict check; `phase`, added sensitivity area, regular-file/symlink identity and executable-mode changes must never disappear from classification. A required-list removal appears in affected checks (N01). | kernel; project for source-hiding example |
| T04 | R07 can start with no result; R11 can inspect only two completed rows. | Seed an old matching pass and an assessed reuse pass. Register a newer run and evaluate while queued, materializing, running, quarantined and cancelled-without-result: none may fall back. Complete the earlier run after the newer one; latest registration still decides. Registration stales an existing satisfied evaluation. B03; D3 §§2.5–2.7. | kernel |
| T05 | R13 dedupes one trigger but does not distinguish retries or generations; P04 proves rows, not the new registrations. | Kill after nomination/application intent and around finalization. Exactly one registration per trigger generation and key survives. Two distinct operator requests both register; replaying one request does not. Recovery attempt 1 and 2 are distinct, but a restart cannot reset the original-trigger retry budget. Include `generation` in the tested identity: A.3 declares it, §2.5's tuple omits it. | kernel |
| T06 | R11 tests the allocator but not consumers of its ordering. | Leave sequence 9 registered and unfinished while maximum result sequence is 5; disposition a finding; then complete 9. That pre-disposition execution must not count as a post-disposition fix. `src/store/transitions/queue.ts` currently takes the watermark from `MAX(check_results.execution_seq)`; change it with registration allocation. Include collision-free fixture writes (`baseline.ts`). | kernel |
| T07 | R05/R06/R15/R16 do not give a total start/cancellation/recovery cross-product. A.5 lacks materializing→quarantined. | Cancel/crash after allocation, placement, authorization, successful exec, durable started report, exit report and collection. Unknown closure preserves a nonterminal execution/domain even before `running`. An executed check is not retrospectively “never started”: reconcile §2.6's iff rule with §2.7's blanket `interrupted` false row. A recovery-killed or cancelled check cannot become passed because it handled TERM with exit 0; retries wait for closure. Check code's stdout/stderr and attempts at the control descriptors cannot forge started/exit. | kernel + sandbox |
| T08 | R08 can observe an orphan only after cleanup, or cover only a child that holds stdout open. | Own check process exits 0 while a detached descendant remains, with stdout closed; observe the descendant at that exit before init teardown. Record `orphans=true` and failure even if the descendant disappears during cleanup. Add a no-descendant control. `src/invoke/domain-init.ts` currently drains stdout before reporting exit; reuse must not shift the observation to that later point. | sandbox |
| T09 | R10's critical finding can block the gate even if evidence validation is broken. | Independently assert `EVIDENCE_MISSING` for refused/absent check output, not merely an unsatisfied gate from the finding. A zero-output successful check still produces its required empty output record. Assert bounded interleaved stdout/stderr and no raw secret publication. `gates.ts` currently skips an absent record id with `if (!record) continue`; D3 §2.6 needs an explicit evidence-presence contract. | sandbox + kernel |
| T10 | C07 only changes a dependency enough to change the class; C08 may inspect only a new approval. | Change spec criteria/areas, effective version, scope approval, discovery, classifier version or authority between preview and effect **while class remains the same**. The old human or Reviewer authorization must not apply. Replay after restart also refuses. Extend `baseline.ts` `specRevision`, presently hashing key/text_ref/phase/status, to cover new index semantics; pin the complete manifest, not only `change_kind` (D1 §10.5; BS §6; SEAM §§77, 101, 104). | kernel |
| T11 | S01–S04 can supply all kinds and a module area, masking both absences. | T3 with complete criteria and sign-offs but missing each required kind separately is incomplete. T1 project/T2 module gets automatic milestone verification without a Builder nomination. A sensitive requirement spanning two stages receives its floor in the first stage even without a module-area declaration. B04. | kernel |
| T12 | S03/S05 prove scope fields but not all hash/approval consumers. | Change only a requirement's sensitivity or criteria, or a module tier/presence fact. Check registration, gate scope, required sign-offs, content hash, preview staleness and subsequent approval must agree. An earlier sign-off cannot authorize changed acceptance content. `evidence.ts` currently has an independent project-tier rule and `sensitivity: []`; test its replacement against `gates.ts`, not just one helper. | kernel |
| T13 | R20/R21 act on result arrival after `verifying`; a result before that state or an old failing arrival can escape the test. | Record failure before the work enters `verifying`, then reconcile it; exactly one repair follows. Conversely, an earlier failure finishing after a newer pass cannot trigger a repair. Several failed checks of one build cannot spend several repair attempts for the same transition. Restart/repeated ticks preserve attempt/no-progress limits; pending/not-run/stale never consumes Builder repair; conflict wins over auto-repair. D3 §2.10/Q2. | kernel |
| T14 | X02 can test one well-formed objection while trusting arbitrary check/criterion references. | Unknown, foreign-project or unrelated-work references are refused without registering a blocker or spec change. Replayed objections dedupe. A valid objection parks the named work, preserves checks, and only a human answer can choose the next work; the Builder cannot cause an actual spec edit through its field. E89 item 2; D3 §5 X2/A.3. | kernel |
| T15 | R12/S06 may use only a changed protected version to demonstrate staleness. | Supersede only the candidate while a check runs; its old result cannot authorize a current promotion or repair/resolution. Include assessed reuse and old-source bindings. `checkState` currently does not inspect `superseded_by`; establish target refusal or an explicit stale rule rather than asserting that version matching supplies it. | kernel |
| T16 | X01 accepts any unsatisfied result on unreadable refs. | Move/delete each registered ref, evaluate immediately, and get the correct observation without a tick. Separately force a transient Git failure, recover the read, and get no invented edit/adopt decision. Race an engine-owned journal finalizer with fact preparation: reconcile its registry generation rather than report the engine's own write as out-of-band. N02. | kernel, real git |
| T17 | P03/R01/J04 bound definition count, tree bytes and a running check, but not every main-thread preparation/cache cost. | Use many zero-byte source/input entries, a large definition traversal, stalled Git and several unreferenced/shared trees. Enforce entry, byte, time and aggregate admission bounds during preparation; API/cancellation remain responsive within D2 §3.7. A failed materialization cleans partial state, never exposes an incomplete cached tree, and never reads the same relative path from another project. | sandbox; kernel for fault injection |
| T18 | R17/J01/J02 may prove only simple failing tests, empty suites and all-skips. | Run every self-test and its control; fail qualification for failed/not-exercised mandatory cases. Reference-project mutants include swallowed child failure, a premature success summary, skipped/empty discovery, candidate `process.exit(0)` and the root-hiding case. The protective project wrapper must fail where it claims protection; separately label bare Node's vacuous pass as a limitation demonstration, never evidence of guarded execution. A missing mandatory sandbox/project lane fails the suite (D2 §2.8; M2 plan §2.1). | sandbox + project |
| T19 | R17/R18 qualify a runner but may not bind actual executions to the qualification's mechanism. | Change the check profile or restart between registration and launch. Dispatch needs the current qualified profile; persist the actual runner identity/qualification and the resolved program hash used for the execution. Wrong-class results never match. Frozen historical result provenance must not be relabelled as a new qualification. D3 §§2.5, 2.8; D2 §7.1. | kernel + sandbox |
| T20 | No Appendix C row closes M2's explicitly carried F2. | Once Sean decides F2, an unrelated green check, a developer check and a check outside the required scope cannot resolve the finding. Pin finding criterion→required acceptance check linkage plus current fix-candidate/post-disposition bindings, and require intact evidence. Leave adequacy of the asserted test to independent assessment. Decision preparation Part 4; E87 item 11; E88 item 2. | kernel |

The tests need real SQLite/git for transactional, ordering, manifest and journal claims; a scripted boundary cannot establish mount immutability, trusted-channel inaccessibility or descendant closure. Conversely, no model invocation is needed to establish any row above. These are additions/strengthenings of D3's three proposed lanes, not a demand to repeat the paid M2 lane during this review (D3 Appendix C; M2 acceptance plan §§2, 5).

### 8.2 Classifier adversarial examples and usability

| Change | Draft-1 outcome | Judgment |
|---|---|---|
| Add `src/` as a root while retained checks declare only their protected runners; source enumeration disappears | Tightening by `root_added` with unchanged declared-input fingerprint | **Unsafe; B02.** Existing evidence can weaken without a changed protected runner. |
| Add a valid but vacuous new check outside all retained declared inputs | Tightening | Structurally consistent: it does not remove the retained checks, but its claimed coverage is not semantic proof. The Reviewer must assess adequacy before approving; criterion metadata alone cannot establish it (D3 §§3.2, 6; E13). |
| Change only `phase`, then add an unrelated new check | §3.1 omits an explicit phase element; its overall retained-fingerprint invariant should force fallback | Pin that invariant with T03. An implementation dispatching only the listed fields can erroneously call this tightening. The conservative catch-all must cover every unhandled semantic delta. |
| Add an explanatory comment to a protected test program, or narrow an assertion's permitted range | Unclassifiable because an existing input changed | A person can readily approve; automatic refusal is appropriately conservative. A structural classifier cannot establish that arbitrary code became stricter (D3 §3.1; E13). |
| Add a new independent check under the default input policy | Usually unclassifiable because existing checks include the new protected files | Conservative and potentially noisy, but usable with explicit, enforced input projections. Mandatory input lists would not fix unsound namespace handling (Q3/B01–B02). |
| Add a key to `required_checks` for an already existing valid check | Unclassifiable | More conservative than semantic necessity, but explicitly required by brief C2 and D3 §3.2. Do not weaken it in this review. |

The fallback is conservative enough **after B02**, provided “any unhandled difference” is enforced. It is intentionally not clever about changed test programs. Keep that tradeoff rather than adding a second interpreter or model-based classifier. New checks covering already-covered criteria need not be categorically forbidden: they can add regression protection without removing the prior check. The risk is inadequate assessment, not overlap itself (F §4.1; D3 §§3.1–3.2).

### 8.3 Limits that must remain visible

D3 §6's in-process candidate execution limitation is real. A process-exit observer cannot distinguish a legitimate zero from candidate code calling `process.exit(0)` inside the same process. The reference checks should use a supervising protected program and assert child behavior, with that early-exit mutant in the project lane. This is a check-authoring and assessment obligation, not a reason to claim the engine can judge arbitrary test semantics. A successful runner self-test must never be advertised as qualification of every project's checks (D3 §2.8, Appendix B; CH 17; AH §9.9).

Operator reruns of flaky checks are likewise an explicit policy limitation, not a new pass algorithm. Keep their history visible (N03), make pending reruns block (B03), and do not automatically retry genuine test failures as infrastructure errors (§2.7). I would not add a statistical flake policy or ban reruns in M3.

No `.git` is an honest supported-toolchain boundary. A check depending on `git describe` should fail or declare an engine-supplied immutable revision value such as the existing `SURETY_SOURCE_REVISION`; do not silently mount live repository metadata to make it work. A later supported metadata projection needs its own governed contract (D3 §§2.2–2.4, 6; D2 §2.3).

The accepted M1 fixtures are not all semantically unchanged by L3 and §4.2. Requirements registered without criteria will now be uncertain; scopes with sensitive requirements/modules or raised module tiers can acquire different required sets and acceptance hashes. The Verifier must update affected fixtures and pin rejection of their former insufficient scope. A nonsensitive case with the same effective required set need not change its hash merely because this implementation is new. Test both cases instead of regenerating every expected hash without explanation (`src/store/transitions/evidence.ts` `contentHash`; D3 §§4.2–4.5; BS §4).

## 9. What I verified versus inferred

The labels have the same meanings as AH's evidence section:

| Label | Evidence in this review |
|---|---|
| **Observed this review** | Read the brief, D3 draft 1, the requested foundations/errata/design/build-spec sections, SEAM §§66–77 and 99–104, M2 acceptance plan §§2 and 5, and predecessor incident/review material. Also read the newer E87–E89 and decision preparation so accepted choices and open F2 were not mistaken for fresh design questions. |
| **Observed this review** | Inspected `src/gates/prepare.ts`, `src/protected/set.ts`, `src/store/transitions/{gates,protected,findings,evidence,baseline,queue,accept}.ts`, engine Git execution, and relevant domain-init/sandbox code. Verified the result-only selector, result-based disposition watermark, mode-free protected fingerprint, project-tier nomination, independent acceptance-hash derivation, and finalizer invalidation described above. |
| **Observed this review** | Repeated Node v22.22.0's empty/all-skipped/late-throw probes. Empty: exit 0, 0 tests. All-skipped: exit 0, 1 skipped, 0 passed. Late uncaught exception: exit 1. These were scratch fixtures, not the repository's test suite. |
| **Observed this review** | Tested a read-only bind beneath a writable directory, then the relevant overlay variant with an upper-only parent and capabilities dropped. Renaming the parent allowed replacement at the original pathname; the original protected bytes remained at the renamed mount. A lower-backed parent did not behave identically, which is why the successful upper-layer case is identified explicitly in B01. |
| **Observed this review** | In a disposable Git repository, a regular file containing `target` and a symlink to `target` had the same blob oid, `1de565933b05f74c75ff9a6520af5f9f8a5a2f1d`, with modes `100644` and `120000`. This establishes the input-identity counterexample, not an exploit of a running D3 implementation. |
| **Observed this review** | An unchanged scratch Node wrapper failed when it discovered a failing source test and returned zero when that source directory was hidden. A stronger variant refused empty discovery and retained a passing baseline test: visible source produced 2 tests/1 failure/exit 1; hidden source produced 1 test/0 failures/0 skips/exit 0. This establishes the behavioral premise of B02 even with a nonempty suite; classification and materialization follow from the draft's rules. |
| **Recorded observation** | CH §3.4's incidents, AH's predecessor runs, D2's qualification record and E88's M2 acceptance are their authors' recorded evidence. I did not repeat predecessor benchmarks, M2 qualification, real-backend runs or its full suite. |
| **Implemented** | The inspected kernel implements the cited gate/protected/decision behavior. Present source is evidence of those algorithms, not a new reliability or acceptance claim; the D3 runner/classifier are still design work under E89. |
| **Open/reported** | F2 is explicitly open in E87 item 11, E88 item 2 and decision preparation Part 4. It was not retroactively made a blocker to accepted M2 here. |
| **Recommendation/inference** | The four amendments, classifier outcomes under the written rules, test obligations and Q recommendations. No end-to-end exploit of a D3 runner, classifier or deployment path is claimed. |

Scratch directories were removed. No model, paid benchmark, qualification run, full test suite, deployment or background review agent was started. The only repository file written for this task is this review; pre-existing journal and HTML changes were preserved. E57's optional eBPF observer remains corroborating qualification evidence, never launch authority, check judgment or proof of termination.

## Questions for Sean

1. **Decide Q1–Q7 and L1–L5** using sections 4–5, and disposition B01–B04. My recommendations preserve the three E89 choices; the mount objection concerns enforcement of the promised read-only inputs, not reversal of the overlay decision.
2. **F2:** choose decision preparation Part 4 option **(c)**: the finding names the violated criterion and its resolving check must cover that criterion and be a required acceptance-origin check of the current scope, with the existing fix-candidate and post-disposition bindings. If a finding cannot name a represented criterion, leave it unresolved and route the missing verification obligation for correction; do not substitute any convenient green check. Semantic adequacy remains the Reviewer's responsibility. This is a decision for M3, as E88 already records, and T20 is its acceptance obligation.
