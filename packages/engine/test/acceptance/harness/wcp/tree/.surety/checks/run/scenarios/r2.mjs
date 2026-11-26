// R2: visual cut layout with kerf.

import { same, plan, sum, kinds, lengths, barSum, pieceLengths, coreSegs } from '../lib/steps.mjs';

const PLANNER = 'public/js/planner.mjs';

// The drawn weight of a segment: flex-grow, a flex shorthand, a width or
// flex-basis, an SVG width, or a numeric custom property.
function weight(ui, el) {
  const eng = ui.engine();
  const num = (v) => { const m = /^\s*(-?[\d.]+)/.exec(v || ''); return m ? Number(m[1]) : NaN; };
  const tries = [eng.value(el, 'flex-grow', 'screen'), (eng.value(el, 'flex', 'screen') || '').split(/\s+/)[0], eng.value(el, 'width', 'screen'),
    eng.value(el, 'flex-basis', 'screen'), eng.value(el, 'inline-size', 'screen'), el.getAttribute('width')];
  for (const v of tries) { const n = num(v); if (Number.isFinite(n) && n > 0) return n; }
  for (const d of (el.getAttribute('style') || '').split(';')) {
    const m = /^\s*--[\w-]+\s*:\s*(-?[\d.]+)/.exec(d);
    if (m && Number(m[1]) > 0) return Number(m[1]);
  }
  return NaN;
}
function gridWeights(ui, bar) {
  const v = ui.engine().value(bar.el, 'grid-template-columns', 'screen') || '';
  const fr = [...v.matchAll(/([\d.]+)fr/g)].map((m) => Number(m[1]));
  return fr.length === bar.segments.length ? fr : null;
}

export const scenarios = {
  'R2.1': {
    title: 'one 2400 mm board, a 3 mm blade and two 800 mm pieces: one bar with two 800 mm pieces, two 3 mm kerf marks and a 794 mm offcut',
    sessions: [async (t) => {
      const { computeLayout } = await t.importCandidate(PLANNER);
      const L = computeLayout(plan({ blade: 3, boards: [2400], pieces: [[800, 2]] }));
      t.check(L && L.boards && L.boards.length === 1 && same(coreSegs(L.boards[0]), [['piece', 800], ['kerf', 3], ['piece', 800], ['kerf', 3], ['offcut', 794]]),
        'computeLayout gives the board piece 800, kerf 3, piece 800, kerf 3, offcut 794', L && L.boards);
      t.check(L && Array.isArray(L.unplaced) && L.unplaced.length === 0, 'computeLayout leaves nothing unplaced', L && L.unplaced);

      const { ui } = await t.open();
      await ui.setBlade(3);
      await ui.addBoard(2400);
      await ui.addPiece(800, 2);
      const bars = ui.bars();
      t.must(bars.length === 1, 'one bar is drawn', ui.snapshot());
      const b = bars[0];
      t.check(same(kinds(b), ['piece', 'kerf', 'piece', 'kerf', 'offcut']), 'the bar shows piece, kerf, piece, kerf, offcut in order', kinds(b));
      t.check(same(lengths(b), [800, 3, 800, 3, 794]), 'their lengths are 800, 3, 800, 3 and 794 mm', lengths(b));
      for (const s of b.segments) {
        t.check(new RegExp(`(^|[^\\d.])${s.lengthMm}([^\\d.]|$)`).test(s.text), `the ${s.kind} shows its length ${s.lengthMm}`, s.text);
      }
    }],
  },

  'R2.2': {
    title: "each bar's segments are drawn in proportion to their lengths, and each piece shows its length and its label",
    sessions: [async (t) => {
      const { ui } = await t.open();
      await ui.setBlade(3);
      await ui.addBoard(2400);
      await ui.addPiece(800, 1, 'Shelf');
      await ui.addPiece(500, 1);
      await ui.addBoard(1200);
      await ui.addPiece(1100, 1, 'Leg');
      const bars = ui.bars();
      t.must(bars.length === 2, 'two bars are drawn', ui.snapshot());
      for (const b of bars) {
        const total = barSum(b);
        let ws = gridWeights(ui, b) || b.segments.map((s) => weight(ui, s.el));
        const okW = ws.every((w) => Number.isFinite(w) && w > 0);
        t.check(okW, `every segment of the ${total} mm bar has a drawn size (flex-grow, width, flex-basis or grid track)`, b.segments.map((s, i) => [s.kind, s.lengthMm, ws[i]]));
        if (okW) {
          const W = sum(ws);
          const prop = b.segments.every((s, i) => Math.abs(ws[i] / W - s.lengthMm / total) <= 0.005);
          t.check(prop, `the segments of the ${total} mm bar are drawn in proportion to their lengths`, b.segments.map((s, i) => [s.kind, s.lengthMm, ws[i]]));
        }
      }
      const pieces = bars.flatMap((b) => b.segments.filter((s) => s.kind === 'piece'));
      const find = (l) => pieces.find((p) => p.lengthMm === l);
      t.must(find(800) && find(500) && find(1100), 'the 800, 500 and 1100 mm pieces are drawn', ui.snapshot());
      t.check(/(^|\D)800(\D|$)/.test(find(800).text) && /shelf/i.test(find(800).text), 'the 800 mm piece shows its length and its label "Shelf"', find(800).text);
      t.check(/(^|\D)500(\D|$)/.test(find(500).text), 'the unlabelled 500 mm piece shows its length', find(500).text);
      t.check(/(^|\D)1100(\D|$)/.test(find(1100).text) && /leg/i.test(find(1100).text), 'the 1100 mm piece shows its length and its label "Leg"', find(1100).text);
    }],
  },

  'R2.3': {
    title: 'one 2400 mm board, a 3 mm blade and three 800 mm pieces: adding a second 2400 mm board places all three, and each bar adds up to its board length',
    sessions: [async (t) => {
      const { computeLayout } = await t.importCandidate(PLANNER);
      const L = computeLayout(plan({ blade: 3, boards: [2400, 2400], pieces: [[800, 3]] }));
      t.check(L && L.unplaced && L.unplaced.length === 0, 'computeLayout places all three pieces on two 2400 mm boards', L && L.unplaced);
      t.check(L && L.boards && L.boards.length === 2 && L.boards.every((b) => sum(b.segments.map((s) => s.lengthMm)) === 2400),
        'computeLayout segments add up to 2400 mm on each board', L && L.boards);
      t.check(L && L.boards && sum(L.boards.map((b) => b.segments.filter((s) => s.kind === 'piece').length)) === 3, 'computeLayout places three pieces in all', L && L.boards);

      const { ui } = await t.open();
      await ui.setBlade(3);
      await ui.addBoard(2400);
      await ui.addPiece(800, 3);
      const first = ui.bars();
      t.check(first.length === 1 && pieceLengths(first[0]).length === 2, 'with one board, two of the three pieces are on it', ui.snapshot());
      await ui.addBoard(2400);
      const bars = ui.bars();
      t.check(bars.length === 2, 'two bars are drawn after adding the second board', ui.snapshot());
      t.check(bars.flatMap(pieceLengths).length === 3, 'all three 800 mm pieces are on the boards', ui.snapshot());
      t.check(ui.unplaced().length === 0, 'no piece is shown unplaced', ui.unplaced().map((u) => u.instanceId));
      for (const b of bars) t.check(barSum(b) === 2400, `the pieces, kerfs and offcut of board ${b.boardId} add up to 2400 mm`, lengths(b));
    }],
  },

  'R2.4': {
    title: 'changing the blade width redraws the layout with the new kerf length on every cut',
    sessions: [async (t) => {
      const { computeLayout } = await t.importCandidate(PLANNER);
      const L = computeLayout(plan({ blade: 5, boards: [2400], pieces: [[800, 2]] }));
      t.check(L && L.boards && same(coreSegs(L.boards[0]), [['piece', 800], ['kerf', 5], ['piece', 800], ['kerf', 5], ['offcut', 790]]),
        'computeLayout with a 5 mm blade gives kerfs of 5 mm and a 790 mm offcut', L && L.boards);

      const { ui } = await t.open();
      await ui.setBlade(3);
      await ui.addBoard(2400);
      await ui.addPiece(800, 3);
      await ui.addBoard(2400);
      const expect = (blade) => {
        const bars = ui.bars();
        const kerfs = bars.flatMap((b) => b.segments.filter((s) => s.kind === 'kerf').map((s) => s.lengthMm));
        t.check(kerfs.length === 3 && kerfs.every((k) => k === blade), `with a ${blade} mm blade every cut is a ${blade} mm kerf`, ui.snapshot());
        t.check(bars.length === 2 && bars.every((b) => barSum(b) === 2400), `with a ${blade} mm blade each bar still adds up to 2400 mm`, ui.snapshot());
        const offcuts = bars.map((b) => b.segments.filter((s) => s.kind === 'offcut').map((s) => s.lengthMm)).flat().sort((a, b) => a - b);
        t.check(same(offcuts, [2400 - 1600 - 2 * blade, 2400 - 800 - blade].sort((a, b) => a - b)), `with a ${blade} mm blade the offcuts are ${2400 - 1600 - 2 * blade} and ${2400 - 800 - blade} mm`, offcuts);
      };
      expect(3);
      await ui.setBlade(5);
      expect(5);
      await ui.setBlade(4);
      expect(4);
    }],
  },
};
