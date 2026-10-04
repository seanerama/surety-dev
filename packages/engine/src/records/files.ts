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
export async function writeWholeRecord(rt: Runtime, args: { project: string | null; run: string | null; kind: string; content: Buffer }): Promise<string> {
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
// The transcripts being written now, by run: what a client following a run's
// output reads from while the role runs (SEAM.md §92, the tail).
const liveTranscripts = new Map<string, RecordStream>();
const transcriptWaiters = new Set<() => void>();

export function liveTranscript(run: string): RecordStream | undefined {
  return liveTranscripts.get(run);
}

// Resolves when a transcript stream is opened or ended for any run, or after
// `ms`: a tail that waits for its run's output to begin looks again then.
export function transcriptChange(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      transcriptWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    transcriptWaiters.add(done);
  });
}

const announce = (): void => {
  for (const w of [...transcriptWaiters]) w();
};

export class RecordStream {
  private readonly redactor = new StreamRedactor();
  // The bytes accepted for the file that are not yet durable, oldest first:
  // a reader of offsets at or past `durable` reads them here, and below it
  // from the file.
  private unsynced: Buffer[] = [];
  private readonly listeners = new Set<() => void>();
  private finished = false;
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

  // Bytes accepted so far: the offset the next byte will have.
  get length(): number {
    return this.retained;
  }

  // The stream has ended, whether or not it was published.
  get over(): boolean {
    return this.finished;
  }

  // Called when bytes are accepted and when the stream ends. Returns the
  // function that stops the calls.
  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  // Up to `max` accepted bytes from `offset`, as they are or will be in the
  // record: redacted, in order. Empty when nothing is there yet.
  async read(offset: number, max: number): Promise<Buffer> {
    if (offset < this.durable) {
      const want = Math.min(max, this.durable - offset);
      for (const name of [`${this.id}.stream`, this.id]) {
        let fh: FileHandle;
        try {
          fh = await open(join(this.dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch {
          continue;
        }
        try {
          const buf = Buffer.alloc(want);
          const { bytesRead } = await fh.read(buf, 0, want, offset);
          return buf.subarray(0, bytesRead);
        } finally {
          await fh.close();
        }
      }
      return Buffer.alloc(0);
    }
    let skip = offset - this.durable;
    const out: Buffer[] = [];
    let taken = 0;
    for (const piece of this.unsynced) {
      if (taken >= max) break;
      if (skip >= piece.length) {
        skip -= piece.length;
        continue;
      }
      const part = piece.subarray(skip, skip + (max - taken));
      skip = 0;
      out.push(part);
      taken += part.length;
    }
    return Buffer.concat(out);
  }

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
    const stream = new RecordStream(rt, id, dir, handle);
    if (args.kind === 'transcript') {
      liveTranscripts.set(args.run, stream);
      stream.run = args.run;
      announce();
    }
    return stream;
  }

  private run: string | null = null;

  private close(): void {
    this.finished = true;
    if (this.run !== null && liveTranscripts.get(this.run) === this) liveTranscripts.delete(this.run);
    this.notify();
    announce();
  }

  // The engine stopped reading at a bound before the role's output ended:
  // the record keeps what was read before it, and nothing after.
  truncate(): void {
    this.cut = true;
  }

  // Set by truncate(): nothing more is accepted; what was is kept and
  // published (SEAM.md §157: the transcript kept, holding fewer bytes than
  // the role wrote).
  private cut = false;

  // What the role wrote, as it was read.
  write(data: Buffer): void {
    if (this.ended || this.cut || data.length === 0) return;
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
    const copy = Buffer.from(taken);
    this.pending.push(copy);
    this.unsynced.push(copy);
    this.pendingLength += taken.length;
    this.retained += taken.length;
    while (this.pendingLength >= CHUNK_MAX) this.flush(CHUNK_MAX);
    this.notify();
  }

  // `length` bytes at the front of what was not durable now are.
  private madeDurable(length: number): void {
    this.durable += length;
    let left = length;
    while (left > 0 && this.unsynced.length > 0) {
      const first = this.unsynced[0]!;
      if (first.length <= left) {
        left -= first.length;
        this.unsynced.shift();
      } else {
        this.unsynced[0] = first.subarray(left);
        left = 0;
      }
    }
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
      this.madeDurable(chunk.length);
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
      this.close();
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
      this.close();
      return false;
    }
    try {
      unlinkSync(join(this.dir, `${this.id}.stream`));
      syncDirectory(this.dir);
    } catch (err) {
      log('record stream name', err, { record: this.id });
    }
    this.close();
    void postScan(this.rt, this.id);
    return true;
  }

  // The stream will never end normally (its role was never spawned).
  async abandon(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.queue;
    await this.handle.close().catch(() => {});
    this.close();
  }
}

// The bytes of a published record as the store describes it, or why they
// cannot be served: missing, or not of the recorded hash. Only the regular
// file the engine wrote is read (D1 §11.1): the name is opened without
// following a link and without waiting at a pipe, and anything that is not a
// regular file of the recorded size is not read at all (SEAM.md §91).
export async function readRecordBytes(home: string, row: { path: string; sha256: string | null; bytes: number | null }): Promise<Buffer | null> {
  let fh: FileHandle;
  try {
    fh = await open(join(recordsDir(home), row.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || row.bytes === null || st.size !== row.bytes) return null;
    const bytes = Buffer.alloc(row.bytes);
    for (let done = 0; done < bytes.length; ) {
      const { bytesRead } = await fh.read(bytes, done, bytes.length - done, done);
      if (bytesRead === 0) return null;
      done += bytesRead;
    }
    if (sha256(bytes) !== row.sha256) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}
