// New-app onboarding: create only a new directory, then use the existing
// journaled project bootstrap. Existing repositories use /projects or /adopt.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { git, repoContext } from '../git/exec.js';
import { prepareBootstrap } from '../projects/commands.js';
import { Refusal } from '../refusal.js';
import type { Runtime } from '../runtime.js';

const invalid = (field: string, reason: string) => new Refusal(400, 'invalid_value', reason, 'Correct the new-app form.', { field });

// The one parent the engine offers by default (GET /v1/setup). It is the only
// folder the engine creates for a person: a new app under it creates it first
// (one level, mode 700, never recursively, never an existing folder's
// contents). Any other missing parent is still a refusal.
export const defaultProjectsDirectory = (): string => join(homedir(), 'projects');
export const defaultProjectsDirectoryExists = (): boolean => existsSync(defaultProjectsDirectory());
function ensureDefaultParent(wanted: string): void {
  const dflt = defaultProjectsDirectory();
  if (resolve(wanted) !== dflt || existsSync(dflt)) return;
  try { mkdirSync(dflt, { mode: 0o700 }); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw invalid('dev_repo_path', `The default app folder ${dflt} does not exist and could not be created.`);
  }
}
export async function prepareNewProject(rt: Runtime, body: unknown): Promise<Record<string, unknown>> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('body', 'A new app needs an object.');
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!['name', 'tier', 'dev_repo_path', 'idea'].includes(key)) throw invalid(key, 'The new-app request contains an unsupported field.');
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 120 || /[\x00-\x1f]/.test(b.name)) throw invalid('name', 'Name must be 1–120 characters on one line.');
  if (!['T1', 'T2', 'T3'].includes(String(b.tier))) throw invalid('tier', 'Choose T1, T2 or T3.');
  if (typeof b.idea !== 'string' || !b.idea.trim()) throw invalid('idea', 'Describe the app you want to build.');
  if (typeof b.dev_repo_path !== 'string' || !isAbsolute(b.dev_repo_path) || /[\x00-\x1f]/.test(b.dev_repo_path)) throw invalid('dev_repo_path', 'Choose an absolute folder path.');
  const path = resolve(b.dev_repo_path);
  ensureDefaultParent(dirname(path));
  let parent: string;
  try { parent = realpathSync(dirname(path)); } catch { throw invalid('dev_repo_path', 'The parent folder must already exist.'); }
  const repo = join(parent, basename(path));
  if (repo === realpathSync(rt.home) || repo.startsWith(realpathSync(rt.home) + '/')) throw invalid('dev_repo_path', 'Keep app repositories outside the engine home.');
  try { mkdirSync(repo, { mode: 0o700 }); } catch (err) {
    throw new Refusal(409, 'repository_not_created', (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'That folder already exists; it was not changed.' : 'The app folder could not be created.', 'Choose a new folder in a writable parent directory.', { path: repo });
  }
  const ctx = repoContext(repo);
  const env = { GIT_AUTHOR_NAME: 'Surety Engine', GIT_AUTHOR_EMAIL: 'engine@surety.invalid', GIT_COMMITTER_NAME: 'Surety Engine', GIT_COMMITTER_EMAIL: 'engine@surety.invalid' };
  const run = async (args: string[]) => {
    const r = await git(ctx, args, { env });
    if (r.code !== 0) throw new Refusal(409, 'repository_setup_incomplete', 'The new folder was created, but repository setup did not finish.', 'The folder has been preserved. Inspect it before choosing another folder; no project has been registered.', { path: repo, step: args[0] });
  };
  await run(['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), `# ${b.name.trim()}\n\n${b.idea}\n`, { flag: 'wx', mode: 0o600 });
  await run(['add', '--', 'README.md']);
  await run(['commit', '-q', '-m', 'Initial app brief']);
  await run(['checkout', '-q', '--detach']);
  const prepared = await prepareBootstrap(rt, { name: b.name.trim(), tier: b.tier, dev_repo_path: repo, integration_branch: 'main', idea: b.idea });
  return { ...prepared, initiallyPaused: true };
}
