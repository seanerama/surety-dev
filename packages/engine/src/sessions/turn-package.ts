// A session turn's context package, built from durable records on the main
// thread (D6 §2.2; D2 §1.3): the session's transcript and the last save's
// notes from the store, the approved inputs from git, and the current state
// of the role's artifact read from the session's workspace (the files under
// its permitted paths, through the redactor, bounded). Written the same way
// for the kernel lane's package and the one the sandbox mounts at
// /surety/context; a qualification attempt's continuation canary adds its
// instructions (D6 §2.6).

import { lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { gitOk, repoContext } from '../git/exec.js';
import { readRegular } from '../invoke/sandbox/volatile.js';
import { redactText } from '../records/redact.js';
import type { Runtime } from '../runtime.js';
import type { Claim } from '../store/transitions/runs.js';
import { type ArtifactState, type SessionContextFacts, writeSessionPackage } from './package.js';
import { designPackageFor } from '../design/package.js';

// What of the artifact a package carries, at most.
const ARTIFACT_FILE_MAX = 256 * 1024;
const ARTIFACT_TOTAL_MAX = 1024 * 1024;
const ARTIFACT_FILES_MAX = 200;

// The role's artifact as the workspace holds it now: every regular file
// under its permitted paths (never through a link), in path order. A file
// or a total past its bound is named as left out, never truncated silently.
export function artifactState(workspace: string | null, paths: readonly string[]): ArtifactState {
  if (workspace === null) return { files: [], omitted: [], unknown: 'the session has no workspace yet' };
  const found: string[] = [];
  // What the walk could not read is unknown, never "no files" (the review's
  // N1): named, and the state as a whole is then unknown.
  const unreadable: string[] = [];
  const WALK_MAX = ARTIFACT_FILES_MAX * 4;
  let stopped = false;
  const walk = (rel: string) => {
    if (found.length >= WALK_MAX) {
      stopped = true;
      return;
    }
    let st;
    try {
      st = lstatSync(join(workspace, rel));
    } catch (err) {
      // A permitted path that does not exist is absent: the role has not
      // written it. Anything else could not be read.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(`${rel}: ${(err as NodeJS.ErrnoException).code ?? 'unreadable'}`);
      return;
    }
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = readdirSync(join(workspace, rel)).sort();
      } catch (err) {
        unreadable.push(`${rel}/: ${(err as NodeJS.ErrnoException).code ?? 'unreadable'}`);
        return;
      }
      for (const n of names) walk(rel === '' ? n : `${rel}/${n}`);
    } else if (st.isFile()) found.push(rel);
  };
  for (const p of paths) walk(p.endsWith('/') ? p.slice(0, -1) : p);
  const files: ArtifactState['files'] = [];
  const omitted: ArtifactState['omitted'] = [];
  let total = 0;
  for (const rel of [...new Set(found)].sort()) {
    if (files.length >= ARTIFACT_FILES_MAX) {
      omitted.push({ path: rel, why: `more than ${ARTIFACT_FILES_MAX} files` });
      continue;
    }
    const r = readRegular(workspace, relative(workspace, join(workspace, rel)), ARTIFACT_FILE_MAX);
    if (r.state !== 'read') {
      omitted.push({ path: rel, why: r.state === 'absent' ? 'absent' : `not read (${r.reason})` });
      continue;
    }
    if (total + r.bytes.length > ARTIFACT_TOTAL_MAX) {
      omitted.push({ path: rel, why: `the package's artifact bound (${ARTIFACT_TOTAL_MAX} bytes) is reached` });
      continue;
    }
    total += r.bytes.length;
    files.push({ path: rel, text: redactText(r.bytes.toString('utf8')) });
  }
  if (stopped) omitted.push({ path: paths.join(', '), why: `the walk stopped after ${WALK_MAX} files; what lies beyond is not listed` });
  const unknown = unreadable.length > 0 ? `parts of the artifact could not be read: ${unreadable.join('; ')}` : stopped ? `the walk stopped after ${WALK_MAX} files` : null;
  return { files, omitted, unknown };
}

export async function writeTurnPackage(rt: Runtime, claim: Claim, dir: string, workspace: string | null, canary: Record<string, unknown> | null = null): Promise<boolean> {
  const facts = await rt.read<SessionContextFacts | null>('session.context', { run: claim.run });
  if (facts === null) return false;
  const texts = new Map<string, string | null>();
  const repo = await rt.read<{ repo: string } | null>('project.repo', { project: claim.project });
  for (const a of facts.approved) texts.set(a.blob, repo === null ? null : await gitOk(repoContext(repo.repo), ['cat-file', 'blob', a.blob]));
  writeSessionPackage(dir, claim, facts, texts, artifactState(workspace, facts.paths), canary, await designPackageFor(rt, claim.run));
  return true;
}
