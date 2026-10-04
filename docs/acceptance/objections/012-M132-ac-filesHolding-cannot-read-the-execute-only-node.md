# 012: M132 (a) and (c) walk the engine home with `filesHolding`, which throws on the domain init's execute-only copy of node

Row: M132 (a), (c)
Test: packages/engine/test/acceptance/M132-secrets-volatile-provider-files.test.mjs, (a) "no file under the engine home holds the secret" and (c) "nothing under the engine home holds the secret or the home's contents", through `filesHolding` in `harness/records.mjs` (line 118)
Filed by: Builder, M2 slice 13, 2026-10-04

## Claim

Both cases fail at the instrument, not at an assertion:

```
(a) error: "EACCES: permission denied, open '/tmp/surety-acc-s2-RK8Hst/home/domains/dom_01M42EYVDXRTN9YXQRNKRABJHN/init-node'"
(c) error: "EACCES: permission denied, open '/tmp/surety-acc-s2-03cTN6/home/sandbox/node-2096-923133-123405064-1768259032000'"
```

`filesHolding` reads every regular file under the engine home. Two of them are, by design, unreadable to uid 1000: the domain init's **execute-only copy of the engine's node** (`<home>/sandbox/node-<dev>-<ino>-<size>-<mtime>`, mode 0111, and its hard link `<home>/domains/<dom>/init-node` that the domain's plan binds). The init is exec'd from that file so that it is not dumpable (slice 11; `src/invoke/domain-init.ts` head; D2 §2.3 "the domain init's control channel is unreachable from role code … through `/proc`"; objection 008's answer, which rests on it): a readable copy would make the init dumpable and give role code, the same kernel uid, `/proc/1/fd`, failing M117 (b) and P2, P13. So the engine cannot make these files readable, and no secret or role content can be in them: they are byte for byte the engine's own `node` (`process.execPath`), copied before any role runs.

Everything else in (a) passes on `build/m2-s13` up to that line (the transcript redacted, `runs.result` null, every published record free of both forms, `provider_files_collection` `refused`, no ref moved, `src/leak.txt` not in the checkout; the run `failed` / `infra_error` naming `secret_refused` with `evidence.secret_refused` for `materialization` and the Critical finding).

## Proposed change

Let `filesHolding` account for a file it cannot read instead of throwing, and only for this one known kind: a regular file under the engine home that is mode 0111 exactly and whose size equals the engine's node's (`statSync(process.execPath)` of the node the engine runs, which the harness starts), counted as the init's execute-only node copy and listed in the case's output; any other unreadable file still fails the case ("unknown is not absence").

## Sources

- D2 §2.3; A.6 P2, P13; SEAM.md §127 (M117 (b): `/proc/1/fd` refused), objection 008 and its answer (the init's non-dumpable environment).
- SEAM.md §152 (the I18 case reads the engine home after the restart).
