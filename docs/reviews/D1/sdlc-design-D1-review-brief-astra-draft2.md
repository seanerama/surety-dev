# Cross-review brief for D1 draft 2 (handed to Astra)

Astra, draft 2 of D1 is ready. Your draft-1 review was accepted in full: all sixteen blocking objections and all five suggestions are applied, and Sean decided the four questions reserved to him in line with your recommendations. The same brief applies as before (`sdlc-design-D1-review-brief-astra.md`), with these changes.

## Read first

1. `sdlc-review-D1-dispositions.md`: how each of your 21 items was applied, with the draft-2 sections that implement it, and the recorded decisions on all eight open questions.
2. `sdlc-foundations-v1.1-errata-draft.md` E18: the new decision O11 (this directory becomes the Surety repository) and the three D1 decisions Sean made.
3. `sdlc-design-D1-engine-core.md` draft 2. Appendix A is new and is the authoritative enumeration; the body references it.
4. `mockup/README.md` status line and the three corrected fixtures (`Main`, `Build`, `Gate`).

## What I want from you this time

Same eight sections as before. For section 2, judge each of your sixteen objections as **closed**, **closed with the variant noted in the dispositions file**, or **still open**, citing the draft-2 section. For section 7, re-run the incident table against draft 2; that table is still the one I care about most.

Four new open questions are in D1 §20; the first is the one place I varied from your text (store worker placement as default, D1-20 as the requirement). Say whether that variant is acceptable.

## Where to press on draft 2

- Appendix A against the body: any state, field, event, reason, or error used in §§1–19 and not declared in A, or declared and unused.
- §7.3 snapshot and quiescence, especially for sessions (§20 Q2).
- §9.1 delivered-requirements derivation (§20 Q3) and §3.4 finding inheritance (§20 Q4).
- §4.5 end protocol and §16.1 together: is there any path by which a run is reported ended while a process it owned may still write?
- §9.6 authorize-versus-complete: can a stale DeploymentVerification from a previous attempt ever satisfy a completion gate?
- §10.5 answer validation: is the fresh-read comparison complete, or is there a material dependency outside the preview hash?
- §11.1 against your 21-invariant table: anything still missing.

Same constraints as before: read-only, cite paths and sections, proposed text in D1's register, questions for Sean under a final heading. Tell me the verdict in one line and where the file is.
