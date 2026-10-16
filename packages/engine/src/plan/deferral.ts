// Deferred authoring (D6 §6.2, D6-W06; A.2 CheckObligationReason
// `deferred_authoring`; B.7 `deferred_criteria`; B07; SEAM.md §428): a check
// the Verifier cannot write yet (its interface does not exist) is listed in
// its authoring result with its reason and its prerequisite, a stage of the
// plan by number or an interface of the module map by name. When the
// authoring is applied, each entry becomes an unresolved obligation with a
// follow-up identity (`deferred_authoring`, <the obligation>, 1); the
// prerequisite's integration makes that follow-up `check_authoring` eligible
// exactly once (the trigger identity is the store's uniqueness); the
// obligation is resolved by an applied version whose required acceptance
// checks cover its criterion. Until then the phase and deployment gates
// carry AUTHORING_INCOMPLETE naming it (plan/phase.ts authoringShortfall).

import type { Database } from 'better-sqlite3';

import { activeStages } from './active.js';
import { type DecisionRow, invalidateDecision } from '../store/transitions/decisions.js';
import { checksOfVersion } from '../store/transitions/evidence.js';
import type { Tx } from '../store/transitions/tx.js';
import { getWorkItem, observeTrigger, transitionWork } from '../store/transitions/work.js';

type Db = Database;

const parse = <T>(text: unknown, fallback: T): T => {
  try {
    return typeof text === 'string' ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

interface Deferral {
  criterion: string;
  reason: string;
  prerequisite: { stage?: number; interface?: string };
}

// The plan generation now active of the one named (D6 §5.7).
function activePlanOf(db: Db, plan: string): string {
  let id = plan;
  for (let hops = 0; hops < 64; hops++) {
    const row = db.prepare('SELECT "active", "replaced_by" FROM "phase_plans" WHERE "id" = ?').get(id) as { active: number; replaced_by: string | null } | undefined;
    if (!row || row.active === 1 || row.replaced_by === null) return id;
    id = row.replaced_by;
  }
  return id;
}

// The criteria a phase plan owes (D6 §6.2: the authoring writes checks for
// "every criterion the plan's stages validate"): its planned obligations'
// criteria, every scope, with the criteria its active stages' `validation`
// names. Null when not known: a plan published by no check (a fixture's)
// records no planned obligations, and an absent or unreadable check is
// unknown, never none, so nothing is refused or dropped on it.
export function criteriaOwed(db: Db, plan: string): Set<string> | null {
  const row = db.prepare('SELECT p."bundle", c."obligations" FROM "phase_plans" p LEFT JOIN "plan_checks" c ON c."id" = p."check" WHERE p."id" = ?').get(plan) as { bundle: string | null; obligations: string | null } | undefined;
  if (!row || row.bundle === null) return null;
  const planned = parse<unknown>(row.obligations, null);
  if (!Array.isArray(planned)) return null;
  const owed = new Set<string>();
  for (const o of planned as { criteria?: unknown }[]) for (const c of Array.isArray(o?.criteria) ? o.criteria : []) if (typeof c === 'string') owed.add(c);
  for (const st of activeStages<{ validation: string | null }>(db, plan)) {
    const v = parse<{ criteria?: unknown }>(st.validation, {}).criteria;
    for (const c of Array.isArray(v) ? v : []) if (typeof c === 'string') owed.add(c);
  }
  return owed;
}

// The owner's `build_first` (D6 §6.2; F §5.1; the slice-37 review's M8):
// the plan's authoring still owed, as one `authoring_pending` obligation
// whose follow-up `check_authoring` is raised once the plan's active stages
// have all integrated, and resolved by that follow-up's applied proposal.
export function recordAuthoringPending(tx: Tx, args: { project: string; phase_plan: string; decision: string }): string {
  const id = tx.newId('obl_');
  const followUp = { trigger_source: 'authoring_pending', trigger_id: id, trigger_generation: 1 };
  const generation = (tx.db.prepare('SELECT "spec_evidence_generation" AS g FROM "projects" WHERE "id" = ?').get(args.project) as { g: number }).g;
  tx.db
    .prepare(
      `INSERT INTO "check_obligations" ("id", "created_at", "project", "check", "key", "criteria", "generation", "reason", "request", "prerequisite", "deferred_reason", "follow_up", "phase_plan")
       VALUES (?, ?, ?, NULL, NULL, '[]', ?, 'authoring_pending', NULL, NULL, ?, ?, ?)`,
    )
    .run(id, tx.at, args.project, generation, 'the owner let the Builders build first (build_first)', JSON.stringify(followUp), args.phase_plan);
  tx.emit('check.obligation_recorded', { project: args.project, check_obligation: id }, { reason: 'authoring_pending', criteria: [], follow_up: followUp, decision: args.decision });
  return id;
}

// At an authoring proposal's application: its deferrals recorded, and an
// `authoring_pending` obligation its run was the follow-up of resolved.
export function recordDeferrals(tx: Tx, args: { project: string; proposal: string }): number {
  const row = tx.db
    .prepare(
      `SELECT p."deferred_criteria", w."subject", w."kind", w."trigger_source", w."trigger_id" FROM "protected_proposals" p JOIN "runs" r ON r."id" = p."run" JOIN "work_items" w ON w."id" = r."work_item" WHERE p."id" = ?`,
    )
    .get(args.proposal) as { deferred_criteria: string | null; subject: string; kind: string; trigger_source: string | null; trigger_id: string | null } | undefined;
  if (row && row.kind === 'check_authoring' && row.trigger_source === 'authoring_pending' && row.trigger_id !== null) {
    if (tx.db.prepare(`UPDATE "check_obligations" SET "resolved_by" = ?, "resolved_at" = ? WHERE "id" = ? AND "resolved_at" IS NULL`).run(args.proposal, tx.at, row.trigger_id).changes > 0) {
      tx.emit('check.obligation_resolved', { project: args.project, check_obligation: row.trigger_id }, { resolved_by: args.proposal, how: 'authoring_applied' });
    }
  }
  if (!row || row.kind !== 'check_authoring' || row.deferred_criteria === null) return 0;
  const plan = parse<{ phase_plan?: string }>(row.subject, {}).phase_plan ?? null;
  const generation = (tx.db.prepare('SELECT "spec_evidence_generation" AS g FROM "projects" WHERE "id" = ?').get(args.project) as { g: number }).g;
  let n = 0;
  for (const d of parse<Deferral[]>(row.deferred_criteria, [])) {
    const id = tx.newId('obl_');
    const followUp = { trigger_source: 'deferred_authoring', trigger_id: id, trigger_generation: 1 };
    tx.db
      .prepare(
        `INSERT INTO "check_obligations" ("id", "created_at", "project", "check", "key", "criteria", "generation", "reason", "request", "prerequisite", "deferred_reason", "follow_up", "phase_plan")
         VALUES (?, ?, ?, NULL, NULL, ?, ?, 'deferred_authoring', NULL, ?, ?, ?, ?)`,
      )
      .run(id, tx.at, args.project, JSON.stringify([d.criterion]), generation, JSON.stringify(d.prerequisite), d.reason, JSON.stringify(followUp), plan);
    tx.emit('check.obligation_recorded', { project: args.project, check_obligation: id }, { reason: 'deferred_authoring', criteria: [d.criterion], prerequisite: d.prerequisite, follow_up: followUp, proposal: args.proposal });
    n++;
  }
  return n;
}

// Whether a deferral's prerequisite has integrated code: its stage (by
// number) of the plan's active generation integrated, or, for an interface,
// every active stage of the plan whose modules hold it (the plan's bundle's
// module map) integrated, at least one; each neither cancelled nor parked
// (the stage-code milestone's rule, D6 §6.4; the slice-37 review's N10).
// The engine cannot tell which of a module's stages writes an interface, so
// one stage of the module integrated is not enough (found by the real loop
// run 1: an interface of a module the phase's first stage touched).
function prerequisiteMet(db: Db, plan: string | null, pre: Deferral['prerequisite']): boolean {
  if (plan === null) return false;
  const active = activePlanOf(db, plan);
  const all = activeStages<{ number: number; status: string; modules: string; parked_at: string | null; cancelled_at: string | null }>(db, active).filter((s) => s.cancelled_at === null);
  const integrated = (s: (typeof all)[number]) => (s.status === 'integrated' || s.status === 'verified') && s.parked_at === null;
  if (pre.stage !== undefined) return all.some((s) => s.number === pre.stage && integrated(s));
  if (pre.interface === undefined) return false;
  const bundle = db.prepare('SELECT b."artifacts" FROM "phase_plans" p JOIN "plan_bundles" b ON b."id" = p."bundle" WHERE p."id" = ?').get(active) as { artifacts: string } | undefined;
  const modules = parse<{ modules?: { modules?: { name: string; interfaces?: { name: string }[] }[] } }>(bundle?.artifacts ?? null, {}).modules?.modules ?? [];
  const holders = modules.filter((m) => (m.interfaces ?? []).some((i) => i.name === pre.interface)).map((m) => m.name);
  if (holders.length === 0) return false;
  const ids = holders.flatMap((name) => (db.prepare('SELECT "id" FROM "modules" WHERE "name" = ? AND "project" = (SELECT "project" FROM "phase_plans" WHERE "id" = ?)').all(name, active) as { id: string }[]).map((m) => m.id));
  const holding = all.filter((s) => parse<string[]>(s.modules, []).some((m) => holders.includes(m) || ids.includes(m)));
  return holding.length > 0 && holding.every(integrated);
}

// Why a deferral is not one this plan's authoring may make, or null: a
// criterion the phase does not owe (its checks are authored with the phase
// that owes it; found by the real loop run 1, a phase-1 authoring deferring
// phase 2's criteria), a stage number the plan's active generation does not
// have, or an interface no module of its bundle's module map holds (the
// slice-37 review's M5).
export function deferralRefsInvalid(db: Db, plan: string | null, deferrals: Deferral[]): string | null {
  if (deferrals.length === 0) return null;
  if (plan === null) return 'deferred_criteria names prerequisites, and the authoring names no plan';
  const active = activePlanOf(db, plan);
  const owed = criteriaOwed(db, active);
  if (owed !== null) {
    const foreign = [...new Set(deferrals.map((d) => d.criterion).filter((c) => !owed.has(c)))];
    if (foreign.length > 0) {
      const phase = (db.prepare('SELECT "phase_number" FROM "phase_plans" WHERE "id" = ?').get(active) as { phase_number: number } | undefined)?.phase_number;
      const which = phase === undefined ? 'this phase' : `phase ${phase}`;
      const many = foreign.length > 1;
      return `the deferral${many ? 's' : ''} of ${foreign.join(', ')} name${many ? '' : 's'} ${many ? 'criteria' : 'a criterion'} ${which} does not owe (it owes ${[...owed].sort().join(', ') || 'none'}); a criterion's checks are authored with the phase that owes it: leave ${many ? 'them' : 'it'} out of deferred_criteria and write no check for ${many ? 'them' : 'it'} in ${which}`;
    }
  }
  const numbers = new Set(activeStages<{ number: number }>(db, active).map((s) => s.number));
  const bundle = db.prepare('SELECT b."artifacts" FROM "phase_plans" p JOIN "plan_bundles" b ON b."id" = p."bundle" WHERE p."id" = ?').get(active) as { artifacts: string } | undefined;
  const interfaces = new Set(
    (parse<{ modules?: { modules?: { name: string; interfaces?: { name: string }[] }[] } }>(bundle?.artifacts ?? null, {}).modules?.modules ?? []).flatMap((m) => (m.interfaces ?? []).map((i) => i.name)),
  );
  for (const d of deferrals) {
    if (d.prerequisite.stage !== undefined && !numbers.has(d.prerequisite.stage)) return `the deferral of ${d.criterion} names stage ${d.prerequisite.stage}, which the plan does not have`;
    if (d.prerequisite.interface !== undefined && !interfaces.has(d.prerequisite.interface)) return `the deferral of ${d.criterion} names the interface ${d.prerequisite.interface}, which no module of the plan's module map holds`;
  }
  return null;
}

// A deferral recorded for a criterion its phase does not owe (a store from
// before the scope rule above, or a plan replaced since): resolved, with
// `check.obligation_resolved` (how `not_owed_by_phase`), so it holds no
// gate and dispatches no follow-up; its follow-up not yet running is
// cancelled with its open questions. Its checks are the owing phase's.
export function resolveUnowedDeferrals(tx: Tx, project: string): number {
  const rows = tx.db
    .prepare(`SELECT "id", "criteria", "phase_plan", "follow_up" FROM "check_obligations" WHERE "project" = ? AND "reason" = 'deferred_authoring' AND "resolved_at" IS NULL AND "phase_plan" IS NOT NULL ORDER BY rowid`)
    .all(project) as { id: string; criteria: string; phase_plan: string; follow_up: string | null }[];
  let n = 0;
  for (const o of rows) {
    const active = activePlanOf(tx.db, o.phase_plan);
    const owed = criteriaOwed(tx.db, active);
    const criteria = parse<string[]>(o.criteria, []);
    if (owed === null || criteria.length === 0 || criteria.some((c) => owed.has(c))) continue;
    if (tx.db.prepare('UPDATE "check_obligations" SET "resolved_by" = ?, "resolved_at" = ? WHERE "id" = ? AND "resolved_at" IS NULL').run(active, tx.at, o.id).changes === 0) continue;
    tx.emit('check.obligation_resolved', { project, check_obligation: o.id }, { resolved_by: active, how: 'not_owed_by_phase', criteria, phase_plan: active });
    const f = parse<{ trigger_source?: string; trigger_id?: string }>(o.follow_up, {});
    const items = tx.db
      .prepare(`SELECT "id" FROM "work_items" WHERE "project" = ? AND "kind" = 'check_authoring' AND "trigger_source" = ? AND "trigger_id" = ? AND "status" IN ('eligible', 'held', 'parked', 'awaiting_decision')`)
      .all(project, f.trigger_source ?? 'deferred_authoring', f.trigger_id ?? o.id) as { id: string }[];
    for (const w of items) {
      const item = getWorkItem(tx, w.id);
      if (!item) continue;
      transitionWork(tx, item, 'cancelled', { blocker: null }, { cause: 'not_owed_by_phase', check_obligation: o.id });
      const open = tx.db.prepare(`SELECT * FROM "decisions" WHERE "subject_type" = 'work_item' AND "subject_id" = ? AND "status" = 'open'`).all(w.id) as DecisionRow[];
      for (const d of open) invalidateDecision(tx, d, `the deferral it followed up names criteria phase plan ${active} does not owe (${criteria.join(', ')})`);
    }
    n++;
  }
  return n;
}

// The same, for the authoring run's plan (its work item's subject).
export function deferralRefsInvalidForRun(db: Db, args: { run: string; deferrals: Deferral[] }): string | null {
  const row = db.prepare('SELECT w."subject" FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."id" = ?').get(args.run) as { subject: string } | undefined;
  return deferralRefsInvalid(db, parse<{ phase_plan?: string }>(row?.subject ?? null, {}).phase_plan ?? null, args.deferrals);
}

// Every unresolved deferral whose prerequisite has integrated: its
// follow-up `check_authoring`, once (the trigger identity).
export function followUpsDue(tx: Tx, project: string): number {
  // A deferral its phase does not owe is resolved first, never followed up.
  resolveUnowedDeferrals(tx, project);
  let made = 0;
  // `authoring_pending` (M8): once every active stage of the plan has
  // integrated (and none is parked), the authoring is asked again, once.
  const pending = tx.db
    .prepare(`SELECT "id", "follow_up", "phase_plan" FROM "check_obligations" WHERE "project" = ? AND "reason" = 'authoring_pending' AND "resolved_at" IS NULL AND "phase_plan" IS NOT NULL ORDER BY rowid`)
    .all(project) as { id: string; follow_up: string | null; phase_plan: string }[];
  for (const o of pending) {
    const active = activePlanOf(tx.db, o.phase_plan);
    const stages = activeStages<{ status: string; parked_at: string | null }>(tx.db, active);
    if (stages.length === 0 || !stages.every((s) => (s.status === 'integrated' || s.status === 'verified') && s.parked_at === null)) continue;
    const f = parse<{ trigger_source: string; trigger_id: string; trigger_generation: number }>(o.follow_up, { trigger_source: 'authoring_pending', trigger_id: o.id, trigger_generation: 1 });
    const out = observeTrigger(tx, { project, kind: 'check_authoring', trigger_source: f.trigger_source, trigger_id: f.trigger_id, trigger_generation: f.trigger_generation, subject: { phase_plan: active }, chain: 0 }, { check_obligation: o.id });
    if (out.created) made++;
  }
  const rows = tx.db
    .prepare(`SELECT "id", "prerequisite", "follow_up", "phase_plan" FROM "check_obligations" WHERE "project" = ? AND "reason" = 'deferred_authoring' AND "resolved_at" IS NULL ORDER BY rowid`)
    .all(project) as { id: string; prerequisite: string; follow_up: string; phase_plan: string | null }[];
  let n = 0;
  for (const o of rows) {
    if (!prerequisiteMet(tx.db, o.phase_plan, parse<Deferral['prerequisite']>(o.prerequisite, {}))) continue;
    const f = parse<{ trigger_source: string; trigger_id: string; trigger_generation: number }>(o.follow_up, { trigger_source: 'deferred_authoring', trigger_id: o.id, trigger_generation: 1 });
    const made = observeTrigger(
      tx,
      { project, kind: 'check_authoring', trigger_source: f.trigger_source, trigger_id: f.trigger_id, trigger_generation: f.trigger_generation, subject: o.phase_plan ? { phase_plan: activePlanOf(tx.db, o.phase_plan) } : {}, chain: 0 },
      { check_obligation: o.id },
    );
    if (made.created) n++;
  }
  return n + made;
}

// At a version's application: each unresolved deferral whose criterion a
// required acceptance-origin check of the version now covers is resolved.
export function resolveDeferrals(tx: Tx, args: { project: string; version: string }): number {
  const covering = checksOfVersion(tx.db, args.version).filter((c) => c.required === 1 && (c.origin ?? 'acceptance') !== 'developer');
  const covered = new Set(covering.flatMap((c) => parse<string[]>(c.criteria ?? null, [])));
  const rows = tx.db.prepare(`SELECT "id", "criteria" FROM "check_obligations" WHERE "project" = ? AND "reason" = 'deferred_authoring' AND "resolved_at" IS NULL ORDER BY rowid`).all(args.project) as { id: string; criteria: string }[];
  let n = 0;
  for (const o of rows) {
    const criteria = parse<string[]>(o.criteria, []);
    if (criteria.length === 0 || !criteria.every((c) => covered.has(c))) continue;
    tx.db.prepare('UPDATE "check_obligations" SET "resolved_by" = ?, "resolved_at" = ? WHERE "id" = ? AND "resolved_at" IS NULL').run(args.version, tx.at, o.id);
    tx.emit('check.obligation_resolved', { project: args.project, check_obligation: o.id }, { resolved_by: args.version, how: 'deferred_checks_applied' });
    n++;
  }
  return n;
}
