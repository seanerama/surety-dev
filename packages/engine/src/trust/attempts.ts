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
import { type BackendSampling, type ClaudeCapabilities, type ClaudeStreamSummary, claudeAnswered, claudeAuthFailure, claudeCapabilities, claudeKeyDelivery, claudeProviderError } from '../invoke/adapters/claude.js';
import { CANARY_KINDS, CANARY_UNLISTED, CONTAINMENT_ACTIONS, canaryEdit, canaryResult } from './canaries.js';
import { BOUNDARY_MECHANISM, ISOLATION_MECHANISM, hostIdentity } from './host.js';
import { type CanaryObservation, type DispatchTarget, type Launcher, canaryObservations } from '../invoke/choke.js';
import { helpHash } from '../invoke/static.js';
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
    for (const kind of CANARY_KINDS) {
      if (canaries.length > 0) {
        const between = await this.drift(attempt);
        if (between !== null) {
          await this.rt.engine('qualification.invalidate', { attempt, reason: between });
          return;
        }
      }
      const item = await this.rt.engine<string>('qualification.canary_item', { attempt, kind });
      // The host side's own witnesses (D2 §7.2), read before the
      // containment canary and compared after it.
      const before = kind === 'containment' ? hostWitnesses(this.rt.home, target.repo) : null;
      const run = await this.dispatch(target, item, attempt, a, kind);
      const judged = run === null ? { entry: await this.failedToStart(a, kind), capabilities: null } : await this.judge(a, kind, run, unexpected, before === null ? null : { before, after: hostWitnesses(this.rt.home, target.repo) }, used, history);
      const entry = judged.entry;
      if (judged.capabilities !== null) capabilities = judged.capabilities;
      canaries.push(entry);
      await this.rt.engine('qualification.canary', { attempt, canary: entry, unexpected });
      if (!entry.passed) {
        await this.rt.engine('qualification.conclude', { attempt, canaries, unexpected_contacts: unexpected });
        return;
      }
    }
    const input = await this.entryInput(a, canaries, [...used], history, capabilities);
    await this.rt.engine('qualification.conclude', { attempt, canaries, unexpected_contacts: unexpected, entry: input });
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

  private async failedToStart(a: AttemptRow, kind: string): Promise<CanaryEntry> {
    const record = await this.record(a, null, { kind, outcome: 'not_dispatched' });
    return { kind, run: null, passed: false, failure_class: FAILURE[kind]!, provider_error: record, evidence: record, term_to_exit_ms: null };
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
    const authFailure = stream !== null ? claudeAuthFailure(stream) : null;
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
    if (kind === 'positive') {
      const want = canaryResult(a.id, kind);
      const got = obs?.value as { summary?: unknown } | null | undefined;
      const resultOk = obs?.verdict === 'accepted' && got?.summary === want.summary;
      const editOk = obs?.editContent === canaryEdit(a.id).content;
      passed = obs?.exitClass === 'clean' && resultOk && editOk && (!real || (stream !== null && authFailure === null));
      detail = { ...detail, result_collection: obs?.verdict ?? null, result_matches: resultOk, edit_matches: editOk };
    } else if (kind === 'cancellation') {
      termToExit = obs?.termToExitMs ?? null;
      // A real backend must have been authenticated and answering when it
      // reached the barrier (D2 §7.2): a model answer with no
      // authentication failure in its stream.
      const answered = !real || (stream !== null && claudeAnswered(stream));
      passed = obs?.barrierSeen === true && obs.exitClass === 'engine_signaled' && termToExit !== null && answered;
      detail = { ...detail, barrier_observed: obs?.barrierSeen ?? false, term_to_exit_ms: termToExit, ...(real ? { authenticated: answered } : {}) };
    } else {
      // Each action witnessed by the init (it performed the action itself,
      // asked by a probe program the backend ran with the action's exact
      // arguments), every witness of it the expected outcome, and the host
      // side agreeing (D2 §7.2; the review's S1).
      const refusedUnlisted = (obs?.egress ?? []).some((e) => e.authority === CANARY_UNLISTED && e.decision === 'refused');
      const corroboration: Record<string, { checked: boolean; agrees: boolean | null; what: string }> = {
        token_read: { checked: true, agrees: host !== null && host.before.token !== null && host.before.token === host.after.token, what: "the token file's bytes unchanged, read from the host" },
        git_config: { checked: true, agrees: host !== null && host.before.config !== null && host.before.config === host.after.config, what: "the fixture repository's configuration unchanged, read from the host" },
        unlisted_connect: { checked: true, agrees: refusedUnlisted, what: "the proxy's log shows the unlisted CONNECT refused" },
        engine_port: { checked: false, agrees: null, what: 'not corroborated host-side: the engine keeps no record of a connection that never reached it' },
        workspace_write: { checked: false, agrees: null, what: 'the control: the init observed the write' },
      };
      const actions = CONTAINMENT_ACTIONS.map((x) => {
        const ws = obs?.witnesses.filter((y) => y.action === x.name) ?? [];
        const c = corroboration[x.name]!;
        const outcome = ws.at(-1)?.outcome ?? null;
        const ok = ws.length > 0 && ws.every((w) => w.outcome === x.expected) && (!c.checked || c.agrees === true);
        return { name: x.name, witnessed: ws.length > 0, outcome, expected: x.expected, host: c, passed: ok };
      });
      passed = actions.every((x) => x.passed);
      detail = { actions };
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
              };
        capabilities = claudeCapabilities(
          history.map((h) => h.stream).filter((x): x is ClaudeStreamSummary => x !== null),
          merged,
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
                key_delivery: claudeKeyDelivery(stream),
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
    const evidence = await this.record(a, run, redactValue(detail));
    let failureClass: string | null = null;
    if (!passed) {
      failureClass = kind === 'cancellation' && obs?.barrierSeen === true ? 'cancellation_failed' : FAILURE[kind]!;
      if (real) failureClass = realFailureClass(kind, failureClass, { stream, authFailure, obs, candidates, capabilities, actionsPassed: kind === 'containment' && (detail.actions as { passed: boolean }[]).every((x) => x.passed) });
    }
    let providerError: string | null = null;
    if (!passed) {
      // The scripted backend's: the run's redacted output. A real backend's:
      // its structured provider error, redacted (D2 §7.2, N04).
      providerError = real
        ? await this.record(a, run, redactValue({ kind, failure_class: failureClass, provider_error: stream === null ? null : claudeProviderError(stream), exit_class: facts.exit_class ?? obs?.exitClass ?? null, exit_status: obs?.exitStatus ?? null, transcript: facts.transcript }))
        : (facts.transcript ?? (await this.record(a, run, { kind, failure: FAILURE[kind], detail })));
    }
    return { entry: { kind, run, passed, failure_class: failureClass, provider_error: providerError, evidence, term_to_exit_ms: kind === 'cancellation' ? termToExit : null }, capabilities };
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
      session_qualified: false,
      provider_files: providerFiles,
      term_to_exit_ms: canaries.find((c) => c.kind === 'cancellation')?.term_to_exit_ms ?? null,
      qualification_attempt: a.id,
      evidence,
    };
  }
}

const FAILURE: Record<string, string> = { positive: 'invalid_result', cancellation: 'barrier_not_reached', containment: 'containment_failed' };

// A real backend's failure class (D2 §7.2, A.2), from what the engine saw:
// an authentication failure first, whatever else failed; a containment
// canary whose actions held but whose delegation was not shown absent; a
// backend that wrote nothing at all and exited nonzero (as Claude Code does
// for a flag it does not know, which it reports on standard error before
// the run; the class is inferred and the evidence says so); a candidate
// destination the proxy refused; a positive canary whose agent used no
// tool. Otherwise the kind's own class.
function realFailureClass(
  kind: string,
  fallback: string,
  f: { stream: ClaudeStreamSummary | null; authFailure: string | null; obs: CanaryObservation | undefined; candidates: string[]; capabilities: ClaudeCapabilities | null; actionsPassed: boolean },
): string {
  if (f.authFailure !== null) return 'auth_failed';
  if (kind === 'containment' && f.actionsPassed && f.capabilities !== null && !f.capabilities.delegation_verified) return 'delegation_unverified';
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
