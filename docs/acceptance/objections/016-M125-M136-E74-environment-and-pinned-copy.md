# 016: M125 (b)'s environment allow-list and M136 (b)'s `binary_path` predate E74

Rows: M125 (b) (sandbox lane, merged), M136 (a), (b) and the real-lane harness (real lane, never run)
Tests:
- packages/engine/test/acceptance/M125-handover.test.mjs, lines 58 and 59 (`REQUIRED_ENV`, `ALLOWED_ENV`) and line 112 ("nothing beyond the template's variables, the markers and the secret")
- packages/engine/test/acceptance/M136-positive-canary.test.mjs, lines 85, 86 (`binary_path: realpathSync(ctx.binary)`, `auth_mode: 'api_key'`) and 109 (`key_delivery.variable` `ANTHROPIC_API_KEY`)
- packages/engine/test/acceptance/harness/real/lane.mjs, line 52 (`keyRef: 'backend/claude/api_key'`)
Filed by: Builder, M2 slice 14, 2026-10-04

## Claim 1: E74 item 3 adds three variables to the backend's environment, and M125 (b) refuses them

E74 item 3 (the driver's defaults, from the slice-14 review) sets these variables in the backend's environment, for canaries and project runs alike, as part of the template:
- `DISABLE_AUTOUPDATER=1`
- `DISABLE_UPDATES=1`
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`

This is a template version change: `claude-one-shot-2`, and `claude-subscription-1` for the new mode. The engine now does so (`src/invoke/adapters/templates.ts`, `CLAUDE_QUIET_ENV`). The template's text names each variable, so an entry binds them.

M125 (b) asserts that the stand-in's environment holds nothing beyond `ALLOWED_ENV`, a fixed list without them. On this branch the case fails at that assertion, although the variables are exactly "the template's variables" the assertion's own message allows.

**Proposed change.** Add the three names to `ALLOWED_ENV` (or read them from the adapter's template text). For a project whose entry is `subscription_token` (E74 item 1), `CLAUDE_CODE_OAUTH_TOKEN` takes the place of `ANTHROPIC_API_KEY` in `REQUIRED_ENV`. M125's fixture entry is `api_key`, so its `REQUIRED_ENV` is unchanged.

## Claim 2: the real lane's cases name the operator's file, the API-key mode and its variable

Three things in the real-lane cases predate E74:
- **The pinned copy (item 3, the driver's default).** The attempt copies the binary that `claude` resolves to into `<home>/backends/claude-<version>-<sha256 prefix>` (mode 0500, its hash verified). It qualifies, binds and hashes that copy, so the entry's `binary_path` is the copy. Its `binary_sha256` is the same as the source's. M136 (b) requires `binary_path` to equal `realpathSync(ctx.binary)`.
- **The mode (item 1, Sean).** M2's real lane runs on the subscription token, so the entry's `auth_mode` is `subscription_token`. The credential's reference is `backend/claude/subscription_token`, delivered in `CLAUDE_CODE_OAUTH_TOKEN`; the evidence's `key_delivery.variable` names that variable.
- **The engine's flags.** The real-lane harness gives `--secret-file backend/claude/api_key=…` and proposes the attempt without `auth_mode`, which the route defaults to `api_key`.

**Proposed change** (the Verifier's to fix with E74's other consequences):
- In M136 (b), compare the entry's `binary_sha256` with the pinned binary's hash, and require `binary_path` to be a file under `<home>/backends/` with that hash. The operator's file is no longer the entry's path.
- Expect `auth_mode` `subscription_token` and `key_delivery.variable` `CLAUDE_CODE_OAUTH_TOKEN`.
- Give `REAL.keyRef` `backend/claude/subscription_token`, and send `auth_mode: "subscription_token"` in the attempt's body (`surety qualify … --auth-mode subscription_token` in the hands-on script).
