// Developer tests for E162 item 4 (D7 §6.4 as clarified): every design
// approval durably records its own effective asset set, unchanged assets
// and placeholders included, each entry {slot, variant, slot_version,
// source, digest}, with a digest on the approved revision and on its
// `design.approved` event; `design.assets_approved` and asset work follow
// only a change, and a retried approval records nothing twice. Against
// scratch stores; nothing is decoded or run.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const load = (p) => import(pathToFileURL(join(dist, p)).href);
const { placeholderManifest } = await load('design/assets.js');
const { recordInventory } = await load('design/store.js');
const { approveDesign, effectiveSetNow } = await load('design/approval.js');
const { designView } = await load('design/view.js');
const { migrate } = await load('store/migrate.js');
const { transact, ENGINE_ACTOR } = await load('store/transitions/tx.js');
const { setEngineSettings } = await load('store/transitions/settings.js');
const { canonical, sha256 } = await load('store/transitions/common.js');

const P = 'proj_set';
const TARGETS = ['web'];
const INVENTORY = JSON.stringify({ inventory_digest: 'dg', targets: TARGETS.map((t) => ({ module: 'ui', target: t, required_slots: [] })), ui_requirements: [], interfaces: [], obligations: [], fixtures: [], cross_platform: false });
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(dist, '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, domain_memory_max: 8 * 1024 ** 3, max_concurrent_domains: 8 });
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO "projects" ("id", "created_at", "name", "tier", "dev_repo_path", "integration_branch", "baseline_state", "registration_state", "management") VALUES (?, ?, 'pantry', 'T2', '/nowhere', 'main', 'spec_ready', 'registered', 'x')`).run(P, at);
  // The derivation: every default slot's placeholder effective.
  db.prepare(`INSERT INTO "design_inventories" ("id", "created_at", "project", "inventory_digest", "revision", "inventory", "manifest") VALUES ('dinv_1', ?, ?, 'dg1', 'r1', ?, ?)`).run(
    at,
    P,
    INVENTORY,
    JSON.stringify({ ...placeholderManifest('pantry', TARGETS).manifest, sources: {}, head_manifest: 'absent' }),
  );
  transact(db, ENGINE_ACTOR, (tx) => recordInventory(tx, { id: 'dinv_1' }));
  return { db, at };
}

// The head's manifest with logo/full proposed at `version` with `digest`.
function manifestWithLogo(version, digest) {
  const m = structuredClone(placeholderManifest('pantry', TARGETS).manifest);
  const logo = m.slots.find((s) => s.kind === 'logo');
  const full = logo.variants.find((v) => v.name === 'full');
  full.digest = digest;
  full.file = `assets/m/logo-${version}.svg`;
  Object.assign(logo, { slot_version: version, status: 'proposed', provenance: 'owner' });
  return m;
}

function propose(db, at, { id, version, scope, manifest, held = [] }) {
  db.prepare(
    `INSERT INTO "design_revisions" ("id", "created_at", "project", "version", "scope", "revision", "blobs", "origin", "targets", "asset_manifest", "selection", "narrowings", "status", "findings", "assets_held")
     VALUES (?, ?, ?, ?, ?, 'r9', '{}', 'intended', '[]', ?, NULL, '[]', 'proposed', '[]', ?)`,
  ).run(id, at, P, version, scope, JSON.stringify(manifest), JSON.stringify(held));
}
const approve = (db, id) => transact(db, ENGINE_ACTOR, (tx) => approveDesign(tx, { revision: id, specRevision: null, withoutCriteria: true }));
const recorded = (db, id) => {
  const r = db.prepare('SELECT "effective_assets", "effective_assets_digest" FROM "design_revisions" WHERE "id" = ?').get(id);
  return { entries: JSON.parse(r.effective_assets), digest: r.effective_assets_digest };
};
const events = (db, type, rev) => db.prepare(`SELECT "subject", "payload" FROM "events" WHERE "type" = ?`).all(type).filter((e) => JSON.parse(e.subject).design_revision === rev);
const assetWork = (db) => db.prepare(`SELECT "id", "trigger_id" FROM "work_items" WHERE "kind" = 'fix' AND "trigger_source" = 'asset_updated'`).all();
const entry = (set, slot, variant) => set.entries.find((e) => e.slot === slot && e.variant === variant);

test('two approvals in sequence: each records its own whole set (placeholders and unchanged assets included), each identifiable afterwards by its revision and its event', (t) => {
  const { db, at } = scratch(t);
  const placeholders = effectiveSetNow(db, P);
  assert.ok(placeholders.entries.length >= 3 && placeholders.entries.every((e) => e.source === 'placeholder'), 'the derivation left the placeholders effective');

  propose(db, at, { id: 'dsg_1', version: 1, scope: 'full', manifest: manifestWithLogo(2, A) });
  approve(db, 'dsg_1');
  const first = recorded(db, 'dsg_1');
  assert.equal(first.entries.length, placeholders.entries.length, 'one entry per selected slot and variant');
  for (const e of first.entries) assert.deepEqual(Object.keys(e).sort(), ['digest', 'slot', 'slot_version', 'source', 'variant'], 'each entry is {slot, variant, slot_version, source, digest}');
  assert.deepEqual(entry(first, 'logo', 'full'), { slot: 'logo', variant: 'full', slot_version: 2, source: 'approved', digest: A });
  assert.ok(first.entries.filter((e) => !(e.slot === 'logo' && e.variant === 'full')).every((e) => e.source === 'placeholder'), 'the placeholders it left effective are recorded');
  assert.equal(first.digest, sha256(canonical(first.entries)), 'the digest is of the recorded entries');
  assert.equal(JSON.parse(events(db, 'design.approved', 'dsg_1')[0].payload).effective_assets_digest, first.digest, 'design.approved carries it');
  assert.equal(events(db, 'design.assets_approved', 'dsg_1').length, 1, 'the logo moved: one design.assets_approved');

  propose(db, at, { id: 'dsg_2', version: 2, scope: 'asset_only', manifest: manifestWithLogo(3, B) });
  approve(db, 'dsg_2');
  const second = recorded(db, 'dsg_2');
  assert.deepEqual(entry(second, 'logo', 'full'), { slot: 'logo', variant: 'full', slot_version: 3, source: 'approved', digest: B });
  assert.notEqual(second.digest, first.digest);
  assert.equal(JSON.parse(events(db, 'design.approved', 'dsg_2')[0].payload).effective_assets_digest, second.digest);
  // The first approval's set is still identifiable, unchanged, after the second replaced the current set.
  assert.deepEqual(recorded(db, 'dsg_1'), first, 'the first approval\'s set survives the second');
  assert.equal(effectiveSetNow(db, P).digest, second.digest, 'the current set is the second approval\'s');

  // The design read: per revision, and the current set's digest.
  const view = designView(db, { project: P });
  const byId = Object.fromEntries(view.revisions.map((r) => [r.id, r]));
  assert.deepEqual({ entries: byId.dsg_1.effective_assets, digest: byId.dsg_1.effective_assets_digest }, first);
  assert.deepEqual({ entries: byId.dsg_2.effective_assets, digest: byId.dsg_2.effective_assets_digest }, second);
  assert.equal(view.effective_assets_digest, second.digest);
});

test('an approval that changes nothing records its set, with the same digest as the one before, and emits no change event and schedules no asset work', (t) => {
  const { db, at } = scratch(t);
  propose(db, at, { id: 'dsg_1', version: 1, scope: 'full', manifest: manifestWithLogo(2, A) });
  approve(db, 'dsg_1');
  const first = recorded(db, 'dsg_1');
  const workBefore = assetWork(db).length;
  // Logo B proposed and held: nothing effective moves.
  propose(db, at, { id: 'dsg_2', version: 2, scope: 'asset_only', manifest: manifestWithLogo(3, B), held: ['logo'] });
  approve(db, 'dsg_2');
  const second = recorded(db, 'dsg_2');
  assert.deepEqual(second, first, 'the same set, the same digest, recorded on the second approval');
  assert.equal(JSON.parse(events(db, 'design.approved', 'dsg_2')[0].payload).effective_assets_digest, first.digest);
  assert.equal(events(db, 'design.assets_approved', 'dsg_2').length, 0, 'no design.assets_approved');
  assert.equal(assetWork(db).length, workBefore, 'no asset_updated work');
  assert.ok(!assetWork(db).some((w) => String(w.trigger_id).startsWith('dsg_2:')));
});

test('the first approval with everything held still records the placeholders it leaves effective', (t) => {
  const { db, at } = scratch(t);
  const placeholders = effectiveSetNow(db, P);
  propose(db, at, { id: 'dsg_1', version: 1, scope: 'full', manifest: manifestWithLogo(2, A), held: ['logo'] });
  approve(db, 'dsg_1');
  const first = recorded(db, 'dsg_1');
  assert.deepEqual(first, placeholders, 'the placeholders, recorded with their digest');
  assert.ok(first.entries.length > 0 && first.entries.every((e) => e.source === 'placeholder'));
  assert.equal(events(db, 'design.assets_approved', 'dsg_1').length, 0);
});

test('a retried approval records nothing twice: the set, its digest and the events are unchanged', (t) => {
  const { db, at } = scratch(t);
  propose(db, at, { id: 'dsg_1', version: 1, scope: 'full', manifest: manifestWithLogo(2, A) });
  approve(db, 'dsg_1');
  propose(db, at, { id: 'dsg_2', version: 2, scope: 'asset_only', manifest: manifestWithLogo(3, B) });
  approve(db, 'dsg_2');
  const snapshot = () => ({
    sets: ['dsg_1', 'dsg_2'].map((id) => recorded(db, id)),
    approved: db.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" = 'design.approved'`).get().n,
    moved: db.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" = 'design.assets_approved'`).get().n,
    work: assetWork(db).length,
    current: effectiveSetNow(db, P),
  });
  const before = snapshot();
  approve(db, 'dsg_2');
  approve(db, 'dsg_1');
  assert.deepEqual(snapshot(), before);
});
