// The downloadable Alpha deliverable (the owner's instruction of 2026-10-29;
// SHAPES.md §4): `GET /v1/projects/:p/candidates/:c/deliverable` and
// `…/deliverable/download`. The candidate's tree is sealed as a deployment
// seals it (deploy/artifact.ts, within the same bounds, with no exclude: the
// tracked files minus `.surety/`), and packaged as a zip (deploy/zip.ts):
// one entry per manifest entry in the manifest's order, each entry's bytes
// checked against the manifest's SHA-256 as it is read, every timestamp the
// candidate's `nominated_at`, so the same artifact gives the same bytes.
// The package is written once, `$SURETY_HOME/artifacts/<project>/<digest
// hex>.zip` (read-only), and recorded (`deliverables`); every later read
// re-reads the file and checks its size and SHA-256 and that its entries
// are the artifact's, before saying `verified` or serving a byte.
//
// Ready only when the candidate's phase gate is satisfied (its latest
// `phase` evaluation satisfied and not stale) and its artifact seals within
// the bounds; otherwise 409 `deliverable_not_ready` with the reason. 404 for
// a candidate that is not the project's.
//
// The owner's ruling of 2026-10-29: "No additional owner approval is
// required to download an already-prepared deliverable through an
// authenticated request with access to that project. Downloading must not
// start agents, deploy anything or execute the program." Building and
// serving the package is the engine's own work: no run, no model call, no
// decision, no work item, no operation, and nothing of the package is ever
// executed. What is verified is the package; whether the program runs is
// not tested on any platform, and the answer says so.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { nowMs } from '../clock.js';
import { Refusal } from '../refusal.js';
import { type Runtime, log } from '../runtime.js';
import type { DeliverableFacts, DeliverableRow } from '../store/transitions/deliverable.js';
import { seamArtifactFreeBytes } from '../testing/seam.js';
import { ArtifactRefused, type ManifestEntry, type Sealed, artifactsDir, homeFreeBytes, removeUnrecorded, sealArtifact } from './artifact.js';
import { type OutputKind, STATIC_ENTRY_DEFAULT, outputKindOfTree, startScriptOf } from './static-site.js';
import { readZip, writeZip } from './zip.js';

export const PACKAGE_VERIFIED = 'every entry of the package re-read and matched to the sealed artifact by sha256';
export const EXECUTION_NOT_TESTED = 'the program was not run on any platform by the engine; hosted checks are separate';
export const NO_INSTRUCTIONS = 'No run instructions are known for this output';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const notReady = (candidate: string, reason: string, extra: Record<string, unknown> = {}): Refusal =>
  new Refusal(409, 'deliverable_not_ready', reason, 'Satisfy what the reason names (the candidate\'s phase gate, or the artifact\'s bounds), then read the deliverable again; nothing was packaged.', { candidate, ...extra });

// The project's name as a file name's first part.
export const slugOf = (name: string): string => {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s === '' ? 'project' : s;
};

// What the package's platform, instructions and prerequisites say, by the
// output kind of its tree.
export function platformOf(kind: OutputKind, facts: { start: string | null; node: string | null }): { platform: Record<string, unknown>; instructions: string[]; prerequisites: string[] } {
  if (kind === 'static_site') {
    return {
      platform: { kind: 'static_site', intended: 'any modern web browser, served from a local static file server', hosting_required: false },
      instructions: [`Unzip; serve the folder with any static file server (ES modules do not load from file://); open ${STATIC_ENTRY_DEFAULT}.`],
      prerequisites: ['A modern web browser.', 'Any static file server (the package includes none).'],
    };
  }
  if (kind === 'node_service') {
    return {
      platform: { kind: 'node_service', intended: `a host with Node.js ${facts.node ?? '(version not known to the engine)'}`, hosting_required: true },
      instructions: ['Unzip.', `In the unzipped folder, run the start command: npm start (package.json scripts.start: ${facts.start ?? 'not read'}).`],
      prerequisites: [facts.node === null ? 'Node.js, of a version the engine does not know (no environment of the project pins one it can name).' : `Node.js ${facts.node}, the runtime the project's environment pins.`],
    };
  }
  return { platform: { kind: 'unknown', intended: 'not known', hosting_required: null }, instructions: [NO_INSTRUCTIONS], prerequisites: [] };
}

// The package file read back and checked: its size and SHA-256 as recorded,
// its entries exactly the manifest's files in order with their SHA-256.
export function verifyPackage(path: string, row: { bytes: number; sha256: string }, manifest: readonly ManifestEntry[] | null): { ok: true; bytes: Buffer } | { ok: false; why: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return { ok: false, why: 'the package file cannot be read' };
  }
  if (bytes.length !== row.bytes) return { ok: false, why: `the package file has ${bytes.length} bytes, not the ${row.bytes} recorded` };
  if (sha256(bytes) !== row.sha256) return { ok: false, why: 'the package file does not have its recorded SHA-256' };
  if (manifest !== null) {
    let entries;
    try {
      entries = readZip(bytes);
    } catch (err) {
      return { ok: false, why: `the package does not read as a zip: ${(err as Error).message}` };
    }
    if (entries.length !== manifest.length) return { ok: false, why: `the package has ${entries.length} entries, the artifact ${manifest.length} files` };
    for (let i = 0; i < manifest.length; i++) {
      const m = manifest[i]!;
      const e = entries[i]!;
      if (e.name !== m[0] || sha256(e.bytes) !== m[4]) return { ok: false, why: `the package's entry ${i} (${e.name}) is not the artifact's ${m[0]}` };
    }
  }
  return { ok: true, bytes };
}

interface Built {
  row: DeliverableRow;
  bytes: Buffer;
  manifest: ManifestEntry[];
  start: string | null;
}

const building = new Map<string, Promise<Built>>();

async function sealFor(rt: Runtime, facts: DeliverableFacts): Promise<Sealed> {
  const v = rt.config.values as unknown as Record<string, number>;
  const project = facts.project.id;
  try {
    return await sealArtifact({
      home: rt.home,
      project,
      repo: facts.project.repo,
      revision: facts.candidate.revision,
      exclude: [],
      bounds: {
        maxEntries: v.artifact_max_entries!,
        maxBytes: v.artifact_max_bytes!,
        totalMax: v.artifacts_max_bytes!,
        reserveDisk: v.host_reserve_disk!,
        deadlineSeconds: v.artifact_prepare_deadline!,
        startedMs: nowMs(),
        freeBytes: () => seamArtifactFreeBytes() ?? homeFreeBytes(rt.home),
        admission: (digest) => rt.read('deploy.artifact_admission', { project, digest }),
      },
    });
  } catch (err) {
    if (err instanceof ArtifactRefused) throw notReady(facts.candidate.id, err.reason, { refusal: err.refusal });
    throw err;
  }
}

async function build(rt: Runtime, facts: DeliverableFacts): Promise<Built> {
  const sealed = await sealFor(rt, facts);
  try {
    if (sealed.reused === 'corrupt') throw notReady(facts.candidate.id, `The sealed artifact ${sealed.digest} failed its rehash; nothing is packaged from it.`, { artifact_digest: sealed.digest });
    const manifest = sealed.manifest as ManifestEntry[];
    const entries = manifest.map(([path, , mode, , digest]) => {
      const bytes = readFileSync(join(sealed.path, ...path.split('/')));
      if (sha256(bytes) !== digest) throw notReady(facts.candidate.id, `The sealed artifact's ${path} does not have its manifest's SHA-256; nothing is packaged.`, { artifact_digest: sealed.digest });
      return { name: path, bytes, mode: mode === '100755' ? 0o755 : 0o644 };
    });
    const pkg = entries.find((e) => e.name === 'package.json')?.bytes ?? null;
    const read = (p: string): Buffer | null => (p === 'package.json' ? pkg : null);
    // The candidate's output kind as the deployment compatibility recorded
    // it from the candidate's tree (deploy/compatibility.ts), else the
    // sealed tree's.
    const kind = (await evaluatedKind(rt, facts.project.id, facts.candidate.id)) ?? outputKindOfTree(manifest, read);
    const start = startScriptOf(read);
    const zip = writeZip(entries, new Date(facts.candidate.nominated_at));
    const hex = sealed.digest.slice('sha256:'.length);
    const path = join(artifactsDir(rt.home), facts.project.id, `${hex}.zip`);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = join(dirname(path), `.staging-${randomBytes(8).toString('hex')}.zip`);
      try {
        writeFileSync(tmp, zip, { mode: 0o444, flag: 'wx' });
        renameSync(tmp, path);
      } finally {
        rmSync(tmp, { force: true });
      }
    }
    chmodSync(path, 0o444);
    const revision7 = facts.candidate.revision.slice(0, 7);
    const version = `${facts.candidate.seq}-${revision7}`;
    const row = await rt.engine<DeliverableRow>('deliverable.record', {
      project: facts.project.id,
      candidate: facts.candidate.id,
      revision: facts.candidate.revision,
      artifact_digest: sealed.digest,
      format: 'zip',
      version,
      filename: `${slugOf(facts.project.name)}-${version}.zip`,
      path,
      bytes: zip.length,
      sha256: sha256(zip),
      entries: manifest.length,
      manifest: JSON.stringify(manifest),
      output_kind: kind,
    });
    return { row, bytes: zip, manifest, start };
  } finally {
    // The sealed copy this read made, and no deployment records, goes (as a
    // request's does, deploy/commands.ts); the package stays.
    if (sealed.created) {
      try {
        const rows = await rt.read<{ project: string; digest: string; path: string }[]>('deploy.artifact_rows');
        if (!rows.some((r) => r.project === facts.project.id && r.digest === sealed.digest)) removeUnrecorded(rt.home, sealed.path, rows.some((r) => r.project === facts.project.id));
      } catch (err) {
        log('deliverable', err, { what: 'cleanup' });
      }
    }
  }
}

// The package of a candidate, built once, then re-verified at every read.
async function prepared(rt: Runtime, project: string, candidate: string): Promise<{ facts: DeliverableFacts; row: DeliverableRow; bytes: Buffer; start: string | null }> {
  const facts = await rt.read<DeliverableFacts>('deliverable.facts', { project, candidate });
  if (!facts.ready.ok) throw notReady(facts.candidate.id, facts.ready.reason ?? 'The candidate\'s phase gate is not satisfied.', { evaluation: facts.ready.evaluation });
  const known = facts.rows[0];
  if (known) {
    const v = verifyPackage(known.path, known, JSON.parse(known.manifest) as ManifestEntry[]);
    if (!v.ok) throw notReady(facts.candidate.id, `The recorded package ${known.filename} no longer verifies: ${v.why}.`, { deliverable: known.id });
    const pkg = readZip(v.bytes).find((e) => e.name === 'package.json')?.bytes ?? null;
    return { facts, row: known, bytes: v.bytes, start: startScriptOf((p) => (p === 'package.json' ? pkg : null)) };
  }
  let p = building.get(candidate);
  if (!p) {
    p = build(rt, facts).finally(() => building.delete(candidate));
    building.set(candidate, p);
  }
  const b = await p;
  // Read back as any later read is, before it is answered.
  const v = verifyPackage(b.row.path, b.row, b.manifest);
  if (!v.ok) throw notReady(facts.candidate.id, `The package just written does not verify: ${v.why}.`, { deliverable: b.row.id });
  return { facts, row: b.row, bytes: v.bytes, start: b.start };
}

// The output kind an evaluation of the deployment compatibility recorded
// for the candidate from its tree, or null (none, or not readable).
const evaluatedKind = (rt: Runtime, project: string, candidate: string): Promise<OutputKind | null> =>
  rt.read<OutputKind | null>('deploy.compatibility_kind', { project, candidate }).catch(() => null);

const nodeVersionOf = (runtimes: DeliverableFacts['runtimes']): string | null => (runtimes.some((r) => r.path === process.execPath) ? process.version : null);

// GET …/deliverable.
export async function deliverableRead(rt: Runtime, project: string, candidate: string): Promise<Record<string, unknown>> {
  const { facts, row, start } = await prepared(rt, project, candidate);
  const { platform, instructions, prerequisites } = platformOf((await evaluatedKind(rt, project, candidate)) ?? row.output_kind, { start, node: nodeVersionOf(facts.runtimes) });
  return {
    deliverable: {
      candidate: row.candidate,
      revision: row.revision,
      artifact_digest: row.artifact_digest,
      format: row.format,
      version: row.version,
      filename: row.filename,
      bytes: row.bytes,
      sha256: row.sha256,
      built_at: row.built_at,
      ready: true,
      not_ready_reason: null,
      platform,
      instructions,
      prerequisites,
      verification: { package: { state: 'verified', what: PACKAGE_VERIFIED }, execution: { state: 'not_tested', what: EXECUTION_NOT_TESTED } },
      download: `/v1/projects/${encodeURIComponent(project)}/candidates/${encodeURIComponent(candidate)}/deliverable/download`,
    },
  };
}

// GET …/deliverable/download: the verified bytes, as they were checked.
export async function deliverableDownload(rt: Runtime, project: string, candidate: string): Promise<{ bytes: Buffer; headers: Record<string, string> }> {
  const { row, bytes } = await prepared(rt, project, candidate);
  return {
    bytes,
    headers: {
      'content-disposition': `attachment; filename="${row.filename}"`,
      'x-surety-sha256': row.sha256,
    },
  };
}
