// The git work an API command needs before its transaction (D1 §§3.1, 6.3,
// 11.4; SEAM.md §27): reads of the repository, and the commit its intent
// will freeze. No transaction is held across any of it; the command's own
// transaction checks again what it depends on and records the intent.

import { rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { nowIso } from '../clock.js';
import { validatePolicySubmission, wideningKeys } from '../config/project-policy.js';
import { commitContent, messageText } from '../git/commit.js';
import { SHA, gitOk, repoContext } from '../git/exec.js';
import { readRef, treeOf, writeBlob } from '../git/repo.js';
import { newId } from '../ids.js';
import { branchCheckedOutAt, commitId } from '../journal/effects.js';
import { Refusal } from '../refusal.js';
import type { Runtime } from '../runtime.js';
import { policyRefusal } from '../store/transitions/project.js';

const invalid = (field: string, why: string) => new Refusal(400, 'invalid_value', `"${field}" ${why}.`, 'Correct the request and send it again; nothing was created.', { field });

const repoUnreadable = (path: string) =>
  new Refusal(409, 'repo_unreadable', `${path} is not a git repository the engine can read.`, 'Give the path of a readable git repository; nothing was created.', { path });

// A tree: `base` with `files` added or replaced, built in a scratch index.
async function treeWith(repo: string, base: string, files: Record<string, string>, scratch: string): Promise<string | null> {
  const ctx = repoContext(repo);
  const index = join(scratch, `prepare-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    if ((await gitOk(ctx, ['read-tree', base], { env })) === null) return null;
    for (const [path, content] of Object.entries(files)) {
      const blob = await writeBlob(ctx, content);
      if (blob === null) return null;
      if ((await gitOk(ctx, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env })) === null) return null;
    }
    const tree = (await gitOk(ctx, ['write-tree'], { env }))?.trim() ?? '';
    return SHA.test(tree) ? tree : null;
  } finally {
    rmSync(index, { force: true });
  }
}

async function prepareCommit(repo: string, base: string, files: Record<string, string>, message: string, scratch: string) {
  const tree = await treeWith(repo, base, files, scratch);
  if (tree === null) return null;
  const content = commitContent({ tree, parent: base, message, at: nowIso() });
  const sha = await commitId(repo, content);
  return sha === null ? null : { tree, sha, content };
}

const PROJECT_FIELDS = ['name', 'tier', 'dev_repo_path', 'integration_branch'];

// POST /v1/projects: the body checked, the repository read, and the bootstrap
// commit prepared. Refusals create nothing.
export async function prepareBootstrap(rt: Runtime, body: unknown): Promise<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!PROJECT_FIELDS.includes(key)) throw new Refusal(400, 'unknown_field', `"${key}" is not a field of a project.`, `Send only ${PROJECT_FIELDS.join(', ')}.`, { field: key });
  }
  for (const field of PROJECT_FIELDS) if (typeof b[field] !== 'string' || (b[field] as string).length === 0) throw invalid(field, 'must be a non-empty string');
  const name = b.name as string;
  const tier = b.tier as string;
  const repo = b.dev_repo_path as string;
  const branch = b.integration_branch as string;
  if (!['T1', 'T2', 'T3'].includes(tier)) throw invalid('tier', 'must be T1, T2 or T3');
  if (!isAbsolute(repo)) throw invalid('dev_repo_path', 'must be an absolute path');
  if (/[\0\n]/.test(branch)) throw invalid('integration_branch', 'is not a branch name');

  const ctx = repoContext(repo);
  if ((await gitOk(ctx, ['rev-parse', '--git-dir'])) === null) throw repoUnreadable(repo);
  const head = await readRef(ctx, `refs/heads/${branch}`);
  if (head.state === 'unknown') throw repoUnreadable(repo);
  if (head.state === 'missing') throw invalid('integration_branch', `is no branch of ${repo}`);
  // Correction 6: a bootstrap commit could not be integrated onto a branch
  // checked out in a worktree the engine does not own.
  const at = await branchCheckedOutAt(repo, branch, rt.home);
  if (at === 'unknown') throw repoUnreadable(repo);
  if (at !== null) {
    throw new Refusal(
      409,
      'integration_conflict',
      `The integration branch ${branch} is checked out in the worktree ${at}, so the project's bootstrap commit could not be integrated.`,
      `Switch the worktree ${at} to another branch, or detach it, and send the request again; nothing was created.`,
      { worktree: at, branch },
    );
  }
  const id = newId('proj_');
  const identity = `${JSON.stringify({ id, name }, null, 2)}\n`;
  const message = messageText({ title: `surety: bootstrap project ${id}`, trailers: [['Surety-Project', id]] });
  const commit = await prepareCommit(repo, head.oid, { '.surety/project.json': identity }, message, rt.scratch);
  if (commit === null) throw repoUnreadable(repo);
  return { id, name, tier, repo, branch, head: head.oid, commit, deadlineSeconds: rt.setting('git_deadline') };
}

// POST /v1/projects/:p/policy, a valid change (SEAM.md §27): validated whole
// against the closed schema first; refused while the repository is held by
// an observation; and a change that widens authority is not taken here.
export async function preparePolicy(rt: Runtime, project: string, body: unknown): Promise<Record<string, unknown>> {
  await rt.read('project.policy', { project });
  const change = validatePolicySubmission(body);
  // What the project's journal has in hand (its bootstrap, an earlier policy
  // change) is settled first: the change is made on the branch they leave.
  await rt.services?.journal(project);
  const facts = await rt.engine<{
    repo: string;
    branch: string;
    head: string | null;
    effective: Record<string, number>;
    revision: number | null;
    blocking: string | null;
  }>('project.policy_facts', { project });
  if (facts.blocking) throw policyRefusal(facts.blocking);
  const widens = wideningKeys(facts.effective, change);
  if (widens.length > 0) {
    throw new Refusal(
      501,
      'unsupported',
      `The change widens authority (${widens.join(', ')}): it needs a policy_widening decision, which this engine revision does not have.`,
      'Nothing was changed. Lower limits only, or wait for the policy-widening route.',
      { fields: widens },
    );
  }
  const ctx = repoContext(facts.repo);
  const head = await readRef(ctx, `refs/heads/${facts.branch}`);
  if (head.state === 'unknown' || facts.head === null) throw policyRefusal('repository');
  if (head.state === 'missing' || head.oid !== facts.head) throw policyRefusal('ref');
  if ((await treeOf(ctx, facts.head)) === null) throw policyRefusal('repository');
  const effective: Record<string, number> = { ...facts.effective, ...change };
  const sorted = Object.fromEntries(Object.keys(effective).sort().map((k) => [k, effective[k]!]));
  const content = `${JSON.stringify(sorted, null, 2)}\n`;
  const revision = (facts.revision ?? 0) + 1;
  const message = messageText({ title: `surety: project policy revision ${revision}`, trailers: [['Surety-Project', project], ['Surety-Policy-Revision', String(revision)]] });
  const commit = await prepareCommit(facts.repo, facts.head, { '.surety/policy.json': content }, message, rt.scratch);
  if (commit === null) throw policyRefusal('repository');
  const blob = await writeBlob(ctx, content);
  if (blob === null) throw policyRefusal('repository');
  return { project, body, prepared: { head: facts.head, revision, commit, blob, effective: sorted, change, deadlineSeconds: rt.setting('git_deadline') } };
}

// POST /v1/projects/:p/rebind: the new path must be a readable repository
// that holds the commit the engine expects the project's integration branch
// at. Nothing is changed in the repository.
export async function prepareRebind(rt: Runtime, project: string, body: unknown): Promise<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (key !== 'dev_repo_path') throw new Refusal(400, 'unknown_field', `"${key}" is not a field of this command.`, 'Send only dev_repo_path.', { field: key });
  }
  const path = b.dev_repo_path;
  if (typeof path !== 'string' || !isAbsolute(path)) throw invalid('dev_repo_path', 'must be an absolute path');
  const facts = await rt.engine<{ head: string | null }>('project.policy_facts', { project });
  if (facts.head === null) throw repoUnreadable(path);
  const found = await gitOk(repoContext(path), ['cat-file', '-e', `${facts.head}^{commit}`]);
  if (found === null) {
    throw new Refusal(409, 'repo_unreadable', `${path} is not this project's repository: it does not hold the commit ${facts.head} the engine expects the integration branch at.`, 'Give the path the repository was moved to.', { path });
  }
  return { project, dev_repo_path: path };
}
