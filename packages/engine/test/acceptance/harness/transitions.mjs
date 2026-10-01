// The Verifier's transition tables as code (build spec §4, Plan §2). Cases
// are generated from ../contract/*.json, never from the engine's own tables.
// The harness self-check exercises every function here, and shows that a
// wrong table or a wrong path is caught.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (name) => JSON.parse(readFileSync(new URL(`../contract/${name}`, import.meta.url), 'utf8'));

export const WORK = load('work-items.json');
export const LIFECYCLE = load('run-lifecycle.json');

export const STATUSES = WORK.statuses;
export const CONTINUATIONS = WORK.continuations;

export const m1Kinds = (table = WORK) => Object.keys(table.kinds).filter((k) => table.kinds[k].m1);

const kindOf = (kind, table) => {
  const spec = table.kinds[kind];
  if (!spec) throw new Error(`no work kind ${kind} in the contract table`);
  return spec;
};

const templateApplies = (template, spec) => !template.only_kinds_with || spec.path.includes(template.only_kinds_with);

// Every edge the kind may take, each with where it comes from: its path, or
// a template. `continue` edges are listed for each continuation the kind can
// store; whether one is legal for a given item depends on what that item
// stored (isLegal).
export function legalEdges(kind, table = WORK) {
  const spec = kindOf(kind, table);
  const edges = [];
  const reach = new Set(spec.path);
  for (let i = 0; i + 1 < spec.path.length; i++) edges.push({ from: spec.path[i], to: spec.path[i + 1], via: 'path' });
  const has = (from, to) => edges.some((e) => e.from === from && e.to === to);
  const templates = Object.entries(table.templates).filter(([name]) => !name.startsWith('$'));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, template] of templates) {
      if (!templateApplies(template, spec)) continue;
      for (const from of template.from) {
        if (!reach.has(from)) continue;
        const targets = name === 'continue' ? table.continuations.filter((c) => spec.path.includes(c)) : [template.to];
        for (const to of targets) {
          if (has(from, to)) continue;
          edges.push({ from, to, via: name });
          reach.add(to);
          grew = true;
        }
      }
    }
  }
  return edges;
}

export const reachable = (kind, table = WORK) => {
  const edges = legalEdges(kind, table);
  return table.statuses.filter((s) => kindOf(kind, table).path.includes(s) || edges.some((e) => e.to === s));
};

// The continuations a kind can store on entering awaiting_decision.
export const continuationsOf = (kind, table = WORK) =>
  legalEdges(kind, table).filter((e) => e.via === 'block').map((e) => e.from);

// Is from → to legal for this kind? Leaving awaiting_decision for executing,
// integrating or verifying is legal only for the continuation the item
// stored when it entered (correction 11).
export function isLegal(kind, from, to, { continuation } = {}, table = WORK) {
  if (!legalEdges(kind, table).some((e) => e.from === from && e.to === to)) return false;
  if (from === 'awaiting_decision' && table.continuations.includes(to)) return to === continuation;
  return true;
}

// The statuses that own a run, for a kind (Stop and Abandon apply from each).
export const owningStatuses = (kind, table = WORK) => {
  const spec = kindOf(kind, table);
  if (!spec.path.includes('claimed')) return [];
  const reach = reachable(kind, table);
  return table.run_owning.filter((s) => reach.includes(s));
};

// The statuses to step through, from `eligible`, to bring an item of this
// kind to `target` by legal edges only. For awaiting_decision, `continuation`
// says which status it is entered from (default: the first the kind allows).
// The route never passes through awaiting_decision on the way to something else.
export function routeTo(kind, target, { continuation } = {}, table = WORK) {
  if (target === 'awaiting_decision') {
    const from = continuation ?? continuationsOf(kind, table)[0];
    if (from === undefined) {
      const path = kindOf(kind, table).path;
      const at = path.indexOf('awaiting_decision');
      if (at < 0) throw new Error(`${kind} cannot reach awaiting_decision`);
      return path.slice(1, at + 1);
    }
    return [...routeTo(kind, from, {}, table), 'awaiting_decision'];
  }
  const edges = legalEdges(kind, table).filter((e) => e.from !== 'awaiting_decision' && e.to !== 'awaiting_decision');
  const start = kindOf(kind, table).path[0];
  const queue = [[start]];
  const seen = new Set([start]);
  while (queue.length > 0) {
    const route = queue.shift();
    const at = route.at(-1);
    if (at === target) return route.slice(1);
    for (const e of edges) {
      if (e.from !== at || seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push([...route, e.to]);
    }
  }
  throw new Error(`${kind} cannot reach ${target}`);
}

// Every (from, to) the kind must refuse, with how to reach `from`. For
// awaiting_decision there is one group per continuation the kind can store.
export function illegalEdgeCases(kind, table = WORK) {
  const cases = [];
  for (const from of reachable(kind, table)) {
    const variants = from === 'awaiting_decision' ? continuationsOf(kind, table).map((c) => ({ continuation: c })) : [{}];
    if (variants.length === 0) variants.push({});
    for (const variant of variants) {
      const targets = table.statuses.filter((to) => to !== from && !isLegal(kind, from, to, variant, table));
      cases.push({ from, ...variant, route: routeTo(kind, from, variant, table), targets });
    }
  }
  return cases;
}

// Check an observed path, a list of statuses starting where the item was
// created, against the table. Throws naming the first illegal step.
export function assertWorkPathLegal(kind, path, what = 'work item', table = WORK) {
  assert.ok(Array.isArray(path) && path.length > 0, `${what}: no path observed`);
  assert.equal(path[0], kindOf(kind, table).path[0], `${what}: a ${kind} item starts ${kindOf(kind, table).path[0]}, observed ${path[0]}`);
  let continuation;
  for (let i = 0; i + 1 < path.length; i++) {
    const [from, to] = [path[i], path[i + 1]];
    assert.ok(
      isLegal(kind, from, to, { continuation }, table),
      `${what}: ${from} → ${to} is not a legal ${kind} transition` +
        (from === 'awaiting_decision' ? ` (stored continuation: ${continuation})` : '') +
        `; path observed: ${path.join(' → ')}`,
    );
    if (to === 'awaiting_decision') continuation = from;
  }
}

export function assertRunPathLegal(states, what = 'run', table = LIFECYCLE) {
  assert.ok(Array.isArray(states) && states.length > 0, `${what}: no states observed`);
  assert.equal(states[0], 'created', `${what}: a run starts created, observed ${states[0]}`);
  for (let i = 0; i + 1 < states.length; i++) {
    assert.ok(
      table.run.edges.some(([from, to]) => from === states[i] && to === states[i + 1]),
      `${what}: ${states[i]} → ${states[i + 1]} is not a legal run transition; path observed: ${states.join(' → ')}`,
    );
  }
}

export const isLegalDomainEdge = (from, to, table = LIFECYCLE) => table.domain.edges.some(([a, b]) => a === from && b === to);

// Outcome → the reason classes it may carry and the workspace disposition it leaves.
export const outcomeSpec = (outcome, table = LIFECYCLE) => {
  const spec = table.run.outcomes[outcome];
  if (!spec) throw new Error(`no run outcome ${outcome} in the contract table`);
  return spec;
};

export const roleOf = (kind, table = WORK) => kindOf(kind, table).role;
