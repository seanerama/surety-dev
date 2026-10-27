// A workspace assistant turn's context package and the reply it is held to
// (the assistant design §4.2 and §4.3). The engine chooses the reads before
// the turn (its allowlisted gateway, service.ts); the package carries only
// what they returned, redacted as stored, the owner's request, the
// conversation's last messages bounded by characters, the reply schema and
// the fixed instructions. Nothing else enters: no records, transcripts,
// repositories or secrets. The model's reply is data: it is validated
// against the schema, its links are filtered to the console's own routes, and
// it never becomes an action, an approval, a form value or a mutation
// argument.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AssistantContext, Evidence } from './contract.js';

// The conversation carried into a turn: its last messages, newest last, at
// most this many characters of text in all.
export const CONVERSATION_MAX_CHARS = 12_000;
export const CONVERSATION_MAX_MESSAGES = 10;
// A reply's text, at most.
export const REPLY_TEXT_MAX_CHARS = 16_000;
export const REPLY_LINKS_MAX = 16;

export const REPLY_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'workspace assistant reply',
  type: 'object',
  additionalProperties: false,
  required: ['text', 'cited_evidence', 'links'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: REPLY_TEXT_MAX_CHARS },
    cited_evidence: { type: 'array', items: { type: 'string', description: 'an id from evidence.json' } },
    links: {
      type: 'array',
      maxItems: REPLY_LINKS_MAX,
      items: { type: 'object', additionalProperties: false, required: ['label', 'href'], properties: { label: { type: 'string' }, href: { type: 'string', pattern: '^#/' } } },
    },
  },
} as const;

export const ASSISTANT_PROMPT = [
  '# The workspace assistant',
  '',
  "You answer the owner's question about their Surety workspace, from the engine's evidence only.",
  '',
  '1. Read /surety/context/request.json (the owner\'s message and where they asked it), /surety/context/evidence.json (what the engine read for this question, each item with an id) and /surety/context/conversation.json (the conversation\'s last messages).',
  '2. Answer only from the supplied evidence. Cite the ids of the evidence items you rely on. Say plainly what the evidence does not establish; never guess and never call something unknown done, clean or empty.',
  '3. Never approve, decide, configure or instruct an action: approvals and actions stay the owner\'s, in the workspace. Point to the workspace instead, with links to its own routes (beginning "#/") only.',
  '4. Write exactly one JSON object to /surety/out/result.json, as /surety/context/reply-schema.json describes it: {"text": <your answer>, "cited_evidence": [<evidence ids>], "links": [{"label": <text>, "href": <a route beginning "#/">}]}.',
  '5. Then stop. Read nothing else and write nothing else.',
  '',
].join('\n');

export interface TurnPackage {
  request: { intent_id: string; text: string; context: AssistantContext };
  evidence: Evidence[];
  conversation: { role: 'user' | 'assistant'; text: string; created_at: string }[];
  // A qualification canary's instructions (trust/canaries.ts), when the turn
  // is one.
  canary?: Record<string, unknown> | null;
  canaryPrompt?: string[] | null;
}

// The conversation's last messages, newest last, within the bounds.
export function boundedConversation(messages: { role: 'user' | 'assistant'; text: string; created_at: string }[]): TurnPackage['conversation'] {
  const out: TurnPackage['conversation'] = [];
  let chars = 0;
  for (const m of [...messages].reverse()) {
    if (out.length >= CONVERSATION_MAX_MESSAGES) break;
    if (chars + m.text.length > CONVERSATION_MAX_CHARS) break;
    chars += m.text.length;
    out.unshift({ role: m.role, text: m.text, created_at: m.created_at });
  }
  return out;
}

// Write the package into `dir` (the domain's context directory, mounted
// read-only at /surety/context).
export function writeTurnPackage(dir: string, p: TurnPackage): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const write = (name: string, value: string) => writeFileSync(join(dir, name), value, { mode: 0o444 });
  write('prompt.md', p.canaryPrompt && p.canaryPrompt.length > 0 ? `${ASSISTANT_PROMPT}\n${p.canaryPrompt.join('\n')}` : ASSISTANT_PROMPT);
  write('request.json', JSON.stringify(p.request, null, 2));
  write('evidence.json', JSON.stringify(p.evidence, null, 2));
  write('conversation.json', JSON.stringify(p.conversation, null, 2));
  write('reply-schema.json', JSON.stringify(REPLY_SCHEMA, null, 2));
  if (p.canary) write('canary.json', JSON.stringify(p.canary, null, 2));
}

export interface Reply {
  text: string;
  cited_evidence: string[];
  links: { label: string; href: string }[];
  // No evidence cited: the text is the model's commentary, labelled so.
  commentary: boolean;
  // Links dropped because they were not the console's own routes.
  links_dropped: number;
}

// The reply as the engine takes it, or why it is not one (`invalid_result`):
// exactly the schema's three fields; a citation of an id the package did not
// carry contradicts the evidence and is invalid; a link outside the
// console's routes is dropped, never followed.
export function validateReply(value: unknown, evidenceIds: readonly string[]): { reply: Reply } | { invalid: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { invalid: 'the reply is not a JSON object' };
  const v = value as Record<string, unknown>;
  const extra = Object.keys(v).filter((k) => !['text', 'cited_evidence', 'links'].includes(k));
  if (extra.length > 0) return { invalid: `the reply carries fields outside its schema (${extra.slice(0, 5).join(', ')})` };
  if (typeof v.text !== 'string' || v.text.trim() === '') return { invalid: 'the reply has no text' };
  if (v.text.length > REPLY_TEXT_MAX_CHARS) return { invalid: `the reply's text passes ${REPLY_TEXT_MAX_CHARS} characters` };
  if (!Array.isArray(v.cited_evidence) || v.cited_evidence.some((c) => typeof c !== 'string')) return { invalid: 'cited_evidence is not a list of evidence ids' };
  const unknown = (v.cited_evidence as string[]).filter((c) => !evidenceIds.includes(c));
  if (unknown.length > 0) return { invalid: `the reply cites evidence the engine did not supply (${unknown.slice(0, 5).join(', ')})` };
  if (!Array.isArray(v.links) || v.links.length > REPLY_LINKS_MAX) return { invalid: `links is not a list of at most ${REPLY_LINKS_MAX}` };
  const links: Reply['links'] = [];
  let dropped = 0;
  for (const l of v.links) {
    if (typeof l !== 'object' || l === null || Array.isArray(l)) return { invalid: 'a link is not an object' };
    const { label, href } = l as Record<string, unknown>;
    if (typeof label !== 'string' || typeof href !== 'string' || Object.keys(l).some((k) => k !== 'label' && k !== 'href')) return { invalid: 'a link is not {label, href}' };
    if (/^#\/[A-Za-z0-9_./%-]*$/.test(href) && label.length <= 200) links.push({ label, href });
    else dropped++;
  }
  const cited = [...new Set(v.cited_evidence as string[])];
  return { reply: { text: v.text, cited_evidence: cited, links, commentary: cited.length === 0, links_dropped: dropped } };
}
