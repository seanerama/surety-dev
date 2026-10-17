# 202: the package-driven fakes cannot play a design journey's specification: the Spec Writer writes no targets or surface marks, and a design batch's spec_change throws

Row: M519, M535 (their dress rehearsals, BS6 §12, "the rehearsal plays from the package"); M541 (Sean's run of `M6-hands-on.sh`; `M541-hands-on-script` itself passes)
Test: harness/standin/package-fakes.cjs `specWriterTurn`, `specChangeRun`; harness/real/m6-lane.mjs `m6Spec`, `m6Design`; docs/acceptance/reports/M6-hands-on.sh (`roles prepare`)
Filed by: Builder, slice 46, 2026-10-17

## Claim

Read on `build/m6-s46`; nothing of the real lane was run (rehearsal or paid), and the hands-on script was not run. Three gaps stop a design journey played by the fakes. For the first two, the engine did not state the form either, so the fake had nothing to read it from. It does now.

**1. The Spec Writer's targets and surface marks.** `m6Spec` asks for "`**Targets:** web`" (M519) or "`**Targets:** web, android and **Cross-platform:** yes`" (M535). `pantryBrief(row)` gives the fake `targets`, `cross_platform` and each UI requirement's `surface` (`'ui (web)'`, `'ui (android)'`). `specWriterTurn` writes none of them. It writes the header from `spec_writer.header_fields` (Spec version, Status, Tier, Owner) and the requirement from `spec_writer.requirement_form`. So the rehearsal's specification has no targets. Under `design: both` the plan check then refuses the first plan `SPEC_TARGETS_MISSING`, and no UI requirement is derived. The Spec Writer's packages stated neither form before this slice: `SPEC_HEADER_FIELDS` is the four fields, and `spec_writer.marks` holds `human_test` and `descriptive`.

The engine now states a new element **`spec_writer.targets`** in the `spec_writer`, `spec_writer_retrofit` and `spec_change` packages, from the parser's own constants (`SPEC_TARGET_FIELDS`, `TARGETS`, `SPEC_MARKS.surface`):

```json
{ "targets": { "line": "**Targets:**", "values": ["web","android","ios","macos","windows","linux"], "separator": ", ", "rule": "…" },
  "cross_platform": { "line": "**Cross-platform:**", "value": "yes", "rule": "…" },
  "surface": { "mark": "**Surface:** ui", "with_targets": "**Surface:** ui (<targets>)", "separator": ", ", "rule": "on its own line after the statement of each requirement a user interface fulfils; …" } }
```

A unit test (`role-packages.test.mjs`, "M6: the Spec Writer's package states the header's targets and the surface mark …") writes a specification from the blocks with these lines and the parser reads `targets`, `cross_platform` and `surface_targets` with no finding. M442's element checks do not read the new id, and the existing elements are unchanged.

**Asked (1):** `specWriterTurn` writes, from `spec_writer.targets` alone, the targets line (and the cross-platform line when `o.cross_platform`) after the header fields, and the surface mark after each requirement's statement where `r.surface` is given. Told nothing of the element, it writes neither, and the judgement names the element.

**2. A design batch's spec_change.** `specChangeRun` reads only an owner's `rehearsal-change` block in the request text and throws without one ("rehearsal fake: the change could not be read"). A design batch's request is the engine's, not the owner's (`src/design/approval.ts` `requestText`). It carries the design's criteria and human tests in a plain `json` block, which no package element stated. So the fake cannot play the batch's change. SEAM.md §544 has the hands-on script play it with the fake (`kind-spec_change` FAKE), and the M519/M535 rehearsals reach it at `m6?_design`.

The engine now states a new element **`spec_writer.design_change`** in the `spec_change` package, only when the request's source is a design. It holds the design's `criteria` (criteria.json's, as approved) and `human_tests`, each with the `phase` that holds its target's last UI stage (`lastUiPhase`; `null` when none can be determined, never a guess), and how each is written:

```json
{ "source": "design", "criteria": [ … ], "human_tests": [ { "target": "web", "text": "…", "screens": [ … ], "not_checkable_yet": [ … ], "phase": 1 } ],
  "criterion": { "under": "its requirement; …", "id": "R<n>.<m>, the next free number under its requirement; …", "text": "the criterion's text exactly as given: the engine finds each design criterion in the specification by its text", "change_kind": "criteria_added" },
  "human_test": { "key": "a new requirement, the next free R<n>, one per human test", "surface": "**Surface:** ui (<target>)", "mark": "**Human test.**", "text": "the human test's text, after the mark; no criteria", "phase": "…", "change_kind": "added" } }
```

This is what `harness/design/plan44.mjs` `batchSpec` writes, stated as the engine reads it: the criteria by their text (`designCatalogueFacts`, the Builder's package), the human tests excluded from the inventory as human-test requirements (`batchInventoryDiff`).

**Asked (2):** `specChangeRun` plays a request whose package states `spec_writer.design_change` from that block: each criterion under its requirement at the next free id with its text, each human test a new requirement with the surface mark and the human-test mark, the version raised, the result's `changes` (`criteria_added`, `added`) in `spec_writer.change_result`'s form. It keeps today's `rehearsal-change` path for an owner's request.

**3. The hands-on script's content.** `M6-hands-on.sh` `roles prepare` calls `s.packageFakes(designerContent({ name: ref.PROJECT_NAME }))`. The fakes read the Designer's content at `content.design` (`designerTurn`: `const d = content.design || {}`). So Sean's run draws a design with no palette, no pairs, no criteria and no logo proposal, and the correction has no `design_checks`. M537's fixture and `m6Content` pass `{ design: designerContent(…), design_checks, … }`. The script's own test (M541) checks only its form and passes.

**Asked (3):** the script passes `{ design: designerContent({ name: ref.PROJECT_NAME, criteria: … }), design_checks: … }`, as `m6Content` does, so that its step (c) reaches the batch with criteria and its step (d) has a logo proposal to hold.

Objection 201 (the correction fake's program) is the fourth gap on the same path.

## Sources

- BS6 §12: "The rehearsal plays from the package (E135; M537 (b)): the fake Designer derives every file from the schemas, …"; §4.1 rule 18.
- E151; BS6 §11.4: the package states what the engine reads.
- D7 §4.1, G3 (the header's `**Targets:**`, `**Cross-platform:**`, the `**Surface:** ui` mark); §7.1, §7.3 (the consolidated change: criteria under their requirements, one human-test requirement per target).
- SEAM.md §544 (the hands-on's fakes: "the Designer, the batch's `spec_change` one-shot and the `check_correction` Verifier play the package-driven fakes with `designerContent({name})`"); §541 (the real lane's rehearsal).
