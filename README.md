# Surety

An evidence-gated delivery engine for AI coding agents.

Surety drives headless coding agents (Claude Code, Codex CLI) through a governed software lifecycle. The engine, not the agent, performs every git operation, runs every check, and decides every state change, and it advances work only on evidence it observed itself. It is the successor to spec-driven-devops and Verity.

## Status

Design is approved and the first milestone, M1, is being built: the engine kernel on a scripted adapter. Nothing of the kernel is implemented yet. The `surety` command reports its version and refuses everything else.

## Where to start

- **Building or reviewing:** [docs/spec/M1-build-spec.md](docs/spec/M1-build-spec.md)
- **All documents:** [docs/README.md](docs/README.md)

## Layout

| Path | Contents |
|---|---|
| `packages/engine` | The engine: TypeScript compiled with `tsc`, SQLite as the runtime store. |
| `packages/ui` | The UI: zero-build HTML and JS, a client of the engine's API. Not started. |
| `scripts` | The test runner and the role-boundary check. |
| `docs` | Foundations, design, acceptance plan, build spec, reviews, UI mockup. |

## Commands

```
npm install
npm run build
npm run test:unit
npm test          # fails until all 74 acceptance rows of M1 exist and pass
```

Requires Node 22 or later and git, on Linux.
