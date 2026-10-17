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

// The placeholders a re-derived inventory owes a manifest that exists (D7
// §6.3: "when targets change"; SEAM.md §506): each default slot the manifest
// lacks, added with its placeholder files; each existing slot of a kind a
// new target uses gaining it in `platforms` (neither its slot_version nor
// its files change); a variant a slot lacks added with its placeholder (a
// change of its files: its slot_version one higher, its history extended).
// The manifest's version is one higher when anything changed. Nothing an
// existing slot holds is replaced.
export function mergePlaceholders(head: AssetManifest, ph: { manifest: AssetManifest; files: Record<string, string> }): { manifest: AssetManifest; files: Record<string, string>; changed: boolean } {
  const m: AssetManifest = structuredClone(head);
  const files: Record<string, string> = {};
  let changed = false;
  for (const p of ph.manifest.slots) {
    const s = m.slots.find((x) => x.key === p.key) ?? m.slots.find((x) => x.kind === p.kind);
    if (!s) {
      m.slots.push(structuredClone(p));
      for (const v of p.variants) if (v.file && ph.files[v.file] !== undefined) files[v.file] = ph.files[v.file]!;
      changed = true;
      continue;
    }
    for (const t of p.platforms) {
      if (!s.platforms.includes(t)) {
        s.platforms.push(t);
        changed = true;
      }
    }
    const missing = p.variants.filter((v) => !s.variants.some((x) => x.name === v.name));
    if (missing.length > 0) {
      for (const v of missing) {
        s.variants.push(structuredClone(v));
        if (v.file && ph.files[v.file] !== undefined) files[v.file] = ph.files[v.file]!;
      }
      s.slot_version += 1;
      const designVersion = (s.history ?? []).at(-1)?.design_version ?? 0;
      s.history = [...(s.history ?? []), { slot_version: s.slot_version, design_version: designVersion, status: s.status, files: s.variants.filter((v) => typeof v.digest === 'string').map((v) => ({ variant: v.name, digest: v.digest! })) }];
      changed = true;
    }
  }
  if (changed) m.version += 1;
  return { manifest: m, files, changed };
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

// A raster's header (D7 §6.3; SEAM.md §507): its width, height and whether
// it carries an alpha channel, read from the header alone (PNG's IHDR and
// the chunk headers before its first IDAT, for a tRNS; WebP's VP8X, VP8L or
// VP8 header; ICO's directory). No pixel is decoded and no image data is
// inflated. null fields: the header does not say (it is cut off, or names
// no such thing), which never counts as a match.
export interface RasterHeader {
  sizes: { w: number; h: number; alpha: boolean | null }[];
  unreadable: string | null;
}

export function rasterHeader(bytes: Buffer, format: string): RasterHeader {
  const cut = (why: string): RasterHeader => ({ sizes: [], unreadable: why });
  if (format === 'png') {
    if (bytes.length < 26 || bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return cut('the PNG header ends before its IHDR');
    const w = bytes.readUInt32BE(16);
    const h = bytes.readUInt32BE(20);
    const colorType = bytes[25]!;
    let alpha: boolean | null = colorType === 4 || colorType === 6 ? true : null;
    if (alpha === null) {
      // The chunk headers up to the first IDAT: a tRNS gives an alpha
      // channel; the chunks' data are skipped by their lengths, never read.
      let off = 8;
      while (alpha === null) {
        if (off + 8 > bytes.length) break;
        const len = bytes.readUInt32BE(off);
        const type = bytes.subarray(off + 4, off + 8).toString('latin1');
        if (type === 'tRNS') alpha = true;
        else if (type === 'IDAT' || type === 'IEND') alpha = false;
        off += 12 + len;
      }
    }
    return { sizes: [{ w, h, alpha }], unreadable: null };
  }
  if (format === 'webp') {
    if (bytes.length < 30) return cut('the WebP header is cut off');
    const chunk = bytes.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8X') return { sizes: [{ w: bytes.readUIntLE(24, 3) + 1, h: bytes.readUIntLE(27, 3) + 1, alpha: (bytes[20]! & 0x10) !== 0 }], unreadable: null };
    if (chunk === 'VP8L') {
      if (bytes[20] !== 0x2f) return cut('the WebP VP8L header has no signature');
      const bits = bytes.readUInt32LE(21);
      return { sizes: [{ w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1, alpha: ((bits >>> 28) & 1) === 1 }], unreadable: null };
    }
    if (chunk === 'VP8 ') {
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return cut('the WebP VP8 header has no start code');
      return { sizes: [{ w: bytes.readUInt16LE(26) & 0x3fff, h: bytes.readUInt16LE(28) & 0x3fff, alpha: false }], unreadable: null };
    }
    return cut(`the WebP header's first chunk is ${JSON.stringify(chunk)}`);
  }
  if (format === 'ico') {
    if (bytes.length < 6) return cut('the ICO header is cut off');
    const count = bytes.readUInt16LE(4);
    if (count === 0) return cut('the ICO directory is empty');
    if (bytes.length < 6 + 16 * count) return cut('the ICO directory is cut off');
    const sizes: RasterHeader['sizes'] = [];
    for (let i = 0; i < count; i++) {
      const e = 6 + 16 * i;
      const bpp = bytes.readUInt16LE(e + 6);
      sizes.push({ w: bytes[e] === 0 ? 256 : bytes[e]!, h: bytes[e + 1] === 0 ? 256 : bytes[e + 1]!, alpha: bpp === 32 ? true : bpp === 0 ? null : false });
    }
    return { sizes, unreadable: null };
  }
  return cut(`${format} is not a raster format`);
}

// The header checks of one file against the variant that declares it (D7
// §6.3; SEAM.md §507): format by magic bytes or SVG root, a raster's size,
// its alpha channel, and an SVG's activity. A file whose header cannot
// establish what is declared is refused naming the file, never admitted.
// Each reason's subjects name `subject` (the slot, the variant) and the file.
export function headerReasons(bytes: Buffer, variant: { format?: unknown; size?: unknown; transparency?: unknown }, subject: Record<string, unknown>): { code: string; subjects: Record<string, unknown> }[] {
  const out: { code: string; subjects: Record<string, unknown> }[] = [];
  const add = (code: string, extra: Record<string, unknown>) => out.push({ code, subjects: { ...subject, ...extra } });
  const found = formatOf(bytes);
  if (found !== variant.format) {
    add('DESIGN_ASSET_FORMAT_MISMATCH', { declared: variant.format ?? null, found });
    return out;
  }
  if (found === 'svg') {
    const active = svgActive(bytes.toString('utf8'));
    if (active !== null) add('DESIGN_ASSET_SVG_ACTIVE', { what: active });
    return out;
  }
  const header = rasterHeader(bytes, String(found));
  if (header.unreadable !== null) {
    add('DESIGN_ASSET_SIZE_MISMATCH', { why: header.unreadable });
    return out;
  }
  const size = variant.size as { w?: unknown; h?: unknown } | undefined;
  const declared = size && typeof size.w === 'number' && typeof size.h === 'number' ? { w: size.w, h: size.h } : null;
  const matching = declared === null ? header.sizes : header.sizes.filter((s) => s.w === declared.w && s.h === declared.h);
  if (declared !== null && matching.length === 0) add('DESIGN_ASSET_SIZE_MISMATCH', { declared, found: header.sizes.map((s) => ({ w: s.w, h: s.h })) });
  const t = variant.transparency;
  if (t === 'forbidden' || t === 'required') {
    const alphas = (matching.length > 0 ? matching : header.sizes).map((s) => s.alpha);
    const ok = t === 'forbidden' ? alphas.every((a) => a === false) : alphas.length > 0 && alphas.every((a) => a === true);
    if (!ok) add('DESIGN_ASSET_TRANSPARENCY_MISMATCH', { declared: t, alpha_channel: alphas.some((a) => a === null) ? 'not established by the header' : alphas.some((a) => a) });
  }
  return out;
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
