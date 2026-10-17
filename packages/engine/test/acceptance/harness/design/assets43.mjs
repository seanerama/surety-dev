// M6 slice 43, assets (M522, M523, M525, M526, M527, M534; SEAM.md §§504
// to 511). Built on slices 40 to 42's harness (reference.mjs, drive.mjs,
// check41.mjs) and pinned beside it:
//
// - the asset manifest edited as a Designer writes it (`propose`): a
//   proposal replaces one variant's file, its slot's `slot_version` and the
//   manifest's `version` each one above the base's, the slot `proposed`,
//   provenance `designer`, its history extended (D7 §6.1; B.16; §504);
// - a Designer turn writing a whole design, its manifest and asset files,
//   after removing `mockups/` and the test's own asset directory
//   `assets/m43/` (`assetTurn`), and the fault session over it
//   (`assetSession`, check41's `checkSession` with this turn);
// - asset files with valid headers (BS6 §4.1 rule 22): PNGs of any colour
//   type and size, a PNG whose header is truncated, a PNG whose header is
//   valid and whose image data is not, active SVGs; read back by the test's
//   own header reader (`pngHeader`, `svgPassive`), never decoded;
// - the owner's asset commands in the test's own home (`assetAdd`,
//   `assetsSubmit`) and `GET …/design/bindings`;
// - the release hook's seam route (`evaluateHook`, `hookEvaluations`;
//   §509) and the policy key `assets_required_for` (`setPolicy`);
// - Pantry carried to Alpha on the kernel lane with every effective slot a
//   placeholder (`toAlphaWithPlaceholders`), for M522 (b) and M534 (g).
//
// SAFETY (BS6 §4.1; E64). Nothing here starts, stops or signals a process
// but the scripted roles and the engine's own commands in the test's home;
// the process sampler only reads /proc. Nothing the Designer or the owner
// wrote is run or decoded (rules 21, 22).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

import { confirmRequired, consume } from '../decisions.mjs';
import { waitFor } from '../engine.mjs';
import { gitEnv } from '../git.mjs';
import { getPolicy } from '../journal.mjs';
import { alphaDeployed, alphaReady, evaluationsOfKind, journeyContext, pump } from '../journey/drive.mjs';
import { refOid } from '../repos.mjs';
import { step } from '../scripted.mjs';
import { postCloseRaw, postSaveRaw } from '../session-lane.mjs';
import { sayAndSettle, scriptTurns, turnResult } from '../sessions.mjs';
import { withStore } from '../store.mjs';
import { REQUIREMENTS, SPEC_MODULES, TARGETS_LINE } from './reference.mjs';
import { cli, designEvents, effectiveAssets, inventoryOf, manifestOf, openDesigner, readDesign, stageRow, toPublished } from './drive.mjs';
import { DESIGN_DIR, KERNEL_KINDS, approvedRevision, approveBatch, checkSession, designModel, filesOf, scriptVariant, specV2With, untilBatch } from './check41.mjs';

export const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
export const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const clone = (v) => structuredClone(v);
const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const parse = (v) => (v === null || v === undefined ? v : typeof v === 'string' ? JSON.parse(v) : v);

// The test's own asset directory under .surety/design/ (relative to it).
export const M43 = 'assets/m43';

// D7 §6.2's default table, as SEAM.md §484 pins it: kind → variants.
export const DEFAULT_VARIANTS = Object.freeze({
  logo: ['full', 'compact', 'monochrome', 'on_light', 'on_dark'],
  favicon: ['default'],
  app_icon_android: ['default', 'adaptive_foreground', 'adaptive_background'],
  app_icon: ['default'],
  splash: ['default'],
});

// ---- files with valid headers (rule 22; nothing decoded) ---------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([len, typed, crc]);
};
const ihdr = (w, h, colorType) => {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0);
  b.writeUInt32BE(h, 4);
  b[8] = 8;
  b[9] = colorType;
  return b;
};
// A flat PNG of colour type 2 (truecolour, no alpha channel) or 6
// (truecolour with alpha), every pixel `rgba` (alpha 0xff: every pixel opaque).
export function pngOf(w, h, { alpha = false, rgba = [0x0b, 0x5c, 0xad, 0xff] } = {}) {
  const px = Buffer.from(alpha ? rgba : rgba.slice(0, 3));
  const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: w }, () => px)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr(w, h, alpha ? 6 : 2)), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
// A PNG whose header is valid and whose image data is not zlib at all: a
// decoder fails on it (or, at w x h, would allocate w * h * 3 bytes); a
// header check reads its signature and IHDR and passes it.
export function headerOnlyPng(w, h) {
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr(w, h, 2)), pngChunk('IDAT', Buffer.from('not zlib data, never to be inflated', 'ascii')), pngChunk('IEND', Buffer.alloc(0))]);
}
// A PNG cut off inside its IHDR: the signature, then four bytes.
export const truncatedPng = () => Buffer.concat([PNG_SIGNATURE, Buffer.from([0, 0, 0, 13])]);

// A passive SVG of w x h whose text holds `label`.
export const passiveSvg = (w, h, label = 'Pantry') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#2e7d32"/><text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="#ffffff">${label}</text></svg>\n`;
// Active SVGs (D7 §14): a script, an event attribute, an external reference.
export const ACTIVE_SVG = Object.freeze({
  script: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><script>document.title = "ran";</script><rect width="48" height="48"/></svg>\n',
  onload: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" onload="document.title = \'ran\'"><rect width="48" height="48"/></svg>\n',
  external: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="48" height="48"><image href="https://example.org/mark.png" width="48" height="48"/></svg>\n',
});

// The test's own header reads (never the engine's): a PNG's signature and
// IHDR; an SVG's root and whether it is passive.
export function pngHeader(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIGNATURE) || b.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] };
}
export const isSvg = (bytes) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(Buffer.from(bytes).subarray(0, 4096).toString('utf8'));
export function svgPassive(text) {
  if (/<script[\s>]/i.test(text)) return false;
  if (/\son[a-z]+\s*=/i.test(text)) return false;
  if (/(?:href|src)\s*=\s*["']\s*(?!#|data:)[^"']+/i.test(text)) return false;
  return true;
}

// ---- git reads as bytes -----------------------------------------------------------------------

export const blobBytes = (repo, rev, path) => {
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, 'cat-file', 'blob', `${rev}:${path}`], { env: gitEnv(repo), maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
};
export const headOf = (p) => refOid(p.repo.path, p.repo.ref);
// The file a manifest variant names, as bytes at `rev` (the head by default).
export const variantBytes = (p, variant, rev = headOf(p)) => (variant?.file ? blobBytes(p.repo.path, rev, `${DESIGN_DIR}${variant.file}`) : null);

// ---- the manifest as a Designer edits it (B.16; SEAM.md §504) -----------------------------------

export const slotOf = (manifest, key) => {
  const s = (manifest?.slots ?? []).find((x) => x.key === key);
  assert.ok(s, `the manifest has slot ${key} (${JSON.stringify((manifest?.slots ?? []).map((x) => x.key))})`);
  return s;
};
export const variantOf = (slot, name) => (slot?.variants ?? []).find((v) => v.name === name) ?? null;

// The base manifest with `proposals` ([{slot, variant, format, size?,
// transparency?, file, bytes}]): each named variant's file replaced, each
// touched slot's slot_version one above the base's, `proposed`, provenance
// `designer`, status_since `designVersion`, a history entry of its files
// appended; the manifest's version one above the base's. Returns
// {manifest, files: {path under .surety/design/: bytes}}.
export function propose(base, proposals, { designVersion = 1, provenance = 'designer' } = {}) {
  const m = clone(base);
  const files = {};
  const touched = new Set();
  for (const p of proposals) {
    const slot = slotOf(m, p.slot);
    const v = { name: p.variant, format: p.format, ...(p.size ? { size: p.size } : {}), transparency: p.transparency ?? 'any', file: p.file, digest: sha256hex(p.bytes) };
    const i = slot.variants.findIndex((x) => x.name === p.variant);
    if (i >= 0) slot.variants[i] = v;
    else slot.variants.push(v);
    files[p.file] = p.bytes;
    touched.add(p.slot);
  }
  for (const key of touched) {
    const slot = slotOf(m, key);
    const was = slotOf(base, key);
    slot.slot_version = was.slot_version + 1;
    slot.status = 'proposed';
    slot.provenance = provenance;
    slot.status_since = designVersion;
    slot.history = [...(was.history ?? []), { slot_version: slot.slot_version, design_version: designVersion, status: 'proposed', files: slot.variants.filter((v) => v.digest).map((v) => ({ variant: v.name, digest: v.digest })) }];
  }
  m.version = base.version + 1;
  return { manifest: m, files };
}

// A slot the design adds (a banner, say), proposed by the Designer.
export function addSlot(manifest, slot, { designVersion = 1 } = {}) {
  const m = clone(manifest);
  const s = { slot_version: 1, status: 'proposed', provenance: 'designer', status_since: designVersion, ...clone(slot) };
  s.history = [{ slot_version: s.slot_version, design_version: designVersion, status: 'proposed', files: s.variants.filter((v) => v.digest).map((v) => ({ variant: v.name, digest: v.digest })) }];
  m.slots.push(s);
  return m;
}

// ---- a Designer turn with assets, and the fault session over it ---------------------------------

// The model (check41's designModel) with `manifest` and `assets` ({path
// under .surety/design/: bytes}) as its extra files.
export function withAssets(model, manifest, assets = {}) {
  const m = { ...model, extra: { ...model.extra, 'assets/manifest.json': json(manifest), ...assets } };
  return m;
}
// A turn writing the whole design after removing mockups/ and assets/m43/.
export function assetTurn(model, { reply = 'The design is written.' } = {}) {
  const writes = Object.entries(filesOf(model)).map(([path, content]) => (Buffer.isBuffer(content) ? step.writeBytes(path, content) : step.write(path, content)));
  return { steps: [step.delete(`${DESIGN_DIR}mockups`), step.delete(`${DESIGN_DIR}${M43}`), ...writes, step.result(turnResult({ reply, artifact_changed: true }))] };
}
// One Designer session: each case ({name, model}) a turn writing it and a
// save; a last turn of talk. Returns {run, saves: [{name, res, turn}]}; the
// session is left open. `during(save)`: a promise run beside each save.
export async function assetSession(fx, project, cases, { during } = {}) {
  const run = await openDesigner(fx, project);
  const talk = { steps: [step.result(turnResult({ reply: 'Read the engine\'s notes.' }))] };
  scriptTurns(fx, run.id, [...cases.map((c) => assetTurn(c.model, { reply: `Written: ${c.name}.` })), talk]);
  const saves = [];
  for (const c of cases) {
    await sayAndSettle(fx, project, run.id, `Draw it: ${c.name}.`);
    const res = during ? await during(() => postSaveRaw(fx, project, run.id)) : await postSaveRaw(fx, project, run.id);
    saves.push({ name: c.name, res, turn: saves.length + 1 });
  }
  await sayAndSettle(fx, project, run.id, 'What did the engine say?');
  return { run, saves };
}
export const refuseClose = (fx, project, run) => postCloseRaw(fx, project, run, { refuse: true });
export { checkSession };

// The save refused by the design check with `code` in a reason whose text
// names any one of `anyOf`.
export function assertReasonAny(res, code, anyOf, what) {
  const check = res?.body?.design_check;
  assert.equal(res?.status, 200, `${what}: the save answers 200 with its check (SEAM.md §483) (→ ${res?.status} ${res?.text?.slice(0, 600)})`);
  assert.equal(check?.outcome, 'refused', `${what}: the design check refused (${JSON.stringify(check)?.slice(0, 1200)})`);
  const hit = (check.reasons ?? []).find((r) => r.code === code && anyOf.some((n) => JSON.stringify(r.subjects ?? r).includes(n)));
  assert.ok(hit, `${what}: ${code} naming one of ${anyOf.join(', ')} (reasons: ${JSON.stringify(check.reasons)})`);
  return hit;
}

// ---- the process inventory around a save (M506 (h)'s reading) ------------------------------------

export function descendants(pid) {
  const out = [];
  const walk = (p) => {
    let tasks = [];
    try {
      tasks = readdirSync(`/proc/${p}/task`);
    } catch {
      return;
    }
    for (const t of tasks) {
      let kids = [];
      try {
        kids = readFileSync(`/proc/${p}/task/${t}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
      } catch {
        kids = [];
      }
      for (const k of kids) {
        let cmd = '';
        try {
          cmd = readFileSync(`/proc/${k}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
        } catch {
          cmd = '';
        }
        out.push({ pid: k, cmd });
        walk(k);
      }
    }
  };
  walk(pid);
  return out;
}
// Runs `fn` while sampling the engine's descendants every 5 ms; returns
// {value, seen: [{pid, cmd}] matching `pattern`} (git itself excluded).
export async function sampled(fx, pattern, fn) {
  const seen = [];
  let on = true;
  const suspicious = (d) => pattern.test(d.cmd) && !/^(\S*\/)?git(\s|$)/.test(d.cmd);
  const sampler = (async () => {
    while (on) {
      for (const d of descendants(fx.engine.pid)) if (suspicious(d)) seen.push(d);
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  let value;
  try {
    value = await fn();
  } finally {
    on = false;
    await sampler;
  }
  return { value, seen };
}

// ---- the owner's asset commands and reads (D7 A.8; SEAM.md §§505, 508) ---------------------------

// `surety design asset add --project <p> <slot> <variant> <file>`: the file
// written under the test's root first. Returns the CLI's {status, body, stdout, stderr}.
export function assetAdd(fx, project, slot, variant, name, bytes) {
  const file = join(fx.root, name);
  writeFileSync(file, bytes);
  return cli(fx, ['design', 'asset', 'add', '--project', project, slot, variant, file]);
}
export const assetsSubmit = (fx, project) => cli(fx, ['design', 'assets', 'submit', '--project', project]);
export async function readBindings(fx, project) {
  const res = await fx.engine.get(`/v1/projects/${project}/design/bindings`);
  assert.equal(res.status, 200, `GET …/design/bindings (D7 A.8; SEAM.md §508) (→ ${res.status} ${res.text?.slice(0, 400)})`);
  return res.body;
}

// The asset_updated fix items (SEAM.md §487).
export const assetFixes = (home, project) =>
  rows(home, 'SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = \'fix\' ORDER BY "seq"', project)
    .map((w) => ({ ...w, subject: parse(w.subject) }))
    .filter((w) => w.subject?.cause === 'asset_updated');
export const versionObligations = (home, project) => rows(home, 'SELECT * FROM "check_obligations" WHERE "project" = ? AND "reason" = \'asset_version_changed\' ORDER BY rowid', project);
// The check results of a check key, oldest first, asset_inputs parsed.
export const resultsOfKey = (home, project, key) =>
  rows(home, 'SELECT r.* FROM "check_results" r JOIN "check_executions" x ON x."id" = r."execution" JOIN "checks" c ON c."id" = x."check" WHERE r."project" = ? AND c."key" = ? ORDER BY r."execution_seq"', project, key).map((r) => ({ ...r, asset_inputs: parse(r.asset_inputs) ?? [] }));
export const designAssetsOf = (home, revision) => rows(home, 'SELECT * FROM "design_assets" WHERE "design_revision" = ? ORDER BY rowid', revision);
// The newest open design_approval (by insertion).
export const openApproval = (home, project) => rows(home, 'SELECT * FROM "decisions" WHERE "project" = ? AND "kind" = \'design_approval\' AND "status" = \'open\' ORDER BY rowid', project).map((d) => ({ ...d, options: parse(d.options), evidence: parse(d.evidence) })).at(-1) ?? null;

// ---- policy and the release hook (D7 §6.7, A.7; SEAM.md §509) -------------------------------------

// A policy change through the owner's route: applied directly (200), or,
// where the engine counts it a widening, its confirmation approved.
export async function setPolicy(fx, project, change) {
  const before = (await getPolicy(fx.engine, project)).revision ?? 0;
  const res = await fx.engine.post(`/v1/projects/${project}/policy`, change);
  if (res.status === 409 && res.body?.code === 'confirm_required') {
    const row = await confirmRequired(fx, `/v1/projects/${project}/policy`, change);
    await consume(fx, project, row, 'approve');
  } else assert.equal(res.status, 200, `the policy change ${JSON.stringify(change)} (→ ${res.status} ${res.text})`);
  return waitFor(
    async () => {
      const p = await getPolicy(fx.engine, project);
      return p.revision > before && Object.entries(change).every(([k, v]) => JSON.stringify(p.effective?.[k]) === JSON.stringify(v)) ? p : undefined;
    },
    { what: `the policy ${JSON.stringify(change)} effective` },
  );
}

// POST /v1/harness/release-hook: the hook's condition evaluated through the seam.
export const evaluateHook = (fx, body) => fx.engine.post('/v1/harness/release-hook', body);
export async function hookEvaluated(fx, body, what) {
  const res = await evaluateHook(fx, body);
  assert.equal(res.status, 200, `${what}: POST /v1/harness/release-hook (SEAM.md §509) (→ ${res.status} ${res.text?.slice(0, 400)})`);
  return res.body;
}
// GET /v1/harness/release-hook: every evaluation of the condition since start.
export async function hookEvaluations(fx) {
  const res = await fx.engine.get('/v1/harness/release-hook');
  assert.equal(res.status, 200, `GET /v1/harness/release-hook (SEAM.md §509) (→ ${res.status} ${res.text?.slice(0, 400)})`);
  assert.ok(Array.isArray(res.body?.evaluations), `its evaluations (${res.text?.slice(0, 400)})`);
  return res.body.evaluations;
}
// The callers allowed to evaluate the condition before D5: the seam and GET …/design's count.
export const ALLOWED_CALLERS = Object.freeze(['harness', 'design_view']);
export const notApprovedOf = (answer) => [...new Set((answer?.reasons ?? []).filter((r) => r.code === 'ASSETS_NOT_APPROVED').flatMap((r) => r.subjects ?? []))].sort();

// ---- Pantry to Alpha with every effective slot a placeholder (M522 (b), M534 (g)) ---------------

export const TO_ALPHA_POLICY = Object.freeze({ design: 'before_build', autonomy: 'phase', alpha_deploy: 'on_phase_complete', phase_size: { min: 1, max: 5 } });

// Pantry under `before_build` and `on_phase_complete`, its design the
// engine's placeholders only (designModel proposes no asset), approved
// through the batch; then built, its phase complete and Alpha deployed on the
// kernel lane's scripted adapter. Returns {p, ctx, model, approved, ready,
// marks: {readyAt, uiLaunched, phase, alphaAuthorize, deployed}}; a step
// that fails throws naming it.
export async function toAlphaWithPlaceholders(fx, { name = 'pantry-alpha' } = {}) {
  const { p } = await toPublished(fx, { policy: TO_ALPHA_POLICY, name });
  const model = designModel(inventoryOf(p));
  const v2 = specV2With({ criteria: model.criteria, base: REQUIREMENTS, targets: TARGETS_LINE, modules: SPEC_MODULES });
  const ctx = scriptVariant(fx, p, v2);
  ctx.answerKinds = [...KERNEL_KINDS];
  await alphaReady(fx, ctx);
  const out = await checkSession(fx, p.id, [{ name: 'the design over the engine\'s placeholders', model }]);
  assert.equal(out.saves[0].res.body?.design_check?.outcome, 'passed', `the design over the placeholders passes (${out.saves[0].res.text?.slice(0, 600)})`);
  const closed = await postCloseRaw(fx, p.id, out.run.id, {});
  assert.equal(closed.status, 200, `the close (${closed.text?.slice(0, 400)})`);
  const batch = await untilBatch(fx, ctx);
  const approved = await approveBatch(fx, ctx, batch);
  const eff = effectiveAssets(fx.home, p.id);
  assert.ok(eff.length > 0 && eff.every((e) => e.source === 'placeholder'), `every effective slot a placeholder (${JSON.stringify(eff)})`);
  const ready = await pump(fx, ctx, () => approvedRevision(fx.home, p.id)?.ready_at ?? undefined, { what: 'design_ready with every slot a placeholder', max: 40 });
  const uiLaunched = await pump(fx, ctx, () => ([2, 3].every((n) => fx.scripted.launches({ work_item: stageRow(fx.home, p.id, n)?.work_item }).length > 0) ? true : undefined), { what: 'both UI stages dispatched', max: 80 });
  const deployed = await alphaDeployed(fx, ctx, { max: 200 });
  const phase = evaluationsOfKind(fx.home, p.id, 'phase');
  const alphaAuthorize = evaluationsOfKind(fx.home, p.id, 'alpha_authorize');
  return { p, ctx, model, approved, ready, marks: { readyAt: ready, uiLaunched, phase, alphaAuthorize, deployed } };
}

export { designEvents, manifestOf, readDesign };
