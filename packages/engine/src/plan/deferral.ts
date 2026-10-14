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
import { checksOfVersion } from '../store/transitions/evidence.js';
import type { Tx } from '../store/transitions/tx.js';
import { observeTrigger } from '../store/transitions/work.js';

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

// At an authoring proposal's application: its deferrals recorded.
export function recordDeferrals(tx: Tx, args: { project: string; proposal: string }): number {
  const row = tx.db
    .prepare(
      `SELECT p."deferred_criteria", w."subject", w."kind" FROM "protected_proposals" p JOIN "runs" r ON r."id" = p."run" JOIN "work_items" w ON w."id" = r."work_item" WHERE p."id" = ?`,
    )
    .get(args.proposal) as { deferred_criteria: string | null; subject: string; kind: string } | undefined;
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
// number) of the plan's active generation, or a stage of the module that
// holds its interface (the plan's bundle's module map), integrated.
function prerequisiteMet(db: Db, plan: string | null, pre: Deferral['prerequisite']): boolean {
  if (plan === null) return false;
  const active = activePlanOf(db, plan);
  const stages = activeStages<{ number: number; status: string; modules: string }>(db, active).filter((s) => s.status === 'integrated' || s.status === 'verified');
  if (pre.stage !== undefined) return stages.some((s) => s.number === pre.stage);
  if (pre.interface === undefined) return false;
  const bundle = db.prepare('SELECT b."artifacts" FROM "phase_plans" p JOIN "plan_bundles" b ON b."id" = p."bundle" WHERE p."id" = ?').get(active) as { artifacts: string } | undefined;
  const modules = parse<{ modules?: { modules?: { name: string; interfaces?: { name: string }[] }[] } }>(bundle?.artifacts ?? null, {}).modules?.modules ?? [];
  const holders = modules.filter((m) => (m.interfaces ?? []).some((i) => i.name === pre.interface)).map((m) => m.name);
  if (holders.length === 0) return false;
  const ids = holders.flatMap((name) => (db.prepare('SELECT "id" FROM "modules" WHERE "name" = ? AND "project" = (SELECT "project" FROM "phase_plans" WHERE "id" = ?)').all(name, active) as { id: string }[]).map((m) => m.id));
  return stages.some((s) => parse<string[]>(s.modules, []).some((m) => holders.includes(m) || ids.includes(m)));
}

// Every unresolved deferral whose prerequisite has integrated: its
// follow-up `check_authoring`, once (the trigger identity).
export function followUpsDue(tx: Tx, project: string): number {
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
  return n;
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
