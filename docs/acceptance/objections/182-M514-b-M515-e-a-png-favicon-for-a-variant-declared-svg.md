# 182: M514 (b) and M515 (e) add a PNG favicon to a variant the manifest declares SVG, which slice 43's `asset add` refuses

Row: M514 (b), M515 (e) (slice 44)
Test: packages/engine/test/acceptance/M514-the-design-decisions-bindings.test.mjs, case "(b) the asset manifest's version moved by the owner's asset add between the preview and the answer: the approval stale"; M515-staleness-the-design-class.test.mjs, case "(e) an asset-only revision stales nothing; (b) …"
Filed by: Builder, slice 44, 2026-10-17 (after merging `build/m6-s43` at `28b5794`)

## Claim

Both cases call `assetAdd(fx, p.id, 'favicon', 'default', 'favicon.png', pngOf(48, 48))`. In both projects the favicon's `default` variant is the engine placeholder, which the manifest declares `format: "svg"`. Slice 43's `surety design asset add` checks the file against the slot and variant (SEAM.md §508: "the engine validates the file against the slot and variant (§§505, 507)"). It refuses a PNG for a variant declared SVG, and nothing is committed:

```
surety design asset add (SEAM.md §508) ( 422 {"code":"design_asset_invalid","reason":"The file is not a valid favicon/default: DESIGN_ASSET_FORMAT_MISMATCH. Nothing was committed.", …
  "reasons":[{"code":"DESIGN_ASSET_FORMAT_MISMATCH","subjects":{"slot":"favicon","variant":"default","file":"favicon.png","declared":"svg","found":"png"}}]}
```

Slice 43's own cases give the owner's file the variant's declared format. M523 uses `owner-favicon.${fav.format}` and M527 uses `owner-favicon.svg`. Under slice 43's engine, M514 (b) and M515 (e) fail at their setup, before anything slice 44 asserts. Every other case of the two files passes on `build/m6-s44` at `089ca97`.

I have not changed the engine. Whether an owner file may change a variant's declared format is slice 43's rule, already pinned by M523 and M525.

## What the test can do

Add a file in the variant's declared format: an SVG favicon, as M527's `FAVICON_OWNER` does, or `pngOf` only for a variant declared `png`. The case's point is unchanged: the asset manifest's version moves, and an asset-only revision stales nothing.

## Sources

- SEAM.md §508 (`asset add` validates against the slot and variant); §§505, 507 (the header checks and declared formats).
- M523-the-asset-manifests-versions.test.mjs:172; M527-bindings-and-versioned-parity.test.mjs:182.

## Decision

Upheld by the driver under the owner's delegation, 2026-10-17. **The owner's file is in the variant's declared format** (Verifier, `verify/m6-s44c` from `9b5a7a5`).

Slice 43's engine is right: `asset add` checks the file against the variant's declared format (SEAM.md §508; §§505, 507), and the placeholder favicon's `default` variant is declared `svg`. The fault was in the two cases. Each added `favicon.png` (`pngOf(48, 48)`), a format no slice 43 case gives that variant.

Both cases now add `owner-favicon.svg`, `Buffer.from(passiveSvg(48, 48, 'P'))`. That is a passive SVG, as in M523 (c), which uses `passiveSvg(48, 48, 'P')` when the variant is declared SVG, and as in M527's `FAVICON_OWNER`. The `pngOf` import is replaced by `passiveSvg` in both files. Neither case's assertions changed:

- **M514 (b)** still asserts that the add exits 0, that the manifest's version has moved from the one `design_approval` bound, and that the answer is refused stale.
- **M515 (e)** still asserts that the add and the submit exit 0, the asset-only approval, and that every screen stays current with no `design.stale`.

**A second fault in M515 (e), found on verification.** Once the add succeeded, the case waited for `design.assets_approved` events to reach `>= 2`, an absolute count that assumes the first design approval also emitted one. On `9a75c98` it does not. The engine emits the event only when an effective version moves (`moved`), and the first approval moves none because its placeholders are already effective. A probe of (e) recorded exactly one event, from the asset-only approval (favicon/default, slot_version 1 to 2).

The wait now counts from just before the submit and waits for one more event, as M526 (e) does (M526:207 to 214). What (e) checks is unchanged: the asset-only approval takes effect and nothing goes stale.

Whether the first approval must emit the event is a separate question, and M515 should not answer it. D7 §6.4 says "the engine records the set at every approval (`design_effective_assets`, A.3; `design.assets_approved`)". The row that pins the event, M526 (e), pins it only on an approval that makes a file effective. If the owner reads §6.4 as requiring the event on every approval, that is a design decision for Sean, and the failing test belongs in M526, not M515.

**A third fault in the same M515 case, found on verification.** The case's last part (add-item's request gains a property, and S3 and S4 go stale) read the stale screens from `rev`, the first design revision. Once (e) takes effect, the asset-only revision supersedes `rev` and is current, and the engine marks staleness on the current revision's screens. So the wait never saw `rev`'s screens go stale. The part now reads `currentRevision(fx.home, p.id)` (`allCurrent` already did) and first asserts that it is not `rev`. The expected screens are unchanged: S3 and S4 stale, `design_due` naming S3/web and S4/android. No earlier run reached this part, because the case used to fail at the add.

**A fourth fault in the same M515 case: the asset-only approval's work was not scripted.** The favicon is carried by an integrated stage, so the approval registers one `asset_updated` fix (slot `favicon`, `favicon@1` to `favicon@2`, no bindings; SEAM.md §510). The fixture scripted no Builder for it. The fix's Builder runs failed until the work parked at `repair_attempts_max`, a probe saw four failed `builder` one-shots, and they ran at varying times. In one of three runs, one was in flight when the case's second later Architect session opened, which was refused 409 `session_busy` (E147 item 4).

The case now scripts that fix as M527 (d) scripts its favicon fix. It reads the work from the store with no tick and scripts it before dispatch: `FAVICON_FIX` copies `design/assets/favicon/default.svg` from its package to `web/favicon.svg` and binds it (`copy`). After (e)'s assertions, the case waits for the fix to be `complete` before the Architect sessions. Nothing (e) or (b) asserts changed.

**Run on `build/m6-s44` at `9a75c98`** (scratch worktree, each file alone, TMPDIR=/tmp/v44c):

- **M514, 3 runs, 5 of 6 cases passing in each.** Case (b) failed in all three, now at its real assertion and no longer at setup. The add exits 0 and the manifest's version moves, but the engine answered the `design_approval` with 200 (`consumed`) rather than refusing it stale. The cause was in the engine: `designManifest` recomputed `asset_manifest_version` as the revision's own fixed value. The Builder has since fixed the binding (`a492b88`).
- **M515, as each fault above was found.** With only the SVG change, the three runs went 5 of 6; (e) failed at the absolute event count. With the relative count, (e) failed at `rev`'s screens. With the current revision, the runs went 6/6, 6/6, then 5/6 at the `session_busy` race. With the fix scripted, one run of (e) alone passed. The full three-run verification of this file moved to `a492b88`, as recorded below.

**Run on `build/m6-s44` at `a492b88`:** scratch worktree, the two files of `a80275f` copied in, each alone, TMPDIR=/tmp/v44c. **M514: 2 runs, 6/6 and 6/6. M515: 2 runs, 6/6 and 6/6.** All exit 0.
