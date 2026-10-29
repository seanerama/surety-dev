// The engine's serving check (SHAPES.md §3; the owner's rulings of
// 2026-10-29): a program of the engine's install, run by the check runner
// as the command of a `post_deploy_serving` check, in the check's own
// domain, with the engine's node, against the deployed service through the
// execution's service link. Node's own modules only. It reads, never
// writes: GET requests to the service, nothing else; it is given no secret.
//
// What it verifies, and only this (its description, the first line of its
// output): serving check: the entry page and its referenced assets are
// served from the deployed artifact; not application behaviour, not visual
// acceptance.
//   1. The deployment's identity: the sealed artifact's manifest it is
//      handed hashes to the digest the deployment recorded, which is the
//      digest the execution is bound to.
//   2. The entry page: `/` answers 200 with bytes whose SHA-256 is the
//      manifest's for the entry.
//   3. The required local assets: every local reference of the entry
//      (script src, link href, img and source src and srcset, the import
//      specifiers of its inline module scripts) and the relative imports of
//      each referenced script, one level deep, answer 200 with bytes whose
//      SHA-256 is the manifest's for that path. A reference to another
//      origin, a data: URL or a bare module specifier is listed, not
//      fetched, and is not a local asset.
// It passes (exit 0) only when all three hold; anything else fails (exit 1);
// a variable missing fails it too (exit 2). Its output lists each path with
// its served and expected SHA-256 and ends with one JSON line.
//
// The engine sets (checks/run.ts): SURETY_SERVING_URL, SURETY_STATIC_ROOT,
// SURETY_STATIC_ENTRY, SURETY_ARTIFACT_DIGEST (the execution's),
// SURETY_DEPLOYED_ARTIFACT_DIGEST (the deployment's), and
// SURETY_ARTIFACT_MANIFEST (the sealed artifact's manifest, as recorded).

import { createHash } from 'node:crypto';
import http from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DESCRIPTION = 'serving check: the entry page and its referenced assets are served from the deployed artifact; not application behaviour, not visual acceptance';
const MAX_REFS = 512;
const MAX_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

type Entry = [path: string, type: string, mode: string, size: number, sha256: string];
export interface Row {
  path: string;
  from: string;
  served: string | null;
  expected: string | null;
  status: number | null;
  result: 'match' | 'differs' | 'not_served' | 'not_in_artifact' | 'not_local' | 'not_fetched';
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

// The local references of an HTML page: [attribute value, inline module source].
export function htmlReferences(html: string): { refs: string[]; inlineModules: string[] } {
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  const refs: string[] = [];
  const inlineModules: string[] = [];
  const attr = (tag: string, name: string): string | null => {
    const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
    return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
  };
  for (const m of text.matchAll(/<(script|link|img|source)\b[^>]*>/gi)) {
    const tag = m[0];
    const name = m[1]!.toLowerCase();
    const one = name === 'link' ? attr(tag, 'href') : attr(tag, 'src');
    if (one !== null && one.trim() !== '') refs.push(one.trim());
    if (name === 'img' || name === 'source') {
      const set = attr(tag, 'srcset');
      if (set) for (const part of set.split(',')) {
        const u = part.trim().split(/\s+/)[0];
        if (u) refs.push(u);
      }
    }
  }
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\btype\s*=\s*["']?module/i.test(m[1]!) && !/\ssrc\s*=/i.test(m[1]!)) inlineModules.push(m[2]!);
  }
  return { refs, inlineModules };
}

// The module specifiers a script names: static imports and re-exports, and
// dynamic imports of a string literal.
export function moduleSpecifiers(js: string): string[] {
  const out: string[] = [];
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/[^\n]*/g, '$1');
  for (const m of code.matchAll(/(?:^|[;\s}])(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"'\n]+)["']/g)) out.push(m[1]!);
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g)) out.push(m[1]!);
  return [...new Set(out)];
}

const isRelativeSpecifier = (s: string): boolean => s.startsWith('./') || s.startsWith('../') || s.startsWith('/');

function fetchBytes(url: URL): Promise<{ status: number | null; bytes: Buffer | null; error?: string }> {
  return new Promise((resolve) => {
    const req = http.request({ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'GET', agent: false, timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on('data', (c: Buffer) => {
        n += c.length;
        if (n > MAX_BYTES) {
          req.destroy();
          resolve({ status: res.statusCode ?? null, bytes: null, error: 'too large' });
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? null, bytes: Buffer.concat(chunks) }));
      res.on('error', (e) => resolve({ status: res.statusCode ?? null, bytes: null, error: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve({ status: null, bytes: null, error: e.message }));
    req.end();
  });
}

export interface Inputs {
  url: string;
  root: string;
  entry: string;
  digest: string;
  deployed: string;
  manifest: Entry[];
}

export function inputsFrom(env: NodeJS.ProcessEnv): Inputs | string {
  const need = ['SURETY_SERVING_URL', 'SURETY_STATIC_ROOT', 'SURETY_STATIC_ENTRY', 'SURETY_ARTIFACT_DIGEST', 'SURETY_DEPLOYED_ARTIFACT_DIGEST', 'SURETY_ARTIFACT_MANIFEST'];
  const missing = need.filter((k) => typeof env[k] !== 'string' || env[k] === '');
  if (missing.length > 0) return `missing ${missing.join(', ')}`;
  let manifest: Entry[];
  try {
    manifest = JSON.parse(env.SURETY_ARTIFACT_MANIFEST!) as Entry[];
    if (!Array.isArray(manifest)) return 'SURETY_ARTIFACT_MANIFEST is not a manifest';
  } catch {
    return 'SURETY_ARTIFACT_MANIFEST does not parse';
  }
  return { url: env.SURETY_SERVING_URL!, root: env.SURETY_STATIC_ROOT!, entry: env.SURETY_STATIC_ENTRY!, digest: env.SURETY_ARTIFACT_DIGEST!, deployed: env.SURETY_DEPLOYED_ARTIFACT_DIGEST!, manifest };
}

// The check, against the service at `url`. Returns its verdict and rows.
export async function servingCheck(i: Inputs): Promise<{ passed: boolean; identity: { manifest: string; deployed: string; execution: string; holds: boolean }; rows: Row[] }> {
  const manifestDigest = `sha256:${sha(JSON.stringify(i.manifest))}`;
  const identity = { manifest: manifestDigest, deployed: i.deployed, execution: i.digest, holds: manifestDigest === i.deployed && i.deployed === i.digest };
  // The served tree: paths under the root, relative to it, with their SHA-256.
  const prefix = i.root === '.' ? '' : `${i.root}/`;
  const expected = new Map<string, string>();
  for (const e of i.manifest) if (Array.isArray(e) && typeof e[0] === 'string' && e[0].startsWith(prefix)) expected.set(e[0].slice(prefix.length), e[4]);
  const base = new URL(i.url.endsWith('/') ? i.url : `${i.url}/`);
  const rows: Row[] = [];
  const seen = new Set<string>();
  const local = (ref: string, from: URL): URL | null => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) return null;
    let u: URL;
    try {
      u = new URL(ref, from);
    } catch {
      return null;
    }
    return u.origin === base.origin ? u : null;
  };
  const check = async (u: URL, from: string, label?: string): Promise<Buffer | null> => {
    let path: string;
    try {
      path = label ?? decodeURIComponent(u.pathname).slice(1);
    } catch {
      path = u.pathname.slice(1);
    }
    if (seen.has(path)) return null;
    seen.add(path);
    if (seen.size > MAX_REFS) {
      rows.push({ path, from, served: null, expected: expected.get(path) ?? null, status: null, result: 'not_fetched' });
      return null;
    }
    const want = expected.get(path) ?? null;
    const got = await fetchBytes(u);
    const served = got.bytes === null ? null : sha(got.bytes);
    const result: Row['result'] = got.status !== 200 || got.bytes === null ? 'not_served' : want === null ? 'not_in_artifact' : served === want ? 'match' : 'differs';
    rows.push({ path, from, served, expected: want, status: got.status, result });
    return got.status === 200 ? got.bytes : null;
  };
  const entryBytes = await check(base, '/', i.entry);
  const scripts: { url: URL; from: string }[] = [];
  if (entryBytes !== null) {
    const { refs, inlineModules } = htmlReferences(entryBytes.toString('utf8'));
    const specs = inlineModules.flatMap(moduleSpecifiers);
    for (const ref of [...refs, ...specs]) {
      const u = local(ref, base);
      const bare = specs.includes(ref) && !isRelativeSpecifier(ref) && !/^[a-z][a-z0-9+.-]*:/i.test(ref);
      if (u === null || bare) {
        rows.push({ path: ref, from: i.entry, served: null, expected: null, status: null, result: 'not_local' });
        continue;
      }
      const bytes = await check(u, i.entry);
      if (bytes !== null && /\.m?js$/i.test(u.pathname)) scripts.push({ url: u, from: decodeURIComponent(u.pathname).slice(1) });
    }
  }
  // One level of the referenced scripts' imports.
  for (const s of scripts) {
    const bytes = await fetchBytes(s.url);
    if (bytes.bytes === null) continue;
    for (const spec of moduleSpecifiers(bytes.bytes.toString('utf8'))) {
      if (!isRelativeSpecifier(spec)) {
        rows.push({ path: spec, from: s.from, served: null, expected: null, status: null, result: 'not_local' });
        continue;
      }
      const u = local(spec, s.url);
      if (u === null) continue;
      await check(u, s.from);
    }
  }
  const fetched = rows.filter((r) => r.result !== 'not_local');
  const passed = identity.holds && entryBytes !== null && fetched.length > 0 && fetched.every((r) => r.result === 'match');
  return { passed, identity, rows };
}

async function main(): Promise<number> {
  process.stdout.write(`${DESCRIPTION}\n`);
  const i = inputsFrom(process.env);
  if (typeof i === 'string') {
    process.stdout.write(`not checked: ${i}\n`);
    process.stdout.write(`${JSON.stringify({ serving_verified: false, reason: i })}\n`);
    return 2;
  }
  const r = await servingCheck(i);
  process.stdout.write(`identity\tmanifest ${r.identity.manifest}\tdeployed ${r.identity.deployed}\texecution ${r.identity.execution}\t${r.identity.holds ? 'match' : 'differs'}\n`);
  process.stdout.write('path\tserved sha256\texpected sha256\tstatus\tresult\n');
  for (const row of r.rows) process.stdout.write(`${row.path}\t${row.served ?? '-'}\t${row.expected ?? '-'}\t${row.status ?? '-'}\t${row.result}\n`);
  process.stdout.write(`${JSON.stringify({ serving_verified: r.passed, statement: r.passed ? 'serving verified; not functional or visual acceptance' : 'serving not verified', identity: r.identity, paths: r.rows })}\n`);
  return r.passed ? 0 : 1;
}

// Run only when this file is the program; an import starts nothing.
const self = fileURLToPath(import.meta.url);
let program: string | null = null;
try {
  program = process.argv[1] ? realpathSync(process.argv[1]) : null;
} catch {
  program = null;
}
if (program !== null && (program === self || program === realpathSync(self))) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stdout.write(`${JSON.stringify({ serving_verified: false, reason: String((err as Error).message ?? err) })}\n`);
      process.exit(1);
    },
  );
}
