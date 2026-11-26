// R2 (spec version 2): the layout's lengths in the selected unit.

import { same, kinds, lengths } from '../lib/steps.mjs';
import { unitControl, selectedUnit, setUnit, lenRe, numRe, shares } from '../lib/units.mjs';

const INCH_SYM = /\d\s*(in\b|inch|″)/i;

export const scenarios = {
  'R2.5': {
    title: 'in the situation of R2.1, inches shows the same bar with two 31.496 in pieces, two 0.118 in kerf marks and a 31.26 in offcut in the same proportions, and millimetres shows the R2.1 lengths again',
    sessions: [async (t) => {
      const P = await t.open();
      const { ui } = P;
      t.must(!!unitControl(ui), 'the page shows a unit selector offering millimetres and inches', ui.screenText().slice(0, 800));
      if (selectedUnit(ui) !== 'mm') await setUnit(ui, P, 'mm');
      await ui.setBlade('3');
      await ui.addBoard('2400');
      await ui.addPiece('800', 2);
      const bars0 = ui.bars();
      t.must(bars0.length === 1 && same(kinds(bars0[0]), ['piece', 'kerf', 'piece', 'kerf', 'offcut']) && same(lengths(bars0[0]), [800, 3, 800, 3, 794]),
        'in millimetres the bar is piece 800, kerf 3, piece 800, kerf 3, offcut 794', ui.snapshot());
      const snap = ui.snapshot();
      const share0 = shares(ui, bars0[0]);
      t.must(!!share0, 'every segment of the bar has a drawn size', bars0[0].segments.map((s) => [s.kind, s.lengthMm]));

      await setUnit(ui, P, 'in');
      t.must(selectedUnit(ui) === 'in', 'inches is selected', selectedUnit(ui));
      const bars = ui.bars();
      t.check(same(ui.snapshot(), snap), 'in inches the same bar is drawn, with the same pieces, kerfs and offcut', { now: ui.snapshot(), before: snap });
      const b = bars[0];
      t.must(!!b, 'a bar is drawn in inches', ui.snapshot());
      const want = { piece: '31.496', kerf: '0.118', offcut: '31.26' };
      for (const s of b.segments) {
        t.check(lenRe(want[s.kind], 'in').test(s.text), `in inches the ${s.kind} (${s.lengthMm} mm) shows ${want[s.kind]} in`, s.text);
      }
      t.check(b.segments.filter((s) => s.kind === 'piece').length === 2 && b.segments.filter((s) => s.kind === 'kerf').length === 2,
        'in inches the bar shows two pieces and two kerf marks', kinds(b));
      const share1 = shares(ui, b);
      t.check(!!share1 && share1.every((x, i) => Math.abs(x - share0[i]) <= 0.005), 'in inches the segments are drawn in the same proportions', { mm: share0, in: share1 });

      await setUnit(ui, P, 'mm');
      t.must(selectedUnit(ui) === 'mm', 'millimetres is selected again', selectedUnit(ui));
      t.check(same(ui.snapshot(), snap), 'back in millimetres the bar is unchanged', { now: ui.snapshot(), before: snap });
      const b2 = ui.bars()[0];
      for (const s of (b2 ? b2.segments : [])) {
        t.check(numRe(String(s.lengthMm)).test(s.text) && !INCH_SYM.test(s.text), `back in millimetres the ${s.kind} shows ${s.lengthMm} (no inches)`, s.text);
      }
      const share2 = b2 && shares(ui, b2);
      t.check(!!share2 && share2.every((x, i) => Math.abs(x - share0[i]) <= 0.005), 'back in millimetres the proportions are unchanged', { before: share0, now: share2 });
    }],
  },
};
