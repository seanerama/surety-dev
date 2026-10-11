# 048: `filesHoldingAny` reports the engine's execute-only node copies as unread, so M332 (b) and M334 can never find the home clean

Row: M332, M334
Test: packages/engine/test/acceptance/M332-secret-delivery-on-a-real-unit.test.mjs, case "(a), (b), (d) …" ("(b) no file of the engine home … holds a value, and every one was read"); packages/engine/test/acceptance/M334-output-withheld-and-logs-redacted.test.mjs, both cases ("no file of the engine home holds the value"; "no file of the engine home (store, records, events) holds either, and every one was read"); helper `filesHoldingAny` in harness/deploy/host.mjs
Filed by: Builder, slice 28, 2026-10-11

## Claim

`filesHoldingAny(home, forms)` lists every regular file it cannot read as `unread:<path>`. The engine home holds files that no process of the uid can read, by D2's design: the execute-only copy of the engine's own `node` that every domain init runs from. These are `sandbox/node-<dev>-<ino>-<size>-<mtime>`, mode 0111, and its hard links `domains/<domain>/init-node` and `run/<env>-g<n>/init-node`, made by `src/invoke/sandbox/tools.ts` (`initNodeCopy`, `initNodeIn`). A run of M332's case on build/m4-s28, in a copy that changes only the workspace check's envelope (objection 049), found no value anywhere. It failed only on this list:

```
'unread:domains/dom_…/init-node' (six of them), 'unread:run/env_…-g1/init-node', 'unread:sandbox/node-2096-923133-123405064-1768259032000'
```

The engine cannot make them readable without undoing D2's protection: a process that execs a file it may not read is not dumpable. These files are copies of the engine's `node` binary, made before any secret is held, and nothing writes to them afterwards.

The search should account for them instead of failing. For example: a regular file of mode 0111 (no read bit for anyone) whose size equals the engine's node binary's size (`process.execPath`, as `realpathSync` resolves it), and whose name is `init-node` or `sandbox/node-*`, is listed as `execute_only:<path>` and not as unread. Any other unreadable file stays `unread`. Alternatively, it is compared by inode with `sandbox/node-*`. The guarantee "every other file was read" is kept.

## Sources

- D2 §2.3, and the code's statement of it in `src/invoke/sandbox/tools.ts`: "An execute-only copy of the engine's node under the engine home … a process that execs it without the capability to read it is not dumpable".
- SEAM.md §310: "a directory or file it cannot read is reported as `unread:<path>`, never taken for clean". The rule stands; these files are known not to be secret-bearing by construction, and the search can establish that without reading them.
