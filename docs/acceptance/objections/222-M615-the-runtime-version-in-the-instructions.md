# 222: M615 (e) asks for the runtime version "in the instructions"; the engine gives it as a prerequisite. Which did the owner mean?

Row: M615 (e) (M7 acceptance plan DRAFT 1, §3b)
Test: packages/engine/test/acceptance/M615-the-downloadable-deliverable.test.mjs, case "(e) the runtime version given in the run guidance (the version the environment pins, as a prerequisite)"
Filed by: Verifier, branch verify/static-preview (from 0311382c), 2026-10-29. This is a question for the owner about the row's wording. It is not a claim that the engine is wrong.

## Claim

Row M615 (e) requires, for a `node_service` candidate: "`hosting_required true`, the start command and runtime version in the instructions."

For a Node service candidate (the M4 fixture with a package.json start script, its environment pinning the engine's own node), the engine on e5e469f8 serves:

```
instructions:  ["Unzip.", "In the unzipped folder, run the start command: npm start (package.json scripts.start: node server.js)."]
prerequisites: ["Node.js v22.22.0, the runtime the project's environment pins."]
```

- **The start command** is in `instructions`.
- **The runtime version** is in `prerequisites`, not in `instructions`.

Read literally, the row fails. The case observed, run alone:

> `the instructions give the runtime version v22.22.0, the one the environment pins (instructions ["Unzip.","In the unzipped folder, run the start command: npm start (package.json scripts.start: node server.js)."]; prerequisites ["Node.js v22.22.0, the runtime the project's environment pins."])`

The sources name both fields and do not say which holds the version, so I read the row as ambiguous rather than the engine as wrong. The case now asserts:

- the version appears in the deliverable's run guidance (instructions or prerequisites);
- in particular, it is the `Node.js <version>` prerequisite.

The start command is still asserted in `instructions`. The file passes run alone: 8 tests, 8 pass, 0 fail.

**The owner's choice:**

1. **"Instructions" meant the run guidance as a whole.** The case stands as written now, and the row's wording can say "instructions or prerequisites".
2. **The version must be in `instructions` itself.** The case goes back to the literal assertion, which fails on e5e469f8, and the Builder moves or repeats the version there.

## Sources

- **D4 §13.3** (on main, 2055330f): "its `platform`, `instructions` and `prerequisites` follow the output kind (13.4)".
- **The owner, 2026-10-29**, quoted in D4 §13.3: "Serve a versioned package bound to the completed candidate, with its filename, size, checksum, intended platform and any run instructions or prerequisites."
- **SHAPES.md §4** (the driver, 2026-10-29): "The package's `platform.kind` and instructions come from the output kind (§5) … For `node_service`: the start command and runtime version."
- **The Builder's record** (engine A, commit 72e4bb88): "node_service: the start script and the Node.js version an environment pins, or that it is not known".
- **The Verifier's reading:** `packages/engine/test/acceptance/harness/SEAM.md` §578 (M615).
