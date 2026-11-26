// The user operation the deployed-service check drives on the served page
// (run by ../run/lib/page.mjs in a child process, one session each): enter a
// 3 mm blade, a 2400 mm board and two 800 mm pieces and read the bar drawn
// (R1, R2.1); then reopen the page with the storage it left and read the
// same plan back (R4.2).

const kinds = (bar) => bar.segments.map((s) => s.kind);
const lengths = (bar) => bar.segments.map((s) => s.lengthMm);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const EXPECTED_KINDS = ['piece', 'kerf', 'piece', 'kerf', 'offcut'];
const EXPECTED_LENGTHS = [800, 3, 800, 3, 794];

export const scenarios = {
  deploy: {
    title: 'on the served page: blade 3 mm, a 2400 mm board and two 800 mm pieces give piece 800, kerf 3, piece 800, kerf 3, offcut 794; a reload restores it',
    sessions: [
      async (t) => {
        const { ui } = await t.open();
        await ui.setBlade(3);
        await ui.addBoard(2400);
        await ui.addPiece(800, 2);
        const bars = ui.bars();
        t.must(bars.length === 1, 'the served page draws one bar', ui.snapshot());
        const b = bars[0];
        t.check(lengths(b).reduce((x, y) => x + y, 0) === 2400, 'the segments of the bar add up to the 2400 mm board', lengths(b));
        t.check(same(kinds(b), EXPECTED_KINDS), 'the bar shows piece, kerf, piece, kerf, offcut in order', kinds(b));
        t.check(same(lengths(b), EXPECTED_LENGTHS), 'their lengths are 800, 3, 800, 3 and 794 mm', lengths(b));
        for (const s of b.segments) {
          t.check(new RegExp(`(^|[^\\d.])${s.lengthMm}([^\\d.]|$)`).test(s.text), `the ${s.kind} shows its length ${s.lengthMm}`, s.text);
        }
        await t.unload();
      },
      async (t) => {
        t.must(Object.keys(t.storageInit).length > 0, 'the first session left the plan in localStorage', t.storageInit);
        const { ui } = await t.open();
        const bars = ui.bars();
        t.must(bars.length === 1, 'the reopened page draws the saved board', ui.snapshot());
        t.check(same(kinds(bars[0]), EXPECTED_KINDS) && same(lengths(bars[0]), EXPECTED_LENGTHS),
          'the reopened page shows piece 800, kerf 3, piece 800, kerf 3, offcut 794', [kinds(bars[0]), lengths(bars[0])]);
      },
    ],
  },
};
