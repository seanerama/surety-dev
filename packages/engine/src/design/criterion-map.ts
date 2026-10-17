// The design criteria's specification ids (D7 §7.1, §7.2, §8.4; the
// slice-46 review's B1): each criterion of an approved design's
// criteria.json, by its index, mapped to the criterion of the specification
// its consolidated change wrote, recorded in the transaction that applies
// the change (`design_revisions.criterion_map`). The Verifier's and the
// Builder's packages and the review read the map, never the text again; a
// criterion that could not be mapped is kept in it with `id: null` and
// why, and stated as unmatched, never dropped.
//
// How a criterion is mapped, in order:
//   1. under its requirement (a criterion whose requirement is "new": under
//      the requirements the change added that are not human tests), to a
//      criterion the change added whose text is the same, whitespace
//      aside; equal texts are taken in order;
//   2. to a criterion of that requirement the specification already had
//      with the same text (a later design keeping an earlier criterion);
//   3. what is left under a requirement, paired in order with the criteria
//      the change added there and no criterion took, when both number the
//      same (a text the Spec Writer reworded);
//   4. else unmapped, with why.
// Pure, but for its reads of the store.

import type Database from 'better-sqlite3';

import { parseJson } from '../store/transitions/common.js';
import type { SpecRepresentation } from '../spec/semantics.js';

type Db = Database.Database;

export interface CriterionMapEntry {
  index: number;
  // The requirement criteria.json names (R<n>, or "new").
  requirement: string;
  kind: string;
  // The specification's criterion id, or null where none could be mapped.
  id: string | null;
  // The requirement the id is under.
  requirement_key: string | null;
  // The criterion's targets; where criteria.json names none, those the
  // design check scopes it to (every target of a screen of its requirement;
  // a new requirement's surface targets).
  targets: string[];
  how: 'text' | 'existing' | 'order' | null;
  why?: string;
}

const norm = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();
const critNum = (id: string): number => Number(id.split('.')[1] ?? 0);

export function criterionMap(args: {
  criteria: Record<string, unknown>[];
  screens: Record<string, unknown>[];
  rep: SpecRepresentation | null;
  added_criteria: string[];
  added_requirements: string[];
}): CriterionMapEntry[] {
  const reqs = new Map((args.rep?.requirements ?? []).filter((q) => q.withdrawn !== true).map((q) => [q.key, q]));
  const textOf = new Map<string, string>();
  for (const q of reqs.values()) for (const c of q.criteria) textOf.set(c.id, norm(c.text));
  const added = new Set(args.added_criteria);
  const keyOf = (id: string): string => id.split('.')[0]!;
  // The new requirements a "new" criterion may land under: added, not a human test.
  const newKeys = args.added_requirements.filter((k) => reqs.has(k) && reqs.get(k)!.human_test !== true);
  const pool = (requirement: string): string[] => {
    const keys = requirement === 'new' ? newKeys : [requirement];
    return keys.flatMap((k) => (reqs.get(k)?.criteria ?? []).map((c) => c.id)).filter((id) => added.has(id)).sort((a, b) => (keyOf(a) === keyOf(b) ? critNum(a) - critNum(b) : Number(keyOf(a).slice(1)) - Number(keyOf(b).slice(1))));
  };
  const out: CriterionMapEntry[] = args.criteria.map((c, index) => ({ index, requirement: String(c.requirement ?? ''), kind: String(c.kind ?? ''), id: null, requirement_key: null, targets: [], how: null }));
  const taken = new Set<string>();
  const set = (e: CriterionMapEntry, id: string, how: CriterionMapEntry['how']) => {
    e.id = id;
    e.requirement_key = keyOf(id);
    e.how = how;
    taken.add(id);
  };
  // 1. by text, among the criteria the change added.
  for (const e of out) {
    const text = norm(args.criteria[e.index]!.text);
    const hit = pool(e.requirement).find((id) => !taken.has(id) && textOf.get(id) === text);
    if (hit) set(e, hit, 'text');
  }
  // 2. by text, among the requirement's criteria the specification already had.
  for (const e of out.filter((x) => x.id === null && x.requirement !== 'new')) {
    const text = norm(args.criteria[e.index]!.text);
    const hit = (reqs.get(e.requirement)?.criteria ?? []).map((c) => c.id).find((id) => !added.has(id) && !taken.has(id) && textOf.get(id) === text);
    if (hit) set(e, hit, 'existing');
  }
  // 3. in order, where what is left under a requirement and what the change added there that nothing took number the same.
  for (const requirement of [...new Set(out.filter((x) => x.id === null).map((x) => x.requirement))]) {
    const left = out.filter((x) => x.id === null && x.requirement === requirement);
    const free = pool(requirement).filter((id) => !taken.has(id));
    if (left.length === free.length) left.forEach((e, i) => set(e, free[i]!, 'order'));
  }
  for (const e of out) {
    if (e.id === null) {
      e.why =
        e.requirement !== 'new' && !reqs.has(e.requirement)
          ? `the specification has no requirement ${e.requirement}`
          : `no criterion of ${e.requirement === 'new' ? 'a requirement the change added' : e.requirement} has its text, and what the change added there does not pair with it`;
    }
    // The targets: as named, else as the design check scopes it.
    const c = args.criteria[e.index]!;
    const named = Array.isArray(c.targets) ? (c.targets as unknown[]).filter((t): t is string => typeof t === 'string') : [];
    if (named.length > 0) e.targets = named;
    else if (e.requirement !== 'new') e.targets = [...new Set(args.screens.filter((s) => Array.isArray(s.requirements) && (s.requirements as unknown[]).includes(e.requirement)).map((s) => String(s.target)))].sort();
    else if (e.requirement_key) e.targets = [...(reqs.get(e.requirement_key)?.surface_targets ?? args.rep?.targets ?? [])];
  }
  return out;
}

// The map of the change applying now (approval.ts approveDesign): the
// applied specification's representation and the change's impact.
export function criterionMapAtApplication(db: Db, args: { specRevision: string; request: string; content: { criteria?: { criteria?: Record<string, unknown>[] }; screens?: { screens?: Record<string, unknown>[] } } | null }): CriterionMapEntry[] {
  const row = db.prepare('SELECT s."representation" FROM "spec_revisions" v LEFT JOIN "spec_semantics" s ON s."id" = v."semantics" WHERE v."id" = ?').get(args.specRevision) as { representation: string | null } | undefined;
  const rep = parseJson<SpecRepresentation>(row?.representation ?? null);
  const impact = parseJson<{ added_criteria?: string[]; requirements?: { key: string; changes: string[] }[] }>((db.prepare('SELECT "impact_value" FROM "spec_change_requests" WHERE "id" = ?').get(args.request) as { impact_value: string | null } | undefined)?.impact_value ?? null);
  return criterionMap({
    criteria: args.content?.criteria?.criteria ?? [],
    screens: args.content?.screens?.screens ?? [],
    rep,
    added_criteria: impact?.added_criteria ?? [],
    added_requirements: (impact?.requirements ?? []).filter((q) => q.changes.includes('added')).map((q) => q.key),
  });
}

// The latest approved design's criteria, mapped and not (the readers):
// null when no design is approved. An approved revision with no map (one
// approved without criteria, or before the map was recorded) has every
// criterion unmatched, with why.
export interface MappedCriteria {
  revision: string;
  mapped: (CriterionMapEntry & { id: string; requirement_key: string; criterion: Record<string, unknown> })[];
  unmatched: { index: number; requirement: string; kind: string; text: string; why: string }[];
}
export function mappedCriteria(db: Db, project: string): MappedCriteria | null {
  const rev = db
    .prepare(`SELECT "id", "status", "content", "criterion_map" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`)
    .get(project) as { id: string; status: string; content: string | null; criterion_map: string | null } | undefined;
  if (!rev) return null;
  const criteria = parseJson<{ criteria?: { criteria?: Record<string, unknown>[] } }>(rev.content)?.criteria?.criteria ?? [];
  const map = parseJson<CriterionMapEntry[]>(rev.criterion_map);
  const out: MappedCriteria = { revision: rev.id, mapped: [], unmatched: [] };
  for (const [index, c] of criteria.entries()) {
    const e = map?.find((x) => x.index === index) ?? null;
    if (e && e.id !== null && e.requirement_key !== null) out.mapped.push({ ...e, id: e.id, requirement_key: e.requirement_key, criterion: c });
    else
      out.unmatched.push({
        index,
        requirement: String(c.requirement ?? ''),
        kind: String(c.kind ?? ''),
        text: String(c.text ?? ''),
        why: e?.why ?? (rev.status === 'approved_without_criteria' ? 'the design was approved without its criteria: none is in the specification' : 'no mapping was recorded when the design was approved'),
      });
  }
  return out;
}
