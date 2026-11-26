// plan-store: the plan in this browser's local storage (ADR-001), one JSON
// value under cutPlanner.plan in the shape of spec §9, and the selected unit
// on its own under cutPlanner.unit (ADR-003). Never throws.

import { emptyPlan } from './planner.mjs';

export const KEY = 'cutPlanner.plan';
export const UNIT_KEY = 'cutPlanner.unit';

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// The plan a saved value holds, with invalid entries dropped; null when the
// value is not a version 1 plan at all.
function sanitize(v) {
  if (!isObject(v) || v.version !== 1 || !positive(v.bladeMm) || !Array.isArray(v.boards) || !Array.isArray(v.pieces)) return null;
  if (v.placements !== undefined && !isObject(v.placements)) return null;
  const boards = [];
  for (const b of v.boards) {
    if (isObject(b) && typeof b.id === 'string' && positive(b.lengthMm) && !boards.some((x) => x.id === b.id)) {
      boards.push({ id: b.id, lengthMm: b.lengthMm });
    }
  }
  const pieces = [];
  for (const p of v.pieces) {
    if (isObject(p) && typeof p.id === 'string' && positive(p.lengthMm) && Number.isInteger(p.quantity) && p.quantity >= 1
      && !pieces.some((x) => x.id === p.id)) {
      pieces.push({ id: p.id, lengthMm: p.lengthMm, quantity: p.quantity, label: typeof p.label === 'string' ? p.label : '' });
    }
  }
  const placements = {};
  for (const [instanceId, boardId] of Object.entries(v.placements || {})) {
    const m = /^(.*)#(\d+)$/.exec(instanceId);
    const piece = m && pieces.find((p) => p.id === m[1]);
    if (piece && Number(m[2]) >= 1 && Number(m[2]) <= piece.quantity && boards.some((b) => b.id === boardId)) placements[instanceId] = boardId;
  }
  return { version: 1, bladeMm: v.bladeMm, boards, pieces, placements };
}

export function loadPlan(storage = defaultStorage()) {
  try {
    const raw = storage ? storage.getItem(KEY) : null;
    if (raw === null || raw === undefined) return emptyPlan();
    return sanitize(JSON.parse(raw)) || emptyPlan();
  } catch {
    return emptyPlan();
  }
}

export function savePlan(plan, storage = defaultStorage()) {
  try {
    if (!storage) return { ok: false, message: 'Local storage is not available in this browser.' };
    storage.setItem(KEY, JSON.stringify(plan));
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `The plan could not be saved in this browser (${e && e.message ? e.message : e}).` };
  }
}

export function clearPlan(storage = defaultStorage()) {
  try {
    if (!storage) return { ok: false, message: 'Local storage is not available in this browser.' };
    storage.removeItem(KEY);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `The saved plan could not be removed (${e && e.message ? e.message : e}).` };
  }
}

// The saved unit: 'in' only when exactly that is saved, else 'mm'.
export function loadUnit(storage = defaultStorage()) {
  try {
    return storage && storage.getItem(UNIT_KEY) === 'in' ? 'in' : 'mm';
  } catch {
    return 'mm';
  }
}

export function saveUnit(unit, storage = defaultStorage()) {
  try {
    if (!storage) return { ok: false, message: 'Local storage is not available in this browser.' };
    storage.setItem(UNIT_KEY, unit === 'in' ? 'in' : 'mm');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `The unit could not be saved in this browser (${e && e.message ? e.message : e}).` };
  }
}
