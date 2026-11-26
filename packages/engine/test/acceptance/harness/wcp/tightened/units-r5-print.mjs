// R5.5 (spec version 2), the printed page of a saved plan: the Verifier's
// check correction of the print finding (accept-r5-5 passed on the candidate
// that prints its board diagrams before naming the unit). With the saved
// two-board plan loaded, the print view must name the selected unit before
// the first board diagram, in millimetres and in inches. Run by
// check-scenario.mjs (accept-r5-5-print); accept-r5-5 is unchanged.

import { selectedUnit, setUnit } from '../lib/units.mjs';

const INCHES = /\binch(es)?\b/i;
const MILLIMETRES = /\bmillimet(re|er)s?\b/i;

// The saved two-board plan (spec §9 shape, as iteration 1's own
// public/js/store.mjs saved it): boards of 1000 mm and 500 mm, three 400 mm
// pieces, a 3 mm blade; millimetres selected.
const TWO_BOARDS = { 'cutPlanner.plan': "{\"version\":1,\"bladeMm\":3,\"boards\":[{\"id\":\"b1\",\"lengthMm\":1000},{\"id\":\"b2\",\"lengthMm\":500}],\"pieces\":[{\"id\":\"p1\",\"lengthMm\":400,\"quantity\":3,\"label\":\"\"}],\"placements\":{}}", 'cutPlanner.unit': 'mm' };

const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
function firstIndex(T, re) { const m = re.exec(T); return m ? m.index : Infinity; }

function judgeOrder(t, ui, unit) {
  const name = unit === 'in' ? INCHES : MILLIMETRES;
  const label = unit === 'in' ? 'inches' : 'millimetres';
  const T = flat(ui.printText());
  const bars = ui.bars('print');
  t.must(bars.length === 2, 'the print view shows the saved plan as two board diagrams', T.slice(0, 1500));
  const fig = bars[0].el.closest('figure') || bars[0].el;
  const first = flat(ui.visibleText(fig, 'print'));
  const iDiagram = first ? T.indexOf(first) : -1;
  t.must(iDiagram >= 0, 'the first board diagram is found in the print view', first.slice(0, 300));
  t.check(firstIndex(T, name) < iDiagram, `the printed page names the unit (${label}) before the first board diagram`, T.slice(0, 1500));
}

export const scenarios = {
  'R5.5': {
    title: 'with the saved two-board plan the printed page names the selected unit before the first board diagram, in millimetres and in inches',
    storage: TWO_BOARDS,
    sessions: [async (t) => {
      const P = await t.open();
      const { ui } = P;
      t.must(selectedUnit(ui) === 'mm', 'the saved plan opens in millimetres', selectedUnit(ui));
      t.must(/\b194\s*mm\b/.test(ui.printText()) && /\b97\s*mm\b/.test(ui.printText()), 'the saved plan is loaded: offcuts of 194 mm and 97 mm', flat(ui.printText()).slice(0, 1500));
      judgeOrder(t, ui, 'mm');
      await setUnit(ui, P, 'in');
      t.must(selectedUnit(ui) === 'in', 'inches is selected', selectedUnit(ui));
      judgeOrder(t, ui, 'in');
    }],
  },
};
