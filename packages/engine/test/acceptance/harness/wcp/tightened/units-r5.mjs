// R5 (spec version 2): the cut sheet states its unit and every length in it.

import { unitControl, selectedUnit, setUnit, lenRe, anyLen } from '../lib/units.mjs';

const INCHES = /\binch(es)?\b/i;
const MILLIMETRES = /\bmillimet(re|er)s?\b/i;

// R2.1's plan: one 2400 mm board, a 3 mm blade, two 800 mm pieces.
async function r21(t) {
  const P = await t.open();
  const { ui } = P;
  t.must(!!unitControl(ui), 'the page shows a unit selector offering millimetres and inches', ui.screenText().slice(0, 800));
  if (selectedUnit(ui) !== 'mm') await setUnit(ui, P, 'mm');
  await ui.setBlade('3');
  await ui.addBoard('2400');
  await ui.addPiece('800', 2, 'Shelf');
  return P;
}

function firstIndex(T, re) { const m = re.exec(T); return m ? m.index : Infinity; }

// The saved two-board plan (spec §9 shape, written by iteration 1's own
// public/js/store.mjs): boards of 1000 mm and 500 mm, three 400 mm pieces, a
// 3 mm blade; millimetres selected. It opens as the woodworker left it.
const TWO_BOARDS = { 'cutPlanner.plan': "{\"version\":1,\"bladeMm\":3,\"boards\":[{\"id\":\"b1\",\"lengthMm\":1000},{\"id\":\"b2\",\"lengthMm\":500}],\"pieces\":[{\"id\":\"p1\",\"lengthMm\":400,\"quantity\":3,\"label\":\"\"}],\"placements\":{}}", 'cutPlanner.unit': 'mm' };

const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

// The print view of the saved plan opens with its unit: the selected unit is
// named before the first board diagram on the printed page, not only in the
// cut sheet that follows the diagrams.
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
  const iName = firstIndex(T, name);
  t.check(iName < iDiagram, `the printed page names the unit (${label}) before the first board diagram`, T.slice(0, 1500));
}

function judge(t, T, unit) {
  const name = unit === 'in' ? INCHES : MILLIMETRES;
  const other = unit === 'in' ? MILLIMETRES : INCHES;
  const label = unit === 'in' ? 'inches' : 'millimetres';
  t.must(T.length > 0, 'the page has a print view', T);
  const iName = firstIndex(T, name);
  t.check(iName < Infinity, `the print view states the unit, ${label}`, T.slice(0, 1500));
  t.check(!other.test(T), `the print view does not state the other unit while ${label} is selected`, T.slice(0, 1500));
  t.check(!anyLen(unit === 'in' ? 'mm' : 'in').test(T), `no length on the print view carries the other unit's symbol`, T.slice(0, 1500));
  const L = unit === 'in' ? { board: '94.488', piece: '31.496', blade: '0.118', offcut: '31.26' } : { board: '2400', piece: '800', blade: '3', offcut: '794' };
  const sym = unit === 'in' ? 'in' : 'mm';
  const bladeRe = new RegExp(`(blade|kerf)[^\\d]{0,60}${L.blade.replace('.', '\\.')}(?!\\d)\\s*${unit === 'in' ? '(in\\b|inch|″|")' : 'mm\\b'}`, 'i');
  t.check(bladeRe.test(T), `the print view gives the blade width as ${L.blade} ${sym}`, T.slice(0, 1500));
  // The sheet opens with the unit, then the blade width and the boards.
  t.check(iName < firstIndex(T, bladeRe), `the unit (${label}) is stated at the top of the sheet, before its blade width and boards`, T.slice(0, 1500));
  t.check(lenRe(L.board, unit).test(T), `the print view gives the board length as ${L.board} ${sym}`, T.slice(0, 1500));
  t.check(new RegExp(`${lenRe(L.piece, unit).source}[^\\d]{0,60}shelf|shelf[^\\d]{0,60}${lenRe(L.piece, unit).source}`, 'i').test(T), `the print view gives the Shelf pieces as ${L.piece} ${sym}`, T.slice(0, 1500));
  t.check(lenRe(L.offcut, unit).test(T), `the print view gives the offcut as ${L.offcut} ${sym}`, T.slice(0, 1500));
}

const printOrder = async (t) => {
  const P = await t.open();
  const { ui } = P;
  t.must(selectedUnit(ui) === 'mm', 'the saved plan opens in millimetres', selectedUnit(ui));
  t.must(/\b194\s*mm\b/.test(ui.printText()) && /\b97\s*mm\b/.test(ui.printText()), 'the saved plan is loaded: offcuts of 194 mm and 97 mm', flat(ui.printText()).slice(0, 1500));
  judgeOrder(t, ui, 'mm');
  await setUnit(ui, P, 'in');
  t.must(selectedUnit(ui) === 'in', 'inches is selected', selectedUnit(ui));
  judgeOrder(t, ui, 'in');
  // The next session starts as the original one always has: from an empty store.
  P.local.clear();
};

export const scenarios = {
  'R5.5': {
    title: 'the print view states the selected unit at its top and every length carries its symbol; in inches the R2.1 plan prints 31.496 in pieces, a 0.118 in blade and a 31.26 in offcut; with the saved two-board plan the printed page names the unit before the first board diagram',
    storage: TWO_BOARDS,
    sessions: [printOrder, async (t) => {
      const P = await r21(t);
      const { ui } = P;
      await setUnit(ui, P, 'in');
      t.must(selectedUnit(ui) === 'in', 'inches is selected', selectedUnit(ui));
      judge(t, ui.printText(), 'in');
      await setUnit(ui, P, 'mm');
      t.must(selectedUnit(ui) === 'mm', 'millimetres is selected', selectedUnit(ui));
      judge(t, ui.printText(), 'mm');
    }],
  },
};
