# 016: Answer — upheld, on Sean's terms (E75 item 1)

Rows: M125 (b) (sandbox lane), M136 (a), (b) and the real-lane harness (real lane)
Objection: `016-M125-M136-E74-environment-and-pinned-copy.md` (Builder, M2 slice 14)
Decided by: Sean, E75 item 1 ("uphold the remaining mismatches ... Expected values remain independently defined by the tests, never copied from the implementation")
Answered by: Verifier, M2 slice 14, 2026-10-04, on `verify/m2-s14-016` from `main` at `83cf03c`

## Claim 1: M125 (b) refused the three variables E74 adds — upheld

**Changed in `M125-handover.test.mjs`:**
- `QUIET_ENV` names `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, each with the value **the test expects**, `"1"`. They join `REQUIRED_ENV`, so each must be present.
- Case (b) asserts each one's value by the hash of `"1"` (the stand-in logs value hashes by name).
- Every other name outside `ALLOWED_ENV` is still refused.
- The parent-only sentinels gain `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN`, so an inherited credential of either mode is refused as the others are.
- SEAM §139 says the same.

**Where each value comes from.** I did not read `templates.ts`. The sources are Claude Code's documentation, read on 2026-10-04 at code.claude.com/docs, and E74 item 3:
- `DISABLE_AUTOUPDATER` = `1`: Advanced setup, "Disable auto-updates": "Set `DISABLE_AUTOUPDATER` to `"1"`".
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` = `1`: Environment variables: "Set to any non-empty value, such as `1`". The page adds: "Setting it to `0` or `false` still disables this traffic"; `1` is the value the test pins.
- `DISABLE_UPDATES` = `1`: the Advanced setup page names it ("To block all update paths, including manual updates, set `DISABLE_UPDATES`") but gives no value there. The Environment variables page did not show the row when I read it. The value `1` follows its sibling's convention, so **this one value rests on convention, not on a quoted source** (question 1 below).

**Run.** `M125-handover.test.mjs` alone with `node --test` on the Builder's tip `228cf5e`, in a detached scratch worktree after `npm ci` and `npm run build`: **3 of 3 passed** ((a) and (b) in one test, (c), (d)).

## Claim 2: the real-lane cases named the operator's file, the API-key mode and its variable — upheld

The subscription changes already merged (E74, `890c875`) stand: `SURETY_REAL_AUTH_MODE` defaults to `subscription_token`, and the reference is `backend/claude/subscription_token`. The real-lane files were checked with `node --check` only.

**Changed:**
- **The source binary, read by the test** (`harness/real/attempt.mjs`). Before the attempt is proposed, the test records `source_binary`:
  - the path of `SURETY_REAL_CLAUDE_BINARY`;
  - the SHA-256 of its bytes, computed by the test;
  - the first word of the binary's own `--version`, run once with exactly that argument, an empty `HOME` and no credential.
- **M136 (b), the engine-owned pinned copy.** The test builds the expected path from its own values: `<home>/backends/claude-<version>-<sha16>`, with `<sha16>` the first 16 hex digits of the hash the test computed. The entry's `binary_path` must equal it. The file must be regular, owned by the user, mode 0500, and its bytes must hash to the test's value; the entry's `binary_sha256` must too. No expected value is read from the engine.
- **M136 (b), the subscription mode:**
  - `credential_delivery.variable` must be `CLAUDE_CODE_OAUTH_TOKEN`. The source is Claude Code's documentation, Environment variables: "OAuth access token for claude.ai authentication ... Generate one with `claude setup-token`". In the `api_key` mode it stays `ANTHROPIC_API_KEY`.
  - The entry's template must have no `--bare` in the subscription mode (and must have it in the `api_key` mode).
  - It must name the three switches.
- SEAM §§164 and 165 say the same.

**Not changed:** the harness's `REAL` reference and the attempt's `auth_mode` body. Both already carried the subscription mode since E74; the objection read them from an earlier revision.

## Questions for Sean (values only the implementation could supply)

1. **`DISABLE_UPDATES`'s value.** The documentation I could read names the variable and not its value. The test pins `1`. If the documentation's row gives another value, the test should take it from there.
2. **The `<version>` in the pinned copy's name.** E74 and the objection give `claude-<version>-<sha16>` without saying what `<version>` is. The test takes the first word of the binary's own `--version` (`2.1.289` from `2.1.289 (Claude Code)`). The engine choosing another form, such as the whole line, would fail M136 (b) on the name alone.
