// Descriptors a process inherited from whoever started it (D2 §§2.2, 2.3;
// A.6 P14: the role holds descriptors 0 to 2 only). A descriptor opened by
// node itself carries close-on-exec; one a parent passed down without it (a
// terminal multiplexer's or an ssh server's pty, say) does not, and would
// survive every exec down to the role. These are closed: every descriptor
// above 2 whose flags, as /proc/self/fdinfo gives them, lack O_CLOEXEC.
// Nothing else is touched. The launcher and the domain init carry their own
// copy of this (each imports nothing of the engine's).

import { closeSync, readFileSync, readdirSync } from 'node:fs';

const O_CLOEXEC = 0o2000000;

// The descriptors above 2 without close-on-exec; null if /proc cannot be read.
export function inheritedDescriptors(): number[] | null {
  let names: string[];
  try {
    names = readdirSync('/proc/self/fd');
  } catch {
    return null;
  }
  const out: number[] = [];
  for (const n of names) {
    const fd = Number(n);
    if (!Number.isInteger(fd) || fd <= 2) continue;
    try {
      const m = /^flags:\s+([0-7]+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'));
      if (m && (parseInt(m[1]!, 8) & O_CLOEXEC) === 0) out.push(fd);
    } catch {
      // closed meanwhile (the listing's own descriptor)
    }
  }
  return out;
}

// Close them; returns those closed.
export function closeInheritedDescriptors(): number[] {
  const fds = inheritedDescriptors() ?? [];
  for (const fd of fds) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
  return fds;
}
