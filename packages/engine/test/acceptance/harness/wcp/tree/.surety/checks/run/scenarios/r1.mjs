// R1: enter boards, pieces and blade width in millimetres.

import { same, pieceLengths, barSum } from '../lib/steps.mjs';

const MM = /(^|[^a-z])mm([^a-z]|$)/;

export const scenarios = {
  'R1.1': {
    title: 'the page shows a blade width field, a board list with an add-board control and a piece list with an add-piece control (length, quantity, optional label), each length labelled in mm',
    sessions: [async (t) => {
      const { ui } = await t.open();
      const blade = ui.blade();
      t.check(MM.test(ui.unitText(blade)), 'the blade width field is labelled in mm', ui.unitText(blade));
      const b = ui.addFields('board');
      t.check(!!b.btn && !!b.len, 'an add-board control with a length input is shown');
      t.check(MM.test(ui.unitText(b.len)), 'the board length input is labelled in mm', ui.unitText(b.len));
      const p = ui.addFields('piece');
      t.check(!!p.btn && !!p.len, 'an add-piece control with a length input is shown');
      t.check(!!p.len && MM.test(ui.unitText(p.len)), 'the piece length input is labelled in mm', p.len && ui.unitText(p.len));
      t.check(!!p.qty, 'the add-piece control takes a quantity');
      t.check(!!p.label, 'the add-piece control takes a label');
      t.check(p.len !== p.qty && p.len !== p.label && p.qty !== p.label, 'length, quantity and label are separate inputs');
      await ui.addBoard(2400);
      t.check(ui.hasRowValue(2400), 'the board list shows an added 2400 mm board');
      await ui.addPiece(800, 2);
      t.check(ui.hasRowValue(800), 'the piece list shows an added 800 mm piece added without a label');
    }],
  },

  'R1.2': {
    title: 'after adding boards of 2400 mm and 1200 mm and a piece of 800 mm with quantity 3, both boards and the piece with quantity 3 are listed',
    sessions: [async (t) => {
      const { ui } = await t.open();
      await ui.addBoard(2400);
      await ui.addBoard(1200);
      await ui.addPiece(800, 3);
      const values = ui.rowFields().map((f) => f.value);
      t.check(values.filter((v) => v === '2400').length === 1, 'the board list shows the 2400 mm board once', values);
      t.check(values.filter((v) => v === '1200').length === 1, 'the board list shows the 1200 mm board once', values);
      t.check(values.filter((v) => v === '800').length === 1, 'the piece list shows the 800 mm piece once', values);
      const row = ui.rowOf(ui.rowField(800));
      const rowValues = row.querySelectorAll('input,textarea').map((f) => f.value);
      t.check(rowValues.includes('3') || /(^|\D)3(\D|$)/.test(ui.visibleText(row)), 'the 800 mm piece is listed with quantity 3', { rowValues, text: ui.visibleText(row) });
      const placed = ui.bars().flatMap(pieceLengths);
      t.check(placed.length === 3 && placed.every((l) => l === 800), 'the layout holds the three 800 mm pieces', ui.snapshot());
    }],
  },

  'R1.3': {
    title: 'editing a board length, a piece length or quantity, or removing a board or a piece, updates the lists and the layout at once',
    sessions: [async (t) => {
      const { ui } = await t.open();
      await ui.setBlade(3);
      await ui.addBoard(2400);
      await ui.addBoard(1000);
      await ui.addPiece(800, 2);
      await ui.addPiece(900, 1);
      let bars = ui.bars();
      t.must(bars.length === 2, 'two boards are drawn: 900 and 800 mm on the 2400 mm board, 800 mm on the 1000 mm board', ui.snapshot());
      const [b1, b2] = bars.map((b) => b.boardId);
      const bar = (id) => ui.bars().find((b) => b.boardId === id);
      t.check(same(pieceLengths(bar(b1)).sort(), [800, 900]) && same(pieceLengths(bar(b2)), [800]), 'the starting layout is as expected', ui.snapshot());

      await ui.type(ui.rowField(2400), '2600');
      t.check(ui.hasRowValue(2600) && !ui.hasRowValue(2400), 'the board list shows the board edited to 2600 mm');
      t.check(bar(b1) && barSum(bar(b1)) === 2600, 'the edited board is drawn 2600 mm long', ui.snapshot());
      t.check(bar(b1) && same(pieceLengths(bar(b1)).sort(), [800, 800, 900]), 'the three pieces now fit the 2600 mm board', ui.snapshot());

      await ui.type(ui.rowField(900), '950');
      t.check(ui.hasRowValue(950) && !ui.hasRowValue(900), 'the piece list shows the piece edited to 950 mm');
      t.check(bar(b1) && same(pieceLengths(bar(b1)).sort(), [800, 800, 950]), 'the layout uses the edited 950 mm piece', ui.snapshot());

      const qty = ui.rowOf(ui.rowField(800)).querySelectorAll('input').find((f) => f.value === '2');
      t.must(!!qty, 'the 800 mm piece row has an editable quantity of 2');
      await ui.type(qty, '1');
      const placed = ui.bars().flatMap(pieceLengths).sort();
      t.check(same(placed, [800, 950]), 'lowering the quantity to 1 leaves one 800 mm piece in the layout', ui.snapshot());

      await ui.click(ui.removeButtonFor(ui.rowField(950)));
      t.check(!ui.hasRowValue(950), 'the removed 950 mm piece leaves the piece list');
      t.check(same(ui.bars().flatMap(pieceLengths), [800]), 'the removed piece leaves the layout', ui.snapshot());

      await ui.click(ui.removeButtonFor(ui.rowField(2600)));
      t.check(!ui.hasRowValue(2600) && ui.hasRowValue(1000), 'the removed 2600 mm board leaves the board list');
      bars = ui.bars();
      t.check(!bars.some((b) => b.boardId === b1), 'the removed board is no longer drawn', ui.snapshot());
      t.check(bar(b2) && same(pieceLengths(bar(b2)), [800]) && barSum(bar(b2)) === 1000, 'the 800 mm piece moves to the remaining 1000 mm board', ui.snapshot());
    }],
  },

  'R1.4': {
    title: 'a zero, negative or non-numeric length, quantity or blade width shows a message next to that field and is not used in the layout',
    sessions: [async (t) => {
      const P = await t.open();
      const { ui } = P;
      await ui.setBlade(3);
      await ui.addBoard(2400);
      await ui.addPiece(800, 2);
      const good = ui.snapshot();
      t.must(good.length === 1 && same(good[0].segs.map((s) => s[1]), [800, 3, 800, 3, 794]), 'the starting layout is one 2400 mm board with two 800 mm pieces', good);

      // Types value into a field, judges the message and the layout, then
      // types the valid value back.
      async function attempt(name, locate, value, validValue) {
        const field = locate([validValue]);
        const before = ui.around(field).text;
        const mark = P.doc._nativeReports.length;
        await ui.type(field, value);
        let cur = field.isConnected ? field : locate([value, '', validValue]);
        const after = ui.around(cur).text;
        const words = ui.newWords(before, after);
        const native = ui.nativeReportsSince(mark, [field, cur]);
        t.check(words.length > 0 || native.length > 0, `${name} "${value}" shows a message next to the field`, { before, after });
        t.check(same(ui.snapshot(), good), `${name} "${value}" is not used in the layout`, ui.snapshot());
        cur = cur.isConnected ? cur : locate([value, '', validValue]);
        await ui.type(cur, validValue);
        if (!same(ui.snapshot(), good)) t.note(`after restoring ${name} to ${validValue} the layout differs`);
      }
      const byValue = (pred) => (vals) => {
        const f = ui.rowFields().find((x) => vals.includes(x.value) && pred(x));
        if (!f) throw new Error('the edited list field could not be found again');
        return f;
      };
      const bladeField = () => ui.blade();
      for (const v of ['0', '-3', 'abc']) await attempt('blade width', bladeField, v, '3');
      const boardRow = byValue((x) => !ui.rowOf(ui.rowField(800)).contains(x));
      for (const v of ['0', '-100', 'abc']) await attempt('board length', boardRow, v, '2400');
      const pieceLen = (vals) => {
        const rows = ui.rowFields();
        const f = rows.find((x) => vals.includes(x.value) && x.value !== '2' && !rows.some((b) => b.value === '2400' && b === x));
        if (!f) throw new Error('the piece length field could not be found again');
        return f;
      };
      for (const v of ['0', '-800', 'abc']) await attempt('piece length', pieceLen, v, '800');
      const qty = (vals) => {
        const row = ui.rowOf(ui.rowFields().find((x) => x.value === '800'));
        const f = row.querySelectorAll('input').find((x) => vals.includes(x.value) && x.value !== '800');
        if (!f) throw new Error('the quantity field could not be found again');
        return f;
      };
      for (const v of ['0', '-1', 'abc']) await attempt('piece quantity', qty, v, '2');

      // The add forms refuse invalid values too.
      for (const [kind, v] of [['board', '0'], ['board', 'abc'], ['piece', '-5']]) {
        const f = ui.addFields(kind);
        const field = f.len;
        const before = ui.around(field).text;
        const rowsBefore = ui.rowFields().length;
        const mark = P.doc._nativeReports.length;
        await ui.type(field, v);
        if (kind === 'piece') await ui.type(f.qty, '1');
        await ui.click(ui.mainAdd(kind));
        const cur = field.isConnected ? field : ui.addFields(kind).len;
        const after = ui.around(cur).text;
        const native = ui.nativeReportsSince(mark, [field, cur]);
        t.check(ui.newWords(before, after).length > 0 || native.length > 0, `adding a ${kind} of length "${v}" shows a message next to the length field`, { before, after });
        t.check(ui.rowFields().length === rowsBefore, `no ${kind} of length "${v}" is added to the list`);
        t.check(same(ui.snapshot(), good), `the ${kind} of length "${v}" is not used in the layout`, ui.snapshot());
        await ui.type(cur.isConnected ? cur : ui.addFields(kind).len, '');
      }
    }],
  },
};
