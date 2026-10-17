# 140: where a raster placeholder's declared size comes from, when D7 §6.2's table names no sizes

Row: M522 (a), (d) (and M525's header checks of the engine's own placeholders)
Test: packages/engine/test/acceptance/M522-placeholders-never-block.test.mjs, case "(a), (d) a placeholder for every default slot and variant of Pantry's targets, …"
Filed by: Verifier, slice 43, 2026-10-17 (a question for Sean, not a Builder's objection)

## Claim

The M6 plan's M522 (a) expects, among the placeholders written at inventory derivation, "the PNG variants at their declared sizes". D7 §6.3 writes, "for a variant whose format is raster, a flat PNG of the declared size encoded with the engine's own code (node's zlib)", and BS6 §§3 and 5 list the flat PNG encoder among the engine's own code.

But D7 §6.2 says the default table "names kinds and variants, not sizes: sizes and store requirements are platform guidance, recorded in §6.6, never hard-coded in the engine". §6.3 writes placeholders only "for every default slot and variant that has none". Nothing in D7 says which default variant has a raster format, or where its declared size would come from:

- the default table gives no format and no size;
- §6.6's `packaging` entries are prose guidance with a status, not machine sizes;
- a Designer- or owner-declared raster variant always comes with its own file (a variant with no file is `DESIGN_ASSET_FILE_MISSING`), so the engine never has to fill it.

So, read literally, every default placeholder is an SVG and the flat PNG encoder has no caller. The slice-40 Builder's work in progress (`build/m6-s40`) writes every placeholder as SVG.

The test pins what is unambiguous and accepts either reading for the rest:

- every default slot and variant has a placeholder, provenance `engine_placeholder`, status `placeholder`;
- a logo variant is a labelled logo block (SVG naming the project and `PLACEHOLDER`);
- any other SVG placeholder is an initials icon;
- a raster placeholder, if any, is a flat PNG whose IHDR equals its declared `size`;
- every file is valid by its header and deterministic from the project's name.

The test does not require that any raster placeholder exist.

The choice is Sean's:

- (a) every default placeholder is SVG; the flat PNG encoder is used only where a raster variant with a declared size and no file is given to the engine (state where, or drop it from BS6 §§3, 5);
- (b) the engine declares formats and sizes for some default variants (for example `favicon` 48 x 48 PNG, android's adaptive layers 108 x 108 PNG), which amends D7 §6.2's "never hard-coded in the engine";
- (c) a raster placeholder is written for a raster variant the design's selection or manifest declares with a size and no file, at the next derivation, which amends §6.3's "every default slot and variant" and B.16's `DESIGN_ASSET_FILE_MISSING`.

Under (b) or (c) the test gains a case requiring the raster placeholder. Under (a) it stands as written.

## Sources

- D7 §6.2 ("The table names kinds and variants, not sizes"), §6.3, §6.6; B.16.
- M6 plan §3.5 M522 (a): "the PNG variants at their declared sizes".
- BS6 §3 ("placeholders written with no model and no dependency (SVG, and flat PNGs through node's zlib)"), §5.
