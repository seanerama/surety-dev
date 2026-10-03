// Fixtures, commands and reads for the slice-5 rows on the protected path,
// acceptance scope, findings and the two gate kinds M1 computes (rows M35 to
// M44; SEAM.md §§65 to 75).
//
// Check results, classifications of a protected diff, baseline approvals and
// reuse entries enter through fixture routes and are labelled as test setup
// (Plan §§1, 2): M1 has no check runner and no classifier, and nothing here
// qualifies one. Findings, sign-offs, proposals and assessments are not
// fixtures: they come from a scripted role's result, as they would from an
// agent's.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { waitFor } from './engine.mjs';
import { addGitProject, addItem, permittedEdit, roleThat, runToEnd, waitForCandidates } from './gitruns.mjs';
import { hasIdForm } from './ids.mjs';
import { consume, decisionsOn, openDecision } from './decisions.mjs';
import { candidatesOf, changePolicy, eventsOfType } from './journal.mjs';
import { listTree, parentsOf, refOid } from './repos.mjs';
import { addWork, runsOf, scriptedEngine, tick, tickUntil } from './runs.mjs';
import { step } from './scripted.mjs';
import { withStore } from './store.mjs';

// ---- the protected set (SEAM.md §65) ------------------------------------------------

export const PROTECTED_ROOT = '.surety/checks/';
export const GOVERNED_FILE = '.surety/checks/protected-policy.json';
export const GOVERNED_KEYS = ['protected_paths', 'check_commands', 'check_discovery', 'runner_config', 'result_collection', 'required_checks'];

// The protected fingerprint of a revision, computed here and never read from
// the engine (build spec §6 correction 3): SHA-256, in lower-case hex, of the
// JSON text of the array of [path, blob id] pairs of every file under the
// protected roots, sorted by path. No field of any file is projected.
export function protectedFingerprint(repo, rev, roots = [PROTECTED_ROOT]) {
  const pairs = Object.entries(listTree(repo, rev))
    .map(([path, entry]) => [path, ...entry.split(' ').slice(1)])
    .filter(([path, type]) => type === 'blob' && roots.some((root) => path.startsWith(root)))
    .map(([path, , oid]) => [path, oid])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}

// ---- store reads ----------------------------------------------------------------------

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));

export const protectedVersions = (home, project) => rows(home, 'SELECT * FROM "protected_versions" WHERE "project" = ? ORDER BY "seq"', project);

// The one effective protected version (D1 §2.4): authorized, in effect, not superseded.
export function effectiveVersion(home, project) {
  const effective = protectedVersions(home, project).filter((version) => version.authorized === 1 && version.effective_from !== null && version.superseded_by === null);
  assert.equal(effective.length, 1, `a project has exactly one effective protected version (found ${effective.length})`);
  return effective[0];
}

export const proposalsOf = (home, project) => rows(home, 'SELECT * FROM "protected_proposals" WHERE "project" = ? ORDER BY "seq"', project);
export const findingsOf = (home, project) => rows(home, 'SELECT * FROM "findings" WHERE "project" = ? ORDER BY "seq"', project);
export const finding = (home, id) => rows(home, 'SELECT * FROM "findings" WHERE "id" = ?', id)[0];
export const signoffsOf = (home, candidate) => rows(home, 'SELECT * FROM "signoffs" WHERE "candidate" = ? ORDER BY rowid', candidate);
export const assessmentsOf = (home, project) => rows(home, 'SELECT * FROM "applicability_assessments" WHERE "project" = ? ORDER BY rowid', project);
export const authorizationsOf = (home, candidate) => rows(home, 'SELECT * FROM "deployment_authorizations" WHERE "candidate" = ? ORDER BY rowid', candidate);
export const checkResult = (home, id) => rows(home, 'SELECT * FROM "check_results" WHERE "id" = ?', id)[0];
export const evaluationsOf = (home, candidate, kind) => rows(home, 'SELECT * FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = ? ORDER BY rowid', candidate, kind);

// The scope an evaluation was computed over, with its id lists parsed.
export function scopeOf(home, evaluation) {
  const [scope] = rows(home, 'SELECT * FROM "acceptance_scopes" WHERE "id" = ?', evaluation.scope);
  assert.ok(scope, `the evaluation names its scope (${evaluation.scope})`);
  return { ...scope, delivered: json(scope.delivered_requirement_ids), partial: json(scope.partial_requirement_ids), required: json(scope.required_check_ids) };
}

// ---- fixtures: test setup, labelled as such (SEAM.md §66) ---------------------------------

const created = (res, what) => {
  assert.equal(res.status, 201, `${what} (body: ${res.text})`);
  return res.body;
};

// An approved baseline and a plan: requirement keys, and stages that say which
// requirements each implements. Returns the fixture's answer:
// {plan, stages: [{id, number, work_item}], requirements: [{id, key}]}.
export async function installGatedPlan(engine, project, { requirements = [], modules, stages }) {
  const body = { project, requirements: requirements.map((key) => ({ key })), stages };
  if (modules !== undefined) body.modules = modules;
  const plan = created(await engine.post('/v1/harness/fixtures/plan', body), 'plan fixture');
  assert.equal(plan.requirements?.length, requirements.length, `the plan fixture answers with one requirement per key (body: ${JSON.stringify(plan)})`);
  return plan;
}

// One check as the checks fixture takes it. `gates` are the gate kinds it
// applies to and `requirements` the requirement keys it covers; a check with
// no requirement is a release obligation.
export const check = (key, { kind = 'acceptance', gates = ['stage', 'alpha_authorize'], requirements = [], ...rest } = {}) => ({ key, kind, gate_kinds: gates, requirements, ...rest });

// Declare checks of the project's effective protected version: the stand-in
// for what D3 would discover in the protected set. Returns {version, id: {key: check id}}.
export async function installChecks(engine, project, checks) {
  const body = created(await engine.post('/v1/harness/fixtures/checks', { project, checks }), 'checks fixture');
  assert.equal(body.checks?.length, checks.length, `the checks fixture answers with one check per key (body: ${JSON.stringify(body)})`);
  return { version: body.protected_version, id: Object.fromEntries(body.checks.map((row) => [row.key, row.id])) };
}

// One recorded execution of a check for a candidate: an observation, entered
// as a fixture. What is not given is the engine's default: the candidate's
// revision, the effective protected version, the check's runner class, an
// established execution with no signal and no deadline. `exit_status` is
// always given. Returns {id, execution_seq}.
export async function postResult(engine, project, result) {
  const body = created(await engine.post('/v1/harness/fixtures/check-result', { project, ...result }), 'check-result fixture');
  assert.ok(hasIdForm(body.check_result?.id, 'cr_') && Number.isInteger(body.check_result.execution_seq), `the fixture answers with the result and its execution sequence (body: ${JSON.stringify(body)})`);
  return body.check_result;
}

// A passing execution of each of `checks` (check ids) for the candidate.
export async function passAll(engine, project, candidate, checks, extra = {}) {
  const results = [];
  for (const id of checks) results.push(await postResult(engine, project, { candidate, check: id, exit_status: 0, ...extra }));
  return results;
}

// A configured test target. Nothing is ever deployed to it.
export async function addEnvironment(engine, project, { name = 'alpha', targets = ['alpha-1'] } = {}) {
  return created(await engine.post('/v1/harness/fixtures/environment', { project, name, target_set: targets }), 'environment fixture').environment.id;
}

// The classification D3's classifier would give a captured proposal.
export async function classify(engine, proposal, changeKind) {
  const res = await engine.post('/v1/harness/fixtures/classification', { proposal, change_kind: changeKind });
  assert.equal(res.status, 200, `classification fixture (body: ${res.text})`);
}

// The validation-scope approval of a proposal that changes the required
// set (E13; F §3.3): a baseline approval, which M1 takes as a fixture.
export async function scopeApproval(engine, project, proposal) {
  return created(await engine.post('/v1/harness/fixtures/approval', { project, kind: 'validation_scope', proposal }), 'approval fixture').approval;
}

// A reuse entry: the typed, assessed statement that an identified result of
// an earlier candidate may count for `candidate` (build spec §6 correction
// 18). The fixture installs what it is given, complete or not; what the gate
// makes of an incomplete entry is the engine's to get right.
export async function reuseEvidence(engine, entry) {
  return created(await engine.post('/v1/harness/fixtures/evidence-reuse', entry), 'evidence-reuse fixture').reuse;
}

// The evidence for the Alpha exception of a High finding (F §6.1): that the
// test environment contains its consequences, and the testing purpose.
// Installed as a fixture: who records it outside a test is not decided.
export async function alphaException(engine, findingId, { containment = 'The alpha target has no route to production data.', purpose = 'Exercise the import path before the fix lands.' } = {}) {
  created(await engine.post('/v1/harness/fixtures/alpha-exception', { finding: findingId, containment_evidence: containment, testing_purpose: purpose }), 'alpha-exception fixture');
}

// ---- commands -----------------------------------------------------------------------------

// Evaluate a gate. A gate that is not satisfied is an answer, not an error:
// the response is 200 with the evaluation either way. Returns the evaluation:
// {id, gate_kind, outcome, reasons: [{code, subjects}], check_states, scope, stale}.
export async function evaluate(engine, project, candidate, kind, body = {}) {
  const res = await engine.post(`/v1/projects/${project}/candidates/${candidate}/gates/${kind}`, body);
  assert.equal(res.status, 200, `evaluate the ${kind} gate of ${candidate} (body: ${res.text})`);
  const evaluation = res.body?.evaluation;
  assert.ok(hasIdForm(evaluation?.id, 'gate_'), `the response carries the evaluation (body: ${res.text})`);
  assert.ok(Array.isArray(evaluation.reasons), `the evaluation lists its reasons (body: ${res.text})`);
  assert.equal(evaluation.outcome, evaluation.reasons.length === 0 ? 'satisfied' : 'not_satisfied', `an evaluation is satisfied exactly when it has no reason (reasons: ${reasonCodes(evaluation).join(', ') || 'none'})`);
  return evaluation;
}

export const reasonCodes = (evaluation) => [...new Set(evaluation.reasons.map((reason) => reason.code))].sort();

// Every subject the evaluation names under one reason code.
export const reasonSubjects = (evaluation, code) => evaluation.reasons.filter((reason) => reason.code === code).flatMap((reason) => reason.subjects);

export const stageGate = (fx, ctx, candidate = ctx.candidate, stage = ctx.stage) => evaluate(fx.engine, ctx.project.id, candidate.id, 'stage', { stage });

// Record a prospective authorization: candidate, environment, artifact,
// configuration and exact targets (build spec §6 correction 4). The same
// binding sent again answers with the same row.
export async function proposeAuthorization(engine, project, candidate, binding) {
  const res = await engine.post(`/v1/projects/${project}/candidates/${candidate}/authorizations`, binding);
  assert.ok([200, 201].includes(res.status), `propose an authorization (→ ${res.status} ${res.text})`);
  assert.ok(hasIdForm(res.body?.authorization?.id, 'dauth_'), `the response carries the authorization (body: ${res.text})`);
  return res.body.authorization;
}

export const ARTIFACT = `sha256:${'a'.repeat(64)}`;

// A test target and a proposed authorization of the candidate for it.
// Returns {environment, binding, authorization, evaluate()}.
export async function alphaTarget(fx, ctx, candidate = ctx.candidate, { environment, targets = ['alpha-1'], artifact = ARTIFACT } = {}) {
  const env = environment ?? (await addEnvironment(fx.engine, ctx.project.id, { targets }));
  const binding = { environment: env, artifact_digest: artifact, config_identity: 'config-1', target_set: targets };
  const authorization = await proposeAuthorization(fx.engine, ctx.project.id, candidate.id, binding);
  return { environment: env, binding, authorization, evaluate: () => evaluate(fx.engine, ctx.project.id, candidate.id, 'alpha_authorize', { authorization: authorization.id }) };
}

// ---- candidates and role runs ----------------------------------------------------------------

// A project whose plan's first stage has been built, integrated and
// nominated. `stages` default to one stage that implements every
// requirement; `roles[n]` scripts stage n+1's Builder (stage 1 writes the
// permitted edit by default). At T1 a nomination is the Builder's request.
// `project` is a project made beforehand (of tier `tier`), else one is made.
// Returns {project, plan, items, stage, candidate, requirement: {key: id}}.
export async function nominated(fx, { tier = 'T1', requirements = ['R1'], stages, modules, files, roles = [], project: existing } = {}) {
  const project = existing ?? (await addGitProject(fx, { tier, files }));
  const plan = await installGatedPlan(fx.engine, project.id, { requirements, modules, stages: stages ?? [{ number: 1, goal: 'the first stage', implements: requirements }] });
  const items = plan.stages.map((stage) => stage.work_item);
  const nominate = tier === 'T1' ? { nominate: true } : {};
  items.forEach((item, n) => fx.scripted.script(item, [roles[n] ?? roleThat([n === 0 ? permittedEdit() : step.write(`src/stage-${n + 1}.js`, `export const stage = ${n + 1};\n`)], nominate)]));
  await runToEnd(fx, project.id, items[0]);
  const [candidate] = await waitForCandidates(fx, project.id);
  return { project, plan, items, stage: plan.stages[0].id, candidate, requirement: Object.fromEntries(plan.requirements.map((row) => [row.key, row.id])) };
}

// A later candidate of a T1 project: a fix is integrated on top and the
// Builder asks for its nomination. By default the fix's work is a fixture's
// (naming no finding). With `work`, it is that existing item: the fix the
// engine registered for a finding dispositioned `fix` (SEAM.md §74; E43),
// which is chained and waits at the chain boundary, so a person lets it
// through first. Returns the new candidate.
export async function successor(fx, ctx, { work } = {}) {
  const count = candidatesOf(fx.home, ctx.project.id).length;
  const fix = work ?? (await addItem(fx, ctx.project.id, 'fix'));
  fx.scripted.script(fix, [roleThat([step.write(`src/fix-${count}.js`, `export const fix = ${count};\n`)], { nominate: true })]);
  if (work !== undefined) await consume(fx, ctx.project.id, await openDecision(fx, ctx.project.id, 'blocker', work), 'continue');
  await tickUntil(fx.engine, ctx.project.id, () => runsOf(fx.home, fix)[0]?.state === 'ended', { what: 'the fix to be built' });
  return (await waitForCandidates(fx, ctx.project.id, count + 1)).at(-1);
}

// One run of a role on work a fixture creates for it: `steps` in its
// workspace, then a valid result with the fields of `result`. Returns {item, run}, the run ended.
export async function roleRun(fx, project, kind, { subject, steps = [], result = {} } = {}) {
  const item = await addWork(fx.engine, project, kind, subject === undefined ? {} : { subject });
  fx.scripted.script(item, [roleThat(steps, result)]);
  const run = await tickUntil(
    fx.engine,
    project,
    () => {
      const [first] = runsOf(fx.home, item);
      return first?.state === 'ended' ? first : undefined;
    },
    { what: `the ${kind} run to end` },
  );
  return { item, run };
}

// A role's run that the engine accepted.
export async function acceptedRun(fx, project, kind, opts) {
  const done = await roleRun(fx, project, kind, opts);
  assert.deepEqual([done.run.outcome, done.run.reason_class], ['completed', 'none'], `the ${kind} run was accepted (${done.run.reason_text})`);
  return done;
}

// Findings a Reviewer (or, with kind 'verification', a Verifier) reports on a
// candidate. Returns their rows, in the order reported.
export async function raiseFindings(fx, project, candidate, findings, { kind = 'review' } = {}) {
  const before = findingsOf(fx.home, project).length;
  await acceptedRun(fx, project, kind, { subject: { candidate }, result: { findings } });
  const raised = findingsOf(fx.home, project).slice(before);
  assert.equal(raised.length, findings.length, 'one finding is recorded for each the role reported');
  return raised;
}

// A Reviewer's run on a candidate with the given result fields: sign-offs,
// dispositions, severity changes, assessments, a proposal approval.
export const review = (fx, project, candidate, result) => acceptedRun(fx, project, 'review', { subject: { candidate }, result });

// ---- protected proposals: capture, classification, approval, application (SEAM.md §§68, 69) ----

export const CHECK_FILE = '.surety/checks/login.check.json';
export const PROTECTED_FILES = Object.freeze({
  [GOVERNED_FILE]: '{"protected_paths": [".surety/checks/"], "required_checks": ["login"]}\n',
  [CHECK_FILE]: '{"expect": 200}\n',
});

// How every rationale of a proposal captured here begins.
export const PROPOSAL_RATIONALE = 'The Verifier proposes this correction';

// A proposal captured from a Verifier's check_correction run that rewrote
// the check file, then classified by the fixture as `changeKind` (null: left
// unclassified). Returns the proposal's row.
export async function capturedProposal(fx, project, { changeKind = 'tightening', content = '{"expect": 200, "body": "ok"}\n', steps } = {}) {
  const requested = changeKind ?? 'tightening';
  const { run } = await acceptedRun(fx, project.id, 'check_correction', {
    steps: steps ?? [step.write(CHECK_FILE, content)],
    result: { proposal: { rationale: `${PROPOSAL_RATIONALE} (${requested}).`, requested_change_kind: requested } },
  });
  const proposal = proposalsOf(fx.home, project.id).find((row) => row.run === run.id);
  assert.ok(proposal, 'the Verifier\'s protected-only diff was captured as a proposal');
  if (changeKind !== null) await classify(fx.engine, proposal.id, changeKind);
  return proposalsOf(fx.home, project.id).find((row) => row.id === proposal.id);
}

// A Reviewer's run that approves a proposal, with a reason grounded in the spec.
export const reviewerApproves = (fx, project, proposal) =>
  roleRun(fx, project.id, 'review', { subject: { proposal: proposal.id }, result: { proposal_approval: { proposal: proposal.id, reason: 'The approved spec requires the body to be checked.' } } });

// The proposal once it has been applied and its finalizer has run.
export const waitApplied = (fx, project, proposal) =>
  tickUntil(
    fx.engine,
    project.id,
    () => {
      const row = proposalsOf(fx.home, project.id).find((found) => found.id === proposal.id);
      return row.status === 'applied' ? row : undefined;
    },
    { max: 6, what: `proposal ${proposal.id} to be applied` },
  );

// The proposal was applied, once and exactly (D1 §7.9): one commit of kind
// `protected` on the integration branch, on top of `headBefore`, whose
// protected set is the proposed one; one new version, authorized, effective,
// with the provenance given, superseding `previous`. Returns the new version.
export function assertApplied(fx, project, { proposal, previous, headBefore, authority, changeKind }) {
  const repo = project.repo.path;
  const head = refOid(repo, project.repo.ref);
  assert.deepEqual(parentsOf(repo, head), [headBefore], 'the integration branch gained one commit, on top of where it was');
  const revision = rows(fx.home, 'SELECT * FROM "revisions" WHERE "project" = ? AND "sha" = ?', project.id, head)[0];
  assert.equal(revision?.kind, 'protected', 'that commit is recorded as a protected revision');
  assert.equal(protectedFingerprint(repo, head), protectedFingerprint(repo, proposal.tree_id), 'the protected set it holds is the proposed one, exactly');

  const applied = proposalsOf(fx.home, project.id).find((row) => row.id === proposal.id);
  const versions = protectedVersions(fx.home, project.id);
  const version = effectiveVersion(fx.home, project.id);
  assert.deepEqual(versions.filter((row) => row.proposal === proposal.id).map((row) => row.id), [version.id], 'exactly one version was recorded for the proposal, and it is the effective one');
  assert.deepEqual(
    { fingerprint: version.fingerprint, change_kind: version.change_kind, authority: version.approver_authority },
    { fingerprint: protectedFingerprint(repo, head), change_kind: changeKind, authority },
    'the version has the fingerprint of the applied set and says who approved what',
  );
  assert.equal(versions.find((row) => row.id === previous.id).superseded_by, version.id, 'the previous version is superseded by it');
  assert.deepEqual([applied.status, applied.resulting_version, applied.approver_authority], ['applied', version.id, authority], 'the proposal is applied and names its version and its approver\'s authority');
  return version;
}

// ---- one fixture for several cases ------------------------------------------------------

// A fixture the cases of one describe block share: build it in the block's
// `before` hook with `shared.context` in place of a test context, and run
// `shared.cleanup` in its `after` hook. Used where a row's cases are
// readings of one history (one candidate, one evaluation), each reported
// by itself.
export function sharedFixture() {
  const undo = [];
  return {
    context: { after: (fn) => undo.push(fn) },
    cleanup: async () => {
      for (const fn of undo.reverse()) await fn();
    },
  };
}

// ---- a correction awaiting its approval (rows M53 to M55, M57) ---------------------------------

// A project with a protected set, a proposal a Verifier's run captured, the
// fixture's classification of it as `changeKind`, and the open decision of
// that class. A rejected run parks its work at once (no repair), so a case
// can go on using the project. Returns {fx, project, previous, proposal,
// decision, headBefore}: `previous` is the effective version, `headBefore`
// the commit the integration branch is at.
export async function correction(t, changeKind, { steps, content } = {}) {
  const fx = await scriptedEngine(t);
  const project = await addGitProject(fx, { tier: 'T1', files: PROTECTED_FILES });
  await changePolicy(fx.engine, project.id, { repair_attempts_max: 0 });
  const previous = effectiveVersion(fx.home, project.id);
  const proposal = await capturedProposal(fx, project, { changeKind, steps, content });
  const decision = await openDecision(fx, project.id, `check_correction_${changeKind}`, proposal.id);
  return { fx, project, previous, proposal, decision, headBefore: refOid(project.repo.path, project.repo.ref) };
}

// Nothing of the proposal was applied: the branch, the effective version and the proposal say so.
export function assertNotApplied(fx, { project, previous, proposal }, head) {
  assert.equal(refOid(project.repo.path, project.repo.ref), head, 'the integration branch is where it was');
  assert.equal(effectiveVersion(fx.home, project.id).id, previous.id, 'the effective protected version is the one that was authorized');
  const row = proposalsOf(fx.home, project.id).find((found) => found.id === proposal.id);
  assert.ok(row.status !== 'applied' && row.resulting_version === null, `the proposal is not applied (it is ${row.status})`);
  return row;
}

// ---- M2 slice 1: hardening before a backend (SEAM.md §§99 to 103) ------------------------

// A human edit of a governed field through the policy route (SEAM.md §66):
// answered 202 with the proposal it became. Returns the proposal's row,
// `captured`, `proposed_by` human. (Row M35 has the same helper privately.)
export async function governedEdit(fx, project, change) {
  const res = await fx.engine.post(`/v1/projects/${project.id}/policy`, change);
  assert.equal(res.status, 202, `a governed field takes the protected route (body: ${res.text})`);
  const proposal = proposalsOf(fx.home, project.id).find((row) => row.id === res.body?.proposal?.id);
  assert.ok(proposal, `the response names the proposal the edit became (body: ${res.text})`);
  assert.deepEqual([proposal.proposed_by, proposal.status], ['human', 'captured']);
  return proposal;
}

// Ask for ticks until `probe` answers, without waiting for the project's
// runs to end: for a step taken while a role is held in its workspace
// (rows M28 and M43). One tick round per attempt.
export const askingForTicks = (fx, project, probe, what) =>
  waitFor(
    async () => {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
      await tick(fx.engine, project, { rounds: 1 });
      return undefined;
    },
    { intervalMs: 200, timeoutMs: 60_000, what },
  );

// A protected change landed by the human while a role's run is held: the
// proposal is classified as `changeKind` by the fixture, the human approves
// it through the decision of that kind, and the application is waited for
// without waiting for the held run. Returns the new effective version.
export async function humanApplies(fx, project, proposal, changeKind) {
  const previous = effectiveVersion(fx.home, project.id);
  await classify(fx.engine, proposal.id, changeKind);
  const kind = `check_correction_${changeKind}`;
  const decision = await askingForTicks(fx, project.id, () => decisionsOn(fx.home, kind, proposal.id).find((row) => row.status === 'open'), `the ${changeKind} to be offered for approval`);
  await consume(fx, project.id, decision, 'approve');
  await askingForTicks(fx, project.id, () => proposalsOf(fx.home, project.id).find((row) => row.id === proposal.id)?.status === 'applied', `the approved ${changeKind} to be applied`);
  const version = effectiveVersion(fx.home, project.id);
  assert.notEqual(version.id, previous.id, 'the application made a new effective version');
  return version;
}

// What a finding is, in every respect the seam pins (SEAM.md §83): compared
// before a decision about it is raised and after the decision is rejected.
export const findingState = (row) => ({
  status: row.status,
  disposition: row.disposition,
  disposition_authority: row.disposition_authority,
  linked_issue: row.linked_issue,
  defer_target: row.defer_target,
  effective_severity: row.effective_severity,
  severity_history: row.severity_history,
  sensitive_area: row.sensitive_area,
  reevaluations: row.reevaluations,
  resolution_verification: row.resolution_verification,
  alpha_exception: row.alpha_exception,
});

// A correction the human rejected (SEAM.md §102): the proposal is in the
// `rejected` state D1 A.5 names, nothing of it was applied, no version was
// recorded for it, and one `protected.rejected` names it. Returns the row.
export function assertProposalRejected(fx, ctx) {
  const row = assertNotApplied(fx, ctx, ctx.headBefore);
  assert.equal(row.status, 'rejected', `the proposal is rejected (it is ${row.status})`);
  assert.deepEqual(protectedVersions(fx.home, ctx.project.id).filter((version) => version.proposal === ctx.proposal.id), [], 'no protected version, intended or authorized, was recorded for it');
  assert.equal(eventsOfType(fx.home, 'protected.rejected').filter((event) => event.subject?.proposal === ctx.proposal.id).length, 1, 'one protected.rejected event names the proposal');
  return row;
}
