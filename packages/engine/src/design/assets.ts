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
export const TRANSPARENCIES = ['required', 'forbidden', 'any'] as const;
export const RASTER_FORMATS = ['png', 'webp', 'ico'] as const;
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

// What a derivation writes of the assets, given the manifest at the head
// (its text, or null when it has none): the placeholders and their manifest
// when the tree has none; the merge when it has one (SEAM.md §506); nothing
// when it cannot be read, which is recorded as unknown, never assumed (the
// review's B2). Files are relative to `.surety/design/`.
export function placeholderPlan(
  existing: string | null,
  ph: { manifest: AssetManifest; files: Record<string, string> },
  head: string,
): { files: Record<string, string>; head_manifest: 'absent' | 'merged' | 'unchanged' | { unknown: string } } {
  const manifestPath = 'assets/manifest.json';
  if (existing === null) return { files: { ...ph.files, [manifestPath]: `${JSON.stringify(ph.manifest, null, 2)}\n` }, head_manifest: 'absent' };
  let parsed: AssetManifest | null = null;
  try {
    const v = JSON.parse(existing) as AssetManifest;
    parsed = v && Array.isArray(v.slots) && typeof v.version === 'number' && v.slots.every((s) => s && typeof s === 'object' && Array.isArray(s.variants) && Array.isArray(s.platforms)) ? v : null;
  } catch {
    parsed = null;
  }
  if (parsed === null) return { files: {}, head_manifest: { unknown: `${MANIFEST_FILE} at ${head} is not a readable asset manifest: no placeholder was merged into it` } };
  const merged = mergePlaceholders(parsed, ph);
  if (!merged.changed) return { files: {}, head_manifest: 'unchanged' };
  return { files: { ...merged.files, [manifestPath]: `${JSON.stringify(merged.manifest, null, 2)}\n` }, head_manifest: 'merged' };
}

// ---- header checks (D7 §6.3, §14): format by magic bytes or SVG root ----------------------------

export function formatOf(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'ico';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  // An SVG by its root, after any prolog: the XML declaration, other
  // processing instructions, comments and a DOCTYPE are read past here and
  // refused, each by name, by the activity check (svgActive). A UTF-16
  // byte-order mark is read too, so that it is refused by name.
  const start = bytes.subarray(0, 4096);
  const utf16 = start.length >= 2 && ((start[0] === 0xff && start[1] === 0xfe) || (start[0] === 0xfe && start[1] === 0xff));
  const decoded = utf16 ? (start[0] === 0xff ? start.subarray(2) : Buffer.from(start.subarray(2, 2 + ((start.length - 2) & ~1))).swap16()).toString('utf16le') : start.toString('utf8');
  const head = decoded.replace(/^﻿/, '').trimStart();
  if (/^(<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>\s*)*<svg[\s>]/i.test(head)) return 'svg';
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
  return cut(`the header of a ${format} file is not read here: its format is not one of png, webp or ico`);
}

// The header checks of one file against the variant that declares it (D7
// §6.3; SEAM.md §507): format by magic bytes or SVG root, a raster's size,
// its alpha channel, and an SVG's activity. A file whose header cannot
// establish what is declared is refused naming the file, never admitted.
// Each reason's subjects name `subject` (the slot, the variant) and the file.
export function headerReasons(bytes: Buffer, variant: { format?: unknown; size?: unknown; transparency?: unknown }, subject: Record<string, unknown>): { code: string; subjects: Record<string, unknown> }[] {
  const out: { code: string; subjects: Record<string, unknown> }[] = [];
  const add = (code: string, extra: Record<string, unknown>) => out.push({ code, subjects: { ...subject, ...extra } });
  // The declaration itself (B.16): transparency one of the three; a raster
  // variant declares its size in whole pixels.
  const t = variant.transparency;
  if (!(TRANSPARENCIES as readonly unknown[]).includes(t)) add('DESIGN_SCHEMA_INVALID', { field: 'transparency', value: t ?? null, why: 'transparency is required, forbidden or any' });
  const raster = (RASTER_FORMATS as readonly unknown[]).includes(variant.format);
  const size = variant.size as { w?: unknown; h?: unknown } | undefined;
  const declared = size && Number.isInteger(size.w) && Number.isInteger(size.h) && (size.w as number) > 0 && (size.h as number) > 0 ? { w: size.w as number, h: size.h as number } : null;
  if (raster && declared === null) add('DESIGN_SCHEMA_INVALID', { field: 'size', value: variant.size ?? null, why: 'a raster variant declares its size, {w, h} in whole pixels' });
  const found = formatOf(bytes);
  if (found !== variant.format) {
    add('DESIGN_ASSET_FORMAT_MISMATCH', { declared: variant.format ?? null, found });
    return out;
  }
  if (found === 'svg') {
    const active = svgActive(bytes);
    if (active !== null) add('DESIGN_ASSET_SVG_ACTIVE', { what: active });
    // An SVG's transparency is not established by anything the check reads.
    if (t === 'forbidden' || t === 'required') add('DESIGN_ASSET_TRANSPARENCY_MISMATCH', { declared: t, found: { unknown: 'transparency is not established for SVG' } });
    return out;
  }
  const header = rasterHeader(bytes, String(found));
  if (header.unreadable !== null) {
    add('DESIGN_ASSET_SIZE_MISMATCH', { declared, found: { unknown: header.unreadable } });
    return out;
  }
  const matching = declared === null ? header.sizes : header.sizes.filter((x) => x.w === declared.w && x.h === declared.h);
  if (declared !== null && matching.length === 0) add('DESIGN_ASSET_SIZE_MISMATCH', { declared, found: header.sizes.map((x) => ({ w: x.w, h: x.h })) });
  if (t === 'forbidden' || t === 'required') {
    const alphas = (matching.length > 0 ? matching : header.sizes).map((x) => x.alpha);
    const ok = t === 'forbidden' ? alphas.every((a) => a === false) : alphas.length > 0 && alphas.every((a) => a === true);
    if (!ok) add('DESIGN_ASSET_TRANSPARENCY_MISMATCH', { declared: t, found: alphas.some((a) => a === null) ? { unknown: 'the alpha channel is not established by the header' } : { alpha_channel: alphas.some((a) => a) } });
  }
  return out;
}

// An SVG that could run anything when opened: a script, an event attribute
// or an external reference (D7 §14; DESIGN_ASSET_SVG_ACTIVE).
export function svgActive(input: Buffer | string): string | null {
  return svgActivity(typeof input === 'string' ? Buffer.from(input, 'utf8') : input);
}

// Deny by default (D7 §14; the slice-43 review's B1). An SVG is passive only
// if it is UTF-8 text (its only byte-order mark UTF-8's, its only declared
// encoding UTF-8), holds no processing instruction but the XML declaration,
// no DOCTYPE, ENTITY or other markup declaration, binds namespaces to SVG and
// xlink alone, has no element that runs or embeds anything (script,
// foreignObject, iframe, object, embed, handler, listener, under any
// prefix), no event attribute, no srcdoc, no animation of a link, and no
// reference leaving the document: every href and url() points inside it
// (#…), save a data: image (PNG, JPEG, WebP or GIF) in the href of an
// <image> or <feImage>. `javascript:` and `@import` are refused anywhere,
// after entities are decoded and whitespace removed. The first reason found
// is returned; null for a passive SVG.
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const ACTIVE_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'handler', 'listener']);
const ANIMATIONS = new Set(['animate', 'set', 'animatemotion', 'animatetransform', 'animatecolor']);
const IMAGE_ELEMENTS = new Set(['image', 'feimage']);
const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif)[;,]/;
const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

// XML's character references and the five predefined entities, decoded
// once; null for any other entity (undeclared: the document is not XML).
function decodeEntities(text: string): string | null {
  let bad = false;
  const out = text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][\w.-]*)(;?)/g, (m, body: string, semi: string) => {
    if (semi !== ';') {
      bad = true;
      return m;
    }
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(Math.min(parseInt(body.slice(2), 16), 0x10ffff));
    if (body.startsWith('#')) return String.fromCodePoint(Math.min(parseInt(body.slice(1), 10), 0x10ffff));
    const named = NAMED_ENTITIES[body];
    if (named === undefined) bad = true;
    return named ?? m;
  });
  return bad ? null : out;
}
// For pattern checks: lower case, every whitespace and control character removed.
const squeeze = (text: string): string => text.toLowerCase().replace(/[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]/g, '');

// A text or attribute value's reasons: script URLs, imports, and url()s
// leaving the document.
function valueReason(raw: string, where: string): string | null {
  const decoded = decodeEntities(raw);
  if (decoded === null) return `an undeclared entity in ${where}`;
  const flat = squeeze(decoded);
  if (flat.includes('javascript:') || flat.includes('vbscript:')) return `a script URL in ${where}`;
  if (flat.includes('@import')) return `an @import in ${where}`;
  const urls = /url\(([^)]*)\)/g;
  for (let m = urls.exec(flat); m !== null; m = urls.exec(flat)) {
    const target = m[1]!.replace(/^['"]|['"]$/g, '');
    if (!target.startsWith('#')) return `a url() leaving the document in ${where} (${target.slice(0, 80)})`;
  }
  if ((flat.match(/url\(/g) ?? []).length !== (flat.match(/url\([^)]*\)/g) ?? []).length) return `an unterminated url() in ${where}`;
  return null;
}

const BOM_OTHER = "a byte-order mark other than UTF-8's";

function svgActivity(bytes: Buffer): string | null {
  // The byte-order mark and the encoding: UTF-8 only.
  let body = bytes;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) body = body.subarray(3);
  else if (body.length >= 2 && ((body[0] === 0xfe && body[1] === 0xff) || (body[0] === 0xff && body[1] === 0xfe))) return BOM_OTHER;
  else if (body.length >= 4 && body[0] === 0 && body[1] === 0 && body[2] === 0xfe && body[3] === 0xff) return BOM_OTHER;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return 'text that is not UTF-8';
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return 'a control character (an encoding other than UTF-8, or not text)';
  let i = 0;
  let first = true;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    const chunk = lt < 0 ? text.slice(i) : text.slice(i, lt);
    if (chunk.trim() !== '') {
      const r = valueReason(chunk, 'text');
      if (r !== null) return r;
    }
    if (lt < 0) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) return 'an unterminated comment';
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end < 0) return 'an unterminated CDATA section';
      const r = valueReason(text.slice(i + 9, end).replace(/&/g, '&amp;'), 'a CDATA section');
      if (r !== null) return r;
      i = end + 3;
      first = false;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) return 'an unterminated processing instruction';
      const pi = text.slice(i + 2, end);
      const target = /^[^\s?]*/.exec(pi)![0];
      if (target !== 'xml' || !first || text.slice(0, i).trim() !== '') return `a processing instruction (<?${target.slice(0, 40)}): only the XML declaration is admitted`;
      const enc = /\bencoding\s*=\s*(['"])([^'"]*)\1/.exec(pi);
      if (enc && !/^utf-?8$/i.test(enc[2]!)) return `the declared encoding ${enc[2]!.slice(0, 40)}: only UTF-8 is admitted`;
      i = end + 2;
      first = false;
      continue;
    }
    if (text.startsWith('<!', i)) {
      const decl = /^<!\s*([A-Za-z]*)/.exec(text.slice(i))![1]!.toUpperCase();
      if (decl === 'DOCTYPE') return 'a DOCTYPE declaration';
      if (decl === 'ENTITY') return 'an ENTITY declaration';
      return `a markup declaration (<!${decl.slice(0, 20)})`;
    }
    first = false;
    if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i);
      if (end < 0) return 'an unterminated end tag';
      i = end + 1;
      continue;
    }
    // A start tag: its name, then its attributes, each quoted.
    const name = /^<([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)/.exec(text.slice(i, i + 256));
    if (!name) return 'markup that is not a well-formed tag';
    const qname = name[1]!;
    const local = (qname.includes(':') ? qname.slice(qname.indexOf(':') + 1) : qname).toLowerCase();
    if (ACTIVE_ELEMENTS.has(local)) return `a ${qname} element`;
    let j = i + name[0].length;
    const attrs: { name: string; local: string; value: string }[] = [];
    for (;;) {
      while (j < n && /\s/.test(text[j]!)) j++;
      if (j >= n) return `the unterminated tag <${qname}>`;
      if (text[j] === '>') {
        j += 1;
        break;
      }
      if (text.startsWith('/>', j)) {
        j += 2;
        break;
      }
      const an = /^([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\s*=\s*(["'])/.exec(text.slice(j, j + 512));
      if (!an) return `an attribute of <${qname}> that is not name="value"`;
      const quote = an[2]!;
      const start = j + an[0].length;
      const end = text.indexOf(quote, start);
      if (end < 0) return `an unterminated attribute value in <${qname}>`;
      const aname = an[1]!;
      attrs.push({ name: aname, local: (aname.includes(':') ? aname.slice(aname.indexOf(':') + 1) : aname).toLowerCase(), value: text.slice(start, end) });
      j = end + 1;
    }
    for (const a of attrs) {
      const lname = a.name.toLowerCase();
      if (lname === 'xmlns' || lname.startsWith('xmlns:')) {
        const ns = decodeEntities(a.value)?.trim();
        if (ns !== SVG_NS && ns !== XLINK_NS) return `a namespace other than SVG's and xlink's (${a.name}="${a.value.slice(0, 80)}")`;
        continue;
      }
      if (a.local.startsWith('on')) return `an event attribute (${a.name})`;
      if (a.local === 'srcdoc') return `a srcdoc attribute on <${qname}>`;
      const decoded = decodeEntities(a.value);
      if (decoded === null) return `an undeclared entity in ${a.name}`;
      const r = valueReason(a.value, `${a.name} of <${qname}>`);
      if (r !== null) return r;
      if (a.local === 'href' || a.local === 'src') {
        const target = squeeze(decoded);
        const dataImage = a.local === 'href' && IMAGE_ELEMENTS.has(local) && DATA_IMAGE.test(target);
        if (!target.startsWith('#') && !dataImage) return `an external reference (${a.name}="${decoded.trim().slice(0, 80)}" on <${qname}>)`;
      }
      if (ANIMATIONS.has(local) && a.local === 'attributename') {
        const target = squeeze(decoded);
        const targetLocal = target.includes(':') ? target.slice(target.indexOf(':') + 1) : target;
        if (targetLocal === 'href' || targetLocal === 'src' || targetLocal.startsWith('on')) return `an animation of ${decoded.trim()} on <${qname}>`;
      }
    }
    i = j;
  }
  return null;
}
