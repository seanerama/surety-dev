// The engine's own fixture project for a qualification attempt outside its
// test mode (D2 §7.2: "the engine-owned fixture project"; SEAM.md §148:
// outside harness mode the fixture project is the engine's own and a
// request may not name one). A small git repository in the engine home,
// registered once as an ordinary project through the same bootstrap as
// `POST /v1/projects`, its HEAD detached so that the engine can integrate
// onto its `main` (correction 6). The canaries run on it under the
// attempt's authority alone (K10); it holds nothing but what they write.
//
// Its repository is in the engine home, as every workspace is: what a
// canary's sandbox binds of it is the git view of D2 §2.3 (objects and refs,
// read-only) and the overlay's lower layer, as for any project.
//
// And where the backend the attempt qualifies is installed: resolved from
// the engine's own PATH to its real path, which is what an entry binds (D2
// §7.3: Claude Code installs each version at its own path, so the entry is
// pinned to that file, not to the launcher's symbolic link).

import { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

import { git, repoContext } from '../git/exec.js';
import { prepareBootstrap } from '../projects/commands.js';
import type { Runtime } from '../runtime.js';
import type { StoreClient } from '../store/client.js';
import { ENGINE_ACTOR } from '../store/transitions/tx.js';

export const FIXTURE_NAME = 'surety-qualification-fixture';
export const FIXTURE_BRANCH = 'main';
export const fixtureRepoPath = (home: string): string => join(home, 'qualification', 'fixture');

const IDENTITY = { GIT_AUTHOR_NAME: 'Surety Engine', GIT_AUTHOR_EMAIL: 'engine@surety.invalid', GIT_COMMITTER_NAME: 'Surety Engine', GIT_COMMITTER_EMAIL: 'engine@surety.invalid' };

// The fixture repository, made if it is not there: one commit on `main`
// holding a README, HEAD detached. Idempotent: an existing repository is
// left as it is.
export async function ensureFixtureRepo(home: string): Promise<string> {
  const repo = fixtureRepoPath(home);
  const ctx = repoContext(repo);
  if (existsSync(join(repo, '.git'))) return repo;
  mkdirSync(repo, { recursive: true, mode: 0o700 });
  const step = async (args: string[], env: Record<string, string> = {}) => {
    const r = await git(ctx, args, { env });
    if (r.code !== 0) throw new Error(`git ${args[0]} in the fixture repository failed: ${r.stderr.trim().slice(0, 200)}`);
  };
  await step(['init', '-q', '-b', FIXTURE_BRANCH]);
  writeFileSync(join(repo, 'README.md'), '# Surety qualification fixture\n\nThe engine qualifies backends here: each canary of a qualification attempt runs on this project.\n');
  await step(['add', 'README.md']);
  await step(['commit', '-q', '-m', 'surety: the qualification fixture'], { ...IDENTITY, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });
  await step(['checkout', '-q', '--detach']);
  return repo;
}

// The backend's installation: the first executable named `backend` on the
// engine's PATH, resolved to its real path. null when there is none.
export function resolveInstallation(backend: string, path = process.env.PATH ?? ''): string | null {
  if (!/^[a-z][a-z0-9-]*$/.test(backend)) return null;
  for (const dir of path.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, backend);
    try {
      accessSync(candidate, constants.X_OK);
      const real = realpathSync(candidate);
      if (statSync(real).isFile()) return real;
    } catch {
      // not here
    }
  }
  return null;
}

// The engine's own fixture project's id, or null where none is registered
// (a home that has none: before the first start outside the test mode, and
// in a test-mode home).
export function findFixtureProject(store: StoreClient, home: string): Promise<string | null> {
  return store.call<string | null>('read', { name: 'qualification.engine_fixture', args: { repo: fixtureRepoPath(home) } });
}

// Found, or made and registered by the engine through the bootstrap of
// POST /v1/projects (SEAM.md §164: at the engine's first start outside the
// test mode). Two callers at once make one.
let making: Promise<string> | null = null;
export function ensureFixtureProject(rt: Runtime, store: StoreClient): Promise<string> {
  making ??= (async () => {
    const found = await findFixtureProject(store, rt.home);
    if (found !== null) return found;
    const repo = await ensureFixtureRepo(rt.home);
    const args = await prepareBootstrap(rt, { name: FIXTURE_NAME, tier: 'T1', dev_repo_path: repo, integration_branch: FIXTURE_BRANCH });
    const result = await store.call<{ status: number; effects?: { kind: string }[] }>('mutate', { name: 'project.create', args, actor: ENGINE_ACTOR, method: 'POST', path: '/v1/projects' });
    if (result.effects && result.effects.length > 0) rt.afterCommit(result.effects);
    return String(args.id);
  })().finally(() => {
    making = null;
  });
  return making;
}
