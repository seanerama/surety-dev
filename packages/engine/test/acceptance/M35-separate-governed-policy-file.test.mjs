// M35, the separate governed policy file (slice 5). Plan §3.4 M35; RN R2;
// build spec §6 correction 3; D1 §§2.4, 5.2, 7.9, D1-12, D1-35; Review B19;
// F §5.2; SEAM.md §§65, 67.
//
// The governed settings (the protected roots, check commands, the required
// set) live in `.surety/checks/protected-policy.json`, inside the protected
// roots. `.surety/policy.json` holds only ungoverned settings. The protected
// fingerprint is SHA-256 over the sorted (path, blob id) list of the
// protected roots, with no projection of any field. So an ordinary setting
// leaves the fingerprint alone; a governed one changes it and takes the
// protected route; a roots change is judged by the roots that are
// authorized, not by the ones it proposes; and a protected set nobody
// authorized blocks the gates of a candidate that holds it.
//
// The last case is the slice-5 review's finding (E41 item 2): a protected
// set that could not be read is not an authorized one. The engine the review
// ran skipped the question when the repository did not answer, and the stage
// gate of a candidate whose head held an unauthorized set was satisfied.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { decisionsOfKind } from './harness/decisions.mjs';
import { GOVERNED_FILE, alphaTarget, authorizationsOf, check, effectiveVersion, installChecks, nominated, passAll, proposalsOf, protectedFingerprint, protectedVersions, reasonCodes, stageGate } from './harness/gates.mjs';
import { addGitProject, addItem, roleThat, runToEnd } from './harness/gitruns.mjs';
import { acceptanceState, assertNothingAccepted, changePolicy, eventsOfType, getPolicy, outOfBand } from './harness/journal.mjs';
import { changedPaths, commitOnRef, fileAt, holdGit, refOid } from './harness/repos.mjs';
import { answerDecision, scriptedEngine, tick, workItem } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

const GOVERNED = { protected_paths: ['.surety/checks/'], check_commands: { login: ['node', '.surety/checks/login.mjs'] }, required_checks: ['login'] };
const protectedFiles = (governed = GOVERNED) => ({ [GOVERNED_FILE]: `${JSON.stringify(governed, null, 2)}\n`, '.surety/checks/login.check.json': '{"expect": 200}\n' });

// What makes a protected version the one it is. (Its check set is declared by a fixture and is not part of this.)
const identity = (version) => ({ id: version.id, seq: version.seq, fingerprint: version.fingerprint, authorized: version.authorized });

// A human edit of a governed field through the policy route: answered 202
// with the proposal it became. Returns the proposal's row.
async function governedEdit(fx, project, change) {
  const res = await fx.engine.post(`/v1/projects/${project.id}/policy`, change);
  assert.equal(res.status, 202, `a governed field takes the protected route (body: ${res.text})`);
  const proposals = proposalsOf(fx.home, project.id);
  assert.deepEqual(proposals.map((row) => row.id), [res.body?.proposal?.id], `the response names the proposal the edit became (body: ${res.text})`);
  return proposals[0];
}

// Nothing was applied: the branch, the effective version and the ordinary policy are where they were.
async function assertNotApplied(fx, project, authorized) {
  assert.equal(refOid(project.repo.path, project.repo.ref), project.base, 'nothing was committed to the integration branch');
  assert.deepEqual(identity(effectiveVersion(fx.home, project.id)), identity(authorized), 'the effective protected version is the authorized one, unchanged');
  assert.equal(protectedVersions(fx.home, project.id).length, 1, 'no further protected version was recorded');
  assert.equal((await getPolicy(fx.engine, project.id)).revision, null, 'no policy revision was recorded');
  assert.equal(decisionsOfKind(fx.home, project.id, 'policy_widening').length, 0, 'and the edit is not offered for an ordinary policy confirmation');
}

describe('M35 the governed policy file is separate from the ordinary one', () => {
  test('an ordinary budget setting is committed to .surety/policy.json and leaves the protected fingerprint and the effective version as they were', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx, { files: protectedFiles() });
    const authorized = effectiveVersion(fx.home, project.id);
    assert.equal(authorized.fingerprint, protectedFingerprint(project.repo.path, project.base), 'the fingerprint is SHA-256 over the sorted (path, blob id) list of the protected roots');

    await changePolicy(fx.engine, project.id, { budget_run_billable_tokens: 500_000 });
    const head = refOid(project.repo.path, project.repo.ref);
    assert.deepEqual(changedPaths(project.repo.path, project.base, head), { '.surety/policy.json': 'A' }, 'the change is committed to the ordinary policy file and to nothing else');
    assert.equal(protectedFingerprint(project.repo.path, head), authorized.fingerprint, 'the protected fingerprint is what it was');
    assert.deepEqual(identity(effectiveVersion(fx.home, project.id)), identity(authorized), 'the effective protected version is unchanged');
    assert.equal(proposalsOf(fx.home, project.id).length, 0, 'and nothing was proposed');
  });

  for (const [field, value] of [
    ['check_commands', { login: ['sh', '-c', 'true'] }],
    ['required_checks', []],
  ]) {
    test(`a human edit of the governed field ${field} becomes a protected proposal and is not applied`, async (t) => {
      const fx = await scriptedEngine(t);
      const project = await addGitProject(fx, { files: protectedFiles() });
      const authorized = effectiveVersion(fx.home, project.id);

      const proposal = await governedEdit(fx, project, { [field]: value });
      assert.deepEqual([proposal.proposed_by, proposal.status, proposal.base_revision], ['human', 'captured', project.base], 'a proposal by a human, captured against the integration branch');
      assert.deepEqual(changedPaths(project.repo.path, project.base, proposal.tree_id), { [GOVERNED_FILE]: 'M' }, 'what it proposes is a change to the governed file');
      assert.deepEqual(JSON.parse(fileAt(project.repo.path, proposal.tree_id, GOVERNED_FILE)), { ...GOVERNED, [field]: value }, 'with the edited field and every other governed field as it was');
      assert.notEqual(protectedFingerprint(project.repo.path, proposal.tree_id), authorized.fingerprint, 'a governed change changes the protected fingerprint');
      await assertNotApplied(fx, project, authorized);
    });
  }

  test('a roots change that would take the governed file out of protection is itself a protected change, and while it is unapproved the authorized roots stay in force', async (t) => {
    const fx = await scriptedEngine(t);
    const roots = ['.surety/checks/', 'acceptance/'];
    const project = await addGitProject(fx, { files: { ...protectedFiles({ ...GOVERNED, protected_paths: roots }), 'acceptance/login.spec.json': '{"status": 200}\n' } });
    const authorized = effectiveVersion(fx.home, project.id);
    assert.equal(authorized.fingerprint, protectedFingerprint(project.repo.path, project.base, roots), 'the fixture is live: the authorized set covers both roots the governed file names');

    // The edit names roots that hold neither the governed file nor the acceptance directory.
    const proposal = await governedEdit(fx, project, { protected_paths: ['docs/'] });
    assert.deepEqual(changedPaths(project.repo.path, project.base, proposal.tree_id), { [GOVERNED_FILE]: 'M' }, 'its own delta is not hidden: the governed file is judged by the roots that are authorized');
    await assertNotApplied(fx, project, authorized);

    // A Builder now edits a file the proposed roots would no longer protect.
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([step.write('acceptance/login.spec.json', '{"status": 500}\n')])]);
    const before = acceptanceState(fx, project.id);
    const run = await runToEnd(fx, project.id, item);
    assertNothingAccepted(fx, run.id, before, { reason: 'diff_violation', pathInReason: 'acceptance/login.spec.json' });
    assert.deepEqual(identity(effectiveVersion(fx.home, project.id)), identity(authorized), 'the old authorized set was not bypassed');
  });

  test('a protected set that no authorized version covers blocks the gates of a candidate that holds it', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx, { tier: 'T1', files: protectedFiles() });
    const authorized = effectiveVersion(fx.home, project.id);
    // A developer loosens a check by hand on the integration branch, and a person adopts the commit.
    const stray = commitOnRef(project.repo.path, project.repo.ref, { '.surety/checks/login.check.json': '{"expect": "anything"}\n' }, { message: 'developer: an edit nobody approved' });
    await tick(fx.engine, project.id);
    const [observed] = outOfBand(fx.home, project.id);
    assert.ok(observed, 'the fixture is live: the commit was observed out of band');
    await answerDecision(fx.engine, project.id, observed.decision.id, 'adopt');
    await waitFor(() => outOfBand(fx.home, project.id)[0].disposition === 'adopt', { what: 'the adoption to be recorded' });

    // A stage is built on the adopted commit and nominated; its one required check passes.
    const ctx = await nominated(fx, { project });
    const checks = await installChecks(fx.engine, project.id, [check('login', { requirements: ['R1'] })]);
    await passAll(fx.engine, project.id, ctx.candidate.id, Object.values(checks.id));
    const evaluation = await stageGate(fx, ctx);
    assert.ok(reasonCodes(evaluation).includes('PROTECTED_PATH_UNAUTHORIZED'), `the gate is not satisfied, because the protected path is not authorized (reasons: ${reasonCodes(evaluation).join(', ')})`);
    assert.deepEqual(identity(effectiveVersion(fx.home, project.id)), identity(authorized), 'adopting the commit authorized nothing: the effective version is the one that was authorized');
    assert.notEqual(protectedFingerprint(project.repo.path, stray), authorized.fingerprint, 'the fixture is live: the adopted commit holds another protected set');
    assert.ok(eventsOfType(fx.home, 'protected.unauthorized_detected').length >= 1, 'the unauthorized set was reported');
  });

  test('a protected set that cannot be read is not an authorized one: with the repository not answering, the stage gate and the Alpha authorization of a candidate whose head holds an unauthorized set are not satisfied, nothing completes and nothing is issued', async (t) => {
    const fx = await scriptedEngine(t, { config: { git_deadline: 2 } });
    const project = await addGitProject(fx, { tier: 'T1', files: protectedFiles() });
    const authorized = effectiveVersion(fx.home, project.id);
    // As in the case above: a developer's edit of a check, adopted, and a candidate built on it whose one required check passes.
    const stray = commitOnRef(project.repo.path, project.repo.ref, { '.surety/checks/login.check.json': '{"expect": "anything"}\n' }, { message: 'developer: an edit nobody approved' });
    await tick(fx.engine, project.id);
    const [observed] = outOfBand(fx.home, project.id);
    assert.ok(observed, 'the fixture is live: the commit was observed out of band');
    await answerDecision(fx.engine, project.id, observed.decision.id, 'adopt');
    await waitFor(() => outOfBand(fx.home, project.id)[0].disposition === 'adopt', { what: 'the adoption to be recorded' });
    const ctx = await nominated(fx, { project });
    const checks = await installChecks(fx.engine, project.id, [check('login', { requirements: ['R1'] })]);
    await passAll(fx.engine, project.id, ctx.candidate.id, Object.values(checks.id));
    const alpha = await alphaTarget(fx, ctx);
    assert.notEqual(protectedFingerprint(project.repo.path, refOid(project.repo.path, project.repo.ref)), authorized.fingerprint, 'the fixture is live: the head of the integration branch holds a protected set that is not the authorized one');
    assert.notEqual(protectedFingerprint(project.repo.path, stray), authorized.fingerprint);

    // The repository stops answering: every git call of the engine waits, and is ended at its deadline. Both gates are evaluated meanwhile.
    const letGo = holdGit(project.repo.path);
    fx.beforeCleanup.push(letGo);
    const stage = await stageGate(fx, ctx);
    const authorization = await alpha.evaluate();
    letGo();

    for (const [gate, evaluation] of [['stage gate', stage], ['Alpha authorization gate', authorization]]) {
      assert.equal(evaluation.outcome, 'not_satisfied', `the ${gate}, evaluated while the protected set at the head could not be read: an input that could not be read is not a pass`);
      assert.ok(reasonCodes(evaluation).includes('PROTECTED_PATH_UNAUTHORIZED'), `the ${gate} says which input was not shown: the protected path is not shown to be authorized (reasons: ${reasonCodes(evaluation).join(', ')})`);
    }
    assert.equal(workItem(fx.home, ctx.items[0]).status, 'verifying', "the stage's work is not complete");
    assert.deepEqual(authorizationsOf(fx.home, ctx.candidate.id).map((row) => row.status), ['proposed'], 'and no authorization was issued');
  });
});
