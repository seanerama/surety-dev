// M452, retrofit mode rules at approval (slice 32; kernel lane). M5 plan
// §3.2 M452; D6-R09; D6 §8.1 step 2; B10; K10; SEAM.md §384.
//   (a) `full` mode: one produced requirement unanswered, and one confirmed
//       with no criteria: `approve` refused, naming the requirement; one
//       answered `defect` and every other confirmed with criteria: `approve`
//       open (the defect an explicit pending obligation scheduled later);
//   (b) `scoped` mode with criterion-less descriptive requirements left
//       unanswered: `approve` open; those requirements
//       `descriptive_unverified`, shown pending with their mark;
//   (c) every module classified in both modes (and a save dropping one
//       refused: M412 (d));
//   (d) the generic approval check never excludes silently: the same
//       specification is blocked in `full` and open in `scoped`, by the
//       engine's `adoption_mode` and not by any label the role wrote.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, decisionsOfKind } from './harness/decisions.mjs';
import { modulesOf, readSpec, requirementsOf } from './harness/journey/drive.mjs';
import { adoptProject, chooseMode, confirmAndApprove, retrofitEngine, retrofitSpecSession } from './harness/retrofit/drive.mjs';
import { REQUIREMENTS, retrofitSpecText } from './harness/retrofit/products.mjs';

// The open `spec_approval` (its latest generation) answered `approve`.
async function tryApprove(fx, project) {
  const open = decisionsOfKind(fx.home, project, 'spec_approval').filter((d) => d.status === 'open');
  assert.ok(open.length > 0, 'an open spec_approval');
  return answer(fx.engine, project, open.at(-1), 'approve');
}
const descriptiveService = REQUIREMENTS.map((r) => (r.module === 'service' ? { ...r, descriptive: true } : r));

async function adoptedWith(t, mode, spec) {
  const fx = await retrofitEngine(t);
  const p = await adoptProject(fx);
  await chooseMode(fx, p.id, mode);
  const s = await retrofitSpecSession(fx, p.id, { spec });
  return { fx, p, s };
}

describe('M452 retrofit mode rules at approval', () => {
  test('(a) full: an unanswered requirement blocks approve, named; answered (one defect), approve is open', async (t) => {
    const { fx, p } = await adoptedWith(t, 'full', retrofitSpecText());
    await confirmAndApprove(fx, p.id, { R1: 'confirm', R3: 'confirm', R4: 'defect' }, { approve: false });
    const blocked = await tryApprove(fx, p.id);
    assert.equal(blocked.status, 409, `approve refused while R2 is unanswered (→ ${blocked.status} ${blocked.text})`);
    assert.match(JSON.stringify(blocked.body), /R2/, 'naming R2');
    await confirmAndApprove(fx, p.id, { R2: 'confirm' }, { approve: false });
    const open = await tryApprove(fx, p.id);
    assert.equal(open.status, 200, `every requirement answered, one a defect: approve accepted (→ ${open.status} ${open.text})`);
    const r4 = requirementsOf(fx.home, p.id).find((r) => r.key === 'R4');
    assert.deepEqual([r4.status, Boolean(r4.defect)], ['pending', true], 'the defect an explicit pending obligation');
  });

  test('(a) full: a requirement confirmed with no criteria blocks approve, named', async (t) => {
    const requirements = REQUIREMENTS.map((r) => (r.key === 'R3' ? { ...r, descriptive: true } : r));
    const { fx, p } = await adoptedWith(t, 'full', retrofitSpecText({ requirements }));
    await confirmAndApprove(fx, p.id, { R1: 'confirm', R2: 'confirm', R3: 'confirm', R4: 'defect' }, { approve: false });
    const blocked = await tryApprove(fx, p.id);
    assert.equal(blocked.status, 409, `approve refused while R3 has no criteria (→ ${blocked.status} ${blocked.text})`);
    assert.match(JSON.stringify(blocked.body), /R3/, 'naming R3');
  });

  test('(b) scoped: descriptive requirements left unanswered, approve open; they are descriptive_unverified and shown pending with the mark; (c) every module classified', async (t) => {
    const { fx, p } = await adoptedWith(t, 'scoped', retrofitSpecText({ requirements: descriptiveService }));
    await confirmAndApprove(fx, p.id, { R1: 'confirm' }, { approve: false });
    const open = await tryApprove(fx, p.id);
    assert.equal(open.status, 200, `scoped: approve accepted with the descriptive requirements unanswered (→ ${open.status} ${open.text})`);
    const by = Object.fromEntries(requirementsOf(fx.home, p.id).map((r) => [r.key, r]));
    for (const key of ['R2', 'R3', 'R4']) assert.equal(by[key].status, 'descriptive_unverified', `${key} descriptive_unverified`);
    assert.equal(by.R1.status, 'pending', 'R1 confirmed with criteria: pending');
    const spec = await readSpec(fx, p.id);
    for (const key of ['R2', 'R3', 'R4']) assert.equal(spec.requirements.find((r) => r.key === key)?.status, 'descriptive_unverified', `the spec read shows ${key} with its mark`);
    assert.deepEqual(modulesOf(fx.home, p.id).map((m) => [m.name, Array.isArray(m.sensitive_areas)]), [['lib', true], ['service', true]], 'every module classified in scoped mode');
  });

  test('(d) the same specification is blocked in full and open in scoped: the engine\'s adoption_mode decides, not the role\'s labels', async (t) => {
    const spec = retrofitSpecText({ requirements: descriptiveService });
    const full = await adoptedWith(t, 'full', spec);
    await confirmAndApprove(full.fx, full.p.id, { R1: 'confirm' }, { approve: false });
    const blocked = await tryApprove(full.fx, full.p.id);
    assert.equal(blocked.status, 409, `full: refused (→ ${blocked.status} ${blocked.text})`);
    for (const key of ['R2', 'R3', 'R4']) assert.match(JSON.stringify(blocked.body), new RegExp(key), `full: the refusal names ${key}, never a silent exclusion`);
    const scoped = await adoptedWith(t, 'scoped', spec);
    await confirmAndApprove(scoped.fx, scoped.p.id, { R1: 'confirm' }, { approve: false });
    const open = await tryApprove(scoped.fx, scoped.p.id);
    assert.equal(open.status, 200, `scoped: accepted (→ ${open.status} ${open.text})`);
  });
});
