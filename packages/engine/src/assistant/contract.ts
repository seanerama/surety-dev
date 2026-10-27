// Experimental assistant contract. This is distinct from project role sessions.
export interface AssistantContext { project: string | null; screen: string; candidate?: string; gate?: string }
export type ReadTool = 'attention' | 'gate';
export interface Evidence {
  id: string; tool: ReadTool; scope: { project: string | null; candidate?: string };
  source: string; read_at: string; served_at: string | null; snapshot_seq: number | null;
  freshness: string | null; data: unknown;
  error?: { code: string; reason: string; what_to_do: string };
}
export interface AssistantLink { label: string; href: string }
// The fake's usage: attributed to the account, a measured zero, no counts.
export interface FakeUsage {
  account: 'workspace_assistant'; provider: 'fake'; cost_status: 'measured_zero'; cost_usd: 0;
  input_tokens: null; output_tokens: null;
}
// A real turn's usage, read from its one ledger row (the assistant design
// §1.3): cost reported, estimated or unknown, never "0 USD" from a provider;
// unknown counts are null; an incomplete usage carries its allowance.
export interface TurnUsage {
  account: 'workspace_assistant'; provider: string; cost_status: 'reported' | 'estimated' | 'unknown' | 'measured_zero'; cost_usd: number | null;
  input_tokens: number | null; output_tokens: number | null; cached_input_tokens: number | null;
  usage_complete: boolean; unknown_allowance_tokens: number | null; model_observed: string | null; basis?: string | null;
  // Charged: the turn's one ledger row is written.
  charged?: true;
}
// Not yet charged (a turn under way, refused, or whose end is unknown):
// nothing is claimed. `provider` and `model` are the configured backend and
// model (the usability batch's decision 5); "unconfigured" only when the
// assistant is.
export interface PendingUsage { account: 'workspace_assistant'; provider: string; model: string | null; cost_status: 'unknown'; cost_usd: null; input_tokens: null; output_tokens: null; charged: false }
export type AssistantUsage = FakeUsage | TurnUsage | PendingUsage;
// Why a turn did not complete (the assistant design §4): the engine's code,
// its words, what to do, and the turn's outcome.
export interface TurnError { code: string; reason: string; what_to_do: string; outcome: string }
// A message's status (the usability batch's decision 2). The owner message's
// is its turn's: `running` while it is under way; `completed`, `failed`,
// `stopped` (cancelled, or a turn limit), `timed_out`, `refused` (the
// admission refused it, or nothing was launched), `interrupted` (the engine
// restarted and recovery ended the turn; never replayed) once it ended; and
// `unknown` only while the engine genuinely does not know (between a restart
// and the end of the turn's recovery). A reply carries its turn's end.
export const MESSAGE_STATUSES = ['running', 'completed', 'failed', 'stopped', 'timed_out', 'refused', 'interrupted', 'unknown'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export interface AssistantMessage {
  id: string; intent_id: string; role: 'user' | 'assistant'; text: string; context: AssistantContext;
  created_at: string; status: MessageStatus; evidence: Evidence[];
  actions?: ({ kind: 'create_app'; draft: { name?: string; idea?: string } } | { kind: 'start_planning'; project: string })[];
  links: AssistantLink[]; usage: AssistantUsage; actor: { kind: 'human' | 'assistant'; request_id: string | null };
  // A real turn: its invocation, its reply's citations and whether it is
  // commentary (no evidence cited), and its error when it did not complete.
  invocation?: string; cited_evidence?: string[]; commentary?: boolean; error?: TurnError;
}
export interface Conversation { id: string; created_at: string; updated_at: string; messages: AssistantMessage[] }
export interface AssistantRequest { intent_id: string; text: string; context: AssistantContext }
export const LIMITS = { max_message_chars: 4000, max_messages: 100, max_tool_calls: 16, max_evidence_chars: 48000, max_conversations: 20 } as const;
export const FAKE_USAGE: FakeUsage = { account: 'workspace_assistant', provider: 'fake', cost_status: 'measured_zero', cost_usd: 0, input_tokens: null, output_tokens: null };
