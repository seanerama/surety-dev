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
