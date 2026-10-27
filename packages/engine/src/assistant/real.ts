// The workspace assistant's real path, the main thread's side (the assistant
// design of 2026-10-27, §§2 and 4): the state computed from real
// configuration on each read, the credential facts only this thread holds
// (values are held in its redactor, never in the store), and, from step 6,
// a turn's admission and its settlement.
//
// Selected only when config.json has a `workspace_assistant` block; with no
// block the in-process fake is selected by the engine's test mode alone, and
// otherwise the assistant is unconfigured (api/server.ts).

import type { AssistantConfig } from '../config/engine-config.js';
import { heldSecret } from '../records/redact.js';
import { Refusal } from '../refusal.js';
import type { Runtime } from '../runtime.js';
import { credentialStatus } from '../setup/credentials.js';
import type { CredentialFacts, TurnClaim } from '../store/transitions/assistant.js';
import type { Actor } from '../store/transitions/tx.js';
import type { RealAssistantPort, TurnRead } from './service.js';
import type { TurnPackage } from './turn-package.js';

export type StoreRead = <T>(name: string, args: Record<string, unknown>) => Promise<T>;
export type StoreMutate = (name: string, args: unknown, actor: Actor, method: string, path: string) => Promise<{ status: number; body: unknown; effects?: { kind: string }[] }>;

export class RealAssistant implements RealAssistantPort {
  constructor(
    private readonly home: string,
    readonly config: AssistantConfig,
    private readonly read: StoreRead,
    private readonly mutate: StoreMutate | null = null,
    private readonly runtime: (() => Runtime) | null = null,
  ) {}

  private turns() {
    let rt: Runtime | null = null;
    try {
      rt = this.runtime?.() ?? null;
    } catch {
      rt = null;
    }
    if (rt === null || rt.assistant === null) throw new Refusal(503, 'assistant_state_unavailable', 'The engine is not running its assistant turns yet.', 'Retry once the engine is in full mode.', {});
    return { rt, turns: rt.assistant };
  }

  // The admission (§1.3): the package registered for the tick's dispatch,
  // then the store's transaction (the state recomputed, the reservation, the
  // receipt), which asks for a tick. A refusal withdraws the package.
  async admit(args: { conversation: string; intent_id: string; pkg: TurnPackage; actor: Actor }): Promise<{ invocation: string; deadline_at: string; backend: string }> {
    const { rt, turns } = this.turns();
    if (this.mutate === null) throw new Refusal(503, 'assistant_state_unavailable', 'The store cannot admit a turn here.', 'Retry shortly.', {});
    turns.provide(args.conversation, args.intent_id, args.pkg);
    try {
      const r = await this.mutate(
        'assistant.admit',
        { conversation: args.conversation, intent_id: args.intent_id, credential: this.credential(), incarnation: rt.incarnation, scope: rt.boundary() === 'real' ? (rt.scope?.path ?? null) : null },
        args.actor,
        'POST',
        `/v1/assistant/conversations/${args.conversation}/messages`,
      );
      rt.afterCommit((r.effects ?? []) as Parameters<Runtime['afterCommit']>[0]);
      const claim = r.body as TurnClaim;
      return { invocation: claim.invocation, deadline_at: claim.deadline_at, backend: claim.backend };
    } catch (err) {
      turns.withdraw(args.conversation, args.intent_id);
      throw err;
    }
  }

  // The waiter is registered before the turn is read, so that a turn that
  // ended meanwhile is never waited for to the bound.
  async settled(invocation: string, ms: number): Promise<boolean> {
    const waiting = this.turns().turns.settled(invocation, ms);
    const now = await this.turn({ invocation }).catch(() => null);
    if (now !== null && now.status === 'ended') return true;
    return waiting;
  }

  turn(args: { invocation: string } | { conversation: string; intent_id: string }): Promise<TurnRead | null> {
    return this.read<TurnRead | null>('assistant.turn', args);
  }

  // The configured backend and model (an owner message's pending usage
  // names them; the usability batch's decision 5).
  provider(): { provider: string; model: string } {
    return { provider: this.config.backend, model: this.config.model };
  }

  // This engine's incarnation, or null while it is not yet running its turns
  // (a turn another incarnation owns is then unknown until recovery ends it).
  incarnation(): string | null {
    try {
      const rt = this.runtime?.() ?? null;
      return rt === null || rt.assistant === null ? null : rt.incarnation;
    } catch {
      return null;
    }
  }

  async cancel(args: { conversation: string; intent_id: string; actor: Actor }): Promise<{ invocation: string; status: string } | null> {
    const { turns } = this.turns();
    if (this.mutate === null) return null;
    const r = await this.mutate('assistant.cancel', { conversation: args.conversation, intent_id: args.intent_id }, args.actor, 'POST', `/v1/assistant/conversations/${args.conversation}/cancel`);
    const body = r.body as { invocation: string; status: string } | null;
    if (body !== null && body.status !== 'ended') turns.cancel(body.invocation);
    return body;
  }

  // true once the hook is set; false while the engine is not running its
  // turns yet (a conversation's next read then writes what ended).
  onSettled(fn: (invocation: string) => Promise<void>): boolean {
    try {
      const rt = this.runtime?.() ?? null;
      if (rt?.assistant) {
        rt.assistant.onSettled = fn;
        return true;
      }
    } catch {
      // not running yet
    }
    return false;
  }

  // Whether the saved credential manifest reads, and whether the block's
  // reference is loaded. Never a value or a path's content.
  credential(): CredentialFacts {
    let manifestOk = true;
    try {
      credentialStatus(this.home);
    } catch {
      manifestOk = false;
    }
    return { manifest_ok: manifestOk, loaded: heldSecret(this.config.credential_ref) !== null };
  }

  // The state body (§2), computed now. A store failure while computing it is
  // a 503 refusal, never `ready`.
  async state(): Promise<Record<string, unknown>> {
    try {
      return await this.read<Record<string, unknown>>('assistant.state', { credential: this.credential() });
    } catch (err) {
      const why = err instanceof Refusal ? err.reason : err instanceof Error ? err.message : String(err);
      throw new Refusal(503, 'assistant_state_unavailable', `The assistant's state could not be read: ${why}. It is not ready.`, 'Retry shortly; the ordinary workspace controls are unaffected.', { cause: err instanceof Refusal ? err.code : 'store_error' });
    }
  }
}
