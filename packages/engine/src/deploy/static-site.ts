// A static site on the local_service adapter (the owner's instruction of
// 2026-10-29; SHAPES.md §§1, 2, 4): an environment configured with
// `mode: 'static'` names no start command. The engine runs its own static
// file server (design/preview/server.mts in its plain mode: GET and HEAD
// only, the file's bytes with its content type, `/` the entry, no frame, no
// banner, nothing outside the root) under the configured runtime, with
// /surety/app (the sealed artifact) its working directory. Everything else
// is the ordinary local_service deployment: the request and its
// alpha_authorize, the sealed artifact and its tree digest, the service
// domain, verification, observation, logs, the relay and teardown. Only
// the server program's file and its read-only binding into the domain are
// shared with the design preview; nothing of the preview's route is.
//
// The server's SHA-256 is frozen on every static deployment's intent
// (`static.server_digest`), as the design preview records it on its row.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { previewServerPath } from '../design/preview/path.js';
import { Refusal } from '../refusal.js';

export const STATIC_ROOT_DEFAULT = '.';
export const STATIC_ENTRY_DEFAULT = 'index.html';
export const CONFIG_MODES = ['service', 'static'] as const;

export interface StaticSpec {
  root: string;
  entry: string;
}

// What a static deployment freezes on its intent beside its start command.
export interface FrozenStatic extends StaticSpec {
  server: string;
  server_digest: string;
}

type ModeContent = { mode?: unknown; static?: unknown };

export const isStaticMode = (content: ModeContent | null | undefined): boolean => content?.mode === 'static';

// The configuration's mode as the environment read states it: absent is
// `service` (today's rules).
export const modeOf = (content: ModeContent | null | undefined): 'service' | 'static' => (isStaticMode(content) ? 'static' : 'service');

// The static spec of a configuration (its defaults filled), or null for a
// service configuration.
export function staticSpec(content: ModeContent | null | undefined): StaticSpec | null {
  if (!isStaticMode(content)) return null;
  const s = (typeof content!.static === 'object' && content!.static !== null ? content!.static : {}) as Partial<StaticSpec>;
  return { root: typeof s.root === 'string' ? s.root : STATIC_ROOT_DEFAULT, entry: typeof s.entry === 'string' ? s.entry : STATIC_ENTRY_DEFAULT };
}

// A plain relative path: no empty, `.` or `..` component, no leading `/`,
// no backslash or NUL.
export const isPlainRelative = (p: string): boolean =>
  p !== '' && !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');

// The entry's path in the artifact (relative to /surety/app).
export const entryPathOf = (s: StaticSpec): string => (s.root === STATIC_ROOT_DEFAULT ? s.entry : `${s.root}/${s.entry}`);

// The start command a static deployment freezes: the configured runtime
// running the engine's server in its plain mode.
export const staticStart = (runtime: string, server: string, s: StaticSpec): string[] => [runtime, server, '--static', `--root=${s.root}`, `--entry=${s.entry}`];

// The engine's server, by its real path, and its SHA-256 (cached by the
// file's identity on disk).
let cached: { key: string; sha256: string } | null = null;
export function staticServer(): { path: string; sha256: string; digest: string } {
  const path = previewServerPath();
  const st = statSync(path);
  const key = `${path}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  if (cached?.key !== key) cached = { key, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  return { path, sha256: cached.sha256, digest: `sha256:${cached.sha256}` };
}

// The configured entry against the projection's paths, before anything is
// sealed (as checkStart checks a service's entry point): it must be a file
// of the artifact under the root.
export function checkStaticEntry(s: StaticSpec, paths: Set<string>): void {
  const entry = entryPathOf(s);
  if (!paths.has(entry)) {
    throw new Refusal(422, 'config_invalid', `The configuration's static.entry names ${JSON.stringify(entry)}, which is not a file of the sealed artifact.`, 'Write a configuration version that the host can run, then request the deployment again; nothing was authorized.', {
      field: 'static.entry',
    });
  }
}

// ---- the output kind of a sealed tree (SHAPES.md §§4, 5) ----------------------------------------

export type OutputKind = 'static_site' | 'node_service' | 'unknown';

// The kind of program a sealed tree is, from the tree alone, minimally:
// a `package.json` naming a start script → `node_service`; an `index.html`
// at the root and no start script → `static_site`; otherwise `unknown`,
// never guessed. A `package.json` whose content is not given (`read`
// absent or answering null) or does not parse leaves the start script
// unknown, and so the kind. Engine B's `output_kind` may replace this.
export function outputKindOfTree(manifest: readonly (readonly [string, ...unknown[]])[], read?: (path: string) => Buffer | null): OutputKind {
  const paths = new Set(manifest.map((e) => e[0]));
  const index = paths.has('index.html');
  if (paths.has('package.json')) {
    const bytes = read ? read('package.json') : null;
    if (bytes === null) return 'unknown';
    let start: unknown;
    try {
      const pkg = JSON.parse(bytes.toString('utf8')) as { scripts?: Record<string, unknown> };
      start = pkg.scripts?.start;
    } catch {
      return 'unknown';
    }
    if (typeof start === 'string' && start.trim() !== '') return 'node_service';
    return index ? 'static_site' : 'unknown';
  }
  return index ? 'static_site' : 'unknown';
}

// The start script a tree's package.json names, or null.
export function startScriptOf(read: (path: string) => Buffer | null): string | null {
  const bytes = read('package.json');
  if (bytes === null) return null;
  try {
    const start = (JSON.parse(bytes.toString('utf8')) as { scripts?: Record<string, unknown> }).scripts?.start;
    return typeof start === 'string' && start.trim() !== '' ? start : null;
  } catch {
    return null;
  }
}
