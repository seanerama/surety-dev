// The idea record's identity block (D6 §3.1, Appendix B.1; IBT): a fenced
// block whose info string is `yaml surety-identity`, holding exactly B.1's
// eight keys. The engine parses it itself over the closed key set (BS5 §5:
// no library); anything it cannot read is reported by key, never guessed at.
// Pure: it reads only the text.

import { SENSITIVE_AREAS } from '../checks/schema.js';

export const IDENTITY_KEYS = ['name', 'one_line', 'users', 'non_goals', 'success_measures', 'sensitive_areas', 'tier_recommendation', 'environments'] as const;
export type IdentityKey = (typeof IDENTITY_KEYS)[number];
export const IDENTITY_LIST_KEYS: readonly IdentityKey[] = ['users', 'non_goals', 'success_measures', 'environments'];
export const IDENTITY_TIERS = ['T1', 'T2', 'T3', 'unsure'];

export interface IdentityBlock {
  name: string;
  one_line: string;
  users: string[];
  non_goals: string[];
  success_measures: string[];
  // As the block writes them: a list of the closed list's areas, or `none`.
  sensitive_areas: string[] | 'none';
  tier_recommendation: 'T1' | 'T2' | 'T3' | 'unsure';
  environments: string[];
}

export interface IdentityFinding {
  // The key the finding is about, or null for the block itself.
  key: string | null;
  why: string;
}

export type IdentityResult = { ok: true; block: IdentityBlock } | { ok: false; findings: IdentityFinding[] };

const FENCE_OPEN = /^```yaml\s+surety-identity\s*$/;
const FENCE_CLOSE = /^```\s*$/;

// A scalar as the block writes it: unquoted text, or text in matching quotes.
function scalar(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

// A flow list `[a, b]`, `[]`, or `none`; block lists (`- item` lines) are
// gathered by the caller.
function flowList(raw: string): string[] | null {
  const t = raw.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  const inner = t.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((x) => scalar(x)).filter((x) => x.length > 0);
}

// Find the one identity block of the text: its lines between the fences.
export function identityBlockLines(text: string): { lines: string[] } | { missing: 'none' | 'unclosed' | 'several' } {
  const all = text.split('\n');
  let start = -1;
  let found: string[] | null = null;
  let count = 0;
  for (let i = 0; i < all.length; i++) {
    if (start === -1) {
      if (FENCE_OPEN.test(all[i]!)) start = i;
      continue;
    }
    if (FENCE_CLOSE.test(all[i]!)) {
      count++;
      found ??= all.slice(start + 1, i);
      start = -1;
    }
  }
  if (start !== -1) return { missing: 'unclosed' };
  if (found === null) return { missing: 'none' };
  if (count > 1) return { missing: 'several' };
  return { lines: found };
}

export function parseIdentityBlock(text: string): IdentityResult {
  const located = identityBlockLines(text);
  if ('missing' in located) {
    const why = located.missing === 'none' ? 'the idea record has no ```yaml surety-identity block' : located.missing === 'unclosed' ? 'the surety-identity block is not closed' : 'the idea record has more than one surety-identity block';
    return { ok: false, findings: [{ key: null, why }] };
  }
  const findings: IdentityFinding[] = [];
  const values = new Map<string, string | string[]>();
  let pending: { key: string; items: string[] } | null = null;
  const flush = () => {
    if (pending) values.set(pending.key, pending.items);
    pending = null;
  };
  for (const line of located.lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && pending) {
      pending.items.push(scalar(item[1]!));
      continue;
    }
    const kv = /^([a-z_]+):(.*)$/.exec(line);
    if (!kv) {
      flush();
      findings.push({ key: null, why: `the line "${line.trim()}" is not a key of the identity block` });
      continue;
    }
    flush();
    const key = kv[1]!;
    const rest = kv[2]!;
    if (!(IDENTITY_KEYS as readonly string[]).includes(key)) {
      findings.push({ key, why: `"${key}" is not a key of the identity block` });
      continue;
    }
    if (values.has(key)) findings.push({ key, why: `"${key}" is given twice` });
    if (rest.trim() === '') {
      pending = { key, items: [] };
      continue;
    }
    const list = flowList(rest);
    values.set(key, list ?? scalar(rest));
  }
  flush();
  for (const key of IDENTITY_KEYS) if (!values.has(key)) findings.push({ key, why: `"${key}" is missing` });
  const str = (key: IdentityKey): string => {
    const v = values.get(key);
    if (typeof v !== 'string') {
      if (v !== undefined) findings.push({ key, why: `"${key}" must be text, not a list` });
      return '';
    }
    return v;
  };
  const list = (key: IdentityKey): string[] => {
    const v = values.get(key);
    if (v === undefined) return [];
    if (typeof v === 'string') {
      if (key === 'sensitive_areas' && v.toLowerCase() === 'none') return [];
      findings.push({ key, why: `"${key}" must be a list${key === 'sensitive_areas' ? ' or none' : ''}` });
      return [];
    }
    return v;
  };
  const name = str('name');
  const oneLine = str('one_line');
  if (values.has('name') && name === '') findings.push({ key: 'name', why: '"name" is empty' });
  if (values.has('one_line') && oneLine === '') findings.push({ key: 'one_line', why: '"one_line" is empty' });
  const users = list('users');
  const nonGoals = list('non_goals');
  const measures = list('success_measures');
  const areasNone = typeof values.get('sensitive_areas') === 'string' && (values.get('sensitive_areas') as string).toLowerCase() === 'none';
  const areas = list('sensitive_areas');
  for (const a of areas) if (!SENSITIVE_AREAS.includes(a)) findings.push({ key: 'sensitive_areas', why: `"${a}" is not a sensitive area of the closed list` });
  if (new Set(areas).size !== areas.length) findings.push({ key: 'sensitive_areas', why: 'a sensitive area is repeated' });
  const tier = str('tier_recommendation');
  if (values.has('tier_recommendation') && !IDENTITY_TIERS.includes(tier)) findings.push({ key: 'tier_recommendation', why: `"${tier}" is not T1, T2, T3 or unsure` });
  for (const key of IDENTITY_LIST_KEYS) {
    const v = values.get(key);
    if (v !== undefined && typeof v === 'string') findings.push({ key, why: `"${key}" must be a list` });
  }
  const environments = list('environments');
  if (findings.length > 0) return { ok: false, findings };
  return {
    ok: true,
    block: { name, one_line: oneLine, users, non_goals: nonGoals, success_measures: measures, sensitive_areas: areasNone ? 'none' : areas, tier_recommendation: tier as IdentityBlock['tier_recommendation'], environments },
  };
}
