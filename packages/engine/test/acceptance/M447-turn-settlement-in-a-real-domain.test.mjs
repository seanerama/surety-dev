// M447 (a), (c), (d), turn settlement in a real role domain (slice 33;
// SANDBOX lane: D2's launcher, the scripted backend, no model; the kernel
// half is `M447-turn-settlement-in-order`). M5 plan §3.3 M447; D6-S10; D6
// §2.1, §2.4; B01; D2 §1.4, §4.3; SEAM.md §§152, 389.
//   (a) in a real domain, `session.turn_settled` comes after the domain's
//       termination, the provider-files inventory (collection) and the
//       turn's ledger row; the idle generation advanced by one;
//   (c) usage unknown at settlement: `usage_status` `unknown`;
//   (d) the session's run stopped while its turn is held after the domain
//       terminated and before collection (`session.turn_settling.terminated`
//       †): no late reply appended, no late bytes materialized into the
//       workspace, one charge for the invocation, the turn not `replied`.
//
// SAFETY (BS5 §4.1; E64): the scripted role program in the test's own
// domains; the Stop is the engine's own route; nothing else signalled.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { stopRun, tick } from './harness/runs.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { step } from './harness/scripted.mjs';
import { ledgerRowsOf, openSession, postTurn, runRow, sayAndSettle, scriptTurns, transcriptEntries, turnResult, turnRows, turnThatWrites } from './harness/sessions.mjs';
import { withStore } from './harness/store.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitFor } from './harness/engine.mjs';
import { domainsOfRun, eventsOfRun, idleGeneration, invocationsOf, pauseAt, reached, release, sessionProject, settling } from './harness/session-lane.mjs';

const IDEA = '# Tally\n\nWritten by a turn the owner stopped.\n';
const recordsOfKind = (home, project, kind) => withStore(home, (db) => db.prepare('SELECT * FROM "records" WHERE "project" = ? AND "kind" = ? ORDER BY rowid').all(project, kind));

describe('M447 turn settlement in a real role domain', () => {
  test('(a) settled after the domain terminated, the inventory and the ledger row; the generation advanced by one; (c) usage unknown at settlement', async (t) => {
    const fx = await sandboxEngine(t);
    const p = await sessionProject(fx);
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, [{ steps: [step.result(turnResult({ reply: 'No usage.' }))] }]);
    const g0 = idleGeneration(fx.home, run.id);
    const done = await sayAndSettle(fx, p.id, run.id, 'Go.');
    assert.equal(idleGeneration(fx.home, run.id), g0 + 1, 'advanced by one');
    const [domain] = domainsOfRun(fx.home, run.id);
    assert.equal(domain.status, 'terminated', 'the domain terminated');
    const settled = eventsOfRun(fx.home, 'session.turn_settled', run.id);
    assert.equal(settled.length, 1, 'settled once');
    const inventory = recordsOfKind(fx.home, p.id, 'provider_files');
    assert.ok(inventory.length >= 1 && inventory.every((r) => r.created_at <= settled[0].at), 'the provider-files inventory before settlement');
    const [ledger] = ledgerRowsOf(fx.home, p.id, run.id);
    assert.ok(ledger && ledger.created_at <= settled[0].at, 'the ledger row before settlement');
    // (c)
    assert.equal(done.turn.usage_status, 'unknown', `usage unknown at settlement (${JSON.stringify(done.turn)})`);
  });

  test('(d) the run stopped after its turn\'s domain terminated and before collection: no late reply, no late bytes, one charge', async (t) => {
    const fx = await sandboxEngine(t);
    const p = await sessionProject(fx);
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, [turnThatWrites({ '.surety/idea.md': IDEA }, { reply: 'Written.' })]);
    await pauseAt(fx, settling('terminated'));
    await postTurn(fx, p.id, run.id, 'Write it.');
    void tick(fx.engine, p.id, { rounds: 1 }).catch(() => null);
    await reached(fx, settling('terminated'), 'the turn after its domain terminated');
    const stopping = stopRun(fx.engine, p.id, run.id).catch((err) => err);
    await release(fx, settling('terminated'));
    await stopping;
    await waitFor(() => (runRow(fx.home, run.id)?.state === 'ended' ? true : undefined), { what: 'the session run to end', timeoutMs: 120_000 });
    const [turn] = turnRows(fx.home, run.id);
    assert.notEqual(turn.outcome, 'replied', `the turn not replied (${JSON.stringify(turn)})`);
    assert.deepEqual(transcriptEntries(fx.home, run.id).filter((e) => e.speaker === 'role'), [], 'no late reply appended');
    const ws = withStore(fx.home, (db) => db.prepare('SELECT * FROM "workspaces" WHERE "id" = ?').get(runRow(fx.home, run.id).workspace));
    const written = (() => {
      try {
        return readFileSync(join(ws.path, '.surety/idea.md'), 'utf8');
      } catch {
        return null;
      }
    })();
    assert.notEqual(written, IDEA, 'no late bytes materialized into the workspace');
    const [invocation] = invocationsOf(fx.home, run.id);
    assert.equal(ledgerRowsOf(fx.home, p.id, run.id).filter((r) => r.invocation === invocation.id && r.corrects === null).length, 1, 'one charge for the invocation');
  });
});
