// The engine-constructed git metadata view (D2 §§2.3, 2.7; E37 item 5; Q4):
// what a role sees of the repository at /surety/git. The workspace's `.git`
// names it; it holds an engine-written `config` (core settings only, no
// includes, no hooks path, no helper), the run's `HEAD`, a copy of the run's
// index the role may change, an empty `hooks`, the repository's refs
// read-only, and its objects under an overlay whose writes stay on the
// volatile filesystem. The repository's own configuration, hooks, `info/`,
// `config.worktree`, credentials and every other worktree's metadata are not
// in it. A repository with alternates is refused (`mount_plan_refused`;
// E58 item 3), as is one whose objects or refs are not plain directories.
//
// The seed is written into the domain's area before the launch; the mount
// plan (sandbox/mounts.ts) binds it. Nothing here starts a process.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GitViewInput } from './mounts.js';
import { GIT_VIEW } from './mounts.js';

export class GitViewRefused extends Error {
  constructor(
    readonly path: string,
    readonly reason: 'alternates' | 'repository',
    detail: string,
  ) {
    super(detail);
  }
}

// The repository's common directory, refused if it has alternates (D2 §2.3)
// or anything the view binds is not what it should be.
export function repositoryCommonDir(repo: string): string {
  let common: string;
  try {
    common = realpathSync(join(repo, '.git'));
  } catch (err) {
    throw new GitViewRefused(repo, 'repository', `the repository's metadata cannot be resolved (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  for (const name of ['objects/info/alternates', 'objects/info/http-alternates']) {
    if (existsSync(join(common, name))) throw new GitViewRefused(join(common, name), 'alternates', `the repository borrows objects through ${name}, which the sandbox's git view cannot bind`);
  }
  for (const dir of ['objects', 'refs']) {
    let st;
    try {
      st = lstatSync(join(common, dir));
    } catch {
      throw new GitViewRefused(join(common, dir), 'repository', `the repository has no ${dir} directory`);
    }
    if (!st.isDirectory()) throw new GitViewRefused(join(common, dir), 'repository', `the repository's ${dir} is not a directory`);
  }
  for (const file of ['packed-refs', 'shallow']) {
    try {
      const st = lstatSync(join(common, file));
      if (!st.isFile()) throw new GitViewRefused(join(common, file), 'repository', `the repository's ${file} is not a regular file`);
    } catch (err) {
      if (err instanceof GitViewRefused) throw err;
    }
  }
  return common;
}

// The object format a repository records, from its configuration's
// `[extensions]` section: sha1 unless it names sha256.
export function objectFormat(common: string): 'sha1' | 'sha256' {
  let text = '';
  try {
    text = readFileSync(join(common, 'config'), 'utf8');
  } catch {
    return 'sha1';
  }
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const head = /^\[\s*([A-Za-z0-9.-]+)/.exec(line);
    if (head) {
      section = head[1]!.toLowerCase();
      continue;
    }
    const kv = /^objectformat\s*=\s*(\S+)/i.exec(line);
    if (section === 'extensions' && kv && kv[1]!.toLowerCase() === 'sha256') return 'sha256';
  }
  return 'sha1';
}

// The configuration the role's git reads: core settings and nothing else.
export function viewConfig(format: 'sha1' | 'sha256'): string {
  const lines = ['[core]', `\trepositoryformatversion = ${format === 'sha256' ? 1 : 0}`, '\tfilemode = true', '\tbare = false', '\tlogallrefupdates = false'];
  if (format === 'sha256') lines.push('[extensions]', '\tobjectformat = sha256');
  return `${lines.join('\n')}\n`;
}

// Write the view's seed into `<area>/git`: the configuration, the run's HEAD
// (detached at the revision the workspace was made at), a copy of the
// workspace's index, the workspace's `.git` naming the view, and an empty
// hooks directory.
export function seedGitView(args: { repo: string; adminDir: string; seed: string; head: string }): GitViewInput {
  const common = repositoryCommonDir(args.repo);
  mkdirSync(args.seed, { recursive: true, mode: 0o700 });
  mkdirSync(join(args.seed, 'hooks'), { recursive: true, mode: 0o555 });
  mkdirSync(join(args.seed, 'empty'), { recursive: true, mode: 0o555 });
  writeFileSync(join(args.seed, 'config'), viewConfig(objectFormat(common)), { mode: 0o444 });
  writeFileSync(join(args.seed, 'HEAD'), `${args.head}\n`, { mode: 0o444 });
  writeFileSync(join(args.seed, 'gitfile'), `gitdir: ${GIT_VIEW}\n`, { mode: 0o444 });
  const index = join(args.adminDir, 'index');
  const hasIndex = existsSync(index);
  if (hasIndex) copyFileSync(index, join(args.seed, 'index'));
  return { commonDir: common, seed: args.seed, index: hasIndex, packedRefs: existsSync(join(common, 'packed-refs')), shallow: existsSync(join(common, 'shallow')) };
}
