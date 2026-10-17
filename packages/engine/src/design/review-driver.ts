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
// {status, bytes, truncated, reason}; `status` null with `reason` when no
// answer came (no tunnel, a refusal, a timeout): never invented.
async function fetchRoute(rt: Runtime, attempt: string, route: string, maxBytes: number, timeoutMs: number): Promise<{ status: number | null; bytes: Buffer; truncated: boolean; reason: string | null }> {
  const sock = await rt.deploy?.services?.openTunnel(attempt, timeoutMs);
  if (!sock) return { status: null, bytes: Buffer.alloc(0), truncated: false, reason: 'no tunnel to the running application opened through the service link' };
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let why: string | null = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      const bytes = Buffer.concat(chunks);
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(bytes.subarray(0, 64).toString('latin1'));
      resolve({ status: m ? Number(m[1]) : null, bytes, truncated, reason: m ? null : (why ?? (bytes.length === 0 ? 'the application closed the connection without answering' : 'the answer is not an HTTP response')) });
    };
    const timer = setTimeout(() => {
      why = `no answer within ${Math.round(timeoutMs / 1000)} s`;
      done();
    }, timeoutMs);
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
    sock.on('error', (err: NodeJS.ErrnoException) => {
      why = `the connection failed (${err.code ?? err.message})`;
      done();
    });
    sock.write(`GET ${route} HTTP/1.1\r\nHost: localhost\r\nUser-Agent: surety-design-review\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
  });
}

// The observations of a review-mode session's run, made once.
export async function observationsFor(rt: Runtime, project: string, run: string): Promise<{ observations: Observation[]; not_observed: ReviewTarget['not_observed']; unobservable: string | null }> {
  const made = await rt.read<Observation[]>('design.observations', { run });
  const target = await rt.read<ReviewTarget | null>('design.review_target', { project });
  if (made.length > 0) return { observations: made, not_observed: target?.not_observed ?? [], unobservable: null };
  if (target === null) {
    const not_observed = await rt.read<ReviewTarget['not_observed']>('design.not_observed', { project });
    return { observations: [], not_observed, unobservable: 'no deployed service of this project runs supervised: nothing was observed' };
  }
  await pausePoint('review.before_fetch');
  const timeoutMs = rt.config.values.service_link_connect_timeout * 1000;
  // Bounded by the engine's adapter output bound (D7 §10.2; SEAM.md §526).
  const maxBytes = rt.config.values.adapter_output_max_bytes;
  for (const r of target.routes) {
    const got = await fetchRoute(rt, target.attempt, r.route, maxBytes, Math.max(timeoutMs, 5000)).catch((err: Error) => {
      log('design review', err, { run, route: r.route });
      return { status: null, bytes: Buffer.alloc(0), truncated: false, reason: `the fetch failed (${err.message})` };
    });
    const bytes = got.bytes;
    // Recorded through the redactor; the record holds what was answered, nothing else.
    const record = bytes.length > 0 ? await writeWholeRecord(rt, { project, run, kind: 'design_observation', content: bytes }).catch(() => null) : null;
    await rt.engine('design.record_observation', {
      project,
      run,
      screen: r.screen,
      target: r.target,
      route: r.route,
      status: got.status,
      bytes: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      truncated: got.truncated,
      record,
      reason: got.reason,
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
  let review: { subject?: Record<string, unknown>; screens?: Record<string, unknown>[]; revised_design?: unknown; first_design?: unknown };
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
      // B.14: the role revised the design in the same tree, or drew the
      // first one (D7 §10.3, §10.6); the close proposes it.
      revised_design: review.revised_design === true,
      first_design: review.first_design === true,
    },
  };
}
