# Cross-review brief for D1 draft 3 (handed to Astra)

Astra, draft 3 of D1 is in ~/projects/sdlc-x. Your draft-2 review was accepted in full: the eleven still-open objections and B17 are applied, Sean decided Q4 as you recommended (E19), and Q1 to Q3 follow your recommendations. The earlier briefs still apply with these changes.

## Read first

1. `sdlc-review-D1-dispositions.md`: one row per draft-2 finding with the draft-3 section that implements it, the four question decisions, and the consistency checker's output on the committed document.
2. `sdlc-foundations-v1.1-errata-draft.md` E19: Sean's decision on finding-exclusion authority.
3. `sdlc-design-D1-engine-core.md` draft 3. This draft stands alone; no section defers to an earlier draft. Appendix A was written first; the body was written against it; A.10 declares the projection-only fields.
4. `scripts/d1-consistency.mjs`: the checker. Run it yourself; it is read-only.
5. `mockup/Gate.dc.html` and `mockup/Main.dc.html`: the two fixture follow-ups from your N03.

## What I want from you this time

Same eight sections. In section 2, mark each of the twelve items you left open (B01–B05, B08, B10–B12, B14, B15, B17) closed or still open against draft 3, and add any new blocker. Re-run the incident table in section 7.

There are no open questions in draft 3 §20. If you find a decision Sean must make, put it under "Questions for Sean."

## Where to press on draft 3

- The checker's rules R1 to R5 are lexical. Where the body and Appendix A agree on names but disagree on meaning, that is what I cannot catch mechanically and what I most want you to look for.
- §2.7 and §4.5: enumeration of a domain's processes by environment marker. Is `/proc/*/environ` plus process group a sufficient baseline on this host, and what must D2 add before a containerized backend?
- §7.3 and §7.6 together: is there any path by which a role's own writes in its workspace are classified as an out-of-band checkout change, or by which a dirty integration worktree escapes detection?
- §7.10: do the probes and finalizers cover every journaled kind, and can a finalizer run twice with a different result?
- §9.1 to §9.3: with delivery derived from `implements` and stages, can a requirement be delivered with no required check covering it?
- §9.6 with A.8: the go-live approval binds the authorization; confirm that no path lets that approval serve a different environment or a superseded authorization.
- §10.5 and A.8: is any decision kind's dependency manifest missing a value that could change between preview and effect?
- §11.1 bootstrap: is positive same-origin evidence on `Sec-Fetch-Site` plus parsed Origin or Referer sufficient on the browsers you expect, and what happens on a browser that sends neither?
- A.5 WorkItem common transitions: any transition the body needs that the table forbids, or the reverse.

Same constraints. Verdict in one line and the file path when you are done.
