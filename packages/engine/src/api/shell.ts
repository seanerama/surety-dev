// The static shell (RN R6; build spec §6 correction 7; D1 §11.1; SEAM.md
// §90): an enumerated set of files served without a token, after the Host
// and origin-evidence checks. M1 has no UI of its own; the directory is a
// parameter of the start, and without it the engine serves no shell route.
//
// The routes are enumerated when the engine starts: `/` is the directory's
// index.html, and `/assets/<name>` each regular file of its assets/ directory.
// The bytes are served exactly as they were read: nothing is put into them,
// no cookie is set, and nothing of the token or of a project is in them.

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

export interface ShellFile {
  bytes: Buffer;
  type: string;
  document: boolean;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const regular = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

// The shell's routes, read once. An unreadable directory has no routes.
export function loadShell(dir: string | null): Map<string, ShellFile> {
  const routes = new Map<string, ShellFile>();
  if (dir === null) return routes;
  const index = join(dir, 'index.html');
  if (regular(index)) routes.set('/', { bytes: readFileSync(index), type: TYPES['.html']!, document: true });
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, 'assets'));
  } catch {
    names = [];
  }
  for (const name of names) {
    const path = join(dir, 'assets', name);
    if (!regular(path)) continue;
    routes.set(`/assets/${name}`, { bytes: readFileSync(path), type: TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream', document: false });
  }
  return routes;
}

// The shell document's content security policy: nothing but its own origin,
// no inline script, no eval, no framing.
export const SHELL_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
