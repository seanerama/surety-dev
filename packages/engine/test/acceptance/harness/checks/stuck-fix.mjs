// Objection 209 (findings F19, F26 and F33 of the M535 Waterlog recovery
// attempt; Sean's ruling of 2026-10-23, errata E179 item 8): a `fix` work
// item the engine leaves `verifying` with nothing able to move it, and the
// real-lane harness counting it as runnable. The fixtures of M235's cases
// for it and of M512's case of the harness's judgement, built through the
// engine's API in the kernel lane (no browser, no real model).
//
// The project (T1, `step`): R1 with criterion R1.1; one stage implementing
// R1; discovered checks `login` (acceptance, covering R1.1) and `smoke`,
// both required. Every finding here names `login` and R1.1, so a check that
// can verify it exists (D3 §2.11 conditions 1 and 2): what is observed is
// never a missing verification.
//
// Two states the run reached, each made as the run made it:
//   - `uncandidatedFix` (F19, F26): a Verifier's `check_correction` run (its
//     work names no candidate) raises the finding; the owner answers its
//     owed `finding_disposition` question `fix`; the fix's Builder runs and
//     its candidate is nominated and verified, `login` passing there after
//     the disposition; the engine evaluates the stage gate by itself.
//   - `supersededFix` (F33): the stage verified on its first candidate; two
//     findings raised on that candidate by a Verifier, each dispositioned
//     `fix` by the owner; fix 1's candidate nominated and verified, `login`
//     passing there; fix 2's candidate supersedes it (holding fix 1 by
//     ancestry) and is verified, `login` passing there too; every
//     verification complete, every question answered. Nothing runs, nothing
//     is queued, nothing is asked.
//
// `judgedOrAsked` is the terminal judgement of both M235 cases, the minimum
// either of the answers objection 209 leaves to Sean satisfies (no silent
// hold; Sean's "without silently dropping work"): the finding resolved by an
// evaluation, with the fix complete (D3 §2.11; E36 item 4; E38 item 6), or an
// open owner question naming the fix or its finding. A fix complete while its
// finding is not resolved is a drop, never a pass.

import assert from 'node:assert/strict';

import { consume, openDecision } from '../decisions.mjs';
import { acceptedRun, raiseFindings, successor } from '../gates.mjs';
import { roleThat } from '../gitruns.mjs';
import { workItemsOf } from '../journal.mjs';
import { tick, tickUntil, workItem } from '../runs.mjs';
import { withStore } from '../store.mjs';
import { recordExit } from './selection.mjs';
import { buildAndNominate, def, findingRow, registrationsBy, repairProject } from './repair.mjs';

export const DEFS = Object.freeze({ login: def('acceptance', { criteria: ['R1.1'] }), smoke: def('smoke') });
export const REQUIRED = Object.freeze(['login', 'smoke']);
const INDEX = Object.freeze([{ key: 'R1', criteria: ['R1.1'] }]);

export const defect = (message) => ({ category: 'defect', severity: 'medium', message, check: 'login', criterion: 'R1.1' });

const json = (text) => (text === null || text === undefined ? text : typeof text === 'string' ? JSON.parse(text) : text);
const candidatesOf = (home, project) => withStore(home, (db) => db.prepare('SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"').all(project));
const lineageOf = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "lineages" WHERE "id" = ?').get(id));

// The project, its stage built and nominated: candidate 1, its nomination's
// registrations of both required checks queued, the stage's work `verifying`.
export async function fixProject(fx) {
  const p = await repairProject(fx, { defs: DEFS, governed: { required_checks: [...REQUIRED] }, index: INDEX, policy: { autonomy: 'step' } });
  const { candidate: c1 } = await buildAndNominate(fx, p, { keys: [...REQUIRED] });
  return { p, c1, ctx: { project: p, stage: p.stages[0].id, candidate: c1 } };
}

// A candidate verified: each required check's nomination registration
// recorded passing (with output), and its verification work let through the
// chain boundary by a person, its Verifier reporting nothing, complete.
// Returns {key: result}.
export async function verified(fx, p, candidate) {
  const reg = await tickUntil(
    fx.engine,
    p.id,
    () => {
      const r = registrationsBy(fx.home, candidate.id);
      return REQUIRED.every((k) => r[k]) ? r : undefined;
    },
    { max: 8, what: `candidate ${candidate.seq}'s nomination registrations` },
  );
  const results = {};
  for (const key of REQUIRED) results[key] = { ...(await recordExit(fx.engine, reg[key].id, 0, { output: `${key} passed on candidate ${candidate.seq}\n` })), execution_seq: reg[key].execution_seq };
  const v = workItemsOf(fx.home, p.id).find((w) => w.kind === 'verification' && w.subject?.candidate === candidate.id);
  assert.ok(v, `the fixture is live: candidate ${candidate.seq}'s nomination registered its verification`);
  fx.scripted.script(v.id, [roleThat([], {})]);
  await consume(fx, p.id, await openDecision(fx, p.id, 'blocker', v.id), 'continue');
  await tickUntil(fx.engine, p.id, () => workItem(fx.home, v.id).status === 'complete', { what: `candidate ${candidate.seq}'s verification to complete` });
  return results;
}

// The owner's answer `fix` to the owed finding_disposition question about
// the finding (as Sean's, posted by the driver, in the run): the fix work
// item the engine registers for it.
export async function ownerFix(fx, p, finding) {
  const owed = await openDecision(fx, p.id, 'finding_disposition', finding.id);
  assert.ok((owed.options ?? []).some((o) => o.key === 'fix'), `the fixture is live: the owed question offers fix (${JSON.stringify((owed.options ?? []).map((o) => o.key))})`);
  await consume(fx, p.id, owed, 'fix');
  const fix = workItemsOf(fx.home, p.id).find((w) => w.kind === 'fix' && w.subject?.finding === finding.id);
  assert.ok(fix, 'the fixture is live: the engine registered the fix for the owner\'s disposition (E43)');
  return { fix, owed };
}

// F19, F26: the finding a Verifier's check_correction run raises (its work
// names no candidate), dispositioned `fix` by the owner, its fix built, its
// candidate nominated and verified with `login` passing after the
// disposition, and the engine ticked: the stage gate it evaluates by itself
// on the fix's candidate is satisfied.
export async function uncandidatedFix(fx) {
  const { p, c1, ctx } = await fixProject(fx);
  const before = new Set(withStore(fx.home, (db) => db.prepare('SELECT "id" FROM "findings" WHERE "project" = ?').all(p.id)).map((r) => r.id));
  const { run } = await acceptedRun(fx, p.id, 'check_correction', { result: { findings: [defect('F26: the durations are strings where the token contract gives milliseconds')] } });
  const raised = withStore(fx.home, (db) => db.prepare('SELECT * FROM "findings" WHERE "project" = ? AND "source_run" = ?').all(p.id, run.id)).filter((f) => !before.has(f.id));
  assert.equal(raised.length, 1, 'the fixture is live: the check_correction run raised one finding');
  const [finding] = raised;
  const { fix, owed } = await ownerFix(fx, p, finding);
  const c2 = await successor(fx, ctx, { work: fix.id });
  assert.ok(json(c2.held_work).includes(fix.id), `the fixture is live: the fix's candidate holds it (${c2.held_work})`);
  const results = await verified(fx, p, c2);
  const stage = p.stages[0].work_item;
  await tickUntil(fx.engine, p.id, () => workItem(fx.home, stage).status === 'complete', { max: 8, what: "the engine's own stage gate on the fix's candidate to complete the stage" });
  await tick(fx.engine, p.id, { rounds: 3 });
  const disposed = findingRow(fx.home, finding.id).disposition_seq;
  assert.ok(results.login.execution_seq > disposed, `the fixture is live: login passed on the fix's candidate by an execution registered after the disposition (${results.login.execution_seq} > ${disposed})`);
  return { p, c1, c2, ctx, finding: findingRow(fx.home, finding.id), fix: workItem(fx.home, fix.id), owed, results };
}

// F33: a plain fix whose candidate a later fix's candidate supersedes, the
// stage verified before either (so no stage work is left verifying), every
// verification complete and every question answered.
export async function supersededFix(fx) {
  const { p, c1, ctx } = await fixProject(fx);
  await verified(fx, p, c1);
  const stage = p.stages[0].work_item;
  await tickUntil(fx.engine, p.id, () => workItem(fx.home, stage).status === 'complete', { max: 8, what: "the stage verified on its first candidate by the engine's own stage gate" });
  const findings = await raiseFindings(fx, p.id, c1.id, [defect('F33 one: the first defect'), defect('F33 two: the second defect')], { kind: 'verification' });
  const fixes = [];
  for (const f of findings) fixes.push((await ownerFix(fx, p, f)).fix);
  const c2 = await successor(fx, ctx, { work: fixes[0].id });
  const onC2 = await verified(fx, p, c2);
  const c3 = await successor(fx, ctx, { work: fixes[1].id });
  const onC3 = await verified(fx, p, c3);
  await tick(fx.engine, p.id, { rounds: 4 });
  const [, c2now, c3now] = candidatesOf(fx.home, p.id);
  assert.equal(c2now.superseded_by, c3.id, "the fixture is live: fix 2's candidate supersedes fix 1's");
  assert.equal(lineageOf(fx.home, c3now.lineage)?.started_from_candidate, c2.id, "the fixture is live: fix 2's candidate started from fix 1's, so it holds fix 1 by ancestry (E43)");
  assert.ok(json(c2now.held_work).includes(fixes[0].id) && !json(c3now.held_work).includes(fixes[0].id), `the fixture is live: fix 1 is in its own candidate's held work only (${c2now.held_work}, ${c3now.held_work})`);
  for (const f of findings) {
    const disposed = findingRow(fx.home, f.id).disposition_seq;
    assert.ok(onC3.login.execution_seq > disposed && onC2.login.execution_seq > disposed, `the fixture is live: login passed on both fix candidates after ${f.id}'s disposition`);
  }
  return { p, c1, c2: c2now, c3: c3now, ctx, findings: findings.map((f) => findingRow(fx.home, f.id)), fixes: fixes.map((w) => workItem(fx.home, w.id)) };
}

// What the store says of a fix and its finding: the fix's status, the
// finding's status, scope and candidate, the evaluations that read it (the
// gate's `inputs_snapshot.findings`), the candidates holding the fix in their
// own held work (with their supersession), and the open questions naming
// the fix or the finding (as subject or in their evidence).
export function fixState(home, project, fixId, findingId) {
  return withStore(home, (db) => {
    const fix = db.prepare('SELECT "id", "kind", "status" FROM "work_items" WHERE "id" = ?').get(fixId);
    const f = db.prepare('SELECT "id", "status", "scope", "candidate", "disposition", "resolution_verification" FROM "findings" WHERE "id" = ?').get(findingId);
    const evaluations = db.prepare('SELECT "id", "candidate", "gate_kind", "outcome", "inputs_snapshot" FROM "gate_evaluations" WHERE "project" = ? ORDER BY rowid').all(project);
    const readBy = evaluations.filter((e) => (json(e.inputs_snapshot)?.findings ?? []).includes(findingId)).map((e) => e.id);
    const holders = db.prepare(`SELECT c."id", c."superseded_by" FROM "candidates" c, json_each(c."held_work") h WHERE c."project" = ? AND h."value" = ?`).all(project, fixId);
    const asked = db
      .prepare(`SELECT "id", "kind", "subject_type", "subject_id" FROM "decisions" WHERE "project" = ? AND "status" = 'open' AND ("subject_id" IN (?, ?) OR COALESCE("evidence", '') LIKE ? OR COALESCE("evidence", '') LIKE ?)`)
      .all(project, fixId, findingId, `%${fixId}%`, `%${findingId}%`);
    return {
      fix: fix?.status ?? null,
      finding: f ? { status: f.status, scope: f.scope, candidate: f.candidate, disposition: f.disposition, resolution_verification: json(f.resolution_verification) } : null,
      evaluations: evaluations.map((e) => ({ id: e.id, candidate: e.candidate, gate_kind: e.gate_kind, outcome: e.outcome })),
      read_by: readBy,
      holders,
      asked,
    };
  });
}

// The terminal judgement: judged (resolved, the fix complete) or asked (an
// open question naming the fix or its finding). A fix complete with its
// finding unresolved is a drop.
export function judgedOrAsked(home, project, fixId, findingId) {
  const s = fixState(home, project, fixId, findingId);
  const resolved = s.finding?.status === 'resolved' && s.finding.resolution_verification !== null && s.finding.resolution_verification !== undefined;
  const judged = s.fix === 'complete' && resolved;
  const dropped = s.fix === 'complete' && !resolved;
  return { ok: !dropped && (judged || s.asked.length > 0), judged, dropped, state: s };
}
