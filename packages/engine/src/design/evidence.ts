// Owner-supplied review evidence (D7 §10.5, §14, A.2 EvidenceFormat, A.4
// REVIEW_EVIDENCE_INVALID, A.6 design_evidence_invalid, A.7; G13; SEAM.md
// §522): screenshots (`png`, `webp`, `jpeg`) and screen recordings (`mp4`,
// `webm`) the owner hands over with `surety design review --evidence`. Each
// is judged by its magic bytes against its file name's extension and by its
// size against `design_review_evidence_max_bytes`, all of them together
// against `design_review_evidence_max_review_bytes`; nothing is decoded
// beyond the header, nothing is executed or played. A refusal is whole.
// Pure: bytes in, a verdict out.

import { constants as bufferConstants } from 'node:buffer';
import { createHash } from 'node:crypto';

import { Refusal } from '../refusal.js';

export const EVIDENCE_FORMATS = ['png', 'webp', 'jpeg', 'mp4', 'webm'] as const;
export type EvidenceFormat = (typeof EVIDENCE_FORMATS)[number];
// The runtime a verdict says it was seen on (A.2 ObservedOn).
export const OBSERVED_ON = ['browser', 'simulator', 'emulator', 'device', 'simulation'] as const;
// The runtime the owner states his evidence files were seen on (D7 §10.5;
// SEAM.md §522; the slice-45 review's S7): a device, an emulator or a
// simulator he ran.
export const EVIDENCE_OBSERVED_ON = ['device', 'emulator', 'simulator'] as const;
// Screenshots reach the role's package as images; recordings by name only (D7 §10.5).
export const SCREENSHOT_FORMATS: readonly string[] = ['png', 'webp', 'jpeg'];

const EXTENSIONS: Record<string, EvidenceFormat> = { png: 'png', webp: 'webp', jpg: 'jpeg', jpeg: 'jpeg', mp4: 'mp4', webm: 'webm' };

export const FILE_KEY = 'design_review_evidence_max_bytes';
export const REVIEW_KEY = 'design_review_evidence_max_review_bytes';

// The format a file's name claims, by its extension; null for any other.
export function formatOfName(name: string): EvidenceFormat | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? (EXTENSIONS[m[1]!.toLowerCase()] ?? null) : null;
}

// The format the header shows, read from the first bytes only.
export function formatOfBytes(b: Buffer): EvidenceFormat | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 && webmDocType(b)) return 'webm';
  return null;
}

// The EBML header's DocType is `webm` (the element 0x4282 within the header's
// first bytes; nothing past the header is read).
function webmDocType(b: Buffer): boolean {
  const head = b.subarray(0, Math.min(b.length, 64));
  for (let i = 4; i + 3 < head.length; i++) {
    if (head[i] !== 0x42 || head[i + 1] !== 0x82) continue;
    const size = head[i + 2]! & 0x7f;
    return head.toString('latin1', i + 3, i + 3 + size) === 'webm';
  }
  return false;
}

export interface EvidenceFile {
  name: string;
  // Its size, known from its base64 length before any decoding (S4).
  size: number;
  // Its bytes, decoded only once every bound holds.
  bytes: () => Buffer;
}

// The decoded size of a base64 text, from its length alone.
export const base64Size = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

export interface CheckedEvidence {
  name: string;
  format: EvidenceFormat;
  digest: string;
  bytes: Buffer;
}

export interface EvidenceReason {
  code: 'REVIEW_EVIDENCE_INVALID';
  subjects: Record<string, unknown>;
}

// Every file judged; the reasons, each naming its file (and, for a bound,
// the key), or the files with their formats and digests.
export function checkEvidence(files: EvidenceFile[], bounds: { file: number; review: number }): { ok: true; files: CheckedEvidence[] } | { ok: false; reasons: EvidenceReason[] } {
  const reasons: EvidenceReason[] = [];
  const out: CheckedEvidence[] = [];
  const add = (subjects: Record<string, unknown>) => reasons.push({ code: 'REVIEW_EVIDENCE_INVALID', subjects });
  // The bounds first, from the sizes alone: nothing past them is decoded.
  const total = files.reduce((n, f) => n + f.size, 0);
  const overReview = total > bounds.review;
  if (overReview) add({ files: files.map((f) => f.name), key: REVIEW_KEY, max: bounds.review, bytes: total, why: `the files together are larger than ${REVIEW_KEY}` });
  for (const f of files) {
    const claimed = formatOfName(f.name);
    if (claimed === null) add({ file: f.name, why: `its name does not end in one of ${Object.keys(EXTENSIONS).map((e) => `.${e}`).join(', ')}` });
    if (f.size > bounds.file) {
      add({ file: f.name, key: FILE_KEY, max: bounds.file, bytes: f.size, why: `it is larger than ${FILE_KEY}` });
      continue;
    }
    if (overReview || claimed === null) continue;
    const bytes = f.bytes();
    const shown = formatOfBytes(bytes);
    if (shown !== claimed) add({ file: f.name, format: claimed, header: shown, why: shown === null ? `its first bytes are not a ${claimed} header` : `its name says ${claimed} but its header is ${shown}` });
    else out.push({ name: f.name, format: claimed, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes });
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, files: out };
}

export const evidenceInvalid = (reasons: EvidenceReason[]): Refusal =>
  new Refusal(
    422,
    'design_evidence_invalid',
    `The review's evidence is refused: ${reasons.map((r) => `${r.code} (${String(r.subjects.file ?? (r.subjects.files as string[] | undefined)?.join(', ') ?? '')}: ${String(r.subjects.why)}${r.subjects.key ? `, ${String(r.subjects.key)}` : ''})`).join('; ')}. Nothing was opened or recorded.`,
    'Supply PNG, WebP or JPEG screenshots and MP4 or WebM recordings, each named by its format, within the bounds; or raise the bound in the project policy.',
    { reasons },
  );

// The owner's file names are data, never paths the engine opens: one name,
// no directory, printable, at most 255 bytes.
export function validName(name: unknown): name is string {
  return typeof name === 'string' && name !== '' && Buffer.byteLength(name) <= 255 && !/[/\\\0]/.test(name) && name !== '.' && name !== '..' && !/[\x00-\x1f\x7f]/.test(name);
}

// The upload's body cap (the slice-45 review's S4): the body is read whole
// and parsed as one JSON text, so it stays below the longest string this
// runtime can hold, with a margin. Evidence of about three quarters of it
// fits, base64; a larger body is refused 413 at the transport before any is
// read, whatever a raised key allows.
export const REVIEW_BODY_CAP = Math.min(Math.ceil((512 * 1024 * 1024) / 3) * 4 + 1024 * 1024, bufferConstants.MAX_STRING_LENGTH - 1024 * 1024);
const REVIEW_BYTES_TRANSPORT = Math.floor(((REVIEW_BODY_CAP - 1024 * 1024) * 3) / 4);
export const reviewTooLarge = (cap: number) =>
  new Refusal(413, 'payload_too_large', `The review's upload exceeds ${cap} bytes, its body's limit (evidence of at most ${REVIEW_BYTES_TRANSPORT} bytes together, base64). Nothing was opened or recorded.`, `Supply evidence of at most ${REVIEW_BYTES_TRANSPORT} bytes in one review.`, { limit: 'body', max: cap });
