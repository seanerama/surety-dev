# 115: M204 (f) under K1 (the Verifier's run dispatched with no script) and M235 (a) S2 under K2 (both stages' Builders at once)

Rows: M204 (f); M235 (a)
Filed by: Builder, slice 37, 2026-10-15 (gate 4 at 12d2485; gate 3 at e06b56d for M204)

## M204 (f), "every check of the due registration is missing…"

**Observed.** Gate 4 reports 0/1 alone on mini-hp01, and it also failed in gate 3. It fails alone here at b301110: "timed out after 30000 ms waiting for every run of proj_… to end", in `tickUntil`'s `waitForIdle` at line 40.

**Mechanism** (kept store):
1. The stage's Builder run ends, is integrated and nominated.
2. A requested tick (D6 K1: the operation's finalization, M440 (a)) then dispatches the candidate's verification work.
3. The case scripts no Verifier run, so its run stays `executing` (domain `launched`). `waitForIdle` waits for every run of the project to end, and that run never does.

Before K1, the case's `tickUntil` found the candidate before any tick could dispatch the verification.

**Proposed.** Give the verification work a script (for example `script.complete()` as the default), or pause the project once the candidate exists and before waiting for idle.

## M235 (a) S2, "the fixture is live: candidate 2 is stage 2's"

**Observed.** It failed alone on mini-hp01 at 12d2485 and earlier on the workstation; it is intermittent.

**Mechanism.** The case scripts both stages' Builders with `nominate: true` and runs them under `autonomy: step`. Under D6 K2 both run at once. Whether candidate 2 holds stage 2's work depends on the order of the two integrations and nominations:
- stage 2 may integrate first;
- or both may integrate before the first nomination, so that one candidate holds both. One review and one candidate per integration interval is the engine's rule (objection 109).

**Proposed.** Run stage 1 alone to its candidate first: hold stage 2 (pause the project, or a barrier) until candidate 1 exists. Alternatively, find "stage 2's candidate" as the candidate whose `held_work` includes s2, rather than taking the second.

## Sources

- D6 K1, K2; M440 (a); SEAM §437; objections 100, 109, 111, 114.
