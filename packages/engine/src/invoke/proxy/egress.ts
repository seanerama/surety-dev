// A domain's egress, the engine's side (D2 §§2.4, 3.7): the proxy started
// before the launcher with the domain's allow list and the engine's limits,
// its refusals recorded as `domain.egress_refused`, its log's bound
// cancelling the run, and its `egress_log` record written once the domain is
// terminated and the proxy closed.

import { writeWholeRecord } from '../../records/files.js';
import { redactText } from '../../records/redact.js';
import { type Runtime, log } from '../../runtime.js';
import { echoEndpoint } from './echo.js';
import { DomainProxy, canonicalHost } from './proxy.js';
import { activeResolver } from './resolver.js';

export interface EgressArgs {
  area: string;
  domain: string;
  run: string | null;
  invocation: string | null;
  profile: string;
  // The trust entry's or the qualification attempt's egress list, and the
  // project's approved `egress_allow_extra` (D2 §2.4).
  allow: string[];
  // The log reached its bound: the caller cancels the run (D2 §3.7).
  onLogBound?: () => void;
}

export function proxyLimits(rt: Runtime) {
  return {
    resolveTimeoutMs: rt.setting('egress_resolve_timeout') * 1000,
    connectTimeoutMs: rt.setting('egress_connect_timeout') * 1000,
    tunnelMaxMs: rt.setting('egress_tunnel_max_seconds') * 1000,
    tunnelsMax: rt.setting('egress_tunnels_max'),
    bufferMaxBytes: rt.setting('egress_buffer_max_bytes'),
    logMaxBytes: rt.setting('egress_log_max_bytes'),
  };
}

export async function startEgress(rt: Runtime, args: EgressArgs): Promise<DomainProxy> {
  const proxy = new DomainProxy({
    area: args.area,
    domain: args.domain,
    run: args.run,
    invocation: args.invocation,
    profile: args.profile,
    allow: [...new Set(args.allow.map(canonicalHost))].sort(),
    limits: proxyLimits(rt),
    resolver: activeResolver(),
    echo: args.profile === 'probe' ? echoEndpoint : null,
    onRefused: (r) => {
      // The authority is the role's text: redacted through the same screen
      // as the egress_log record before it is stored (the review's S2).
      void rt.engine('domain.egress_refused', { domain: args.domain, authority: redactText(r.authority), reason: r.reason }).catch((err) => log('egress refusal', err, { domain: args.domain }));
    },
    ...(args.onLogBound ? { onLogBound: args.onLogBound } : {}),
  });
  await proxy.listen();
  return proxy;
}

// The proxy closed (every tunnel with it) and its log published as the
// domain's `egress_log` record. Returns the record's id, or null if it could
// not be written (logged; the run's other evidence stands).
export async function finishEgress(rt: Runtime, proxy: DomainProxy, owner: { project: string | null; run: string | null }): Promise<string | null> {
  return (await finishEgressAccount(rt, proxy, owner)).egress_log;
}

// The domain's egress evidence (E85; SEAM.md §174): the record its log was
// written as (null if it could not be), and the proxy's account of it.
export interface EgressEvidence {
  domain: string;
  egress_log: string | null;
  complete: boolean;
  entries: number;
  accepted: number;
  bytes_up: number;
}

export async function finishEgressAccount(rt: Runtime, proxy: DomainProxy, owner: { project: string | null; run: string | null }): Promise<EgressEvidence> {
  await proxy.close();
  let record: string | null = null;
  try {
    record = await writeWholeRecord(rt, { project: owner.project, run: owner.run, kind: 'egress_log', content: Buffer.from(proxy.recordText()) });
  } catch (err) {
    log('egress log', err, { domain: proxy.opts.domain });
    record = null;
  }
  const a = proxy.account();
  return { domain: proxy.opts.domain, egress_log: record, complete: a.complete && record !== null, entries: a.entries, accepted: a.accepted, bytes_up: a.bytes_up };
}
