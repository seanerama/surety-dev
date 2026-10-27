// A workspace assistant turn through the runner boundary (the assistant
// design of 2026-10-27, §4; D1 §§15.1, 15.4). The turn was admitted in the
// store's transaction of its receipt (store/transitions/assistant.ts), which
// asked for a tick; the scheduler's tick dispatches it here, the choke
// point's own directory, never the API route. There is no other scheduler
// and no background loop.
//
// The reads were chosen by the engine before the admission (the gateway's
// allowlisted, closed-argument reads; assistant/service.ts); the turn's
// context package carries only what they returned (assistant/turn-package.ts).
// The turn is one one-shot invocation of the active assistant entry's binary
// with its assistant template, in an execution domain with no repository
// mounted: on the real boundary the sandbox of D2 (launcher, cgroup, egress
// proxy with only the entry's hosts and no project widening, a mount plan of
// /surety/context read-only and /surety/out), and only in the engine's test
// mode the kernel lane's scripted boundary (a direct spawn in its own
// process group, as the choke point's scripted path does).
//
// Each usage observation is checked against the turn limit; passing it stops
// the turn. The turn's deadline and the owner's cancel stop it too. Its end,
// once the domain's termination is established, is one transaction that
// writes its terminal observation and its one ledger row. Nothing is retried.
// The model's reply never becomes an action: it is validated against its
// schema and its evidence, and kept as text, citations and internal links.

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { type TurnPackage, validateReply, writeTurnPackage } from '../assistant/turn-package.js';
import { createDomainCgroup, verifyLimits } from '../boundary/cgroup.js';
import { terminateDomain } from '../boundary/terminate.js';
import { processStartTime } from '../lock.js';
import { heldSecret, redactText, redactValue } from '../records/redact.js';
import { writeWholeRecord } from '../records/files.js';
import { type Runtime, log } from '../runtime.js';
import type { DomainRow } from '../store/transitions/boundary.js';
import type { TurnClaim, TurnOutcome } from '../store/transitions/assistant.js';
import type { EgressAccount } from '../store/transitions/ledger.js';
import { pausePoint, seamLauncherBarriers, seamLauncherReached, seamObserveDomain, seamRefuseEntryBinary, seamSandboxBinds } from '../testing/seam.js';
import { ClaudeStream, claudeAuthFailure, claudeModelFallback } from './adapters/claude.js';
import { templateOf } from './adapters/templates.js';
import { RoleOutput } from './choke.js';
import { collectResult } from './collect.js';
import { exitCause } from './exit-cause.js';
import { DOMAIN_MARKER, INVOCATION_MARKER, markedProcesses, signalFound, signalRecordedGroup } from './processes.js';
import { finishEgressAccount, startEgress } from './proxy/egress.js';
import type { DomainProxy } from './proxy/proxy.js';
import { EGRESS_SOCKET, buildPlan, entriesFingerprint, planEntries } from './sandbox/mounts.js';
import { FORWARDER_PORT, domainArea } from './sandbox/prepare.js';
import { engineNode, initNodeCopy, initNodeIn, resolveSandboxTools } from './sandbox/tools.js';
import { type BackendLaunch, INIT_SCRIPT, SandboxLaunch } from './sandboxed.js';
import { helpHash } from './static.js';

// The end of one turn as decided.
interface Decided {
  outcome: TurnOutcome;
  reason: string;
  text: string | null;
}

// A turn under way in this incarnation: what termination needs of its holder
// (boundary/terminate.ts's DomainHolder) and what its supervision saw.
class Turn {
  readonly claim: { domain: string };
  sandbox: SandboxLaunch | null = null;
  backendStarted = false;
  terminal: 'success' | 'failure' | null = null;
  child: ChildProcess | null = null;
  pid: number | null = null;
  startTime: string | null = null;
  exit: { code: number | null; signal: string | null } | null = null;
  decided: Decided | null = null;
  // The scripted protocol's result line (the kernel lane has no /surety/out).
  streamResult: { value: unknown } | null = null;
  adapter: ClaudeStream | null = null;
  egress: DomainProxy | null = null;
  egressEvidence: EgressAccount[] = [];
  egressEntries: { authority: string; decision: string; reason: string | null; opened_at: string; bytes_up?: number; bytes_down?: number }[] = [];
  output: RoleOutput | null = null;
  deadline: NodeJS.Timeout | null = null;
  private fire: () => void = () => {};
  readonly stopped: Promise<void>;
  constructor(readonly c: TurnClaim) {
    this.claim = { domain: c.domain };
    this.stopped = new Promise<void>((resolve) => (this.fire = resolve));
  }
  // The engine decides the turn's end once; the backend is then cancelled.
  stop(outcome: TurnOutcome, reason: string, text: string | null): void {
    if (this.decided !== null) return;
    this.decided = { outcome, reason, text };
    this.fire();
  }
}

export class AssistantTurns {
  // Each owner message's package, by conversation and intent, registered
  // before its admission (the reads are the engine's, made then).
  private readonly packages = new Map<string, TurnPackage>();
  private readonly turns = new Map<string, Turn>();
  private readonly starting = new Set<string>();
  private readonly waiters = new Map<string, (() => void)[]>();
  // The assistant service's hook: a settled turn's message written into its
  // conversation (assistant/service.ts).
  onSettled: ((invocation: string) => Promise<void>) | null = null;

  constructor(private readonly rt: Runtime) {}

  private key = (conversation: string, intent: string) => `${conversation}\u0000${intent}`;

  provide(conversation: string, intent: string, pkg: TurnPackage): void {
    this.packages.set(this.key(conversation, intent), pkg);
  }

  withdraw(conversation: string, intent: string): void {
    this.packages.delete(this.key(conversation, intent));
  }

  // Resolves once the turn has ended (or `ms` has passed).
  settled(invocation: string, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
      const list = this.waiters.get(invocation) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
      this.waiters.set(invocation, list);
    });
  }

  private settle(invocation: string): void {
    const list = this.waiters.get(invocation) ?? [];
    this.waiters.delete(invocation);
    for (const f of list) f();
  }

  // The owner's cancel (recorded in the store first): a turn under way is
  // stopped; one not yet launched is ended at its dispatch.
  cancel(invocation: string): void {
    this.turns.get(invocation)?.stop('stopped', 'assistant_cancelled', 'the owner cancelled the turn');
  }

  // From the scheduler's tick: every admitted turn launched, without the
  // tick waiting for its run. Returns how many were dispatched.
  async dispatchDue(): Promise<number> {
    const due = await this.rt.read<string[]>('assistant.admitted');
    let n = 0;
    for (const invocation of due) {
      if (this.turns.has(invocation) || this.starting.has(invocation)) continue;
      this.starting.add(invocation);
      n++;
      void this.run(invocation)
        .catch((err) => log('assistant turn', err, { invocation }))
        .finally(() => {
          this.starting.delete(invocation);
          this.turns.delete(invocation);
          this.settle(invocation);
          void this.onSettled?.(invocation).catch((err) => log('assistant conversation', err, { invocation }));
        });
    }
    return n;
  }

  private async end(invocation: string, d: Decided, extra: { exit?: { exit_class: string | null; exit_evidence: string | null } | null; reply?: unknown; egress?: EgressAccount[]; neverRan?: boolean } = {}): Promise<void> {
    await this.rt.engine('assistant.end', {
      invocation,
      never_ran: extra.neverRan === true,
      outcome: d.outcome,
      reason: d.reason,
      reason_text: d.text === null ? null : redactText(d.text),
      exit: extra.exit ?? null,
      reply: extra.reply ?? null,
      egress: extra.egress ?? [],
    });
  }

  private async run(invocation: string): Promise<void> {
    const c = await this.rt.read<TurnClaim | null>('assistant.claim', { invocation });
    if (c === null) return;
    const turn = new Turn(c);
    this.turns.set(invocation, turn);
    if (!(await this.rt.engine<boolean>('assistant.dispatched', { invocation }))) return;
    const pkg = this.packages.get(this.key(c.conversation, c.intent_id)) ?? null;
    this.packages.delete(this.key(c.conversation, c.intent_id));
    const state = await this.rt.read<{ cancel_requested_at: string | null } | null>('assistant.turn', { invocation });
    // Refused before anything is spawned: nothing was spent, no row (§4).
    const refuse = async (code: string, text: string) => {
      await this.rt.engine('domain.terminated', { domain: c.domain, observed: false }).catch((err) => log('assistant turn', err, { invocation }));
      await this.end(invocation, { outcome: 'refused', reason: code, text });
    };
    if (state?.cancel_requested_at) return refuse('assistant_cancelled', 'the owner cancelled the turn before it was launched');
    if (pkg === null) return refuse('infra_error', "the turn's context package is not held by this engine (it was admitted by another start)");
    const pre = await this.preflight(c);
    if (pre !== null) return refuse(pre.code, pre.reason);
    // The deadline from the receipt (turn_deadline_seconds at admission).
    const left = Date.parse(c.deadline_at) - Date.now();
    turn.deadline = setTimeout(() => turn.stop('timed_out', 'assistant_timed_out', 'the turn passed its turn_deadline_seconds'), Math.max(0, left));
    turn.deadline.unref?.();
    if (c.backend === 'claude') turn.adapter = new ClaudeStream({ costAs: c.auth_mode === 'subscription_token' ? 'estimated' : 'reported' });
    try {
      if (this.rt.boundary() === 'scripted') await this.kernel(turn, pkg);
      else if (this.rt.scope !== null && c.cgroup_path !== null) await this.sandboxed(turn, pkg);
      else {
        await refuse('isolation_unqualified', 'The engine has no incarnation scope, so no domain can be placed in the execution boundary.');
        return;
      }
    } catch (err) {
      // A failure of the engine's own: the turn is ended `failed` once its
      // domain is established terminated (never charged before), or its
      // domain quarantined; never left holding its reservation unseen.
      log('assistant turn', err, { invocation });
      const d = await this.rt.read<DomainRow | null>('domain.row', { domain: c.domain }).catch(() => null);
      if (d !== null && d.status === 'terminated') await this.end(invocation, turn.decided ?? { outcome: 'failed', reason: 'infra_error', text: 'the engine failed while running the turn' }).catch((e) => log('assistant turn', e, { invocation }));
      else await this.rt.engine('assistant.quarantine', { domain: c.domain, subject: { account: 'workspace_assistant', invocation } }).catch((e) => log('assistant quarantine', e, { invocation }));
    } finally {
      if (turn.deadline) clearTimeout(turn.deadline);
    }
  }

  // The checks before anything is spawned (D2 §§1.2, 2.5, 7.3): the test
  // mode's refusal of a real binary, the entry's binary and help as
  // qualified (a change revokes it), and its credential held.
  private async preflight(c: TurnClaim): Promise<{ code: string; reason: string } | null> {
    const real = seamRefuseEntryBinary(c.binary_path, c.backend, true);
    if (real !== null) return { code: 'backend_refused', reason: `This engine does not launch ${c.backend}'s own binary here: ${real}.` };
    let found: string | null;
    try {
      found = createHash('sha256').update(await readFile(c.binary_path)).digest('hex');
    } catch {
      found = null;
    }
    if (found !== c.binary_sha256) {
      await this.rt.engine('trust.revoke_drifted', { entry: c.trust_entry, binaries: { [c.binary_path]: found } }).catch((err) => log('trust revocation', err, { invocation: c.invocation }));
      return { code: 'backend_refused', reason: `The binary at ${c.binary_path} ${found === null ? 'cannot be read' : 'is not the one the assistant trust entry names'}; the entry is revoked.` };
    }
    const help = await helpHash(c.binary_path, c.backend).catch(() => null);
    if (help !== null && help !== c.help_sha256) {
      await this.rt.engine('trust.revoke_drifted', { entry: c.trust_entry, helps: { [c.binary_path]: help } }).catch((err) => log('trust revocation', err, { invocation: c.invocation }));
      return { code: 'backend_refused', reason: `The help of ${c.binary_path} is not the one the qualification recorded; the entry is revoked.` };
    }
    if (c.key_ref !== '' && heldSecret(c.key_ref) === null) return { code: 'backend_refused', reason: `The credential ${c.key_ref} the assistant entry takes is not held by this engine, so the backend is not launched without it.` };
    return null;
  }

  private template(c: TurnClaim) {
    return templateOf(c.backend, { scripted: true, authMode: c.auth_mode, purpose: 'assistant' })!;
  }

  private requestLine(c: TurnClaim, context: string): string {
    return `${JSON.stringify({ invocation: c.invocation, domain: c.domain, role: 'workspace_assistant', work_kind: 'workspace_assistant', context })}\n`;
  }

  // A protocol line of the backend's output: usage recorded and checked
  // against the turn limit; a terminal event noted; the scripted result held.
  private async line(turn: Turn, line: string): Promise<void> {
    const c = turn.c;
    const usage: { semantics: 'cumulative' | 'delta'; raw: unknown }[] = [];
    let terminal = false;
    if (turn.adapter !== null) {
      const r = turn.adapter.feed(line);
      usage.push(...r.usage);
      if (r.terminal !== null) {
        turn.terminal = r.terminal;
        terminal = true;
      }
      if (r.protocolError !== null) turn.terminal = 'failure';
    } else {
      let m: Record<string, unknown>;
      try {
        const v = JSON.parse(line) as unknown;
        if (typeof v !== 'object' || v === null || Array.isArray(v)) return;
        m = v as Record<string, unknown>;
      } catch {
        return;
      }
      if (m.type === 'usage' && (m.semantics === 'cumulative' || m.semantics === 'delta') && typeof m.raw === 'object' && m.raw !== null && !Array.isArray(m.raw)) usage.push({ semantics: m.semantics, raw: m.raw });
      if (m.type === 'result') {
        if (turn.sandbox === null && turn.streamResult === null) turn.streamResult = { value: redactValue(m.result) };
        turn.terminal = m.is_error === true || (m.subtype !== undefined && m.subtype !== 'success') ? 'failure' : 'success';
        terminal = true;
      }
    }
    for (const u of usage) {
      const recorded = await this.rt.engine<boolean>('assistant.usage', { invocation: c.invocation, semantics: u.semantics, raw: redactValue(u.raw) });
      if (!recorded) continue;
      const over = await this.rt.read<string | null>('assistant.limit_check', { invocation: c.invocation, terminal }).catch(() => 'assistant_usage_unknown');
      if (over !== null) turn.stop('stopped', over, over === 'assistant_turn_limit' ? 'the turn passed its turn_limit_billable_tokens' : "the turn's usage could not be judged against its limit");
    }
  }

  // ---- the kernel lane (the engine's test mode only) ----------------------------------------

  private async kernel(turn: Turn, pkg: TurnPackage): Promise<void> {
    const c = turn.c;
    const area = domainArea(this.rt.home, c.domain);
    const context = join(area, 'context');
    const out = join(area, 'out');
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writeTurnPackage(context, pkg);
    const template = this.template(c);
    const key = template.keyVariable === '' ? null : heldSecret(c.key_ref);
    await pausePoint('assistant.before_spawn');
    if (turn.decided !== null) {
      await this.rt.engine('domain.terminated', { domain: c.domain, observed: false });
      return this.end(c.invocation, { ...turn.decided, outcome: 'refused' });
    }
    let child: ChildProcess;
    try {
      child = spawn(c.binary_path, template.render({ model: c.model, invocation: c.invocation }), {
        cwd: out,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', [DOMAIN_MARKER]: c.domain, [INVOCATION_MARKER]: c.invocation, ...template.env, ...(key === null ? {} : { [template.keyVariable]: key }) },
        detached: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (err) {
      log('assistant spawn', err, { invocation: c.invocation });
      await this.rt.engine('domain.terminated', { domain: c.domain, observed: false });
      return this.end(c.invocation, { outcome: 'refused', reason: 'infra_error', text: 'the backend could not be spawned' });
    }
    if (child.pid === undefined) {
      child.once('error', (err) => log('assistant spawn', err, { invocation: c.invocation }));
      await this.rt.engine('domain.terminated', { domain: c.domain, observed: false });
      return this.end(c.invocation, { outcome: 'refused', reason: 'infra_error', text: 'the backend could not be spawned' });
    }
    child.on('error', (err) => log('assistant process', err, { invocation: c.invocation }));
    turn.child = child;
    turn.pid = child.pid;
    try {
      turn.startTime = processStartTime(child.pid);
    } catch {
      turn.startTime = null;
    }
    const output = new RoleOutput(child.stdout!, () => {});
    turn.output = output;
    const exited = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        turn.exit = { code, signal };
        output.exited();
        resolve();
      });
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(this.requestLine(c, context));
    await this.rt.engine('assistant.launched', { invocation: c.invocation, domain: c.domain, pid: child.pid, pgid: child.pid, startTime: turn.startTime });
    // Read the output until it ends; a decided end cancels the backend.
    let killing = false;
    const kill = async () => {
      if (killing) return;
      killing = true;
      await this.signalKernel(turn, 'SIGTERM');
    };
    void turn.stopped.then(kill);
    for (let l = await output.next(); l !== null; l = await output.next()) {
      await this.line(turn, l).catch((err) => log('assistant line', err, { invocation: c.invocation }));
    }
    output.close();
    await Promise.race([exited, turn.stopped.then(() => sleep(this.rt.setting('terminate_grace') * 1000))]);
    const terminated = await this.terminateKernel(turn);
    if (!terminated) {
      await this.rt.engine('assistant.quarantine', { domain: c.domain, subject: { account: 'workspace_assistant', invocation: c.invocation } }).catch((err) => log('assistant quarantine', err, { invocation: c.invocation }));
      return this.end(c.invocation, turn.decided ?? { outcome: 'failed', reason: 'assistant_termination_unknown', text: "the termination of the turn's domain could not be established; nothing it left was read" });
    }
    const decided = turn.decided !== null ? { d: turn.decided } : this.decideKernel(turn, pkg);
    return this.end(c.invocation, decided.d, { reply: 'reply' in decided ? decided.reply : null });
  }

  private async signalKernel(turn: Turn, sig: NodeJS.Signals): Promise<void> {
    if (turn.pid !== null && turn.startTime !== null) signalRecordedGroup(turn.pid, turn.pid, turn.startTime, sig);
    for (const p of markedProcesses(turn.c.domain) ?? []) signalFound(p, sig);
  }

  // Termination on the scripted boundary (as the run-end protocol's step 2):
  // TERM, KILL after terminate_grace, and the boundary's report.
  private async terminateKernel(turn: Turn): Promise<boolean> {
    const graceMs = this.rt.setting('terminate_grace') * 1000;
    const killMs = this.rt.setting('kill_grace') * 1000;
    const start = performance.now();
    let termSent = false;
    let killSent = false;
    for (;;) {
      const observed = seamObserveDomain(turn.c.domain);
      if (observed === 'terminated') {
        await this.rt.engine('domain.terminated', { domain: turn.c.domain, observed: true });
        return true;
      }
      const elapsed = performance.now() - start;
      if (!termSent) {
        await this.signalKernel(turn, 'SIGTERM');
        termSent = true;
      } else if (!killSent && elapsed >= graceMs) {
        await this.signalKernel(turn, 'SIGKILL');
        killSent = true;
      }
      if (observed === 'unknown' || elapsed >= graceMs + killMs) return false;
      await sleep(200);
    }
  }

  private decideKernel(turn: Turn, pkg: TurnPackage): { d: Decided; reply?: unknown } {
    if (turn.exit?.code === 0 && turn.streamResult !== null) return this.judgeReply(turn, pkg, turn.streamResult.value);
    if (turn.exit?.code === 0) return { d: { outcome: 'failed', reason: 'invalid_result', text: 'the backend exited 0 without a reply' } };
    return { d: { outcome: 'failed', reason: 'assistant_provider_error', text: `the backend exited ${turn.exit?.code ?? 'by a signal'} without a reply` } };
  }

  private judgeReply(turn: Turn, pkg: TurnPackage, value: unknown): { d: Decided; reply?: unknown } {
    const fallback = turn.adapter !== null ? claudeModelFallback(turn.adapter.summary(), turn.c.model) : null;
    if (fallback !== null) return { d: { outcome: 'failed', reason: 'invalid_result', text: `model_fallback: ${fallback.text}` } };
    const judged = validateReply(value, pkg.evidence.map((e) => e.id));
    if ('invalid' in judged) return { d: { outcome: 'failed', reason: 'invalid_result', text: judged.invalid } };
    return { d: { outcome: 'completed', reason: 'none', text: null }, reply: redactValue(judged.reply) };
  }

  // ---- the real boundary --------------------------------------------------------------------

  private async sandboxed(turn: Turn, pkg: TurnPackage): Promise<void> {
    const c = turn.c;
    const rt = this.rt;
    const tools = (await resolveSandboxTools()).paths;
    if (!tools.unshare || !tools.setpriv || !tools.ip || !tools.mount || !tools.umount || !tools.pivot_root || !tools.mknod) {
      await rt.engine('domain.terminated', { domain: c.domain, observed: false });
      return this.end(c.invocation, { outcome: 'refused', reason: 'isolation_unqualified', text: "the sandbox's tools are missing" });
    }
    const made = domainArea(rt.home, c.domain);
    for (const d of ['root', 'vol', 'context']) mkdirSync(join(made, d), { recursive: true, mode: 0o700 });
    const area = realpathSync(made);
    writeTurnPackage(join(area, 'context'), pkg);
    // The cgroup, only while the launch is not closed, and only at this
    // domain's directory in this engine's own scope (D2 §3.2).
    const may = await rt.read<{ cgroup_path: string | null; may: boolean }>('domain.may_create', { domain: c.domain });
    if (rt.scope === null || !may.may || may.cgroup_path === null || may.cgroup_path !== join(rt.scope.path, c.domain)) {
      await rt.engine('domain.close', { domain: c.domain, cause: 'not_created' });
      await rt.engine('domain.terminated', { domain: c.domain, observed: false });
      return this.end(c.invocation, { outcome: 'refused', reason: 'isolation_unqualified', text: "the turn's domain could not be created in this engine's scope" });
    }
    const limits = { memoryMax: c.memory_max, tasksMax: rt.setting('domain_tasks_max') };
    const inode = createDomainCgroup(may.cgroup_path, limits);
    await rt.engine('domain.cgroup_created', { domain: c.domain, inode });
    // The egress proxy: the entry's own hosts and nothing else (no project
    // widening applies to the assistant, §3). Its log's bound stops the turn.
    turn.egress = await startEgress(rt, {
      area,
      domain: c.domain,
      run: null,
      invocation: c.invocation,
      profile: 'role',
      allow: c.egress_hosts,
      onLogBound: () => turn.stop('failed', 'infra_error', `the egress log reached egress_log_max_bytes (${rt.setting('egress_log_max_bytes')} bytes)`),
    });
    const template = this.template(c);
    const writable = rt.setting('domain_writable_bytes');
    const plan = buildPlan({
      area,
      context: join(area, 'context'),
      workspace: null,
      readPaths: [c.binary_path],
      writablePaths: [...new Set(seamSandboxBinds().filter((b) => b.writable).map((b) => b.path))],
      volBytes: writable,
      volInodes: rt.setting('domain_writable_inodes'),
      shmBytes: Math.min(writable, 64 * 1024 * 1024),
      tools: { mount: tools.mount, umount: tools.umount, pivot_root: tools.pivot_root, ip: tools.ip, unshare: tools.unshare, setpriv: tools.setpriv, mknod: tools.mknod },
      node: engineNode(),
      initNodeCopy: await initNodeIn(area, await initNodeCopy(rt.home)),
      initScript: INIT_SCRIPT,
      git: null,
      egressSocket: turn.egress.socketPath,
      holdVolatile: true,
    });
    const entries = planEntries(plan);
    const fingerprint = entriesFingerprint(entries, { area, workspace: null });
    const record = await writeWholeRecord(rt, { project: null, run: null, kind: 'qualification_evidence', content: Buffer.from(JSON.stringify({ profile: 'role', purpose: 'workspace_assistant', fingerprint, domain: c.domain, invocation: c.invocation, entries }, null, 2)) });
    await rt.engine('domain.plan', { domain: c.domain, fingerprint, mounts: entries, record });
    const key = template.keyVariable === '' ? null : heldSecret(c.key_ref);
    const backend: BackendLaunch = {
      argv: [c.binary_path, ...template.render({ model: c.model, invocation: c.invocation })],
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        HOME: '/surety/home',
        XDG_CONFIG_HOME: '/surety/home/.config',
        XDG_CACHE_HOME: '/surety/home/.cache',
        XDG_DATA_HOME: '/surety/home/.local/share',
        XDG_STATE_HOME: '/surety/home/.local/state',
        TMPDIR: '/tmp',
        HTTPS_PROXY: `http://127.0.0.1:${FORWARDER_PORT}`,
        [DOMAIN_MARKER]: c.domain,
        [INVOCATION_MARKER]: c.invocation,
        ...template.env,
        ...(key === null ? {} : { [template.keyVariable]: key }),
      },
      cwd: '/surety/out',
      stdin: this.requestLine(c, '/surety/context'),
      forwarder: { port: FORWARDER_PORT, socket: EGRESS_SOCKET },
    };
    let started: () => void = () => {};
    const backendStarted = new Promise<void>((resolve) => (started = resolve));
    const w = seamLauncherBarriers(rt.home);
    const launch = new SandboxLaunch(
      { domain: c.domain, invocation: c.invocation, incarnation: rt.incarnation, generation: 1, cgroup: c.cgroup_path, unshare: tools.unshare, node: engineNode(), ...(w ? { waits: w.barriers, releaseDir: w.releaseDir } : {}) },
      {
        barrier: (name) => pausePoint(name),
        reached: (name, action) => seamLauncherReached(name, action),
        placed: async (pid) => {
          await rt.engine('domain.placed', { domain: c.domain, pid });
        },
        authorize: async () => {
          if (turn.decided !== null) return false;
          const wrong = verifyLimits(c.cgroup_path!, limits);
          if (wrong !== null) {
            turn.stop('refused', 'isolation_unqualified', `the domain's cgroup limits do not read as the engine wrote them (${wrong})`);
            return false;
          }
          const r = await rt.engine<{ granted: boolean }>('assistant.authorize', { domain: c.domain, invocation: c.invocation, incarnation: rt.incarnation, pid: launch.pid, startTime: launch.startTime });
          return r.granted && turn.decided === null;
        },
        plan: () => plan,
        backend: () => backend,
        started: async () => {
          turn.backendStarted = true;
          started();
        },
        setupFailed: (detail) => {
          turn.stop('refused', 'isolation_unqualified', `the sandbox could not be built: ${detail}`);
          rt.rerunHostChecks();
        },
      },
    );
    turn.sandbox = launch;
    const output = new RoleOutput(launch.output, () => {}, {
      lineMax: rt.setting('stream_line_max_bytes'),
      queueMax: rt.setting('stream_queue_max_bytes'),
      onBound: (why) => turn.stop('failed', 'infra_error', why),
    });
    turn.output = output;
    void launch.backendDone.then(() => {
      launch.ackExit();
      const report = launch.exitReport;
      turn.exit = report === null ? { code: null, signal: null } : { code: report.code, signal: report.signal === null ? null : String(report.signal) };
      output.exited();
    });
    // A decided end closes the launch and cancels the backend through the
    // boundary: termination below does both (closure, TERM, cgroup.kill).
    void turn.stopped.then(() => {
      launch.closed = true;
      launch.term();
    });
    await Promise.race([backendStarted, launch.launcherExited]);
    try {
      for (let l = await output.next(); l !== null; l = await output.next()) {
        await this.line(turn, l).catch((err) => log('assistant line', err, { invocation: c.invocation }));
      }
    } finally {
      output.close();
    }
    await Promise.race([launch.backendDone, turn.stopped]);
    // Termination with closure, whatever the turn did (D2 §§3.2, 3.4).
    const d = await rt.read<DomainRow>('domain.row', { domain: c.domain });
    const verdict = await terminateDomain({ rt, d, incarnation: rt.incarnation, handle: turn });
    try {
      if (!verdict.terminated) {
        await rt.engine('assistant.quarantine', { domain: c.domain, subject: { account: 'workspace_assistant', invocation: c.invocation } }).catch((err) => log('assistant quarantine', err, { invocation: c.invocation }));
        return this.end(c.invocation, turn.decided ?? { outcome: 'failed', reason: 'assistant_termination_unknown', text: `the termination of the turn's domain could not be established: ${verdict.unknown ?? 'unknown'}` });
      }
      // The egress evidence of the terminated domain (E85): what the row may
      // rest the labelled zero on (O6).
      if (turn.egress !== null) {
        const egress = turn.egress;
        turn.egress = null;
        turn.egressEntries = egress.entries.map((e) => ({ authority: e.authority, decision: e.decision, reason: e.reason, opened_at: e.opened_at, bytes_up: e.bytes_up, bytes_down: e.bytes_down }));
        turn.egressEvidence.push(await finishEgressAccount(rt, egress, { project: null, run: null }));
      }
      const exit = await rt.read<{ exit_class: string | null; exit_evidence: string | null } | null>('domain.exit_of', { domain: c.domain }).catch(() => null);
      if (!turn.backendStarted) {
        // The backend never started (the init said so): nothing was spent.
        return this.end(c.invocation, turn.decided ? { ...turn.decided, outcome: 'refused' } : { outcome: 'refused', reason: 'isolation_unqualified', text: 'the launcher ended before the backend started' }, { egress: turn.egressEvidence, neverRan: true });
      }
      const decided = turn.decided ? { d: turn.decided } : this.decideSandboxed(turn, pkg, exit?.exit_class ?? 'unknown', launch);
      return this.end(c.invocation, decided.d, { exit, reply: 'reply' in decided ? decided.reply : null, egress: turn.egressEvidence });
    } finally {
      launch.releaseVolatile();
      launch.closeChannel();
    }
  }

  // What the exit class, the stream and the result file give (D2 §1.6, as a
  // run's; §4's failure classes).
  private decideSandboxed(turn: Turn, pkg: TurnPackage, cls: string, launch: SandboxLaunch): { d: Decided; reply?: unknown } {
    const summary = turn.adapter?.summary() ?? null;
    if (summary !== null) {
      const auth = claudeAuthFailure(summary, turn.c.auth_mode);
      if (auth !== null) return { d: { outcome: 'failed', reason: 'assistant_auth_failed', text: auth } };
    }
    if (cls === 'clean') {
      const r = collectResult(launch.volatile, {
        resultMaxBytes: this.rt.setting('result_max_bytes'),
        entriesMax: this.rt.setting('collect_entries_max'),
        filesMaxBytes: this.rt.setting('provider_files_max_bytes'),
        deadlineMs: this.rt.setting('collect_deadline') * 1000,
      });
      if (r.state === 'secret') return { d: { outcome: 'failed', reason: 'invalid_result', text: 'secret_refused: the secret screen refused the reply' } };
      if (r.state !== 'read') return { d: { outcome: 'failed', reason: 'invalid_result', text: `the backend exited clean and left no readable reply (${r.state})` } };
      let value: unknown;
      try {
        value = redactValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(r.bytes)));
      } catch {
        return { d: { outcome: 'failed', reason: 'invalid_result', text: 'the reply is not JSON' } };
      }
      return this.judgeReply(turn, pkg, value);
    }
    if (cls === 'error_exit') {
      const cause = exitCause(summary, turn.egressEntries);
      return { d: { outcome: 'failed', reason: 'assistant_provider_error', text: `exit class error_exit: the backend failed without a reply${cause ? `; ${cause}` : ''}` } };
    }
    return { d: { outcome: 'failed', reason: 'infra_error', text: `exit class ${cls}` } };
  }

  // ---- startup recovery (D1 §16.1; the assistant design §4) ----------------------------------

  // Every turn an earlier incarnation left unended: its domain's termination
  // established (the real boundary's protocol; on the scripted boundary its
  // processes killed and the boundary's report), then ended `recovered` with
  // what it observed and the allowance, its owner message left unknown and
  // never replayed. A turn that never launched is ended `refused` (nothing
  // was spent). A domain whose termination cannot be established stays, its
  // turn unended and its reservation held, and is tried again at the next
  // start.
  async recover(priorUnknown: Map<string, string>): Promise<number> {
    const left = await this.rt.read<
      { invocation: string; status: string; domain: string; domain_status: string; cgroup_path: string | null; incarnation: string | null; pid: number | null; pgid: number | null; pid_start_time: string | null }[]
    >('assistant.unended');
    let n = 0;
    for (const t of left) {
      try {
        const launched = t.status === 'running' && (t.pid !== null || (markedProcesses(t.domain) ?? []).length > 0 || t.cgroup_path !== null);
        let terminated = t.domain_status === 'terminated';
        if (!terminated && t.cgroup_path !== null) {
          const d = await this.rt.read<DomainRow | null>('domain.row', { domain: t.domain });
          if (d !== null) terminated = (await terminateDomain({ rt: this.rt, d, incarnation: t.incarnation ?? this.rt.incarnation, handle: undefined, knownUnknown: priorUnknown.get(t.incarnation ?? '') ?? null })).terminated;
        } else if (!terminated) {
          if (t.pid !== null && t.pid_start_time !== null) signalRecordedGroup(t.pid, t.pgid ?? t.pid, t.pid_start_time, 'SIGKILL');
          for (const p of markedProcesses(t.domain) ?? []) signalFound(p, 'SIGKILL');
          const seen = seamObserveDomain(t.domain);
          if (seen === 'terminated' || (!launched && seen !== 'running')) {
            await this.rt.engine('domain.terminated', { domain: t.domain, observed: launched });
            terminated = true;
          }
        }
        if (!terminated) {
          log('assistant recovery', new Error("the turn's domain could not be established terminated; it stays, and its reservation with it"), { invocation: t.invocation, domain: t.domain });
          continue;
        }
        await this.end(
          t.invocation,
          launched ? { outcome: 'recovered', reason: 'recovered', text: 'the engine restarted while the turn ran; it is never replayed' } : { outcome: 'refused', reason: 'recovered', text: 'the engine restarted before the turn was launched; it is never replayed' },
        );
        n++;
      } catch (err) {
        log('assistant recovery', err, { invocation: t.invocation });
      }
    }
    return n;
  }
}

