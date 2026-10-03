// The host tools the launcher and the domain init use (D2 §6 H6), resolved to
// absolute paths from the system directories only, with their versions; and
// the execute-only copy of the engine's node the domain init runs from (see
// invoke/domain-init.ts). Nothing here runs a backend.

import { execFile } from 'node:child_process';
import { chmod, copyFile, link, mkdir, rename, stat } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const SYSTEM_DIRS = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];

export const SANDBOX_TOOLS = ['unshare', 'setpriv', 'ip', 'mount', 'umount', 'pivot_root'] as const;
export type ToolName = (typeof SANDBOX_TOOLS)[number];

export function resolveTool(name: string): string | null {
  for (const dir of SYSTEM_DIRS) {
    const path = join(dir, name);
    if (existsSync(path)) {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    }
  }
  return null;
}

const VERSION_ARGS: Record<string, string[]> = { ip: ['-V'] };

// `<tool> --version` (`ip -V`), first line; null if it cannot be run.
export function toolVersion(path: string, name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, VERSION_ARGS[name] ?? ['--version'], { timeout: 3000, env: { PATH: SYSTEM_DIRS.join(':'), LANG: 'C.UTF-8' } }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(String(stdout).split('\n')[0]!.trim() || null);
    });
  });
}

export interface ResolvedTools {
  paths: Partial<Record<ToolName, string>>;
  versions: Partial<Record<ToolName, string | null>>;
  missing: ToolName[];
}

export async function resolveSandboxTools(): Promise<ResolvedTools> {
  const paths: Partial<Record<ToolName, string>> = {};
  const versions: Partial<Record<ToolName, string | null>> = {};
  const missing: ToolName[] = [];
  for (const name of SANDBOX_TOOLS) {
    const path = resolveTool(name);
    if (path === null) {
      missing.push(name);
      continue;
    }
    paths[name] = path;
    versions[name] = await toolVersion(path, name);
  }
  return { paths, versions, missing };
}

// The engine's node, by its real path.
export const engineNode = (): string => {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
};

// An execute-only copy of the engine's node under the engine home, made once
// per binary (keyed by its device, inode, size and modification time) and
// reused: a process that execs it without the capability to read it is not
// dumpable (D2 §2.3; invoke/domain-init.ts).
export async function initNodeCopy(home: string): Promise<string> {
  const node = engineNode();
  const st = await stat(node);
  const dir = join(home, 'sandbox');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `node-${st.dev}-${st.ino}-${st.size}-${Math.floor(st.mtimeMs)}`);
  try {
    const have = await stat(path);
    if (have.size === st.size && (have.mode & 0o777) === 0o111) return path;
  } catch {
    // not made yet
  }
  const tmp = `${path}.tmp-${process.pid}`;
  await copyFile(node, tmp);
  await chmod(tmp, 0o111);
  await rename(tmp, path);
  return path;
}

// The init's node in a domain's own area: a hard link of the execute-only
// copy (the same file, so the plan's source is inside the domain's area,
// SEAM.md §133), or a copy where a link cannot be made.
export async function initNodeIn(area: string, copy: string): Promise<string> {
  const path = join(area, 'init-node');
  try {
    await link(copy, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return path;
    await copyFile(copy, path);
    await chmod(path, 0o111);
  }
  return path;
}
