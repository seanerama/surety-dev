// R3: explain pieces that do not fit, and fix by adding a board or moving a piece.

import { same, plan, pieceLengths, barSum } from '../lib/steps.mjs';

const PLANNER = 'public/js/planner.mjs';
const mm = (n) => new RegExp(`(^|[^\\d.])${n}\\s*mm`, 'i');

// The id of the board other than `except` offered by a move control,
// preferring the option naming `length`.
function otherBoard(ui, instanceId, except, length) {
  const sel = ui.moveSelect(instanceId);
  if (!sel) throw new Error(`no move control (a select of boards) on piece ${instanceId}`);
  const opts = sel.options.filter((o) => o.value && o.value !== except && !o.disabled);
  const o = opts.find((x) => new RegExp(`(^|\\D)${length}(\\D|$)`).test(x.text)) || opts[0];
  if (!o) throw new Error(`the move control of ${instanceId} offers no other board`);
  return o.value;
}

// The text around an element, up to `levels` ancestors out, until it matches.
function textNear(ui, el, levels, test) {
  let last = '';
  for (let n = el, k = 0; n && k <= levels; n = n.parentElement, k++) {
    last = ui.visibleText(n, 'screen', { skipSegments: true });
    if (test(last)) return last;
  }
  return last;
}

export const scenarios = {
  'R3.1': {
    title: 'one 2400 mm board, a 3 mm blade and three 800 mm pieces: one 800 mm piece is unplaced, with a message that the pieces need 2406 mm (2400 mm plus 6 mm for two cuts) but the board is 2400 mm',
    sessions: [async (t) => {
      const { computeLayout } = await t.importCandidate(PLANNER);
      const L = computeLayout(plan({ blade: 3, boards: [2400], pieces: [[800, 3]] }));
      t.check(L && L.unplaced && L.unplaced.length === 1 && L.unplaced[0].lengthMm === 800, 'computeLayout leaves one 800 mm piece unplaced', L && L.unplaced);
      const why = JSON.stringify(L && L.unplaced && L.unplaced[0]);
      t.check(/NO_ROOM/.test(why) && mm(2406).test(why) && mm(2400).test(why) && mm(6).test(why), 'its reason is NO_ROOM with a sentence naming 2406 mm, 2400 mm and 6 mm', why);

      const { ui } = await t.open();
      await ui.setBlade(3);
      await ui.addBoard(2400);
      await ui.addPiece(800, 3);
      const un = ui.unplaced();
      t.check(un.length === 1, 'one piece is shown unplaced', un.map((u) => u.instanceId));
      t.check(un.length === 1 && un[0].lengthMm === 800, 'the unplaced piece is 800 mm', un.map((u) => [u.instanceId, u.lengthMm]));
      t.check(same(ui.bars().flatMap(pieceLengths), [800, 800]), 'the other two pieces are on the board', ui.snapshot());
      const text = un.length ? textNear(ui, un[0].el, 3, (s) => mm(2406).test(s)) : '';
      t.check(mm(2406).test(text), 'the message states that the pieces need 2406 mm', text);
      t.check(/(^|[^\d.])2400\s*mm[^.]*(^|[^\d.])6\s*mm|(^|[^\d.])6\s*mm[^.]*(^|[^\d.])2400\s*mm/i.test(text), 'the message breaks it down as 2400 mm of pieces plus 6 mm for the cuts', text);
      t.check(/(two|2)\s*cuts/i.test(text), 'the message names the two cuts', text);
    }],
  },

  'R3.2': {
    title: 'in the situation of R3.1 the message offers an add-board control; adding a 1200 mm board through it places the piece and the message disappears',
    sessions: [async (t) => {
      const P = await t.open({ prompt: ['1200'] });
      const { ui } = P;
      await ui.setBlade(3);
      await ui.addBoard(2400);
      await ui.addPiece(800, 3);
      t.must(ui.unplaced().length === 1, 'one piece is unplaced to begin with', ui.unplaced().map((u) => u.instanceId));
      const inline = ui.addButtons('board').filter((b) => ui.nearUnplaced(b));
      t.must(inline.length > 0, 'an add-board control is offered next to the unplaced piece');
      const btn = inline[0];
      const cont = ui.controlContainer(btn);
      let fields = ui.containerFields(cont);
      if (fields.length) await ui.type(fields[0], '1200');
      await ui.click(btn);
      if (ui.bars().length < 2) {
        // a control that first reveals its length field
        const again = ui.addButtons('board').filter((b) => ui.nearUnplaced(b));
        const c2 = again.length ? ui.controlContainer(again[0]) : null;
        fields = c2 ? ui.containerFields(c2) : [];
        if (again.length && fields.length) { await ui.type(fields[0], '1200'); await ui.click(again[0]); }
      }
      const bars = ui.bars();
      t.check(bars.length === 2, 'a second board is drawn', ui.snapshot());
      const nb = bars.find((b) => barSum(b) === 1200);
      t.check(!!nb && same(pieceLengths(nb), [800]), 'the new 1200 mm board holds the 800 mm piece', ui.snapshot());
      t.check(ui.unplaced().length === 0, 'no piece is unplaced any more', ui.unplaced().map((u) => u.instanceId));
      t.check(!mm(2406).test(ui.screenText()), 'the message about 2406 mm is gone', ui.screenText().slice(0, 600));
      t.check(ui.hasRowValue(1200), 'the board list shows the 1200 mm board');
    }],
  },

  'R3.3': {
    title: 'a move control on any piece moves it to another board, and both boards redraw with the piece in its new place',
    sessions: [async (t) => {
      const { computeLayout, applyMove } = await t.importCandidate(PLANNER);
      const p0 = plan({ blade: 3, boards: [2400, 1200], pieces: [[800, 2]] });
      const p1 = applyMove(p0, 'p1#2', 'b2');
      t.check(p1 && p1.placements && p1.placements['p1#2'] === 'b2', 'applyMove records the placement of p1#2 on b2', p1 && p1.placements);
      t.check(same(p0.placements, {}), 'applyMove leaves the original plan unchanged', p0.placements);
      const L = p1 && computeLayout(p1);
      const on = (id) => L && L.boards.find((b) => b.boardId === id);
      t.check(on('b2') && on('b2').segments.some((s) => s.kind === 'piece' && s.instanceId === 'p1#2'), 'computeLayout puts p1#2 on b2', L && L.boards);
      t.check(on('b1') && on('b1').segments.filter((s) => s.kind === 'piece').length === 1, 'computeLayout leaves one piece on b1', L && L.boards);

      const { ui } = await t.open();
      await ui.setBlade(3);
      await ui.addBoard(2400);
      await ui.addBoard(1200);
      await ui.addPiece(800, 2);
      let bars = ui.bars();
      const b1 = bars[0];
      t.must(b1 && pieceLengths(b1).length === 2, 'both pieces start on the 2400 mm board', ui.snapshot());
      const moved = b1.segments.filter((s) => s.kind === 'piece')[1].instanceId;
      t.must(!!moved, 'the placed pieces carry data-instance-id', ui.snapshot());
      const b2id = otherBoard(ui, moved, b1.boardId, 1200);
      await ui.move(moved, b2id);
      bars = ui.bars();
      const nb1 = bars.find((b) => b.boardId === b1.boardId);
      const nb2 = bars.find((b) => b.boardId === b2id);
      t.check(nb1 && same(pieceLengths(nb1), [800]) && barSum(nb1) === 2400, 'the 2400 mm board redraws with one piece', ui.snapshot());
      t.check(nb2 && nb2.segments.some((s) => s.kind === 'piece' && s.instanceId === moved) && barSum(nb2) === 1200, 'the 1200 mm board redraws with the moved piece', ui.snapshot());

      await ui.move(moved, b1.boardId);
      bars = ui.bars();
      const back = bars.find((b) => b.boardId === b1.boardId);
      t.check(back && back.segments.some((s) => s.kind === 'piece' && s.instanceId === moved) && pieceLengths(back).length === 2, 'moving it back redraws it on the 2400 mm board', ui.snapshot());

      await ui.addPiece(3000, 1, 'Beam');
      const un = ui.unplaced();
      t.check(un.length === 1 && !!ui.moveSelect(un[0].instanceId), 'an unplaced piece has a move control too', un.map((u) => u.instanceId));
    }],
  },

  'R3.4': {
    title: 'moving a piece to a board without room leaves the layout unchanged and gives the piece length, the kerf and the space left on that board in mm',
    sessions: [async (t) => {
      const { computeLayout, checkMove } = await t.importCandidate(PLANNER);
      const p = plan({ blade: 3, boards: [2400, 1200], pieces: [[800, 3]] });
      const L = computeLayout(p);
      const onB2 = L && L.boards.find((b) => b.boardId === 'b2');
      const id = onB2 && (onB2.segments.find((s) => s.kind === 'piece') || {}).instanceId;
      t.must(!!id, 'computeLayout puts one 800 mm piece on the 1200 mm board', L && L.boards);
      const r = checkMove(p, L, id, 'b1');
      t.check(r && r.ok === false, 'checkMove refuses moving it to the full 2400 mm board', r);
      const msg = String(r && r.message);
      t.check(mm(800).test(msg) && mm(3).test(msg) && (mm(797).test(msg) || mm(794).test(msg)), 'the refusal names the 800 mm piece, the 3 mm kerf and the space left on the board', msg);
      const ok = checkMove(p, L, id, 'b2');
      t.check(ok && ok.ok === true, 'checkMove accepts the board it is already on (its own length excluded)', ok);

      const { ui } = await t.open();
      await ui.setBlade(3);
      await ui.addBoard(2400);
      await ui.addBoard(1200);
      await ui.addPiece(800, 3);
      const bars = ui.bars();
      t.must(bars.length === 2 && pieceLengths(bars[0]).length === 2 && pieceLengths(bars[1]).length === 1, 'two pieces are on the 2400 mm board and one on the 1200 mm board', ui.snapshot());
      const piece = bars[1].segments.find((s) => s.kind === 'piece').instanceId;
      const before = ui.snapshot();
      const textBefore = ui.screenText();
      await ui.move(piece, bars[0].boardId);
      t.check(same(ui.snapshot(), before), 'the layout is unchanged', ui.snapshot());
      const textAfter = ui.screenText();
      const fresh = ui.newWords(textBefore, textAfter);
      t.check(fresh.length > 0, 'a message is shown', fresh);
      const el = ui.pieceEl(piece);
      const near = el ? textNear(ui, el, 4, (s) => mm(800).test(s) && mm(3).test(s) && (mm(797).test(s) || mm(794).test(s))) : textAfter;
      t.check(mm(800).test(near) && mm(3).test(near) && (mm(797).test(near) || mm(794).test(near)), 'the message gives the 800 mm piece length, the 3 mm kerf and the space left on that board', near.slice(0, 800));
    }],
  },

  'R3.5': {
    title: 'a piece longer than every board is unplaced with a message naming the piece length and the longest board length',
    sessions: [async (t) => {
      const { computeLayout } = await t.importCandidate(PLANNER);
      const L = computeLayout(plan({ blade: 3, boards: [2400, 1800], pieces: [[3000, 1, 'Beam']] }));
      const u = L && L.unplaced && L.unplaced[0];
      const why = JSON.stringify(u);
      t.check(L && L.unplaced.length === 1 && u.lengthMm === 3000, 'computeLayout leaves the 3000 mm piece unplaced', L && L.unplaced);
      t.check(/TOO_LONG/.test(why) && mm(3000).test(why) && mm(2400).test(why), 'its reason is TOO_LONG with a sentence naming 3000 mm and 2400 mm', why);

      const { ui } = await t.open();
      await ui.setBlade(3);
      await ui.addBoard(2400);
      await ui.addBoard(1800);
      await ui.addPiece(3000, 1, 'Beam');
      const un = ui.unplaced();
      t.check(un.length === 1 && un[0].lengthMm === 3000, 'the 3000 mm piece is shown unplaced', un.map((x) => [x.instanceId, x.lengthMm]));
      const text = un.length ? textNear(ui, un[0].el, 3, (s) => mm(3000).test(s) && mm(2400).test(s)) : '';
      t.check(mm(3000).test(text) && mm(2400).test(text), 'its message names the 3000 mm piece and the 2400 mm longest board', text);
    }],
  },
};
