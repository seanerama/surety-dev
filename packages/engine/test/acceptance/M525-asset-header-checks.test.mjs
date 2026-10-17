// M525, asset header checks (slice 43; kernel lane). M6 plan §3.5 M525;
// D7 §6.3, §14; A.4; BS6 §4.1 rules 21, 22; SEAM.md §§504, 507.
//
// One Designer session on Pantry; each save the whole design with the
// favicon's (or the logo's) variant replaced by a file the test generates
// with a valid header, never a real image (the valid PNG first, as the
// control):
// (a) a PNG declared `svg`; a WebP declared `png`: DESIGN_ASSET_FORMAT_MISMATCH;
// (b) a PNG whose header size differs from the declared size:
//     DESIGN_ASSET_SIZE_MISMATCH;
// (c) `transparency: forbidden` with an alpha channel, every pixel opaque;
//     `required` with none: DESIGN_ASSET_TRANSPARENCY_MISMATCH;
// (d) SVGs with a <script>, an onload attribute, an external href:
//     DESIGN_ASSET_SVG_ACTIVE;
// (e) a header cut off: refused, naming the file, never admitted;
// (f) what the checks read: a PNG whose header is valid and whose image
//     data is not (at 20000 x 20000) passes, so nothing past the header is
//     read; no process naming the asset files is started around any save.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { scriptedEngine } from './harness/runs.mjs';
import { designScripts, inventoryOf, manifestOf, toPublished } from './harness/design/drive.mjs';
import { BEFORE_BUILD, assertPassed, assertReason, designModel, webpOf } from './harness/design/check41.mjs';
import { ACTIVE_SVG, M43, assetSession, headerOnlyPng, json, passiveSvg, pngOf, propose, refuseClose, sampled, truncatedPng } from './harness/design/assets43.mjs';

const SIZE = Object.freeze({ w: 48, h: 48 });
const HEADER_CODES = Object.freeze(['DESIGN_ASSET_FORMAT_MISMATCH', 'DESIGN_ASSET_SIZE_MISMATCH', 'DESIGN_ASSET_TRANSPARENCY_MISMATCH']);

describe('M525 asset header checks', () => {
  test('(a) to (f) one session of header faults on generated files; nothing decoded and nothing started', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD });
    designScripts(fx);
    const base = manifestOf(p);
    const model = designModel(inventoryOf(p));
    // A case: the favicon's default variant (or `slot`'s `variant`) replaced by `bytes` declared as `decl`.
    const caseOf = (name, file, bytes, decl, { slot = 'favicon', variant = 'default', code, names } = {}) => {
      const { manifest, files } = propose(base, [{ slot, variant, file: `${M43}/${file}`, bytes, ...decl }]);
      return { name, file: `${M43}/${file}`, code, names: names ?? [slot], model: { ...model, extra: { 'assets/manifest.json': json(manifest), ...files } } };
    };
    const png = { format: 'png', size: SIZE, transparency: 'any' };
    const cases = [
      caseOf('a flat PNG declared png at its size', 'favicon.png', pngOf(48, 48), png),
      caseOf('a PNG named and declared svg', 'favicon-png.svg', pngOf(48, 48), { format: 'svg', transparency: 'any' }, { code: 'DESIGN_ASSET_FORMAT_MISMATCH' }),
      caseOf('a WebP declared png', 'favicon-webp.png', webpOf(48, 48), png, { code: 'DESIGN_ASSET_FORMAT_MISMATCH' }),
      caseOf('a 32 x 32 PNG declared 48 x 48', 'favicon-32.png', pngOf(32, 32), png, { code: 'DESIGN_ASSET_SIZE_MISMATCH' }),
      caseOf('transparency forbidden, an alpha channel with every pixel opaque', 'favicon-rgba.png', pngOf(48, 48, { alpha: true }), { ...png, transparency: 'forbidden' }, { code: 'DESIGN_ASSET_TRANSPARENCY_MISMATCH' }),
      caseOf('transparency required, no alpha channel', 'favicon-rgb.png', pngOf(48, 48), { ...png, transparency: 'required' }, { code: 'DESIGN_ASSET_TRANSPARENCY_MISMATCH' }),
      caseOf('an SVG with a script', 'logo-script.svg', Buffer.from(ACTIVE_SVG.script), { format: 'svg', transparency: 'any' }, { slot: 'logo', variant: 'full', code: 'DESIGN_ASSET_SVG_ACTIVE' }),
      caseOf('an SVG with an onload attribute', 'logo-onload.svg', Buffer.from(ACTIVE_SVG.onload), { format: 'svg', transparency: 'any' }, { slot: 'logo', variant: 'full', code: 'DESIGN_ASSET_SVG_ACTIVE' }),
      caseOf('an SVG with an external href', 'logo-external.svg', Buffer.from(ACTIVE_SVG.external), { format: 'svg', transparency: 'any' }, { slot: 'logo', variant: 'full', code: 'DESIGN_ASSET_SVG_ACTIVE' }),
      caseOf('a PNG cut off inside its header', 'favicon-cut.png', truncatedPng(), png, { code: 'header' }),
      caseOf('a PNG whose header is valid and whose image data is not, 20000 x 20000', 'favicon-huge.png', headerOnlyPng(20000, 20000), { format: 'png', size: { w: 20000, h: 20000 }, transparency: 'forbidden' }),
      caseOf('transparency required, an alpha channel', 'favicon-alpha.png', pngOf(48, 48, { alpha: true, rgba: [0x0b, 0x5c, 0xad, 0x00] }), { ...png, transparency: 'required' }),
      caseOf('a passive SVG logo', 'logo-passive.svg', Buffer.from(passiveSvg(120, 40)), { format: 'svg', transparency: 'any' }, { slot: 'logo', variant: 'full' }),
    ];
    const pattern = new RegExp(`m43|\\.png\\b|\\.svg\\b|\\.webp\\b`);
    const seen = [];
    const out = await assetSession(fx, p.id, cases, {
      during: async (save) => {
        const s = await sampled(fx, pattern, save);
        seen.push(...s.seen);
        return s.value;
      },
    });
    const save = (name) => out.saves.find((s) => s.name === name).res;
    assertPassed(save(cases[0].name), 'the control: a flat PNG at its declared size');
    for (const c of cases.filter((x) => x.code && x.code !== 'header')) assertReason(save(c.name), c.code, c.names, c.name);
    // (e) Refused, naming the file, by a header reason (SEAM.md §507).
    const cut = cases.find((c) => c.code === 'header');
    const res = save(cut.name);
    assert.equal(res.status, 200, `${cut.name}: the save answers with its check (${res.status} ${res.text?.slice(0, 400)})`);
    assert.equal(res.body?.design_check?.outcome, 'refused', `${cut.name}: never admitted (${JSON.stringify(res.body?.design_check)})`);
    assert.ok((res.body.design_check.reasons ?? []).some((r) => HEADER_CODES.includes(r.code) && JSON.stringify(r.subjects ?? r).includes(cut.file)), `${cut.name}: a header reason naming ${cut.file} (${JSON.stringify(res.body.design_check.reasons)})`);
    // (f) Nothing past the header read; the controls pass.
    for (const name of ['a PNG whose header is valid and whose image data is not, 20000 x 20000', 'transparency required, an alpha channel', 'a passive SVG logo']) assertPassed(save(name), `${name} (headers only)`);
    assert.deepEqual(seen, [], 'no process naming the asset files started by the engine around any save (BS6 §4.1 rule 21)');
    await refuseClose(fx, p.id, out.run.id);
  });
});
