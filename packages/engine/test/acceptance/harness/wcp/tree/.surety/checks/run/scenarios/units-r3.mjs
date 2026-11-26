// R3 (spec version 2): the unplaced explanation in the selected unit.

import { same, plan, pieceLengths } from '../lib/steps.mjs';
import { unitControl, selectedUnit, setUnit, lenRe, textNear } from '../lib/units.mjs';

const PLANNER = 'public/js/planner.mjs';

const inchMessage = (s) => lenRe('94.724', 'in').test(s) && lenRe('94.488', 'in').test(s) && lenRe('0.236', 'in').test(s);

export const scenarios = {
  'R3.6': {
    title: 'in the situation of R3.1, inches keeps the same piece unplaced and states 94.724 in needed (94.488 in of pieces plus 0.236 in for two cuts) but the board is 94.488 in',
    sessions: [async (t) => {
      const { computeLayout } = await t.importCandidate(PLANNER);
      const p = plan({ blade: 3, boards: [2400], pieces: [[800, 3]] });
      const Lmm = computeLayout(p);
      const Lin = computeLayout(p, 'in');
      t.check(Lin && Lin.unplaced && Lin.unplaced.length === 1 && Lmm && Lmm.unplaced && Lin.unplaced[0].instanceId === Lmm.unplaced[0].instanceId,
        'computeLayout(plan, "in") leaves the same piece unplaced as in millimetres', { mm: Lmm && Lmm.unplaced, in: Lin && Lin.unplaced });
      t.check(Lin && same(Lin.boards, Lmm.boards), 'computeLayout(plan, "in") places the boards exactly as in millimetres', { mm: Lmm && Lmm.boards, in: Lin && Lin.boards });
      const why = JSON.stringify(Lin && Lin.unplaced && Lin.unplaced[0]);
      t.check(/NO_ROOM/.test(why) && inchMessage(why), 'its reason is NO_ROOM with a sentence naming 94.724 in, 94.488 in and 0.236 in', why);

      const P = await t.open();
      const { ui } = P;
      t.must(!!unitControl(ui), 'the page shows a unit selector offering millimetres and inches', ui.screenText().slice(0, 800));
      if (selectedUnit(ui) !== 'mm') await setUnit(ui, P, 'mm');
      await ui.setBlade('3');
      await ui.addBoard('2400');
      await ui.addPiece('800', 3);
      const un0 = ui.unplaced();
      t.must(un0.length === 1 && un0[0].lengthMm === 800, 'in millimetres one 800 mm piece is unplaced', un0.map((u) => [u.instanceId, u.lengthMm]));
      const snap = ui.snapshot();

      await setUnit(ui, P, 'in');
      t.must(selectedUnit(ui) === 'in', 'inches is selected', selectedUnit(ui));
      const un = ui.unplaced();
      t.check(un.length === 1 && un[0].instanceId === un0[0].instanceId, 'in inches the same piece is unplaced', un.map((u) => u.instanceId));
      t.check(same(ui.snapshot(), snap) && same(ui.bars().flatMap(pieceLengths), [800, 800]), 'in inches the other two pieces stay on the board', ui.snapshot());
      const text = un.length ? textNear(ui, un[0].el, 3, inchMessage) : '';
      t.check(lenRe('94.724', 'in').test(text), 'the message states that the pieces need 94.724 in', text);
      t.check(/(^|[^\d.])94\.488(?!\d)\s*(in\b|inch|″)[^.]*(^|[^\d.])0\.236(?!\d)\s*(in\b|inch|″)/i.test(text), 'the message breaks it down as 94.488 in of pieces plus 0.236 in for the cuts', text);
      t.check(/(two|2)\s*cuts/i.test(text), 'the message names the two cuts', text);
      t.check(/0\.236(?!\d)\s*(in\b|inch|″)[^]*94\.488(?!\d)\s*(in\b|inch|″)/i.test(text), 'the message states the board is 94.488 in', text);
      t.check(!/\d\s*mm\b/i.test(text), 'the message gives no length in millimetres', text);
    }],
  },
};
