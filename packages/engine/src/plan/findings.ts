// The parse at save of a session's products (D6 §3.1 to §3.3; SEAM.md §346):
// what the engine found of the files in the role's paths at the checkpoint,
// as findings `{code, path, subject, message}` the save answers and the
// engine's transcript entry carries. Pure: given the texts and what the
// approved baseline holds, it returns findings and the parsed artifacts.
//
// The codes are the Verifier's starting set (§346), extended by later slices
// and never renamed: `identity_block_invalid`; `spec_index_invalid`,
// `spec_criterion_mismatch`, `spec_requirement_unindexed`,
// `spec_row_unmatched`, `spec_requirement_uncertain`, `spec_area_unknown`,
// `spec_tier_invalid`, `spec_header_invalid`; `unknown_field`,
// `architecture_area_dropped`, `roadmap_requirement_duplicate`,
// `roadmap_requirement_missing`, `roadmap_phase_cycle`, `adr_key_missing`,
// `adr_status_invalid`, `machine_file_invalid`.

import { parseIdentityBlock } from '../spec/identity-block.js';
import { type SemanticFinding, type SemanticResult, type SpecRepresentation, parseSpecification } from '../spec/semantics.js';
import { compareKeys } from '../spec/keys.js';
import { ADR_FILE, type AdrFrontMatter, MODULES_FILE, type ModuleMap, PLAN_FILE, type PhasePlanFile, ROADMAP_FILE, type Roadmap, parseAdr, parseModuleMap, parsePhasePlan, parseRoadmap } from './schemas.js';

export interface Finding {
  code: string;
  path: string | null;
  subject: Record<string, unknown>;
  message: string;
}

// ---- the idea record (B.1) ---------------------------------------------------------------

export function ideaFindings(text: string): { findings: Finding[]; identity: Record<string, unknown> | null } {
  const parsed = parseIdentityBlock(text);
  if (parsed.ok) return { findings: [], identity: parsed.block as unknown as Record<string, unknown> };
  return {
    // The message names the key as well as the value (SEAM.md §345): the
    // engine's transcript entry carries the message.
    findings: parsed.findings.map((f) => ({ code: 'identity_block_invalid', path: '.surety/idea.md', subject: { key: f.key, value: valueNamed(f.why) }, message: f.key === null ? f.why : `${f.key}: ${f.why}` })),
    identity: null,
  };
}

// The value a finding names in quotes, if one.
const valueNamed = (why: string): string | null => /"([^"]+)"/.exec(why)?.[1] ?? null;

// ---- the specification (B.2) ----------------------------------------------------------------

const SPEC_CODES: Record<string, string> = {
  header_missing: 'spec_header_invalid',
  header_invalid: 'spec_header_invalid',
  index_invalid: 'spec_index_invalid',
  index_missing: 'spec_index_invalid',
  section_missing: 'spec_index_invalid',
  no_statement: 'spec_requirement_uncertain',
  no_criteria_no_mark: 'spec_requirement_uncertain',
  criterion_malformed: 'spec_criterion_mismatch',
  areas_missing: 'spec_area_unknown',
  area_unknown: 'spec_area_unknown',
  duplicate_requirement: 'spec_requirement_duplicate',
  duplicate_criterion: 'spec_criterion_duplicate',
  index_subsection_mismatch: 'spec_row_unmatched',
  criterion_mismatch: 'spec_criterion_mismatch',
  module_table_invalid: 'spec_modules_invalid',
  question_malformed: 'spec_question_invalid',
  claims_table_invalid: 'spec_claims_invalid',
  claims_requirement_unknown: 'spec_claims_invalid',
};

// One finding of the representation as the save answers it (SEAM.md §346).
export function specFinding(f: SemanticFinding, path = '.surety/spec/spec.md'): Finding {
  let code = SPEC_CODES[f.code] ?? 'spec_semantics_invalid';
  const subject: Record<string, unknown> = {};
  if (f.code === 'index_subsection_mismatch') {
    // A §4 requirement without a row, or a row without a subsection.
    code = /no index row/.test(f.why) ? 'spec_requirement_unindexed' : 'spec_row_unmatched';
    subject.key = f.where;
  } else if (f.code === 'criterion_mismatch' || f.code === 'criterion_malformed' || f.code === 'duplicate_criterion') {
    subject.key = f.where;
    subject.criterion = /\b(R[1-9][0-9]*\.[1-9][0-9]*)\b/.exec(f.why)?.[1] ?? null;
  } else if (f.code === 'index_invalid') {
    subject.row = /index row (\d+)/.exec(f.why) ? Number(/index row (\d+)/.exec(f.why)![1]) : 0;
    const rowKey = /index row \d+ \((R[1-9][0-9]*)\)/.exec(f.why)?.[1];
    if (rowKey) subject.key = rowKey;
    const area = /"([a-z_]+)" is not a sensitive area/.exec(f.why)?.[1];
    if (area) {
      code = 'spec_area_unknown';
      subject.area = area;
    }
  } else if (f.code === 'claims_requirement_unknown') {
    subject.key = / names (R[1-9][0-9]*),/.exec(f.why)?.[1] ?? null;
    subject.row = Number(/claims row (\d+)/.exec(f.why)?.[1] ?? 0);
  } else if (f.code === 'area_unknown' || f.code === 'areas_missing') {
    subject.area = valueNamed(f.why);
    subject.where = f.where;
  } else if ((f.code === 'header_invalid' || f.code === 'header_missing') && /Tier/.test(f.why)) {
    // A fourth tier, or none (M421 (d)).
    code = 'spec_tier_invalid';
    subject.tier = f.code === 'header_missing' ? null : valueNamed(f.why);
  } else if (f.where !== 'header' && f.where !== 'index' && f.where !== 'modules' && f.where !== 'questions' && f.where !== 'claims') subject.key = f.where;
  return { code, path, subject, message: f.why };
}

// What a blocker names of a finding (`CODE:subject`): the criterion, the
// key, the area, the row, else where it was found.
export function blockerOf(f: Finding): string {
  const s = f.subject;
  const name = s.criterion ?? s.key ?? s.area ?? (typeof s.row === 'number' && s.row > 0 ? `row ${s.row}` : null) ?? (s.tier !== undefined ? 'Tier' : null) ?? f.path ?? 'spec';
  return `${f.code}:${String(name)}`;
}

// `prev`: the representation of the project's previous save, against which
// a key renumbered or gone is named (D6 §3.2; M421 (c)); neither refuses the
// save, which is committed as a checkpoint like any other.
export function specFindings(text: string, path = '.surety/spec/spec.md', prev: SpecRepresentation | null = null): { findings: Finding[]; semantics: SemanticResult } {
  const semantics = parseSpecification(text);
  const findings: Finding[] = semantics.findings.map((f) => specFinding(f, path));
  if (semantics.representation !== null) {
    const keys = compareKeys(prev, semantics.representation);
    for (const r of keys.renumbered) {
      findings.push({ code: 'spec_keys_renumbered', path, subject: { key: r.key, from: r.from, kind: r.kind }, message: `${r.from} is now ${r.key}: a key never changes once given; keep ${r.from} and add a new key for anything new` });
    }
    for (const k of keys.withdrawn) {
      const criterion = k.includes('.');
      findings.push({
        code: 'spec_key_withdrawn',
        path,
        subject: criterion ? { key: k, criterion: k, requirement: k.split('.')[0] } : { key: k },
        message: `${k} is no longer in the specification: at approval it is recorded withdrawn, never deleted, and its key is not reused`,
      });
    }
    // The vanished requirements stay in this save's representation, marked
    // withdrawn (SEAM.md §397); the digest is over the live ones.
    const here = new Set(semantics.representation.requirements.map((r) => r.key));
    for (const r of prev?.requirements ?? []) if (!here.has(r.key)) semantics.representation.requirements.push({ ...r, withdrawn: true });
  }
  return { findings, semantics };
}

// ---- the Architect's files (B.3 to B.6) -------------------------------------------------------

export interface ArchitectTexts {
  // path → text, every file under the Architect's paths at the checkpoint.
  files: Record<string, string>;
}

export interface ArchitectBaseline {
  // The approved requirements' keys (not withdrawn).
  requirement_keys: string[];
  // TPL §6's modules of the approved specification, with their areas.
  spec_modules: { name: string; sensitive_areas: string[] }[];
  // Scoped mode's descriptive, criteria-less requirements (Sean,
  // 2026-10-13): each must be held by a module of the map.
  descriptive_keys?: string[];
}

export interface ArchitectParsed {
  modules: ModuleMap | null;
  roadmap: Roadmap | null;
  plans: Record<number, PhasePlanFile>;
  adrs: Record<string, { text: string; front: AdrFrontMatter }>;
  architecture_text: string | null;
}

export function architectFindings(texts: ArchitectTexts, baseline: ArchitectBaseline): { findings: Finding[]; parsed: ArchitectParsed } {
  const findings: Finding[] = [];
  const parsed: ArchitectParsed = { modules: null, roadmap: null, plans: {}, adrs: {}, architecture_text: texts.files['.surety/architecture/architecture.md'] ?? null };
  const schema = (path: string, finding: { field: string | null; why: string }) => {
    const unknown = /"([^"]+)" is not a field of/.exec(finding.why);
    if (unknown) findings.push({ code: 'unknown_field', path, subject: { path, field: unknown[1] }, message: `${path}: ${finding.why}` });
    else findings.push({ code: 'machine_file_invalid', path, subject: { path, field: finding.field }, message: `${path}: ${finding.why}` });
  };
  if (texts.files[MODULES_FILE] !== undefined) {
    const m = parseModuleMap(texts.files[MODULES_FILE]!, MODULES_FILE);
    if (m.ok) parsed.modules = m.value;
    else schema(MODULES_FILE, m.finding);
  }
  if (texts.files[ROADMAP_FILE] !== undefined) {
    const r = parseRoadmap(texts.files[ROADMAP_FILE]!, ROADMAP_FILE);
    if (r.ok) parsed.roadmap = r.value;
    else schema(ROADMAP_FILE, r.finding);
  }
  for (const [path, text] of Object.entries(texts.files)) {
    const plan = PLAN_FILE.exec(path);
    if (plan) {
      const p = parsePhasePlan(text, path, Number(plan[1]));
      if (p.ok) parsed.plans[p.value.phase] = p.value;
      else schema(path, p.finding);
      continue;
    }
    const adr = ADR_FILE.exec(path);
    if (adr) {
      const a = parseAdr(text, path);
      const key = adr[1]!;
      if (a.ok) parsed.adrs[a.value.key] = { text, front: a.value };
      else if (a.finding.field === 'key') findings.push({ code: 'adr_key_missing', path, subject: { adr: key, path }, message: `${path}: ${a.finding.why}` });
      else if (a.finding.field === 'status') findings.push({ code: 'adr_status_invalid', path, subject: { adr: key, path, status: valueNamed(a.finding.why) }, message: `${path}: ${a.finding.why}` });
      else schema(path, a.finding);
    }
  }
  // A sensitive area on a TPL §6 module can be moved, never dropped (D6 §3.3;
  // F §5.6's floor is the spec's): every area of every spec module appears
  // on some module of the map.
  if (parsed.modules) {
    const present = new Set(parsed.modules.modules.flatMap((m) => m.sensitive_areas));
    for (const sm of baseline.spec_modules) {
      for (const area of sm.sensitive_areas) {
        if (!present.has(area)) findings.push({ code: 'architecture_area_dropped', path: MODULES_FILE, subject: { area, module: sm.name }, message: `${MODULES_FILE} drops the sensitive area ${area} of the specification's module ${sm.name} from every module; an area can be moved, never dropped` });
      }
    }
  }
  // The requirements the modules hold (Sean, 2026-10-13): each a requirement
  // of the approved specification; in scoped mode every descriptive,
  // criteria-less requirement held by some module, so that a stage touching
  // it can be known (D6-R04, R08; E6).
  if (parsed.modules) {
    const held = new Set<string>();
    for (const m of parsed.modules.modules) {
      for (const k of m.requirements ?? []) {
        held.add(k);
        if (!baseline.requirement_keys.includes(k)) findings.push({ code: 'module_requirement_unknown', path: MODULES_FILE, subject: { module: m.name, key: k }, message: `${MODULES_FILE}: the module ${m.name} holds ${k}, which the approved specification does not have` });
      }
    }
    for (const k of baseline.descriptive_keys ?? []) {
      if (!held.has(k)) findings.push({ code: 'module_requirement_unmapped', path: MODULES_FILE, subject: { key: k }, message: `${MODULES_FILE}: no module holds ${k}, a descriptive requirement with no criteria; in scoped mode every one is held by the module it describes` });
    }
  }
  // The roadmap's references (D6 §3.3, §5.1): every approved requirement in
  // exactly one phase; phase dependencies acyclic.
  if (parsed.roadmap) {
    const seen = new Map<string, number[]>();
    for (const ph of parsed.roadmap.phases) for (const k of ph.requirement_ids) seen.set(k, [...(seen.get(k) ?? []), ph.number]);
    for (const [k, ns] of seen) if (ns.length > 1) findings.push({ code: 'roadmap_requirement_duplicate', path: ROADMAP_FILE, subject: { key: k, phases: ns }, message: `${ROADMAP_FILE} lists ${k} in phases ${ns.join(' and ')}; every requirement appears in exactly one phase` });
    for (const k of baseline.requirement_keys) if (!seen.has(k)) findings.push({ code: 'roadmap_requirement_missing', path: ROADMAP_FILE, subject: { key: k }, message: `${ROADMAP_FILE} assigns ${k} to no phase; every approved requirement appears in exactly one phase` });
    for (const k of seen.keys()) if (!baseline.requirement_keys.includes(k)) findings.push({ code: 'roadmap_requirement_unknown', path: ROADMAP_FILE, subject: { key: k }, message: `${ROADMAP_FILE} names ${k}, which the approved specification does not have` });
    const cycle = phaseCycle(parsed.roadmap);
    if (cycle) findings.push({ code: 'roadmap_phase_cycle', path: ROADMAP_FILE, subject: { phase: cycle[0], cycle }, message: `${ROADMAP_FILE}: phase ${cycle[0]} depends on itself through ${cycle.join(' -> ')}` });
  }
  return { findings, parsed };
}

function phaseCycle(r: Roadmap): number[] | null {
  const byNumber = new Map(r.phases.map((p) => [p.number, p]));
  const state = new Map<number, 'open' | 'done'>();
  const path: number[] = [];
  const visit = (n: number): number[] | null => {
    if (state.get(n) === 'done') return null;
    if (state.get(n) === 'open') return [...path.slice(path.indexOf(n)), n];
    state.set(n, 'open');
    path.push(n);
    for (const d of byNumber.get(n)?.depends_on ?? []) {
      if (d === n) return [n, n];
      if (!byNumber.has(d)) continue;
      const found = visit(d);
      if (found) return found;
    }
    path.pop();
    state.set(n, 'done');
    return null;
  };
  for (const p of r.phases) {
    const found = visit(p.number);
    if (found) return found;
  }
  return null;
}
