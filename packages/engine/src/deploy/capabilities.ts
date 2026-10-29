// What each deployment adapter of this engine can host (the static-preview
// shapes of 2026-10-29, §§1 and 5): its modes, the output kind each mode
// hosts, and the output kinds it serves. A table of the engine's own code,
// read by the deployment compatibility (deploy/compatibility.ts) and meant
// to be what the adapter capability read (GET /v1/adapters/:a, §1) serves
// too, so the two never say different things.
//
// `static` is the mode of §2 (`mode: 'static'` in a configuration). The
// table states it as the agreed capability of local_service; the
// configuration validation and the static server that make it run are §2's
// (deploy/config.ts takes the field once they exist). A configuration that
// names no mode is in `default_mode`, today's rules unchanged.

import type { OutputKind } from './output-kind.js';

export interface AdapterMode {
  // The output kind this mode hosts.
  hosts: Exclude<OutputKind, 'unknown'>;
  // What the mode runs, as a clause: "<adapter> in <mode> mode <what>".
  what: string;
}

export interface AdapterCapabilities {
  adapter_version: string;
  default_mode: string;
  modes: Record<string, AdapterMode>;
  outputs: { kind: Exclude<OutputKind, 'unknown'>; hosted: boolean; downloadable?: boolean }[];
}

export const ADAPTER_CAPABILITIES: Readonly<Record<string, AdapterCapabilities>> = Object.freeze({
  local_service: {
    adapter_version: '1',
    default_mode: 'service',
    modes: {
      service: { hosts: 'node_service', what: 'hosts a Node service started from the artifact' },
      static: { hosts: 'static_site', what: "serves the artifact's files with the engine's static server" },
    },
    outputs: [
      { kind: 'node_service', hosted: true },
      { kind: 'static_site', hosted: true, downloadable: true },
    ],
  },
});

// The adapter's modes, in the table's order (§1 `modes`); null for an
// adapter this engine does not have.
export function modesOf(adapter: string): string[] | null {
  const a = ADAPTER_CAPABILITIES[adapter];
  return a ? Object.keys(a.modes) : null;
}

// The mode a configuration's content is in: its `mode`, else the adapter's
// default (absent = service, §2). null when the content names a mode that
// is not a string.
export function modeOfContent(adapter: string, content: Record<string, unknown>): string | null {
  const m = content.mode;
  if (m === undefined || m === null) return ADAPTER_CAPABILITIES[adapter]?.default_mode ?? null;
  return typeof m === 'string' ? m : null;
}

// Whether a kind of output needs hosting at all (the owner's instruction of
// 2026-10-29: hosted deployment only for outputs that need it): a static
// site does not (a download suffices), a Node service does; unknown is not
// known.
export const HOSTING_REQUIRED: Readonly<Record<OutputKind, boolean | null>> = Object.freeze({ static_site: false, node_service: true, unknown: null });

// The kind as a phrase: "a static site", "a Node service".
export const KIND_LABEL: Readonly<Record<OutputKind, string>> = Object.freeze({ static_site: 'static site', node_service: 'Node service', unknown: 'output of unknown kind' });
export const withArticle = (kind: OutputKind): string => (kind === 'unknown' ? 'an output of unknown kind' : `a ${KIND_LABEL[kind]}`);
