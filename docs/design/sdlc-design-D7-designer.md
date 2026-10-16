# D7. The Designer: the Interface Inventory, the Governed Design and the Design Review at Alpha

**Status:** Draft 1, 2026-10-16, written for Sean by the owner's assistant (no Builder, Verifier or Reviewer role) from his request of 2026-10-16 ("I think we need some sort of designer role … then work with the user on feedback or perhaps this role runs at alpha? what do you suggest?") and the driver's recommendation he approved for write-up: **two touchpoints**, an optional Designer session after the Architect and before UI stages build, and an optional design review at Alpha. **M6 scope.** Not adopted; nothing here changes M5 or its acceptance. Sean's answers to the questions at the end decide draft 2; after that, as E20 says, a later finding is an errata decision or a failing acceptance test.
**Depends on:** F v1.0 with errata E1 to E152; D1 draft 3 as corrected; D2 draft 2; D3 draft 2 with E152 item 3; D4 draft 2; **D6 draft 3** (sessions §2, products §3, the governed specification §4, planning §5, execution §6, pace §7, retrofit §8, Appendices A to C). D7 extends them and redrafts none; every rule it changes is a correction in §15 (G1 to G9).
**Scope:** a fourth interactive role, the **Designer**, as a D6 §2 session; the **interface inventory** the engine derives for it; the **design** as a governed product under `.surety/design/` with closed schemas; the design's entry into the specification and into check authoring; the **`design_ready` milestone** that holds UI stages and nothing else; a **preview environment** for mockups on the `local_service` adapter; the **design review at Alpha**; staleness under spec changes and replans; retrofit; pace. Out of scope: a browser in the engine, rendered screenshots, pixel comparison, a component library, a second UI stack's runtime previews unless Sean answers question 2 so, the UI of Surety itself (E14).
**Conventions:** as D6. "MUST" is a statement a row of Appendix C's sketch pins. References: F §n, En, D1 §n to D6 §n, TPL, IBT, SEAM §n.
**Evidence this draft rests on.** Read only, no model run for this draft: D6 draft 3; the M5 build spec §1 and §13; D1 A.8; D3 §1, §2.11 (E152 item 3); D4 §5, §9. The real runs of 2026-10-15 and 16 (E152): the visual-design brief (`~/surety-m5-physics-idea-visual.md`, requirement R8 "the page follows the design system") ran clean in visual run V1 (8.61 USD estimated), and its protected check `accept-r8.mjs` showed that **tokens-only colours, sizes, spacing and radii, AA contrast of every text token against its background token in both themes, a labelled input with units, and layout rules at a named width are checkable statically from the page's files, with no browser**; R8.5, "the look and feel … judged by a person", stayed `owed` on the pace read's `human_tests`, as did R6, R7 and R9. V1's pace read records two sessions, a Spec Writer of 2 turns in 266 s and an Architect of 1 turn in 232 s, 98 k billable, 648 k cached and 51 k output tokens together. The fixes of the same days (`aa06dcf`, `5bf01a4`: the Alpha gate's missing checks authored, not left to stall; `339e116`: a Builder writes nothing under `.surety/`; E151: each package states what the engine reads) are the three lessons §10, §3.3 and §3.4 apply.

---

## 1. The journey, with design

D6 §1's journey with the design steps inserted, for a project whose policy is `design: both`. Steps D6 already has keep their numbers' meaning; the inserted ones are lettered.

1. to 4. **As D6 §1:** the project, the Vision session (optional), the Spec Writer session and `spec_approval`, the Architect session and `architecture_approval` with phase 1's `plan_approval`. The module map now marks each module's **surface** (`ui`, `api`, `cli`, `library`, `none`) and gives every interface a UI module consumes its request and response shapes and error cases (§4.1; G1). Phase 1's plan is published as D6 §5.5; its stages that touch a `ui` module are **UI stages** (§7.1).
4a. **The engine derives the interface inventory** (§4) from the approved architecture, the spec and the environment at publication: `design.inventory_derived`. If the project's policy is not `off` and the module map has a `ui` module, it raises **`design_due`** (§10) asking the owner to open a Designer session. No model.
5. **Phase 1 opens with check authoring** as D6 §6.2. **Backend stages build** as D6 §6.3 (their milestones are D6 §6.4's two); **UI stages are held `design_pending`** (§7.2), visibly, with `design_due` open.
5a. **A Designer session** (§3): the owner and the role talk; the role writes tokens, the screen inventory and mockups in the chosen stack, fed with the engine's fixtures (§5); at each save the engine runs the **design check** (§5.4) and tells the session what failed; `surety design preview` deploys the checkpoint's mockups to the **preview environment** (§5.5) so the owner clicks through them. Close raises **`design_approval`** consolidated with a **`spec_change`** carrying the design's proposed criteria (§6).
5b. **The owner approves** (both, one batch): `design_revisions` 1, `baseline.design_approved`; the spec change's effect per D6 §4.5 (version n+1, the design criteria and the design human-test requirement registered, `check_correction` registered for the uncovered criteria). When the protected version covering the design criteria is applied, **`design_ready_at`** is set (§6.4) and the UI stages' work becomes eligible: `design.ready`, `work.dependency_met`.
6. to 11. **As D6 §1**, with the UI stages' Builders given the approved design in their packages (§7.3), and the design checks run like any other on every candidate.
12. **Alpha** as D6 §1 step 12.
12a. **The design review at Alpha** (§9): on `alpha_complete` the engine raises `design_due` (stage `alpha_review`); the owner opens a Designer session in review mode, browses the running Alpha through the operator relay (D4 Q7), and the role compares it with the approved mockups and the engine's observations of the served files. Close records the review and, if there are deltas, raises a new `design_approval` with **one** spec change carrying them; approval re-verifies and rebuilds through the ordinary path (§9.3; G7).

**Human acts the design adds:** opening the Designer session (or answering `design_due` otherwise), the consolidated `design_approval` + `spec_change`, and at Alpha the review session and its approval if it found deltas. Opening the preview is the owner's choice, not a gate. **No role approves anything** (E12), and the design moves nothing on F §9.1's floor: the criteria it proposes enter the spec only through the floor's spec approval.

---

## 2. The policy

`design` (project policy, D1 policy revision; A.7): **`off`** (default), `before_build`, `at_alpha`, `both`.

| Value | Before build | At Alpha |
|---|---|---|
| `off` | nothing; no inventory is derived; UI stages have D6's milestones only | nothing |
| `before_build` | inventory derived; `design_due` raised; UI stages wait on `design_ready` | nothing |
| `at_alpha` | inventory derived (it is the review's reference); no hold | `design_due` (`alpha_review`) raised on `alpha_complete` |
| `both` | as `before_build` | as `at_alpha` |

**Changing the value** is an ordinary policy change. Turning design on mid-project applies to UI stages not yet dispatched (a tightening; no `policy_widening`). Turning it off releases the holds and records the waiver on each held stage (`design.waived`): the design human-test requirement, if one was approved, stays visibly pending. A project with no `ui` module derives an inventory with no screens obligations and raises nothing; the policy is then inert, and `GET …/design` says so rather than showing an empty design as complete.

---

## 3. The Designer session

**3.1 A session as D6 §2, unchanged in mechanism.** A run of kind `session`, role `designer`, one capability grant, one cumulative budget, turns that are one-shot invocations with the transcript in the package, settlement before idle, save and close through the journal, idle timeout and budget exhaustion by one protocol, resume from durable records. **One open session per project** (D6 §2.7): a Designer session and a Spec Writer or Architect session never run at once on a project, and a Designer session admits no one-shot run beside it on its project (`session_busy`). That is a cost: while the owner designs, no Builder of that project is dispatched. Question 5 asks whether the Designer, which writes only `.surety/design/`, should be exempt.

**3.2 Model and limits.** `model_designer` default **Opus**, as Spec Writer and Architect (E139 Q6): design is judgement and its product is read by every UI Builder. `deadline_designer` 30 m per turn (as `deadline_spec_writer`). The session's cumulative budget is `designer_session_budget_billable_tokens`, default **3,000,000** (A.7): a trial value, double the run budget, because a mockup turn writes several files and each turn re-sends the transcript and the inventory (D6 §2.2). No figure is a measurement; §12 says what M6 records.

**3.3 What the Designer may write** (D6 §2.5's rule, enforced at save by D1 §7.3 step 1, `diff_violation` refusing the save whole): **`.surety/design/` and nothing else**, minus the engine-owned `.surety/design/inventory/` (§4.4), which it may read and may not change (`DESIGN_INVENTORY_MODIFIED`). Never source, never `.surety/spec/`, `.surety/architecture/`, `.surety/adrs/`, `.surety/roadmap/`, `.surety/phases/`, `.surety/checks/` or the policy. **The converse holds too, and is today's lesson** (`339e116`): no Builder, Verifier, Reviewer, Spec Writer or Architect may write `.surety/design/`; a Builder implements the design in source, and a finding never asks a Builder for a `.surety/design/` change. An interface the design needs that the inventory lacks is **not** the Designer's to add: it is a `requirement_conflict` or `contract_conflict` finding in the role's result (D3 X2), routed to `change_spec` or to an Architect session, and the session is told so (§4.5).

**3.4 The package states what the engine reads** (E151; M442's principle). The Designer's context package carries: the role prompt (engine-authored, D2 §1.2; the SAP's five phases recast as listen, reflect, explore, **render**, document); the transcript so far; the **interface inventory** (§4) and its fixtures; the approved spec's semantic representation (statements, criteria, marks) and the identity block's `users` and `non_goals`; the module map with surfaces; the ADRs that name the UI stack; the environment's runtime and start command (TPL §7); **Appendix B's design schemas verbatim, the design check's reason codes and what each means, the closed list of criterion kinds the Verifier can check (§6.2), the mockup kinds the stack admits, the pinned-URL rule, the configured `design_widths`**, and the engine's notes on the last save. In review mode (§9) it adds the approved design, the Alpha candidate's UI source read-only, the design checks' results on that candidate and the engine's observations of the served files. Nothing else; in particular never the Spec Writer's or Architect's transcripts (D6 §3.5's rule).

**3.5 The turn result** (B.12): `{reply, artifact_changed, questions_for_owner?, done?, findings?}`, D6 B.7's session result plus `findings` (D3 X2) for an interface or requirement the design cannot honour.

---

## 4. The interface inventory

**4.1 What the Architect now states** (G1; B.3 extended). Each module gains `surface: ui | api | cli | library | none` and, where `surface` is `ui`, `ui_stack` (closed: `html`, `html_module`, `threejs`, `streamlit`, `other`). Each interface gains `consumed_by: [module]` and, for an interface a `ui` module consumes or a `ui` module exposes, **`request`, `response` and `errors`**: shapes in the closed shape language of B.8 (types, required properties, enums, numeric and length bounds, `collection: true` on arrays) and errors as `[{code, when}]`. **Under `design` not `off`, a UI-consumed interface without them refuses the plan check** (`ARCH_INTERFACE_SHAPE_MISSING`, a new clause 5 of D6 §5.3, G2), naming the interface, so the Architect's session is told before close; under `off` they are optional. Today's `{name, kind, path?, description}` interfaces parse unchanged.

**4.2 What the engine derives** (a pure function of the approved bundle; `inventory.json`, B.9; recorded with `inventory_digest`):
- **Interfaces:** every interface whose `consumed_by` includes a `ui` module or which a `ui` module exposes, with its shapes and errors, its module and the requirements the roadmap assigns to that module.
- **UI requirements:** every requirement not withdrawn that is assigned to a phase whose modules include a `ui` module **and** that a UI stage implements, or whose subsection carries the mark `**Surface:** ui` (B.2 gains the mark, G3). The mark lets the Spec Writer name a UI requirement before any plan exists.
- **State obligations**, mechanically: `loading` for every `http` or `event` interface a `ui` module consumes; `error:<code>` for each declared error; `empty` for every response holding a `collection`; `invalid_input` for every request property with a bound or an enum; `ok` always. Each obligation names its interface.
- **The stack:** each `ui` module's `ui_stack`, the environment's runtime, and the ADR keys that name them.
- **Widths:** `design_widths` (A.7, default 360, 720, 1280 px).

**4.3 What it does not derive.** Screens. The engine cannot read screens out of prose; it derives obligations, and the Designer proposes the screens that meet them (§5.2), which the design check then holds to the obligations. Mapping a requirement to a screen is the role's claim; the check proves coverage, never that the screen is good (§14 class C).

**4.4 Fixtures.** For each interface and state obligation the engine writes deterministic fake data under `.surety/design/inventory/fixtures/<interface>.<state>.json`, generated from the shapes with a seed derived from `inventory_digest` (strings from the property name and bounds, numbers within bounds, `collection` arrays of three items and of none for `empty`, the declared error body for `error:<code>`, a value violating the first bound for `invalid_input`). It commits them with `inventory.json` as an engine `intent` revision (D1 §7.8), journaled, before the session opens. The Designer may add its own data under `mockups/data/`; every file there must validate against the shape it names (`DESIGN_FIXTURE_INVALID`). **The inventory is the contract the design is drawn against, and the Designer may not change it** (§3.3).

**4.5 When the inventory is wrong.** A missing interface, a wrong shape or a missing error case is an architecture or spec change, never a design workaround: the role reports a finding (§3.5); the engine routes `contract_conflict` to the owner's question with the options D3 X2 gives plus `architect` (open an Architect session; the route D6 §3.4 already has for a later Architect session), and `requirement_conflict` to `change_spec` (D6 §4.2). The design session may continue meanwhile; its approval is blocked while a finding it raised is open against an interface its screens use (`DESIGN_INTERFACE_DISPUTED`).

---

## 5. The design product

**5.1 Files** (`.surety/design/`; closed schemas in Appendix B):
- `design.json` (B.10): `{version, inventory_digest, stack, widths, screens_file, tokens_file, criteria_file, mockups: [...]}`, the manifest the engine reads first.
- `tokens.json` (B.11): colours as hex per theme (`light`, `dark`), font sizes, spacing, radii, durations, and **`pairs`**: every text-on-background use as `{text, background}` token names.
- `screens.json` (B.12): screens `S<n>`, each `{key, title, requirements, interfaces, states: [{obligation, mockup, fixture}], widths, notes}`.
- `criteria.json` (B.13): the criteria the design proposes, each `{requirement, text, kind}` with `kind` from §6.2's closed list.
- `mockups/`: the rendered mockups; `mockups/data/`: the role's own fixtures.
- `design.md`: prose for the owner and the Builders. Not parsed.

**5.2 Mockups in the chosen stack.** Closed kinds, by `ui_stack`: `static_html` (HTML and CSS reading `tokens.json` through a generated `tokens.css`, the role's scripts if any); `scene_html` (`threejs`: an HTML page with a module script importing three.js from a pinned URL, rendering a minimal scene or still from a fixture's time series); `stack_stub` (`streamlit`, `other`: a source file for the stack's runtime, previewed only under `design_preview: stack`, question 2). Each mockup is bound to the screen states it renders and the fixtures it reads. **External URLs** a mockup loads must name an exact version on the configured allowlist (`design_external_urls`, A.7; `DESIGN_EXTERNAL_URL_UNPINNED`): the owner's browser fetches them, the engine never does.

**5.3 The size bound.** The design tree is at most `design_tree_max_bytes` (default 16 MiB) and `design_tree_max_files` (default 400); beyond either the save is refused naming the bound. Binary images are admitted (`png`, `svg`, `webp`) and counted.

**5.4 The design check** (`checkDesign(tree, inventory)`, a pure function like D6 §5.3's, run at every save and again at close; recorded as a `design_check` record; each reason names its subjects; A.4):
1. **Schema:** every machine file parses with its closed schema (`DESIGN_SCHEMA_INVALID`, naming the field); `design.json`'s `inventory_digest` is the current inventory's (`DESIGN_INVENTORY_STALE`).
2. **References:** every requirement key is a UI requirement of the inventory (`DESIGN_UNKNOWN_REQUIREMENT`); every interface is in the inventory (`DESIGN_UNKNOWN_INTERFACE`); every mockup and fixture file named exists, and no mockup exists that no screen names (`DESIGN_MOCKUP_MISSING`, `DESIGN_MOCKUP_ORPHAN`).
3. **Coverage:** every UI requirement is on at least one screen (`DESIGN_REQUIREMENT_UNCOVERED`); every state obligation is a state of a screen that uses its interface (`DESIGN_STATE_UNCOVERED`); every screen declares every configured width (`DESIGN_WIDTH_UNCOVERED`).
4. **Tokens:** every token a pair names is defined in both themes (`DESIGN_TOKEN_UNDEFINED`); **every pair's WCAG 2 contrast ratio is at least 4.5:1 in each theme** (`DESIGN_CONTRAST_BELOW_AA`; arithmetic on the declared hex values, nothing rendered).
5. **Criteria:** every proposed criterion's `kind` is on §6.2's list or is `human` (`DESIGN_CRITERION_UNCHECKABLE`); a `tokens_only` criterion names the implemented stylesheet path the Builders will write.
6. **Stack:** each mockup's kind is admitted by its screen's module's `ui_stack` (`DESIGN_STACK_MISMATCH`); external URLs pinned (§5.2).
The check reads JSON and computes; **it executes nothing the Designer wrote** (M5 §4.1 rule 14 holds), and it does not judge a mockup's look. A failed check is the engine's entry on the next turn; close is refused until it passes, or the owner closes with `--refuse`, which records the product and raises nothing (D6 §3.4's form).

**5.5 The preview environment** (G4, a correction to D4). The owner needs to click through mockups, so the engine can serve a design checkpoint on the `local_service` adapter:
- **Environment `design-preview`**, reserved, engine-configured (no owner configuration act), one per project, adapter `local_service`, its configuration the engine's: the runtime the engine's own `node`, the start command **an engine-authored static file server** (read-only, in the engine's install, hashed), its document root the sealed design tree. The design's own code is served, never run on the host: HTML and scripts run in the owner's browser; only under `design_preview: stack` (question 2) does a `stack_stub` run, and then only as a service domain's application, as any candidate's code runs (D4 §9.2).
- **The subject is a design revision, not a candidate.** `surety design preview [--revision <checkpoint|approved>]` seals `.surety/design/` at that revision (D4 §3's sealing, same limits), deploys it through D4's operation with **no `alpha_authorize`** and **no behaviour check**: verification is the two identity reads (`tree_digest`) only. A preview deployment is never a candidate progress, never `alpha_deployed`, and never evidence for any gate. `design.preview_deployed`.
- **Admission:** `preview_memory_max` (default 256 MiB) under the envelope as built; **no shared check capacity is reserved** (no check runs on a preview), unlike E126's service. One preview generation per project; a new preview replaces the last (D4's stop-then-start).
- **Access** through the operator relay (D4 Q7), opened only by the owner's command, on `127.0.0.1`; `surety design preview` prints the URL.
- **Teardown** at the session's close plus `design_preview_ttl` (default 24 h), on a newer approved design, or by `surety design preview --stop`; D4 §4.6's rules, the unit name derived from the home as D4 §9.3.
- **Without a qualified adapter** the preview is unavailable and says why; `surety design export <dir>` always works: it writes the design tree at the named revision to a directory the owner names (a read, no host call beyond the write), and he opens the files himself.

---

## 6. Approval, and how design enters the specification

**6.1 The choice** (question 1). The design proposes criteria; the spec is the governed source of criteria (D6 §4), written only by the Spec Writer (D6 §2.5) and approved on the floor. Three ways to join them:
- **(a) Consolidated** (recommended): at close the engine files one change request (`source: design`, A.2) whose text is `criteria.json` and the design human-test requirement (§6.3); a Spec Writer one-shot writes the diff on its side ref (D6 §4.3); the impact is computed (D6 §4.4); **`design_approval` and that `spec_change` are raised under one `batch_key`** (D1 §10.3). The owner sees mockups, check record, criteria diff and impact together and answers once per decision. One spec author, one floor control, one sitting.
- **(b) Separate:** design approval first; the owner later runs a Spec Writer change himself. Simpler, but the design is approved with no criteria bound to it, and UI stages would build against a design nothing checks.
- **(c) Design-owned criteria:** the gates read `criteria.json` as a second criterion source beside the spec. Rejected: it splits the governed specification in two and bypasses D6 §4's impact and invalidation.

**6.2 What a design criterion can be** (the closed `DesignCriterionKind`, each a check the Verifier knows how to write, as V1's `accept-r8.mjs` showed; static reads of the implemented files, no browser):
`tokens_only` (every colour, font size, spacing, radius and duration literal in the named stylesheets is a custom property defined once in the tokens stylesheet); `token_parity` (the implemented tokens stylesheet defines exactly the approved `tokens.json` values for design version d); `contrast_aa` (every text colour token meets 4.5:1 against its background token in both themes); `layout_at_width` (no fixed width, min-width or grid track exceeds the named width outside a media query that excludes it); `label_with_unit` (every input has an associated label, naming its unit where the inventory's shape has one); `focus_visible` (every focusable element has a focus style not removed); `reduced_motion` (every transition and animation is disabled or reduced under `prefers-reduced-motion`); `state_rendered` (each state obligation of a screen has a reachable rendering in the implementation, by a named selector or marker); `human` (judged by a person; no check). Each criterion is written into the spec as an ordinary `R<n>.<m>` and its check is authored by the Verifier like any criterion (D6 §6.2): the design proposes; the Verifier's checks and D3 §4.2's required set decide.

**6.3 The human-test requirement.** Every approved design adds or updates one requirement: "The UI matches approved design version d: screens S1 to Sk at the configured widths" marked `**Human test.**` (B.2), assigned to the phase that holds the last UI stage. As D6 §11 class C says of every human-test requirement, it has no check and is never `verified` by a gate; it is shown pending with a reference to the approved mockups, and the review at Alpha (§9) records the owner's verdict against it (question 4).

**6.4 `design_approval`** (A.8 row, G5). Subject the design revision; binds the design version **and** the semantic bindings it was checked against: the spec version, the architecture version, `inventory_digest`, the `design_check` record's hash and the blobs of the design tree; any change stales it (D1 §4.6). **Human only; not on F §9.1's floor**, like `architecture_approval` (D6 §3.4); its criteria reach the floor through the consolidated `spec_change`. Options: `approve`, `revise` (back to a session with the owner's note: `design_due` re-raised with stage `revise`), `reject` (the product kept as history; the policy's holds remain and `design_due` stays open). **Option blockers:** the design check not passing; a finding the session raised open against an interface its screens use (§4.5); the consolidated `spec_change` answered `reject` (a design whose criteria were refused is approved only through `approve_without_criteria`, an explicit option that records the absence on the revision and in every projection). **Effect:** `design_revisions` row (A.3), `baseline.design_approved`, the stage-to-screen binding computed (§7.1), the preview's TTL restarted on the approved revision.

**6.5 Design readiness** (B07's rule applied to design). `design_ready_at` is set when the design is approved **and** the protected version that covers its criteria (the `check_correction` the spec change registered, D6 §4.5) is applied, or when the design was approved without criteria. A captured, rejected or unapplied proposal establishes nothing; the design criteria carry `ACCEPTANCE_SCOPE_INCOMPLETE` on every gate until their checks exist, as D6 §4.5 says of any uncovered criterion. `design.ready`.

---

## 7. Planning and execution

**7.1 UI stages.** A stage is a **UI stage** when any of its modules has `surface: ui`. Its **screens** are the approved screens that name a requirement the stage implements; the engine computes the binding at design approval and at each plan publication (`stage_screens`, A.3), so the first plan, approved before any design existed, needs no Architect re-entry. Plans published after a design exists may name `screens` per stage (B.5 gains the field, G6); when they do, the plan check verifies them.

**7.2 The third milestone** (D6 §6.4 extended, G6). Under `before_build` and `both`, a UI stage's `stage_build` work depends on D6's two milestones **and on `design_ready`** for every screen bound to it. Unmet, the work is held **`design_pending`** (no approved design) or **`design_stale`** (§8), recorded as `work.held` intervals like every hold (D6 §7.6). **Backend stages are untouched**: their work never waits on design, so a phase's API stages build, verify and pipeline while the owner designs. A dependant of a UI stage waits on that stage's code milestone as always; design never blocks a stage that is not a UI stage.

**7.3 Plan check additions** (D6 §5.3; G2, G6; A.4):
- clause 5, **interfaces:** `ARCH_INTERFACE_SHAPE_MISSING` (§4.1) under any `design` other than `off`;
- clause 1, **references:** a `screens` key not in the approved design is `PLAN_SCREEN_UNKNOWN`;
- clause 4, **obligations:** under `before_build` or `both`, when an approved design exists, a UI stage implementing a UI requirement that no approved screen covers is refused **`PLAN_DESIGN_UNCOVERED`**, naming the requirement. The replan's repair (D6 §5.6) cannot fix design coverage, so the blocker after its repair offers **`design`** (open a Designer session; `BlockerOption`, A.2) beside `retry`, `replan`, `cancel`. Before any design exists the clause records a **planned design obligation** per UI stage instead of refusing (the first plan's case), and the hold of §7.2 carries it.

**7.4 The Builder's package** (D6 §3.5; E151) for a UI stage adds: `tokens.json` and the generated `tokens.css` of the approved design version; the stage's screens from `screens.json` with their states and widths; the mockups and fixtures of those screens, **read-only, as reference**; the design criteria the stage's requirements carry; and the plain statement that **the Builder implements the design in source and writes nothing under `.surety/`** (`339e116`). The Verifier's phase-authoring and correction packages add the closed criterion kinds of §6.2 with what each check reads, and the implemented stylesheet paths the criteria name.

**7.5 Pace inside the phase.** With `design: before_build`, a phase whose UI stages wait costs the owner's design time on those stages only; the pace read shows it as the `design_pending` hold interval per stage and the human wait of `design_due` and `design_approval` (D6 §7.6's union rule).

---

## 8. Staleness: spec changes, architecture revisions and replans

**8.1 What a design is bound to:** the spec version, the architecture version and `inventory_digest` it was approved against (§6.4). The impact analysis of D6 §4.4 gains a **design class** (G8): the screens whose requirements are `text_changed`, `criteria_changed`, `withdrawn` or newly UI, and the screens whose interfaces changed shape.
- **An approved spec change** listing design-class subjects marks those screens `stale` (`design.stale`, the screens named), recomputes the inventory, and registers the obligation to revise them; the design's own criteria are handled by D6 §4.5 like any criterion.
- **An architecture revision** (a later Architect session, D6 §3.4) that changes `inventory_digest` marks stale the screens whose interfaces or requirements moved; a revision that leaves the digest unchanged stales nothing.
- **A replan** that only moves requirements between phases stales nothing; it recomputes `stage_screens`. A UI requirement newly assigned to a UI stage with no screen is §7.3's `PLAN_DESIGN_UNCOVERED`.
- **Stale screens hold** the UI stages bound to them that are not yet dispatched (`design_stale`) and raise `design_due` (stage `revise`) naming them (§10); stages already running or integrated keep their history (D6 §4.6's rule); their later findings and gates see the current spec as always.
- A design revision approved under the same protocol (§6) clears the staleness for the screens it covers; `design_revisions` keeps every version.

---

## 9. The design review at Alpha

**9.1 When.** Under `at_alpha` or `both`, `alpha_complete` (D4) raises `design_due` with stage `alpha_review`, bound to the Alpha's deployment and candidate. Nothing waits on it: the candidate is `alpha_deployed` and stays so.

**9.2 The session in review mode.** A Designer session whose package adds (§3.4): the approved design; the candidate's UI source, read-only; the design checks' results on the candidate; and **the engine's observations of the served files**: for every screen's route the inventory names, the response the engine fetched through the service link (D4 §5.2) at the review's start, recorded through the redactor as `observed` records within `adapter_output_max_bytes`, never fetched by the role (its domain has no reach to the service, D2 §2). The owner browses the Alpha himself through the operator relay and types what he sees. The role writes `.surety/design/reviews/review-<n>.json` (B.14): per screen `matches`, `deltas` (each delta with the owner's words, the screen and state, and whether it is a design change, an implementation defect, or both) or `not_observed`; and, if the owner agrees in the session, a **revised design** in the same tree.

**9.3 Close.** Records the review (`design_reviews`, A.3; `design.review_recorded`) and the owner's verdict against the human-test requirement of §6.3 as owner evidence bound to the candidate (provenance `claimed` by the role, confirmed by the owner's close; question 4 asks whether it may do more). Then:
- **No deltas:** nothing else.
- **Implementation defects only** (the design was right; the code is not): each is filed as a finding against the candidate (D3; severity the owner states in the session, default Medium), dispositioned by the owner; `fix` makes fix work as E43, the design criteria's checks deciding.
- **Design deltas:** close raises `design_approval` for the revised design with **one** consolidated `spec_change` (D6 §4.2's one-pending rule; the deltas are one request, not many). Approval runs D6 §4.5: version n+1, invalidation, obligations, `check_correction` for the changed criteria, and a replan.

**9.4 The rebuild after the last phase** (G7; a finding about D6 as it reads, and a decision for Sean, question 6). D6 §4.5 registers `replan` "when the impact touches the current or a later phase". After the last phase, a change to requirements of completed phases touches neither, so as D6 reads **nothing schedules the rebuild**: the affected criteria carry obligations, the runner re-runs, and a check that now fails has no stage to repair it: a silent stall of exactly the kind the real runs found worst. G7 closes it for every spec change, not only design: an approved change whose impact names a requirement of a completed phase, with no open phase, registers `replan` with trigger `post_phase_change` (`ReplanTrigger`, A.2), and the Architect's result adds a **delivery phase** to the roadmap for the affected requirements; the roadmap change routes to `plan_approval` (D6 §5.4), and the new phase's stages rebuild and re-verify through the ordinary path, then Alpha under the project's `alpha_deploy`.

---

## 10. No silent stalls

The real runs' worst failures were stalls with nothing asked (`aa06dcf`, `5bf01a4`, the owed-finding rules of E152 item 2). D7's rule: **no design hold exists without an open owner question naming it.**
- **`design_due`** (A.8 row; subject the project; human only): raised when a UI stage is first held `design_pending` or `design_stale`, when a design is rejected or sent back for revision, and on `alpha_complete` under `at_alpha`/`both`. Its question names the held stages, the stale screens, and the exact command (`surety session open designer`). Options: **`open`** (allocates the Designer session, D6 §2.1: no process starts until the owner's first turn); **`waive`** (the named UI stages proceed with no design; recorded on each stage with the owner's reason, `design.waived`; the design human-test requirement, if any, stays pending); **`policy_off`** (sets `design: off`, a policy revision); **`later`** (re-raises at a target time the owner gives, at most `design_due_max_defer`, default 7 d). One `design_due` is open per project at a time; a new cause updates its subjects, which stales and re-raises it (D1 §4.6), never a second row.
- **Escalation:** `target_seconds` 2 d (A.8's approvals default); `decision.escalated` as D1 §10.
- **A Designer session that ends without a product** (idle timeout, budget exhaustion, a close with `--refuse`) leaves `design_due` open and says so on the next read; it never closes the question.
- **A held UI stage's pace** is the `design_pending` interval; `GET …/plan` shows each held stage with its hold, the open question and its age.
- **The engine never answers `design_due`** and no harness default does outside the scripted human acts of the test seam (M5 spec §8's form).

---

## 11. Retrofit (D6 §8)

An adopted repository with an existing UI captures its design as **observed**. A Designer session in retrofit mode (a package variant, as D6 §8.2) reads the UI source and writes tokens extracted from the existing stylesheets, a screen inventory of the existing routes and templates mapped to the confirmed requirements, and mockups that are **copies of the existing pages as static files** where the stack allows (none otherwise); `design.json` carries `origin: observed`. Its approval is `design_approval` as §6.4 with the origin shown; its proposed criteria go through the same consolidated spec change, but **are scheduled to the first change phase, never to the conformance set** (B11's reasoning: the conformance phase carries the code unchanged, and a design criterion the adopted code fails would block conformance on an aspiration). An owner's intended design change is an `intended` requirement in a later phase, delivered as any. The interface inventory of an adopted repository needs the Architect's retrofit module map to state shapes (§4.1); where it cannot, the inventory lists the interface with `shape: unknown` and the design check reports every screen using it (`DESIGN_INTERFACE_SHAPE_UNKNOWN`), which blocks approval under `before_build` and is shown under `at_alpha`. Unknown is a value; the engine does not invent a shape.

---

## 12. Pace and cost

**What it costs, by construction.** One Designer session per design revision (Opus), usually one before build and at most one per Alpha review; one Spec Writer one-shot per consolidated change; one `check_correction` Verifier run for the design criteria; the checks themselves cost no model. A session's turns re-send the transcript and the inventory (D6 §2.2), and mockup turns write more output than the Architect's: V1's Architect session was one turn of 232 s with the Spec Writer's two turns 266 s, sessions together 98 k billable, 648 k cached and 51 k output tokens. **No Designer figure exists yet**; that comparison suggests a design session of several turns at a few minutes each, which is a guess for planning the real run, not a claim.

**What the pace read adds** (D6 §7.6, as projections from recorded events, `unknown` where an observation is missing): per project, `baseline.spec_approved` → `baseline.design_approved` → `design.ready`; per session, the Designer's turns, time and tokens with `cached_in` apart; per UI stage, the `design_pending` and `design_stale` intervals; per preview, the deploy's time and its domain's `memory.peak`; per review, its time and the deltas by kind. M6's real run (C-sketch M519) records them, so `designer_session_budget_billable_tokens` and `preview_memory_max` are revisited on measurements.

---

## 13. Boundary and security notes

The Designer's turns are `role` domains with D2's mount plan and the proxy as their only egress; nothing changes there. **Mockups are role-written code.** The engine parses the design's JSON with closed schemas and executes none of the tree (§5.4). The preview's server is the engine's own, read-only and hashed; the design tree is served as data. Mockup scripts run in the **owner's browser**, at the relay's `127.0.0.1` origin: the engine's API is a unix socket the browser cannot reach, and the operator relay is opened only by the owner's command, but a mockup script can reach any other service listening on the owner's loopback, as any page he opens can; the pinned-URL allowlist bounds what it loads, not what it does (§14 class C). Under `design_preview: stack` a stub runs only as a service domain's application with D4 §9.2's isolation. Fixtures are engine-generated or validated against the inventory's shapes, so no fixture carries a real record; the owner's typed feedback is redacted as every transcript (D1 §14.2). The engine's fetches of the Alpha's served files for review go through the service link and the redactor, bounded, and are records, never instructions to the role (D2 §2.1).

---

## 14. What D7 does not claim

**Class A.** An owner who approves a design he did not look at; a Designer that draws what the owner asks when he asks for something unwise.

**Class B, not built.** Rendered screenshots, pixel or perceptual comparison of Alpha against mockups, and any browser in the engine or the check toolchain (question 3); previews that run a stack's runtime unless question 2 is answered so; design for more than one UI stack per module; a component library or design-token export to a third-party tool; designs for Beta or Live; the Designer exempt from session exclusivity (question 5).

**Class B, not yet established:** that a Designer session produces a design an owner approves, that a mockup in the chosen stack is faithful to what that stack can build, that a UI Builder given the design implements it, that §6.2's static checks catch what a person would call off-design, that the design session's cost is near §12's guess. Each is the real run's to show (M519), and none is a property a test can pin.

**Class C.** **Coverage is not quality:** the design check proves that every UI requirement and state obligation has a screen and that every declared text pair meets AA arithmetically; it never proves a screen is usable or beautiful. **Static checks are approximations:** `layout_at_width` reads CSS rules, not a rendering; a layout broken by content length or a script is invisible to it; contrast is checked on declared token pairs, not on every pixel (an image or a gradient behind text is not seen). **The human-test requirement** stays pending until the owner judges it, and the review's verdict is his word, recorded. **Mockup scripts** run in the owner's browser with that origin's reach to his loopback (§13). **Fixtures** are plausible data from shapes, not representative data; a design that looks right with three items may not with three thousand. **The inventory** is as good as the Architect's shapes; an undeclared error case has no `error` state obligation.

---

## 15. Corrections to D3, D4, D6 and the engine as built

| # | D3, D4, D6 or the engine says | Correction | Sketch |
|---|---|---|---|
| G1 | D6 B.3: a module `{name, paths, sensitive_areas, tier_override?, interfaces: [{name, kind, path?, description}]}` | modules gain `surface` and, for `ui`, `ui_stack`; interfaces gain `consumed_by`, `request`, `response`, `errors` in B.8's shape language; old files parse unchanged | M501 |
| G2 | D6 §5.3: four clauses, sixteen reasons | clause 5, `ARCH_INTERFACE_SHAPE_MISSING` under `design` not `off`; clause 1 gains `PLAN_SCREEN_UNKNOWN`; clause 4 gains `PLAN_DESIGN_UNCOVERED` and the planned design obligation | M508 |
| G3 | D6 B.2: the marks `**Human test.**` and `**Descriptive.**` | adds `**Surface:** ui` | M502 |
| G4 | D4 §4: a deployment's subject is a candidate under `alpha_authorize` | a **preview deployment** whose subject is a design revision, to the reserved engine-configured environment `design-preview`, verified by identity reads only, never a candidate progress, no check capacity reserved | M510, M511 |
| G5 | D1 A.8: no design kinds | `design_approval` (design revision; binds version, spec, architecture, inventory digest, check hash, blobs; 2 d) and `design_due` (project; binds the held stages and stale screens; 2 d) | M505, M514 |
| G6 | D6 §6.4: two dependency milestones; B.5's stage | a third, `design_ready`, for UI stages under `before_build`/`both`; holds `design_pending`, `design_stale`; B.5 stages gain `screens?` | M507 |
| G7 | D6 §4.5: `replan` registered when the impact touches the current or a later phase | also when it names a requirement of a completed phase and no phase is open: trigger `post_phase_change`, a delivery phase added by roadmap revision (**decision for Sean**, question 6) | M517 |
| G8 | D6 §4.4: classes requirements, checks, ADRs and architecture, stages and roadmap, evidence, work | adds the design class: stale screens by requirement and by interface shape | M515 |
| G9 | D6 §2.5: permitted paths of three roles; D6 B.7 | the Designer's paths (`.surety/design/` less `inventory/`); every other role refused `.surety/design/`; the Designer turn result with `findings` | M503 |

---

## Appendix A. Closed enumerations, added

**A.1 Id prefixes.** `dsg_` design_revisions, `dchk_` design_checks, `drv_` design_reviews.

**A.2 Enumerations.**
- **RoleKind:** designer, added. **RunKind:** session, as D6.
- **DesignPolicy:** off, before_build, at_alpha, both. **DesignPreviewPolicy:** off, static, stack.
- **ModuleSurface:** ui, api, cli, library, none. **UiStack:** html, html_module, threejs, streamlit, other.
- **MockupKind:** static_html, scene_html, stack_stub. **DesignOrigin:** intended, observed.
- **StateObligation:** ok, loading, empty, invalid_input, error:<code>.
- **DesignCriterionKind:** tokens_only, token_parity, contrast_aa, layout_at_width, label_with_unit, focus_visible, reduced_motion, state_rendered, human.
- **ScreenStatus:** current, stale. **DesignRevisionStatus:** proposed, approved, approved_without_criteria, rejected, superseded.
- **ReviewVerdict:** matches, deltas, not_observed. **DeltaKind:** design, implementation, both.
- **SpecChangeSource:** design, design_review, added. **ReplanTrigger:** post_phase_change, added (G7).
- **WorkItem hold:** design_pending, design_stale, added. **BlockerOption** (replan): design, added.
- **DecisionKind:** design_approval, design_due, added. **DesignDueStage:** before_build, revise, alpha_review. **DesignDueOption:** open, waive, policy_off, later.
- **RecordKind:** design_check, design_inventory, design_observation, added.
- **EventType, added:** `design.inventory_derived`, `design.checked`, `design.approved`, `design.rejected`, `design.ready`, `design.stale`, `design.waived`, `design.preview_deployed`, `design.preview_torn_down`, `design.review_recorded`.

**A.3 Tables and fields.**
- **design_revisions:** `id`, `project`, `version`, `git_path` `.surety/design/design.json`, `tree_blob`, `origin`, `spec_revision →spec_revisions`, `architecture_revision`, `inventory_digest`, `design_check →design_checks`, `status`, `approved_by`, `approved_at`, `ready_at`, `supersedes`.
- **design_screens:** `design_revision`, `key`, `requirements []`, `interfaces []`, `status =ScreenStatus`, `stale_reason?`.
- **stage_screens:** `stage →stages`, `screen`, `design_revision`, computed at design approval and plan publication.
- **design_checks:** `id`, `tree_revision`, `inventory_digest`, `outcome passed | refused`, `reasons [{code, subjects}]`.
- **design_reviews:** `id`, `design_revision`, `candidate`, `deployment_attempt`, `verdicts [{screen, verdict, deltas}]`, `change_request? →spec_change_requests`, `findings []`.
- **phase_plans:** unchanged. **projects:** `design_inventory_digest`.

**A.4 Reason codes, added.** Design check: `DESIGN_SCHEMA_INVALID`, `DESIGN_INVENTORY_STALE`, `DESIGN_INVENTORY_MODIFIED`, `DESIGN_UNKNOWN_REQUIREMENT`, `DESIGN_UNKNOWN_INTERFACE`, `DESIGN_MOCKUP_MISSING`, `DESIGN_MOCKUP_ORPHAN`, `DESIGN_REQUIREMENT_UNCOVERED`, `DESIGN_STATE_UNCOVERED`, `DESIGN_WIDTH_UNCOVERED`, `DESIGN_TOKEN_UNDEFINED`, `DESIGN_CONTRAST_BELOW_AA`, `DESIGN_CRITERION_UNCHECKABLE`, `DESIGN_STACK_MISMATCH`, `DESIGN_EXTERNAL_URL_UNPINNED`, `DESIGN_FIXTURE_INVALID`, `DESIGN_INTERFACE_DISPUTED`, `DESIGN_INTERFACE_SHAPE_UNKNOWN`. Plan: `ARCH_INTERFACE_SHAPE_MISSING`, `PLAN_SCREEN_UNKNOWN`, `PLAN_DESIGN_UNCOVERED`.

**A.5 Transitions, added.** **Design revision:** proposed (a checkpoint, no effect) → approved | approved_without_criteria | rejected; approved → superseded. **Readiness:** approved → ready (the covering protected version applied, or no criteria). **Screen:** current → stale (G8) → current (a covering revision approved). **Preview:** as D4's deploy operation, with no authorization step and verification by identity reads only.

**A.6 Error codes, added.** `design_check_failed` (422, with reasons), `design_tree_too_large` (413), `design_preview_unavailable` (409, naming the cause: adapter unqualified, policy `off`, no design revision), `design_generation_stale` (409).

**A.7 Configuration keys, added.**

| Key | Scope | Default | Range |
|---|---|---|---|
| `design` | project | off | off, before_build, at_alpha, both |
| `design_preview` | project | static | off, static, stack |
| `design_widths` | project | [360, 720, 1280] | 1 to 6 widths, each 240 to 3840 px |
| `design_external_urls` | project | cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com; exact versions only | a list of hosts |
| `model_designer` | project | Opus (as Q6) | an active entry's model |
| `deadline_designer` | project | 30 m per turn | 5 to 180 m |
| `designer_session_budget_billable_tokens` | project | 3,000,000 (a trial value) | 250,000 to 20,000,000 |
| `design_tree_max_bytes`, `design_tree_max_files` | project | 16 MiB, 400 | 1 to 64 MiB, 50 to 4,000 |
| `preview_memory_max` | project | 256 MiB | 64 MiB to `domain_memory_max` |
| `design_preview_ttl` | project | 24 h | 1 h to 14 d |
| `design_due_max_defer` | project | 7 d | 1 h to 30 d |

**A.8 Routes and CLI, added.** `GET /v1/projects/:p/design` (inventory, revisions, screens with status, holds, open `design_due`); `POST …/design/preview {revision}`, `DELETE …/design/preview`; `GET …/design/export?revision=` (the tree as an archive); sessions as D6 A.8 with role `designer` and `mode: review` for §9. CLI: `surety session open designer [--review]`, `surety design show|preview [--stop]|export <dir>`.

---

## Appendix B. The machine files, added (closed schemas; unknown fields refused)

**B.8 Shape language** (interfaces, G1): `{type: object | array | string | number | integer | boolean | null, properties?: {<name>: shape}, required?: [], enum?: [], minimum?, maximum?, minLength?, maxLength?, items?: shape, collection?: bool, unit?: string}`. No references, no unions beyond `null` in `type` as a list of two.

**B.9 `.surety/design/inventory/inventory.json`** (engine-written): `{inventory_digest, spec_version, architecture_version, stack: [{module, ui_stack, runtime, adrs: []}], widths: [], ui_requirements: [{key, phase, modules: []}], interfaces: [{name, module, kind, path?, request?, response?, errors: [{code, when}], shape_known: bool}], obligations: [{interface, state}], fixtures: [{interface, state, path}]}`.

**B.10 `.surety/design/design.json`:** `{version, origin: intended | observed, inventory_digest, stack: [{module, ui_stack}], widths: [], tokens_file, screens_file, criteria_file, mockups: [{path, kind =MockupKind, screens: [], external_urls: []}]}`.

**B.11 `tokens.json`:** `{themes: {light: {<token>: "#rrggbb"}, dark: {...}}, font_sizes: {<token>: "<n>px|<n>rem"}, spacing: {...}, radii: {...}, durations: {<token>: "<n>ms"}, pairs: [{text, background}]}`; colour tokens named `--color-*`, the others by their group's prefix (`--font-size-*`, `--space-*`, `--radius-*`, `--duration-*`).

**B.12 `screens.json`:** `{screens: [{key: "S<n>", title, requirements: [], interfaces: [], states: [{obligation: {interface, state}, mockup, fixture}], widths: [], notes?}]}`. **Designer turn result:** `{reply, artifact_changed: bool, questions_for_owner?: [], done?: bool, findings?: []}` (findings as D3 X2).

**B.13 `criteria.json`:** `{criteria: [{requirement: "R<n>" | "new", text, kind =DesignCriterionKind, paths?: [], width?: px}], human_test: {text, screens: []}}`.

**B.14 `reviews/review-<n>.json`:** `{design_version, candidate, screens: [{key, verdict =ReviewVerdict, deltas: [{state?, owner_words, kind =DeltaKind}]}], revised_design: bool}`.

---

## Appendix C. Acceptance-row sketch (M6; rows, not tests)

Lanes as M5's: kernel, sandbox, project, real. Every journey row runs the production paths only (M5 §4.1 rule 20).

| Row | Pins | Lane |
|---|---|---|
| M501 | B.3's new fields parse; old module maps parse unchanged; unknown fields refused | kernel |
| M502 | `**Surface:** ui` parsed into the representation; a UI requirement derived from it before any plan | kernel |
| M503 | The Designer's save outside `.surety/design/`, or inside `inventory/`, is refused whole; a Builder's or Architect's write to `.surety/design/` is `diff_violation` | kernel |
| M504 | The inventory is a pure function of the bundle; every state obligation derived as §4.2; fixtures deterministic per digest and valid against their shapes | kernel |
| M505 | Close raises `design_approval` and one `spec_change` under one batch; each option blocker of §6.4; a save after preview stales it | kernel |
| M506 | Each design-check reason (§5.4) fires on a minimal fault and names its subject; AA contrast computed on declared pairs; nothing in the tree is executed (process inventory) | kernel |
| M507 | UI stages held `design_pending`; backend stages of the same phase build and pipeline meanwhile; `design_ready` set only on the covering protected version's application | kernel |
| M508 | `ARCH_INTERFACE_SHAPE_MISSING`, `PLAN_SCREEN_UNKNOWN`, `PLAN_DESIGN_UNCOVERED`; the first plan records a design obligation instead | kernel |
| M509 | The UI Builder's package holds the approved tokens, its screens, mockups and the `.surety/`-is-not-yours statement; a backend Builder's holds none | kernel |
| M510 | `surety design preview` deploys a checkpoint to `design-preview` on a real unit, verified by two identity reads, no `alpha_authorize`, no check capacity reserved; teardown leaves nothing of the prefix | sandbox |
| M511 | A preview is never a candidate progress or gate evidence; without a qualified adapter it is `design_preview_unavailable`, and export works | kernel |
| M512 | `design_due` opens with every hold; its four options; one open per project; a session ended without a product leaves it open; escalation | kernel |
| M513 | Policy changes: on mid-project holds undispatched UI stages only; off releases and records waivers | kernel |
| M514 | `design_due` and `design_approval` bindings and staleness per D1 §4.6 | kernel |
| M515 | A spec change and an architecture revision stale exactly the screens of G8, hold their undispatched UI stages `design_stale`, raise `design_due`; a phase move stales nothing | kernel |
| M516 | The review at Alpha: the engine's served-file observations in the package, the role unable to reach the service; verdicts recorded; deltas filed as one change; implementation defects as findings | project |
| M517 | G7: a change touching only completed phases registers `post_phase_change` and a delivery phase; nothing stalls silently | kernel |
| M518 | Retrofit: an observed design's criteria scheduled outside the conformance set; `shape: unknown` reported, never invented | kernel |
| M519 | Real: one project with a UI module under `design: both`, a real Designer session before build and at Alpha, to `alpha_deployed` and the review; pace and cost recorded | real |

---

## Questions for Sean

1. **How design criteria enter the spec** (§6.1). Recommended (a): the design's criteria and its human-test requirement become one spec change written by a Spec Writer one-shot and raised with `design_approval` under one batch, so the spec keeps one author and one floor control. (b) separate later spec change; (c) design-owned criteria read by the gates beside the spec.
2. **Preview runtime** (§5.2, §5.5). Recommended: M6 serves **static** previews only (HTML, CSS, module scripts and three.js scenes run in your browser from the engine's static server); `stack_stub` mockups (Streamlit and the like) are written but shown as source until a later milestone runs them as a service domain's application, which needs the stack's runtime qualified like D4's. Or build `stack` in M6.
3. **A browser for checks** (§6.2, §14). The visual run showed tokens, contrast, labels and width rules are checkable from files. Rendered checks (computed layout at 360 px, real contrast over images, screenshots for the review) need a headless browser in the **check** toolchain: a project dependency inside check domains, never an engine dependency. Recommended: not in M6; keep the static kinds and the human test. Or admit a pinned headless browser as a qualified check runtime.
4. **What the Alpha review's verdict may do** (§6.3, §9.3). Today a human-test requirement is never `verified` by a gate (D6 §11 class C). Recommended: the review records your verdict as evidence shown on the requirement, and the gate semantics stay. Alternative: a `human_confirm` that lets your recorded verdict, bound to the candidate's acceptance content hash, verify a human-test requirement, a change to D1 §9 and D3 §4.
5. **Session exclusivity for the Designer** (§3.1). D6 §2.7 allows one session per project and no one-shot beside it, so while you design, no Builder of that project runs, which cuts against "design need not block the backend". The Designer writes only `.surety/design/`, which no other role may touch (G9). Recommended: exempt the Designer, so a Designer session may run beside one-shot runs (never beside another session), its saves serialized on the integration lease like any commit. Or keep the rule and accept the pause.
6. **G7, the rebuild after the last phase** (§9.4). As D6 §4.5 reads, an approved spec change touching only completed phases registers no replan, so a criterion that now fails has no stage to fix it. This is a gap in D6 for every late change, found by working through the Alpha review; D7 proposes the fix rather than claiming it was observed in a run. Recommended: G7 as written, a `post_phase_change` replan that adds a delivery phase, routed to `plan_approval`; applied to M5's engine now as an errata decision, with M517 as its failing test, or left for M6.
