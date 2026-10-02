// The durable record path (D1 §14.1; build spec §6 correction 21; SEAM.md
// §56). A record is a file under $SURETY_HOME/records/ and a row of
// `records`. Its bytes pass through the redactor before they reach the disk,
// are synced before the store records them, and the row is published only
// once the file is whole under its immutable name. No transaction is open
// while bytes are written or synced.

import { createHash } from 'node:crypto';
import { constants, linkSync, mkdirSync, unlinkSync } from 'node:fs';
import { type FileHandle, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { syncDirectory } from '../durable.js';
import { newId } from '../ids.js';
import { type Runtime, log } from '../runtime.js';
import { pausePoint } from '../testing/seam.js';
import { REDACTION_VERSION, StreamRedactor, scanBytes } from './redact.js';

// SEAM.md §56: a chunk is at most 1 MiB; a transcript retains at most 8 MiB.
export const CHUNK_MAX = 1 << 20;
export const TRANSCRIPT_CAP = 8 << 20;

export function recordsDir(home: string): string {
  const dir = join(home, 'records');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

async function writeAll(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  for (let done = 0; done < data.length; ) {
    const { bytesWritten } = await handle.write(data, done, data.length - done, position + done);
    done += bytesWritten;
  }
}

// A record written whole, such as a role's result: redacted, written and
// synced under a temporary name, renamed to its immutable name, the
// directory synced, and then published in one transaction. Returns its id.
export async function writeWholeRecord(rt: Runtime, args: { project: string; run: string | null; kind: string; content: Buffer }): Promise<string> {
  const dir = recordsDir(rt.home);
  const id = newId('rec_');
  const redactor = new StreamRedactor();
  const bytes = Buffer.concat([redactor.push(args.content), redactor.end()]);
  const temp = join(dir, `${id}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await writeAll(handle, bytes, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, join(dir, id));
  syncDirectory(dir);
  await rt.engine('record.publish_whole', {
    id,
    project: args.project,
    run: args.run,
    kind: args.kind,
    path: id,
    sha256: sha256(bytes),
    bytes: bytes.length,
    redactionVersion: REDACTION_VERSION,
  });
  void postScan(rt, id);
  return id;
}

// The post-write scan of a published record's stored bytes (D1 §14.2):
// clean, or a hit. A record whose bytes cannot be read stays pending.
export async function postScan(rt: Runtime, id: string): Promise<void> {
  try {
    const row = await rt.read<{ path: string | null; published: number } | null>('record.row', { record: id });
    if (!row || row.published !== 1 || row.path === null) return;
    const bytes = await readFile(join(recordsDir(rt.home), row.path));
    const found = scanBytes(bytes);
    await rt.engine('record.scan', { record: id, hit: found.hit, by: found.by });
  } catch (err) {
    log('post-write scan', err, { record: id });
  }
}

// A rescan of every stored record, as when a detector is registered.
export async function rescanRecords(rt: Runtime): Promise<void> {
  const stored = await rt.read<{ id: string }[]>('records.stored');
  for (const r of stored) await postScan(rt, r.id);
}

// A role's output, streamed into a record (SEAM.md §56). The stream is
// registered before its first chunk; each full chunk is written, synced and
// receipted as it fills; when the stream ends, the last chunk is, and the
// record is published. A stream that retains less than the role wrote (the
// cap), or whose writing failed, is never published.
export class RecordStream {
  private readonly redactor = new StreamRedactor();
  private pending: Buffer[] = [];
  private pendingLength = 0;
  // Bytes accepted for the file, and bytes written, synced and receipted.
  private retained = 0;
  private durable = 0;
  private readonly hash = createHash('sha256');
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private overflow = false;
  private ended = false;
  private receipts = 0;

  private constructor(
    private readonly rt: Runtime,
    readonly id: string,
    private readonly dir: string,
    private readonly handle: FileHandle,
  ) {}

  static async open(rt: Runtime, args: { project: string; run: string; kind: string }): Promise<RecordStream> {
    const dir = recordsDir(rt.home);
    const id = newId('rec_');
    const path = `${id}.stream`;
    await pausePoint('stream.before_registration');
    const handle = await open(join(dir, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await rt.engine('record.register_stream', { id, project: args.project, run: args.run, kind: args.kind, path, redactionVersion: REDACTION_VERSION });
    } catch (err) {
      await handle.close().catch(() => {});
      try {
        unlinkSync(join(dir, path));
      } catch {
        // nothing to remove
      }
      throw err;
    }
    return new RecordStream(rt, id, dir, handle);
  }

  // What the role wrote, as it was read.
  write(data: Buffer): void {
    if (this.ended || data.length === 0) return;
    this.accept(this.redactor.push(data));
  }

  private accept(bytes: Buffer): void {
    if (this.overflow || bytes.length === 0) return;
    const room = TRANSCRIPT_CAP - this.retained;
    let taken = bytes;
    if (bytes.length > room) {
      // Beyond the cap nothing is retained, and the stream will not be a
      // record of all the role wrote.
      taken = bytes.subarray(0, room);
      this.overflow = true;
    }
    if (taken.length === 0) return;
    this.pending.push(Buffer.from(taken));
    this.pendingLength += taken.length;
    this.retained += taken.length;
    while (this.pendingLength >= CHUNK_MAX) this.flush(CHUNK_MAX);
  }

  // Take `length` bytes off the front of what is pending and make them a chunk.
  private flush(length: number): void {
    const all = Buffer.concat(this.pending);
    const chunk = all.subarray(0, length);
    const rest = all.subarray(length);
    this.pending = rest.length > 0 ? [rest] : [];
    this.pendingLength = rest.length;
    this.queue = this.queue.then(() => this.writeChunk(chunk));
  }

  private async writeChunk(chunk: Buffer): Promise<void> {
    if (this.failure !== null) return;
    try {
      await writeAll(this.handle, chunk, this.durable);
      await this.handle.sync();
      this.hash.update(chunk);
      await this.rt.engine('record.chunk', { record: this.id, offset: this.durable, length: chunk.length, sha256: sha256(chunk) });
      this.durable += chunk.length;
      if (this.receipts++ === 0) await pausePoint('stream.chunk_durable');
    } catch (err) {
      this.failure = err;
      log('record stream', err, { record: this.id });
    }
  }

  // The stream has ended: the last chunk is made durable and, if the stream
  // holds all the role wrote, the record is published. Returns whether it was.
  async end(): Promise<boolean> {
    if (this.ended) return false;
    this.ended = true;
    this.accept(this.redactor.end());
    if (this.pendingLength > 0) this.flush(this.pendingLength);
    await this.queue;
    if (this.failure !== null || this.overflow) {
      await this.handle.close().catch(() => {});
      return false;
    }
    try {
      await this.handle.sync();
      await this.handle.close();
      await pausePoint('stream.before_rename');
      // The immutable name is made a second name of the synced file, so the
      // name the row holds always names the file; the stream's own name is
      // removed once the row names the immutable one.
      linkSync(join(this.dir, `${this.id}.stream`), join(this.dir, this.id));
      syncDirectory(this.dir);
      await this.rt.engine('record.publish_stream', { record: this.id, path: this.id, sha256: this.hash.digest('hex'), bytes: this.durable });
      await pausePoint('stream.published');
    } catch (err) {
      log('record publication', err, { record: this.id });
      return false;
    }
    try {
      unlinkSync(join(this.dir, `${this.id}.stream`));
      syncDirectory(this.dir);
    } catch (err) {
      log('record stream name', err, { record: this.id });
    }
    void postScan(this.rt, this.id);
    return true;
  }

  // The stream will never end normally (its role was never spawned).
  async abandon(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.queue;
    await this.handle.close().catch(() => {});
  }
}

// The bytes of a published record as the store describes it, or why they
// cannot be served: missing, or not of the recorded hash.
export async function readRecordBytes(home: string, row: { path: string; sha256: string | null; bytes: number | null }): Promise<Buffer | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(recordsDir(home), row.path));
  } catch {
    return null;
  }
  if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) return null;
  return bytes;
}
