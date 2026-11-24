// Developer tests for the engine's serving check proposed for a service
// that explicitly declares `serving {root, entry}` (DECISIONS item 41; the
// owner's ruling of 2026-11-24: "When a service explicitly declares
// serving: {root, entry}, use the existing engine-authored proposal flow if
// the serving check is absent. Reuse a present or pending check so repeat
// configuration creates no duplicate approval. Keep the service's
// behavioral check required ... Services that omit serving retain today's
// behavior."): the same engine-authored proposal as a static configuration's
// (proposed_by engine, no run, no check_authoring work, a tightening adding
// surety-static-serving), its rationale saying what it verifies for a
// service; reused while present or pending; none for a service omitting
// serving, the answer saying why; post_deploy_behavior still required.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertRefused } from '../acceptance/harness/fixtures.mjs';
import { sharedFixture } from '../acceptance/harness/gates.mjs';
import { scriptedEngine, tickUntil } from '../acceptance/harness/runs.mjs';
import { withStore } from '../acceptance/harness/store.mjs';
import { def, defPath } from '../acceptance/harness/checks/scope.mjs';
import { recordFile, recordRow } from '../acceptance/harness/records.mjs';
import { DEPLOY_DEFS, configContent, deployable, putConfig, requestDeployment } from '../acceptance/harness/deploy/kernel.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { servingRationale, SERVING_CHECK_KEY } = await import(join(dist, 'deploy', 'serving-install.js'));

const SERVE = def('post_deploy_serving', { gates: ['alpha_complete'], requires: ['environment', 'artifact_digest'], command: ['surety-static-serving'], inputs: [] });
const PUBLIC = Object.freeze({
  'public/index.html': '<!doctype html><link rel="stylesheet" href="app.css"><p>Lap Lab</p>\n',
  'public/app.css': 'p { color: teal; }\n',
});
// The project's own checks list their inputs file by file, so adding the
// engine's definition changes none of them (as static-serving-check's case).
const OWN = Object.freeze({ acc: { ...DEPLOY_DEFS.acc, inputs: [defPath('acc')] }, smoke: { ...DEPLOY_DEFS.smoke, inputs: [defPath('smoke')] }, behaves: { ...DEPLOY_DEFS.behaves, inputs: [defPath('behaves')] } });

const engineProposals = (home, project) => withStore(home, (db) => db.prepare(`SELECT * FROM "protected_proposals" WHERE "project" = ? AND "proposed_by" = 'engine'`).all(project));
const authoringWork = (home, project) => withStore(home, (db) => db.prepare(`SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = 'check_authoring'`).all(project));
const rationaleText = (home, id) => readFileSync(recordFile(home, recordRow(home, id)), 'utf8');

// ---- the rationale --------------------------------------------------------------------------

test('the rationale: a service\'s names its declared root and entry, the bytes served against the sealed artifact, and the behavioural check still required; never static mode', () => {
  const text = servingRationale('alpha', { mode: 'service', root: 'public', entry: 'index.html' });
  assert.match(text, /environment alpha's service configuration declares serving \{root: "public", entry: "index\.html"\}/);
  assert.match(text, /verifies the bytes served from the declared root against the sealed artifact/);
  assert.match(text, /post_deploy_behavior check stays required/);
  assert.match(text, /never meets that requirement/);
  assert.match(text, /No Verifier wrote it\./);
  assert.doesNotMatch(text, /static mode|static site/);
  assert.ok(text.includes(SERVING_CHECK_KEY));
});

test('the rationale: a static configuration\'s as before', () => {
  const text = servingRationale('alpha', { mode: 'static', root: '.', entry: 'index.html' });
  assert.match(text, /because environment alpha is configured in static mode\. /);
  assert.match(text, /deployment-specific post-deploy requirement of a static site's alpha_complete scope, recorded as serving verified/);
  assert.doesNotMatch(text, /declares serving/);
});

// ---- through the engine's API on the kernel lane --------------------------------------------

describe('the serving check proposed for a service declaring serving, on the kernel lane', () => {
  const shared = sharedFixture();
  let fx;
  before(async () => {
    fx = await scriptedEngine(shared.context);
  });
  after(() => shared.cleanup());

  test('a service declaring serving with no serving check: the engine proposes it (engine, no run, tightening), the answer names it; another configuration finds it pending', async () => {
    const ctx = await deployable(fx, { files: PUBLIC, defs: OWN, config: { serving: { root: 'public' } }, name: 'alpha' });
    const proposals = engineProposals(fx.home, ctx.project);
    assert.equal(proposals.length, 1, 'one proposal of the engine\'s');
    const [proposal] = proposals;
    assert.deepEqual([proposal.proposed_by, proposal.run, proposal.requested_change_kind], ['engine', null, 'tightening']);
    const event = withStore(fx.home, (db) => db.prepare(`SELECT "payload" FROM "events" WHERE "type" = 'protected.proposed' AND json_extract("subject", '$.proposal') = ?`).get(proposal.id));
    assert.deepEqual([JSON.parse(event.payload).proposed_by, JSON.parse(event.payload).engine_authored], ['engine', 'post_deploy_serving']);
    const why = rationaleText(fx.home, proposal.rationale);
    assert.match(why, /environment alpha's service configuration declares serving \{root: "public", entry: "index\.html"\}/);
    assert.match(why, /bytes served from the declared root against the sealed artifact/);
    assert.doesNotMatch(why, /static mode/);
    assert.deepEqual(authoringWork(fx.home, ctx.project), [], 'no Verifier check_authoring for the engine\'s own check');

    // The configuration's answer named it: written again under another
    // environment, and the same environment with other content, it is pending.
    const beta = await putConfig(fx.engine, ctx.project, 'beta', configContent({ port: 8081, serving: { root: 'public' } }));
    assert.equal(beta.status, 201, beta.text);
    assert.deepEqual(beta.body.serving_check, { kind: 'post_deploy_serving', proposal: null, state: 'pending', reason: null });
    const alpha2 = await putConfig(fx.engine, ctx.project, 'alpha', configContent({ serving: { root: 'public', entry: 'app.css' } }));
    assert.equal(alpha2.status, 201, alpha2.text);
    assert.equal(alpha2.body.serving_check.state, 'pending');
    assert.equal(engineProposals(fx.home, ctx.project).length, 1, 'no second proposal');

    // From here any proposal: classified a tightening adding the check.
    const classified = await tickUntil(fx.engine, ctx.project, () => {
      const p = withStore(fx.home, (db) => db.prepare('SELECT * FROM "protected_proposals" WHERE "id" = ?').get(proposal.id));
      return p.classified_change_kind !== null ? p : undefined;
    }, { max: 8, what: 'the engine\'s proposal classified' });
    assert.equal(classified.classified_change_kind, 'tightening', classified.classification);
    assert.deepEqual(JSON.parse(classified.classification).elements, [{ reason: 'check_added', check: SERVING_CHECK_KEY }]);
    assert.equal(engineProposals(fx.home, ctx.project).length, 1, 'still one');
  });

  test('the answer names the proposal it captured', async () => {
    const ctx = await deployable(fx, { files: PUBLIC, defs: OWN, name: 'alpha' });
    assert.deepEqual(engineProposals(fx.home, ctx.project), [], 'a service omitting serving: nothing proposed');
    const res = await putConfig(fx.engine, ctx.project, 'beta', configContent({ port: 8081, serving: {} }));
    assert.equal(res.status, 201, res.text);
    const [proposal] = engineProposals(fx.home, ctx.project);
    assert.ok(proposal, 'an empty serving is a declared serving (root "." and entry index.html)');
    assert.deepEqual(res.body.serving_check, { kind: 'post_deploy_serving', proposal: proposal.id, state: 'proposed', reason: null });
  });

  test('a service declaring serving whose project has the serving check: present, nothing proposed', async () => {
    const ctx = await deployable(fx, { files: PUBLIC, defs: { ...OWN, serve: SERVE }, config: { serving: { root: 'public' } }, name: 'alpha' });
    assert.deepEqual(engineProposals(fx.home, ctx.project), []);
    const res = await putConfig(fx.engine, ctx.project, 'beta', configContent({ port: 8081, serving: { root: 'public' } }));
    assert.deepEqual(res.body.serving_check, { kind: 'post_deploy_serving', proposal: null, state: 'present', reason: null });
    assert.deepEqual(engineProposals(fx.home, ctx.project), []);
  });

  test('a service omitting serving: no proposal; the answer says why (not_proposed)', async () => {
    const ctx = await deployable(fx, { files: PUBLIC, defs: OWN, name: 'alpha' });
    const res = await putConfig(fx.engine, ctx.project, 'beta', configContent({ port: 8081 }));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.serving_check.state, 'not_proposed');
    assert.equal(res.body.serving_check.proposal, null);
    assert.match(res.body.serving_check.reason, /declares no serving root and entry/);
    assert.deepEqual(engineProposals(fx.home, ctx.project), []);
  });

  test('a service declaring serving with only a serving check: still ACCEPTANCE_SCOPE_INCOMPLETE kind:post_deploy_behavior', async () => {
    const ctx = await deployable(fx, { files: PUBLIC, defs: { acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke, serve: SERVE }, config: { serving: { root: 'public' } }, name: 'alpha' });
    const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'alpha');
    assertRefused(res, 409, 'authorization_not_issued', 'the request');
    const incomplete = res.body.subject.reasons.filter((r) => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE').flatMap((r) => r.subjects);
    assert.deepEqual(incomplete, ['kind:post_deploy_behavior']);
  });
});
