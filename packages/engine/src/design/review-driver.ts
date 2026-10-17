// The review's main-thread steps (D7 §10.2, §10.3; SEAM.md §489): the
// engine's observations of the Alpha's web routes, fetched once per
// review-mode session through the service link (an HTTP GET over a tunnel
// to the running application; the bytes recorded, nothing rendered or run),
// and what a review-mode session's close reads of its review file.

import { createHash } from 'node:crypto';

import { git, repoContext } from '../git/exec.js';
import { listTree, treeOf } from '../git/repo.js';
import { writeWholeRecord } from '../records/files.js';
import { type Runtime, log } from '../runtime.js';
import type { SaveFacts } from '../sessions/session.js';
import { pausePoint } from '../testing/seam.js';
import type { Observation, ReviewTarget } from './review.js';

const REVIEWS = '.surety/design/reviews/';

// One GET of `route` from the application of `attempt`, through a tunnel:
// {status, bytes, truncated}, or null when no tunnel opened.
async function fetchRoute(rt: Runtime, attempt: string, route: string, maxBytes: number, timeoutMs: number): Promise<{ status: number | null; bytes: Buffer; truncated: boolean } | null> {
  const sock = await rt.deploy?.services?.openTunnel(attempt, timeoutMs);
  if (!sock) return null;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const done = () => {
      clearTimeout(timer);
      sock.destroy();
      const bytes = Buffer.concat(chunks);
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(bytes.subarray(0, 64).toString('latin1'));
      resolve({ status: m ? Number(m[1]) : null, bytes, truncated });
    };
    const timer = setTimeout(done, timeoutMs);
    sock.on('data', (c: Buffer) => {
      if (size + c.length > maxBytes) {
        chunks.push(c.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        done();
        return;
      }
      chunks.push(c);
      size += c.length;
    });
    sock.on('end', done);
    sock.on('error', done);
    sock.write(`GET ${route} HTTP/1.1\r\nHost: localhost\r\nUser-Agent: surety-design-review\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
  });
}

// The observations of a review-mode session's run, made once.
export async function observationsFor(rt: Runtime, project: string, run: string): Promise<{ observations: Observation[]; not_observed: ReviewTarget['not_observed']; unobservable: string | null }> {
  const made = await rt.read<Observation[]>('design.observations', { run });
  const target = await rt.read<ReviewTarget | null>('design.review_target', { project });
  if (made.length > 0) return { observations: made, not_observed: target?.not_observed ?? [], unobservable: null };
  if (target === null) return { observations: [], not_observed: [], unobservable: 'no deployed service of this project runs supervised: nothing was observed' };
  await pausePoint('review.before_fetch');
  const timeoutMs = rt.config.values.service_link_connect_timeout * 1000;
  for (const r of target.routes) {
    const got = await fetchRoute(rt, target.attempt, r.route, target.max_bytes, Math.max(timeoutMs, 5000)).catch((err) => {
      log('design review', err, { run, route: r.route });
      return null;
    });
    const bytes = got?.bytes ?? Buffer.alloc(0);
    let record: string | null = null;
    if (got !== null) record = await writeWholeRecord(rt, { project, run, kind: 'design_observation', content: bytes }).catch(() => null);
    await rt.engine('design.record_observation', {
      project,
      run,
      screen: r.screen,
      target: r.target,
      route: r.route,
      status: got?.status ?? null,
      bytes: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      truncated: got?.truncated ?? false,
      record,
    });
  }
  await pausePoint('review.after_fetch');
  return { observations: await rt.read<Observation[]>('design.observations', { run }), not_observed: target.not_observed, unobservable: null };
}

// A review-mode close (D7 §10.3): the newest review file of the head not
// yet recorded, its verdicts recorded as proposals. null: none written.
export async function reviewRaise(rt: Runtime, facts: SaveFacts): Promise<Record<string, unknown> | null> {
  if (facts.head === null) return null;
  const ctx = repoContext(facts.repo);
  const tree = await treeOf(ctx, facts.head);
  const entries = tree === null ? null : await listTree(ctx, tree);
  if (entries === null) return null;
  const known = await rt.read<{ design_revision: string | null; alpha_review: boolean; recorded: string[] }>('design.review_facts', { project: facts.project, run: facts.run });
  const files = [...entries.values()].filter((e) => e.type === 'blob' && e.path.startsWith(REVIEWS) && e.path.endsWith('.json') && !known.recorded.includes(e.oid)).sort((a, b) => a.path.localeCompare(b.path));
  const file = files.at(-1);
  if (!file) return null;
  const r = await git(ctx, ['cat-file', 'blob', file.oid]);
  if (r.code !== 0) return null;
  let review: { subject?: Record<string, unknown>; screens?: Record<string, unknown>[] };
  try {
    review = JSON.parse(r.bytes.toString('utf8')) as typeof review;
  } catch {
    return null;
  }
  const verdicts = (Array.isArray(review.screens) ? review.screens : []).map((s) => ({
    target: String(s.target),
    screen: String(s.key ?? s.screen),
    verdict: String(s.verdict),
    ...(typeof s.not_observed_reason === 'string' ? { not_observed_reason: s.not_observed_reason } : {}),
    ...(typeof s.observed_on === 'string' ? { observed_on: s.observed_on } : {}),
    evidence: Array.isArray(s.evidence) ? s.evidence : [],
    deltas: Array.isArray(s.deltas) ? s.deltas : [],
    status: 'proposed',
  }));
  return {
    kind: 'review',
    review: {
      project: facts.project,
      run: facts.run,
      design_revision: known.design_revision,
      trigger: known.alpha_review ? 'alpha_complete' : 'owner_command',
      subject: review.subject ?? {},
      review_blob: file.oid,
      verdicts,
    },
  };
}
