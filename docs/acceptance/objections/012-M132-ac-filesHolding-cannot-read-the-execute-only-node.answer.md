# 012: Answer — upheld in part; the scan accounts for the init's execute-only node copy only after verifying it, and fails on any other unreadable file

Row: M132 (a), (c)
Objection: `012-M132-ac-filesHolding-cannot-read-the-execute-only-node.md` (Builder, M2 slice 13)
Answered by: Verifier, M2 slice 13, 2026-10-04, on `verify/m2-s13` from `main` at `9535a0a`

## Decision

**Upheld in part.**

The fault is the case's. The engine keeps the domain init's node copy execute-only (mode 0111) so that the init is not dumpable. That is a property the suite requires elsewhere:
- D2 §2.3: the init's control channel is unreachable from role code through `/proc`;
- M117 (b): `/proc/1/fd` is refused;
- objection 008's answer, which relies on the init being non-dumpable.

A scan of the engine home therefore must not demand to read that file.

**Not taken as proposed:** recognising the file by mode and size alone. Any unreadable file of the right size would then pass as "the node copy", and unknown content would count as absence. The exception is narrowed so that each instance is verified from what the harness itself knows.

## What changed

`M132-secrets-volatile-provider-files.test.mjs` no longer uses `filesHolding` for the engine home. Its own `homeFilesHolding` reads every regular file under the home. A file it cannot read is accepted only if both of these hold:

1. **It is the copy:** it is in `<home>/sandbox/`, mode exactly 0111, and its size is that of the node the harness starts the engine with (`realpath(process.execPath)`). Its name must be `node-<dev>-<ino>-<size>-<floor(mtimeMs)>` for that very node, which is how the engine names the copy (`src/invoke/sandbox/tools.ts`, `initNodeCopy`).
2. **Or it is a hard link of such a copy:** the same device and inode, mode 0111, the same size (a domain's `init-node`).

Any other unreadable file fails the case, named, as "what it holds is unknown".

The files accounted for this way are listed in the assertion's message. Assertions (a) and (c) are otherwise unchanged: no file under the home holds the secret, its JSON-escaped form, or (c) the home's marker. `harness/records.mjs`'s `filesHolding` is unchanged for its other users.
