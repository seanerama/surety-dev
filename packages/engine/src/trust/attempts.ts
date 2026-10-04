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
    const unexpected: { destination: string; refused_at: string }[] = [];
    for (const kind of CANARY_KINDS) {
      if (canaries.length > 0) {
        const between = await this.drift(attempt);
        if (between !== null) {
          await this.rt.engine('qualification.invalidate', { attempt, reason: between });
          return;
        }
      }
      const item = await this.rt.engine<string>('qualification.canary_item', { attempt, kind });
      const run = await this.dispatch(target, item, attempt);
      const entry = run === null ? await this.failedToStart(a, kind) : await this.judge(a, kind, run, unexpected);
      canaries.push(entry);
      await this.rt.engine('qualification.canary', { attempt, canary: entry, unexpected });
      if (!entry.passed) {
        await this.rt.engine('qualification.conclude', { attempt, canaries, unexpected_contacts: unexpected });
        return;
      }
    }
    const input = await this.entryInput(a, canaries);
    await this.rt.engine('qualification.conclude', { attempt, canaries, unexpected_contacts: unexpected, entry: input });
  }

  // The canary's run, dispatched under the attempt's authority alone; null
  // when it could not be dispatched within its deadline.
  private async dispatch(target: DispatchTarget, item: string, attempt: string): Promise<string | null> {
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      if (await this.launcher.dispatch(target, { id: item }, attempt).catch(() => false)) break;
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
  private async judge(a: AttemptRow, kind: string, run: string, unexpected: { destination: string; refused_at: string }[]): Promise<CanaryEntry> {
    const obs: CanaryObservation | undefined = canaryObservations.get(run);
    canaryObservations.delete(run);
    const facts = await this.rt.read<{ outcome: string | null; exit_class: string | null; transcript: string | null }>('qualification.run_facts', { run });
    for (const e of obs?.egress ?? []) {
      if (e.decision === 'refused' && e.reason === 'not_listed' && e.authority !== CANARY_UNLISTED && !unexpected.some((u) => u.destination === e.authority)) {
        unexpected.push({ destination: e.authority, refused_at: e.opened_at });
      }
    }
    let passed = false;
    let detail: Record<string, unknown> = { kind, run, exit_class: facts.exit_class ?? obs?.exitClass ?? null, outcome: facts.outcome };
    let termToExit: number | null = null;
    if (kind === 'positive') {
      const want = canaryResult(a.id, kind);
      const got = obs?.value as { summary?: unknown } | null | undefined;
      const resultOk = obs?.verdict === 'accepted' && got?.summary === want.summary;
      const editOk = obs?.editContent === canaryEdit(a.id).content;
      passed = obs?.exitClass === 'clean' && resultOk && editOk;
      detail = { ...detail, result_collection: obs?.verdict ?? null, result_matches: resultOk, edit_matches: editOk };
    } else if (kind === 'cancellation') {
      termToExit = obs?.termToExitMs ?? null;
      passed = obs?.barrierSeen === true && obs.exitClass === 'engine_signaled' && termToExit !== null;
      detail = { ...detail, barrier_observed: obs?.barrierSeen ?? false, term_to_exit_ms: termToExit };
    } else {
      const actions = CONTAINMENT_ACTIONS.map((x) => {
        const w = obs?.witnesses.find((y) => y.action === x.name) ?? null;
        return { name: x.name, witnessed: w !== null, outcome: w?.outcome ?? null, expected: x.expected, passed: w !== null && w.outcome === x.expected };
      });
      passed = actions.every((x) => x.passed);
      detail = { actions };
    }
    const evidence = await this.record(a, run, detail);
    let providerError: string | null = null;
    if (!passed) {
      // The run's redacted output (for the scripted backend; a real
      // backend's is its structured provider error, slice 14).
      providerError = facts.transcript ?? (await this.record(a, run, { kind, failure: FAILURE[kind], detail }));
    }
    const failureClass = passed ? null : kind === 'cancellation' && obs?.barrierSeen === true ? 'cancellation_failed' : FAILURE[kind]!;
    return { kind, run, passed, failure_class: failureClass, provider_error: providerError, evidence, term_to_exit_ms: kind === 'cancellation' ? termToExit : null };
  }

  // The entry an attempt whose canaries all passed writes (D2 §§4.1, 7.2).
  private async entryInput(a: AttemptRow, canaries: CanaryEntry[]): Promise<EntryInput> {
    const usage = await this.rt.read<{ observations: number; cost: boolean }>('qualification.usage', { attempt: a.id });
    // How often usage was reported: per model call where the canaries
    // observed it; for the scripted backend, whose usage the test scripts,
    // per invocation (the engine's reading for a stand-in; SEAM.md §148).
    const granularity = usage.observations > 0 ? 'model_call' : a.backend === 'scripted' ? 'invocation' : 'none';
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
    const candidate = JSON.parse(a.candidate_egress) as string[];
    const used = await this.rt.read<string[]>('qualification.used_egress', { attempt: a.id }).catch(() => [] as string[]);
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
      capabilities: { tools: [], denied: [], features_disabled: [], delegation_verified: true },
      host_id: hostIdentity() ?? 'unknown',
      host_qualification: a.host_qualification,
      isolation: ISOLATION_MECHANISM,
      boundary: BOUNDARY_MECHANISM,
      profile_fingerprint: a.profile_fingerprint,
      egress_hosts: candidate.filter((h) => used.includes(h)),
      usage_granularity: granularity,
      usage_semantics: usage.observations > 0 ? 'cumulative' : null,
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

