// units: pure, DOM-free conversion between millimetres, in which every
// length is kept, and the unit the woodworker enters and reads lengths in
// (ADR-003). 1 in = 25.4 mm exactly; rounding is for display only.

export const MM_PER_INCH = 25.4;

export const normalizeUnit = (v) => (v === 'in' ? 'in' : 'mm');
export const unitSymbol = (unit) => (normalizeUnit(unit) === 'in' ? 'in' : 'mm');
export const unitName = (unit) => (normalizeUnit(unit) === 'in' ? 'inches' : 'millimetres');

const DECIMAL = /^[0-9]*\.?[0-9]+$/;
const SIGNED = /^[-+][0-9]*\.?[0-9]+$/;

// A plain decimal number in the given unit, as millimetres (unrounded), or a
// refusal: no sign, fraction, exponent or text such as "31in".
export function parseLength(raw, unit) {
  const inches = normalizeUnit(unit) === 'in';
  const s = String(raw ?? '').trim();
  const positive = inches ? 'Enter a length greater than 0 in.' : 'Enter a length greater than 0 mm.';
  if (SIGNED.test(s)) return { ok: false, message: positive };
  if (!DECIMAL.test(s)) {
    return { ok: false, message: inches ? 'Enter a decimal number of inches, such as 31.5.' : 'Enter a number of millimetres, such as 800.' };
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, message: inches ? 'Enter a decimal number of inches, such as 31.5.' : 'Enter a number of millimetres, such as 800.' };
  if (n <= 0) return { ok: false, message: positive };
  return { ok: true, value: inches ? n * MM_PER_INCH : n };
}

// Millimetres shown in the unit: at most 3 decimals in inches, 2 in mm,
// trailing zeros dropped.
export function formatNumber(mm, unit) {
  const inches = normalizeUnit(unit) === 'in';
  const scale = inches ? 1000 : 100;
  const v = Math.round((inches ? mm / MM_PER_INCH : mm) * scale) / scale;
  return String(Object.is(v, -0) ? 0 : v);
}

export const formatLength = (mm, unit) => `${formatNumber(mm, unit)} ${unitSymbol(unit)}`;
