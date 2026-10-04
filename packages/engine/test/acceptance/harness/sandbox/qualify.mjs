// A qualification attempt without a model (M2 slice 13 part 2, row M135;
// D2 §7.2, K10, A.3, A.7; SEAM.md §§148, 149). The backend is `scripted`,
// its binary a stand-in built to run the scripted role program, and its
// three canaries are scripted roles inside the real sandbox. No provider,
// no key, no network beyond the engine's own proxy.
//
// SAFETY (E64 item 2; SEAM.md §141): the containment canary's actions, and
// any canary that connects, are guarded probes; `armedCanary` releases a
// canary's role into them only after `assertContained` has read, from the
// host, that the role is inside its domain and in namespaces of its own.

import assert from 'node:assert/strict';
import { join } from 'node:path';

import { waitFor } from '../engine.mjs';
import { addGitProject } from '../gitruns.mjs';
import { acting, hostNamespaces, step } from '../scripted.mjs';
import { withStore } from '../store.mjs';
import { StandIn, attemptRow, consumeEngine, openEngineDecision } from '../trust.mjs';
import { domainOf, roleProcess, sandboxEngine } from './lane.mjs';
import { assertContained } from './view.mjs';

export const CANARY_KINDS = Object.freeze(['positive', 'cancellation', 'containment']);
// Names under .example only, never resolved (SEAM.md §132).
export const CANDIDATE_EGRESS = Object.freeze(['api.provider.example']);

const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// The attempt row with its JSON columns parsed.
export function attemptOf(home, id) {
  const row = attemptRow(home, id);
  if (!row) return null;
  const out = { ...row };
  for (const k of ['candidate_egress', 'canary_deadlines', 'spend', 'canaries', 'unexpected_contacts']) if (k in out && out[k] !== null) out[k] = json(out[k]);
  return out;
}

export const attemptsOf = (home) => withStore(home, (db) => db.prepare('SELECT "id" FROM "qualification_attempts" ORDER BY rowid').all()).map((r) => attemptOf(home, r.id));

export const waitAttempt = (home, id, status, { timeoutMs = 180_000 } = {}) =>
  waitFor(() => ([status].flat().includes(attemptOf(home, id)?.status) ? attemptOf(home, id) : undefined), { timeoutMs, what: `attempt ${id} to be ${[status].flat().join(' or ')}` });

// The runs dispatched under an attempt's authority: those whose receipt
// names it (K10, A.3), oldest first, each {run, receipt}.
export const canaryRuns = (home, attemptId) =>
  withStore(home, (db) =>
    db
      .prepare('SELECT r."id" AS run, r."project", r."outcome", r."reason_class", r."state", i."id" AS receipt, i."trust_entry", i."qualification_attempt" FROM "invocation_receipts" i JOIN "runs" r ON r."id" = i."run" WHERE i."qualification_attempt" = ? ORDER BY r."seq", i.rowid')
      .all(attemptId),
  );

// POST /v1/trust/qualify (SEAM.md §148). Returns the response.
export const postQualify = (fx, body) => fx.engine.post('/v1/trust/qualify', body);

export async function qualify(fx, body) {
  const res = await postQualify(fx, body);
  assert.equal(res.status, 201, `POST /v1/trust/qualify proposes an attempt (body: ${res.text})`);
  assert.match(String(res.body?.qualification_attempt?.id), /^qa_[0-9A-HJKMNP-TV-Z]{26}$/, `the answer names the attempt (${res.text})`);
  return { id: res.body.qualification_attempt.id, decision: res.body.decision ?? null, body: res.body };
}

// The default canary scripts: each obeys its instructions; the containment
// canary's actions are released by the test (armedCanary).
export function obeyingCanaries(fx, { positive, cancellation, containment } = {}) {
  // Each default is repeated, so that every attempt of a case finds one.
  const hostNs = hostNamespaces();
  const times = (one) => Array.from({ length: 8 }, () => one);
  fx.scripted.canaryScript('positive', positive ?? times({ steps: [step.canary('obey')] }));
  fx.scripted.canaryScript('cancellation', cancellation ?? times({ steps: [step.canary('obey')], on_term: 'exit' }));
  fx.scripted.canaryScript('containment', containment ?? times({ steps: [step.hold('armed'), acting(hostNs).canaryActions(), step.canary('result_only')] }));
}

// A sandbox-lane engine, a stand-in built to run the scripted role program
// (the attempt's binary), and the fixture project (a git project).
export async function attemptFixture(t, { config = {} } = {}) {
  const fx = await sandboxEngine(t, { config: { terminate_grace: 3, kill_grace: 2, ...config } });
  const standIn = new StandIn(join(fx.root, 'standin'), { logDir: fx.scripted.dir, runsChild: true });
  const fixtureProject = (await addGitProject(fx)).id;
  return { fx, standIn, fixtureProject };
}

export const scriptedBody = (standIn, fixtureProject, extra = {}) => ({
  backend: 'scripted',
  mode: 'one_shot_headless',
  model: 'scripted-model',
  binary: { path: standIn.path },
  fixture_project: fixtureProject,
  candidate_egress: [...CANDIDATE_EGRESS],
  ...extra,
});

// Approve the attempt's qualification_approval, as the human would.
export async function approveAttempt(fx, fixtureProject, attemptId) {
  const previewed = await openEngineDecision(fx, fixtureProject, 'qualification_approval', attemptId);
  await consumeEngine(fx, previewed, 'approve');
  return previewed;
}

// The canary of `kind` holding at "armed": found from the host, shown
// contained, then released into its guarded actions.
export async function armedCanary(fx, kind, { timeoutMs = 120_000 } = {}) {
  const launch = await waitFor(
    () => {
      const l = fx.scripted.launches().filter((e) => e.canary_kind === kind).at(-1);
      if (!l) return undefined;
      return fx.scripted.eventsOfInvocation(l.invocation, 'holding').some((e) => e.hold === 'armed') ? l : undefined;
    },
    { timeoutMs, what: `the ${kind} canary's role to hold at "armed"` },
  );
  assert.ok(launch.run, `the ${kind} canary's launch names its run`);
  const domain = domainOf(fx.home, launch.run);
  const member = await roleProcess(fx, domain, launch);
  assertContained(domain, member, `the ${kind} canary's role`);
  fx.scripted.release(launch.invocation, 'armed');
  return { launch, domain, member };
}

// The canary entry of `kind` on the attempt row.
export const canaryOf = (attempt, kind) => (attempt?.canaries ?? []).find((c) => c.kind === kind);
