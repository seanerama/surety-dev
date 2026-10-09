# Surety

Surety is an evidence-gated delivery engine for AI coding agents. This repository is its development home. M1 (the engine kernel on a scripted adapter), M2 (Claude Code as a real backend under D2's isolation) and M3 (the check runner of D3) are accepted; M4, deployment to a real Alpha environment under D4, is being built now.

**Read `docs/spec/M4-build-spec.md` before changing anything** (M1 to M3 are accepted; their specs, `docs/spec/M1-build-spec.md`, `docs/spec/M2-build-spec.md` and `docs/spec/M3-build-spec.md`, still govern what they built). It says what is being built, which design documents govern, and who may write what.

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
node scripts/run-tests.mjs acceptance --slice N    # acceptance files for slices 1..N (22 = all of M1 to M3; M4 is slices 23 to 30)
node scripts/run-tests.mjs acceptance --lane real  # the paid real-backend lane, only by Sean's command (M2 plan §2.1)
node scripts/run-tests.mjs acceptance --lane exhaust  # fork/memory/storage exhaustion and M4's service limits, only on mini-hp01 with SURETY_EXHAUSTION_HOST set (E69); never here
npm test                                           # unit, then the full kernel and sandbox suite
node scripts/check-role-boundary.mjs <builder|verifier> main <branch>
```

The test runner builds first. It fails on a skipped test, a file with no passing test, a misnamed or unlisted file, or a row with no test. That is deliberate: a skip is not a pass. `npm test` fails until every row of the four plans (M01 to M74, M101 to M142, M201 to M241, M301 to M344) has a file and passes; use `--slice N` meanwhile. Real-lane files (manifest `real`) and exhaustion-lane files (manifest `exhaust`) never run in `npm test`.

The boundary check sees commits only. Commit your work before running it.

## Rules that are easy to break

- Report what you observed. If a test fails, say so and show the output. Never describe work as passing that you did not run.
- Unknown is a value. Do not turn an unknown into zero, clean, empty or success, in code or in a report.
- Do not write a new draft of the design. A new finding is either a design decision for Sean or a failing acceptance test; say which.
- Service units only under a name derived from your own disposable `SURETY_HOME`, stopped only by that exact name; never stop, restart, reload, `daemon-reexec` or `daemon-reload` the user's service manager (M4 build spec §4.1 rules 1 and 2).
- Do not add a dependency. `better-sqlite3` is the engine's only runtime dependency, and every version is pinned exactly.
- Build what a row or a source requires and stop.
- Sean merges to `main`. Work on the branch your prompt names.
- End commit messages with a `Surety-Role: <role>` trailer.
