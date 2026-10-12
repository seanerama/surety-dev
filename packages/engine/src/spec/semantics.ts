// The specification's semantic representation (D6 §3.2, Appendix B.2; B04):
// what the engine reads of `.surety/spec/spec.md` at every save and at
// approval, from the exact syntax B.2 declares and from nothing else. The
// header fields; §5's index (checks/requirement-index.ts, D3 §4.5 with K10's
// Origin column); in §4 each `### R<n>` heading with its statement (the
// first paragraph), its criteria (list items `R<n>.<m> text`), its
// `**Sensitive areas:**` line and the `**Human test.**` and
// `**Descriptive.**` marks; §6's module table; §7's environment subsections;
// §10's `Q<k>` items with the keys they block and the `(phase n)` hint; and,
// when present, §12's claims table. Prose outside these forms is not read.
//
// `semantic_digest` is a hash over the representation with requirements,
// criteria and questions sorted by key: reordering without a change of
// value changes it by nothing (D6-C03; B04).
//
// Slice 31 parses to this depth and reports what does not parse. The
// duplicate, contradiction and renumbering refusals and the phase-hint guard
// are slice 34's (the driver's ruling on question 4); this module's
// `findings` already names what it sees so that approval can block on them
// then. Pure: it reads only the text.

import { SENSITIVE_AREAS } from '../checks/schema.js';
import { type IndexRow, parseRequirementIndex } from '../checks/requirement-index.js';
import { canonical, sha256 } from '../store/transitions/common.js';

export interface SemanticCriterion {
  id: string;
  text: string;
}

export interface SemanticRequirement {
  key: string;
  title: string;
  statement: string;
  criteria: SemanticCriterion[];
  sensitive_areas: string[];
  human_test: boolean;
  descriptive: boolean;
  // From the index row, when one exists.
  phase_hint: number | null;
  origin: 'intended' | 'observed';
  blocked_by_questions: string[];
}

export interface SemanticQuestion {
  id: string;
  text: string;
  blocks: string[];
  phase_hint: number | null;
}

export interface SemanticModule {
  name: string;
  paths: string[];
  sensitive_areas: string[];
}

export interface SemanticEnvironment {
  name: string;
  fields: Record<string, string>;
}

export interface SemanticClaim {
  source: string;
  claim: string;
  observed: string;
  requirement: string | null;
}

export interface SpecRepresentation {
  header: { spec_version: number | null; status: string | null; tier: string | null; owner: string | null };
  requirements: SemanticRequirement[];
  index: IndexRow[];
  questions: SemanticQuestion[];
  modules: SemanticModule[];
  environments: SemanticEnvironment[];
  claims: SemanticClaim[];
}

export interface SemanticFinding {
  // Where: a requirement key, a question id, 'header', 'index', 'modules',
  // 'environments', 'claims'.
  where: string;
  code:
    | 'header_missing'
    | 'header_invalid'
    | 'index_invalid'
    | 'index_missing'
    | 'section_missing'
    | 'no_statement'
    | 'no_criteria_no_mark'
    | 'criterion_malformed'
    | 'areas_missing'
    | 'area_unknown'
    | 'duplicate_requirement'
    | 'duplicate_criterion'
    | 'index_subsection_mismatch'
    | 'criterion_mismatch'
    | 'module_table_invalid'
    | 'question_malformed'
    | 'claims_table_invalid';
  why: string;
}

export interface SemanticResult {
  // false when the representation is not readable as a specification at all.
  readable: boolean;
  representation: SpecRepresentation | null;
  findings: SemanticFinding[];
  digest: string | null;
}

const KEY = /^R[1-9][0-9]*$/;
const CRITERION = /^(R[1-9][0-9]*\.[1-9][0-9]*)\b\s*(.*)$/;
const H2 = /^##\s+(\d+)\.\s+(.*)$/;
const REQ_HEADING = /^###\s+(R[1-9][0-9]*)(?:\.\s*(.*))?\s*$/;
const ENV_HEADING = /^###\s+(.+?)\s*$/;
const QUESTION = /^-\s+(Q[1-9][0-9]*)\s+(.*)$/;

const cells = (line: string): string[] | null => {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2) return null;
  return t.slice(1, -1).split('|').map((c) => c.trim());
};

const list = (cell: string): string[] =>
  cell
    .split(',')
    .map((x) => x.trim().replace(/^`|`$/g, ''))
    .filter((x) => x.length > 0);

// Sections by their `## <n>.` heading: number → lines.
function sections(text: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    const m = H2.exec(line);
    if (m) {
      current = [];
      out.set(Number(m[1]), current);
      continue;
    }
    current?.push(line);
  }
  return out;
}

// The first markdown table of a block of lines, or null.
function firstTable(lines: string[]): string[] | null {
  const rows: string[] = [];
  let inTable = false;
  for (const line of lines) {
    const isRow = cells(line) !== null;
    if (isRow) {
      inTable = true;
      rows.push(line);
    } else if (inTable && line.trim() !== '') break;
    else if (inTable && line.trim() === '') break;
  }
  return rows.length > 0 ? rows : null;
}

function parseHeader(text: string, findings: SemanticFinding[]): SpecRepresentation['header'] {
  const field = (name: string): string | null => {
    const m = new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.*)$`, 'm').exec(text);
    if (!m) return null;
    // The template's bracketed guidance is not a value.
    return m[1]!.replace(/\*\[.*?\]\*/g, '').trim();
  };
  const version = field('Spec version');
  const status = field('Status');
  const tier = field('Tier');
  const owner = field('Owner');
  for (const [name, v] of [
    ['Spec version', version],
    ['Status', status],
    ['Tier', tier],
    ['Owner', owner],
  ] as const) {
    if (v === null) findings.push({ where: 'header', code: 'header_missing', why: `the header field **${name}:** is missing` });
  }
  let specVersion: number | null = null;
  if (version !== null) {
    const n = /^(\d+)\b/.exec(version);
    if (!n) findings.push({ where: 'header', code: 'header_invalid', why: `the Spec version "${version}" is not an integer` });
    else specVersion = Number(n[1]);
  }
  const tierValue = tier === null ? null : (/^(T[123])\b/.exec(tier)?.[1] ?? null);
  if (tier !== null && tierValue === null) findings.push({ where: 'header', code: 'header_invalid', why: `the Tier "${tier}" is not T1, T2 or T3` });
  const statusValue = status === null ? null : (/^(draft|approved)\b/.exec(status)?.[1] ?? null);
  if (status !== null && statusValue === null) findings.push({ where: 'header', code: 'header_invalid', why: `the Status "${status}" is not draft or approved` });
  return { spec_version: specVersion, status: statusValue, tier: tierValue, owner: owner === null || owner === '' ? null : owner };
}

function parseRequirements(lines: string[], findings: SemanticFinding[]): SemanticRequirement[] {
  const out: SemanticRequirement[] = [];
  let cur: (SemanticRequirement & { paragraph: string[]; seenStatement: boolean }) | null = null;
  const seenKeys = new Set<string>();
  const seenCriteria = new Set<string>();
  const finish = () => {
    if (!cur) return;
    const { paragraph: _p, seenStatement: _s, ...req } = cur;
    if (req.statement === '') findings.push({ where: req.key, code: 'no_statement', why: `${req.key} has no statement paragraph under its heading` });
    if (req.criteria.length === 0 && !req.human_test && !req.descriptive) findings.push({ where: req.key, code: 'no_criteria_no_mark', why: `${req.key} has no criterion and no **Human test.** or **Descriptive.** mark` });
    out.push(req);
    cur = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const h = REQ_HEADING.exec(line);
    if (h) {
      finish();
      const key = h[1]!;
      if (seenKeys.has(key)) findings.push({ where: key, code: 'duplicate_requirement', why: `${key} has two subsections` });
      seenKeys.add(key);
      cur = { key, title: (h[2] ?? '').trim(), statement: '', criteria: [], sensitive_areas: [], human_test: false, descriptive: false, phase_hint: null, origin: 'intended', blocked_by_questions: [], paragraph: [], seenStatement: false };
      continue;
    }
    if (!cur) continue;
    if (/^###?\s/.test(line)) {
      finish();
      continue;
    }
    const areas = /^\*\*Sensitive areas:\*\*\s*(.*)$/.exec(line.trim());
    if (areas) {
      const value = areas[1]!.trim();
      const names = value.toLowerCase() === 'none' ? [] : list(value);
      if (names.length === 0 && value.toLowerCase() !== 'none') findings.push({ where: cur.key, code: 'areas_missing', why: `${cur.key}'s sensitive areas are empty: write none` });
      for (const a of names) if (!SENSITIVE_AREAS.includes(a)) findings.push({ where: cur.key, code: 'area_unknown', why: `${cur.key} names "${a}", which is not a sensitive area of the closed list` });
      cur.sensitive_areas = names.filter((a) => SENSITIVE_AREAS.includes(a));
      cur.seenStatement = true;
      continue;
    }
    if (/^\*\*Human test\.\*\*/.test(line.trim())) {
      cur.human_test = true;
      cur.seenStatement = true;
      continue;
    }
    if (/^\*\*Descriptive\.\*\*/.test(line.trim())) {
      cur.descriptive = true;
      cur.seenStatement = true;
      continue;
    }
    const item = /^-\s+(.*)$/.exec(line.trim());
    if (item) {
      cur.seenStatement = true;
      const c = CRITERION.exec(item[1]!);
      if (!c) continue; // a list item that is not a criterion is prose
      const id = c[1]!;
      if (!id.startsWith(`${cur.key}.`)) {
        findings.push({ where: cur.key, code: 'criterion_malformed', why: `the criterion ${id} under ${cur.key} is not of that requirement` });
        continue;
      }
      if (seenCriteria.has(id)) findings.push({ where: cur.key, code: 'duplicate_criterion', why: `the criterion ${id} is listed twice in section 4` });
      seenCriteria.add(id);
      cur.criteria.push({ id, text: c[2]!.replace(/\*\[.*?\]\*/g, '').trim() });
      continue;
    }
    // The statement: the first paragraph under the heading, before any
    // bold-labelled line, mark or list.
    if (!cur.seenStatement) {
      if (line.trim() === '') {
        if (cur.paragraph.length > 0) {
          cur.statement = cur.paragraph.join(' ').replace(/\*\[.*?\]\*/g, '').trim();
          cur.seenStatement = true;
        }
        continue;
      }
      if (/^\*\*[A-Z]/.test(line.trim())) {
        if (cur.paragraph.length > 0) cur.statement = cur.paragraph.join(' ').trim();
        cur.seenStatement = true;
        continue;
      }
      cur.paragraph.push(line.trim());
    }
  }
  finish();
  return out;
}

function parseModules(lines: string[] | undefined, findings: SemanticFinding[]): SemanticModule[] {
  if (!lines) return [];
  const table = firstTable(lines);
  if (!table) return [];
  const header = cells(table[0]!)!;
  if (header.length !== 3 || header[0]!.toLowerCase() !== 'module' || header[1]!.toLowerCase() !== 'paths' || header[2]!.toLowerCase() !== 'sensitive areas') {
    findings.push({ where: 'modules', code: 'module_table_invalid', why: 'the module table is not | Module | Paths | Sensitive areas |' });
    return [];
  }
  const out: SemanticModule[] = [];
  for (const row of table.slice(2)) {
    const c = cells(row)!;
    if (c.length !== 3) {
      findings.push({ where: 'modules', code: 'module_table_invalid', why: `the module row "${row.trim()}" does not have three cells` });
      continue;
    }
    const name = c[0]!.replace(/^\[|\]$/g, '');
    if (name === '') continue;
    const areas = c[2]!.toLowerCase() === 'none' ? [] : list(c[2]!);
    for (const a of areas) if (!SENSITIVE_AREAS.includes(a)) findings.push({ where: 'modules', code: 'area_unknown', why: `the module ${name} names "${a}", which is not a sensitive area of the closed list` });
    out.push({ name, paths: list(c[1]!), sensitive_areas: areas.filter((a) => SENSITIVE_AREAS.includes(a)) });
  }
  return out;
}

function parseEnvironments(lines: string[] | undefined): SemanticEnvironment[] {
  if (!lines) return [];
  // TPL §7 in its table form: the environments by the table's first column,
  // with the section's `- **Field:** value` lines as their fields.
  if (!lines.some((l) => ENV_HEADING.test(l) && !l.startsWith('####'))) {
    const table = firstTable(lines);
    if (!table) return [];
    const fields: Record<string, string> = {};
    for (const line of lines) {
      const f = /^-\s+\*\*(.+?):\*\*\s*(.*)$/.exec(line.trim());
      if (f) fields[f[1]!.trim()] = f[2]!.replace(/\*\[.*?\]\*/g, '').trim();
    }
    return table
      .slice(2)
      .map((row) => (cells(row)?.[0] ?? '').replace(/^\[|\]$/g, '').replace(/`/g, ''))
      .filter((name) => /^[a-z][a-z0-9_-]*$/.test(name))
      .map((name) => ({ name, fields: { ...fields } }));
  }
  const out: SemanticEnvironment[] = [];
  let cur: SemanticEnvironment | null = null;
  for (const line of lines) {
    const h = ENV_HEADING.exec(line);
    if (h && !line.startsWith('####')) {
      cur = { name: h[1]!.trim(), fields: {} };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const f = /^-\s+\*\*(.+?):\*\*\s*(.*)$/.exec(line.trim());
    if (f) cur.fields[f[1]!.trim()] = f[2]!.replace(/\*\[.*?\]\*/g, '').trim();
  }
  return out;
}

function parseQuestions(lines: string[] | undefined, findings: SemanticFinding[]): SemanticQuestion[] {
  if (!lines) return [];
  const out: SemanticQuestion[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('- ')) continue;
    const q = QUESTION.exec(t);
    if (!q) {
      // A list item in §10 that is not `Q<k>` is prose, unless it looks like a question.
      if (/^-\s+Q/.test(t)) findings.push({ where: 'questions', code: 'question_malformed', why: `the item "${t}" is not Q<k> <text>` });
      continue;
    }
    const text = q[2]!.replace(/\*\[.*?\]\*/g, '').trim();
    const hint = /\(phase\s+(\d+)\)\s*$/.exec(text);
    const blocks = [...new Set([...text.matchAll(/\bR[1-9][0-9]*\b/g)].map((m) => m[0]))];
    out.push({ id: q[1]!, text, blocks, phase_hint: hint ? Number(hint[1]) : null });
  }
  return out;
}

function parseClaims(lines: string[] | undefined, findings: SemanticFinding[]): SemanticClaim[] {
  if (!lines) return [];
  const table = firstTable(lines);
  if (!table) return [];
  const header = cells(table[0]!)!.map((h) => h.toLowerCase());
  if (header.length !== 4 || header[0] !== 'source' || header[1] !== 'claim' || header[2] !== 'observed' || header[3] !== 'requirement') {
    findings.push({ where: 'claims', code: 'claims_table_invalid', why: 'the claims table is not | Source | Claim | Observed | Requirement |' });
    return [];
  }
  const out: SemanticClaim[] = [];
  for (const row of table.slice(2)) {
    const c = cells(row)!;
    if (c.length !== 4) {
      findings.push({ where: 'claims', code: 'claims_table_invalid', why: `the claims row "${row.trim()}" does not have four cells` });
      continue;
    }
    if (c.every((x) => x === '' || /^\[.*\]$/.test(x))) continue;
    const req = c[3]!.trim();
    out.push({ source: c[0]!, claim: c[1]!, observed: c[2]!, requirement: req === '' || req.toLowerCase() === 'none' ? null : req });
  }
  return out;
}

export function digestOf(r: SpecRepresentation): string {
  const byKey = <T extends { key: string }>(xs: T[]) => [...xs].sort((a, b) => a.key.localeCompare(b.key));
  return sha256(
    canonical({
      header: { tier: r.header.tier },
      requirements: byKey(r.requirements).map((q) => ({
        key: q.key,
        statement: q.statement,
        criteria: [...q.criteria].sort((a, b) => a.id.localeCompare(b.id)),
        sensitive_areas: [...q.sensitive_areas].sort(),
        human_test: q.human_test,
        descriptive: q.descriptive,
        phase_hint: q.phase_hint,
        origin: q.origin,
      })),
      questions: [...r.questions].sort((a, b) => a.id.localeCompare(b.id)).map((q) => ({ id: q.id, text: q.text, blocks: [...q.blocks].sort(), phase_hint: q.phase_hint })),
      modules: [...r.modules].sort((a, b) => a.name.localeCompare(b.name)).map((m) => ({ name: m.name, paths: [...m.paths].sort(), sensitive_areas: [...m.sensitive_areas].sort() })),
      environments: [...r.environments].sort((a, b) => a.name.localeCompare(b.name)),
      claims: r.claims,
    }),
  );
}

// The representation of a specification's text, with every finding (D6
// §3.2; B04). `readable` false: it has no section 4 and no section 5, so it
// is not a specification in TPL's shape at all.
export function parseSpecification(text: string): SemanticResult {
  const findings: SemanticFinding[] = [];
  const header = parseHeader(text, findings);
  const secs = sections(text);
  const s4 = secs.get(4);
  const s5 = secs.get(5);
  if (!s4 && !s5) return { readable: false, representation: null, findings: [{ where: 'index', code: 'section_missing', why: 'the specification has neither section 4 (Requirements) nor section 5 (Requirement index)' }], digest: null };
  if (!s4) findings.push({ where: 'index', code: 'section_missing', why: 'section 4 (Requirements) is missing' });
  const requirements = parseRequirements(s4 ?? [], findings);
  let index: IndexRow[] = [];
  if (!s5) findings.push({ where: 'index', code: 'index_missing', why: 'section 5 (Requirement index) is missing' });
  else {
    const table = firstTable(s5);
    if (!table) findings.push({ where: 'index', code: 'index_missing', why: 'section 5 has no index table' });
    else {
      const parsed = parseRequirementIndex(table.join('\n'));
      if (!parsed.ok) findings.push({ where: 'index', code: 'index_invalid', why: `${parsed.row === 0 ? 'the index' : `index row ${parsed.row}`} is refused: ${parsed.why}` });
      else index = parsed.rows;
    }
  }
  // The index and the subsections agree (B04): every R<n> of §4 has a row
  // and every row a subsection; a criterion in one and absent from the other
  // is a contradiction. Reported here; slice 34 makes them refuse approval.
  const byKey = new Map(requirements.map((r) => [r.key, r]));
  for (const row of index) {
    const req = byKey.get(row.key);
    if (!req) {
      findings.push({ where: row.key, code: 'index_subsection_mismatch', why: `${row.key} has an index row and no section 4 subsection` });
      continue;
    }
    req.phase_hint = row.phase;
    req.origin = row.origin;
    if (req.sensitive_areas.length === 0 && row.sensitive_areas.length > 0) req.sensitive_areas = [...row.sensitive_areas];
    const inIndex = new Set(row.criteria);
    const inBody = new Set(req.criteria.map((c) => c.id));
    for (const c of row.criteria) if (!inBody.has(c)) findings.push({ where: row.key, code: 'criterion_mismatch', why: `the criterion ${c} is in the index and not under ${row.key} in section 4` });
    for (const c of inBody) if (!inIndex.has(c)) findings.push({ where: row.key, code: 'criterion_mismatch', why: `the criterion ${c} is under ${row.key} in section 4 and not in the index` });
  }
  for (const req of requirements) if (!index.some((r) => r.key === req.key) && index.length > 0) findings.push({ where: req.key, code: 'index_subsection_mismatch', why: `${req.key} has a section 4 subsection and no index row` });
  const questions = parseQuestions(secs.get(10), findings);
  for (const q of questions) for (const key of q.blocks) byKey.get(key)?.blocked_by_questions.push(q.id);
  const modules = parseModules(secs.get(6), findings);
  const environments = parseEnvironments(secs.get(7));
  const claims = parseClaims(secs.get(12), findings);
  const representation: SpecRepresentation = { header, requirements, index, questions, modules, environments, claims };
  return { readable: true, representation, findings, digest: digestOf(representation) };
}

// The keys of KEY form in a list of requirement keys, for callers that want
// only well-formed ones.
export const isRequirementKey = (k: string): boolean => KEY.test(k);
