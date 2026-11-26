// web-ui: renders the plan and the layout computeLayout gives for it, and
// turns the woodworker's edits into plan edits. No placement or kerf
// arithmetic lives here; it is all in planner.mjs. Lengths are kept in
// millimetres; units.mjs parses what is typed in the selected unit and
// formats every length shown (ADR-003).

import {
  emptyPlan, setBlade, addBoard, updateBoard, removeBoard, addPiece, updatePiece, removePiece,
  validateQuantity, computeLayout, checkMove, applyMove,
} from './planner.mjs';
import { parseLength, formatNumber, formatLength, unitSymbol, unitName, normalizeUnit } from './units.mjs';
import { loadPlan, savePlan, clearPlan, loadUnit, saveUnit } from './store.mjs';

let plan = emptyPlan();
// The selected unit: how lengths are entered and shown, never part of the
// plan; saved on its own under cutPlanner.unit.
let unit = 'mm';
// A refused move: { instanceId, message }, shown next to its control until
// the next change of the plan.
let moveNote = null;

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

const fmt = (n) => String(n);
const num = (mm) => formatNumber(mm, unit);
const showLen = (mm) => formatLength(mm, unit);
const validateLength = (raw) => parseLength(raw, unit);

function setMessage(input, message) {
  const id = input.getAttribute('aria-describedby');
  const msg = id ? $(id) : null;
  if (msg) msg.textContent = message || '';
  if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
}

// Validates an input's value; shows the message next to it when refused.
function checked(input, validate) {
  const r = validate(input.value);
  setMessage(input, r.ok ? '' : r.message);
  return r;
}

function notice(message) {
  const n = $('notice');
  n.textContent = message || '';
  n.hidden = !message;
}

function persist() {
  const r = savePlan(plan);
  notice(r.ok ? '' : `${r.message} Your changes stay on this page until you close it.`);
}

function update(next, { lists = false } = {}) {
  plan = next;
  moveNote = null;
  persist();
  if (lists) renderLists();
  renderLayout();
}

// ---------------------------------------------------------------- lists

let fieldSeq = 0;

function numberField({ label, value, name, validate, onValid, length = false }) {
  const id = `f${++fieldSeq}`;
  const shown = length ? num(value) : fmt(value);
  const attrs = length
    ? { id, name, type: 'text', inputmode: 'decimal', autocomplete: 'off', value: shown, 'aria-describedby': `${id}-msg` }
    : { id, name, type: 'number', inputmode: 'numeric', step: '1', min: '1', value: shown, 'aria-describedby': `${id}-msg` };
  const input = el('input', attrs);
  input.value = shown;
  const onEdit = () => {
    const r = checked(input, validate);
    if (r.ok) onValid(r.value);
  };
  input.addEventListener('input', onEdit);
  input.addEventListener('change', onEdit);
  const lab = el('label', { for: id }, label, length ? ' ' : null, length ? el('span', { class: 'unit', text: unitSymbol(unit) }) : null);
  return el('div', { class: 'field' }, lab, input, el('span', { class: 'msg', id: `${id}-msg`, role: 'alert' }));
}

function textField({ label, value, name, onEdit }) {
  const id = `f${++fieldSeq}`;
  const input = el('input', { id, name, type: 'text', maxlength: 60, value });
  input.value = value;
  input.addEventListener('input', () => onEdit(input.value));
  return el('div', { class: 'field' }, el('label', { for: id, text: label }), input);
}

function removeButton(what, onRemove) {
  const b = el('button', { type: 'button', class: 'remove', 'aria-label': `Remove ${what}`, text: 'Remove' });
  b.addEventListener('click', onRemove);
  return b;
}

function renderBoards() {
  const list = $('board-list');
  list.replaceChildren();
  plan.boards.forEach((b, i) => {
    list.append(el('li', { class: 'row', 'data-row-board': b.id },
      el('span', { class: 'row-name', text: `Board ${i + 1}` }),
      numberField({
        label: 'Length', length: true, value: b.lengthMm, name: 'board-length', validate: validateLength,
        onValid: (v) => update(updateBoard(plan, b.id, { lengthMm: v })),
      }),
      removeButton(`board ${i + 1}`, () => update(removeBoard(plan, b.id), { lists: true })),
    ));
  });
  $('board-empty').hidden = plan.boards.length > 0;
}

function renderPieces() {
  const list = $('piece-list');
  list.replaceChildren();
  plan.pieces.forEach((p, i) => {
    list.append(el('li', { class: 'row', 'data-row-piece': p.id },
      numberField({
        label: 'Length', length: true, value: p.lengthMm, name: 'piece-length', validate: validateLength,
        onValid: (v) => update(updatePiece(plan, p.id, { lengthMm: v })),
      }),
      numberField({
        label: 'Quantity', value: p.quantity, name: 'quantity', validate: validateQuantity,
        onValid: (v) => update(updatePiece(plan, p.id, { quantity: v })),
      }),
      textField({
        label: 'Label', value: p.label, name: 'label',
        onEdit: (v) => update(updatePiece(plan, p.id, { label: v })),
      }),
      removeButton(`piece ${p.label || i + 1}`, () => update(removePiece(plan, p.id), { lists: true })),
    ));
  });
  $('piece-empty').hidden = plan.pieces.length > 0;
}

function renderLists() {
  renderBoards();
  renderPieces();
}

// ---------------------------------------------------------------- layout

function segmentEl(s) {
  const attrs = { class: `seg seg-${s.kind}`, 'data-kind': s.kind, 'data-length-mm': s.lengthMm, style: `flex-grow: ${s.lengthMm}` };
  if (s.kind === 'piece') {
    const title = `${s.label ? s.label + ': ' : ''}${showLen(s.lengthMm)}`;
    return el('div', { ...attrs, 'data-instance-id': s.instanceId, title },
      el('span', { class: 'seg-length', text: showLen(s.lengthMm) }),
      s.label ? el('span', { class: 'seg-label', text: s.label }) : null);
  }
  if (s.kind === 'kerf') {
    return el('div', { ...attrs, title: `Kerf ${showLen(s.lengthMm)}`, 'aria-label': `Kerf ${showLen(s.lengthMm)}` });
  }
  return el('div', { ...attrs, title: `Offcut ${showLen(s.lengthMm)}` },
    el('span', { class: 'seg-length', text: `Offcut ${showLen(s.lengthMm)}` }));
}

const boardName = (i, b) => `Board ${i + 1} (${showLen(b.lengthMm)})`;
const pieceName = (p) => `${showLen(p.lengthMm)}${p.label ? ' ' + p.label : ''}`;

// A select of boards that moves one piece instance; a refusal is shown next
// to it and the plan is left as it is.
function moveControl(layout, instanceId, currentBoardId) {
  const id = `move-${instanceId.replace(/[^\w-]/g, '-')}`;
  const sel = el('select', { id, 'data-instance-id': instanceId, 'aria-describedby': `${id}-msg` });
  if (!currentBoardId) sel.append(el('option', { value: '', text: 'Choose a board…' }));
  layout.boards.forEach((b, i) => {
    const o = el('option', { value: b.boardId, text: boardName(i, b) });
    if (b.boardId === currentBoardId) o.selected = true;
    sel.append(o);
  });
  if (!currentBoardId) sel.options[0].selected = true;
  sel.addEventListener('change', () => {
    const target = sel.value;
    if (!target || target === currentBoardId) return;
    const r = checkMove(plan, layout, instanceId, target, unit);
    if (r.ok) { update(applyMove(plan, instanceId, target)); return; }
    moveNote = { instanceId, message: r.message };
    renderLayout();
  });
  const note = moveNote && moveNote.instanceId === instanceId ? moveNote.message : '';
  return el('span', { class: 'move' },
    el('label', { for: id, text: 'Move to' }), sel,
    el('span', { class: 'msg move-msg', id: `${id}-msg`, role: 'alert', text: note }));
}

function renderBoardsLayout(layout) {
  const root = $('layout');
  root.replaceChildren();
  layout.boards.forEach((b, i) => {
    const kerfs = b.segments.filter((s) => s.kind === 'kerf');
    const offcut = b.segments.find((s) => s.kind === 'offcut');
    const placed = b.segments.filter((s) => s.kind === 'piece');
    const count = placed.length;
    const summary = `${count} ${count === 1 ? 'piece' : 'pieces'}, ${kerfs.length} ${kerfs.length === 1 ? 'cut' : 'cuts'} of ${showLen(layout.bladeMm)}, offcut ${showLen(offcut ? offcut.lengthMm : 0)}`;
    root.append(el('figure', { class: 'board' },
      el('figcaption', {}, el('strong', { text: `Board ${i + 1}` }), ` · ${showLen(b.lengthMm)}`),
      el('div', { class: 'bar', 'data-board-id': b.boardId, role: 'img', 'aria-label': `Board ${i + 1}, ${showLen(b.lengthMm)}: ${summary}` },
        ...b.segments.map(segmentEl)),
      el('p', { class: 'bar-summary', text: summary }),
      count ? el('ul', { class: 'moves' }, ...placed.map((s) => el('li', { class: 'move-row' },
        el('span', { class: 'move-piece', text: `${pieceName(s)}${s.manual ? ' (moved)' : ''}` }),
        moveControl(layout, s.instanceId, b.boardId)))) : null,
    ));
  });
  $('layout-empty').hidden = layout.boards.length > 0;
}

function renderUnplaced(layout) {
  const list = $('unplaced-list');
  list.replaceChildren(...layout.unplaced.map((u) => el('li', { class: 'unplaced', 'data-instance-id': u.instanceId, 'data-length-mm': u.lengthMm },
    el('strong', { class: 'unplaced-piece', text: pieceName(u) }),
    el('p', { class: 'reason', 'data-reason': u.reason.code, text: u.reason.message }),
    layout.boards.length ? moveControl(layout, u.instanceId, null) : null)));
  $('unplaced-section').hidden = layout.unplaced.length === 0;
}

const sheetPiece = (len, label) => `${showLen(len)}${label ? ' — ' + label : ''}`;

// The printable cut sheet, from the same layout and unit as the bars. It
// opens with the unit every length on it is given in.
function renderCutSheet(layout) {
  const body = $('cut-sheet-body');
  const parts = [
    el('p', { class: 'sheet-unit', text: `All lengths in ${unitName(unit)} (${unitSymbol(unit)}).` }),
    el('p', { class: 'sheet-blade', text: `Blade width (kerf): ${showLen(layout.bladeMm)}` }),
  ];
  if (!layout.boards.length) parts.push(el('p', { text: 'No boards in the plan.' }));
  layout.boards.forEach((b, i) => {
    const placed = b.segments.filter((s) => s.kind === 'piece');
    const offcut = b.segments.find((s) => s.kind === 'offcut');
    parts.push(el('div', { class: 'sheet-board' },
      el('h3', { text: `Board ${i + 1}: ${showLen(b.lengthMm)}` }),
      placed.length
        ? el('ol', { class: 'sheet-cuts' }, ...placed.map((s) => el('li', { text: sheetPiece(s.lengthMm, s.label) })))
        : el('p', { text: 'No pieces cut from this board.' }),
      el('p', { class: 'sheet-offcut', text: `Offcut: ${showLen(offcut ? offcut.lengthMm : 0)}` })));
  });
  if (layout.unplaced.length) {
    parts.push(el('div', { class: 'sheet-unplaced' },
      el('h3', { text: 'Unplaced pieces' }),
      el('ul', {}, ...layout.unplaced.map((u) => el('li', { text: `${sheetPiece(u.lengthMm, u.label)}: ${u.reason.message}` })))));
  }
  body.replaceChildren(...parts);
}

function renderLayout() {
  const layout = computeLayout(plan, unit);
  renderBoardsLayout(layout);
  renderUnplaced(layout);
  renderCutSheet(layout);
}

// ---------------------------------------------------------------- forms

// The blade width field shows the stored blade in the selected unit; it is
// only written back when the woodworker edits it.
function renderBlade() {
  const input = $('blade-width');
  input.value = num(plan.bladeMm);
  setMessage(input, '');
}

// Unit labels and the add forms' messages, which are worded in the unit.
function renderUnit() {
  $('unit').value = unit;
  $('unit-name').textContent = unitName(unit);
  for (const s of document.querySelectorAll('.unit')) s.textContent = unitSymbol(unit);
  for (const id of ['new-board-length', 'new-piece-length', 'unplaced-board-length']) setMessage($(id), '');
}

function wireUnit() {
  $('unit').addEventListener('change', (e) => {
    unit = normalizeUnit(e.target.value);
    const r = saveUnit(unit);
    notice(r.ok ? '' : `${r.message} The unit stays selected on this page until you close it.`);
    moveNote = null;
    renderUnit();
    renderBlade();
    renderLists();
    renderLayout();
  });
}

function wireBlade() {
  const input = $('blade-width');
  const onEdit = () => {
    const r = checked(input, validateLength);
    if (r.ok) update(setBlade(plan, r.value));
  };
  input.addEventListener('input', onEdit);
  input.addEventListener('change', onEdit);
}

function wireAddBoard(formId, inputId) {
  const form = $(formId);
  const len = $(inputId);
  len.addEventListener('input', () => { if (len.value !== '') setMessage(len, ''); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const r = checked(len, validateLength);
    if (!r.ok) { len.focus(); return; }
    update(addBoard(plan, r.value), { lists: true });
    len.value = '';
  });
}

function wireAddPiece() {
  const form = $('add-piece-form');
  const len = $('new-piece-length');
  const qty = $('new-piece-quantity');
  const label = $('new-piece-label');
  len.addEventListener('input', () => { if (len.value !== '') setMessage(len, ''); });
  qty.addEventListener('input', () => { if (qty.value !== '') setMessage(qty, ''); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const rl = checked(len, validateLength);
    const rq = checked(qty, validateQuantity);
    if (!rl.ok) { len.focus(); return; }
    if (!rq.ok) { qty.focus(); return; }
    update(addPiece(plan, { lengthMm: rl.value, quantity: rq.value, label: label.value }), { lists: true });
    len.value = '';
    qty.value = '1';
    label.value = '';
  });
}

function wireToolbar() {
  $('print-cut-sheet').addEventListener('click', () => window.print());
  $('clear-plan').addEventListener('click', () => {
    if (!window.confirm('Clear the whole plan (blade width, boards and pieces)? This cannot be undone.')) return;
    const r = clearPlan();
    if (!r.ok) notice(r.message);
    plan = emptyPlan();
    moveNote = null;
    persist();
    renderBlade();
    renderLists();
    renderLayout();
  });
}

function start() {
  plan = loadPlan();
  unit = loadUnit();
  wireUnit();
  wireBlade();
  wireAddBoard('add-board-form', 'new-board-length');
  wireAddBoard('unplaced-add-board-form', 'unplaced-board-length');
  wireAddPiece();
  wireToolbar();
  renderUnit();
  renderBlade();
  renderLists();
  renderLayout();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
