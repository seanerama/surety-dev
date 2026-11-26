// The test's own page sessions over a Workshop Cut Planner tree (row M646;
// harness/wcp/index.mjs pageSession). Run by the tree's own page process
// (.surety/checks/run/lib/page.mjs, WCP's DOM and CSS cascade, no browser)
// with the saved two-board plan as localStorage. They only read what the
// page shows and hand it back as the session's carry; the test judges it.
// They are not one of WCP's checks and are never registered with the engine.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const units = () => import(pathToFileURL(path.join(process.cwd(), '.surety/checks/run/lib/units.mjs')).href);
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

// What the print view shows: its visible text, the first board diagram's
// visible text (the figure holding the first bar), and the number of diagrams.
function printed(ui) {
  const bars = ui.bars('print');
  const first = bars[0] ? bars[0].el.closest('figure') || bars[0].el : null;
  return { text: ui.printText(), firstDiagram: first ? ui.visibleText(first, 'print') : '', diagrams: bars.length };
}

// What the screen shows of the plan: the selected unit, each board's
// caption and segments (kind, millimetres, text), and the visible text.
function shown(ui, selectedUnit) {
  return {
    unit: selectedUnit(ui),
    boards: ui.bars('screen').map((b) => {
      const fig = b.el.closest('figure');
      const caption = fig ? fig.querySelector('figcaption') : null;
      return { id: b.boardId, caption: caption ? flat(caption.textContent) : null, segments: b.segments.map((s) => ({ kind: s.kind, lengthMm: s.lengthMm, text: s.text })) };
    }),
    text: flat(ui.screenText()),
  };
}

export const scenarios = {
  print: {
    title: 'the print view of the saved two-board plan, in millimetres and in inches',
    sessions: [
      async (t) => {
        const { selectedUnit, setUnit } = await units();
        const P = await t.open();
        const { ui } = P;
        t.must(selectedUnit(ui) === 'mm', 'the saved plan opens in millimetres', selectedUnit(ui));
        const mm = printed(ui);
        await setUnit(ui, P, 'in');
        t.must(selectedUnit(ui) === 'in', 'inches is selected', selectedUnit(ui));
        return { mm, in: printed(ui) };
      },
    ],
  },
  walk: {
    title: "the walkthrough: the saved plan opened, inches, a refresh in inches, back to millimetres",
    sessions: [
      async (t) => {
        const { selectedUnit, setUnit } = await units();
        const P = await t.open();
        const { ui } = P;
        const mm = shown(ui, selectedUnit);
        await setUnit(ui, P, 'in');
        t.must(selectedUnit(ui) === 'in', 'inches is selected', selectedUnit(ui));
        return { mm, in: shown(ui, selectedUnit) };
      },
      async (t) => {
        const { selectedUnit, setUnit } = await units();
        const P = await t.open();
        const { ui } = P;
        const reloaded = shown(ui, selectedUnit);
        await setUnit(ui, P, 'mm');
        t.must(selectedUnit(ui) === 'mm', 'millimetres is selected', selectedUnit(ui));
        return { reloaded, back: shown(ui, selectedUnit) };
      },
    ],
  },
};
