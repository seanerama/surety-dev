// R1.1 and R4.4 as spec version 2 words them: every length labelled with the
// selected unit (mm when no unit has been chosen), and a first opening with
// nothing saved showing millimetres selected.

import { MemoryStorage } from '../lib/steps.mjs';
import { unitControl, selectedUnit, setUnit } from '../lib/units.mjs';

const STORE = 'public/js/store.mjs';
const UNIT_KEY = 'cutPlanner.unit';
const MM = /(^|[^a-z])(mm|millimetres?|millimeters?)([^a-z]|$)/;
const INCH = /(^|[^a-z])(in|inch|inches)([^a-z]|$)|″/;

// The length inputs: blade width, add-board length, add-piece length.
function lengthInputs(ui) {
  const b = ui.addFields('board');
  const p = ui.addFields('piece');
  return [['the blade width field', ui.blade()], ['the board length input', b.len], ['the piece length input', p.len]];
}

function labelledIn(t, ui, unit, when) {
  for (const [what, el] of lengthInputs(ui)) {
    const text = el ? ui.unitText(el) : '';
    if (unit === 'in') {
      t.check(!!el && INCH.test(text) && !MM.test(text), `${when}: ${what} is labelled in inches, not mm`, el ? text : 'not found');
    } else {
      t.check(!!el && MM.test(text) && !INCH.test(text.replace(/\bin\s+(mm|millimet)/g, '')), `${when}: ${what} is labelled in mm`, el ? text : 'not found');
    }
  }
}

export const scenarios = {
  'R1.1': {
    title: 'each length input (blade width, board length, piece length) is labelled with the selected unit, mm when no unit has been chosen',
    sessions: [async (t) => {
      const P = await t.open();
      const { ui } = P;
      t.must(!!unitControl(ui), 'the page shows a unit selector offering millimetres and inches', ui.screenText().slice(0, 800));
      t.check(selectedUnit(ui) === 'mm', 'with no unit chosen, millimetres is selected', selectedUnit(ui));
      labelledIn(t, ui, 'mm', 'with no unit chosen');
      await setUnit(ui, P, 'in');
      t.must(selectedUnit(ui) === 'in', 'inches can be selected', selectedUnit(ui));
      labelledIn(t, ui, 'in', 'with inches selected');
      await setUnit(ui, P, 'mm');
      t.must(selectedUnit(ui) === 'mm', 'millimetres can be selected again', selectedUnit(ui));
      labelledIn(t, ui, 'mm', 'with millimetres selected again');
    }],
  },

  'R4.4': {
    title: 'opening the page for the first time with no saved plan shows an empty plan with no error, with millimetres selected',
    sessions: [async (t) => {
      const store = await t.importCandidate(STORE);
      const ask = (s) => { try { return store.loadUnit(s); } catch (e) { return 'threw ' + String(e); } };
      t.check(ask(new MemoryStorage()) === 'mm', 'loadUnit with nothing saved returns "mm"', ask(new MemoryStorage()));
      t.check(ask(new MemoryStorage({ [UNIT_KEY]: 'cm' })) === 'mm', 'loadUnit with an unrecognised saved unit returns "mm"', ask(new MemoryStorage({ [UNIT_KEY]: 'cm' })));
      const throwing = { getItem() { throw new Error('storage disabled'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('storage disabled'); } };
      t.check(ask(throwing) === 'mm', 'loadUnit on a storage that throws returns "mm" without throwing', ask(throwing));

      t.check(Object.keys(t.storageInit).length === 0, 'the browser holds nothing saved', t.storageInit);
      const P = await t.open();
      const { ui } = P;
      t.check(P.report.pageErrors.length === 0, 'the page opens without a script error', P.report.pageErrors);
      t.check(P.report.consoleErrors.length === 0, 'the page logs no error', P.report.consoleErrors);
      t.must(!!unitControl(ui), 'the page shows a unit selector offering millimetres and inches', ui.screenText().slice(0, 800));
      t.check(selectedUnit(ui) === 'mm', 'millimetres is selected', selectedUnit(ui));
      t.check(ui.rowFields().length === 0 && ui.bars().length === 0, 'the plan is empty (no board or piece listed, no bar drawn)', ui.snapshot());
      t.check(P.calls.alert.length === 0, 'no alert is shown', P.calls.alert);
    }],
  },
};
