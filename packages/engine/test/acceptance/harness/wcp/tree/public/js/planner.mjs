// planner-core: pure, DOM-free planning functions (ADR-002). Every function
// returns new objects and never mutates its arguments.

import { formatLength } from './units.mjs';

const DEFAULT_BLADE_MM = 3;

// Rounds away floating-point noise so that segment lengths add up exactly.
const mm = (x) => Math.round(x * 1e6) / 1e6;
const sum = (xs) => mm(xs.reduce((a, b) => a + b, 0));

// ---------------------------------------------------------------- plan

export function emptyPlan() {
  return { version: 1, bladeMm: DEFAULT_BLADE_MM, boards: [], pieces: [], placements: {} };
}

function nextId(prefix, items) {
  let n = 0;
  for (const it of items) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(it.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return prefix + (n + 1);
}

function copy(plan) {
  return {
    version: 1,
    bladeMm: plan.bladeMm,
    boards: plan.boards.map((b) => ({ ...b })),
    pieces: plan.pieces.map((p) => ({ ...p })),
    placements: { ...plan.placements },
  };
}

function dropPlacements(placements, drop) {
  const out = {};
  for (const [instanceId, boardId] of Object.entries(placements)) {
    if (!drop(instanceId, boardId)) out[instanceId] = boardId;
  }
  return out;
}

const pieceOfInstance = (instanceId) => {
  const i = instanceId.lastIndexOf('#');
  return { pieceId: instanceId.slice(0, i), k: Number(instanceId.slice(i + 1)) };
};

export function setBlade(plan, bladeMm) {
  return { ...copy(plan), bladeMm };
}

export function addBoard(plan, lengthMm) {
  const next = copy(plan);
  next.boards.push({ id: nextId('b', plan.boards), lengthMm });
  return next;
}

export function updateBoard(plan, boardId, { lengthMm }) {
  const next = copy(plan);
  next.boards = next.boards.map((b) => (b.id === boardId ? { ...b, lengthMm } : b));
  return next;
}

export function removeBoard(plan, boardId) {
  const next = copy(plan);
  next.boards = next.boards.filter((b) => b.id !== boardId);
  next.placements = dropPlacements(next.placements, (_, b) => b === boardId);
  return next;
}

export function addPiece(plan, { lengthMm, quantity = 1, label = '' }) {
  const next = copy(plan);
  next.pieces.push({ id: nextId('p', plan.pieces), lengthMm, quantity, label: String(label).trim() });
  return next;
}

export function updatePiece(plan, pieceId, changes) {
  const next = copy(plan);
  const allowed = {};
  if (changes.lengthMm !== undefined) allowed.lengthMm = changes.lengthMm;
  if (changes.quantity !== undefined) allowed.quantity = changes.quantity;
  if (changes.label !== undefined) allowed.label = String(changes.label).trim();
  next.pieces = next.pieces.map((p) => (p.id === pieceId ? { ...p, ...allowed } : p));
  const piece = next.pieces.find((p) => p.id === pieceId);
  if (piece) {
    next.placements = dropPlacements(next.placements, (instanceId) => {
      const { pieceId: pid, k } = pieceOfInstance(instanceId);
      return pid === pieceId && k > piece.quantity;
    });
  }
  return next;
}

export function removePiece(plan, pieceId) {
  const next = copy(plan);
  next.pieces = next.pieces.filter((p) => p.id !== pieceId);
  next.placements = dropPlacements(next.placements, (instanceId) => pieceOfInstance(instanceId).pieceId === pieceId);
  return next;
}

// ---------------------------------------------------------------- validation

function parseNumber(raw) {
  if (typeof raw === 'number') return raw;
  const s = String(raw ?? '').trim();
  if (s === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
  return Number(s);
}

export function validateLength(raw) {
  const n = parseNumber(raw);
  if (!Number.isFinite(n)) return { ok: false, message: 'Enter a number of millimetres.' };
  if (n <= 0) return { ok: false, message: 'Enter a length greater than 0 mm.' };
  return { ok: true, value: n };
}

export function validateQuantity(raw) {
  const n = parseNumber(raw);
  if (!Number.isFinite(n)) return { ok: false, message: 'Enter a whole number of pieces.' };
  if (n < 1) return { ok: false, message: 'Enter a quantity of at least 1.' };
  if (!Number.isInteger(n)) return { ok: false, message: 'Enter a whole number of pieces.' };
  return { ok: true, value: n };
}

// ---------------------------------------------------------------- layout

// One instance per unit of each piece row: id "<pieceId>#<k>".
export function expandInstances(plan) {
  const out = [];
  for (const p of plan.pieces) {
    for (let k = 1; k <= p.quantity; k++) {
      out.push({ instanceId: `${p.id}#${k}`, pieceId: p.id, lengthMm: p.lengthMm, label: p.label || '' });
    }
  }
  return out;
}

// Whether a piece of newLength fits a board already holding pieces.
export function fits(boardLengthMm, pieceLengths, newLengthMm, bladeMm) {
  return mm(sum(pieceLengths) + newLengthMm + pieceLengths.length * bladeMm) <= boardLengthMm;
}

// Space a new piece could still take on a board: length − Σp − k·blade.
export function spaceLeft(boardLengthMm, pieceLengths, bladeMm) {
  return mm(boardLengthMm - sum(pieceLengths) - pieceLengths.length * bladeMm);
}

// The kerf rule: a kerf between adjacent pieces, then a final cut of
// min(blade, remainder) when material remains, then the offcut.
export function boardSegments(boardLengthMm, pieces, bladeMm) {
  const segments = [];
  pieces.forEach((p, i) => {
    if (i > 0) segments.push({ kind: 'kerf', lengthMm: bladeMm });
    segments.push({ kind: 'piece', instanceId: p.instanceId, pieceId: p.pieceId, lengthMm: p.lengthMm, label: p.label, manual: !!p.manual });
  });
  const k = pieces.length;
  let remainder = mm(boardLengthMm - sum(pieces.map((p) => p.lengthMm)) - Math.max(0, k - 1) * bladeMm);
  if (remainder > 0 && k > 0) {
    const cut = Math.min(bladeMm, remainder);
    segments.push({ kind: 'kerf', lengthMm: cut });
    remainder = mm(remainder - cut);
  }
  if (remainder > 0) segments.push({ kind: 'offcut', lengthMm: remainder });
  return segments;
}

function plural(n, one, many) { return n === 1 ? one : many; }

// Reasons keep their lengths in millimetres; the sentence gives each one in
// the selected unit, converted from its own mm value (ADR-003).
function unplacedReason(inst, boards, bladeMm, unit) {
  const L = (x) => formatLength(x, unit);
  const longest = boards.reduce((m, b) => Math.max(m, b.lengthMm), 0);
  if (!boards.length) {
    return { code: 'TOO_LONG', pieceMm: inst.lengthMm, longestMm: 0, message: `Piece ${L(inst.lengthMm)} has no board to be cut from: add a board.` };
  }
  if (inst.lengthMm > longest) {
    return { code: 'TOO_LONG', pieceMm: inst.lengthMm, longestMm: longest, message: `Piece ${L(inst.lengthMm)} is longer than the longest board (${L(longest)}).` };
  }
  let best = null;
  for (const b of boards) {
    const left = spaceLeft(b.lengthMm, b.items.map((x) => x.lengthMm), bladeMm);
    if (!best || left > best.left) best = { b, left };
  }
  const lengths = [...best.b.items.map((x) => x.lengthMm), inst.lengthMm];
  const n = lengths.length;
  const cuts = n - 1;
  const piecesMm = sum(lengths);
  const kerfMm = mm(cuts * bladeMm);
  const needMm = mm(piecesMm + kerfMm);
  const boardMm = best.b.lengthMm;
  return {
    code: 'NO_ROOM',
    pieceMm: inst.lengthMm,
    boardId: best.b.boardId,
    boardMm,
    needMm,
    piecesMm,
    kerfMm,
    cuts,
    message: `These ${n} ${plural(n, 'piece', 'pieces')} need ${L(needMm)} (${L(piecesMm)} of pieces plus ${L(kerfMm)} for ${cuts} ${plural(cuts, 'cut', 'cuts')}) but the board is ${L(boardMm)}.`,
  };
}

// The unit only words the unplaced reasons; placement never depends on it.
export function computeLayout(plan, unit = 'mm') {
  const bladeMm = plan.bladeMm;
  const boards = plan.boards.map((b) => ({ boardId: b.id, lengthMm: b.lengthMm, items: [] }));
  const byId = new Map(boards.map((b) => [b.boardId, b]));
  const instances = expandInstances(plan).map((inst, order) => ({ ...inst, order }));
  const placements = plan.placements || {};
  const tryPlace = (board, inst, manual) => {
    if (!fits(board.lengthMm, board.items.map((x) => x.lengthMm), inst.lengthMm, bladeMm)) return false;
    board.items.push({ ...inst, manual, seq: board.items.length });
    return true;
  };

  // 1. Manual placements, in plan order of instances.
  const rest = [];
  for (const inst of instances) {
    const board = byId.get(placements[inst.instanceId]);
    if (!board || !tryPlace(board, inst, true)) rest.push(inst);
  }
  // 2. First-fit decreasing over the remaining instances.
  rest.sort((a, b) => b.lengthMm - a.lengthMm || a.order - b.order);
  const left = [];
  for (const inst of rest) {
    if (!boards.some((b) => tryPlace(b, inst, false))) left.push(inst);
  }
  // 3. What is left is unplaced.
  const unplaced = left
    .sort((a, b) => a.order - b.order)
    .map((inst) => ({ instanceId: inst.instanceId, pieceId: inst.pieceId, lengthMm: inst.lengthMm, label: inst.label, reason: unplacedReason(inst, boards, bladeMm, unit) }));

  return {
    bladeMm,
    boards: boards.map((b) => {
      const ordered = b.items.slice().sort((x, y) => y.lengthMm - x.lengthMm || x.seq - y.seq);
      const segments = boardSegments(b.lengthMm, ordered, bladeMm);
      const offcut = segments.filter((s) => s.kind === 'offcut').reduce((a, s) => a + s.lengthMm, 0);
      return { boardId: b.boardId, lengthMm: b.lengthMm, segments, usedMm: mm(b.lengthMm - offcut), freeMm: offcut };
    }),
    unplaced,
  };
}

// ---------------------------------------------------------------- moves

// Whether an instance fits the target board's current pieces, itself
// excluded. A refusal names the piece length, the kerf and the space left,
// in the given unit.
export function checkMove(plan, layout, instanceId, boardId, unit = 'mm') {
  const L = (x) => formatLength(x, unit);
  const inst = expandInstances(plan).find((i) => i.instanceId === instanceId);
  if (!inst) return { ok: false, message: 'That piece is no longer in the plan.' };
  const index = layout.boards.findIndex((b) => b.boardId === boardId);
  if (index < 0) return { ok: false, message: 'That board is no longer in the plan.' };
  const board = layout.boards[index];
  const others = board.segments.filter((s) => s.kind === 'piece' && s.instanceId !== instanceId).map((s) => s.lengthMm);
  const bladeMm = plan.bladeMm;
  if (fits(board.lengthMm, others, inst.lengthMm, bladeMm)) return { ok: true };
  const name = `board ${index + 1} (${L(board.lengthMm)})`;
  const left = Math.max(0, spaceLeft(board.lengthMm, others, bladeMm));
  if (!others.length) {
    return { ok: false, message: `Piece ${L(inst.lengthMm)} does not fit on ${name}: only ${L(left)} is left on it (blade kerf ${L(bladeMm)}).` };
  }
  const k = others.length;
  return {
    ok: false,
    message: `Piece ${L(inst.lengthMm)} does not fit on ${name}: after its ${k} ${plural(k, 'piece', 'pieces')} (${L(sum(others))}) and a ${L(bladeMm)} kerf for each of ${k} ${plural(k, 'cut', 'cuts')}, only ${L(left)} is left.`,
  };
}

export function applyMove(plan, instanceId, boardId) {
  const next = copy(plan);
  next.placements[instanceId] = boardId;
  return next;
}
