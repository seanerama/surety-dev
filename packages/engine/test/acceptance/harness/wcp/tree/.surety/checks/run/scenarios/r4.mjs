// R4: save the plan in this browser and reopen it.

import { same, deepEqual, plan, MemoryStorage, emptyPlanShape, pieceLengths } from '../lib/steps.mjs';

const STORE = 'public/js/store.mjs';
const KEY = 'cutPlanner.plan';

function saved(t) {
  const raw = t.storage()[KEY];
  if (raw === undefined) return { raw };
  try { return { raw, value: JSON.parse(raw) }; } catch { return { raw, bad: true }; }
}
function emptyPage(t, ui, P, when) {
  t.check(ui.bars().every((b) => !b.segments.some((s) => s.kind === 'piece')) && ui.bars().length === 0, `${when}: no board is drawn`, ui.snapshot());
  t.check(ui.rowFields().length === 0, `${when}: the board and piece lists are empty`, ui.rowFields().map((f) => f.value));
  t.check(ui.unplaced().length === 0, `${when}: no piece is listed unplaced`, ui.unplaced().map((u) => u.instanceId));
}

export const scenarios = {
  'R4.1': {
    title: 'after entering a blade width, boards and pieces and reloading the page, the same values and the same layout are shown',
    sessions: [
      async (t) => {
        const store = await t.importCandidate(STORE);
        const s = new MemoryStorage();
        const p = plan({ blade: 4, boards: [2500, 900], pieces: [[1000, 1, 'Shelf'], [800, 2, ''], [700, 1, 'Side']], placements: { 'p2#2': 'b2' } });
        store.savePlan(p, s);
        t.check(typeof s.getItem(KEY) === 'string', `savePlan writes localStorage["${KEY}"]`, [...s.data.keys()]);
        t.check(deepEqual(store.loadPlan(s), p), 'loadPlan reads back the plan savePlan wrote', store.loadPlan(s));

        const { ui } = await t.open();
        await ui.setBlade(4);
        await ui.addBoard(2500);
        await ui.addBoard(900);
        await ui.addPiece(1000, 1, 'Shelf');
        await ui.addPiece(800, 1, 'Rail');
        await ui.addPiece(700, 1, 'Side');
        const snap = ui.snapshot();
        t.check(snap.length === 2 && snap.flatMap((b) => b.segs.filter((x) => x[0] === 'piece')).length === 3, 'the plan is laid out on two boards', snap);
        const values = ui.rowFields().map((f) => f.value).sort();
        const blade = ui.blade().value;
        await t.unload();
        const sv = saved(t);
        t.check(!!sv.value, `the plan is saved in localStorage["${KEY}"] as JSON`, sv.raw);
        const v = sv.value || {};
        t.check(v.version === 1 && v.bladeMm === 4, 'the saved plan has version 1 and the 4 mm blade', v);
        t.check(Array.isArray(v.boards) && same(v.boards.map((b) => b.lengthMm), [2500, 900]), 'the saved plan holds both boards', v.boards);
        t.check(Array.isArray(v.pieces) && same(v.pieces.map((p) => [p.lengthMm, p.quantity, p.label]).sort(), [[1000, 1, 'Shelf'], [700, 1, 'Side'], [800, 1, 'Rail']].sort()), 'the saved plan holds the three pieces with quantities and labels', v.pieces);
        return { snap, values, blade };
      },
      async (t) => {
        const { ui } = await t.open();
        t.check(ui.blade().value === t.carry.blade, 'the blade width is restored', [ui.blade().value, t.carry.blade]);
        t.check(same(ui.rowFields().map((f) => f.value).sort(), t.carry.values), 'the board and piece lists are restored', ui.rowFields().map((f) => f.value).sort());
        t.check(same(ui.snapshot(), t.carry.snap), 'the same layout is shown', { now: ui.snapshot(), before: t.carry.snap });
      },
    ],
  },

  'R4.2': {
    title: 'a piece moved to another board with the move control is still on that board after reloading the page',
    sessions: [
      async (t) => {
        const { ui } = await t.open();
        await ui.setBlade(3);
        await ui.addBoard(2400);
        await ui.addBoard(1200);
        await ui.addPiece(800, 2);
        const b1 = ui.bars()[0];
        t.must(b1 && pieceLengths(b1).length === 2, 'both pieces start on the 2400 mm board', ui.snapshot());
        const moved = b1.segments.filter((s) => s.kind === 'piece')[1].instanceId;
        const sel = ui.moveSelect(moved);
        t.must(!!sel, 'the piece has a move control');
        const target = sel.options.filter((o) => o.value && o.value !== b1.boardId).map((o) => o.value)[0];
        t.must(!!target, 'the move control offers the other board');
        await ui.move(moved, target);
        const nb = ui.bars().find((b) => b.boardId === target);
        t.must(nb && nb.segments.some((s) => s.instanceId === moved), 'the piece is moved to the 1200 mm board', ui.snapshot());
        const snap = ui.snapshot();
        await t.unload();
        const sv = saved(t);
        t.check(sv.value && sv.value.placements && sv.value.placements[moved] === target, 'the saved plan records the manual placement', sv.value && sv.value.placements);
        return { moved, target, snap };
      },
      async (t) => {
        const { ui } = await t.open();
        const nb = ui.bars().find((b) => b.boardId === t.carry.target);
        t.check(nb && nb.segments.some((s) => s.kind === 'piece' && s.instanceId === t.carry.moved), 'after reloading the piece is still on the board it was moved to', ui.snapshot());
        t.check(same(ui.snapshot(), t.carry.snap), 'the layout is the one before reloading', { now: ui.snapshot(), before: t.carry.snap });
      },
    ],
  },

  'R4.3': {
    title: 'a clear-plan control, after a confirmation, empties the plan, and reloading the page shows the empty plan',
    sessions: [
      async (t) => {
        const store = await t.importCandidate(STORE);
        const s = new MemoryStorage();
        store.savePlan(plan({ boards: [2400], pieces: [[800, 1]] }), s);
        store.clearPlan(s);
        t.check(s.getItem(KEY) === null, `clearPlan removes localStorage["${KEY}"]`, s.getItem(KEY));

        const P = await t.open({ confirm: [false, true] });
        const { ui } = P;
        await ui.addBoard(2400);
        await ui.addPiece(800, 1);
        const full = ui.snapshot();
        const clear = () => ui.buttonNamed(/clear|reset|start over|new plan/);
        t.must(!!clear(), 'a clear-plan control is shown');
        await ui.click(clear());
        t.check(P.calls.confirm.length === 1, 'clearing asks for a confirmation', P.calls.confirm);
        t.check(same(ui.snapshot(), full) && ui.hasRowValue(2400), 'declining the confirmation keeps the plan', ui.snapshot());
        await ui.click(clear());
        t.check(P.calls.confirm.length === 2, 'clearing again asks again', P.calls.confirm);
        emptyPage(t, ui, P, 'after confirming');
        await t.unload();
        const sv = saved(t);
        t.check(sv.raw === undefined || (sv.value && emptyPlanShape(sv.value)), 'local storage holds no plan or the empty plan', sv.raw);
      },
      async (t) => {
        const P = await t.open();
        emptyPage(t, P.ui, P, 'after reloading');
      },
    ],
  },

  'R4.4': {
    title: 'opening the page for the first time with no saved plan shows an empty plan with no error',
    sessions: [
      async (t) => {
        const store = await t.importCandidate(STORE);
        let p = null;
        let err = null;
        try { p = store.loadPlan(new MemoryStorage()); } catch (e) { err = e; }
        t.check(!err && emptyPlanShape(p), 'loadPlan with nothing saved returns the empty plan', err ? String(err) : p);
        for (const [what, raw] of [['unparsable', '{not json'], ['of another version', JSON.stringify({ version: 2, bladeMm: 3, boards: [], pieces: [], placements: {} })], ['malformed', JSON.stringify({ version: 1, boards: 'x' })]]) {
          let q = null; let e2 = null;
          try { q = store.loadPlan(new MemoryStorage({ [KEY]: raw })); } catch (e) { e2 = e; }
          t.check(!e2 && emptyPlanShape(q), `loadPlan with a ${what} saved value returns the empty plan without throwing`, e2 ? String(e2) : q);
        }
        const throwing = { getItem() { throw new Error('storage disabled'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('storage disabled'); } };
        let e3 = null; let q3 = null; let w = null;
        try { q3 = store.loadPlan(throwing); w = store.savePlan(plan({ boards: [2400] }), throwing); } catch (e) { e3 = e; }
        t.check(!e3 && emptyPlanShape(q3), 'loadPlan on a storage that throws returns the empty plan', e3 ? String(e3) : q3);
        t.check(!e3 && w && w.ok === false, 'savePlan on a storage that throws reports { ok: false }', e3 ? String(e3) : w);

        const P = await t.open();
        const { ui } = P;
        t.check(P.report.pageErrors.length === 0, 'the page opens without a script error', P.report.pageErrors);
        t.check(P.report.consoleErrors.length === 0, 'the page logs no error', P.report.consoleErrors);
        t.check(!!ui.blade(), 'the blade width field is shown');
        emptyPage(t, ui, P, 'with no saved plan');
        t.check(P.calls.alert.length === 0, 'no alert is shown', P.calls.alert);
      },
    ],
  },
};
