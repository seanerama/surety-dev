// Names the Designer writes, made safe before any host path is built from
// them (the slice-40 review's B1): a slot key or variant name is a slug; a
// relative path is segments with no `.`, `..`, empty segment, backslash or
// leading slash; and every host path built from one is confirmed, resolved,
// to lie inside its base. Fail-closed: anything else is refused, never
// normalised into something that fits.

import { resolve, sep } from 'node:path';

// A slot key (D7 §6.2) or a variant name: a slug.
export const SLOT_KEY = /^[a-z][a-z0-9_-]{0,63}$/;
export const isSlug = (v: unknown): v is string => typeof v === 'string' && SLOT_KEY.test(v);

// A relative path of `/`-separated segments, none `.`/`..`/empty, no `\`,
// no NUL, not absolute.
export function isSafeRelative(p: unknown): p is string {
  if (typeof p !== 'string' || p === '' || p.length > 1024) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// `base` joined with `rel`, or null when `rel` is unsafe or the result does
// not resolve inside `base`.
export function within(base: string, rel: string): string | null {
  if (!isSafeRelative(rel)) return null;
  const root = resolve(base);
  const full = resolve(root, rel);
  return full.startsWith(root + sep) ? full : null;
}
