// Helpers shared by the scenarios.

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function plan({ blade = 3, boards = [], pieces = [], placements = {} }) {
  return {
    version: 1,
    bladeMm: blade,
    boards: boards.map((l, i) => ({ id: `b${i + 1}`, lengthMm: l })),
    pieces: pieces.map(([l, q = 1, label = ''], i) => ({ id: `p${i + 1}`, lengthMm: l, quantity: q, label })),
    placements,
  };
}

export class MemoryStorage {
  constructor(init = {}) { this.data = new Map(Object.entries(init)); }
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }
  setItem(k, v) { this.data.set(String(k), String(v)); }
  removeItem(k) { this.data.delete(k); }
  clear() { this.data.clear(); }
  key(i) { return [...this.data.keys()][i] ?? null; }
  get length() { return this.data.size; }
}

export const pieceLengths = (bar) => bar.segments.filter((s) => s.kind === 'piece').map((s) => s.lengthMm);
export const kinds = (bar) => bar.segments.map((s) => s.kind);
export const lengths = (bar) => bar.segments.map((s) => s.lengthMm);
export const barSum = (bar) => sum(bar.segments.map((s) => s.lengthMm));

// Segments of a computeLayout board as [kind, lengthMm].
export const coreSegs = (b) => (b && Array.isArray(b.segments) ? b.segments.map((s) => [s.kind, s.lengthMm]) : null);

// Finds each pattern in order, each after the previous match.
export function inOrder(text, patterns) {
  let pos = 0;
  for (const p of patterns) {
    const re = new RegExp(p.source, p.flags.replace('g', '') + 'g');
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) return { ok: false, missing: String(p) };
    pos = m.index + m[0].length;
  }
  return { ok: true };
}

export function emptyPlanShape(p) {
  return !!p && p.version === 1 && typeof p.bladeMm === 'number' && Array.isArray(p.boards) && p.boards.length === 0
    && Array.isArray(p.pieces) && p.pieces.length === 0 && p.placements && typeof p.placements === 'object' && Object.keys(p.placements).length === 0;
}

// Structural equality that ignores the order of object keys.
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}
