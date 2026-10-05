// What a real backend's failed exit says of its cause (Sean's second
// real-agent run: a run that could not reach its provider was recorded as a
// budget stop, and without that stop its reason would have said only "the
// backend failed without a result"). From what the engine itself holds: the
// backend's terminal event as the adapter summarized it, and the domain's
// egress log. Bounded; scrubbed of anything shaped like a credential or a
// header value, and redacted of every held secret where it is recorded
// (runs/end.ts). Nothing here is evidence of a cause the engine did not see.

import type { ClaudeStreamSummary } from './adapters/claude.js';

export const EXIT_CAUSE_MAX = 600;
const TEXT_MAX = 240;

type EgressEntry = { authority: string; decision: string; reason: string | null };

// A credential or a header value never reaches a reason text.
export function scrubText(text: string): string {
  return text
    .replace(/\b(proxy-authorization|authorization|x-api-key|api-key|cookie|set-cookie)\b\s*[:=]\s*(?:(?:Bearer|Basic|Digest)\s+)?\S+/gi, '$1: [removed]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, '$1 [removed]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[removed]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
}

const bounded = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

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
