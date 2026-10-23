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

// A role's Medium defect naming `login` and R1.1; `extra` adds fields (a
// reported `scope`).
export const defect = (message, extra = {}) => ({ category: 'defect', severity: 'medium', message, check: 'login', criterion: 'R1.1', ...extra });
// D-3's project: `login` required at `alpha_authorize` only, so no `stage`
// scope requires it; `acc` covers R1.1 at both gates, so the stage's scope is
// validated without it.
export const ALPHA_ONLY = Object.freeze({ acc: def('acceptance', { criteria: ['R1.1'] }), smoke: def('smoke'), login: def('acceptance', { criteria: ['R1.1'], gates: ['alpha_authorize'] }) });
export const ALPHA_ONLY_REQUIRED = Object.freeze(['acc', 'smoke', 'login']);

const json = (text) => (text === null || text === undefined ? text : typeof text === 'string' ? JSON.parse(text) : text);
const candidatesOf = (home, project) => withStore(home, (db) => db.prepare('SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"').all(project));
const lineageOf = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "lineages" WHERE "id" = ?').get(id));

// The project, its stage built and nominated: candidate 1, its nomination's
// registrations of both required checks queued, the stage's work `verifying`.
// `defs` and `required` replace the checks (D-3's case: `login` required at
// `alpha_authorize` only); every key of `required` is registered at the
// nomination and recorded by `verified`.
export async function fixProject(fx, { defs = DEFS, required = REQUIRED } = {}) {
  const p = await repairProject(fx, { defs, governed: { required_checks: [...required] }, index: INDEX, policy: { autonomy: 'step' } });
  const { candidate: c1 } = await buildAndNominate(fx, p, { keys: [...required] });
  return { p, c1, ctx: { project: p, stage: p.stages[0].id, candidate: c1 }, required };
}

// A candidate verified: each required check's nomination registration
// recorded passing (with output), and its verification work let through the
// chain boundary by a person, its Verifier reporting nothing, complete.
// Returns {key: result}.
export async function verified(fx, p, candidate, { required = REQUIRED, exits = {} } = {}) {
  const reg = await tickUntil(
    fx.engine,
    p.id,
    () => {
      const r = registrationsBy(fx.home, candidate.id);
      return required.every((k) => r[k]) ? r : undefined;
    },
    { max: 8, what: `candidate ${candidate.seq}'s nomination registrations` },
  );
  const results = {};
  for (const key of required) results[key] = { ...(await recordExit(fx.engine, reg[key].id, exits[key] ?? 0, { output: `${key} ${(exits[key] ?? 0) === 0 ? 'passed' : 'failed'} on candidate ${candidate.seq}\n` })), execution_seq: reg[key].execution_seq };
  const v = workItemsOf(fx.home, p.id).find((w) => w.kind === 'verification' && w.subject?.candidate === candidate.id);
  assert.ok(v, `the fixture is live: candidate ${candidate.seq}'s nomination registered its verification`);
  fx.scripted.script(v.id, [roleThat([], {})]);
  // At the chain boundary a person lets it through; work below the chain limit (a fixture's fix's candidate) is not held there.
  await tick(fx.engine, p.id);
  const boundary = withStore(fx.home, (db) => db.prepare(`SELECT 1 FROM "decisions" WHERE "kind" = 'blocker' AND "subject_id" = ? AND "status" = 'open'`).get(v.id));
  if (boundary) await consume(fx, p.id, await openDecision(fx, p.id, 'blocker', v.id), 'continue');
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
  const { run } = await acceptedRun(fx, p.id, 'check_correction', { result: { findings: [defect('F26: the durations are strings where the token contract gives milliseconds', { scope: 'candidate' })] } });
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
// stage verified before either (so no stage work is left verifying). With
// `verifyC2` (M512's state, the run's) fix 1's candidate is verified before
// fix 2 is built; without it (M235's and M234's) fix 2's candidate supersedes
// it first, its queued registrations cancelled. With `verifyC3` fix 2's
// candidate is verified. `defs` and `required` as `fixProject`'s.
export async function supersededFix(fx, { defs = DEFS, required = REQUIRED, verifyC2 = true, verifyC3 = true } = {}) {
  const { p, c1, ctx } = await fixProject(fx, { defs, required });
  await verified(fx, p, c1, { required });
  const stage = p.stages[0].work_item;
  await tickUntil(fx.engine, p.id, () => workItem(fx.home, stage).status === 'complete', { max: 8, what: "the stage verified on its first candidate by the engine's own stage gate" });
  const findings = await raiseFindings(fx, p.id, c1.id, [defect('F33 one: the first defect'), defect('F33 two: the second defect')], { kind: 'verification' });
  const fixes = [];
  for (const f of findings) fixes.push((await ownerFix(fx, p, f)).fix);
  const c2 = await successor(fx, ctx, { work: fixes[0].id });
  const onC2 = verifyC2 ? await verified(fx, p, c2, { required }) : null;
  const c3 = await successor(fx, ctx, { work: fixes[1].id });
  const onC3 = verifyC3 ? await verified(fx, p, c3, { required }) : null;
  await tick(fx.engine, p.id, { rounds: 4 });
  const [, c2now, c3now] = candidatesOf(fx.home, p.id);
  assert.equal(c2now.superseded_by, c3.id, "the fixture is live: fix 2's candidate supersedes fix 1's");
  assert.equal(lineageOf(fx.home, c3now.lineage)?.started_from_candidate, c2.id, "the fixture is live: fix 2's candidate started from fix 1's, so it holds fix 1 by ancestry (E43)");
  assert.ok(json(c2now.held_work).includes(fixes[0].id) && !json(c3now.held_work).includes(fixes[0].id), `the fixture is live: fix 1 is in its own candidate's held work only (${c2now.held_work}, ${c3now.held_work})`);
  for (const f of findings) {
    const disposed = findingRow(fx.home, f.id).disposition_seq;
    for (const [on, which] of [[onC2, 2], [onC3, 3]]) if (on && on.login) assert.ok(on.login.execution_seq > disposed, `the fixture is live: login recorded on candidate ${which} after ${f.id}'s disposition`);
  }
  return { p, c1, c2: c2now, c3: c3now, ctx, stage, findings: findings.map((f) => findingRow(fx.home, f.id)), fixes: fixes.map((w) => workItem(fx.home, w.id)), onC2, onC3 };
}

// D-3's `fix_unjudged` blockers about a fix (Sean's ruling of 2026-10-23,
// errata E180): `blocker` decisions whose subject is the fix's work item and
// whose dependency manifest's `cause` is `fix_unjudged` (the blocker's
// reason, as `repair_attempts_max` is a parked repair's). `open` only the
// open ones.
export function fixUnjudged(home, fixId, { open = false } = {}) {
  return withStore(home, (db) =>
    db
      .prepare(`SELECT * FROM "decisions" WHERE "kind" = 'blocker' AND "subject_type" = 'work_item' AND "subject_id" = ? AND json_extract("dependency_manifest", '$.cause') = 'fix_unjudged'${open ? ` AND "status" = 'open'` : ''} ORDER BY rowid`)
      .all(fixId),
  ).map((d) => ({ ...d, options: json(d.options), dependency_manifest: json(d.dependency_manifest) }));
}

// The malformed shape the engine wrote before D-1 (Sean's ruling of
// 2026-10-23, errata E180; F26): a role's finding with a non-project scope
// and no candidate, made in the test's own disposable store with the engine
// stopped (the API no longer writes it once D-1 is built), then the engine
// started again. Returns the rows as stored.
export async function legacyShape(fx, project, findingIds, { scope = 'candidate' } = {}) {
  await fx.engine.kill();
  withStore(
    fx.home,
    (db) => {
      for (const id of findingIds) db.prepare('UPDATE "findings" SET "scope" = ?, "candidate" = NULL, "subject_id" = ? WHERE "id" = ? AND "project" = ?').run(scope, project, id, project);
    },
    { readonly: false },
  );
  await fx.start();
  return findingIds.map((id) => findingRow(fx.home, id));
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

// D-3's state (Sean's ruling of 2026-10-23, errata E180): `login` required at
// `alpha_authorize` only (ALPHA_ONLY), the stage verified on candidate 1, a
// Verifier's finding there naming login dispositioned `fix` by the owner, the
// fix built and its candidate verified: no supported evaluation can judge it,
// and the engine raises its one `fix_unjudged` blocker. `tier` T1 by default.
export async function unjudgedFix(fx, { tier = 'T1' } = {}) {
  const p = await repairProject(fx, { tier, defs: ALPHA_ONLY, governed: { required_checks: [...ALPHA_ONLY_REQUIRED] }, index: INDEX, policy: { autonomy: 'step' } });
  const { candidate: c1 } = await buildAndNominate(fx, p, { keys: [...ALPHA_ONLY_REQUIRED] });
  const ctx = { project: p, stage: p.stages[0].id, candidate: c1 };
  await verified(fx, p, c1, { required: ALPHA_ONLY_REQUIRED });
  const stage = p.stages[0].work_item;
  await tickUntil(fx.engine, p.id, () => workItem(fx.home, stage).status === 'complete', { max: 8, what: 'the stage verified on candidate 1' });
  const [finding] = await raiseFindings(fx, p.id, c1.id, [defect('D-3: login refuses a valid session')], { kind: 'verification' });
  const { fix } = await ownerFix(fx, p, finding);
  const c2 = await successor(fx, ctx, { work: fix.id });
  await verified(fx, p, c2, { required: ALPHA_ONLY_REQUIRED });
  const blocker = await tickUntil(fx.engine, p.id, () => fixUnjudged(fx.home, fix.id, { open: true })[0], { max: 8, what: "the fix's fix_unjudged blocker" });
  return { p, c1, c2, ctx, stage, finding: findingRow(fx.home, finding.id), fix: workItem(fx.home, fix.id), blocker };
}
