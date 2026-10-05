// What a real backend's failed exit says of its cause (Sean's second
// real-agent run: a run that could not reach its provider was recorded as a
// budget stop, and without that stop its reason would have said only "the
// backend failed without a result"). From what the engine itself holds: the
// backend's terminal event as the adapter summarized it, and the domain's
// egress log. Bounded; scrubbed of anything shaped like a credential or a
// header value, and redacted of every held secret where it is recorded
// (runs/end.ts). Nothing here is evidence of a cause the engine did not see.

import { redactText } from '../records/redact.js';
import type { ClaudeStreamSummary } from './adapters/claude.js';

export const EXIT_CAUSE_MAX = 600;
const TEXT_MAX = 240;

type EgressEntry = { authority: string; decision: string; reason: string | null };

// A credential or a header value never reaches a reason text. The text is
// untrusted (a backend's error text may be the agent's own words): every
// held secret is redacted first, in every form the redactor knows; then
// every header that carries a credential loses its value, quoted (JSON) or
// not, to the end of its line, every cookie pair with it; then anything
// shaped like a token or key.
const HEADER = /(["']?)\b(proxy-authorization|authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)\b\1\s*[:=]\s*("(?:[^"\\]|\\.)*"?|'[^']*'?|[^\r\n"}]*)/gi;
const KEYS: RegExp[] = [
  /\b(Bearer|Basic|Digest|Token)\s+[^\s"',;}]+/gi,
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\b(gh[pousr]_|github_pat_|xox[abprs]-|glpat-|AKIA|ASIA)[A-Za-z0-9_-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+)?/g,
  // A long run that mixes letters and digits: a key of a shape not listed.
  /\b(?=[A-Za-z0-9_+/=-]*[0-9])(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{32,}/g,
];

export function scrubText(text: string): string {
  let out = redactText(text);
  out = out.replace(HEADER, (_m, q: string, name: string) => `${q}${name}${q}: [removed]`);
  out = out.replace(KEYS[0]!, '$1 [removed]');
  for (const re of KEYS.slice(1)) out = out.replace(re, '[removed]');
  return out.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

// At most `max` characters, never ending in a fragment of a word the cut
// went through (a part of a token is never kept).
export function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  if (/[^\s]$/.test(cut) && /^[^\s]/.test(text.slice(max - 1))) cut = cut.replace(/[^\s]+$/, '');
  return `${cut.trimEnd()}…`;
}

// The cause, or null when the engine saw nothing that names one.
export function exitCause(stream: ClaudeStreamSummary | null, egress: readonly EgressEntry[] | null): string | null {
  const parts: string[] = [];
  const r = stream?.result ?? null;
  if (r !== null && (r.is_error === true || r.subtype !== 'success')) {
    const what = [r.terminal_reason ?? r.subtype ?? 'error', r.api_error_status !== null ? `status ${r.api_error_status}` : null].filter((x): x is string => x !== null).join(', ');
    const said = r.text ?? r.errors[0] ?? null;
    parts.push(`its terminal event reports ${scrubText(what)}${said ? `: "${bounded(scrubText(said.split('\n')[0] ?? ''), TEXT_MAX)}"` : ''}`);
  }
  const refused = (egress ?? []).filter((e) => e.decision === 'refused');
  if (refused.length > 0) {
    const groups = new Map<string, number>();
    for (const e of refused) {
      const key = `${scrubText(e.reason ?? 'refused')}: ${bounded(scrubText(e.authority), 80)}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const listed = [...groups.entries()].slice(0, 4).map(([k, n]) => `${k} x${n}`);
    const more = groups.size > 4 ? `, and ${groups.size - 4} more` : '';
    const accepted = (egress ?? []).filter((e) => e.decision === 'accepted').length;
    parts.push(`the proxy refused ${refused.length} CONNECT${refused.length === 1 ? '' : 's'} (${listed.join('; ')}${more}) and accepted ${accepted}`);
  }
  return parts.length === 0 ? null : bounded(parts.join('; '), EXIT_CAUSE_MAX);
}
