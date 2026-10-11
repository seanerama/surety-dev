// Unix socket paths (objection 055). A pathname socket's address holds at
// most 107 bytes (`sun_path` is 108 with its NUL). Node's `listen(path)` and
// `connect(path)` do not refuse a longer path: libuv copies what fits, so the
// socket is bound at, or dialled to, the path cut to 107 bytes, and the
// listening callback still fires with no error. Every path the engine binds
// or dials is checked here first. A longer one is refused by name
// (`socket_path_too_long`, naming the path and its length), never bound or
// dialled cut.
//
// The socket paths an engine home produces, all under `$SURETY_HOME/run/`:
//   launch.sock                      the launch socket (16 bytes past the home)
//   lk-<8>-g<n>-<10>.sock            the service link of a post-deploy check
//                                    (service-host.ts `linkSocketName`)
//   env_<26>-g<n>/in.sock            a service domain's ingress
// The ingress is the longest. Its generation counter `<n>` grows with each
// deploy of the environment, so the start allows for GENERATION_DIGITS
// digits of it and refuses a home that could not hold them; the check before
// each bind stands behind that allowance for a generation past it. The
// egress proxy binds through a descriptor of its area (`/proc/self/fd/N/…`,
// SEAM.md §133) and is not bound by this limit; the paths inside a sandbox
// (`/.init/*.sock`) are fixed and short.

import { join } from 'node:path';

import { Refusal } from './refusal.js';

export const SOCKET_PATH_MAX = 107;
export const GENERATION_DIGITS = 6;

export const socketPathBytes = (path: string): number => Buffer.byteLength(path, 'utf8');

export class SocketPathTooLong extends Error {
  readonly code = 'socket_path_too_long';
  constructor(
    readonly path: string,
    readonly length: number,
  ) {
    super(`socket_path_too_long: the socket path ${path} is ${length} bytes, past the ${SOCKET_PATH_MAX} a unix socket address holds; it was not bound or dialled (it would have been cut to ${SOCKET_PATH_MAX} bytes)`);
  }
}

// The path, if a unix socket can be bound or dialled at it whole.
export function assertSocketPath(path: string): string {
  const length = socketPathBytes(path);
  if (length > SOCKET_PATH_MAX) throw new SocketPathTooLong(path, length);
  return path;
}

export interface HomeSocketPath {
  kind: 'launch' | 'link' | 'ingress';
  // The longest path of the kind this home produces, with placeholders for
  // the parts that vary (an id's characters, the generation's digits).
  path: string;
  bytes: number;
}

// The longest socket path of each kind this home produces.
export function homeSocketPaths(home: string): HomeSocketPath[] {
  const generation = '9'.repeat(GENERATION_DIGITS);
  const paths: Record<HomeSocketPath['kind'], string> = {
    launch: join(home, 'run', 'launch.sock'),
    link: join(home, 'run', `lk-${'x'.repeat(8)}-g${generation}-${'x'.repeat(10)}.sock`),
    ingress: join(home, 'run', `env_${'X'.repeat(26)}-g${generation}`, 'in.sock'),
  };
  return (Object.keys(paths) as HomeSocketPath['kind'][]).map((kind) => ({ kind, path: paths[kind], bytes: socketPathBytes(paths[kind]) }));
}

// How many bytes an engine home's path may have for every socket path it
// produces to fit, with GENERATION_DIGITS digits of generation.
export function homePathMaxBytes(): number {
  const probe = '/h';
  const longest = Math.max(...homeSocketPaths(probe).map((p) => p.bytes));
  return SOCKET_PATH_MAX - (longest - socketPathBytes(probe));
}

// Refuses, at start, a home whose socket paths would pass the limit (in the
// form of the other start refusals, before anything is written or locked).
export function checkHomeSocketPaths(home: string): void {
  const longest = homeSocketPaths(home).reduce((a, b) => (b.bytes > a.bytes ? b : a));
  if (longest.bytes <= SOCKET_PATH_MAX) return;
  const homeBytes = socketPathBytes(home);
  const max = homePathMaxBytes();
  throw new Refusal(
    500,
    'socket_path_too_long',
    `The engine home's path is ${homeBytes} bytes, and the socket paths the engine makes under its run/ directory reach ${longest.bytes} bytes (${longest.kind}: ${longest.path}), past the ${SOCKET_PATH_MAX} a unix socket address holds. The engine never binds a socket at a cut path, so the service launch, ingress and link sockets could not be made in this home.`,
    `Set SURETY_HOME to a path of at most ${max} bytes (which leaves room for a generation of up to ${GENERATION_DIGITS} digits) and start again.`,
    { path: '.', home_bytes: homeBytes, home_max_bytes: max, limit: SOCKET_PATH_MAX, longest: { kind: longest.kind, path: longest.path, bytes: longest.bytes } },
  );
}
