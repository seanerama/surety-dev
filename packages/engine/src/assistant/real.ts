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
import { credentialStatus } from '../setup/credentials.js';
import type { CredentialFacts } from '../store/transitions/assistant.js';

export type StoreRead = <T>(name: string, args: Record<string, unknown>) => Promise<T>;

export class RealAssistant {
  constructor(
    private readonly home: string,
    readonly config: AssistantConfig,
    private readonly read: StoreRead,
  ) {}

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
