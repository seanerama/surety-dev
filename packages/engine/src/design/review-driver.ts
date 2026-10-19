// The review's main-thread steps (D7 §10.2, §10.3; SEAM.md §489): the
// engine's observations of the Alpha's web routes, fetched once per
// review-mode session through the service link (an HTTP GET over a tunnel
// to the running application; the bytes recorded, nothing rendered or run),
// and what a review-mode session's close reads of its review file.

import { createHash } from 'node:crypto';

import { Refusal } from '../refusal.js';

import { messageText } from '../git/commit.js';
import { git, repoContext } from '../git/exec.js';
import { listTree, treeOf } from '../git/repo.js';
import type { Journal } from '../journal/driver.js';
import { prepareCommit } from '../projects/commands.js';
import { writeWholeRecord } from '../records/files.js';
import { type Runtime, log } from '../runtime.js';
import type { SaveFacts } from '../sessions/session.js';
import { pausePoint } from '../testing/seam.js';
import { type Observation, type ReviewTarget, DELTA_KINDS, NOT_OBSERVED_REASONS, VERDICTS, isRequestPath } from './review.js';
import { isRefusedReview } from './paths.js';
import { type ReviewMove, refusedMoves } from './review-refused.js';

const REVIEWS = '.surety/design/reviews/';

// One GET of `route` from the application of `attempt`, through a tunnel:
// {status, bytes, truncated, reason}; `status` null with `reason` when no
// answer came (no tunnel, a refusal, a timeout): never invented.
async function fetchRoute(rt: Runtime, attempt: string, route: string, maxBytes: number, timeoutMs: number): Promise<{ status: number | null; bytes: Buffer; truncated: boolean; reason: string | null }> {
  // Never a request line the route could split (S1).
  if (!isRequestPath(route)) return { status: null, bytes: Buffer.alloc(0), truncated: false, reason: 'the route is not a request path, and is not asked for' };
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
  const target = await rt.read<ReviewTarget | null>('design.review_target', { project, run });
  // After a crash, the routes already observed are kept and only the others
  // are fetched or recorded (the slice-45 review's S3): compared by route.
  const missing = (target?.routes ?? []).filter((r) => !made.some((o) => o.screen === r.screen && o.route === r.route));
  if (made.length > 0 && missing.length === 0) return { observations: made, not_observed: target?.not_observed ?? [], unobservable: null };
  if (target === null) {
    if (made.length > 0) return { observations: made, not_observed: await rt.read<ReviewTarget['not_observed']>('design.not_observed', { project }), unobservable: null };
    const not_observed = await rt.read<ReviewTarget['not_observed']>('design.not_observed', { project });
    return { observations: [], not_observed, unobservable: 'no deployed service of this project runs supervised: nothing was observed' };
  }
  await pausePoint('review.before_fetch');
  const timeoutMs = rt.config.values.service_link_connect_timeout * 1000;
  // Bounded by the engine's adapter output bound (D7 §10.2; SEAM.md §526).
  const maxBytes = rt.config.values.adapter_output_max_bytes;
  // The running attempt must be the deployment the review is bound to (S2):
  // otherwise what answers is not the review's candidate, and nothing is
  // observed of it.
  const elsewhere =
    target.bound_deployment === null
      ? 'no deployment of the review\'s candidate is known: what runs is not observed as it'
      : target.running_operation !== target.bound_deployment
        ? `the running deployment (${target.running_operation ?? 'unknown'}) is not the review's (${target.bound_deployment})`
        : null;
  for (const r of missing) {
    const got = elsewhere !== null
      ? { status: null, bytes: Buffer.alloc(0), truncated: false, reason: elsewhere }
      : !isRequestPath(r.route)
        ? { status: null, bytes: Buffer.alloc(0), truncated: false, reason: 'the route is not a request path (printable, no space or control), and is not asked for' }
        : await fetchRoute(rt, target.attempt, r.route, maxBytes, Math.max(timeoutMs, 5000)).catch((err: Error) => {
            log('design review', err, { run, route: r.route });
            return { status: null, bytes: Buffer.alloc(0), truncated: false, reason: `the fetch failed (${err.message})` };
          });
    // Recorded through the redactor; the record holds what was answered,
    // nothing else, and the digest is of the bytes the engine holds (N2).
    const record = got.bytes.length > 0 ? await writeWholeRecord(rt, { project, run, kind: 'design_observation', content: got.bytes }).catch(() => null) : null;
    const held = record ? await rt.read<{ sha256: string | null; bytes: number | null } | null>('record.row', { record }) : null;
    await rt.engine('design.record_observation', {
      project,
      run,
      screen: r.screen,
      target: r.target,
      route: r.route,
      status: got.status,
      bytes: held?.bytes ?? got.bytes.length,
      digest: `sha256:${held?.sha256 ?? createHash('sha256').update(got.bytes).digest('hex')}`,
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
  // The newest by its number (review-10 after review-9; the slice-45 review's N4).
  const number = (path: string): number => Number(/review-(\d+)\.json$/.exec(path)?.[1] ?? -1);
  const files = [...entries.values()]
    // A refused review's file (H5) is never taken as the review.
    .filter((e) => e.type === 'blob' && e.path.startsWith(REVIEWS) && !isRefusedReview(e.path) && e.path.endsWith('.json') && !known.recorded.includes(e.oid))
    .sort((a, b) => number(a.path) - number(b.path) || a.path.localeCompare(b.path));
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
  // Never an invalid value recorded (the slice-45 review's B1): the check
  // refuses such a file at its save, and the close refuses it here too.
  const bad = (Array.isArray(review.screens) ? review.screens : []).find(
    (s) =>
      typeof s !== 'object' || s === null || typeof s.target !== 'string' || typeof (s.key ?? s.screen) !== 'string' || !(VERDICTS as readonly string[]).includes(String(s.verdict)) ||
      (s.not_observed_reason !== undefined && !(NOT_OBSERVED_REASONS as readonly string[]).includes(String(s.not_observed_reason))) ||
      (Array.isArray(s.deltas) && s.deltas.some((d) => typeof d !== 'object' || d === null || !(DELTA_KINDS as readonly string[]).includes(String((d as { kind?: unknown }).kind)))),
  );
  if (bad !== undefined || !Array.isArray(review.screens)) {
    throw new Refusal(422, 'design_check_failed', `The review file ${file.path} holds a verdict that is not B.14's: ${JSON.stringify(bad ?? review.screens).slice(0, 200)}.`, 'Correct the review in the session, save, and close again; or close with refuse.', { run: facts.run, file: file.path });
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
      review_path: file.path,
      verdicts,
      // B.14: the role revised the design in the same tree, or drew the
      // first one (D7 §10.3, §10.6); the close proposes it.
      revised_design: review.revised_design === true,
      first_design: review.first_design === true,
    },
  };
}

// A review-mode session ending without a recorded review (H5; SEAM.md §552):
// before it closes, each unrecorded `reviews/review-<n>.json` of the head
// moved to `reviews/refused/<run>-review-<n>.json`, the same blob, by one
// engine intent commit naming the run, and the branch moved to it; the
// finalizer emits one `design.review_refused` per file. Nothing to move (no
// review file, or the Designer already removed it): nothing committed and
// nothing emitted. Under the project's journal, from the read of the head
// to the drive. Throws if the move is not made: the caller's session stays
// open, to be closed again.
export async function moveRefusedReviews(rt: Runtime, journal: Journal, project: string, run: string): Promise<{ moved: ReviewMove[]; revision: string | null }> {
  return journal.withProject(
    project,
    async () => {
      const facts = await rt.read<{ repo: string; head: string | null }>('design.repo_facts', { project });
      if (facts.head === null) return { moved: [], revision: null };
      const ctx = repoContext(facts.repo);
      const tree = await treeOf(ctx, facts.head);
      const entries = tree === null ? null : await listTree(ctx, tree);
      if (entries === null) throw new Error(`the tree of the integration head ${facts.head} could not be read, so whether a refused review's file is left in active review is unknown`);
      const known = await rt.read<{ recorded: string[] }>('design.review_facts', { project, run });
      const moves = refusedMoves(entries.values(), known.recorded, run);
      if (moves.length === 0) return { moved: [], revision: null };
      const files: Record<string, null | { oid: string; mode: string }> = {};
      for (const m of moves) {
        files[m.from] = null;
        files[m.to] = { oid: m.blob, mode: m.mode };
      }
      const message = messageText({
        title: `surety: the review of session ${run} ended unrecorded; its file moved to reviews/refused/`,
        body: moves.map((m) => `${m.from} -> ${m.to} (${m.blob})`).join('\n'),
        trailers: [
          ['Surety-Project', project],
          ['Surety-Kind', 'intent'],
          ['Surety-Review-Refused', run],
        ],
      });
      const commit = await prepareCommit(facts.repo, facts.head, files, message, rt.scratch);
      if (commit === null) throw new Error("the commit moving the refused review's file could not be prepared");
      const made = await journal.intend('design.intend_review_refused', { project, repo: facts.repo, run, head: facts.head, commit, moves, deadlineSeconds: rt.setting('git_deadline') }, 'commit_tree');
      if (!('operation' in made)) throw new Refusal(409, 'integration_conflict', "The integration branch moved while the refused review's file was being moved; nothing was committed and the session is still open.", 'Close the session again.', { project, run });
      const settled = await journal.drive(made.operation);
      const follow = (settled.receipts as { follow?: unknown }).follow;
      if (settled.end !== 'finalized' || typeof follow !== 'string' || (await journal.drive(follow)).end !== 'finalized') {
        throw new Error("the commit moving the refused review's file, or the branch's move to it, did not finalize");
      }
      return { moved: moves, revision: commit.sha };
    },
    `design:review_refused:${run}`,
  );
}
