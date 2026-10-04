// Name resolution for the egress proxy (D2 §2.4): one resolution per
// attempt, within `egress_resolve_timeout`, the whole answer set returned so
// that it can be validated whole. The system resolver (getaddrinfo) outside
// harness mode; in harness mode the seam's resolver, a name-to-addresses map
// with a query counter and an optional delay (M2 plan §2.3), so that the
// answers a test needs (private, mixed, IPv6, mapped, rebinding) are
// constructed and counted. Nothing here connects.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { seamResolver } from '../../testing/seam.js';

export interface Resolver {
  // The numeric addresses `name` resolves to now; throws when it does not.
  resolve(name: string): Promise<string[]>;
}

export const systemResolver: Resolver = {
  async resolve(name: string): Promise<string[]> {
    const answers = await lookup(name, { all: true, verbatim: true });
    return answers.map((a) => a.address);
  },
};

export const activeResolver = (): Resolver => seamResolver() ?? systemResolver;

export type Resolution = { state: 'resolved'; addresses: string[] } | { state: 'timeout' } | { state: 'failed'; detail: string };

// One resolution of `host`, bounded by `timeoutMs`. A numeric host is its own
// answer (it is still validated, and allowed only if the list names it).
export async function resolveOnce(resolver: Resolver, host: string, timeoutMs: number): Promise<Resolution> {
  if (isIP(host) !== 0) return { state: 'resolved', addresses: [host] };
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const answer = await Promise.race([resolver.resolve(host), timeout]);
    if (answer === 'timeout') return { state: 'timeout' };
    return { state: 'resolved', addresses: answer };
  } catch (err) {
    return { state: 'failed', detail: (err as NodeJS.ErrnoException).code ?? (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
