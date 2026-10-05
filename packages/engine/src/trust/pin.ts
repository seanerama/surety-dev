// The engine's own copy of a qualified backend binary (E74 item 3, the
// driver's default): Claude Code's installer prunes old versions and its
// updater replaced 2.1.288 with 2.1.289 overnight, so an entry bound to the
// operator's installation would be revoked by the operator's next update.
// At qualification the engine copies the resolved binary (Claude Code's
// native build is one self-contained executable file) into its own home,
// `<home>/backends/<backend>-<version>-<sha256 prefix>`, mode 0500, and pins
// the copy: the attempt and the entry name it, every dispatch hashes it, the
// sandbox binds it read-only. The operator's install and `~/.claude` are
// read once, to copy, and never written.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const backendsDir = (home: string): string => join(home, 'backends');

const sha256Of = async (path: string): Promise<string> => {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), new Transform({ transform: (c: Buffer, _e, cb) => (h.update(c), cb(null)) }), async function* (src) {
    for await (const _ of src) void _;
  });
  return h.digest('hex');
};

// The pinned copy's path, made if it is not there. The source is hashed as
// it is copied; the copy is hashed again once written and must match, or
// nothing is pinned. A copy already there with the same hash is reused.
export async function pinBinary(home: string, backend: string, source: string, version: string): Promise<{ path: string; sha256: string }> {
  const dir = backendsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const label = (version.split(/\s+/)[0] ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'unknown';
  const tmp = join(dir, `.copy-${randomBytes(6).toString('hex')}`);
  const h = createHash('sha256');
  try {
    await pipeline(
      createReadStream(source),
      new Transform({
        transform: (c: Buffer, _e, cb) => {
          h.update(c);
          cb(null, c);
        },
      }),
      createWriteStream(tmp, { mode: 0o600, flags: 'wx' }),
    );
    const sha256 = h.digest('hex');
    const dest = join(dir, `${backend}-${label}-${sha256.slice(0, 16)}`);
    if (existsSync(dest) && statSync(dest).isFile() && (await sha256Of(dest)) === sha256) {
      rmSync(tmp, { force: true });
      chmodSync(dest, 0o500);
      return { path: dest, sha256 };
    }
    chmodSync(tmp, 0o500);
    if ((await sha256Of(tmp)) !== sha256) throw new Error(`the copy of ${source} does not hash as the file read`);
    renameSync(tmp, dest);
    return { path: dest, sha256 };
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
