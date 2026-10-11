// M342's free half: `surety deploy`, the command Sean runs in the real
// journey (M4 slice 30; kernel lane, no model, nothing paid; manifest slice
// 30). M4 plan §3.8 M342 (c) ("Sean's `surety qualify-adapter
// local_service` and `surety deploy`"); D4 §1 item 4 ("`surety deploy c-12
// --env alpha`", Q3), A.8 (CLI: `surety deploy`); E121 item 4 (question 6:
// Sean runs both himself); SEAM.md §334.
//
// The real row asks Sean to request the deployment with the command; as
// built the CLI has `qualify-adapter` and `env`, and no `deploy`. What the
// command must be can be held without a model, on the scripted adapter: the
// client of `POST /v1/projects/:p/deployments` (SEAM.md §246), with the
// engine's token and `SURETY_HOME`, as `surety env` and `surety
// qualify-adapter` are (§§313, 322):
//   surety deploy <candidate> --env <environment> --project <project>
// (a) a satisfied request: exit 0, the answer's JSON on one line of standard
//     output naming the issued authorization and the deploy work item; the
//     command again while the deployment is pending: the same authorization
//     and work item, nothing more created (J3's coalescing, through the CLI);
// (b) a refusal is printed as the engine answered it (status and body on
//     standard error) with exit 1, and a usage error (no `--env`) exits 2
//     before anything is asked; neither creates anything.
//
// SAFETY: kernel lane; the scripted adapter's admission is held, so nothing
// deploys; no unit, no process signalled.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';

import { CLI } from './harness/engine.mjs';
import { authorizationsOf } from './harness/gates.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { deployWork, deployable, setAdmission } from './harness/deploy/kernel.mjs';

function surety(fx, args) {
  const done = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, SURETY_HOME: fx.home } });
  let body;
  try {
    body = JSON.parse(done.stdout);
  } catch {
    body = undefined;
  }
  return { status: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '', body };
}

describe('M342 the deploy command (kernel lane, no model)', () => {
  test('(a) surety deploy <candidate> --env <environment> --project <project>: exit 0, the issued authorization and the deploy work item on one JSON line; again while pending, the same ones and nothing more', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    // Admission held (SEAM.md §247): the deployment stays pending whatever ticks run.
    await setAdmission(fx.engine, ctx.env.id, 'held');
    const first = surety(fx, ['deploy', ctx.candidate.id, '--env', ctx.env.name, '--project', ctx.project]);
    assert.equal(first.status, 0, `surety deploy exits 0 on a satisfied request (stdout ${first.stdout.slice(0, 600)}; stderr ${first.stderr.slice(0, 600)})`);
    assert.equal(first.stdout.trim().split('\n').length, 1, 'one line of JSON on standard output');
    assert.equal(first.body?.authorization?.status, 'issued', `the answer names the issued authorization (${first.stdout.slice(0, 400)})`);
    assert.match(first.body?.work_item?.id ?? '', /^wi_/, 'and the deploy work item');
    const [row] = authorizationsOf(fx.home, ctx.candidate.id);
    assert.deepEqual([row?.id, row?.status, row?.environment], [first.body.authorization.id, 'issued', ctx.env.id], 'the store holds that authorization, for the environment named');
    assert.deepEqual(deployWork(fx.home, ctx.project).map((w) => w.id), [first.body.work_item.id], 'and that one deploy work item');

    const again = surety(fx, ['deploy', ctx.candidate.id, '--env', ctx.env.name, '--project', ctx.project]);
    assert.equal(again.status, 0, `the command again while pending exits 0 (stderr ${again.stderr.slice(0, 400)})`);
    assert.deepEqual([again.body?.authorization?.id, again.body?.work_item?.id], [first.body.authorization.id, first.body.work_item.id], 'with the same authorization and work item (J3: coalesced)');
    assert.equal(authorizationsOf(fx.home, ctx.candidate.id).length, 1, 'one authorization');
    assert.equal(deployWork(fx.home, ctx.project).length, 1, 'one deploy work item');
  });

  test('(b) a refusal: the engine\'s status and body on standard error, exit 1; a usage error (no --env): exit 2, nothing asked; neither creates anything', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await setAdmission(fx.engine, ctx.env.id, 'held');
    const unknown = surety(fx, ['deploy', 'cand_01ZZZZZZZZZZZZZZZZZZZZZZZZ', '--env', ctx.env.name, '--project', ctx.project]);
    assert.equal(unknown.status, 1, `a candidate that is not the project's: exit 1 (stdout ${unknown.stdout.slice(0, 300)}; stderr ${unknown.stderr.slice(0, 300)})`);
    assert.match(unknown.stderr, /^4\d\d /, 'the refusal printed with the engine\'s status first, on standard error');
    assert.equal(unknown.stdout, '', 'nothing on standard output');
    const usage = surety(fx, ['deploy', ctx.candidate.id, '--project', ctx.project]);
    assert.equal(usage.status, 2, `no --env: a usage error, exit 2 (stderr ${usage.stderr.slice(0, 300)})`);
    assert.deepEqual(authorizationsOf(fx.home, ctx.candidate.id), [], 'no authorization was written');
    assert.deepEqual(deployWork(fx.home, ctx.project), [], 'no deploy work item');
  });
});
