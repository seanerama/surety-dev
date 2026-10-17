# 157: M538 (b) changes model_designer inside an open session and expects the next turn of the same session to request the new model

Row: M538
Test: packages/engine/test/acceptance/M538-the-designer-session-its-limits-and-its-findings.test.mjs, case "(a) … (b) … a setting changes both …"
Filed by: Builder, slice 41, 2026-10-17

## Claim

The case sets `model_designer: 'sonnet'` and `deadline_designer: 600` while its Designer session is open. It then requires the same session's next turn to request `sonnet`:

```
✖ (a) … AssertionError: model_designer set to sonnet: the next turn requests it ({… "role":"designer", … "model_requested":"opus", …})
```

The deadline half holds as built: a turn's receipt reads `deadline_<role>` at each turn's admission (M415 (b)'s reading). The model half does not. A session's model is the session run's, chosen at its opening: `runs.model_requested`, from `model_<role>` or the opening's `model`. Each turn resolves its backend entry on that model (`sessionBackend(…, { model: run.model_requested })`), and a resume carries it (`openSession(…, { model: old.model_requested })`). D7 §3.1 keeps D6 §2's mechanism unchanged for the Designer. SEAM.md §391 pins that "a project setting changes" the ledger's `model_requested`. M420 (c) reads that as a setting changed before a session opens: its Vision session opens after `model_vision` is set.

A turn of an open session that switched models would make the run's recorded model false. On a real backend it would also continue one provider session on another model's entry. Building that for the Designer alone would make the Designer differ from the other three session roles with no source for it.

The case should change the setting and then open a new Designer session, whose first turn requests `sonnet` (M420 (c)'s form). The deadline half can stay inside the session as it is.

**Observed with that change.** I made a scratch copy of the file outside the repository, `/tmp/b41/scratch/m538.mjs`. Its imports point at the repository's harness. Its only change is that the model assertion is moved to the first turn of a second Designer session, opened after the first closes. Run on this slice's engine, it gives **M538 4/4**: the deadline after the setting is 600 s, and the new session's turn requests `sonnet`.

## Sources

- D7 §3.1 ("A run of kind `session`, role `designer` … D6 §2's mechanism unchanged").
- `sessions/session.ts`: `openSession` (the run's `model_requested`), the turn's admission (`sessionBackend(…, { model: run.model_requested })`), and the resume (`model: old.model_requested`).
- SEAM.md §391, and M420 (c) (`M420-session-backends-and-models.test.mjs`: the setting changed, then a new session opened).

## Decision

Upheld by the driver under the owner's delegation, 2026-10-17. **The test is changed** (Verifier, `verify/m6-s41b` from `main` `364367b`).

In M538's case (a)/(b), the deadline assertion stays inside the open session: after `model_designer: 'sonnet'` and `deadline_designer: 600` are set, the open session's next turn must carry the 10-minute deadline. The `model_designer: 'sonnet'` assertion moves, in M420 (c)'s form, to the first turn of a new Designer session. That session opens after the first one closes, and its first ledger row must request `sonnet`. The second session is then closed. Nothing else in M538 changed. SEAM.md §531 records it.

**Run** against the Builder's engine (a detached scratch worktree of `build/m6-s41` at `8ad9030`, `npm install`, `npm run build`, `TMPDIR=/tmp/v41b`, the file alone with `node --test`): **M538 4/4**. On `main`, which has no Designer session yet, the file fails as before.
