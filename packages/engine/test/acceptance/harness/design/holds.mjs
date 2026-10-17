// What accounts for each design-held stage (D7 §11 as corrected by Sean,
// E162 item 1; BS6 §4.1 rule 25 as amended; SEAM.md §547). Store reads
// only, shared by the kernel and project lanes (drive.mjs
// `assertHoldsAccounted`, which adds the reads) and the real-lane runner
// (harness/real/m6-lane.mjs, its stall and step-end judgements).
//
// The replacement invariant: every `stage_build` item held `design_pending`
// or `design_stale` is accounted for by at least one of
//   - `question`:    an open `design_due` whose `held_stages` names its stage;
//   - `session`:     an owner-opened Designer session not ended (the engine
//                    opens one only on the owner's answer or route, so every
//                    Designer session is owner-opened);
//   - `deferral`:    an unexpired `later` deferral answered on that stage
//                    (`projects.design_due.deferred`, its `held` naming it);
//   - `engine_work`: engine work pending that moves the hold: the Designer
//                    session an `open` asked for, not yet allocated; the
//                    interface inventory's derivation (no digest yet, fewer
//                    than three failed commits); an approved design's
//                    readiness; a design batch the engine is preparing or
//                    holding behind a pending correction.
// Each account carries the cause and the next action. A deferral or a
// Designer session is an INTENTIONAL WAIT: reported as waiting, never as
// completion or a passed real-lane step.
//
// Nothing here writes, starts or signals anything.

import { withStore } from '../store.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const one = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).get(...params));
const parse = (v) => {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

// The engine's count after which design_due names a failing inventory (due.ts INVENTORY_FAILURES_NAMED).
const INVENTORY_FAILURES_NAMED = 3;

// Every design-held stage of the project with what accounts for it, the
// unaccounted ones, and the intentional waits running now. `nowMs`: the
// engine's time (the kernel lane's controlled clock; the real lane's wall clock).
export function designHoldAccounts(home, project, { nowMs = Date.now() } = {}) {
  const held = rows(home, `SELECT "id", "subject", "held", "status" FROM "work_items" WHERE "project" = ? AND "kind" = 'stage_build' AND "held" IN ('design_pending', 'design_stale') ORDER BY "seq"`, project).map((w) => ({
    work_item: w.id,
    stage: parse(w.subject)?.stage ?? null,
    held: w.held,
    status: w.status,
  }));
  const project_row = one(home, 'SELECT "design_due", "design_inventory_digest" FROM "projects" WHERE "id" = ?', project) ?? {};
  const state = parse(project_row.design_due) ?? {};
  const dues = rows(home, `SELECT "id", "evidence", "raised_at" FROM "decisions" WHERE "project" = ? AND "kind" = 'design_due' AND "status" = 'open' ORDER BY "seq"`, project).map((d) => ({ id: d.id, raised_at: d.raised_at, evidence: parse(d.evidence) ?? {} }));
  const sessions = rows(home, `SELECT "id", "session_state" FROM "runs" WHERE "project" = ? AND "role" = 'designer' AND "kind" = 'session' AND "state" <> 'ended' ORDER BY "seq"`, project);
  const deferred = state.deferred && typeof state.deferred.until === 'string' ? state.deferred : null;
  const deferralLive = deferred !== null && Date.parse(deferred.until) > nowMs;
  // Engine work that moves a design hold (see the header).
  const work = [];
  if (typeof state.open_requested === 'string') work.push({ cause: 'engine_work', work: 'designer_session_opening', decision: state.open_requested, next_action: 'the engine allocates the Designer session the owner asked for at its next tick' });
  if ((project_row.design_inventory_digest ?? null) === null && (state.inventory_failure?.count ?? 0) < INVENTORY_FAILURES_NAMED) work.push({ cause: 'engine_work', work: 'inventory_derivation', next_action: 'the engine derives and commits the interface inventory' });
  for (const r of rows(home, `SELECT "id" FROM "design_revisions" WHERE "project" = ? AND "status" = 'approved' AND "ready_at" IS NULL ORDER BY rowid`, project)) {
    work.push({ cause: 'engine_work', work: 'readiness', design_revision: r.id, next_action: "the approved design's criteria's checks applied, then design_ready" });
  }
  const batch = rows(home, `SELECT "id", "status" FROM "work_items" WHERE "project" = ? AND "kind" = 'spec_change' AND "status" NOT IN ('complete', 'cancelled') ORDER BY "seq"`, project);
  const proposed = rows(home, `SELECT "id" FROM "design_revisions" WHERE "project" = ? AND "status" = 'proposed' ORDER BY rowid`, project);
  if (batch.length > 0 && proposed.length > 0) work.push({ cause: 'engine_work', work: 'design_batch', design_revision: proposed.at(-1).id, work_items: batch.map((w) => w.id), next_action: "the design batch raised once its specification change is written (or its pending correction answered)" });

  const holds = held.map((h) => {
    const accounts = [];
    for (const d of dues) if ((d.evidence.held_stages ?? []).includes(h.stage)) accounts.push({ cause: 'question', decision: d.id, raised_at: d.raised_at, next_action: d.evidence.command ?? null });
    for (const s of sessions) accounts.push({ cause: 'session', run: s.id, session_state: s.session_state, next_action: `the owner's turn in Designer session ${s.id}, or its close` });
    if (deferralLive && (deferred.held ?? []).includes(h.stage)) accounts.push({ cause: 'deferral', decision: deferred.decision, until: deferred.until, next_action: `design_due asked again at ${deferred.until}, or at once on a new cause` });
    accounts.push(...work);
    return { ...h, accounts };
  });
  const unaccounted = holds.filter((h) => h.accounts.length === 0);
  // The intentional waits on the owner running now: an unexpired deferral
  // (held stages or not), and a Designer session while a stage is held.
  const waits = [
    ...(deferralLive ? [{ cause: 'deferral', decision: deferred.decision, until: deferred.until, held_stages: deferred.held ?? [] }] : []),
    ...(holds.length > 0 ? sessions.map((s) => ({ cause: 'session', run: s.id, session_state: s.session_state })) : []),
  ];
  return {
    holds,
    unaccounted,
    waits,
    // An expired deferral the engine still records: its re-raise is owed at its next review.
    deferral_expired: deferred !== null && !deferralLive ? { decision: deferred.decision, until: deferred.until } : null,
  };
}

// One line per hold naming what accounts for it (for messages).
export const describeHolds = (acc) =>
  acc.holds.map((h) => `${h.stage} (${h.held}, work ${h.work_item}): ${h.accounts.length === 0 ? 'NOTHING' : h.accounts.map((a) => `${a.cause}${a.work ? `:${a.work}` : ''} ${a.decision ?? a.run ?? a.design_revision ?? ''}`.trim()).join(', ')}`).join('; ');
