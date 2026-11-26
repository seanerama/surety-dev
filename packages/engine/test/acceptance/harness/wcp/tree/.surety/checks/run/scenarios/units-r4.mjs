// R4 (spec version 2): the selected unit saved and restored; a plan saved by
// the previous version (no unit) reopens unchanged in millimetres.

import { same, deepEqual, plan, MemoryStorage, pieceLengths } from '../lib/steps.mjs';
import { unitControl, selectedUnit, setUnit, lenRe } from '../lib/units.mjs';

const STORE = 'public/js/store.mjs';
const PLAN_KEY = 'cutPlanner.plan';
const UNIT_KEY = 'cutPlanner.unit';

const values = (ui) => ui.rowFields().map((f) => f.value).sort();
const segTexts = (ui) => ui.bars().map((b) => b.segments.map((s) => [s.kind, s.text]));
function view(ui) {
  return { unit: selectedUnit(ui), values: values(ui), blade: ui.blade().value, snap: ui.snapshot(), texts: segTexts(ui) };
}
function savedPlan(t) {
  try { return JSON.parse(t.storage()[PLAN_KEY]); } catch { return null; }
}
function sameView(t, ui, before, when) {
  const now = view(ui);
  t.check(now.unit === before.unit, `${when}: ${before.unit === 'in' ? 'inches' : 'millimetres'} is still selected`, now.unit);
  t.check(same(now.values, before.values), `${when}: the lists show the same values`, { now: now.values, before: before.values });
  t.check(now.blade === before.blade, `${when}: the blade width shows the same value`, { now: now.blade, before: before.blade });
  t.check(same(now.snap, before.snap), `${when}: the same layout is shown`, { now: now.snap, before: before.snap });
  t.check(same(now.texts, before.texts), `${when}: the layout shows the same lengths`, { now: now.texts, before: before.texts });
}

// Iteration 1's saved plan: a 3 mm blade, a 2400 mm board, three 800 mm pieces.
const OLD_PLAN = plan({ blade: 3, boards: [2400], pieces: [[800, 3]] });

export const scenarios = {
  'R4.5': {
    title: 'after selecting inches and reloading, inches is still selected with the same values and layout; the same holds for millimetres',
    sessions: [
      async (t) => {
        const store = await t.importCandidate(STORE);
        const s = new MemoryStorage();
        store.saveUnit('in', s);
        t.check(s.getItem(UNIT_KEY) === 'in' && store.loadUnit(s) === 'in', `saveUnit("in") writes localStorage["${UNIT_KEY}"] and loadUnit reads it back`, [s.getItem(UNIT_KEY)]);
        store.saveUnit('mm', s);
        t.check(store.loadUnit(s) === 'mm', 'loadUnit reads back "mm" after saveUnit("mm")', s.getItem(UNIT_KEY));

        const P = await t.open();
        const { ui } = P;
        t.must(!!unitControl(ui), 'the page shows a unit selector offering millimetres and inches', ui.screenText().slice(0, 800));
        if (selectedUnit(ui) !== 'mm') await setUnit(ui, P, 'mm');
        await ui.setBlade('3');
        await ui.addBoard('2400');
        await ui.addPiece('800', 3);
        await ui.addPiece('500', 1, 'Rail');
        await setUnit(ui, P, 'in');
        const v = view(ui);
        t.must(v.unit === 'in', 'inches is selected', v.unit);
        t.check(v.values.includes('94.488') && v.blade === '0.118', 'the lists and blade show inches', v);
        await t.unload();
        t.check(t.storage()[UNIT_KEY] === 'in', `the selected unit is saved in localStorage["${UNIT_KEY}"] as "in"`, t.storage()[UNIT_KEY]);
        const sp = savedPlan(t);
        t.check(sp && sp.bladeMm === 3 && same(sp.boards.map((b) => b.lengthMm), [2400]), 'the saved plan stays in millimetres', sp);
        return v;
      },
      async (t) => {
        const P = await t.open();
        const { ui } = P;
        t.must(!!unitControl(ui), 'the reloaded page shows the unit selector');
        sameView(t, ui, t.carry, 'after reloading in inches');
        const piece = ui.bars().flatMap((b) => b.segments).find((s) => s.kind === 'piece' && s.lengthMm === 800);
        t.check(piece && lenRe('31.496', 'in').test(piece.text), 'after reloading the 800 mm piece shows 31.496 in', piece && piece.text);
        await setUnit(ui, P, 'mm');
        const v = view(ui);
        t.must(v.unit === 'mm', 'millimetres is selected', v.unit);
        t.check(v.values.includes('2400') && v.blade === '3', 'the lists and blade show millimetres', v);
        await t.unload();
        t.check(t.storage()[UNIT_KEY] === 'mm' || t.storage()[UNIT_KEY] === undefined, `the selected unit is saved as millimetres (localStorage["${UNIT_KEY}"] "mm")`, t.storage()[UNIT_KEY]);
        return v;
      },
      async (t) => {
        const P = await t.open();
        const { ui } = P;
        t.must(!!unitControl(ui), 'the reloaded page shows the unit selector');
        sameView(t, ui, t.carry, 'after reloading in millimetres');
      },
    ],
  },

  'R4.6': {
    title: 'a plan saved by the previous version (3 mm blade, a 2400 mm board, three 800 mm pieces, no unit) opens in millimetres as 3 mm, 2400 mm and 800 mm with the layout of R3.1',
    storage: { [PLAN_KEY]: JSON.stringify(OLD_PLAN) },
    sessions: [async (t) => {
      const store = await t.importCandidate(STORE);
      const s = new MemoryStorage({ [PLAN_KEY]: JSON.stringify(OLD_PLAN) });
      t.check(store.loadUnit(s) === 'mm', 'loadUnit with no saved unit returns "mm"', store.loadUnit(s));
      t.check(deepEqual(store.loadPlan(s), OLD_PLAN), 'loadPlan reads the previous version\'s plan unchanged', store.loadPlan(s));

      t.check(t.storageInit[UNIT_KEY] === undefined && typeof t.storageInit[PLAN_KEY] === 'string', 'the browser holds the previous version\'s plan and no unit');
      const P = await t.open();
      const { ui } = P;
      t.check(P.report.pageErrors.length === 0, 'the page opens without a script error', P.report.pageErrors);
      t.must(!!unitControl(ui), 'the page shows a unit selector offering millimetres and inches', ui.screenText().slice(0, 800));
      t.check(selectedUnit(ui) === 'mm', 'millimetres is selected', selectedUnit(ui));
      t.check(ui.blade().value === '3', 'the blade width shows 3', ui.blade().value);
      const vals = values(ui);
      t.check(vals.filter((v) => v === '2400').length === 1, 'the board list shows the 2400 mm board', vals);
      t.check(vals.filter((v) => v === '800').length === 1, 'the piece list shows the 800 mm piece', vals);
      const row = ui.rowOf(ui.rowField('800'));
      t.check(row.querySelectorAll('input').some((f) => f.value === '3'), 'the 800 mm piece is listed with quantity 3', row.querySelectorAll('input').map((f) => f.value));
      const bars = ui.bars();
      t.check(bars.length === 1 && same(bars[0].segments.map((x) => [x.kind, x.lengthMm]), [['piece', 800], ['kerf', 3], ['piece', 800], ['kerf', 3], ['offcut', 794]]),
        'the board holds two 800 mm pieces as in R3.1', ui.snapshot());
      t.check(same(bars.flatMap(pieceLengths), [800, 800]), 'two pieces are placed', ui.snapshot());
      const un = ui.unplaced();
      t.check(un.length === 1 && un[0].lengthMm === 800, 'one 800 mm piece is unplaced as in R3.1', un.map((u) => [u.instanceId, u.lengthMm]));
      const near = un.length ? (() => { let x = ''; for (let n = un[0].el, k = 0; n && k <= 3; n = n.parentElement, k++) { x = ui.visibleText(n); if (lenRe('2406', 'mm').test(x)) break; } return x; })() : '';
      t.check(lenRe('2406', 'mm').test(near), 'its message states 2406 mm in millimetres', near);
      await t.settle(1100);
      const sp = savedPlan(t);
      t.check(sp && deepEqual(sp, OLD_PLAN), 'the saved plan is unchanged after opening', sp);
    }],
  },
};
