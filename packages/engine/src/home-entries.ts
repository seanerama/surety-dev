// What the engine may remove of its own home (the self-test's trees and box
// areas, the areas of terminated domains): an entry directly inside one of
// the home's own directories, by real path, never through a link. The name
// alone never decides (review m3).

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Why `path` may not be removed as an entry of `<home>/<sub>` named by
// `name`, or null when it may:
//   - its name is one `name` accepts;
//   - `<home>/<sub>` is a directory, not a link, and its real path is the
//     home's real path joined with `sub`;
//   - the real path of the entry's parent is that directory's;
//   - the entry itself is a directory, not a link (a link is never
//     followed: it is skipped and reported).
export function ownedHomeEntry(home: string, sub: string, path: string, name: RegExp): string | null {
  if (!name.test(basename(path))) return `${basename(path)} is not a name the engine makes in ${sub}`;
  const dir = join(home, sub);
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return `${dir} is not a directory of the home's own`;
    const real = realpathSync(dir);
    if (real !== join(realpathSync(home), sub)) return `${dir} resolves outside the home (${real})`;
    if (realpathSync(dirname(path)) !== real) return `${path} is not directly inside ${dir}`;
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) return `${path} is a symbolic link: it is not followed`;
    if (!entry.isDirectory()) return `${path} is not a directory`;
  } catch (err) {
    return `${path} cannot be verified: ${(err as Error).message}`;
  }
  return null;
}
