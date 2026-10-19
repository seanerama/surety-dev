# What M6 does not claim

**Written by:** the Verifier of M540, 2026-10-19, on branch `verify/m540` from `main` at `4e05624`, completed from `main` at `5521699`, after the two real runs (M519 10 of 10, last judged at `308230d`; M535 12 of 12, last judged at `def6afd`) and the final split gate (`12ee772`, E170; merged at `19afc9f`; the M6 report, section 12). The exhaustion lane at `4e05624` passed, 15 of 15 in 5 files (the M6 report, section 14); it has not been run at `19afc9f`, after F8's fix. **Status:** the list behind the M6 report's section 27 (row M540; BS6 §13: "what M6 does not claim (`M6-not-claimed.md`, in `M5-not-claimed.md`'s form, starting from D7 §15)"); it decides nothing. An entry whose standing depends on a run names the run and its record; nothing here says a run passed that the M6 report does not record.

The classes are D7 §15's: **class A**, outside the threat model; **class B**, real behaviour no test has yet established, or that M6 does not build; **class C**, a limitation accepted by design. Each entry names its row where one bears on it, and the record that put it here.

## 1. What the real runs do not show

| Entry | Row(s) | Record |
|---|---|---|
| **That Sean made M519's acts, or M535's acts other than his four central ones and the asset-only approval.** Every M519 act and every other M535 act was the driver's, on Sean's quoted instructions in `observed/driver-acts.jsonl`; the store records each answer's actor as `human` and each session's owner turns as `owner`, the route, not who. M519's Designer feedback, preview inspection, combined approval and review confirmation were the driver's words and reads. | M519 (i), M535 (l) | the M6 report, section 19; E156 Q6 |
| **What Sean looked at in the preview.** His entry says "checked all the mockups. they look good"; the relay records its opening and closing (12:26:46 to 12:49:22 UTC), not the paths served (`relay_requests` `unknown`). That he opened the android simulation in its frame is his word only. | M535 (l) | the M6 report, section 19 |
| **That anything was rendered.** Every review delta and every driver inspection of both runs rests on HTTP reads of HTML, CSS and scripts; M519's verdicts say `observed_on: browser` because the schema has no value for a read that rendered nothing. R7.1 and R8.20 (M519) were not observed. | M519 (f), M535 (h) | E165 item 6; E168 item 2 |
| **That M535's web human test rests on engine observation.** Review 1's engine-observed web verdict was struck by mistake; the web human test R6 carries review 2's verdict, `owner_reported`, on a subject recorded `owner_build` (the same Alpha candidate), with no evidence record. | M535 (h) | E168 items 2, 3 |
| **That the approved logo reached the Alpha.** M535's Alpha was deployed under policy at 13:24 UTC with the placeholder and not redeployed after the asset-only approval (15:00); the approved logo reached `main` (`53efa50`), the parity checks and the bindings, not the served Alpha. | M535 (e) to (g) | E168 item 1 |
| **A clean M6 run.** M535 passed its design step by a governed Architect correction around F5, judgement (a) was amended by Sean before it was re-judged, and F6 and F7 were fixed during the run; M519's design step was rerun after F1. Neither run is clean under E152 item 1. | M519, M535 | E164 to E168 |
| **The final engine on a real run.** The runs ran at `0824dff` to `308230d` (M519) and `8cffaf0` to `def6afd` (M535); F5's fix (`d91492c`) is exercised by M504, M506 and M508 only, F8's (`19afc9f`) by M510 (h) only. | M504, M506, M508, M510 | the M6 report, section 2 |
| **The preview's memory (finding F8).** No real preview's `memory.peak` was read before its removal in either run (`unknown` in all four, null in the store); both runs are recorded unmeasured. F8 is fixed at `19afc9f` (E170, Sean's ruling) and pinned by M510 (h) on the real unit; **the first measurement is the next clean real run's, so no real preview's peak, and no revisit of `preview_memory_max` (256 MiB) on a measurement, is claimed.** Service domains' peaks are not recorded either (33 domains, none). | M510 (h), M519 (g), M535 (i), M539 | the M6 report, sections 20, 21 |
| **That the Alpha's differences are repaired.** M519's 24 findings and M535's four are accepted unresolved differences; M519's carry an erroneous association (R8.19, `design-asset-favicon`) the store keeps. | M516, M531 | E166 items 1, 5; E168 item 3 |
| **The android target beyond its source and a labelled simulation.** `not_observed: no_native_runtime`; its human test pending; its cross-target behaviour unverified (E162 item 3). | M535 (h) | E162 item 3 |
| **The project-lane journeys' pace figures.** M536 and M516 passed; their reads' figures were not retained. | M536, M516 | the M6 report, section 13 |
| **The token's absence from any conversation.** The runs' searches (run directory, repositories, unit properties, journals, transcript records) and the report's search of the copied records found no hit; a conversation the value may have passed through is outside every searched source. | M519 (g), M535 (i) | the M6 report, section 22 |
| **The dress rehearsal** is never evidence: it cannot show the subscription mode, what a real model does with its package, or how long anything takes. | M537 | SEAM §171 |
| **The hands-on run.** No record of Sean's run of `M6-hands-on.sh`; its form and guards are M541's. | M541 | the M6 report, section 30 |

## 2. D7 §15, class A

| Entry | Record |
|---|---|
| An owner who approves a design he did not look at, or a simulation he took for the device. | D7 §15 |
| A Designer that draws what the owner asks when he asks for something unwise. | D7 §15 |
| As D2 §8 and D6 §11 class A, a compromised operator account included. | D6 §11 |

## 3. D7 §15, class B: not built in M6

| Entry | Record |
|---|---|
| **Native preview or execution** for `android`, `ios`, `macos`, `windows` or `linux`: no emulator, simulator, device runner or desktop build in the preview or the review. | D7 §15; BS6 §1 |
| **Native building, packaging and device testing** of any target; packaging checks against platform guidance; any store submission. The owner-invoked review records his build and evidence; it builds and runs nothing. | D7 §15, §6.6, §10.5 |
| **Native checks of §5.3's conventions**: each recorded `not_checkable_yet` (M535: android 3, web 2). | D7 §5.3; M524 |
| **A browser** in the engine, the preview's checks or the check toolchain; **rendered screenshots, pixel or perceptual comparison** (question 3; reserved). | D7 §15; BS6 §4.1 rule 22; M506 (h), M521 |
| **Image generation**, and any raster asset the Designer could draw. | D7 §15 |
| **Token bindings generated for Swift, Kotlin or Dart**: Builders read the neutral file. | D7 §15 |
| **Previews that run a technology's runtime** (`stack` refused, E156 Q4); Streamlit and Flutter web previews are labelled simulations. | E156 Q4; M504 (c), M511 (b), M520 |
| **A component library or design-token export** to a third-party tool. | D7 §15 |
| **Designs for Beta or Live** beyond §6.7's hook (`assets_required_for`, inert until D5). | D7 §6.7; M534 |
| **D5** (Beta, Live, rollback, reattachment, remote targets) and **D8** entirely (the portfolio and idea intake; its question 12 and milestone placement open). | E155 item 1; BS6 §13 |
| **Held turns for Vision, Spec Writer and Architect** on a day limit: M5's refusal stays for them. | E162 item 4 |
| **A governed route for adding or correcting an existing finding's verification links.** | E166 item 3 |
| **Surety's own UI**; the throughput benchmark (E130 item 9). | BS6 §§10, 13 |

## 4. D7 §15, class B: not yet established

Each is the real runs' to show and none is a property a test can pin. Two runs give one figure each, on two small projects (the M6 report, sections 16 to 21); none is a claim.

| Entry | What the runs recorded | Record |
|---|---|---|
| That a Designer session produces a design an owner approves | M519: one session of 3 turns, approved by the driver; M535: Sean's first session refused by F5, his second (1 turn) saved and approved by him | sections 16, 18 |
| That a simulated mockup is faithful to what the native technology can build | android mockups in the labelled frame; nothing native run | section 18 |
| That a UI Builder given the design implements it | M519's review found 21 implementation and 3 `both` differences across three labs; M535's four | sections 16, 18 |
| That D7 §7.2's static checks catch what a person would call off-design | every design check passed while the reviews found differences | sections 16, 18 |
| That a design session costs near D7 §13's guess | Designer sessions 0.68 to 5.12 USD; the highest 271,180 billable tokens (9.0 % of the budget) | section 21 |
| That Builders' declared bindings are where the app loads its assets | M535's bindings `public/assets/logo.svg` (`copy`) and `android/assets/logo.png` (`derived`); parity passed; the served Alpha still showed the placeholder | section 18 |
| That a preview fits `preview_memory_max` | not measured in either real run (F8, fixed at `19afc9f` after them; the next clean real run measures it) | section 21 |

The defaults `designer_session_budget_billable_tokens` (3,000,000) and `preview_memory_max` (256 MiB) are trial values (E156 Q4), unchanged.

## 5. D7 §15, class C

| Entry | Record |
|---|---|
| **Coverage is not quality:** the design check proves that every UI requirement, state obligation and required convention has a screen and a declaration on each target, and that every declared text pair meets AA arithmetically; never that a screen is usable or beautiful, nor that a declared back destination or safe-area rule is honoured. | D7 §15 |
| **A simulation is a drawing:** the label says so; a simulated permission prompt or back gesture shows intent, not behaviour; a verdict given on one is recorded as such. | D7 §15 |
| **Static checks are approximations:** `layout_at_width` reads CSS rules, not a rendering; contrast is checked on declared token pairs, not on every pixel; `state_marker_present` proves a marker exists, not that the state is reached. | D7 §15 |
| **Asset checks read headers:** format, size and alpha channel, never what the image shows or whether it is legible small; `transparency: forbidden` refuses an alpha channel even when every pixel is opaque. | D7 §15 |
| **Placeholders may reach Alpha and Beta**, by design (M535's Alpha did). | D7 §6.7; E168 item 1 |
| **Bindings are declarations:** a `copy` binding is digest-checked at integration; that the app shows the file is the human test's to judge; a `derived` binding is recorded with its source version and never compared. | D7 §15 |
| **Owner builds and device evidence are his word**, recorded owner-supplied, never as the engine's observation. | D7 §15 |
| **The human-test requirements** stay pending until the owner judges them; the review's verdict is his word, recorded. Both runs' human tests are pending. | D7 §15; the M6 report, sections 16, 18 |
| **Mockup scripts** run in the owner's browser with that origin's reach to his loopback; a native mockup is served from the same origin as the frame and could remove its banner (E159 item 7). | D7 §14, §15 |
| **Fixtures** are plausible data from shapes, not representative data. | D7 §15 |
| **The inventory** is as good as the Architect's shapes and permissions; an undeclared error case or permission has no state obligation; an unshaped interface a `ui` module consumes or exposes is now refused at the plan check (E169). | D7 §15; E169 |

## 6. Carried to the report by the runs

| Entry | Record |
|---|---|
| F8: the preview's `memory.peak` not read before removal in either run (section 1 above); decided by Sean (E170): fixed at `19afc9f`, the measurement left to the next clean real run. | E170; the M6 report, section 21 |
| The exhaustion lane ran at `4e05624`, before F8's fix; not rerun at `19afc9f`. | the M6 report, sections 14, 31 |
| The review schema has no `observed_on` value for a read that rendered nothing. | E165 item 6 |
| Owner acts with no store event of their own: the Alpha inspection, the review session. | E165 item 9 |
| A real run on a new engine build must re-qualify `local_service` before any preview or Alpha; only the engine's refusal says so. | E165 item 9 |
| The relay and the preview server record no request paths. | the M6 report, section 19 |
| A runnable example line in the driver's instructions struck a verdict (E168 item 2): an act made by Sean on the driver's text. | E168 item 2 |
| The items E157 item 3, E160 item 8, E161 item 6, E163 item 7, E164 item 4 and E166 item 4 record for Sean, not decided. | the M6 report, section 29 |
| E159 item 9: one `/var/tmp/surety-integ-*` home left per gate on `mini-hp01`, untraced. | E159 item 9 |
| **The host's clock steps** after `wsl --shutdown`; wall-clock timestamps are no more exact than it; durations are monotonic. | BS6 §4.1 rule 17 |
| The store's `engine_version` reads `0.0.0`; the revision is `engine_revision` (M544). | the M6 report, section 2 |

## 7. Carried from earlier milestones, not re-planned

`M5-not-claimed.md` stands, unchanged by M6, except where M6 builds what it listed: M542 to M546 fix the five engine defects it carried (the observed model, the held replan, the engine's revision, the retired phase verification, the redundant disposition question), and the real-lane rule 25 meets M444's left-open blocker (BS6 §11.3). M5's other open gaps (#6, #15, #18, #19, #20, L1-3, the Spec Writer reading `phase_size` as a cap) are not M6's and stay as M5 lists them (BS6 §11.3). M4's and earlier milestones' lists stand through M5's. **Load-sensitive under E150 item 6** (the M6 report, section 12): M440, M15, M311 (h), M29, M338, M70, M08, M401, M104, M432, M61, M327, M424, M518, M539 (e), each failing in some split gate and passing alone every time it was rerun, except after the final gate on its loaded host (M440's requested tick 1 of 3, M311 (h) 2 of 3; each then 3 of 3 on a quiet host on `4e05624` and `12ee772`).
