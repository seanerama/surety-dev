// Branding assets (D7 §6; Appendix B.16; Q8; G10, G11): the default slots
// (§6.2), the engine's placeholders (§6.3), the asset manifest's form, the
// header checks that read no more than a file's header (§6.3, §14), and the
// effective set's rule (§6.4: per selected slot and variant the latest
// approved slot@version, else the placeholder). Placeholders are written
// with no model and no dependency, deterministic from the project's name and
// a fixed neutral palette. Nothing here decodes or executes a file.

import { createHash } from 'node:crypto';

export const ASSET_KINDS = ['logo', 'app_icon', 'favicon', 'banner', 'splash', 'illustration', 'image'] as const;
export const ASSET_VARIANTS = ['full', 'compact', 'monochrome', 'on_light', 'on_dark', 'adaptive_foreground', 'adaptive_background', 'default'] as const;
export const ASSET_FORMATS = ['svg', 'png', 'webp', 'ico'] as const;
export const ASSET_STATUSES = ['placeholder', 'proposed', 'approved'] as const;
export const ASSET_PROVENANCES = ['engine_placeholder', 'designer', 'owner', 'observed'] as const;
export const MANIFEST_FILE = '.surety/design/assets/manifest.json';

export interface SlotSpec {
  kind: string;
  purpose: string;
  platforms: (target: string) => boolean;
  variants: (target: string) => readonly string[];
}

// D7 §6.2: every product a `logo`; web a `favicon`; android an `app_icon`
// with the adaptive variants; ios an `app_icon` and a `splash`; macos,
// windows and linux an `app_icon`. Kinds and variants, never sizes.
export const DEFAULT_SLOTS: readonly SlotSpec[] = [
  { kind: 'logo', purpose: 'the product mark', platforms: () => true, variants: () => ['full', 'compact', 'monochrome', 'on_light', 'on_dark'] },
  { kind: 'favicon', purpose: 'the browser tab icon', platforms: (t) => t === 'web', variants: () => ['default'] },
  { kind: 'app_icon', purpose: 'the launcher icon', platforms: (t) => t !== 'web', variants: (t) => (t === 'android' ? ['default', 'adaptive_foreground', 'adaptive_background'] : ['default']) },
  { kind: 'splash', purpose: 'the launch screen', platforms: (t) => t === 'ios', variants: () => ['default'] },
];

export interface ManifestVariant {
  name: string;
  format: string;
  size?: { w: number; h: number };
  transparency: string;
  file?: string;
  digest?: string;
}

export interface ManifestSlot {
  key: string;
  kind: string;
  purpose: string;
  platforms: string[];
  placement?: string;
  screens?: string[];
  variants: ManifestVariant[];
  alt_text?: string;
  decorative?: boolean;
  slot_version: number;
  status: string;
  provenance: string;
  status_since: number;
  history: { slot_version: number; design_version: number; status: string; files: { variant: string; digest: string }[] }[];
}

export interface AssetManifest {
  version: number;
  slots: ManifestSlot[];
  packaging: { target: string; slot?: string; requirement: string; guidance: { source: string; read_on: string }; status: string }[];
}

export const sha256hex = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

// The fixed neutral palette (§6.3).
const INK = '#3c3c3c';
const PAPER = '#e6e6e6';

const escapeXml = (s: string): string => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

const initials = (name: string): string =>
  name
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || 'P';

// A placeholder's SVG text: a labelled logo block, or an initials icon.
export function placeholderSvg(project: string, kind: string, variant: string): string {
  const name = escapeXml(project);
  const dark = variant === 'on_dark' || variant === 'adaptive_background';
  const [fg, bg] = dark ? [PAPER, INK] : [INK, PAPER];
  if (kind === 'logo') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80"><rect width="240" height="80" fill="${bg}"/><text x="120" y="38" font-size="20" text-anchor="middle" fill="${fg}">${name}</text><text x="120" y="62" font-size="11" text-anchor="middle" fill="${fg}">PLACEHOLDER (${escapeXml(variant)})</text></svg>\n`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" fill="${bg}"/><text x="32" y="40" font-size="24" text-anchor="middle" fill="${fg}">${escapeXml(initials(project))}</text></svg>\n`;
}

// The engine's placeholder manifest and files for every default slot and
// variant of `targets` (D7 §6.3; SEAM.md §484): one slot per kind, its key
// the kind, slot_version 1, status placeholder, provenance
// engine_placeholder, status_since 0, its history one entry with design
// version 0. Files: path (relative to .surety/design/) → text.
export function placeholderManifest(project: string, targets: string[]): { manifest: AssetManifest; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const slots: ManifestSlot[] = [];
  for (const spec of DEFAULT_SLOTS) {
    const platforms = targets.filter((t) => spec.platforms(t));
    if (platforms.length === 0) continue;
    const variants = [...new Set(platforms.flatMap((t) => [...spec.variants(t)]))];
    const vs: ManifestVariant[] = variants.map((v) => {
      const file = `assets/${spec.kind}/${v}.svg`;
      const text = placeholderSvg(project, spec.kind, v);
      files[file] = text;
      return { name: v, format: 'svg', transparency: 'any', file, digest: sha256hex(text) };
    });
    slots.push({
      key: spec.kind,
      kind: spec.kind,
      purpose: spec.purpose,
      platforms,
      variants: vs,
      ...(spec.kind === 'logo' ? { alt_text: `${project} (placeholder)` } : {}),
      slot_version: 1,
      status: 'placeholder',
      provenance: 'engine_placeholder',
      status_since: 0,
      history: [{ slot_version: 1, design_version: 0, status: 'placeholder', files: vs.map((v) => ({ variant: v.name, digest: v.digest! })) }],
    });
  }
  return { manifest: { version: 1, slots, packaging: [] }, files };
}

// ---- header checks (D7 §6.3, §14): format by magic bytes or SVG root ----------------------------

export function formatOf(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'ico';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  const head = bytes.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

// An SVG that could run anything when opened: a script, an event attribute
// or an external reference (D7 §14; DESIGN_ASSET_SVG_ACTIVE).
export function svgActive(text: string): string | null {
  if (/<script[\s>]/i.test(text)) return 'a script element';
  const ev = /\son[a-z]+\s*=/i.exec(text);
  if (ev) return `an event attribute (${ev[0].trim()})`;
  const ext = /(?:href|xlink:href|src)\s*=\s*["']\s*(?!#|data:)([^"']+)/i.exec(text);
  if (ext) return `an external reference (${ext[1]})`;
  if (/<foreignObject[\s>]/i.test(text)) return 'a foreignObject element';
  return null;
}
