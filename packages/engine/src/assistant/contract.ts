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
export interface AssistantUsage {
  account: 'workspace_assistant'; provider: 'fake'; cost_status: 'measured_zero'; cost_usd: 0;
  input_tokens: null; output_tokens: null;
}
export interface AssistantMessage {
  id: string; intent_id: string; role: 'user' | 'assistant'; text: string; context: AssistantContext;
  created_at: string; status: 'completed' | 'failed' | 'unknown'; evidence: Evidence[];
  actions?: ({ kind: 'create_app'; draft: { name?: string; idea?: string } } | { kind: 'start_planning'; project: string })[];
  links: AssistantLink[]; usage: AssistantUsage; actor: { kind: 'human' | 'assistant'; request_id: string | null };
}
export interface Conversation { id: string; created_at: string; updated_at: string; messages: AssistantMessage[] }
export interface AssistantRequest { intent_id: string; text: string; context: AssistantContext }
export const LIMITS = { max_message_chars: 4000, max_messages: 100, max_tool_calls: 16, max_evidence_chars: 48000, max_conversations: 20 } as const;
export const FAKE_USAGE: AssistantUsage = { account: 'workspace_assistant', provider: 'fake', cost_status: 'measured_zero', cost_usd: 0, input_tokens: null, output_tokens: null };
