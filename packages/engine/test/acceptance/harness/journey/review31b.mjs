// The 31b review's cases (SEAM.md §374): the shared fixture and readers.
// Kernel lane: the scripted backend, the scripted check boundary (§190) and
// the scripted deployment adapter (§247). Nothing here acts on a unit or a
// process but the test's own engine.

import assert from 'node:assert/strict';

import { runningClassifier, setEngineConfig } from '../checks/classifier.mjs';
import { recordExit } from '../checks/selection.mjs';
import { answer, decisionsOfKind } from '../decisions.mjs';
import { waitFor } from '../engine.mjs';
import { eventsOfType, operationDetails } from '../journal.mjs';
import { refOid } from '../repos.mjs';
import { scriptedEngine, tick } from '../runs.mjs';
import { withStore } from '../store.mjs';
import {
  ROUTED_KINDS,
  architectSession,
  createWithIdea,
  journeyContext,
  journeyScripts,
  openDecisions,
  queuedExecutions,
  specSession,
  visionSession,
} from './drive.mjs';
import { REQUIREMENTS, ROADMAP_JSON, ROADMAP_MD, SPEC_DEFECTIVE, specText } from './reference.mjs';

// The reference project at `developing` on the scripted backend, the
// classifier `authoritative`, under `autonomy: phase` (D6 C.2), the
// journey's scripts by kind in place. `onePhase`: R1 and R2 alone, the
// roadmap's phase 1 alone.
export async function journeyProject(t, { tier = 'T2', policy = {}, onePhase = false } = {}) {
  const fx = await scriptedEngine(t);
  const version = await runningClassifier(fx.engine);
  setEngineConfig(fx, { classifier_authority: { mode: 'authoritative', version } });
  await fx.engine.kill();
  await fx.start();
  journeyScripts(fx);
  const p = await createWithIdea(fx, { tier, policy: { autonomy: 'phase', alpha_deploy: 'manual', ...policy } });
  await visionSession(fx, p.id);
  await specSession(fx, p.id, onePhase ? { second: specText({ requirements: REQUIREMENTS.slice(0, 2) }) } : {});
  const over = onePhase ? { '.surety/roadmap/roadmap.json': { ...ROADMAP_JSON, phases: [ROADMAP_JSON.phases[0]] }, '.surety/roadmap/roadmap.md': ROADMAP_MD } : {};
  const arch = await architectSession(fx, p.id, p.repo, { over });
  const ctx = journeyContext(fx, p, { tier });
  return { fx, p, ctx, plan: arch.published };
}

// Ticks without waiting for the project's runs to end (a held role is a live
// run): each round records every queued execution's exit through §190 that is
// still queued, answers the routed decisions as the owner (`answerKinds`), and
// asks for one tick. Returns what `done` answers.
export async function pumpNoIdle(fx, ctx, done, { max = 60, what = 'the expected state', exits = () => 0, answerKinds = ROUTED_KINDS } = {}) {
  ctx.humanActs ??= [];
  for (let i = 0; i < max; i++) {
    const value = await done();
    if (value !== undefined && value !== null && value !== false) return value;
    for (const x of queuedExecutions(fx.home, ctx.project)) {
      const now = withStore(fx.home, (db) => db.prepare('SELECT "status" FROM "check_executions" WHERE "id" = ?').get(x.id));
      if (now?.status === 'queued') await recordExit(fx.engine, x.id, exits(x)).catch(() => null);
    }
    for (const d of openDecisions(fx.home, ctx.project)) {
      if (!answerKinds.includes(d.kind)) continue;
      const option = d.options.some((o) => o.key === 'approve') ? 'approve' : d.options[0].key;
      const res = await answer(fx.engine, ctx.project, d, option);
      ctx.humanActs.push({ kind: d.kind, id: d.id, option, status: res.status, at: new Date().toISOString() });
    }
    await tick(fx.engine, ctx.project, { rounds: 1 });
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what}: not reached within ${max} rounds`);
}

// POST …/spec/change-requests {text} (SEAM §353). Returns the request.
export async function postChange(fx, ctx, text = 'Change request.') {
  const res = await fx.engine.post(`/v1/projects/${ctx.project}/spec/change-requests`, { text });
  assert.equal(res.status, 201, `POST …/spec/change-requests (→ ${res.status} ${res.text})`);
  return res.body.request;
}

export const requestRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "spec_change_requests" WHERE "id" = ?').get(id));
export const intentRows = (home, project, kind) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "effect_intents" WHERE "project" = ? AND "kind" = ? ORDER BY rowid').all(project, kind));
export const eventsOfIntent = (home, type, intent) => eventsOfType(home, type).filter((e) => e.subject?.intent === intent);
export const unfinalized = (home, project) => operationDetails(home, { project }).filter((op) => !op.finalized);
export const specChangeDecisions = (home, project) => decisionsOfKind(home, project, 'spec_change');
export const integrationHead = (p) => refOid(p.repo.path, p.repo.ref);
export const waitUntil = (probe, what, timeoutMs = 60_000) => waitFor(probe, { what, timeoutMs });

// A specification version 2 whose representation is readable and carries a
// blocking finding: R2.2 in the index and absent from §4 (31a's defect, Q4).
export const SPEC_V2_DEFECT = SPEC_DEFECTIVE.replace('**Spec version:** 1', '**Spec version:** 2');
// Version 2 rewording both of R2's criteria (two listed checks: accept-r2
// covers R2.1 and R2.2, integration covers R2.2; SEAM §368).
export const REQUIREMENTS_R2_BOTH = Object.freeze(
  REQUIREMENTS.map((r) =>
    r.key === 'R2'
      ? {
          ...r,
          criteria: [
            { id: 'R2.1', text: 'Given the service is running, when a client requests GET /sum?a=2&b=3, then it answers 200 with content type application/json and the JSON body {"sum": 5}.' },
            { id: 'R2.2', text: 'Given the service is running, when a client requests GET /sum?a=x&b=3, then it answers 400 with content type application/json.' },
          ],
        }
      : r,
  ),
);
export const SPEC_R2_BOTH = specText({ version: 2, requirements: REQUIREMENTS_R2_BOTH, changeLog: [{ version: 2, date: '2026-10-12', change: 'R2.1 and R2.2 name the content type', by: 'Sean' }] });
// Version 2 rewording R1's one criterion.
export const SPEC_R1_REWORDED = specText({
  version: 2,
  requirements: REQUIREMENTS.map((r) => (r.key === 'R1' ? { ...r, criteria: [{ id: 'R1.1', text: 'Given the numbers 2 and 3, when `sum(2, 3)` of `src/sum.mjs` is called, then it returns the number 5, not a string.' }] } : r)),
  changeLog: [{ version: 2, date: '2026-10-12', change: 'R1.1 names the type', by: 'Sean' }],
});
