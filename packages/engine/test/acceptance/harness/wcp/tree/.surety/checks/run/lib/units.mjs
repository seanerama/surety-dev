// The unit selector and lengths in the selected unit, for the checks of the
// millimetres/inches criteria (spec version 2, architecture §5a, §6, ADR-003).
//
// The selector is found the way a person finds it: a <select> offering a
// millimetres option and an inches option (by option text or value), or a
// radio group whose two inputs are named or labelled so.

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Which unit an option or radio names, or null.
function unitOf(text) {
  const s = String(text || '').toLowerCase().trim();
  if (/millim|\bmm\b/.test(s)) return 'mm';
  if (/inch|\bin\b|″/.test(s)) return 'in';
  return null;
}

export function unitControl(ui) {
  ui.fresh();
  const doc = ui.doc;
  for (const sel of doc.querySelectorAll('select').filter((s) => ui.vis(s))) {
    const opts = {};
    for (const o of sel.options) {
      const u = unitOf(o.text) || unitOf(o.value);
      if (u && !opts[u]) opts[u] = o;
    }
    if (opts.mm && opts.in) return { kind: 'select', el: sel, opts };
  }
  const radios = doc.querySelectorAll('input').filter((e) => e.type === 'radio' && ui.vis(e));
  const byUnit = {};
  for (const r of radios) {
    const u = unitOf(r.getAttribute('value')) || unitOf(ui.accName(r)) || unitOf(r.parentElement && r.parentElement.localName === 'label' ? r.parentElement.textContent : '');
    if (u && !byUnit[u]) byUnit[u] = r;
  }
  if (byUnit.mm && byUnit.in) return { kind: 'radio', mm: byUnit.mm, in: byUnit.in };
  return null;
}

export function selectedUnit(ui) {
  const c = unitControl(ui);
  if (!c) return null;
  if (c.kind === 'select') {
    const o = c.el.selectedOptions[0];
    return o ? unitOf(o.text) || unitOf(o.value) : null;
  }
  if (c.mm.checked && !c.in.checked) return 'mm';
  if (c.in.checked && !c.mm.checked) return 'in';
  return null;
}

export async function setUnit(ui, P, unit) {
  const c = unitControl(ui);
  if (!c) throw new Error('no unit selector found (a select or radio group offering millimetres and inches)');
  if (c.kind === 'select') {
    const sel = c.el;
    sel.focus();
    sel.value = c.opts[unit].value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.blur();
    await P.settle();
    ui.fresh();
  } else {
    await ui.click(c[unit]);
  }
}

// A length as shown: the number (not part of a longer number) followed by the
// unit's symbol.
export function lenRe(n, unit) {
  const sym = unit === 'in' ? '(?:in\\b|inch|″|")' : 'mm\\b';
  return new RegExp(`(^|[^\\d.])${esc(n)}(?![\\d])\\s*${sym}`, 'i');
}
// The number alone, not part of a longer number.
export function numRe(n) {
  return new RegExp(`(^|[^\\d.])${esc(n)}(?![\\d]|\\.\\d)`);
}
// Any length with the given unit's symbol.
export function anyLen(unit) {
  return unit === 'in' ? /\d\s*(?:in\b|inch|″)/i : /\d\s*mm\b/i;
}

// The drawn weight of a segment: flex-grow, a flex shorthand, a width or
// flex-basis, an SVG width, or a numeric custom property (as in R2.2).
export function weight(ui, el) {
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
// The segments' shares of the bar as drawn, or null when a size is missing.
export function shares(ui, bar) {
  const v = ui.engine().value(bar.el, 'grid-template-columns', 'screen') || '';
  const fr = [...v.matchAll(/([\d.]+)fr/g)].map((m) => Number(m[1]));
  const ws = fr.length === bar.segments.length ? fr : bar.segments.map((s) => weight(ui, s.el));
  if (!ws.every((w) => Number.isFinite(w) && w > 0)) return null;
  const W = ws.reduce((a, b) => a + b, 0);
  return ws.map((w) => w / W);
}

// The text around an element, up to `levels` ancestors out, until it matches.
export function textNear(ui, el, levels, test) {
  let last = '';
  for (let n = el, k = 0; n && k <= levels; n = n.parentElement, k++) {
    last = ui.visibleText(n, 'screen', { skipSegments: true });
    if (test(last)) return last;
  }
  return last;
}
