// A qualification attempt, once a person has authorized it (D2 §7.2, K10,
// Q7; SEAM.md §§148, 149): the attempt's own authority dispatches its three
// canaries on the fixture project, one at a time, positive, cancellation,
// containment, each a run whose receipt names the attempt and no entry,
// launched with the attempt's binary, template and profile and charged to
// the ordinary ledger. Its binding is checked before the first dispatch (at
// `qualification.before_dispatch`) and between canaries: a change
// invalidates it and no further canary runs. The first canary that fails
// ends it `failed`; three that pass write the trust entry `proposed` and
// raise `trust_activation`, whose answer launches nothing.
//
// Nothing here starts a process: the canaries are launched by the choke
// point (invoke/choke.ts), and the help check runs through invoke/static.ts.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { redactText, redactValue } from '../records/redact.js';
import {
  type BackendSampling,
  type ClaudeCapabilities,
  type ClaudeStreamSummary,
  claudeAnswered,
  claudeAuthFailure,
  claudeCapabilities,
  claudeKeyDelivery,
  claudeModelFallback,
  claudeProviderError,
} from '../invoke/adapters/claude.js';
import {
  CANARY_BARRIER,
  CANARY_UNLISTED,
  CONTAINMENT_ACTIONS,
  CONTAINMENT_RUN_BY,
  assistantCanaryEvidenceId,
  assistantCanaryNonce,
  assistantCanaryReply,
  canaryEdit,
  canaryKindsOf,
  canaryResult,
  containmentActionsFor,
  continuationMessage,
  continuationToken,
} from './canaries.js';
import { validateReply } from '../assistant/turn-package.js';
import { sameModel } from '../invoke/adapters/claude.js';
import { ACTION_HARDENING, actionHardened } from '../invoke/probes/program.js';
import { BOUNDARY_MECHANISM, ISOLATION_MECHANISM, hostIdentity } from './host.js';
import { type CanaryObservation, type DispatchTarget, type Launcher, canaryObservations } from '../invoke/choke.js';
import { helpHash } from '../invoke/static.js';
import { purposeOfTemplateVersion, templateOf } from '../invoke/adapters/templates.js';
import { readRecordBytes, writeWholeRecord } from '../records/files.js';
import { type Runtime, log } from '../runtime.js';
import type { AttemptRow, EntryInput } from '../store/transitions/trust.js';
import { pausePoint } from '../testing/seam.js';

interface CanaryEntry {
  kind: string;
  run: string | null;
  passed: boolean;
  failure_class: string | null;
  provider_error: string | null;
  evidence: string | null;
  term_to_exit_ms: number | null;
  // A canary never dispatched (`not_dispatched`, B2): what held it, in the
  // blocker's own words; null where nothing held it at the deadline's read.
  wait_reason?: string | null;
}

const POLL_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class QualificationDriver {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly rt: Runtime,
    private readonly launcher: Launcher,
  ) {}

  // Each tick: an attempt whose binding changed before its dispatch is
  // invalidated; an authorized one is taken on its way. An attempt running
  // that no driver of this incarnation holds (a restart) cannot be judged
  // and is invalidated.
  async step(): Promise<void> {
    await this.rt.engine('qualification.sweep', {}).catch((err) => log('qualification', err, { what: 'sweep' }));
    // A continuation canary's session whose attempt is no longer running
    // (invalidated, or concluded while a turn was in flight) is ended, so
    // the fixture project is never left `session_busy` (D6 §2.7; M6).
    const orphans = await this.rt.read<{ run: string; attempt: string; status: string }[]>('qualification.orphan_sessions').catch(() => []);
    for (const o of orphans) {
      await this.rt.services?.endRun(o.run, { outcome: 'failed', reason: 'infra_error', reasonText: `the continuation canary's attempt ${o.attempt} is ${o.status}` }).catch((err) => log('qualification', err, { run: o.run }));
    }
    const due = await this.rt.read<{ id: string; status: string }[]>('qualification.due');
    for (const a of due) {
      if (this.inFlight.has(a.id)) continue;
      if (a.status === 'running') {
        await this.rt.engine('qualification.invalidate', { attempt: a.id, reason: 'engine_restarted' }).catch((err) => log('qualification', err, { attempt: a.id }));
        continue;
      }
      this.inFlight.add(a.id);
      void this.drive(a.id)
        .catch((err) => log('qualification', err, { attempt: a.id }))
        .finally(() => this.inFlight.delete(a.id));
    }
  }

  // What changed of the binding, the help included; null when nothing.
  private async drift(attempt: string): Promise<string | null> {
    const a = await this.rt.read<AttemptRow | null>('qualification.row', { attempt });
    if (!a) return 'missing';
    const store = await this.rt.read<string | null>('qualification.drift', { attempt });
    if (store !== null) return store;
    const help = await helpHash(a.binary_path, a.backend).catch(() => null);
    if (help !== a.help_sha256) return 'help_changed';
    return null;
  }

  private async drive(attempt: string): Promise<void> {
    await pausePoint('qualification.before_dispatch');
    const first = await this.drift(attempt);
    if (first !== null) {
      await this.rt.engine('qualification.invalidate', { attempt, reason: first });
      return;
    }
    const a = await this.rt.engine<AttemptRow>('qualification.start', { attempt });
    const target = await this.rt.read<DispatchTarget | null>('qualification.target', { project: a.fixture_project });
    if (target === null) {
      await this.rt.engine('qualification.invalidate', { attempt, reason: 'fixture_project_missing' });
      return;
    }
    const canaries: CanaryEntry[] = [];
    // A real backend's streams and the host's samples, canary by canary:
    // the tool surface and delegation are judged over all of them (D2 §4.5).
    const history: { stream: ClaudeStreamSummary | null; sampling: BackendSampling | null }[] = [];
    let capabilities: ClaudeCapabilities | null = null;
    const unexpected: { destination: string; refused_at: string }[] = [];
    // The candidate destinations the canaries were let through to.
    const used = new Set<string>();
    for (const kind of canaryKindsOf(a)) {
      if (canaries.length > 0) {
        const between = await this.drift(attempt);
        if (between !== null) {
          await this.rt.engine('qualification.invalidate', { attempt, reason: between });
          return;
        }
      }
      // The continuation canary (D6 §2.6): a session of two turns.
      if (kind === 'continuation') {
        const entry = await this.continuation(a, target);
        canaries.push(entry);
        await this.rt.engine('qualification.canary', { attempt, canary: entry, unexpected });
        if (!entry.passed) {
          await this.rt.engine('qualification.conclude', { attempt, canaries, unexpected_contacts: unexpected });
          return;
        }
        continue;
      }
      const item = await this.rt.engine<string>('qualification.canary_item', { attempt, kind });
      // The host side's own witnesses (D2 §7.2), read before the
      // containment canary and compared after it.
      const before = kind === 'containment' ? hostWitnesses(this.rt.home, target.repo) : null;
      const run = await this.dispatch(target, item, attempt, a, kind);
      const judged = run === null ? { entry: await this.notDispatched(a, kind, item), capabilities: null } : await this.judge(a, kind, run, unexpected, before === null ? null : { before, after: hostWitnesses(this.rt.home, target.repo) }, used, history);
      const entry = judged.entry;
      if (judged.capabilities !== null) capabilities = judged.capabilities;
      canaries.push(entry);
      await this.rt.engine('qualification.canary', { attempt, canary: entry, unexpected });
      if (!entry.passed) {
        await this.rt.engine('qualification.conclude', { attempt, canaries, unexpected_contacts: unexpected });
        return;
      }
    }
    // An active entry's session qualification writes no entry: the
    // conclusion marks that entry qualified for sessions (D6 §2.6).
    if (a.session_entry) {
      await this.rt.engine('qualification.conclude', { attempt, canaries, unexpected_contacts: unexpected });
      return;
    }
    const input = await this.entryInput(a, canaries, [...used], history, capabilities);
    await this.rt.engine('qualification.conclude', { attempt, canaries, unexpected_contacts: unexpected, entry: input });
  }

  // The continuation canary (D6 §2.6; D2 §7.2; D6-S09): one session run on
  // the fixture project under the attempt's authority, two turns, each a
  // one-shot invocation in a fresh domain with a fresh volatile home. Turn 1
  // writes the engine's token into the role's artifact; turn 2 is asked to
  // answer from what the engine carried over (its package: the transcript
  // and the artifact). It passes only if turn 2's reply carries the token,
  // turn 1's domain had terminated (its invocation ended) before turn 2
  // launched, and no provider file was carried (a fresh volatile home per
  // turn; the first one inventoried at its collection). The session is then
  // ended; nothing it wrote is committed.
  private async continuation(a: AttemptRow, target: DispatchTarget): Promise<CanaryEntry> {
    const kind = 'continuation';
    let deadlineS = 1800;
    try {
      const d = (JSON.parse(a.canary_deadlines) as Record<string, number>)[kind];
      if (typeof d === 'number' && d > 0) deadlineS = d;
    } catch {
      // the default
    }
    const until = performance.now() + deadlineS * 1000;
    let run: string | null = null;
    let held: string | null = null;
    while (run === null && performance.now() < until) {
      try {
        run = (await this.rt.engine<{ run: { id: string } }>('qualification.canary_session', { attempt: a.id })).run.id;
      } catch (err) {
        held = (err as { message?: string }).message ?? String(err);
        if ((err as { code?: string }).code !== 'session_busy') {
          log('qualification', err, { attempt: a.id, canary: kind });
          break;
        }
        if ((await this.rt.read<{ status: string } | null>('qualification.row', { attempt: a.id }))?.status !== 'running') break;
        await sleep(500);
      }
    }
    if (run === null) return this.notDispatched(a, kind, null, held);
    const project = a.fixture_project!;
    const scope = this.rt.boundary() === 'real' ? (this.rt.scope?.path ?? null) : null;
    let stopped: string | null = null;
    // Turn 1 refused at its admission: nothing of the canary ran (B2).
    let notAdmitted: string | null = null;
    for (const turn of [1, 2] as const) {
      const read = await this.rt.read<{ idle: boolean; idle_generation: number } | null>('session.admission_read', { project, run });
      if (read === null || !read.idle) {
        stopped = `the session was not idle before turn ${turn}`;
        break;
      }
      const text = continuationMessage(turn);
      let refusal: string | null = null;
      const admitted = await this.rt.engine<{ turn: number; invocation: string }>('session.admit_turn', { project, run, text, textRecord: null, admittedAt: read.idle_generation, scripted: null, scope }).catch((err) => {
        log('qualification', err, { attempt: a.id, canary: kind, turn });
        refusal = (err as { message?: string }).message ?? String(err);
        return null;
      });
      if (admitted === null) {
        stopped = `turn ${turn} was not admitted${refusal === null ? '' : `: ${refusal}`}`;
        if (turn === 1) notAdmitted = refusal ?? stopped;
        break;
      }
      const record = await writeWholeRecord(this.rt, { project, run, kind: 'session_transcript', content: Buffer.from(text) }).catch(() => null);
      if (record !== null) await this.rt.engine('session.attach_text', { run, turn: admitted.turn, record }).catch(() => {});
      await this.launcher.dispatchTurn(target, { run, invocation: admitted.invocation }).catch((err) => log('qualification', err, { attempt: a.id, canary: kind, turn }));
      let settled = false;
      while (performance.now() < until) {
        const f = await this.rt.read<{ state: string; turns: { number: number; settled_at: string | null }[] }>('qualification.continuation_facts', { run });
        if (f.turns.find((t) => t.number === admitted.turn)?.settled_at) {
          settled = true;
          break;
        }
        if (f.state === 'ended') break;
        await sleep(POLL_MS);
      }
      if (!settled) {
        stopped = `turn ${turn} did not settle within the canary's deadline`;
        break;
      }
    }
    const facts = await this.rt.read<ContinuationFacts>('qualification.continuation_facts', { run });
    // The session is ended: closed raising nothing, or by its run's end
    // protocol when a turn is still in flight (its turn settled unknown).
    const read = await this.rt.read<{ idle: boolean; idle_generation: number } | null>('session.admission_read', { project, run });
    if (read !== null && read.idle) {
      await this.rt
        .engine('session.close', { project, run, raise: { kind: 'none' }, admittedAt: read.idle_generation })
        .then(() => this.rt.services?.endRun(run!, { outcome: 'completed', reason: 'none' }))
        .catch((err) => log('qualification', err, { attempt: a.id, canary: kind }));
    } else if (facts.state !== 'ended') {
      await this.rt.services?.endRun(run, { outcome: 'failed', reason: 'infra_error', reasonText: stopped ?? 'the continuation canary did not complete' }).catch((err) => log('qualification', err, { attempt: a.id, canary: kind }));
    }
    const token = continuationToken(a.id);
    const [t1, t2] = [facts.turns.find((t) => t.number === 1), facts.turns.find((t) => t.number === 2)];
    const replyOf = (t: ContinuationFacts['turns'][number] | undefined): string | null => {
      try {
        const r = JSON.parse(t?.reply ?? 'null') as { reply?: unknown } | null;
        return typeof r?.reply === 'string' ? r.reply : null;
      } catch {
        return null;
      }
    };
    const answered = replyOf(t2);
    const found = answered !== null && answered.includes(token);
    const quiescent = t1 !== undefined && t2 !== undefined && t1.domain_status === 'terminated' && t1.ended_order !== null && t2.launched_order !== null && t1.ended_order < t2.launched_order;
    const carried = await this.carriedBetween(facts.inventories, facts.turns.map((t) => t.domain ?? null));
    const real = a.backend === 'claude';
    // A model the turns did not request answered (E86 item 3).
    const others = real ? facts.models_observed.filter((m) => !sameModel(a.model, m)) : [];
    // No provider file carried, established from the two turns' inventories
    // (D2 §4.3); a missing or incomplete inventory is unknown, and the canary
    // does not pass on it (the review's M3).
    const passed = stopped === null && t1?.outcome === 'replied' && t2?.outcome === 'replied' && found && quiescent && carried.carried === false && others.length === 0;
    const detail = {
      kind,
      run,
      turns: facts.turns.map((t) => ({ turn: t.number, invocation: t.invocation, outcome: t.outcome, usage_status: t.usage_status, launched_at: t.launched_at, ended_at: t.ended_at })),
      instructed: { turn_1: 'write the engine\'s token into the artifact', turn_2: 'answer with every match of the token\'s pattern in the package (transcript and artifact)' },
      token_in_reply: found,
      quiescence: { turn_1_domain: t1?.domain_status ?? null, turn_1_ended_at: t1?.ended_at ?? null, turn_2_launched_at: t2?.launched_at ?? null, holds: quiescent },
      provider_files: carried,
      ...(others.length > 0 ? { model_fallback: others } : {}),
      ...(stopped ? { stopped } : {}),
    };
    // Turn 1 never admitted: the canary never ran, and is recorded so with
    // the refusal's words (B2), its session's record beside it.
    if (notAdmitted !== null) {
      const record = await this.record(a, run, redactValue({ ...detail, outcome: 'not_dispatched', wait_reason: notAdmitted }));
      return { kind, run, passed: false, failure_class: 'not_dispatched', provider_error: record, evidence: record, term_to_exit_ms: null, wait_reason: notAdmitted };
    }
    const evidence = await this.record(a, run, redactValue(detail));
    return {
      kind,
      run,
      passed,
      failure_class: passed ? null : others.length > 0 ? 'model_fallback' : 'continuation_failed',
      provider_error: passed ? null : evidence,
      evidence,
      term_to_exit_ms: null,
    };
  }

  // The canary's run, dispatched under the attempt's authority alone. A
  // dispatch held (the resource envelope, the project's own run) waits, for
  // as long as the canary's deadline; null only when it was never dispatched
  // within it.
  private async dispatch(target: DispatchTarget, item: string, attempt: string, a: AttemptRow, kind: string): Promise<string | null> {
    let deadlineS = 600;
    try {
      const d = (JSON.parse(a.canary_deadlines) as Record<string, number>)[kind];
      if (typeof d === 'number' && d > 0) deadlineS = d;
    } catch {
      // the default
    }
    const until = performance.now() + deadlineS * 1000;
    while (performance.now() < until) {
      if (await this.launcher.dispatch(target, { id: item }, attempt).catch(() => false)) break;
      if ((await this.rt.read<{ status: string } | null>('qualification.row', { attempt }))?.status !== 'running') break;
      await sleep(500);
    }
    const run = await this.rt.read<string | null>('qualification.canary_run', { item });
    if (run === null) return null;
    for (;;) {
      if ((await this.rt.read<string | null>('run.state', { run })) === 'ended') return run;
      await sleep(POLL_MS);
    }
  }

  // A canary never dispatched (B2; Sean's approval of 2026-10-27): it ran
  // nothing and cost nothing, so it is recorded `not_dispatched` with what
  // held it (the blocker's own words, and for a day limit the limits passed
  // and the day's account), never as a failure of its kind. `item`: the
  // canary's work item, whose blocker is read now; `reason`: what held it
  // where no item was dispatched (a session that could not be opened, a turn
  // not admitted).
  private async notDispatched(a: AttemptRow, kind: string, item: string | null, reason: string | null = null): Promise<CanaryEntry> {
    const held =
      item === null
        ? { reason, limits: [] as string[], day: null }
        : await this.rt.read<{ reason: string | null; limits: string[]; day: unknown }>('qualification.wait_reason', { item }).catch(() => ({ reason: null, limits: [] as string[], day: null }));
    const record = await this.record(a, null, { kind, outcome: 'not_dispatched', wait_reason: held.reason, limits: held.limits, day: held.day });
    return { kind, run: null, passed: false, failure_class: 'not_dispatched', provider_error: record, evidence: record, term_to_exit_ms: null, wait_reason: held.reason };
  }

  private record(a: AttemptRow, run: string | null, value: unknown): Promise<string> {
    return writeWholeRecord(this.rt, { project: a.fixture_project, run, kind: 'qualification_evidence', content: Buffer.from(JSON.stringify(value)) });
  }

  // D2 §7.2's pass rules (SEAM.md §149), from what the engine observed of
  // the run, never from what the backend printed.
  private async judge(
    a: AttemptRow,
    kind: string,
    run: string,
    unexpected: { destination: string; refused_at: string }[],
    host: { before: HostWitness; after: HostWitness } | null,
    used: Set<string>,
    history: { stream: ClaudeStreamSummary | null; sampling: BackendSampling | null }[],
  ): Promise<{ entry: CanaryEntry; capabilities: ClaudeCapabilities | null }> {
    const obs: CanaryObservation | undefined = canaryObservations.get(run);
    canaryObservations.delete(run);
    const facts = await this.rt.read<{ outcome: string | null; exit_class: string | null; transcript: string | null; provider_session_id: string | null }>('qualification.run_facts', { run });
    // A real backend's stream, read by its adapter (D2 §7.2); null for the
    // scripted backend, whose canaries are the test's instruments.
    const real = a.backend === 'claude';
    const stream = real ? (obs?.stream ?? null) : null;
    if (real) history.push({ stream, sampling: obs?.sampling ?? null });
    const authMode = a.auth_mode;
    const authFailure = stream !== null ? claudeAuthFailure(stream, authMode) : null;
    // A model fallback (E86 item 3): a canary with one fails.
    const fallback = real ? claudeModelFallback(stream, a.model) : null;
    let capabilities: ClaudeCapabilities | null = null;
    const candidates = JSON.parse(a.candidate_egress) as string[];
    for (const e of obs?.egress ?? []) {
      // The authority is a role's text: redacted before it is kept (S2).
      const destination = redactText(e.authority);
      if (e.decision === 'refused' && e.reason === 'not_listed' && e.authority !== CANARY_UNLISTED && !unexpected.some((u) => u.destination === destination)) {
        unexpected.push({ destination, refused_at: e.opened_at });
      }
      const hostOf = e.authority.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
      if (e.decision === 'accepted' && candidates.includes(hostOf)) used.add(hostOf);
    }
    let passed = false;
    let detail: Record<string, unknown> = { kind, run, exit_class: facts.exit_class ?? obs?.exitClass ?? null, outcome: facts.outcome };
    let termToExit: number | null = null;
    // The workspace assistant's attempt (the assistant design §3): its
    // canaries in the assistant's shape, its plan with no repository.
    const purpose = purposeOfTemplateVersion(a.template_version);
    if (kind === 'positive' && purpose === 'assistant') {
      // A schema-valid reply that cites the seeded evidence and carries the
      // engine's nonce, from a clean exit; a real backend's credential
      // delivered and no authentication failure.
      const want = assistantCanaryReply(a.id);
      const judged = validateReply(obs?.resultValue ?? null, [assistantCanaryEvidenceId(a.id)]);
      const reply = 'reply' in judged ? judged.reply : null;
      const resultOk = obs?.verdict === 'accepted' && reply !== null && reply.cited_evidence.includes(assistantCanaryEvidenceId(a.id)) && reply.text.includes(assistantCanaryNonce(a.id));
      const delivery = real && stream !== null ? claudeKeyDelivery(stream, authMode) : null;
      passed = obs?.exitClass === 'clean' && resultOk && (!real || (stream !== null && authFailure === null && delivery?.established === true));
      detail = {
        ...detail,
        purpose,
        result_collection: obs?.verdict ?? null,
        result_matches: resultOk,
        reply_problem: 'invalid' in judged ? judged.invalid : null,
        expected: { result: want, cites: assistantCanaryEvidenceId(a.id), nonce: assistantCanaryNonce(a.id) },
        observed: { result: obs?.resultValue ?? null },
        credential_delivery: real
          ? { auth_mode: authMode, variable: delivery?.variable ?? null, established: delivery?.established === true, how: delivery === null ? 'the stream was not read' : `${delivery.basis}; the credential reached the backend only in ${delivery.variable}` }
          : { auth_mode: authMode, variable: null, established: false, how: 'the scripted backend takes no credential' },
      };
    } else if (kind === 'positive') {
      const want = canaryResult(a.id, kind);
      const got = obs?.value as { summary?: unknown } | null | undefined;
      const resultOk = obs?.verdict === 'accepted' && got?.summary === want.summary;
      const editOk = obs?.editContent === canaryEdit(a.id).content;
      const edit = canaryEdit(a.id);
      // What was asked and what was seen (SEAM.md §165): the edit read after
      // materialization without following a link, the result as collected,
      // and the credential's delivery as the stream established it, which a
      // real backend's positive canary requires (E74 item 3).
      const delivery = real && stream !== null ? claudeKeyDelivery(stream, authMode) : null;
      passed = obs?.exitClass === 'clean' && resultOk && editOk && (!real || (stream !== null && authFailure === null && delivery?.established === true));
      detail = {
        ...detail,
        result_collection: obs?.verdict ?? null,
        result_matches: resultOk,
        edit_matches: editOk,
        expected: { edit, result: want },
        observed: { edit: { path: edit.path, ...(obs?.editObserved ?? { type: 'missing' }) }, result: obs?.resultValue ?? null },
        credential_delivery: real
          ? {
              auth_mode: authMode,
              variable: delivery?.variable ?? null,
              established: delivery?.established === true,
              how: delivery === null ? 'the stream was not read' : `${delivery.basis}; the engine wrote no credential file, the credential reached the backend only in ${delivery.variable}`,
            }
          : { auth_mode: authMode, variable: null, established: false, how: 'the scripted backend takes no credential' },
      };
    } else if (kind === 'cancellation') {
      termToExit = obs?.termToExitMs ?? null;
      // A real backend must have been authenticated and answering when it
      // reached the barrier (D2 §7.2): a model answer with no
      // authentication failure in its stream.
      const answered = !real || (stream !== null && claudeAnswered(stream, authMode));
      passed = obs?.barrierSeen === true && obs.exitClass === 'engine_signaled' && termToExit !== null && answered;
      detail = {
        ...detail,
        barrier_observed: obs?.barrierSeen ?? false,
        // The witness is the domain init's report on its channel, never the
        // stream (SEAM.md §165).
        barrier: { path: CANARY_BARRIER, witnessed: obs?.barrierSeen ?? false, witnessed_at: obs?.barrierAt ?? null },
        term_to_exit_ms: termToExit,
        ...(real ? { authenticated: answered } : {}),
      };
    } else {
      // Each action run by the domain init at the engine's request while the
      // backend was live in the domain (E86), every witness of it completed
      // and the expected outcome, and the host side agreeing (D2 §7.2).
      // Refused by the list, not by a limit (the review of c4a7f7f).
      const refusedUnlisted = (obs?.egress ?? []).some((e) => e.authority === CANARY_UNLISTED && e.decision === 'refused' && e.reason === 'not_listed');
      const corroboration: Record<string, { checked: boolean; agrees: boolean | null; what: string }> = {
        token_read: { checked: true, agrees: host !== null && host.before.token !== null && host.before.token === host.after.token, what: "the token file's bytes unchanged, read from the host" },
        git_config: { checked: true, agrees: host !== null && host.before.config !== null && host.before.config === host.after.config, what: "the fixture repository's configuration unchanged, read from the host" },
        unlisted_connect: { checked: true, agrees: refusedUnlisted, what: "the proxy's log shows the unlisted CONNECT refused by its list (not_listed)" },
        engine_port: { checked: false, agrees: null, what: 'not corroborated host-side: the engine keeps no record of a connection that never reached it' },
        workspace_write: { checked: false, agrees: null, what: 'the control: the init observed the write' },
        out_write: { checked: false, agrees: null, what: 'the control: the init observed the write to /surety/out' },
        workspace_absent: { checked: false, agrees: null, what: 'the init observed nothing at /surety/workspace and could not make it' },
      };
      // The provider's tunnel, for a real backend (SEAM.md §165): an
      // accepted CONNECT to a candidate destination with bytes both ways.
      const tunnel = real ? (obs?.egress ?? []).find((e) => e.decision === 'accepted' && candidates.includes(e.authority.replace(/:443$/, '').toLowerCase()) && (e.bytes_up ?? 0) > 0 && (e.bytes_down ?? 0) > 0) : undefined;
      const judged = judgeContainment({
        actions: containmentActionsFor(purpose),
        witnesses: obs?.witnesses ?? [],
        watch: obs?.containment ?? null,
        done: obs?.containmentDone ?? null,
        corroboration,
        providerTunnel: real ? { ran: tunnel !== undefined, detail: tunnel ? `${tunnel.authority} accepted, ${tunnel.bytes_up} bytes up and ${tunnel.bytes_down} down` : 'no accepted CONNECT to a candidate destination carried bytes both ways' } : null,
      });
      passed = judged.passed;
      detail = { ...CONTAINMENT_RUN_BY, hardening: [...ACTION_HARDENING], actions: judged.actions, controls: judged.controls, backend: judged.backend, reason: judged.reason, result_collection: obs?.verdict ?? null };
      if (real) {
        // The tool surface and the absence of delegation, scheduling and
        // background work (D2 §§4.5, 7.2; T13): over every canary's stream
        // and the host's samples of every canary's domain.
        const samplings = history.map((h) => h.sampling).filter((x): x is BackendSampling => x !== null);
        const merged: BackendSampling | null =
          samplings.length === 0
            ? null
            : {
                samples: samplings.reduce((n, x) => n + x.samples, 0),
                max_backend: Math.max(...samplings.map((x) => x.max_backend)),
                max_members: Math.max(...samplings.map((x) => x.max_members)),
                unclassified: Math.max(...samplings.map((x) => x.unclassified)),
                backend_cmdlines: [...new Set(samplings.flatMap((x) => x.backend_cmdlines))].slice(0, 16),
                transient_backend: samplings.reduce((n, x) => n + (x.transient_backend ?? 0), 0),
                embedded_tool: samplings.reduce((n, x) => n + (x.embedded_tool ?? 0), 0),
                embedded_tool_cmdlines: [...new Set(samplings.flatMap((x) => x.embedded_tool_cmdlines ?? []))].slice(0, 16),
              };
        capabilities = claudeCapabilities(
          history.map((h) => h.stream).filter((x): x is ClaudeStreamSummary => x !== null),
          merged,
          templateOf(a.backend, { authMode, purpose })?.tools ?? [],
        );
        detail = { ...detail, capabilities };
        if (!capabilities.delegation_verified || authFailure !== null) passed = false;
      }
    }
    if (real) {
      // What the stream established, kept with the canary's evidence (D2
      // §§4.5, 7.2): the backend as it described itself, key delivery, usage,
      // the terminal event, the session id the engine assigned.
      detail = {
        ...detail,
        stream:
          stream === null
            ? null
            : {
                init: stream.init,
                credential_delivery: claudeKeyDelivery(stream, authMode),
                protocol_errors: stream.protocol_errors,
                session_id_accepted: stream.init?.session_id == null || facts.provider_session_id === null ? null : stream.init.session_id === facts.provider_session_id,
                usage_steps: stream.usage_steps,
                results: stream.results,
                result: stream.result === null ? null : { subtype: stream.result.subtype, is_error: stream.result.is_error, total_cost_usd: stream.result.total_cost_usd, usage_present: stream.result.usage_present, models: stream.result.models, terminal_reason: stream.result.terminal_reason },
                types: stream.types,
                tool_uses: stream.tool_uses.map((u) => u.name),
                denials: stream.denials,
                auth_failure: authFailure,
              },
        sampling: obs?.sampling ?? null,
        exit_status: obs?.exitStatus ?? null,
      };
    }
    if (fallback !== null) {
      passed = false;
      detail = { ...detail, model_fallback: fallback };
    }
    const evidence = await this.record(a, run, redactValue(detail));
    let failureClass: string | null = null;
    if (!passed) {
      failureClass = kind === 'cancellation' && obs?.barrierSeen === true ? 'cancellation_failed' : FAILURE[kind]!;
      if (real) {
        const held =
          kind === 'containment' &&
          (detail.actions as { passed: boolean }[]).every((x) => x.passed) &&
          ((detail.controls as { ran: boolean }[] | undefined) ?? []).every((x) => x.ran) &&
          detail.reason === null;
        failureClass = realFailureClass(kind, failureClass, { stream, authFailure, obs, candidates, capabilities, containmentHeld: held, fallback: fallback !== null });
      }
    }
    let providerError: string | null = null;
    if (!passed) {
      // The scripted backend's: the run's redacted output. A real backend's:
      // its structured provider error, redacted (D2 §7.2, N04).
      providerError = real
        ? await this.record(a, run, redactValue({ kind, failure_class: failureClass, provider_error: stream === null ? null : claudeProviderError(stream, authMode), exit_class: facts.exit_class ?? obs?.exitClass ?? null, exit_status: obs?.exitStatus ?? null, transcript: facts.transcript }))
        : (facts.transcript ?? (await this.record(a, run, { kind, failure: FAILURE[kind], detail })));
    }
    return { entry: { kind, run, passed, failure_class: failureClass, provider_error: providerError, evidence, term_to_exit_ms: kind === 'cancellation' ? termToExit : null }, capabilities };
  }

  // Whether a provider file was carried from the first turn to the second
  // (D2 §4.3; D6-S09), from the two turns' inventories: each turn ran in a
  // domain of its own on a volatile filesystem placed empty, and both
  // inventories are recorded, readable and complete, so nothing of the
  // first's home reached the second; `unknown` (with why) otherwise, and
  // the canary does not pass on it (the review's M3). Files of the same path
  // and content in both homes are listed: a backend that writes the same
  // startup file in each fresh home shows them, which is not a carry.
  private async carriedBetween(
    inventories: { id: string; path: string | null; sha256: string | null; bytes: number | null }[],
    domains: (string | null)[],
  ): Promise<{ carried: boolean | 'unknown'; how: string; inventories: string[]; same_in_both?: string[] }> {
    const ids = inventories.map((r) => r.id);
    if (inventories.length !== 2) return { carried: 'unknown', how: `${inventories.length} provider-files inventories are recorded for the two turns, not two`, inventories: ids };
    if (domains.length !== 2 || domains.some((d) => d === null) || domains[0] === domains[1]) return { carried: 'unknown', how: 'the two turns did not run in two domains of their own', inventories: ids };
    const parsed: { path: string; type: string; size?: number; content_base64?: string }[][] = [];
    for (const r of inventories) {
      const bytes = r.path === null ? null : await readRecordBytes(this.rt.home, { path: r.path, sha256: r.sha256, bytes: r.bytes }).catch(() => null);
      let v: { locations?: unknown; complete?: unknown } | null = null;
      try {
        v = bytes === null ? null : (JSON.parse(bytes.toString('utf8')) as { locations?: unknown; complete?: unknown });
      } catch {
        v = null;
      }
      if (v === null || !Array.isArray(v.locations)) return { carried: 'unknown', how: `the inventory ${r.id} cannot be read`, inventories: ids };
      if (v.complete !== true) return { carried: 'unknown', how: `the inventory ${r.id} is incomplete (a collection bound was reached)`, inventories: ids };
      parsed.push(v.locations as { path: string; type: string; size?: number; content_base64?: string }[]);
    }
    const home = (e: { path: string; type: string }) => e.type === 'file' && e.path.startsWith('/surety/home/');
    const first = new Map(parsed[0]!.filter(home).map((e) => [e.path, e]));
    const same = parsed[1]!.filter(home).filter((e) => {
      const f = first.get(e.path);
      return f !== undefined && f.size === e.size && f.content_base64 !== undefined && f.content_base64 === e.content_base64;
    });
    return {
      carried: false,
      how: "each turn's volatile home was placed empty in a domain of its own, and both turns' inventories are recorded and complete",
      inventories: ids,
      same_in_both: same.map((e) => e.path),
    };
  }

  // The entry an attempt whose canaries all passed writes (D2 §§4.1, 7.2).
  private async entryInput(
    a: AttemptRow,
    canaries: CanaryEntry[],
    usedEgress: string[],
    history: { stream: ClaudeStreamSummary | null }[],
    capabilities: ClaudeCapabilities | null,
  ): Promise<EntryInput> {
    const usage = await this.rt.read<{ observations: number; cost: boolean }>('qualification.usage', { attempt: a.id });
    // How often usage was reported: per model call where the canaries
    // observed it; for the scripted backend, whose usage the test scripts,
    // per invocation (the engine's reading for a stand-in; SEAM.md §148).
    // A real backend's from its streams: per call where an assistant message
    // carried usage, per invocation where only the result did.
    const streams = history.map((h) => h.stream).filter((x): x is ClaudeStreamSummary => x !== null);
    const granularity =
      a.backend === 'claude'
        ? streams.some((x) => x.usage_steps > 0)
          ? 'model_call'
          : streams.some((x) => x.result?.usage_present === true)
            ? 'invocation'
            : 'none'
        : usage.observations > 0
          ? 'model_call'
          : a.backend === 'scripted'
            ? 'invocation'
            : 'none';
    const evidence = canaries.map((c) => c.evidence).filter((x): x is string => x !== null);
    let providerFiles = { locations: [] as string[], persistence_flags: [] as string[], excluded: [] as string[] };
    const positive = canaries.find((c) => c.kind === 'positive');
    const pf = positive?.run ? await this.rt.read<{ path: string; sha256: string | null; bytes: number | null } | null>('qualification.provider_files', { run: positive.run }) : null;
    if (pf) {
      const bytes = await readRecordBytes(this.rt.home, pf).catch(() => null);
      try {
        const v = JSON.parse(bytes?.toString('utf8') ?? 'null') as { locations?: { path: string }[]; persistence_flags?: string[]; excluded?: { path: string }[] } | null;
        if (v) providerFiles = { locations: (v.locations ?? []).map((l) => l.path), persistence_flags: v.persistence_flags ?? [], excluded: (v.excluded ?? []).map((e) => e.path) };
      } catch {
        // kept empty
      }
    }
    return {
      backend: a.backend,
      version: a.version,
      binary_path: a.binary_path,
      binary_sha256: a.binary_sha256,
      help_sha256: a.help_sha256,
      mode: 'one_shot_headless',
      template: a.template,
      template_version: a.template_version,
      model: a.model,
      auth_mode: a.auth_mode,
      // Only what the canaries established (D2 §4.5): a real backend's tool
      // surface from its streams and its capability test; for the scripted
      // backend no inventory and no delegation test ran, so nothing is
      // claimed.
      capabilities:
        capabilities === null
          ? { tools: [], denied: [], features_disabled: [], delegation_verified: false }
          : { tools: capabilities.tools, denied: capabilities.denied, features_disabled: capabilities.features_disabled, delegation_verified: capabilities.delegation_verified },
      host_id: hostIdentity() ?? 'unknown',
      host_qualification: a.host_qualification,
      isolation: ISOLATION_MECHANISM,
      boundary: BOUNDARY_MECHANISM,
      profile_fingerprint: a.profile_fingerprint,
      egress_hosts: [...usedEgress].sort(),
      usage_granularity: granularity,
      // A real backend's per-call observations are increments, its terminal
      // one the cumulative total that replaces them (adapters/claude.ts).
      usage_semantics: a.backend === 'claude' ? (granularity === 'model_call' ? 'delta' : granularity === 'invocation' ? 'cumulative' : null) : usage.observations > 0 ? 'cumulative' : null,
      cost_reporting: usage.cost ? 'reported' : 'none',
      enforceable_boundaries: granularity === 'none' || evidence.length === 0 ? [] : [{ boundary: 'invocation', mechanism: 'dispatch_check', evidence: evidence[0]!, overshoot: 'deadline' }],
      result_channel: 'file',
      // D6 §2.6: only from a passing continuation canary of this attempt.
      session_qualified: canaries.some((c) => c.kind === 'continuation' && c.passed),
      provider_files: providerFiles,
      term_to_exit_ms: canaries.find((c) => c.kind === 'cancellation')?.term_to_exit_ms ?? null,
      qualification_attempt: a.id,
      evidence,
    };
  }
}

// The containment canary's verdict (D2 §7.2; E86): every action witnessed
// by the init, completed (its child exited by itself with its report: a
// killed, timed out, silent or skipped action fails, never counts as a
// denial), the expected outcome, with the backend running when it ended,
// and the host agreeing where it checks; the backend seen in the domain
// before the check and still there after it; the init's report that the
// check ran with the backend running; every control run. Otherwise not
// passed, with the reason stated.
export function judgeContainment(args: {
  // The actions and their expected outcomes: D2's, or the workspace
  // assistant's (its plan has no repository; the assistant design §3).
  actions?: readonly { name: string; expected: string }[];
  witnesses: { action: string; outcome: string; detail: string; completed: boolean; backend_running: boolean; hardening?: string[] }[];
  watch: { ns_pid?: number; seen: { host_pid: number; at: string } | null; requested_at: string | null; present_at_end: boolean | null; ended_at?: string | null; reason: string | null } | null;
  done: { ran: boolean; backend_running: boolean; reason: string | null } | null;
  corroboration: Record<string, { checked: boolean; agrees: boolean | null; what: string }>;
  providerTunnel: { ran: boolean; detail: string } | null;
}) {
  const list = args.actions ?? CONTAINMENT_ACTIONS;
  const actions = list.map((x) => {
    const ws = args.witnesses.filter((y) => y.action === x.name);
    const c = args.corroboration[x.name] ?? { checked: false, agrees: null, what: 'not corroborated host-side' };
    const last = ws.at(-1);
    // Completed, and under the child's hardening (the review's S2).
    const hardened = ws.length > 0 && ws.every((w) => actionHardened(w.hardening ?? []));
    const completed = ws.length > 0 && ws.every((w) => w.completed) && hardened;
    const live = ws.length > 0 && ws.every((w) => w.backend_running);
    const ok = completed && live && ws.every((w) => w.outcome === x.expected) && (!c.checked || c.agrees === true);
    return { name: x.name, witnessed: ws.length > 0, completed, hardened, hardening: last?.hardening ?? [], backend_running: live, outcome: last?.outcome ?? null, detail: last?.detail ?? null, expected: x.expected, host: c, passed: ok };
  });
  // The control: a write the sandbox allows (the workspace's, or with no
  // repository /surety/out's).
  const controlName = list.some((x) => x.name === 'out_write') ? 'out_write' : 'workspace_write';
  const write = actions.find((x) => x.name === controlName);
  const controls: { name: string; ran: boolean; detail: string }[] = [
    { name: controlName, ran: write?.completed === true && write.outcome === 'allowed', detail: controlName === 'out_write' ? 'the init performed the write to /surety/out in the domain' : 'the init performed the workspace write in the domain' },
  ];
  if (args.providerTunnel) controls.push({ name: 'provider_tunnel', ...args.providerTunnel });
  const w = args.watch;
  // The backend as the host saw it (SEAM.md §175): when it was first seen a
  // member of the domain, its host pid, the host's two reads of the
  // domain's cgroup (before the check and after it), and whether it ran
  // throughout (both reads saw it, and the init says it ran while every
  // action did and when the check ended).
  const throughout = w?.seen != null && w.present_at_end === true && args.done?.ran === true && args.done.backend_running === true && actions.every((x) => x.backend_running);
  const backend = {
    seen_at: w?.seen?.at ?? null,
    pid: w?.seen?.host_pid ?? null,
    ns_pid: w?.ns_pid ?? null,
    requested_at: w?.requested_at ?? null,
    host_reads: [
      ...(w?.seen ? [{ at: w.seen.at, member: true }] : []),
      ...(w?.ended_at ? [{ at: w.ended_at, member: w.present_at_end === true }] : []),
    ],
    running_throughout: throughout,
  };
  const shown = throughout;
  const reason =
    w === null
      ? 'the check was not run: the backend never started in the domain'
      : w.seen === null
        ? `the check was not run: ${w.reason ?? 'the backend was not seen in the domain'}`
        : args.done === null
          ? 'the init did not report the end of the check'
          : !args.done.ran
            ? `the check was not run: ${args.done.reason ?? 'the init ran no action'}`
            : actions.some((x) => !x.witnessed)
              ? `the init witnessed no ${actions.filter((x) => !x.witnessed).map((x) => x.name).join(', ')}`
              : actions.some((x) => !x.completed)
                ? `not completed: ${actions.filter((x) => !x.completed).map((x) => `${x.name} (${x.hardened ? (x.detail ?? 'no detail') : `not hardened: ${x.hardening.join(' ') || 'no flags'}`})`).join('; ')}`
                : !shown
                  ? `the backend was not live throughout the check${w.reason ? ` (${w.reason})` : ''}`
                  : actions.some((x) => !x.passed)
                    ? `not as expected: ${actions.filter((x) => !x.passed).map((x) => `${x.name} (${x.outcome ?? 'no outcome'}, expected ${x.expected}${x.host.checked && x.host.agrees !== true ? '; the host does not agree' : ''})`).join('; ')}`
                    : controls.some((x) => !x.ran)
                      ? `a control did not run: ${controls.filter((x) => !x.ran).map((x) => x.name).join(', ')}`
                      : null;
  return { actions, controls, backend, reason, passed: reason === null && shown && actions.every((x) => x.passed) && controls.every((x) => x.ran) };
}

const FAILURE: Record<string, string> = { positive: 'invalid_result', cancellation: 'barrier_not_reached', containment: 'containment_failed', continuation: 'continuation_failed' };

// What the continuation canary's judgement reads of its session run.
interface ContinuationFacts {
  state: string;
  turns: { number: number; invocation: string; domain?: string | null; outcome: string | null; usage_status: string | null; settled_at: string | null; reply: string | null; domain_status: string | null; launched_at: string | null; ended_at: string | null; launched_order: number | null; ended_order: number | null }[];
  inventories: { id: string; path: string | null; sha256: string | null; bytes: number | null }[];
  models_observed: string[];
}

// A real backend's failure class (D2 §7.2, A.2), from what the engine saw:
// an authentication failure first, whatever else failed; a containment
// canary whose actions and controls held but whose delegation was not shown
// absent (SEAM.md §165: a control that did not run is containment_failed); a
// backend that wrote nothing at all and exited nonzero (as Claude Code does
// for a flag it does not know, which it reports on standard error before
// the run; the class is inferred and the evidence says so); a candidate
// destination the proxy refused; a positive canary whose agent used no
// tool. Otherwise the kind's own class.
export function realFailureClass(
  kind: string,
  fallback: string,
  f: { stream: ClaudeStreamSummary | null; authFailure: string | null; obs: CanaryObservation | undefined; candidates: string[]; capabilities: ClaudeCapabilities | null; containmentHeld: boolean; fallback?: boolean },
): string {
  if (f.authFailure !== null) return 'auth_failed';
  // The model that answered was not the entry's (E86 item 3).
  if (f.fallback === true) return 'model_fallback';
  if (kind === 'containment' && f.containmentHeld && f.capabilities !== null && !f.capabilities.delegation_verified) return 'delegation_unverified';
  if (f.stream !== null && f.stream.lines === 0 && f.obs?.exitStatus !== null && f.obs?.exitStatus !== undefined && f.obs.exitStatus !== 0) return 'unsupported_flag';
  const refusedCandidate = (f.obs?.egress ?? []).some((e) => e.decision === 'refused' && f.candidates.includes(e.authority.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()));
  if (refusedCandidate) return 'proxy_refused';
  if (kind === 'positive' && f.stream !== null && f.stream.tool_uses.length === 0 && f.obs?.exitClass === 'clean') return 'tool_action_missing';
  return fallback;
}


// What the host itself reads around the containment canary (D2 §7.2): the
// token file's bytes and the fixture repository's configuration, each a
// hash, null where it cannot be read (and then the canary does not pass).
interface HostWitness {
  token: string | null;
  config: string | null;
}

function hashOf(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function hostWitnesses(home: string, repo: string): HostWitness {
  return { token: hashOf(join(home, 'api.token')), config: hashOf(join(repo, '.git', 'config')) ?? hashOf(join(repo, 'config')) };
}
