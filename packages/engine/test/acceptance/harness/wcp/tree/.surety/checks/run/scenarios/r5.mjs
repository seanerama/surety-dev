// R5: print a cut sheet.

import { inOrder } from '../lib/steps.mjs';
import { chromaticColours } from '../lib/css.mjs';

const mm = (n) => new RegExp(`(^|[^\\d.])${n}\\s*mm`, 'i');

// Blade 4 mm; boards 2500 and 900 mm; pieces entered as Side 700, Rail 800,
// Shelf 1000. First-fit decreasing cuts Shelf then Rail from the 2500 mm board
// (offcut 2500 - 1800 - 4 - 4 = 692 mm) and Side from the 900 mm board
// (offcut 900 - 700 - 4 = 196 mm).
async function cutPlan(t, extra = []) {
  const P = await t.open();
  const { ui } = P;
  await ui.setBlade(4);
  await ui.addBoard(2500);
  await ui.addBoard(900);
  await ui.addPiece(700, 1, 'Side');
  await ui.addPiece(800, 1, 'Rail');
  await ui.addPiece(1000, 1, 'Shelf');
  for (const [l, q, label] of extra) await ui.addPiece(l, q, label);
  return P;
}

const COLOUR_PROPS = ['color', 'background', 'background-color', 'background-image', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline', 'outline-color', 'fill', 'stroke', 'box-shadow'];
const LINE = /\b(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/;

function hasLine(eng, el) {
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const v = eng.value(el, `border-${side}`, 'print') || '';
    const style = eng.value(el, `border-${side}-style`, 'print') || '';
    const width = eng.value(el, `border-${side}-width`, 'print') || '';
    if ((LINE.test(v) || LINE.test(style)) && !/(^|\s)0(px)?(\s|$)/.test(width) && !/\b(none|hidden)\b/.test(style) && !/^\s*(none|0)\s*$/.test(v)) return true;
  }
  const o = eng.value(el, 'outline', 'print') || eng.value(el, 'outline-style', 'print') || '';
  if (LINE.test(o)) return true;
  const bi = eng.value(el, 'background-image', 'print') || '';
  return /gradient|url\(/.test(bi);
}

export const scenarios = {
  'R5.1': {
    title: "a print cut sheet control opens the browser's print dialog",
    sessions: [async (t) => {
      const P = await t.open();
      const { ui } = P;
      await ui.addBoard(2400);
      await ui.addPiece(800, 1);
      const btn = ui.buttonNamed(/print/);
      t.must(!!btn, 'a print cut sheet control is shown');
      t.check(/cut\s*sheet|print/.test(ui.accName(btn)), 'the control is named for printing the cut sheet', ui.accName(btn));
      await ui.click(btn);
      t.check(P.calls.print === 1, 'using it opens the print dialog (window.print) once', P.calls.print);
    }],
  },

  'R5.2': {
    title: 'the print view lists the blade width and, for each board, its length, each piece in cutting order with length and label, and the offcut length',
    sessions: [async (t) => {
      const { ui } = await cutPlan(t);
      const T = ui.printText();
      t.must(T.length > 0, 'the page has a print view', T);
      t.check(/blade|kerf/i.test(T) && mm(4).test(T), 'the print view gives the 4 mm blade width', T.slice(0, 1500));
      const a = inOrder(T, [mm(2500), /shelf/i, /rail/i, mm(692)]);
      t.check(a.ok, 'the 2500 mm board is listed with Shelf, then Rail, then its 692 mm offcut', { missing: a.missing, text: T.slice(0, 1500) });
      const b = inOrder(T, [mm(900), /side/i, mm(196)]);
      t.check(b.ok, 'the 900 mm board is listed with Side, then its 196 mm offcut', { missing: b.missing, text: T.slice(0, 1500) });
      for (const [l, name] of [[1000, 'Shelf'], [800, 'Rail'], [700, 'Side']]) {
        const re = new RegExp(`(^|[^\\d.])${l}\\s*mm[^\\d]{0,60}${name}|${name}[^\\d]{0,60}(^|[^\\d.])${l}\\s*mm`, 'i');
        t.check(re.test(T), `the print view gives ${name} with its length ${l} mm`, T.slice(0, 1500));
      }
    }],
  },

  'R5.3': {
    title: 'the print view hides the input fields and buttons and shows the board bars legibly in black and white',
    sessions: [async (t) => {
      const { ui } = await cutPlan(t);
      ui.fresh();
      const eng = ui.engine();
      const controls = ui.doc.querySelectorAll('input,select,textarea,button').filter((e) => !(e.localName === 'input' && e.type === 'hidden'));
      t.must(controls.length > 0, 'the screen has its editing controls');
      const shown = controls.filter((e) => eng.visible(e, 'print'));
      t.check(shown.length === 0, 'no input field, select or button is shown in the print view', shown.map((e) => e.outerHTML.slice(0, 160)));
      const segs = ui.segmentEls('print');
      const pieces = segs.filter((e) => e.getAttribute('data-kind') === 'piece');
      t.check(pieces.length >= 3, 'the board bars, with their pieces, are shown in the print view', segs.length);
      const coloured = [];
      for (const e of segs) {
        for (let n = e; n && n.nodeType === 1 && n !== ui.doc.body; n = n.parentElement) {
          for (const p of COLOUR_PROPS) {
            const c = chromaticColours(eng.value(n, p, 'print'));
            if (c.length) coloured.push(`${n.localName}.${n.getAttribute('class') || ''} ${p}: ${c.join(', ')}`);
          }
          if (n.hasAttribute('data-board-id')) break;
        }
      }
      t.check(coloured.length === 0, 'the bars use no colour in the print view (black, white and greys only)', [...new Set(coloured)].slice(0, 12));
      const unlined = pieces.filter((e) => {
        if (hasLine(eng, e)) return false;
        const sibs = [e.previousElementSibling, e.nextElementSibling].filter((s) => s && s.getAttribute('data-kind') === 'kerf');
        return !sibs.some((s) => hasLine(eng, s));
      });
      t.check(unlined.length === 0, 'each piece of a bar is outlined in the print view (a border, outline or pattern), so the pieces read apart without colour', unlined.map((e) => e.outerHTML.slice(0, 160)));
      const unlabelled = pieces.filter((e) => !new RegExp(`(^|\\D)${e.getAttribute('data-length-mm')}(\\D|$)`).test(ui.visibleText(e, 'print') + ' ' + (e.getAttribute('title') || '')));
      t.check(unlabelled.length === 0, 'each piece shows its length in the print view', unlabelled.map((e) => e.outerHTML.slice(0, 160)));
    }],
  },

  'R5.4': {
    title: 'when pieces are unplaced, the print view lists them under a heading for unplaced pieces',
    sessions: [async (t) => {
      const { ui } = await cutPlan(t, [[3000, 1, 'Beam']]);
      ui.fresh();
      const heads = ui.doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],caption,legend,th,dt')
        .filter((h) => ui.vis(h, 'print') && /unplaced|not placed|did not fit|didn.t fit|does not fit|could not be placed|no room/i.test(ui.visibleText(h, 'print')));
      t.must(heads.length > 0, 'the print view has a heading for unplaced pieces', ui.printText().slice(0, 1500));
      const listed = heads.some((h) => {
        for (let n = h.parentElement, k = 0; n && k < 2; n = n.parentElement, k++) {
          const T = ui.visibleText(n, 'print');
          const i = T.indexOf(ui.visibleText(h, 'print'));
          if (i >= 0 && /beam/i.test(T.slice(i)) && mm(3000).test(T.slice(i))) return true;
        }
        return false;
      });
      t.check(listed, 'the 3000 mm Beam is listed under that heading', ui.printText().slice(0, 1500));
    }],
  },
};
