// The idea record's text on the project read (first-app gap N4): the store
// serves the idea's blob, and this reads that blob's bytes from the
// project's repository on the main thread, through the git choke point.
// Text that cannot be read is said to be unknown, with why; never empty.

import { SHA, git, repoContext } from '../git/exec.js';

export type IdeaText = string | { unknown: string };

// A blob's text is fixed by its id, so a read once made is kept (bounded).
const CACHE_LIMIT = 64;
const cache = new Map<string, string>();

export async function ideaText(repo: string | null, blob: unknown): Promise<IdeaText> {
  if (typeof blob !== 'string' || !SHA.test(blob)) return { unknown: 'the idea record has no readable blob id' };
  const kept = cache.get(blob);
  if (kept !== undefined) return kept;
  if (repo === null) return { unknown: "the project's repository is not known" };
  let r: Awaited<ReturnType<typeof git>>;
  try {
    r = await git(repoContext(repo), ['cat-file', 'blob', blob]);
  } catch {
    return { unknown: `the idea record's blob ${blob} could not be read from the project's repository` };
  }
  if (r.code !== 0) return { unknown: `the idea record's blob ${blob} could not be read from the project's repository` };
  const text = r.bytes.toString('utf8');
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(blob, text);
  return text;
}

// GET /v1/projects/:p's body with `project.idea.text` added when the project
// has an idea record; the body is otherwise as the store served it.
export async function withIdeaText(body: unknown, repoOf: () => Promise<{ repo: string } | null>): Promise<unknown> {
  const project = (body as { project?: { idea?: Record<string, unknown> | null } } | null)?.project;
  const idea = project?.idea;
  if (!idea || typeof idea !== 'object') return body;
  const kept = typeof idea.blob === 'string' ? cache.get(idea.blob) : undefined;
  const text = kept ?? (await ideaText((await repoOf().catch(() => null))?.repo ?? null, idea.blob));
  project!.idea = { ...idea, text };
  return body;
}
