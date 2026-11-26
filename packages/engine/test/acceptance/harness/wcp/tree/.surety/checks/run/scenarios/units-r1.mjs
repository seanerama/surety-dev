// R1 (spec version 2): the millimetres/inches selector; entry and display in
// the selected unit, lengths kept in millimetres.

import { same, close } from '../lib/steps.mjs';
import { unitControl, selectedUnit, setUnit, lenRe } from '../lib/units.mjs';

const PLAN_KEY = 'cutPlanner.plan';
const INCH = /(^|[^a-z])(in|inch|inches)([^a-z]|$)|″/;

function savedPlan(t) {
  try { return JSON.parse(t.storage()[PLAN_KEY]); } catch { return null; }
}
const values = (ui) => ui.rowFields().map((f) => f.value).sort();
const segTexts = (ui) => ui.bars().map((b) => b.segments.map((s) => [s.kind, s.text]));

export const scenarios = {
  'R1.5': {
    title: 'a unit selector offers millimetres and inches; in inches a 94.5 in board, a 31.5 in piece and a 0.25 in blade show as entered, and in millimetres as 2400.3 mm, 800.1 mm and 6.35 mm',
    sessions: [async (t) => {
      const P = await t.open();
      const { ui } = P;
      const c = unitControl(ui);
      t.must(!!c, 'the page shows a unit selector offering millimetres and inches', ui.screenText().slice(0, 800));
      await setUnit(ui, P, 'in');
      t.must(selectedUnit(ui) === 'in', 'inches can be selected', selectedUnit(ui));
      t.check(INCH.test(ui.unitText(ui.blade())), 'with inches selected the blade width field is labelled in inches', ui.unitText(ui.blade()));
      await ui.addBoard('94.5');
      await ui.addPiece('31.5', 1);
      await ui.setBlade('0.25');
      t.check(ui.hasRowValue('94.5'), 'the board list shows the board as 94.5', values(ui));
      t.check(ui.hasRowValue('31.5'), 'the piece list shows the piece as 31.5', values(ui));
      t.check(ui.blade().value === '0.25', 'the blade width shows 0.25', ui.blade().value);
      const bars = ui.bars();
      t.must(bars.length === 1, 'one bar is drawn', ui.snapshot());
      const piece = bars[0].segments.find((s) => s.kind === 'piece');
      const kerf = bars[0].segments.find((s) => s.kind === 'kerf');
      t.check(piece && lenRe('31.5', 'in').test(piece.text), 'the piece in the layout shows 31.5 in', piece && piece.text);
      t.check(kerf && lenRe('0.25', 'in').test(kerf.text), 'the kerf in the layout shows 0.25 in', kerf && kerf.text);
      t.check(piece && close(piece.lengthMm, 800.1, 1e-6), 'the piece is kept as 800.1 mm (31.5 × 25.4)', piece && piece.lengthMm);
      t.check(kerf && close(kerf.lengthMm, 6.35, 1e-6), 'the kerf is kept as 6.35 mm (0.25 × 25.4)', kerf && kerf.lengthMm);
      const total = bars[0].segments.reduce((a, s) => a + s.lengthMm, 0);
      t.check(close(total, 2400.3, 1e-6), 'the board is kept as 2400.3 mm (94.5 × 25.4)', total);
      const snap = ui.snapshot();

      await setUnit(ui, P, 'mm');
      t.must(selectedUnit(ui) === 'mm', 'millimetres can be selected again', selectedUnit(ui));
      t.check(ui.hasRowValue('2400.3'), 'in millimetres the board list shows 2400.3', values(ui));
      t.check(ui.hasRowValue('800.1'), 'in millimetres the piece list shows 800.1', values(ui));
      t.check(ui.blade().value === '6.35', 'in millimetres the blade width shows 6.35', ui.blade().value);
      const b2 = ui.bars()[0];
      const p2 = b2 && b2.segments.find((s) => s.kind === 'piece');
      const k2 = b2 && b2.segments.find((s) => s.kind === 'kerf');
      t.check(p2 && lenRe('800.1', 'mm').test(p2.text), 'the piece in the layout shows 800.1 mm', p2 && p2.text);
      t.check(k2 && lenRe('6.35', 'mm').test(k2.text), 'the kerf in the layout shows 6.35 mm', k2 && k2.text);
      t.check(same(ui.snapshot(), snap), 'switching the unit leaves the layout unchanged', { now: ui.snapshot(), before: snap });
      await t.settle(1100);
      const v = savedPlan(t);
      t.check(v && v.boards && v.boards.length === 1 && close(v.boards[0].lengthMm, 94.5 * 25.4, 1e-6)
        && v.pieces && v.pieces.length === 1 && close(v.pieces[0].lengthMm, 31.5 * 25.4, 1e-6) && close(v.bladeMm, 0.25 * 25.4, 1e-6),
      'the saved plan holds the lengths in millimetres (inches × 25.4)', v);
    }],
  },

  'R1.6': {
    title: 'a 2400 mm board, an 800 mm piece and a 3 mm blade show as 94.488 in, 31.496 in and 0.118 in, and as 2400 mm, 800 mm and 3 mm again after switching back and forth, with the same layout and offcuts',
    sessions: [async (t) => {
      const P = await t.open();
      const { ui } = P;
      t.must(!!unitControl(ui), 'the page shows a unit selector offering millimetres and inches', ui.screenText().slice(0, 800));
      if (selectedUnit(ui) !== 'mm') await setUnit(ui, P, 'mm');
      await ui.setBlade('3');
      await ui.addBoard('2400');
      await ui.addPiece('800', 1);
      const snap = ui.snapshot();
      t.must(snap.length === 1 && same(snap[0].segs.map((s) => [s[0], s[1]]), [['piece', 800], ['kerf', 3], ['offcut', 1597]]),
        'the layout is piece 800, kerf 3, offcut 1597 mm', snap);
      await t.settle(1100);
      const plan0 = savedPlan(t);
      const mmTexts = segTexts(ui);

      for (let round = 1; round <= 3; round++) {
        await setUnit(ui, P, 'in');
        t.check(selectedUnit(ui) === 'in', `round ${round}: inches is selected`, selectedUnit(ui));
        t.check(ui.hasRowValue('94.488'), `round ${round}: in inches the board shows 94.488`, values(ui));
        t.check(ui.hasRowValue('31.496'), `round ${round}: in inches the piece shows 31.496`, values(ui));
        t.check(ui.blade().value === '0.118', `round ${round}: in inches the blade shows 0.118`, ui.blade().value);
        t.check(same(ui.snapshot(), snap), `round ${round}: in inches the layout is unchanged`, { now: ui.snapshot(), before: snap });
        const b = ui.bars()[0];
        const seg = (k) => b && b.segments.find((s) => s.kind === k);
        t.check(seg('piece') && lenRe('31.496', 'in').test(seg('piece').text), `round ${round}: the piece shows 31.496 in`, seg('piece') && seg('piece').text);
        t.check(seg('kerf') && lenRe('0.118', 'in').test(seg('kerf').text), `round ${round}: the kerf shows 0.118 in`, seg('kerf') && seg('kerf').text);
        t.check(seg('offcut') && lenRe('62.874', 'in').test(seg('offcut').text), `round ${round}: the offcut shows 62.874 in (1597 mm)`, seg('offcut') && seg('offcut').text);

        await setUnit(ui, P, 'mm');
        t.check(selectedUnit(ui) === 'mm', `round ${round}: millimetres is selected`, selectedUnit(ui));
        t.check(ui.hasRowValue('2400'), `round ${round}: back in millimetres the board shows 2400`, values(ui));
        t.check(ui.hasRowValue('800'), `round ${round}: back in millimetres the piece shows 800`, values(ui));
        t.check(ui.blade().value === '3', `round ${round}: back in millimetres the blade shows 3`, ui.blade().value);
        t.check(same(ui.snapshot(), snap), `round ${round}: back in millimetres the layout is unchanged`, { now: ui.snapshot(), before: snap });
        t.check(same(segTexts(ui), mmTexts), `round ${round}: back in millimetres the layout shows the same lengths as at first`, { now: segTexts(ui), before: mmTexts });
      }
      await t.settle(1100);
      t.check(plan0 && same(savedPlan(t), plan0) && plan0.bladeMm === 3 && plan0.boards[0].lengthMm === 2400 && plan0.pieces[0].lengthMm === 800,
        'the saved plan still holds 3 mm, 2400 mm and 800 mm after the switches', { before: plan0, now: savedPlan(t) });
    }],
  },

  'R1.7': {
    title: 'with inches selected, a fraction such as 3/4 or a value with text such as 31in in a length or the blade width shows a message asking for a decimal number of inches and is not used',
    sessions: [async (t) => {
      const P = await t.open();
      const { ui } = P;
      t.must(!!unitControl(ui), 'the page shows a unit selector offering millimetres and inches', ui.screenText().slice(0, 800));
      await setUnit(ui, P, 'in');
      t.must(selectedUnit(ui) === 'in', 'inches is selected', selectedUnit(ui));
      await ui.setBlade('0.25');
      await ui.addBoard('94.5');
      await ui.addPiece('31.5', 1, 'Rail');
      const good = ui.snapshot();
      t.must(good.length === 1 && good[0].segs.some((s) => s[0] === 'piece'), 'the starting layout is one board with the piece', good);

      const asksDecimalInches = (s) => /decimal/i.test(s) || (/number/i.test(s) && /inch/i.test(s));
      // A message may stay up from the previous attempt on the same field, so
      // each field's text is judged against what it showed before any attempt.
      const baseline = new Map();
      const base = (name, field) => { if (!baseline.has(name)) baseline.set(name, ui.around(field).text); return baseline.get(name); };
      async function attempt(name, locate, value, validValue) {
        const field = locate([validValue]);
        const before = base(name, field);
        const mark = P.doc._nativeReports.length;
        await ui.type(field, value);
        let cur = field.isConnected ? field : locate([value, '', validValue]);
        const after = ui.around(cur).text;
        const words = ui.newWords(before, after).join(' ');
        const native = ui.nativeReportsSince(mark, [field, cur]).map((r) => r.message).join(' ');
        t.check(asksDecimalInches(words) || asksDecimalInches(native), `${name} "${value}" shows a message asking for a decimal number of inches`, { before, after, native });
        t.check(same(ui.snapshot(), good), `${name} "${value}" is not used in the layout`, ui.snapshot());
        cur = cur.isConnected ? cur : locate([value, '', validValue]);
        await ui.type(cur, validValue);
        if (!same(ui.snapshot(), good)) t.note(`after restoring ${name} to ${validValue} the layout differs`);
      }
      const rowBy = (other) => (vals) => {
        const rows = ui.rowFields();
        const f = rows.find((x) => vals.includes(x.value) && x.value !== other && x.value !== 'Rail' && x.value !== '1');
        if (!f) throw new Error('the edited list field could not be found again');
        return f;
      };
      for (const v of ['3/4', '31in']) await attempt('blade width', () => ui.blade(), v, '0.25');
      for (const v of ['3/4', '31in']) await attempt('board length', rowBy('31.5'), v, '94.5');
      for (const v of ['3/4', '31in']) await attempt('piece length', rowBy('94.5'), v, '31.5');

      // The add forms' inputs, found before any message is shown next to them.
      const forms = { board: ui.addFields('board'), piece: ui.addFields('piece') };
      const formField = (kind, k) => (forms[kind][k] && forms[kind][k].isConnected ? forms[kind][k] : ui.addFields(kind)[k]);
      for (const [kind, v] of [['board', '3/4'], ['board', '31in'], ['piece', '3/4'], ['piece', '31in']]) {
        const field = formField(kind, 'len');
        const before = base(`add-${kind}`, field);
        const rowsBefore = ui.rowFields().length;
        const mark = P.doc._nativeReports.length;
        await ui.type(field, v);
        if (kind === 'piece') await ui.type(formField('piece', 'qty'), '1');
        await ui.click(ui.mainAdd(kind));
        const cur = field.isConnected ? field : formField(kind, 'len');
        const after = ui.around(cur).text;
        const words = ui.newWords(before, after).join(' ');
        const native = ui.nativeReportsSince(mark, [field, cur]).map((r) => r.message).join(' ');
        t.check(asksDecimalInches(words) || asksDecimalInches(native), `adding a ${kind} of length "${v}" shows a message asking for a decimal number of inches`, { before, after, native });
        t.check(ui.rowFields().length === rowsBefore, `no ${kind} of length "${v}" is added to the list`);
        t.check(same(ui.snapshot(), good), `the ${kind} of length "${v}" is not used in the layout`, ui.snapshot());
        await ui.type(cur.isConnected ? cur : formField(kind, 'len'), '');
      }
    }],
  },
};
