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

export const scenarios = {
  'R5.5': {
    title: 'the print view states the selected unit at its top and every length carries its symbol; in inches the R2.1 plan prints 31.496 in pieces, a 0.118 in blade and a 31.26 in offcut',
    sessions: [async (t) => {
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
