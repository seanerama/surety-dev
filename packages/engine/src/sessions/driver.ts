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
import { type MetadataBaseline, snapshotTree, validateDiff } from '../git/snapshot.js';
import type { Launcher } from '../invoke/choke.js';
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

  // ---- a turn's settlement (D6 §2.1; B01) ---------------------------------------------

  // The role has exited: its domain's termination established, its reply (or
  // the failure) recorded in the transcript through the redactor, its usage
  // charged, and the session idle again at the next generation. A turn whose
  // termination cannot be established ends the session (slice 33 hardens
  // this path; nothing is settled on an unknown).
  async settle(handle: RunHandle): Promise<void> {
    const { run, invocation, project, domain } = handle.claim;
    try {
      const terminated = await this.ender.terminateDomains(run);
      if (!terminated) {
        this.rt.requestEnd(handle, { outcome: 'failed', reason: 'infra_error', reasonText: "the termination of the turn's domain could not be established; the turn is not settled" }, { afterExit: true });
        return;
      }
      const reply = handle.sessionReply !== null && handle.sessionReply !== 'invalid' && handle.exit?.code === 0 ? handle.sessionReply : null;
      const failure =
        reply !== null
          ? null
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
      const exit = await this.rt.read<{ exit_class: string | null; exit_evidence: string | null } | null>('domain.exit_of', { domain }).catch(() => null);
      await this.rt.engine('session.settle', { run, invocation, reply, failure, textRecord: record, exit });
    } finally {
      if (!handle.ending) this.rt.handles.delete(run);
    }
  }

  // ---- save (D6 §2.4, §2.5; B01, B02) -------------------------------------------------

  async save(project: string, run: string, opts: { expectedGeneration?: number | null } = {}): Promise<SaveAnswer> {
    const facts = await this.rt.engine<SaveFacts>('session.begin_save', { project, run, expectedGeneration: opts.expectedGeneration ?? null });
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
    const done = await this.rt.engine<{ idle_generation: number; saved: boolean }>('session.finish_save', outcome);
    if (refusal) throw refusal;
    return { saved: done.saved, revision: outcome.committed?.sha ?? null, idle_generation: done.idle_generation, findings: outcome.findings };
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
      const paths = diff.changes.map((c) => c.path).filter((p) => !inPaths(facts.role, p));
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
      const r = specFindings(text);
      return {
        blobs,
        findings: r.findings,
        products: { spec: { blob: blobs['.surety/spec/spec.md']!, digest: r.semantics.digest, representation: r.semantics.representation, findings: r.semantics.findings, readable: r.semantics.readable } },
      };
    }
    const base = await this.rt.read<BaselineFacts>('session.bundle_baseline', { project: facts.project, head: facts.base_revision, withPlan: false });
    const r = architectFindings({ files: texts }, { requirement_keys: base.requirement_keys, spec_modules: base.spec_modules });
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
    const expectedGeneration = answer.idle_generation;
    const facts = await this.rt.engine<SaveFacts & { session_state: string }>('session.close_facts', { project, run, expectedGeneration });
    let raise: Record<string, unknown> = { kind: 'none' };
    if (!opts.refuse) {
      if (facts.role === 'vision') raise = { kind: 'idea_accept' };
      else if (facts.role === 'spec_writer') raise = { kind: 'spec_approval' };
      else raise = await this.bundle(facts);
    }
    let closed: { decisions: { id: string; kind: string; batch_key: string | null }[] };
    try {
      closed = await this.rt.engine('session.close', { project, run, raise, expectedGeneration });
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
    const found = architectFindings({ files: texts }, { requirement_keys: probe.requirement_keys, spec_modules: probe.spec_modules });
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

