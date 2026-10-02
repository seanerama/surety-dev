// Fixtures and steps the slice-3 rows share (SEAM.md §§25–34): projects on
// repositories in the topologies the git rows need, installed as fixtures or
// created through the public API; a role's run taken to its end; and the
// scripts of what a role does to a workspace.

import assert from 'node:assert/strict';
import { join } from 'node:path';

import { installProject, waitFor } from './engine.mjs';
import { createProject } from './journal.mjs';
import { makeProjectRepo, refOid } from './repos.mjs';
import { addWork, addWorkOfKind, getRow, runsOf, tick, waitForRun, workItem } from './runs.mjs';
import { VALID_RESULT, script, step } from './scripted.mjs';

// A project on a repository of its own. `primary` is what the developer's
// work tree has checked out ('detached', the supported topology, by
// default); `via` is 'fixture' (the harness installer) or 'api' (POST
// /v1/projects, with its bootstrap commit). Returns {id, repo, base}: `base`
// is the commit the integration branch is at once the project exists.
export async function addGitProject(fx, { primary = 'detached', via = 'fixture', files = {}, branch = 'main', name, tier = 'T2' } = {}) {
  const n = ++fx.repos;
  const repo = makeProjectRepo(join(fx.root, `repo-${n}`), { primary, files, branch });
  const label = name ?? `git-project-${n}`;
  const id = via === 'api' ? (await createProject(fx.engine, { repoPath: repo.path, name: label, tier, branch })).id : await installProject(fx.engine, { repoPath: repo.path, name: label, tier, branch });
  return { id, repo, base: refOid(repo.path, repo.ref) };
}

// One eligible item of `kind`; a stage_build item comes from a one-stage
// plan, whose goal can be given.
export async function addItem(fx, project, kind = 'fix', { goal } = {}) {
  if (kind === 'stage_build' && goal !== undefined) {
    const res = await fx.engine.post('/v1/harness/fixtures/plan', { project, stages: [{ number: 1, goal }] });
    assert.equal(res.status, 201, `plan fixture (body: ${res.text})`);
    return res.body.stages[0].work_item;
  }
  return kind === 'stage_build' ? addWorkOfKind(fx.engine, project, kind) : addWork(fx.engine, project, kind);
}

// Tick, and wait for the (index+1)-th run of the item to end. Returns its row.
export async function runToEnd(fx, project, item, { index = 0, timeoutMs = 60_000 } = {}) {
  if (runsOf(fx.home, item).length <= index) await tick(fx.engine, project);
  return waitForRun(fx.home, item, { index, state: 'ended', timeoutMs });
}

// Tick, and wait for the (index+1)-th run of the item to have its role
// waiting at the hold `name`. Returns {run, launch, workspace}.
export async function runToHold(fx, project, item, { index = 0, name = 'gate' } = {}) {
  if (runsOf(fx.home, item).length <= index) await tick(fx.engine, project);
  const run = await waitForRun(fx.home, item, { index, state: 'executing' });
  const launch = await waitFor(
    () => {
      const found = fx.scripted.launches({ run: run.id })[0];
      return found && fx.scripted.eventsOf(found.pid, 'holding').some((e) => e.hold === name) ? found : undefined;
    },
    { what: `the role of run ${run.id} to reach hold "${name}"` },
  );
  return { run, launch, workspace: getRow(fx.home, 'workspaces', run.workspace) };
}

// A role that does `steps`, then sends a valid result (with `extra` fields) and exits 0.
export const roleThat = (steps, extra = {}) => ({ steps: [...steps, step.result({ ...VALID_RESULT, ...extra })] });

// A role that does `before`, waits at a hold, does `after`, then sends a
// valid result and exits 0. The test looks at the store while it waits.
export const roleThatHolds = (before, after = [], extra = {}) => ({ steps: [...before, step.hold('gate'), ...after, step.result({ ...VALID_RESULT, ...extra })] });

// The edit every "permitted" case makes: one new source file.
export const PERMITTED_EDIT = Object.freeze({ path: 'src/app.js', content: 'export const answer = 42;\n' });
export const permittedEdit = () => step.write(PERMITTED_EDIT.path, PERMITTED_EDIT.content);

export { script, step, workItem };
