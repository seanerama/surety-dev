// What the choke point needs to know of a backend (D1 §15.1). Backends are
// qualified by the trust table of D2; in M1 there is none, so the only
// backend that can be qualified is the scripted one the test seam provides
// (build spec §8). Every other start has no qualified backend and refuses
// every dispatch before launch (`backend_refused`).

export interface BackendSpec {
  id: string;
  version: string;
  // The program spawned for an invocation, as an argument array.
  command: string;
  args: string[];
  // Variables beyond the constructed environment (a provider key).
  env?: Record<string, string>;
}

// What the execution boundary reports of a domain (build spec §6
// correction 1). Only `terminated` establishes termination.
export type DomainObservation = 'running' | 'terminated' | 'unknown';

// The backend every M1 role is dispatched to.
export const M1_BACKEND = 'scripted';
