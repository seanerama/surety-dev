// M542, the run's observed model (M6 slice 39, the corrections carried from
// M5; kernel lane, the scripted backend). M6 plan §3.1 M542; E154 item 6
// (1); E156 Q1; BS6 §11.3; D6 §7.6; M441; M5 report §18 ("`runs.
// model_observed` is never set, so the pace read reports `unknown` although
// the ledger records the model"); SEAM.md §474.
//   (a) a one-shot run whose invocation's ledger row records
//       `model_observed`: `runs.model_observed` set from the ledger in the
//       transaction that records the usage (no read of the store ever sees
//       the run's ledger row with the run's model unset);
//   (b) a session whose turns' ledger rows record it: the run's figure the
//       model every turn observed; where the turns differ, the run's figure
//       names each model observed and the read lists the model per turn,
//       never the requested model in place of an observed one;
//   (c) an invocation that recorded no observed model: `unknown`, never the
//       requested model;
//   (d) the pace read for each: the recorded value, or `unknown` with its
//       reason.
// The pins (SEAM.md §474): `runs.model_observed` holds the one model every
// invocation of the run observed; where its invocations observed more than
// one, the distinct models in the order first observed, joined by `,` (the
// form the ledger's readers already split, store/transitions/
// qualification.ts); the pace read's `runs[].model` is that value, or
// `{unknown: <reason>}`; a session run's entry carries `model_per_turn` †,
// [{turn, model}] in turn order, each a model or `{unknown: <reason>}`.
// The observed models are names no backend requests, so an observed model
// is never mistaken for the requested one.
//
// Limit of the instrument: "in the same transaction" is observed from
// outside as a store watched every few milliseconds from the run's launch to
// its end, each read one statement (one snapshot); a later transaction is
// caught only if a read falls between the two.
//
// SAFETY (BS6 §4.1; E64): kernel lane; no domain, no unit; the test signals
// nothing; every home is the harness's own, at most 56 bytes.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { addGitProject } from './harness/gitruns.mjs';
import { createWithIdea, readPace } from './harness/journey/drive.mjs';
import { addWork, runsOf, scriptedEngine, tick, waitForWork } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { ledgerRowsOf, openSession, runRow, sayAndSettle, scriptTurns, turnResult } from './harness/sessions.mjs';
import { withStore } from './harness/store.mjs';
import { isUnknown, show, sleep } from './harness/exec37/pace.mjs';

const MODEL_A = 'observed-model-m542-a';
const MODEL_B = 'observed-model-m542-b';
const USAGE = (model) => ({ input_tokens: 120, cache_read_tokens: 30, output_tokens: 40, ...(model ? { model } : {}) });

const paceRun = (pace, id) => pace.runs.find((r) => r.id === id);
const ledgerOfRun = (home, run) => withStore(home, (db) => db.prepare('SELECT * FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL ORDER BY rowid').all(run));

// Every few milliseconds until `stop()`: one statement per read, so each is
// one snapshot of the store: the run's model beside whether a ledger row of
// it exists. Returns the reads that saw a ledger row with the model unset.
function watchRun(home, workItem) {
  const torn = [];
  let reads = 0;
  let done = false;
  const loop = (async () => {
    while (!done) {
      try {
        const rows = withStore(home, (db) =>
          db
            .prepare(
              `SELECT r."id" AS "run", r."model_observed" AS "model", (SELECT COUNT(*) FROM "ledger_rows" l WHERE l."run" = r."id" AND l."corrects" IS NULL) AS "ledger"
               FROM "runs" r WHERE r."work_item" = ?`,
            )
            .all(workItem),
        );
        reads++;
        for (const r of rows) if (r.ledger > 0 && r.model === null) torn.push(r);
      } catch {
        // The store busy for a moment: no read, nothing concluded.
      }
      await sleep(3);
    }
  })();
  return {
    async stop() {
      done = true;
      await loop;
      return { torn, reads };
    },
  };
}

describe('M542 (a), (c), (d) a one-shot run: the model its invocation observed, or unknown', () => {
  test('(a), (d) a one-shot run whose ledger row records model_observed: runs.model_observed set from the ledger in the transaction that records the usage; the pace read shows it', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addWork(fx.engine, project.id, 'verification');
    fx.scripted.script(item, { steps: [step.usage(USAGE(MODEL_A)), step.result()] });
    const watch = watchRun(fx.home, item);
    await tick(fx.engine, project.id);
    await waitForWork(fx.home, item, 'complete');
    const { torn, reads } = await watch.stop();
    const run = runsOf(fx.home, item)[0];
    const ledger = ledgerOfRun(fx.home, run.id);
    assert.equal(ledger.length, 1, `the fixture is live: one ledger row for the run (${show(ledger)})`);
    assert.equal(ledger[0].model_observed, MODEL_A, `the fixture is live: the ledger row records the model observed (${show(ledger[0])})`);
    assert.notEqual(ledger[0].model_requested, MODEL_A, 'the fixture is live: the observed model is not the requested one');
    assert.equal(runRow(fx.home, run.id).model_observed, MODEL_A, `runs.model_observed is the model the ledger observed (${show(runRow(fx.home, run.id).model_observed)})`);
    assert.ok(reads > 0, 'the store was read while the run ran');
    assert.deepEqual(torn, [], `no read saw the run's ledger row with runs.model_observed unset (in ${reads} reads): set in the transaction that records the usage`);
    // (d)
    const figure = paceRun(await readPace(fx, project.id), run.id);
    assert.ok(figure, 'the run is in the pace read');
    assert.equal(figure.model, MODEL_A, `the pace read shows the recorded model (${show(figure.model)})`);
  });

  test('(c), (d) an invocation that recorded no observed model: unknown with its reason, never the requested model', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addWork(fx.engine, project.id, 'verification');
    fx.scripted.script(item, { steps: [step.usage(USAGE(null)), step.result()] });
    await tick(fx.engine, project.id);
    await waitForWork(fx.home, item, 'complete');
    const run = runsOf(fx.home, item)[0];
    const ledger = ledgerOfRun(fx.home, run.id);
    assert.equal(ledger.length, 1, `the fixture is live: one ledger row for the run (${show(ledger)})`);
    assert.equal(ledger[0].model_observed, null, 'the fixture is live: the ledger row observed no model');
    const requested = ledger[0].model_requested;
    assert.equal(runRow(fx.home, run.id).model_observed, null, 'runs.model_observed stays unset: never the requested model');
    const figure = paceRun(await readPace(fx, project.id), run.id);
    assert.ok(isUnknown(figure?.model), `the pace read's model is unknown with its reason (${show(figure?.model)})`);
    assert.ok(figure.model.unknown.length > 0, 'the reason is stated');
    assert.notEqual(figure.model, requested, 'never the requested model');
  });
});

describe('M542 (b), (d) a session: the model its turns observed', () => {
  const turn = (model, reply) => ({ steps: [step.usage(USAGE(model)), step.result(turnResult({ reply }))] });

  async function sessionOf(t, models) {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, models.map((m, i) => turn(m, `Turn ${i + 1}.`)));
    for (let i = 0; i < models.length; i++) await sayAndSettle(fx, p.id, run.id, `Owner ${i + 1}.`);
    const ledger = ledgerRowsOf(fx.home, p.id, run.id);
    assert.deepEqual(ledger.map((l) => l.model_observed), models, `the fixture is live: each turn's ledger row records its model (${show(ledger.map((l) => [l.turn, l.model_observed, l.model_requested]))})`);
    for (const l of ledger) assert.ok(!models.includes(l.model_requested), `the fixture is live: no observed model is the requested one (${l.model_requested})`);
    return { fx, p, run, ledger };
  }

  test('(b), (d) every turn observed one model: the run\'s figure is that model, in the store and the pace read, per turn too', async (t) => {
    const { fx, p, run } = await sessionOf(t, [MODEL_A, MODEL_A]);
    assert.equal(runRow(fx.home, run.id).model_observed, MODEL_A, `runs.model_observed is the model every turn observed (${show(runRow(fx.home, run.id).model_observed)})`);
    const figure = paceRun(await readPace(fx, p.id), run.id);
    assert.equal(figure?.model, MODEL_A, `the pace read shows it (${show(figure?.model)})`);
    assert.deepEqual(
      (figure.model_per_turn ?? []).map((x) => [x.turn, x.model]),
      [
        [1, MODEL_A],
        [2, MODEL_A],
      ],
      `model_per_turn † lists each turn's model in turn order (${show(figure.model_per_turn)})`,
    );
  });

  test('(b), (d) the turns observed different models: the run\'s figure names each, per turn in the read, never the requested model', async (t) => {
    const { fx, p, run, ledger } = await sessionOf(t, [MODEL_A, MODEL_B]);
    const requested = ledger[0].model_requested;
    assert.equal(runRow(fx.home, run.id).model_observed, `${MODEL_A},${MODEL_B}`, `runs.model_observed names each model observed, in the order first observed (${show(runRow(fx.home, run.id).model_observed)})`);
    const figure = paceRun(await readPace(fx, p.id), run.id);
    assert.equal(figure?.model, `${MODEL_A},${MODEL_B}`, `the pace read's run figure names each (${show(figure?.model)})`);
    assert.deepEqual(
      (figure.model_per_turn ?? []).map((x) => [x.turn, x.model]),
      [
        [1, MODEL_A],
        [2, MODEL_B],
      ],
      `model_per_turn † gives each turn's model where they differ (${show(figure.model_per_turn)})`,
    );
    assert.ok(!show(figure.model).includes(requested) && !show(figure.model_per_turn).includes(requested), `never the requested model ${requested} in place of an observed one`);
  });
});
