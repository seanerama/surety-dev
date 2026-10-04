// The egress proxy's address policy (D2 §2.4; AR B03): one policy for IPv4
// and IPv6. An address is forbidden if it is loopback, private (RFC 1918,
// the shared address space, IPv6 site-local), link-local, unique-local,
// unspecified, multicast, reserved or broadcast, an IPv4-mapped, -compatible,
// NAT64 or 6to4 form of a forbidden IPv4 address, any IPv4-translated
// (::ffff:0:0/96) or local-use NAT64 (64:ff9b:1::/48) address, or an address
// of this host.
// The whole answer set is refused when any address in it is forbidden.
// Pure functions; nothing here resolves or connects.

import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

export type AddressReason =
  | 'not_numeric'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'unique_local'
  | 'multicast'
  | 'reserved'
  | 'broadcast'
  | 'host_address';

function v4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const x = Number(p);
    if (x > 255) return null;
    n = n * 256 + x;
  }
  return n >>> 0;
}

const inV4 = (n: number, base: string, bits: number): boolean => {
  const b = v4(base)!;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (n & mask) >>> 0 === (b & mask) >>> 0;
};

function v4Reason(n: number): AddressReason | null {
  if (inV4(n, '0.0.0.0', 8)) return 'unspecified';
  if (inV4(n, '127.0.0.0', 8)) return 'loopback';
  if (inV4(n, '10.0.0.0', 8) || inV4(n, '172.16.0.0', 12) || inV4(n, '192.168.0.0', 16) || inV4(n, '100.64.0.0', 10) || inV4(n, '192.0.0.0', 24)) return 'private';
  if (inV4(n, '169.254.0.0', 16)) return 'link_local';
  if (n === 0xffffffff) return 'broadcast';
  if (inV4(n, '224.0.0.0', 4)) return 'multicast';
  if (inV4(n, '240.0.0.0', 4)) return 'reserved';
  return null;
}

// The eight 16-bit groups of an IPv6 address (zone stripped), or null.
export function v6Groups(text: string): number[] | null {
  let s = text.split('%')[0]!.toLowerCase();
  // An embedded IPv4 tail becomes two groups.
  const tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const n = v4(tail[1]!);
    if (n === null) return null;
    s = `${s.slice(0, tail.index)}:${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string): number[] | null => {
    if (h === '') return [];
    const out: number[] = [];
    for (const g of h.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (head === null || rest === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...Array<number>(fill).fill(0), ...rest];
}

const groupsKey = (g: number[]): string => g.map((x) => x.toString(16)).join(':');

function v6Reason(g: number[]): AddressReason | null {
  const zeroUpTo = (k: number) => g.slice(0, k).every((x) => x === 0);
  const embedded = (hi: number, lo: number) => ((g[hi]! << 16) | g[lo]!) >>> 0;
  if (g.every((x) => x === 0)) return 'unspecified';
  if (zeroUpTo(7) && g[7] === 1) return 'loopback';
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated).
  if (zeroUpTo(5) && g[5] === 0xffff) return v4Reason(embedded(6, 7));
  if (zeroUpTo(6)) return v4Reason(embedded(6, 7)) ?? 'reserved';
  // ::ffff:0:0/96, IPv4-translated (RFC 2765): refused whole.
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return 'reserved';
  // 64:ff9b:1::/48, local-use NAT64 (RFC 8215): refused whole.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return 'reserved';
  // 64:ff9b::/96, the NAT64 prefix, carries an IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return v4Reason(embedded(6, 7));
  // 2002::/16, 6to4, carries one in its second and third groups.
  if (g[0] === 0x2002) return v4Reason(embedded(1, 2));
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return 'unique_local';
  if ((first & 0xffc0) === 0xfe80) return 'link_local';
  if ((first & 0xffc0) === 0xfec0) return 'private';
  if ((first & 0xff00) === 0xff00) return 'multicast';
  // 100::/64, the discard prefix.
  if (first === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return 'reserved';
  return null;
}

// The canonical form of a numeric address (IPv4 dotted, IPv6 as groups), so
// that the host's addresses compare whatever their spelling.
export function canonicalAddress(text: string): string | null {
  const family = isIP(text.split('%')[0]!);
  if (family === 4) {
    const n = v4(text);
    return n === null ? null : [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  if (family === 6) {
    const g = v6Groups(text);
    return g === null ? null : groupsKey(g);
  }
  return null;
}

// Every address of this host's interfaces, canonical, read now.
export function hostAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      const c = canonicalAddress(a.address);
      if (c !== null) out.add(c);
    }
  }
  return out;
}

// Why one numeric address is forbidden, or null if it may be connected to.
export function addressReason(text: string, host: Set<string>): AddressReason | null {
  const bare = text.split('%')[0]!;
  const family = isIP(bare);
  if (family === 0) return 'not_numeric';
  const canonical = canonicalAddress(bare);
  if (canonical === null) return 'not_numeric';
  if (family === 4) {
    const reason = v4Reason(v4(bare)!);
    if (reason) return reason;
  } else {
    const reason = v6Reason(v6Groups(bare)!);
    if (reason) return reason;
    // A mapped form of a host address is the host's address.
    const g = v6Groups(bare)!;
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      const n = ((g[6]! << 16) | g[7]!) >>> 0;
      if (host.has([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'))) return 'host_address';
    }
  }
  if (host.has(canonical)) return 'host_address';
  return null;
}

// The verdict on a whole answer set (D2 §2.4): refused if it is empty or any
// address in it is forbidden, naming the first that is.
export function answerVerdict(addresses: string[], host: Set<string>): { ok: true } | { ok: false; address: string | null; reason: AddressReason | 'empty_answer' } {
  if (addresses.length === 0) return { ok: false, address: null, reason: 'empty_answer' };
  for (const a of addresses) {
    const reason = addressReason(a, host);
    if (reason !== null) return { ok: false, address: a, reason };
  }
  return { ok: true };
}
