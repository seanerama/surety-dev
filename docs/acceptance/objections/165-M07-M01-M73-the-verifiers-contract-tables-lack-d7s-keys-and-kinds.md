# 165: M07, M01 and M73 (c) read the Verifier's contract tables, which lack D7 A.7's keys and A.2's decision kinds

Rows: M07 (two cases), M01 (one case), M73 (one case): accepted M1 rows, read on M6's branches
Tests: packages/engine/test/acceptance/M07-project-bootstrap-and-policy.test.mjs, M01-kernel-journey.test.mjs, M73-executable-contract.test.mjs; the tables `contract/config.json` and `contract/decisions.json`
Filed by: Builder, slice 40, 2026-10-17

## Claim

Slice 40 builds D7's policy and decisions: the sixteen project keys of D7 A.7 (and `backend_designer`, as every role's `backend_<role>`, SEAM.md §391's pattern) and the three decision kinds of D7 A.2 (`design_approval`, `design_due`, `design_verdicts`), each with its manifest and its 2 d target (BS6 §11.1). The three accepted rows compare the engine against the Verifier's closed tables, which hold M1 to M5's keys and kinds and none of D7's:

- `contract/config.json` `project` has none of `design`, `design_preview`, `design_widths`, `design_orientations`, `design_external_urls`, `assets_required_for`, `model_designer`, `backend_designer`, `deadline_designer`, `designer_session_budget_billable_tokens`, `design_tree_max_bytes`, `design_tree_max_files`, `preview_memory_max`, `design_preview_ttl`, `design_due_max_defer`, `design_review_evidence_max_bytes`; its `decision_target_defaults` has none of the three kinds.
- `contract/decisions.json` `kinds` has none of the three kinds.

The Builder's side is done on `build/m6-s40`: the three kinds are in the engine's `DECISION_KINDS` (so the contract's decisions section states them; before, `surety contract check` refused the engine's own contract: "The decision kind design_approval is declared and the decisions section says nothing of it", and the same for the other two), and `packages/engine/api/schema.json` and `appendix-a.md` are regenerated. Observed after that change, each file run alone:

```
M73: pass 10, fail 1
  not ok 3 - the contract holds the accepted corrections, as the Verifier's tables state them
    no other decision kind is enabled in M1
    +   'design_approval',
    +   'design_due',
    +   'design_verdicts',
  (the next assertion of the same case, "the project configuration keys", fails on the sixteen keys)
M07: pass 3, fail 2
  "the effective policy is the schema defaults, whatever the file in the repository says"
  "and the schema defaults are in effect"
    +   assets_required_for: 'live',  +   backend_designer: 'scripted',  +   deadline_designer: 1800,
    +   design: 'off',  +   design_due_max_defer: 604800,  +   design_external_urls: [cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com],
    +   design_orientations: [portrait, landscape],  +   design_preview: 'static',  +   design_preview_ttl: 86400,
    +   design_review_evidence_max_bytes: 67108864,  +   design_tree_max_bytes: 33554432,  +   design_tree_max_files: 800,
    +   design_widths: [360, 720, 1280],  +   designer_session_budget_billable_tokens: 3000000,
    +   model_designer: 'opus',  +   preview_memory_max: 268435456,
M01: pass 10, fail 1
  not ok 1 - runtime data stays outside tracked source
    assets_required_for is a project key
```

Every value the engine reports is D7 A.7's default as BS6 §11.1 adopts it. No engine change can make these pass without dropping a key D7 requires or disabling a kind slice 40 raises. The fix is the tables', as M5's slices each extended them (config.json's `$comment` records M5 slices 31, 32, 33, 35 and 37 doing so):

- `config.json` `project`: the sixteen keys with their defaults and ranges (the engine's export, `surety contract export`, `config.project`, states each: e.g. `deadline_designer` 1800 within 300 to 10800; `design_tree_max_bytes` 33554432 within 1048576 to 134217728; `design_preview_ttl` 86400 within 3600 to 1209600; `design_due_max_defer` 604800 within 3600 to 2592000; `design_review_evidence_max_bytes` 67108864 within 1048576 to 2147483648; `preview_memory_max` 268435456 from 67108864 to `domain_memory_max`; `design_preview` `off`, `static` (`stack` refused, E156 Q4); `assets_required_for` `none`, `beta`, `live`).
- `config.json` `decision_target_defaults`: the three kinds at 172800.
- `decisions.json` `kinds`: the three kinds, with the manifests the engine binds:
  - `design_approval`: `design_version`, `architecture_version`, `design_check`, `asset_manifest_version`, `selection`, `tree_blobs`, `spec_version`, `spec_change_diff_hash`, `inventory_digest`, `roadmap_version`, `plan_versions`;
  - `design_due`: `stage`, `held_stages`, `stale_screens`, `policy_revision`, `inventory_failure`;
  - `design_verdicts`: `review`, `review_blob`, `evidence`.

`backend_designer` is the one key not in D7 A.7's table; it is the role's backend selector, as `backend_vision` and `backend_spec_writer` are (SEAM.md §391). If the Verifier holds it should not exist, say so and the Builder removes it.

## Sources

- D7 Appendix A.2 (DecisionKind added), A.7 (configuration keys added); D7 §11, G5 (targets).
- BS6 §11.1 (the numerics and configuration M6 fixes); plan §4.3 (accepted rows' changes are the Verifier's, recorded in COVERAGE).
- `contract/config.json` `$comment` (M5's slices extending the table).

## Decision

Upheld by the driver under the owner's delegation, 2026-10-17, `backend_designer` included (the Designer's backend selector, as `backend_vision` and `backend_spec_writer`, SEAM.md §391). **The tables are changed; no test is** (Verifier, `verify/m6-s40c` from `main` `ca0ac5a`).

- **`contract/config.json` `project`** gains D7 A.7's fifteen keys and `backend_designer`, each at A.7's default and range as BS6 §11.1 adopts them (E156 Q4: trial values), checked against D7 A.7 rather than copied from the engine: `design`, `design_preview` (`off`, `static`; `stack` refused, E156 Q4), `design_widths` (1 to 6 widths, each 240 to 3840), `design_orientations`, `design_external_urls`, `assets_required_for`, `model_designer` (`opus`), `backend_designer` (`scripted`), `deadline_designer` (1800, 300 to 10800), `designer_session_budget_billable_tokens` (3000000, 250000 to 20000000), `design_tree_max_bytes` (33554432, 1048576 to 134217728), `design_tree_max_files` (800, 50 to 8000), `preview_memory_max` (268435456, from 67108864 to `domain_memory_max`), `design_preview_ttl` (86400, 3600 to 1209600), `design_due_max_defer` (604800, 3600 to 2592000), `design_review_evidence_max_bytes` (67108864, 1048576 to 2147483648). **`decision_target_defaults`** gains the three kinds at 172800 (D7 §11, G5).
- **`contract/decisions.json` `kinds`** gains the three kinds of D7 A.2: `design_approval` about a `design_revision` (options of D7 §7.4; manifest SEAM.md §486's eleven keys), `design_due` about the project (A.2's `DesignDueOption`; manifest `stage`, `held_stages`, `stale_screens`, `policy_revision`; `policy_off` records an intent), `design_verdicts` about a `design_review` (`confirm`, `reject`; manifest `review_blob`, D7 §10.3's review-file hash, and `evidence`). The table holds what a manifest binds at least: the engine's `design_due` key `inventory_failure` and `design_verdicts` key `review` are its own and are not pinned.
- **One engine value is not D7's.** The engine exports `preview_memory_max`'s maximum as the number 68719476736, and slice 40's `CEILED_KEYS` (`src/config/project-policy.ts`) holds only `role_memory_max` and `check_memory_max`, so a project value above the effective `domain_memory_max` is not refused. D7 A.7 and SEAM.md §516 say it is. The table follows D7 (`max: "domain_memory_max"`, as `role_memory_max`); M73 compares numeric bounds only, so this file does not catch it. M513 (f), slice 44's row, does.
- **Slices 41 to 45** add no project key: slice 40's engine already reports all sixteen, `designer_session_budget_billable_tokens` among them, and the later slices' SEAM sections (§§491, 499, 516) read these keys.

**Run** against the Builder's engine (a detached scratch worktree of `build/m6-s40-fix` at `5da59e6`, `npm ci`, `npm run build`, the edited tables copied over, `TMPDIR=/tmp/v40c`, each file alone with `node --test`): **M73-executable-contract 11/11, M07-project-bootstrap-and-policy 5/5, M07-closed-configuration 18/18, M01-kernel-journey 11/11.** Not run on `main`: its engine has none of D7's keys or kinds, so the tables expect slice 40's engine and must land with it.
