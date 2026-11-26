// What a user sees and does on the planner page, found the way a person finds
// it: fields by their labels, buttons by their names, the layout by the
// data-* attributes the architecture gives its elements (data-board-id,
// data-kind, data-length-mm, data-instance-id). See ../README.md.

const SEG_KINDS = new Set(['piece', 'kerf', 'offcut']);
const TEXT_TYPES = new Set(['text', 'number', 'search', 'tel', 'url', '']);
const REMOVE_RE = /remove|delete|×|✕|✖|✗|❌|\u{1f5d1}|trash|^\s*x\s*$|^\s*[-−]\s*$/iu;

export function makeUI(P) {
  const doc = P.doc;
  let eng = null;
  const fresh = () => { eng = P.engine(); return eng; };
  const vis = (el, media = 'screen') => (eng || fresh()).visible(el, media);
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

  function isField(el) {
    if (el.localName === 'textarea') return true;
    return el.localName === 'input' && TEXT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
  }
  function isButton(el) {
    if (el.localName === 'button') return true;
    if (el.localName === 'input' && ['submit', 'button', 'reset', 'image'].includes(el.type)) return true;
    return el.getAttribute('role') === 'button';
  }

  // Text of a subtree as shown in a medium (hidden subtrees skipped).
  function visibleText(root, media = 'screen', { skipSegments = false } = {}) {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { out.push(c.data); continue; }
        if (c.nodeType !== 1) continue;
        if (!vis(c, media)) continue;
        if (skipSegments && SEG_KINDS.has(c.getAttribute('data-kind'))) continue;
        if (c.localName === 'select') { const o = c.selectedOptions[0]; if (o) out.push(' ' + o.text + ' '); continue; }
        if (c.localName === 'svg' || c.namespaceURI !== 'http://www.w3.org/1999/xhtml') { out.push(' ' + c.textContent + ' '); continue; }
        out.push(' ');
        walk(c);
        out.push(' ');
      }
    };
    if (root.nodeType === 1 && !vis(root, media)) return '';
    walk(root);
    return norm(out.join(''));
  }

  function textOfIds(ids) {
    return String(ids || '').split(/\s+/).filter(Boolean).map((id) => doc.getElementById(id)).filter(Boolean).map((e) => e.textContent).join(' ');
  }
  // The accessible name, plus the attributes a person or a test would read.
  function accName(el) {
    const parts = [];
    parts.push(el.getAttribute('aria-label') || '');
    parts.push(textOfIds(el.getAttribute('aria-labelledby')));
    for (const l of el.labels || []) {
      const clone = l.cloneNode(true);
      for (const c of clone.querySelectorAll('input,select,textarea,button')) c.remove();
      parts.push(clone.textContent);
    }
    if (isButton(el)) parts.push(el.textContent, el.localName === 'input' ? el.value : '');
    parts.push(el.getAttribute('placeholder') || '', el.getAttribute('title') || '', el.getAttribute('name') || '', el.id || '');
    for (const a of el.getAttributeNames()) if (a.startsWith('data-') && !/^data-(length-mm|board-id|instance-id)$/.test(a)) parts.push(a.slice(5), el.getAttribute(a));
    return norm(parts.join(' ')).toLowerCase();
  }
  // The name, or when the field has none, the text of a parent holding only it.
  function fieldName(el) {
    let n = accName(el);
    const p = el.parentElement;
    if (p && p.querySelectorAll('input,select,textarea').length === 1) n += ' ' + visibleText(p).toLowerCase();
    return norm(n);
  }
  function unitText(el) {
    const p = el.parentElement;
    return norm(fieldName(el) + ' ' + (p ? visibleText(p).toLowerCase() : '') + ' ' + textOfIds(el.getAttribute('aria-describedby')).toLowerCase());
  }

  const allFields = () => doc.querySelectorAll('input,textarea').filter((e) => isField(e) && vis(e));
  const allButtons = () => doc.querySelectorAll('button,input,[role=button]').filter((e) => isButton(e) && vis(e));

  function headingContext(el) {
    for (let n = el.parentElement, k = 0; n && k < 5; n = n.parentElement, k++) {
      const h = n.querySelector('h1,h2,h3,h4,h5,h6,legend,caption,summary');
      const own = [n.getAttribute('aria-label') || '', n.id || '', n.getAttribute('class') || '', n.getAttribute('name') || ''].join(' ');
      if (h || /board|piece|part/i.test(own)) return norm((h ? h.textContent : '') + ' ' + own).toLowerCase();
    }
    return '';
  }
  // The form of a control, or its nearest ancestor holding a field, short of
  // one that holds the layout, a list or more than four fields.
  function controlContainer(btn) {
    if (btn.form) return btn.form;
    for (let n = btn.parentElement, k = 0; n && k < 4; n = n.parentElement, k++) {
      const fields = n.querySelectorAll('input,textarea').filter((f) => isField(f) && vis(f));
      if (n.querySelector('[data-kind],[data-board-id]') || fields.length > 4 || n.localName === 'body') break;
      if (fields.length) return n;
    }
    return btn.parentElement;
  }
  function addButtons(kind) {
    fresh();
    const kindRe = kind === 'board' ? /board/ : /piece|part/;
    const otherRe = kind === 'board' ? /piece|part|blade/ : /board|blade/;
    const out = [];
    for (const b of allButtons()) {
      const n = accName(b);
      if (!/\badd\b|^\s*\+|\bnew\b|➕/.test(n)) continue;
      if (kindRe.test(n) && !otherRe.test(n.replace(kindRe, ''))) { out.push({ b, rank: 0 }); continue; }
      if (otherRe.test(n)) continue;
      const h = headingContext(b);
      if (kindRe.test(h) && !otherRe.test(h)) out.push({ b, rank: 1 });
    }
    return out.sort((x, y) => x.rank - y.rank).map((x) => x.b);
  }
  function mainAdd(kind) {
    const list = addButtons(kind).filter((b) => !nearUnplaced(b));
    if (!list.length) throw new Error(`no add-${kind} control found on the page`);
    return list[0];
  }
  function addContainers() {
    const out = [];
    for (const k of ['board', 'piece']) for (const b of addButtons(k)) if (!nearUnplaced(b)) out.push(controlContainer(b));
    return out;
  }
  function blade() {
    fresh();
    const f = allFields().find((e) => /blade|kerf|saw/.test(fieldName(e)));
    if (!f) throw new Error('no blade width field found (an input labelled with "blade")');
    return f;
  }

  async function type(field, value) {
    field.focus();
    if (typeof field._userType === 'function') field._userType(String(value)); else field.value = String(value);
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.blur();
    await P.settle();
    fresh();
  }
  async function click(el) {
    el.focus();
    el.click();
    await P.settle();
    fresh();
  }

  function containerFields(cont) {
    let bl = null;
    try { bl = blade(); } catch {}
    return cont.querySelectorAll('input,textarea').filter((f) => isField(f) && vis(f) && f !== bl);
  }
  function addFields(kind) {
    const btn = mainAdd(kind);
    const cont = controlContainer(btn);
    const fields = containerFields(cont);
    if (!fields.length) throw new Error(`the add-${kind} control has no input next to it`);
    if (kind === 'board') {
      const len = fields.find((f) => /length|mm|long|size/.test(fieldName(f))) || fields[0];
      return { btn, cont, len };
    }
    const qty = fields.find((f) => /qty|quantit|count|how many|number of|pcs|amount|×/.test(fieldName(f)));
    const label = fields.find((f) => f !== qty && /label|name|desc|note|tag|title/.test(fieldName(f)) && !/length|mm/.test(accName(f)))
      || fields.find((f) => f !== qty && (f.getAttribute('type') || 'text') === 'text' && !/length|mm|qty|quantit/.test(fieldName(f)));
    const len = fields.find((f) => f !== qty && f !== label && /length|mm|long|size/.test(fieldName(f)))
      || fields.find((f) => f !== qty && f !== label);
    return { btn, cont, len, qty, label };
  }
  async function addBoard(length) {
    const { btn, len } = addFields('board');
    await type(len, length);
    await click(btn);
  }
  async function addPiece(length, quantity = 1, label = '') {
    const f = addFields('piece');
    if (!f.len) throw new Error('the add-piece control has no length input');
    if (!f.qty) throw new Error('the add-piece control has no quantity input (a field labelled "quantity" or "qty")');
    await type(f.len, length);
    await type(f.qty, quantity);
    if (label) {
      if (!f.label) throw new Error('the add-piece control has no label input');
      await type(f.label, label);
    } else if (f.label) await type(f.label, '');
    await click(mainAdd('piece'));
  }
  async function setBlade(v) { await type(blade(), v); }

  // ------------------------------------------------------------ layout

  function segmentEls(media = 'screen') {
    fresh();
    return doc.querySelectorAll('[data-kind]').filter((e) => SEG_KINDS.has(e.getAttribute('data-kind')) && vis(e, media)
      && !(e.parentElement && e.parentElement.closest('[data-kind=piece],[data-kind=kerf],[data-kind=offcut]')));
  }
  function segInfo(e) {
    return {
      kind: e.getAttribute('data-kind'),
      lengthMm: Number(e.getAttribute('data-length-mm')),
      instanceId: e.getAttribute('data-instance-id'),
      text: norm([e.textContent, e.getAttribute('title') || '', e.getAttribute('aria-label') || ''].join(' ')),
      el: e,
    };
  }
  function bars(media = 'screen') {
    const byId = new Map();
    for (const e of segmentEls(media)) {
      const bar = e.parentElement && e.parentElement.closest('[data-board-id]');
      if (!bar) continue;
      const id = bar.getAttribute('data-board-id');
      let b = byId.get(id);
      if (!b) { b = { boardId: id, el: bar, segments: [] }; byId.set(id, b); }
      if (b.el !== bar && !b.el.contains(bar)) continue;
      b.segments.push(segInfo(e));
    }
    return [...byId.values()];
  }
  function snapshot() {
    return bars().map((b) => ({ boardId: b.boardId, segs: b.segments.map((s) => [s.kind, s.lengthMm, s.instanceId || null]) }));
  }
  function barEls() { return bars().map((b) => b.el); }
  function unplaced() {
    fresh();
    const be = barEls();
    const cands = doc.querySelectorAll('[data-instance-id]').filter((e) => vis(e) && !be.some((b) => b.contains(e))
      && !e.closest('select') && e.localName !== 'option');
    const top = cands.filter((e) => !cands.some((o) => o !== e && o.contains(e)));
    const seen = new Map();
    for (const e of top) {
      const id = e.getAttribute('data-instance-id');
      if (seen.has(id)) continue;
      const lm = e.getAttribute('data-length-mm');
      const m = /(\d+(?:\.\d+)?)\s*mm/.exec(e.textContent);
      seen.set(id, { instanceId: id, lengthMm: lm !== null ? Number(lm) : m ? Number(m[1]) : NaN, text: visibleText(e), el: e });
    }
    return [...seen.values()];
  }
  function nearUnplaced(el) {
    const items = (() => {
      const be = barEls();
      return doc.querySelectorAll('[data-instance-id]').filter((e) => vis(e) && !be.some((b) => b.contains(e)) && !e.closest('select'));
    })();
    if (!items.length) return false;
    for (let n = el.parentElement, k = 0; n && k < 4; n = n.parentElement, k++) {
      if (items.some((i) => n.contains(i))) {
        // the add-board form of the boards list would also hold the whole page
        return n.querySelectorAll('[data-board-id]').filter((x) => SEG_KINDS.has(x.getAttribute('data-kind')) || x.querySelector('[data-kind]')).length === 0;
      }
    }
    return false;
  }

  // ------------------------------------------------------------ lists

  function rowFields() {
    fresh();
    let bl = null;
    try { bl = blade(); } catch {}
    const conts = addContainers();
    return allFields().filter((f) => f !== bl && !conts.some((c) => c.contains(f)));
  }
  function rowField(value) {
    const f = rowFields().find((x) => x.value === String(value));
    if (!f) throw new Error(`no editable list entry holds the value ${value}`);
    return f;
  }
  function hasRowValue(value) { return rowFields().some((x) => x.value === String(value)); }
  function rowOf(field) {
    for (let n = field.parentElement, k = 0; n && k < 5; n = n.parentElement, k++) {
      if (n.querySelectorAll('input,textarea').filter(isField).length >= 2 || ['li', 'tr'].includes(n.localName)) return n;
    }
    return field.parentElement;
  }
  function removeButtonFor(field) {
    for (let n = field.parentElement, k = 0; n && k < 5; n = n.parentElement, k++) {
      const bs = n.querySelectorAll('button,input,[role=button]').filter((b) => isButton(b) && vis(b) && REMOVE_RE.test(accName(b)) && !/clear/.test(accName(b)));
      if (bs.length) return bs[0];
    }
    throw new Error('no remove control next to the list entry');
  }

  // ------------------------------------------------------------ moves

  function pieceEl(instanceId) {
    fresh();
    return doc.querySelectorAll('[data-instance-id]').find((e) => e.getAttribute('data-instance-id') === instanceId && vis(e) && e.localName !== 'option' && e.localName !== 'select') || null;
  }
  function moveSelect(instanceId) {
    const el = pieceEl(instanceId);
    const sels = doc.querySelectorAll('select').filter((s) => vis(s));
    const tagged = sels.find((s) => s.getAttribute('data-instance-id') === instanceId);
    if (tagged) return tagged;
    if (el) {
      const inside = el.querySelector('select');
      if (inside && vis(inside)) return inside;
      for (let n = el.parentElement, k = 0; n && k < 3; n = n.parentElement, k++) {
        const s = n.querySelectorAll('select').filter((x) => vis(x));
        if (s.length === 1) return s[0];
        if (s.length > 1) break;
      }
    }
    return null;
  }
  async function move(instanceId, boardId) {
    const sel = moveSelect(instanceId);
    if (!sel) throw new Error(`no move control (a select of boards) on piece ${instanceId}`);
    const opt = sel.options.find((o) => o.value === boardId) || sel.options.find((o) => o.getAttribute('data-board-id') === boardId);
    if (!opt) throw new Error(`the move control of ${instanceId} offers no option for board ${boardId}`);
    const before = JSON.stringify(snapshot());
    sel.focus();
    sel.value = opt.value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.blur();
    await P.settle();
    fresh();
    if (JSON.stringify(snapshot()) === before && sel.isConnected) {
      for (let n = sel.parentElement, k = 0; n && k < 2; n = n.parentElement, k++) {
        const b = n.querySelectorAll('button,input,[role=button]').find((x) => isButton(x) && vis(x) && /move|apply|go|→/.test(accName(x)));
        if (b) { await click(b); break; }
      }
    }
  }

  // ------------------------------------------------------------ messages

  // Text around a field, up to three levels out, short of the layout.
  function around(field) {
    let best = field.parentElement || field;
    for (let n = field.parentElement, k = 0; n && k < 3; n = n.parentElement, k++) {
      if (n.querySelector('[data-kind]') || n.querySelectorAll('input,select,textarea,button').length > 8 || n.localName === 'body') break;
      best = n;
    }
    const described = [field.getAttribute('aria-describedby'), field.getAttribute('aria-errormessage')].join(' ').split(/\s+/).filter(Boolean)
      .map((id) => doc.getElementById(id)).filter((e) => e && vis(e)).map((e) => visibleText(e)).join(' ');
    return { el: best, text: norm(visibleText(best, 'screen', { skipSegments: true }) + ' ' + described) };
  }
  function newWords(before, after) {
    const count = new Map();
    for (const w of before.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) count.set(w, (count.get(w) || 0) + 1);
    const out = [];
    for (const w of after.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
      const c = count.get(w) || 0;
      if (c > 0) count.set(w, c - 1); else out.push(w);
    }
    return out.filter((w) => /\p{L}/u.test(w));
  }
  function nativeReportsSince(mark, fields) {
    return doc._nativeReports.slice(mark).filter((r) => r.message && fields.some((f) => f === r.el || (f.parentElement && f.parentElement.contains(r.el))));
  }

  function screenText() { fresh(); return visibleText(doc.body, 'screen'); }
  function printText() { fresh(); return visibleText(doc.body, 'print'); }
  function buttonNamed(re) { fresh(); return allButtons().find((b) => re.test(accName(b))) || null; }

  return {
    doc, fresh, vis, visibleText, accName, fieldName, unitText, isField, isButton, allFields, allButtons,
    addButtons, mainAdd, addFields, addContainers, controlContainer, containerFields, blade, type, click,
    addBoard, addPiece, setBlade, segmentEls, segInfo, bars, snapshot, unplaced, nearUnplaced,
    rowFields, rowField, hasRowValue, rowOf, removeButtonFor, pieceEl, moveSelect, move,
    around, newWords, nativeReportsSince, screenText, printText, buttonNamed, engine: () => eng || fresh(),
  };
}
