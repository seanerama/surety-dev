// The session's main-thread steps (D6 §§2.1 to 2.5, 3.4; B01, B02; SEAM.md
// §§344, 346): the dispatch of admitted turns at a tick, a turn's settlement
// after its role exits, the save (snapshot, validation, the checkpoint commit
// and its integration through the journal, the parse of the role's products
// at the checkpoint) and the close (a save if the workspace differs, the
// Architect's bundle and its plan check, the decision the product calls for,
// the run's end). No transaction is held across a git call; each store step
// is one engine transition of sessions/session.ts, plan/bundle.ts or the
// journal.

import { nowIso } from '../clock.js';
import { commitContent, messageText } from '../git/commit.js';
import { repoContext, worktreeContext } from '../git/exec.js';
import { catBlob, listTree, treeOf } from '../git/repo.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type MetadataBaseline, captureMetadata, indexHashOfTree, snapshotTree, validateDiff } from '../git/snapshot.js';
import type { Launcher } from '../invoke/choke.js';
import { materialize } from '../invoke/sandbox/materialize.js';
import type { Journal } from '../journal/driver.js';
import { commitId } from '../journal/effects.js';
import { type BundleArtifacts, type PlanCheckResult, checkPlan } from '../plan/check.js';
import type { BaselineFacts, BundleContent } from '../plan/bundle.js';
import { type Finding, architectFindings, ideaFindings, specFindings } from '../plan/findings.js';
import { MODULES_FILE, PLAN_FILE, ROADMAP_FILE } from '../plan/schemas.js';
import { writeWholeRecord } from '../records/files.js';
import { redactText, redactValue } from '../records/redact.js';
import { Refusal } from '../refusal.js';
import { pausePoint } from '../testing/seam.js';
import { type RunHandle, type Runtime, log } from '../runtime.js';
import type { RunEnder } from '../runs/end.js';
import { canonical } from '../store/transitions/common.js';
import type { SpecRepresentation } from '../spec/semantics.js';
import { SESSION_PATHS, type SaveFacts, type SaveOutcome, type SessionRole } from './session.js';

const inPaths = (role: SessionRole, path: string): boolean => SESSION_PATHS[role].some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

export interface SaveAnswer {
  saved: boolean;
  revision: string | null;
  idle_generation: number;
  findings: Finding[];
}

export class SessionDriver {
  constructor(
    private readonly rt: Runtime,
    private readonly journal: Journal,
    private readonly launcher: Launcher,
    private readonly ender: RunEnder,
  ) {}

  // ---- open and resume (D6 §2.1, §2.4, §2.7; D1 §15.2, §15.3) -------------------------

  // A session is a run with a grant, a workspace and a lease, and no process
  // (D6-S01): the run, its grant and its lease in one transaction (after
  // the opening's admission read and barrier, SEAM.md §389), then its
  // workspace, a worktree of the project at the run's base made through the
  // journal as any run's is (D1 §7.3). A workspace that cannot be made ends
  // the run; the opening is refused.
  async open(project: string, args: { role: unknown; model?: unknown; scripted: string | null }): Promise<{ status: number; body: unknown }> {
    await this.rt.read('session.open_guard', { project });
    await pausePoint('session.admission');
    const made = await this.rt.engine<{ run: Record<string, unknown> }>('session.open_tx', { project, ...args });
    return this.withWorkspace(project, made.run.id as string);
  }

  async resume(project: string, run: string, args: { dirty: { workspace: string; base: string; tree: string | null; unknown?: string } | null; scripted: string | null }): Promise<{ status: number; body: unknown }> {
    await this.rt.read('session.open_guard', { project });
    await pausePoint('session.admission');
    const made = await this.rt.engine<{ run: Record<string, unknown>; offered: string | null }>('session.resume_tx', { project, run, ...args });
    const answer = await this.withWorkspace(project, made.run.id as string);
    return { status: answer.status, body: { ...(answer.body as object), offered: made.offered } };
  }

  private async withWorkspace(project: string, run: string): Promise<{ status: number; body: unknown }> {
    let failure: string | null = null;
    try {
      failure = await this.makeWorkspace(project, run);
    } catch (err) {
      failure = redactText((err as Error).message);
    }
    if (failure !== null) {
      await this.ender.endRun(run, { outcome: 'failed', reason: 'infra_error', reasonText: `the session's workspace could not be made: ${failure}` }).catch((err) => log('session open', err, { run }));
      throw new Refusal(500, 'infra_error', `The workspace of session ${run} could not be made: ${failure}.`, 'Read the run; open the session again.', { run });
    }
    const view = await this.rt.read<{ run: Record<string, unknown> }>('session.view', { project, run });
    return { status: 201, body: { run: { ...view.run, workspace: view.run.workspace ?? null } } };
  }

  // The worktree at the run's base (D1 §7.3: `git worktree add --detach`,
  // journaled), its baseline fixed with the intent and what lies outside its
  // diff captured, as the choke point does for a one-shot run.
  private async makeWorkspace(project: string, run: string): Promise<string | null> {
    const f = await this.rt.read<{ repo: string; base: string }>('session.open_facts', { run });
    const ctx = repoContext(f.repo);
    const tree = await treeOf(ctx, f.base).catch(() => null);
    const index = tree === null ? null : await indexHashOfTree(ctx, tree).catch(() => null);
    if (tree === null || index === null) return `the base ${f.base} could not be read`;
    const baseline = { head: f.base, index_hash: index, tracked_tree_hash: tree };
    const path = join(this.rt.home, 'workspaces', run);
    mkdirSync(join(this.rt.home, 'workspaces'), { recursive: true, mode: 0o700 });
    const intent = await this.journal.withProject(project, () =>
      this.journal.intend(
        'journal.intend',
        {
          project,
          kind: 'worktree_add',
          payload: { repo: f.repo, run, path, base: f.base },
          target: { repo: f.repo, path },
          subject: { run, action: 'worktree_add' },
          finalizer: { purpose: 'workspace', run, path, base: f.base, baseline },
          deadlineSeconds: this.rt.setting('git_deadline'),
        },
        'worktree_add',
      ),
    );
    if (!('operation' in intent)) return 'the worktree was not intended';
    const settled = await this.journal.withProject(project, () => this.journal.drive(intent.operation));
    const workspace = settled.receipts.workspace as string | undefined;
    if (settled.end !== 'finalized' || workspace === undefined) return `the worktree was not made (${settled.end})`;
    const metadata = await captureMetadata(f.repo, path);
    if (metadata === null) return "what lies outside the workspace's diff could not be captured";
    await this.rt.engine('workspace.metadata', { workspace, metadata });
    return null;
  }

  // ---- the tick: admitted turns dispatched (D1 §15.1; SEAM.md §344) -------------------

  async dispatchTurns(): Promise<number> {
    const pending = await this.rt.read<{ run: string; project: string; invocation: string; repo: string; branch: string }[]>('session.pending_turns', {});
    let n = 0;
    for (const t of pending) {
      try {
        if (await this.launcher.dispatchTurn({ project: t.project, repo: t.repo, branch: t.branch }, { run: t.run, invocation: t.invocation })) n++;
      } catch (err) {
        log('turn dispatch', err, { run: t.run });
      }
    }
    return n;
  }

  // ---- a turn's settlement (D6 §2.1, §2.4; B01; D6-S10; SEAM.md §389) ----------------

  // The role has exited. The turn is settled in this order, each fact
  // established (durably) before its barrier and before the next is tried:
  // (1) `terminated`, its domain's termination with closure; (2)
  // `collected`, what it left collected and materialized into the session's
  // workspace through the secret screen (on the real boundary); (3)
  // `reply_recorded`, its reply or failure in the transcript through the
  // redactor; (4) `usage_recorded`, its terminal observation and its one
  // ledger row, an unknown remainder charged by D2's policy. Then the
  // session is idle at the next generation. A turn whose run the engine
  // has decided to end (a Stop, a deadline, a lease lost) is left to the
  // run-end protocol, which settles it `unknown` with nothing taken late;
  // each transition below also refuses a turn that is no longer open.
  async settle(handle: RunHandle): Promise<void> {
    const { run, invocation, project, domain } = handle.claim;
    const ending = async (): Promise<boolean> => {
      if (handle.ending || handle.controlAfterExit !== null) {
        if (!handle.ending && handle.controlAfterExit !== null) {
          // A Stop or an Abandon confirmed while the turn settled: it ends
          // the session, whose end protocol settles the turn.
          const control = handle.controlAfterExit;
          this.rt.requestEnd(handle, control === 'stop' ? { outcome: 'stopped', reason: 'human_stop' } : { outcome: 'abandoned', reason: 'human_abandon' }, { afterExit: true });
        }
        return true;
      }
      return !(await this.rt.engine<boolean>('session.turn_open', { run, invocation }).catch(() => false));
    };
    try {
      const terminated = await this.ender.terminateDomains(run);
      if (!terminated) {
        this.rt.requestEnd(handle, { outcome: 'failed', reason: 'infra_error', reasonText: "the termination of the turn's domain could not be established; the turn is not settled" }, { afterExit: true });
        return;
      }
      if (!handle.terminatedFired) {
        handle.terminatedFired = true;
        await pausePoint('session.turn_settling.terminated');
      }
      if (await ending()) {
        return;
      }
      // (2) On the real boundary what the turn wrote is on its domain's
      // volatile filesystem: it reaches the session's workspace now, through
      // the secret screen, so that a save sees it (D2 §§2.3, 2.5; D6 §2.4);
      // the hold is then dropped, before the next turn's domain is placed.
      let materializeFailure: string | null = null;
      const hold = handle.sandbox?.volatile ?? null;
      if (handle.sandbox !== null && hold !== null && hold.held && handle.workspacePath !== null && !handle.materialized) {
        const p = await this.rt.read<Record<string, number>>('project.policy', { project }).catch(() => ({}) as Record<string, number>);
        const caps = { files: p.snapshot_max_files ?? 10_000, bytes: p.snapshot_max_bytes ?? 64 * 1024 * 1024, fileBytes: p.snapshot_max_file_bytes ?? 16 * 1024 * 1024 };
        const m = materialize({ hold, home: this.rt.home, workspace: handle.workspacePath, caps });
        if (m.state === 'refused') {
          if (m.reason === 'secret') {
            await this.rt.engine('evidence.secret_refused', { run, domain, what: 'materialization', path: m.path === null ? null : redactText(m.path), by: null }).catch(() => {});
          }
          materializeFailure = `what the turn wrote could not be taken into the workspace (${m.reason}): ${redactText(m.detail)}`;
        } else handle.materialized = true;
      }
      handle.sandbox?.releaseVolatile();
      await pausePoint('session.turn_settling.collected');
      if (await ending()) {
        return;
      }
      // (3)
      const reply = materializeFailure === null && handle.sessionReply !== null && handle.sessionReply !== 'invalid' && handle.exit?.code === 0 ? handle.sessionReply : null;
      const failure =
        reply !== null
          ? null
          : materializeFailure !== null
            ? materializeFailure
            : handle.sessionReply === 'invalid'
              ? "the role's result is not a turn's result (D6 B.7)"
              : handle.sessionReply === null
                ? 'the role exited without a result'
                : `the role exited with status ${String(handle.exit?.code ?? handle.exit?.signal ?? 'unknown')}`;
      const text = reply !== null ? reply.reply : `The turn failed: ${failure}.`;
      const record = await writeWholeRecord(this.rt, { project, run, kind: 'session_transcript', content: Buffer.from(text) }).catch((err) => {
        log('turn record', err, { run });
        return null;
      });
      await this.rt.engine('session.turn_reply', { run, invocation, reply, failure, textRecord: record });
      await pausePoint('session.turn_settling.reply_recorded');
      if (await ending()) {
        return;
      }
      // (4)
      const exit = await this.rt.read<{ exit_class: string | null; exit_evidence: string | null } | null>('domain.exit_of', { domain }).catch(() => null);
      await this.rt.engine('session.turn_usage', { run, invocation, exit });
      await pausePoint('session.turn_settling.usage_recorded');
      if (await ending()) {
        return;
      }
      const settled = await this.rt.engine<{ settled: boolean }>('session.settle', { run, invocation });
      // A settlement that leaves the session's cumulative budget spent
      // closes it at once by the idle protocol (D1 §13.3 "between session
      // turns"; D6 §2.4; the review's M5).
      if (settled.settled && (await this.rt.read<boolean>('session.budget_spent', { run }).catch(() => false))) {
        this.rt.handles.delete(run);
        await this.closeByProtocol(project, run, 'budget_exhausted').catch((err) => log('session close', err, { run }));
      }
    } finally {
      // A run the engine decided to end keeps its handle for the run-end
      // protocol; otherwise the turn is done with it.
      if (!handle.ending) this.rt.handles.delete(run);
    }
  }

  // ---- save (D6 §2.4, §2.5; B01, B02) -------------------------------------------------

  // The admission of a save, a close or a turn (D6 §2.4; B01; SEAM.md §389):
  // the session read, the `session.admission` barrier, and then the
  // compare-and-swap the transition makes on what was read.
  async admission(project: string, run: string): Promise<number | null> {
    const read = await this.rt.read<{ idle: boolean; idle_generation: number } | null>('session.admission_read', { project, run });
    await pausePoint('session.admission');
    return read !== null && read.idle ? read.idle_generation : null;
  }

  async save(project: string, run: string, opts: { expectedGeneration?: number | null } = {}): Promise<SaveAnswer> {
    const admittedAt = await this.admission(project, run);
    const facts = await this.rt.engine<SaveFacts>('session.begin_save', { project, run, admittedAt, expectedGeneration: opts.expectedGeneration ?? null });
    const outcome: SaveOutcome = { project, run, committed: null, refused: null, findings: [], notesRecord: null, products: {}, nothingToSave: false };
    let refusal: Refusal | null = null;
    try {
      const made = await this.checkpoint(facts);
      if ('refused' in made) {
        outcome.refused = { code: made.refused.code, text: made.refused.text };
        refusal = made.refused.refusal;
      } else if (made.sha === null) outcome.nothingToSave = true;
      else {
        const parsed = await this.parse(facts, made.sha);
        outcome.committed = { sha: made.sha, blobs: parsed.blobs };
        // What a finding quotes of a file is role text: through the
        // redactor before the transcript and the notes keep it (D1 §14.2).
        outcome.findings = parsed.findings.map((f) => ({ ...f, message: redactText(f.message), subject: redactValue(f.subject) as Record<string, unknown> }));
        outcome.products = parsed.products;
      }
    } catch (err) {
      log('session save', err, { run });
      outcome.refused = { code: 'infra_error', text: redactText((err as Error).message) };
      refusal = new Refusal(500, 'infra_error', `The save of session ${run} could not be completed: ${outcome.refused.text}.`, 'Read the session; the workspace keeps the change.', { run });
    }
    if (outcome.refused || outcome.findings.length > 0) {
      // The engine's entry (D6 §2.3, §3.2): what the save found, as a record
      // the next turn's package and the transcript read carry.
      const lines = [...(outcome.refused ? [`The save was refused (${outcome.refused.code}): ${outcome.refused.text} The workspace keeps the change.`] : []), ...outcome.findings.map((f) => `${f.code}${f.path ? ` (${f.path})` : ''}: ${f.message}`)];
      outcome.notesRecord = await writeWholeRecord(this.rt, { project, run, kind: 'session_transcript', content: Buffer.from(lines.join('\n')) }).catch(() => null);
    }
    const done = await this.rt.engine<{ idle_generation: number; saved: boolean; standing?: Finding[] }>('session.finish_save', outcome);
    if (refusal) throw refusal;
    // A save with nothing new answers with what the engine found at the
    // checkpoint that stands: the artifact as saved is unchanged, and so is
    // what is wrong with it.
    return { saved: done.saved, revision: outcome.committed?.sha ?? null, idle_generation: done.idle_generation, findings: outcome.nothingToSave ? (done.standing ?? []) : outcome.findings };
  }

  // The snapshot, its validation against the role's paths, the checkpoint
  // commit on the workspace's current base and its integration by a
  // compare-and-swap of the integration branch. `sha` null: nothing differs.
  private async checkpoint(facts: SaveFacts): Promise<{ sha: string | null } | { refused: { code: string; text: string; refusal: Refusal } }> {
    const ws = facts.workspace;
    if (!ws || !ws.metadata) return { sha: null };
    const metadata = ws.metadata as unknown as MetadataBaseline;
    const ctx = repoContext(facts.repo);
    const tree = await snapshotTree(worktreeContext(facts.repo, metadata.adminDir, ws.path), ws.current_base, this.rt.scratch);
    if (tree === null) throw new Error('the workspace could not be snapshotted');
    if (tree === (await treeOf(ctx, ws.current_base))) return { sha: null };
    const diff = await validateDiff(facts.repo, ws.current_base, tree, facts.role, facts.caps, facts.roots, { plans: false });
    if (diff.violation) {
      // The paths outside the role's own, and the one the refusal names (a
      // link inside them that resolves outside, D6-W03).
      const paths = [...new Set([...diff.changes.map((c) => c.path).filter((p) => !inPaths(facts.role, p)), ...(diff.violation.path !== undefined ? [diff.violation.path] : [])])];
      const text = redactText(diff.violation.text);
      const status = diff.violation.klass === 'diff_violation' ? 422 : 500;
      return {
        refused: {
          code: diff.violation.klass,
          text,
          refusal: new Refusal(status, diff.violation.klass, `The save of session ${facts.run} was refused: ${text}.`, `Keep the session's changes within ${SESSION_PATHS[facts.role].join(', ')}; the workspace keeps the change.`, { run: facts.run, paths }),
        },
      };
    }
    if (facts.head !== ws.current_base) {
      const text = `the integration branch is at ${facts.head ?? 'no registered commit'}, not at the session's checkpoint base ${ws.current_base}`;
      return { refused: { code: 'integration_conflict', text, refusal: new Refusal(409, 'integration_conflict', `The save of session ${facts.run} was refused: ${text}.`, 'Close the session and open a new one on the current branch; the workspace keeps the change.', { run: facts.run, head: facts.head, base: ws.current_base }) } };
    }
    const message = messageText({
      title: `session ${facts.run} (${facts.role}): checkpoint after turn ${facts.turn}`,
      trailers: [
        ['Surety-Run', facts.run],
        ['Surety-Role', facts.role],
        ['Surety-Base', ws.current_base],
        ['Surety-Kind', 'checkpoint'],
      ],
    });
    const content = commitContent({ tree, parent: ws.current_base, message, at: nowIso() });
    const sha = await commitId(facts.repo, content);
    if (sha === null) throw new Error('the checkpoint commit could not be prepared: the repository could not be read');
    const deadlineSeconds = this.rt.setting('git_deadline');
    const committed = await this.journal.withProject(facts.project, async () => {
      const intent = await this.journal.intend(
        'accept.intend_commit',
        { project: facts.project, repo: facts.repo, run: facts.run, purpose: 'run', tree, parent: ws.current_base, sha, content, revisionKind: 'checkpoint', checkpoint: true, workspace: ws.id, deadlineSeconds },
        'commit_tree',
      );
      if (!('operation' in intent)) return false;
      return (await this.journal.drive(intent.operation)).end === 'finalized';
    });
    if (!committed) throw new Error('the checkpoint commit was not made');
    const integrated = await this.journal.withProject(facts.project, async () => {
      const intent = await this.journal.intend('session.intend_checkpoint', { project: facts.project, run: facts.run, repo: facts.repo, head: ws.current_base, commit: sha, deadlineSeconds }, 'ref_update');
      if (!('operation' in intent)) return { end: 'failed' as const, detail: null };
      const settled = await this.journal.drive(intent.operation);
      return { end: settled.end, detail: settled.op.outcome_detail ?? null };
    });
    if (integrated.end !== 'finalized') {
      const text = `the checkpoint ${sha} was committed and not integrated (${integrated.end}${integrated.detail ? `: ${JSON.stringify(integrated.detail)}` : ''})`;
      return { refused: { code: 'integration_conflict', text, refusal: new Refusal(409, 'integration_conflict', `The save of session ${facts.run} was refused: ${text}.`, 'Read the session and the integration branch; the workspace keeps the change.', { run: facts.run, commit: sha }) } };
    }
    return { sha };
  }

  // The parse at save of the role's products (SEAM.md §346): every file of
  // its paths at the checkpoint, read from the commit, never from the reply.
  private async parse(facts: SaveFacts, sha: string): Promise<{ blobs: Record<string, string>; findings: Finding[]; products: SaveOutcome['products'] }> {
    const { blobs, texts } = await this.productFiles(facts.repo, sha, facts.role);
    if (facts.role === 'vision') {
      const text = texts['.surety/idea.md'];
      if (text === undefined) return { blobs, findings: [], products: {} };
      const r = ideaFindings(text);
      return { blobs, findings: r.findings, products: { identity: r.identity } };
    }
    if (facts.role === 'spec_writer') {
      const text = texts['.surety/spec/spec.md'];
      if (text === undefined) return { blobs, findings: [], products: {} };
      // The project's previous save, against which a key renumbered or gone
      // is named (M421 (c)); read before this save's representation exists.
      const prev = await this.rt.read<SpecRepresentation | null>('spec.previous_representation', { project: facts.project });
      const withdrawn = await this.rt.read<string[]>('spec.withdrawn_keys', { project: facts.project });
      const r = specFindings(text, '.surety/spec/spec.md', prev, withdrawn);
      return {
        blobs,
        findings: r.findings,
        products: { spec: { blob: blobs['.surety/spec/spec.md']!, digest: r.semantics.digest, representation: r.semantics.representation, findings: r.semantics.findings, readable: r.semantics.readable } },
      };
    }
    const base = await this.rt.read<BaselineFacts>('session.bundle_baseline', { project: facts.project, head: facts.base_revision, withPlan: false });
    const r = architectFindings({ files: texts }, { requirement_keys: base.requirement_keys, spec_modules: base.spec_modules, descriptive_keys: base.descriptive_keys });
    return { blobs, findings: r.findings, products: {} };
  }

  private async productFiles(repo: string, rev: string, role: SessionRole): Promise<{ blobs: Record<string, string>; texts: Record<string, string> }> {
    const ctx = repoContext(repo);
    const tree = await treeOf(ctx, rev);
    const entries = tree === null ? null : await listTree(ctx, tree);
    if (entries === null) throw new Error(`the tree of ${rev} could not be read`);
    const blobs: Record<string, string> = {};
    const texts: Record<string, string> = {};
    for (const e of [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      if (e.type !== 'blob' || !inPaths(role, e.path)) continue;
      blobs[e.path] = e.oid;
      const text = await catBlob(ctx, rev, e.path);
      if (text === null) throw new Error(`${e.path} at ${rev} could not be read`);
      texts[e.path] = text;
    }
    return { blobs, texts };
  }

  // ---- close (D6 §2.4, §3.4; SEAM.md §344) ----------------------------------------------

  async close(project: string, run: string, opts: { refuse: boolean; expectedGeneration?: number | null }): Promise<Record<string, unknown>> {
    const answer = await this.save(project, run, { expectedGeneration: opts.expectedGeneration ?? null });
    const saved = answer.saved ? { revision: answer.revision } : null;
    await pausePoint('session.close_saved');
    // The close holds the generation its own save left (B01): a turn
    // admitted since wins it, and the close is refused
    // `session_generation_stale` rather than losing that turn.
    const admittedAt = answer.idle_generation;
    const facts = await this.rt.engine<SaveFacts & { session_state: string }>('session.close_facts', { project, run, admittedAt });
    let raise: Record<string, unknown> = { kind: 'none' };
    if (!opts.refuse) {
      if (facts.role === 'vision') raise = { kind: 'idea_accept' };
      else if (facts.role === 'spec_writer') raise = { kind: 'spec_approval' };
      else raise = await this.bundle(facts);
    }
    let closed: { decisions: { id: string; kind: string; batch_key: string | null }[] };
    try {
      closed = await this.rt.engine('session.close', { project, run, raise, admittedAt });
    } catch (err) {
      // A bundle recorded for a close that lost its generation is stale,
      // never a proposal awaiting a decision that was not raised.
      if (raise.kind === 'bundle') await this.rt.engine('session.bundle_stale', { bundle: raise.bundle, reason: 'the close that recorded it was refused' }).catch((e) => log('bundle', e, { run }));
      throw err;
    }
    await this.ender.endRun(run, { outcome: 'completed', reason: 'none' });
    const summary = await this.rt.read<{ run: Record<string, unknown> }>('session.view', { project, run });
    return { run: summary.run, saved, decisions: closed.decisions.map((d) => ({ id: d.id, kind: d.kind, ...(d.batch_key ? { batch_key: d.batch_key } : {}) })) };
  }

  // ---- idle timeout and budget exhaustion: one protocol (D6 §2.4; B01) ----------------

  // At each tick: every session idle past `session_idle_timeout` is closed
  // by the engine (`budget_exhausted` if its budget was spent meanwhile). A
  // session whose budget a turn's settlement spends is closed at that
  // settlement, and a turn refused on it closes it too (D1 §13.3).
  async sweep(): Promise<number> {
    const due = await this.rt.read<{ run: string; project: string; cause: 'idle_timeout' | 'budget_exhausted' }[]>('session.due_closes', { at: nowIso() });
    let n = 0;
    for (const d of due) {
      try {
        if (await this.closeByProtocol(d.project, d.run, d.cause)) n++;
      } catch (err) {
        log('session close', err, { run: d.run, cause: d.cause });
      }
    }
    return n;
  }

  // The save, or the retained workspace recorded when the save is refused
  // (the refusal is the engine's entry and the workspace keeps the change);
  // then `closing` under the generation the save left, the product's
  // decision raised only if the product parses, and the end protocol:
  // `timed_out` (`deadline`) or `stopped` (`budget`, public code
  // `budget_exhausted`). Nothing in the workspace is lost; the grant and the
  // lease are released by the run's end. false when another admission won.
  async closeByProtocol(project: string, run: string, cause: 'idle_timeout' | 'budget_exhausted'): Promise<boolean> {
    // The generation the save takes, and leaves (a save does not advance
    // it, SEAM.md §394): the close holds that one, as close() does (the
    // review's N4); a turn admitted meanwhile wins and the close is stale.
    const before = await this.rt.read<{ idle: boolean; idle_generation: number } | null>('session.admission_read', { project, run });
    if (before === null || !before.idle) return false;
    let answer: SaveAnswer | null = null;
    try {
      answer = await this.save(project, run, { expectedGeneration: before.idle_generation });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'session_not_idle' || code === 'session_generation_stale' || code === 'not_found') return false;
      // The save was refused and recorded: the close goes on.
      answer = null;
    }
    const admittedAt = answer?.idle_generation ?? before.idle_generation;
    const facts = await this.rt.engine<SaveFacts>('session.close_facts', { project, run, admittedAt });
    let raise: Record<string, unknown> = { kind: 'none' };
    // The product parses: a checkpoint of this session stands, the save
    // found nothing wrong with it, and none was refused just now.
    if (answer !== null && answer.findings.length === 0 && facts.head !== null && facts.head !== facts.base_revision) {
      if (facts.role === 'vision') raise = { kind: 'idea_accept' };
      else if (facts.role === 'spec_writer') raise = { kind: 'spec_approval' };
      else raise = await this.bundle(facts).catch(() => ({ kind: 'none' }));
    }
    try {
      await this.rt.engine('session.close', { project, run, raise, admittedAt, cause });
    } catch (err) {
      if (raise.kind === 'bundle') await this.rt.engine('session.bundle_stale', { bundle: raise.bundle, reason: 'the close that recorded it was refused' }).catch((e) => log('bundle', e, { run }));
      const code = (err as { code?: string }).code;
      if (code === 'session_not_idle' || code === 'session_generation_stale') return false;
      throw err;
    }
    await this.ender.endRun(
      run,
      cause === 'idle_timeout'
        ? { outcome: 'timed_out', reason: 'deadline', reasonText: 'session_idle_timeout passed with the session idle' }
        : { outcome: 'stopped', reason: 'budget', reasonText: 'budget_run_billable_tokens' },
    );
    return true;
  }

  // ---- resume (D6 §2.4; D1 §15.3; SEAM.md §394) -------------------------------------

  // What the resume's transaction is given: whether the ended session's
  // retained workspace holds changes no checkpoint committed (its snapshot
  // differs from its checkpoint base), found here, never in a transaction.
  async resumeArgs(project: string, run: string): Promise<{ dirty: { workspace: string; base: string; tree: string | null; unknown?: string } | null }> {
    const facts = await this.rt.read<{ repo: string; state: string; workspace: { id: string; path: string; current_base: string; metadata: Record<string, unknown> | null; disposition: string } | null }>('session.resume_facts', { project, run });
    const ws = facts.workspace;
    if (facts.state !== 'ended' || ws === null || ws.disposition !== 'retained') return { dirty: null };
    // What lies outside its diff was never captured: whether it holds
    // changes is unknown, never presumed clean (the review's N2).
    if (ws.metadata === null) return { dirty: { workspace: ws.id, base: ws.current_base, tree: null, unknown: "what lies outside the workspace's diff was never captured, so it cannot be snapshotted" } };
    const metadata = ws.metadata as unknown as MetadataBaseline;
    const tree = await snapshotTree(worktreeContext(facts.repo, metadata.adminDir, ws.path), ws.current_base, this.rt.scratch).catch(() => null);
    const base = await treeOf(repoContext(facts.repo), ws.current_base).catch(() => null);
    // Unknown is never clean: a workspace that cannot be read is not resumed
    // as if it held nothing.
    if (tree === null || base === null) {
      throw new Refusal(500, 'infra_error', `The retained workspace of session ${run} could not be read, so whether it holds changes no checkpoint committed is unknown.`, 'Read the workspace on the host; resume once it can be read.', { run, workspace: ws.id });
    }
    if (tree === base) return { dirty: null };
    return { dirty: { workspace: ws.id, base: ws.current_base, tree } };
  }

  // The Architect's close (D6 §3.4, §5.3, §5.5; B02): the prospective bundle
  // from the head's tree, refused 422 `plan_refused` when the products do not
  // parse or the plan check refuses, 409 `phase_not_next` or
  // `plan_generation_stale` for a plan that is not the next phase's or whose
  // phase already has an open plan; otherwise recorded with its check, and
  // the consolidated pair raised on it. A session that changed nothing of
  // the Architect's paths raises nothing.
  private async bundle(facts: SaveFacts): Promise<Record<string, unknown>> {
    if (facts.head === null) throw new Refusal(409, 'integration_conflict', 'The integration branch is not registered.', 'Read the project.', { run: facts.run });
    const { blobs, texts } = await this.productFiles(facts.repo, facts.head, 'architect');
    const before = await this.productFiles(facts.repo, facts.base_revision, 'architect');
    const changed = Object.keys(blobs).filter((p) => before.blobs[p] !== blobs[p]);
    if (changed.length === 0) return { kind: 'none' };
    const plans = changed.filter((p) => PLAN_FILE.test(p)).map((p) => Number(PLAN_FILE.exec(p)![1]));
    const probe = await this.rt.read<BaselineFacts>('session.bundle_baseline', { project: facts.project, head: facts.base_revision, withPlan: false });
    const found = architectFindings({ files: texts }, { requirement_keys: probe.requirement_keys, spec_modules: probe.spec_modules, descriptive_keys: probe.descriptive_keys });
    const parsed = found.parsed;
    const findings = [...found.findings];
    if (!parsed.modules) findings.push({ code: 'machine_file_invalid', path: MODULES_FILE, subject: { path: MODULES_FILE, field: null }, message: `${MODULES_FILE} is missing or does not parse` });
    if (!parsed.roadmap) findings.push({ code: 'machine_file_invalid', path: ROADMAP_FILE, subject: { path: ROADMAP_FILE, field: null }, message: `${ROADMAP_FILE} is missing or does not parse` });
    if (findings.length > 0) throw planRefused(facts.run, [], findings);
    if (plans.length > 1) {
      throw new Refusal(409, 'phase_not_next', `Session ${facts.run} proposes plans for phases ${plans.join(', ')}; only the next phase's plan is proposed.`, 'Keep one phase plan, the next phase\'s, and close again.', { run: facts.run, phases: plans, next: probe.phase });
    }
    const phase = plans[0] ?? null;
    if (phase !== null) {
      if (phase !== probe.phase) {
        throw new Refusal(409, 'phase_not_next', `Phase ${phase} is not the next phase of project ${facts.project}: the next plan is phase ${probe.phase}'s.`, 'Plan the next phase only (F §3.10.1), and close again; or close with refuse.', {
          run: facts.run,
          phase,
          next: probe.phase,
        });
      }
      if (probe.open_plan !== null) {
        throw new Refusal(409, 'plan_generation_stale', `Phase ${phase} of project ${facts.project} already has an open plan (${probe.open_plan.id}, generation ${probe.open_plan.generation}); a second plan is registered only by early replacement.`, 'Close with refuse; the replacement route is the way to replace an open plan.', {
          run: facts.run,
          phase,
          phase_plan: probe.open_plan.id,
          active_generation: probe.open_plan.generation,
        });
      }
    }
    const base = await this.rt.read<BaselineFacts>('session.bundle_baseline', { project: facts.project, head: facts.base_revision, withPlan: phase !== null, roadmapBlob: blobs[ROADMAP_FILE] ?? null });
    const roadmapChanged = base.roadmap_changed;
    const adrs: BundleContent['adrs'] = {};
    const adrTexts: Record<string, string> = {};
    for (const [key, a] of Object.entries(parsed.adrs)) {
      adrs[key] = { text: a.text, status: a.front.status, ...(a.front.supersedes ? { supersedes: a.front.supersedes } : {}) };
      adrTexts[key] = a.text;
    }
    const plan = phase === null ? null : (parsed.plans[phase] ?? null);
    if (phase !== null && plan === null) throw planRefused(facts.run, [], [{ code: 'machine_file_invalid', path: `.surety/phases/phase-${phase}.json`, subject: { path: `.surety/phases/phase-${phase}.json` }, message: 'the phase plan does not parse' }]);
    let check: PlanCheckResult | null = null;
    if (plan !== null) {
      const artifacts: BundleArtifacts = {
        modules: parsed.modules!,
        roadmap: parsed.roadmap!,
        adrs: adrTexts,
        adr_front_matter: Object.fromEntries(Object.entries(parsed.adrs).map(([k, a]) => [k, a.front])),
        architecture_text: parsed.architecture_text,
        plan,
      };
      check = checkPlan(base.baseline, artifacts);
    }
    const content: BundleContent = { modules: parsed.modules!, roadmap: parsed.roadmap, roadmap_changed: roadmapChanged, plan, adrs, architecture_text: parsed.architecture_text };
    const bundleBody = { project: facts.project, run: facts.run, head: facts.head, spec_revision: base.spec_revision, phase, blobs, versions: base.versions, content, check };
    const bundle = await writeWholeRecord(this.rt, { project: facts.project, run: facts.run, kind: 'plan_check', content: Buffer.from(`${canonical(bundleBody)}\n`) });
    const obligations = check ? await writeWholeRecord(this.rt, { project: facts.project, run: facts.run, kind: 'plan_check', content: Buffer.from(`${JSON.stringify({ bundle, planned_obligations: check.planned_obligations }, null, 2)}\n`) }) : null;
    await this.rt.engine('session.record_bundle', {
      project: facts.project,
      run: facts.run,
      bundle,
      obligations_record: obligations,
      head: facts.head,
      phase,
      blobs,
      content,
      check,
      spec_revision: base.spec_revision,
      versions: base.versions,
    });
    if (check && check.outcome === 'refused') throw planRefused(facts.run, check.reasons, [], bundle);
    return { kind: 'bundle', bundle, withPlan: phase !== null };
  }
}

function planRefused(run: string, reasons: { code: string; subjects: string[] }[], findings: Finding[], bundle: string | null = null): Refusal {
  const named = [...reasons.map((r) => `${r.code} (${r.subjects.join(', ')})`), ...findings.map((f) => `${f.code}: ${f.message}`)];
  return new Refusal(422, 'plan_refused', `The Architect's products of session ${run} are refused: ${named.join('; ')}.`, 'Correct them in the session, save, and close again; or close with refuse, which records the products and raises nothing.', {
    run,
    reasons,
    findings,
    ...(bundle ? { bundle } : {}),
  });
}

