# Surety

Surety is an evidence-gated delivery engine for AI coding agents. This repository is its development home. The first milestone, M1, is being built now: the engine kernel on a scripted adapter, with no real backend.

**Read `docs/spec/M1-build-spec.md` before changing anything.** It says what is being built, which design documents govern, and who may write what.

## Your role

Every session works in exactly one role, named in its first prompt: **Verifier**, **Builder** or **Reviewer**. The roles never share a session. Each role may write only these paths:

- **Verifier:** `packages/engine/test/acceptance/`, `docs/acceptance/objections/`, `docs/acceptance/reports/`.
- **Builder:** `packages/engine/src/`, `packages/engine/migrations/`, `packages/engine/api/`, `packages/engine/test/unit/`, `docs/acceptance/objections/`.
- **Reviewer:** nothing. It reports findings.

Everything else is the owner's: all other `docs/`, the acceptance plan, `CLAUDE.md`, `scripts/`, every `package.json`, `tsconfig.json`, the lockfile. If you need one of those changed, stop and ask Sean.

A Builder never edits, skips or disables an acceptance test. If a test looks wrong, file an objection in `docs/acceptance/objections/` and carry on with other work.

If your prompt names no role, you are assisting Sean, the owner. Do not edit `packages/engine/src/` or `packages/engine/test/acceptance/` in that case unless he asks for it explicitly.

## Commands

```
npm install                                        # once
npm run build                                      # tsc only
npm run test:unit                                  # Builder's developer tests
node scripts/run-tests.mjs acceptance --slice N    # acceptance files for slices 1..N (9 = everything merged so far)
node scripts/run-tests.mjs acceptance --lane real  # the paid real-backend lane, only by Sean's command (M2 plan §2.1)
npm test                                           # unit, then the full kernel and sandbox suite
node scripts/check-role-boundary.mjs <builder|verifier> main <branch>
```

The test runner builds first. It fails on a skipped test, a file with no passing test, a misnamed or unlisted file, or a row with no test. That is deliberate: a skip is not a pass. `npm test` fails until every row of both plans (M01 to M74, M101 to M142) has a file and passes; use `--slice N` meanwhile. Real-lane files (manifest `real`) never run in `npm test`.

The boundary check sees commits only. Commit your work before running it.

## Rules that are easy to break

- Report what you observed. If a test fails, say so and show the output. Never describe work as passing that you did not run.
- Unknown is a value. Do not turn an unknown into zero, clean, empty or success, in code or in a report.
- Do not write a new draft of the design. A new finding is either a design decision for Sean or a failing acceptance test; say which.
- Do not add a dependency. `better-sqlite3` is the engine's only runtime dependency, and every version is pinned exactly.
- Build what a row or a source requires and stop.
- Sean merges to `main`. Work on the branch your prompt names.
- End commit messages with a `Surety-Role: <role>` trailer.
