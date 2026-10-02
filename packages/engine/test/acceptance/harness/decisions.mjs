// Reads, commands and judgements for the decision rows of slice 5 (M45 to
// M58; SEAM.md §§76 to 82): what a preview binds, an answer that carries a
// preview taken before a dependency changed, the next generation the engine
// raises, an effect held between its consumption and its execution, and the
// scripted notification sink.
//
// ../contract/decisions.json says what each kind's preview must bind. No
// test asks the engine what a kind binds.

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { releaseBarrier, waitFor } from './engine.mjs';
import { assertRefused } from './fixtures.mjs';
import { armBarrier } from './journal.mjs';
import { tickUntil } from './runs.mjs';
import { withStore } from './store.mjs';

export const DECISIONS = JSON.parse(readFileSync(new URL('../contract/decisions.json', import.meta.url), 'utf8'));
export const CODES = DECISIONS.codes;

// ---- reads ------------------------------------------------------------------------

const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));
const parsed = (row) => row && { ...row, options: json(row.options), manifest: json(row.dependency_manifest), blocked: json(row.blocked_while_open), answer: json(row.answer), evidence: json(row.evidence) };

export const decision = (home, id) => parsed(withStore(home, (db) => db.prepare('SELECT * FROM "decisions" WHERE "id" = ?').get(id)));

// Every decision of one kind about one subject, oldest generation first.
export const decisionsOn = (home, kind, subjectId) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "decisions" WHERE "kind" = ? AND "subject_id" = ? ORDER BY "semantic_generation", "id"').all(kind, subjectId)).map(parsed);

export const decisionsOfKind = (home, project, kind) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "decisions" WHERE "project" = ? AND "kind" = ? ORDER BY "id"').all(project, kind)).map(parsed);

export const approvalsOf = (home, decisionId) => withStore(home, (db) => db.prepare('SELECT * FROM "approvals" WHERE "decision" = ? ORDER BY rowid').all(decisionId));

export const intentsOf = (home, decisionId) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "effect_intents" WHERE "decision" = ? ORDER BY rowid').all(decisionId)).map((row) => ({ ...row, preconditions: json(row.preconditions) }));

// The one open decision of a kind about a subject, ticking until the engine
// has raised it. The preview is checked against the contract on the way.
export async function openDecision(fx, project, kind, subjectId, { max = 4 } = {}) {
  const found = await tickUntil(
    fx.engine,
    project,
    () => {
      const open = decisionsOn(fx.home, kind, subjectId).filter((row) => row.status === 'open');
      return open.length > 0 ? open : undefined;
    },
    { max, what: `an open ${kind} decision about ${subjectId}` },
  );
  assert.equal(found.length, 1, `one open ${kind} decision about ${subjectId}, not ${found.length}`);
  return assertPreview(found[0]);
}

// ---- what a preview binds (Plan §3.5; build spec §6 correction 22; Review B12) ----------

// The decision's preview is complete for its kind: its subject is of a type
// the kind decides about, its manifest holds every dependency the contract
// names, and each option carries its effect plan and that plan's hash.
export function assertPreview(row) {
  const contract = DECISIONS.kinds[row.kind];
  assert.ok(contract, `${row.kind} is one of the eleven kinds M1 enables`);
  assert.ok(contract.subject_types.includes(row.subject_type), `a ${row.kind} decision is about ${contract.subject_types.join(' or ')} (it names a ${row.subject_type})`);
  assert.ok(row.manifest !== null && typeof row.manifest === 'object', `the ${row.kind} decision has a dependency manifest`);
  const missing = contract.manifest.filter((key) => !(key in row.manifest));
  assert.deepEqual(missing, [], `the ${row.kind} manifest binds every dependency of its kind (it has: ${Object.keys(row.manifest).join(', ')})`);
  assert.ok(typeof row.preview_hash === 'string' && row.preview_hash.length > 0, `the ${row.kind} decision has a preview hash`);
  for (const option of row.options) {
    assert.ok(option.effect_plan !== null && typeof option.effect_plan === 'object', `option ${option.key} carries its effect plan`);
    assert.ok(typeof option.plan_hash === 'string' && option.plan_hash.length > 0, `option ${option.key} carries its plan hash`);
  }
  return row;
}

// A command that goes through the queue (Stop, Abandon, a widening policy
// change) answers 409 `confirm_required` and names the decision it raised
// and that decision's preview hash (SEAM.md §17). Returns the decision, its
// preview checked, with the response as `response`.
export async function confirmRequired(fx, path, body = {}) {
  const res = await fx.engine.post(path, body);
  assertRefused(res, 409, 'confirm_required', `POST ${path} before its confirmation`);
  const row = decision(fx.home, res.body.subject?.decision);
  assert.ok(row, `the refusal names the decision it raised (body: ${res.text})`);
  assert.deepEqual([row.status, row.preview_hash], ['open', res.body.subject.preview_hash], 'the decision is open, and the response carries its preview hash');
  return { ...assertPreview(row), response: res };
}

// ---- answers ---------------------------------------------------------------------

// Answer with the preview hash of `row` as the test read it. The raw response.
export const answer = (engine, project, row, option, previewHash = row.preview_hash) =>
  engine.post(`/v1/projects/${project}/decisions/${row.id}/answer`, { option, preview_hash: previewHash });

// A positive answer: accepted, and the decision is consumed with that answer.
export async function consume(fx, project, row, option) {
  const res = await answer(fx.engine, project, row, option);
  assert.equal(res.status, 200, `answer ${row.kind} ${row.id} with ${option} (body: ${res.text})`);
  const after = decision(fx.home, row.id);
  assert.deepEqual([after.status, after.answer?.option], ['consumed', option], `the ${row.kind} decision is consumed with the answer given`);
  return after;
}

// An answer that carries a preview taken before a dependency changed is
// refused and has no effect of its own: nothing is consumed, approved or
// intended. The engine may find the change when the answer arrives
// (`decision_stale`) or may already have invalidated the decision
// (`decision_invalidated`); either is the refusal D1 §10.5 asks for.
export async function assertStaleAnswer(fx, project, previewed, option) {
  const res = await answer(fx.engine, project, previewed, option);
  assertRefused(res, 409, [CODES.stale, CODES.invalidated], `answering ${previewed.kind} with a preview taken before its dependency changed`);
  const after = decision(fx.home, previewed.id);
  assert.ok(['open', 'invalidated'].includes(after.status), `the decision is not consumed (it is ${after.status})`);
  assert.equal(after.answer ?? null, null, 'no answer is recorded on it');
  assert.equal(approvalsOf(fx.home, previewed.id).length, 0, 'no approval is recorded');
  assert.equal(intentsOf(fx.home, previewed.id).length, 0, 'no effect is intended');
  return res;
}

// After a change that leaves the question standing, the engine invalidates
// the old decision and raises the next generation about the same subject
// (D1 §4.6). The new preview is another preview: its hash differs and its
// manifest differs in each key of `changed`. The approval is not carried over.
export async function nextGeneration(fx, project, previewed, { changed, max = 4 }) {
  const next = await tickUntil(
    fx.engine,
    project,
    () => {
      const open = decisionsOn(fx.home, previewed.kind, previewed.subject_id).filter((row) => row.status === 'open' && row.id !== previewed.id);
      return decision(fx.home, previewed.id).status === 'invalidated' && open.length === 1 ? open[0] : undefined;
    },
    { max, what: `the ${previewed.kind} decision to be invalidated and its next generation raised` },
  );
  assertPreview(next);
  assert.equal(next.semantic_generation, previewed.semantic_generation + 1, 'the next generation follows the one that was invalidated');
  assert.notEqual(next.preview_hash, previewed.preview_hash, 'a changed dependency is a changed preview');
  for (const key of [changed].flat()) assert.notDeepEqual(next.manifest[key], previewed.manifest[key], `the manifests differ in "${key}", the dependency that changed`);
  assert.equal(approvalsOf(fx.home, next.id).length, 0, 'the next generation starts with no approval');
  return next;
}

// ---- an effect between its consumption and its execution (D1 §10.5) ---------------------

export const INTENT_BARRIER = 'intent.recorded';

// Whether the engine runs a consumed decision's effect within the answering
// request or in the next tick's effects step is its own choice. So while a
// test waits for an effect to reach a barrier, it keeps asking for ticks.
const nudge = (fx, project) => fx.engine.post(`/v1/projects/${project}/tick`, {}).catch(() => null);

// The engine is waiting at the pause barrier `name`.
export function reachBarrier(fx, project, name) {
  return waitFor(
    async () => {
      const res = await fx.engine.get('/v1/harness/barriers');
      if (res.status === 200 && res.body?.barriers?.some((barrier) => barrier.name === name && barrier.state === 'waiting')) return true;
      await nudge(fx, project);
      return undefined;
    },
    { intervalMs: 500, what: `the engine to reach the barrier ${name}` },
  );
}

// The engine has killed itself at a kill barrier.
export function untilKilled(fx, project) {
  return waitFor(
    async () => {
      if (!fx.engine.isRunning()) return true;
      await nudge(fx, project);
      return undefined;
    },
    { intervalMs: 500, what: 'the engine to kill itself at the barrier' },
  );
}

// Answer an effect-producing option and stop the engine between the
// transaction that consumes the decision and records its effect intent, and
// the revalidation that precedes the effect. The answer's response may be
// held until the barrier is released, so it is not awaited here. Returns
// {intent, release()}; release() lets the engine go on and returns the response.
export async function answerAndHoldEffect(fx, project, row, option) {
  await armBarrier(fx.engine, INTENT_BARRIER, 'pause');
  const pending = answer(fx.engine, project, row, option).catch((err) => err);
  await reachBarrier(fx, project, INTENT_BARRIER);
  const intents = intentsOf(fx.home, row.id);
  assert.equal(intents.length, 1, 'the consumption recorded one effect intent');
  assert.equal(intents[0].status, 'pending', 'which has not begun to execute');
  assert.equal(decision(fx.home, row.id).status, 'consumed', 'the decision is consumed before its effect runs');
  return {
    intent: intents[0],
    release: async () => {
      await releaseBarrier(fx.engine, INTENT_BARRIER);
      return pending;
    },
  };
}

// A dependency changed after the answer and before the effect: the intent is
// invalidated with the declared reason and never executes. What the answer's
// HTTP response says in that case is not pinned.
export async function assertEffectInvalidated(fx, row, held) {
  await held.release();
  const intent = await waitFor(
    () => {
      const [found] = intentsOf(fx.home, row.id);
      return ['invalidated', 'done'].includes(found.status) ? found : undefined;
    },
    { what: 'the held effect intent to settle' },
  );
  assert.deepEqual([intent.status, intent.invalidated_reason], ['invalidated', CODES.intent_invalidated], 'an effect whose precondition changed is invalidated, not executed');
  assert.equal(intentsOf(fx.home, row.id).length, 1, 'and no second intent is recorded for the consumed decision');
  return intent;
}

// The held effect ran: its intent is done.
export async function assertEffectDone(fx, row, held) {
  const res = await held.release();
  assert.equal(res.status, 200, `the answer was accepted (body: ${res.text})`);
  return waitFor(
    () => {
      const [found] = intentsOf(fx.home, row.id);
      assert.notEqual(found.status, 'invalidated', `the effect was invalidated: ${found.invalidated_reason}`);
      return found.status === 'done' ? found : undefined;
    },
    { what: 'the held effect to be done' },
  );
}

// ---- the scripted notification sink (SEAM.md §82) --------------------------------------------

const SINK = join(dirname(fileURLToPath(import.meta.url)), 'scripted', 'notify.mjs');

// Put the sink program into the fixture's scripted directory and say how it
// behaves: `deliver` is 'ok', 'fail' or 'unknown'; `lookup` is 'ok' or 'unknown'.
export function installSink(fx, behaviour = {}) {
  copyFileSync(SINK, join(fx.scripted.dir, 'notify.mjs'));
  sinkBehaviour(fx, behaviour);
}

export function sinkBehaviour(fx, { deliver = 'ok', lookup = 'ok' } = {}) {
  const file = join(fx.scripted.dir, 'notify.json');
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ deliver, lookup })}\n`);
  renameSync(`${file}.tmp`, file);
}

// Everything the sink program logged, in order: {event: 'deliver' | 'lookup', key, decision, outcome}.
export function sinkLog(fx) {
  const file = join(fx.scripted.dir, 'notifications.jsonl');
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

export const notificationIntents = (home, project) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "notification_intents" WHERE "project" = ? ORDER BY rowid').all(project)).map((row) => ({ ...row, source: json(row.source) }));
