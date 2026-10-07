// The requirement index of an approved spec (D3 §4.5; the project spec
// template's section 5): one table row per requirement with its key `R<n>`,
// title, phase, sensitive areas (from the closed list, or `none`) and
// criteria (`R<n>.<m>`, comma-separated). The one parser spec approval will
// use; until spec approval is built the plan fixture registers through it
// (E92 item 4). A row that does not parse, an unknown area, a criterion that
// is not of its requirement's key, or a repeated criterion refuses the whole
// index and names the row. Pure: it reads only the text.

import { SENSITIVE_AREAS } from './schema.js';

export interface IndexRow {
  key: string;
  title: string;
  phase: number | null;
  sensitive_areas: string[];
  criteria: string[];
}

export type IndexResult = { ok: true; rows: IndexRow[] } | { ok: false; row: number; text: string; why: string };

const KEY = /^R[1-9][0-9]*$/;
const CRITERION = /^R[1-9][0-9]*\.[1-9][0-9]*$/;
const HEADER = ['key', 'title', 'phase', 'sensitive areas', 'criteria'];

const cells = (line: string): string[] | null => {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2) return null;
  return t
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim());
};

const list = (cell: string): string[] =>
  cell
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

// `row` in a refusal is the 1-based number of the requirement row (the
// header and the separator are not counted), or 0 for the table itself.
export function parseRequirementIndex(text: string): IndexResult {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const refuse = (row: number, line: string, why: string): IndexResult => ({ ok: false, row, text: line.trim(), why });
  if (lines.length < 2) return refuse(0, text, 'the index has no header and separator');
  const header = cells(lines[0]!);
  if (header === null || header.length !== 5 || header.some((h, i) => h.toLowerCase() !== HEADER[i])) return refuse(0, lines[0]!, 'the header is not | Key | Title | Phase | Sensitive areas | Criteria |');
  const sep = cells(lines[1]!);
  if (sep === null || sep.length !== 5 || sep.some((c) => !/^:?-{3,}:?$/.test(c))) return refuse(0, lines[1]!, 'the separator row is missing');
  const rows: IndexRow[] = [];
  const keys = new Set<string>();
  const criteria = new Set<string>();
  for (let n = 2; n < lines.length; n++) {
    const line = lines[n]!;
    const row = n - 1;
    const c = cells(line);
    if (c === null || c.length !== 5) return refuse(row, line, 'the row does not have five cells');
    const [key, title, phase, areasCell, criteriaCell] = c as [string, string, string, string, string];
    if (!KEY.test(key)) return refuse(row, line, `"${key}" is not a requirement key R<n>`);
    if (keys.has(key)) return refuse(row, line, `the requirement ${key} is listed twice`);
    if (title.length === 0) return refuse(row, line, 'the title is empty');
    let ph: number | null = null;
    if (phase.length > 0) {
      if (!/^[1-9][0-9]*$/.test(phase)) return refuse(row, line, `"${phase}" is not a phase number`);
      ph = Number(phase);
    }
    const areas = areasCell.toLowerCase() === 'none' ? [] : list(areasCell);
    if (areas.length === 0 && areasCell.toLowerCase() !== 'none') return refuse(row, line, 'the sensitive areas are empty: write none');
    for (const a of areas) if (!SENSITIVE_AREAS.includes(a)) return refuse(row, line, `"${a}" is not a sensitive area`);
    if (new Set(areas).size !== areas.length) return refuse(row, line, 'a sensitive area is repeated');
    const crit = list(criteriaCell);
    for (const x of crit) {
      if (!CRITERION.test(x)) return refuse(row, line, `"${x}" is not a criterion R<n>.<m>`);
      if (!x.startsWith(`${key}.`)) return refuse(row, line, `the criterion ${x} is not of requirement ${key}`);
      if (criteria.has(x)) return refuse(row, line, `the criterion ${x} is repeated`);
      criteria.add(x);
    }
    keys.add(key);
    rows.push({ key, title, phase: ph, sensitive_areas: areas, criteria: crit });
  }
  return { ok: true, rows };
}
