// What a specification's keys and open questions say about it beyond its
// own syntax (D6 §3.2, §3.4; B04; reading 1; TPL §4, §10). Pure: each
// function reads two representations, or one.
//
// - `compareKeys`: a key renumbered against an earlier representation (a
//   requirement's statement, or a criterion's text, now under another key
//   while the old key is gone or holds something else), and a key that
//   disappeared (recorded `withdrawn` at approval, never deleted). TPL: a key
//   never changes once confirmed.
// - `questionBlockers`: the open questions of §10 that block `approve`
//   (the strict reading the coordinator ruled, D6 §12 reading 1 with B04): a
//   question with no `(phase n)` hint; a question blocking a requirement
//   with no index phase; a question blocking a requirement whose index phase
//   is 1. A question's own hint does not move a requirement out of phase 1.

import type { SpecRepresentation } from './semantics.js';

export interface Renumbered {
  kind: 'requirement' | 'criterion';
  key: string;
  from: string;
}

export interface KeyComparison {
  renumbered: Renumbered[];
  // Requirement keys and criteria of `prev` that `next` no longer has.
  withdrawn: string[];
  // Keys `prev` carries as withdrawn that `next` uses again (TPL §4: a key
  // is never reused).
  reused: string[];
}

// The values of `pairs` that occur once, by value.
function uniqueByValue(pairs: [string, string][]): Map<string, string> {
  const count = new Map<string, number>();
  for (const [, v] of pairs) count.set(v, (count.get(v) ?? 0) + 1);
  return new Map(pairs.filter(([, v]) => v !== '' && count.get(v) === 1).map(([k, v]) => [v, k]));
}

export function compareKeys(prev: SpecRepresentation | null, next: SpecRepresentation): KeyComparison {
  if (prev === null) return { renumbered: [], withdrawn: [], reused: [] };
  const carried = new Set(prev.requirements.filter((r) => r.withdrawn === true).map((r) => r.key));
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const renumbered: Renumbered[] = [];
  prev = { ...prev, requirements: prev.requirements.filter((r) => r.withdrawn !== true) };
  next = { ...next, requirements: next.requirements.filter((r) => r.withdrawn !== true) };
  const prevStatement = new Map(prev.requirements.map((r) => [r.key, norm(r.statement)]));
  const nextStatement = new Map(next.requirements.map((r) => [r.key, norm(r.statement)]));
  const prevByStatement = uniqueByValue([...prevStatement.entries()]);
  for (const r of next.requirements) {
    const s = norm(r.statement);
    const from = prevByStatement.get(s);
    if (from === undefined || from === r.key) continue;
    // Moved, not copied: the old key is gone or now says something else,
    // and this key said something else before.
    if (nextStatement.get(from) === s) continue;
    if (prevStatement.get(r.key) === s) continue;
    renumbered.push({ kind: 'requirement', key: r.key, from });
  }
  // A criterion renumbered within its own requirement (the review's M1): a
  // criterion's text moved to another requirement is a withdrawal there and
  // an addition here, never a renumbering.
  for (const r of next.requirements) {
    const before = prev.requirements.find((q) => q.key === r.key);
    if (!before) continue;
    const prevCrit = new Map(before.criteria.map((c) => [c.id, norm(c.text)]));
    const nextCrit = new Map(r.criteria.map((c) => [c.id, norm(c.text)]));
    const prevByText = uniqueByValue([...prevCrit.entries()]);
    for (const [id, text] of nextCrit) {
      const from = prevByText.get(text);
      if (from === undefined || from === id) continue;
      if (nextCrit.get(from) === text) continue;
      if (prevCrit.get(id) === text) continue;
      renumbered.push({ kind: 'criterion', key: id, from });
    }
  }
  // Keys and criteria of the earlier text that this one no longer has (a
  // key carried there as withdrawn already is not reported again).
  const live = (rep: SpecRepresentation) => rep.requirements.filter((r) => r.withdrawn !== true);
  const keys = new Set(live(next).map((r) => r.key));
  const ids = new Set(live(next).flatMap((r) => r.criteria.map((c) => c.id)));
  const withdrawn = live(prev).map((r) => r.key).filter((k) => !keys.has(k));
  const criteria = live(prev).filter((r) => keys.has(r.key)).flatMap((r) => r.criteria.map((c) => c.id)).filter((id) => !ids.has(id));
  const reused = live(next).map((r) => r.key).filter((k) => carried.has(k));
  return { renumbered, withdrawn: [...new Set([...withdrawn, ...criteria])].sort(), reused: [...new Set(reused)].sort() };
}

// `CODE:subject` strings, as every option blocker is written.
export function questionBlockers(rep: SpecRepresentation): string[] {
  const out: string[] = [];
  const byKey = new Map(rep.requirements.filter((r) => r.withdrawn !== true).map((r) => [r.key, r]));
  for (const q of rep.questions) {
    if (q.phase_hint === null) out.push(`QUESTION_NO_PHASE_HINT:${q.id}`);
    for (const key of q.blocks) {
      const r = byKey.get(key);
      if (!r) continue;
      if (r.phase_hint === null) out.push(`REQUIREMENT_NO_PHASE_HINT:${key}:${q.id}`);
      else if (r.phase_hint === 1) out.push(`QUESTION_BLOCKS_PHASE_1:${q.id}:${key}`);
    }
  }
  return [...new Set(out)];
}
