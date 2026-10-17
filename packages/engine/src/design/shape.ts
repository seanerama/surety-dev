// A value read against B.8's closed shape language (D7 §4.4; Appendix B.8),
// for the Designer's own fixtures under `mockups/data/` (§5.6 clause 2,
// DESIGN_FIXTURE_INVALID; SEAM.md §493). A pure read of parsed JSON: nothing
// the Designer wrote is run.

import type { Shape } from '../plan/schemas.js';
import type { Inventory } from './inventory.js';

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// The first way `value` is not of `shape`, at `at`; null when it is. With
// `bounds` false, the bounds and enums are not read (an `invalid_input`
// fixture violates one by construction).
export function shapeProblem(value: unknown, shape: Shape | undefined, opts: { bounds: boolean }, at = '$'): string | null {
  if (shape === undefined) return value === null ? null : `${at}: the interface declares no shape here, so only null fits`;
  const types = (Array.isArray(shape.type) ? shape.type : [shape.type]) as string[];
  const t = typeOf(value);
  const fits = types.includes(t) || (t === 'integer' && types.includes('number'));
  if (!fits) return `${at}: ${t} where the shape says ${types.join(' or ')}`;
  if (value === null) return null;
  if (opts.bounds && shape.enum && shape.enum.length > 0 && !shape.enum.some((e) => e === value)) return `${at}: not one of ${JSON.stringify(shape.enum)}`;
  if (typeof value === 'number' && opts.bounds) {
    if (shape.minimum !== undefined && value < shape.minimum) return `${at}: below its minimum ${shape.minimum}`;
    if (shape.maximum !== undefined && value > shape.maximum) return `${at}: above its maximum ${shape.maximum}`;
  }
  if (typeof value === 'string' && opts.bounds) {
    if (shape.minLength !== undefined && value.length < shape.minLength) return `${at}: shorter than its minLength ${shape.minLength}`;
    if (shape.maxLength !== undefined && value.length > shape.maxLength) return `${at}: longer than its maxLength ${shape.maxLength}`;
  }
  if (Array.isArray(value)) {
    if (opts.bounds && shape.minLength !== undefined && value.length < shape.minLength) return `${at}: fewer than ${shape.minLength} items`;
    if (opts.bounds && shape.maxLength !== undefined && value.length > shape.maxLength) return `${at}: more than ${shape.maxLength} items`;
    for (const [i, item] of value.entries()) {
      const p = shapeProblem(item, shape.items, opts, `${at}[${i}]`);
      if (p !== null) return p;
    }
    return null;
  }
  if (isObj(value)) {
    const props = shape.properties ?? {};
    for (const k of shape.required ?? []) if (!(k in value)) return `${at}: lacks the required property "${k}"`;
    for (const [k, v] of Object.entries(value)) {
      if (!(k in props)) return `${at}: "${k}" is not a property of the shape`;
      const p = shapeProblem(v, props[k], opts, `${at}.${k}`);
      if (p !== null) return p;
    }
  }
  return null;
}

// A file under `mockups/data/` (its name relative to that directory): why it
// is not a fixture of the inventory, or null. Named `<interface>.<state>.json`
// as the inventory's fixtures are (§4.4), and valid against what that
// fixture is generated from: the response for `ok` and `empty`, null for
// `loading`, `{code, message}` naming the code for `error:<code>`, the
// request (its types, not its bounds) for `invalid_input`.
export function fixtureProblem(name: string, bytes: Buffer, inv: Inventory | null): string | null {
  if (!name.endsWith('.json')) return 'not named <interface>.<state>.json';
  if (!inv) return 'the project has no recorded inventory to validate it against';
  const f = inv.fixtures.find((x) => `${x.interface}.${x.state}.json` === name);
  if (!f) return 'not named <interface>.<state>.json for a fixture of the inventory';
  const state = f.state;
  const i = inv.interfaces.find((x) => x.name === f.interface);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return 'not JSON';
  }
  if (state === 'ok' || state === 'empty') return shapeProblem(value, i?.response, { bounds: true });
  if (state === 'loading') return value === null ? null : 'a loading fixture is null';
  if (state.startsWith('error:')) {
    const code = state.slice('error:'.length);
    if (!isObj(value) || Object.keys(value).some((k) => k !== 'code' && k !== 'message')) return 'an error fixture is {code, message}';
    if (value.code !== code) return `its code is not ${code}`;
    return typeof value.message === 'string' ? null : '"message" is not a string';
  }
  if (state === 'invalid_input') return shapeProblem(value, i?.request, { bounds: false });
  return `${state} has no fixture form`;
}
