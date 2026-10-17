// The design journey's steps and reads (D7 §1; BS6 §8; M6 plan §2.3;
// SEAM.md §§480 to 489), each a function a row's file calls as far as its
// cases need. Every human act goes through the owner's production routes
// or the `surety` CLI in the test's own home (BS6 §4.1 rule 26); nothing
// installs a design, an effective asset row, a binding, a readiness or a
// verdict by fixture (BS5 §4.1 rule 20, carried). Lane-agnostic: the kernel
// rows and the project-lane journey share these steps, as M5's did.
//
// SAFETY (BS6 §4.1; E64). Nothing here acts on a unit or signals a process:
// the preview's unit is the engine's, started and stopped by the engine's
// own commands, and read here by exact name only. No browser, no decoder:
// served bytes are compared as bytes (rules 21, 22).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';

import { consume, decision, decisionsOfKind } from '../decisions.mjs';
import { CLI } from '../engine.mjs';
import { eventsOfType } from '../journal.mjs';
import { createWithIdea, ownerPolicy, waitPublished } from '../journey/drive.mjs';
import { fileAt, refOid } from '../repos.mjs';
import { roleThat } from '../gitruns.mjs';
import { script, step } from '../scripted.mjs';
import { closeSession, openSession, saveSession, sayAndSettle, scriptTurns, turnResult, turnThatWrites } from '../sessions.mjs';
import { withStore } from '../store.mjs';
import { specSaves } from '../journey/spec34.mjs';
import {
  ANDROID_LOGO_PATH,
  APP_CSS,
  APP_JS,
  CORRECTION_FILES,
  IDEA_BRIEF,
  INDEX_HTML,
  INVENTORY_PATH,
  MANIFEST_PATH,
  PACKAGE_LOGO,
  PACKAGE_TOKENS_CSS,
  PROJECT_NAME,
  REQUIREMENTS,
  SERVER_MJS,
  SPEC,
  SPEC_V2,
  SPEC_V2_CHANGES,
  STAGES,
  WEB_LOGO_PATH,
  architectFiles,
  authoringFiles,
  bindingOf,
  designFiles,
  specText,
} from './reference.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const one = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).get(...params));
const parse = (v) => (v === null || v === undefined ? v : typeof v === 'string' ? JSON.parse(v) : v);

// The design journey's policy (BS6 §8): `design: both`, `phase`,
// `on_phase_complete`, and a phase size that admits the one-stage phases of
// the kernel variants.
export const DESIGN_POLICY = Object.freeze({ design: 'both', autonomy: 'phase', alpha_deploy: 'on_phase_complete', phase_size: { min: 1, max: 5 } });

// ---- steps 1 to 4 (D6 §1; D7 §1 steps 1 to 4) ------------------------------------------------

// The project created with the idea and its policy (the `design` key a tightening, set directly).
export const createPantry = (fx, { policy = DESIGN_POLICY, name = PROJECT_NAME } = {}) => createWithIdea(fx, { idea: IDEA_BRIEF, name, files: { 'README.md': '# Pantry\n' }, policy });

// A Spec Writer session saving `text` once and closing; `answer` the
// owner's `approve`. Returns {run, saves, approval, answered}.
export async function pantrySpec(fx, project, { text = SPEC, answer = true } = {}) {
  const s = await specSaves(fx, project, [text]);
  let answered = null;
  if (answer) {
    assert.ok(s.approval, `the close raised spec_approval (${JSON.stringify(s.closed)}; findings ${JSON.stringify(s.saves[0]?.findings)})`);
    answered = await consume(fx, project, s.approval, 'approve');
  }
  return { ...s, answered };
}

// The Architect's session with Pantry's products, as M5's `architectSession`.
export async function pantryArchitect(fx, project, repo, { files: fileOpts = {}, answer = 'both', publishTicks = 6 } = {}) {
  const run = await openSession(fx, project, 'architect');
  const revision = refOid(repo.path, repo.ref);
  const files = architectFiles({ revision, ...fileOpts });
  scriptTurns(fx, run.id, [turnThatWrites(files, { reply: 'Architecture, module map with surfaces, targets and shapes, one ADR, the roadmap and phase 1.', done: true })]);
  await sayAndSettle(fx, project, run.id, 'Design Pantry from the approved specification and plan phase 1.');
  const saved = await saveSession(fx, project, run.id);
  const res = await fx.engine.post(`/v1/projects/${project}/sessions/${run.id}/close`, {});
  const out = { run, revision, files, saved, closeRes: res, decisions: {}, published: null };
  if (res.status !== 200) return out;
  for (const d of res.body.decisions ?? []) out.decisions[d.kind] = decision(fx.home, d.id);
  if (answer === 'none') return out;
  for (const kind of ['architecture_approval', 'plan_approval']) {
    assert.ok(out.decisions[kind], `the close raised ${kind} (${res.text})`);
    await consume(fx, project, out.decisions[kind], 'approve');
  }
  out.published = await waitPublished(fx, project, { max: publishTicks });
  return out;
}

// Steps 1 to 4 on the kernel lane, no Vision session (its idea record is
// not read by the design): the project, the spec, the architecture, the
// publication. Returns {p, spec, arch}.
export async function toPublished(fx, { policy = DESIGN_POLICY, name, spec = SPEC, files = {} } = {}) {
  const p = await createPantry(fx, { policy, name });
  const s = await pantrySpec(fx, p.id, { text: spec });
  const arch = await pantryArchitect(fx, p.id, p.repo, { files });
  assert.equal(arch.closeRes.status, 200, `the Architect's close is accepted (${arch.closeRes.status} ${arch.closeRes.text?.slice(0, 600)}; save findings ${JSON.stringify(arch.saved?.findings)})`);
  return { p, spec: s, arch };
}

// ---- git reads -------------------------------------------------------------------------------

export const head = (p) => refOid(p.repo.path, p.repo.ref);
export const gitText = (p, path, rev = head(p)) => {
  try {
    return fileAt(p.repo.path, rev, path);
  } catch {
    return null;
  }
};
export const gitJson = (p, path, rev) => {
  const text = gitText(p, path, rev);
  return text === null ? null : JSON.parse(text);
};
// The inventory and the asset manifest the engine committed (B.9, B.16).
export function inventoryOf(p, rev) {
  const inv = gitJson(p, INVENTORY_PATH, rev);
  assert.ok(inv, `the engine committed ${INVENTORY_PATH} on the integration branch (D7 §4.4)`);
  return inv;
}
export function manifestOf(p, rev) {
  const m = gitJson(p, MANIFEST_PATH, rev);
  assert.ok(m, `the engine committed ${MANIFEST_PATH} with its placeholders (D7 §6.3)`);
  return m;
}

// ---- the Designer session (D7 §3; B.12) -------------------------------------------------------

// A Designer turn writing the files given and replying (B.12's result).
export const designTurn = (files, result = {}) => turnThatWrites(files, { reply: 'The design is written.', ...result });
// A Designer turn that dumps its package first (SEAM.md §343's probe).
export const designTurnDumping = (files, result = {}) => ({ steps: [step.probe('context_dump'), ...designTurn(files, result).steps] });

// `surety session open designer` (D7 A.8): POST …/sessions {role: designer[, mode]}.
export const openDesigner = (fx, project, body = {}) => openSession(fx, project, 'designer', body);

// One Designer session: one turn per element of `turns` ({files, say,
// result?, dump?, save?}), a save after each turn whose `save` is not
// false; closed with `close` (null leaves it open). Returns {run, turns, saves, closed}.
export async function designerSession(fx, project, turns, { close = {}, body = {} } = {}) {
  const run = await openDesigner(fx, project, body);
  scriptTurns(fx, run.id, turns.map((t) => (t.dump ? designTurnDumping(t.files ?? {}, t.result) : designTurn(t.files ?? {}, t.result))));
  const out = { run, turns: [], saves: [], closed: null, closeRes: null };
  for (const t of turns) {
    out.turns.push(await sayAndSettle(fx, project, run.id, t.say ?? 'Draw the design.'));
    out.saves.push(t.save === false ? null : await fx.engine.post(`/v1/projects/${project}/sessions/${run.id}/save`, {}));
  }
  if (close !== null) {
    out.closeRes = await fx.engine.post(`/v1/projects/${project}/sessions/${run.id}/close`, close);
    out.closed = out.closeRes.status === 200 ? out.closeRes.body : null;
  }
  return out;
}

// The whole valid design from what the engine derived, at the head.
export const validDesign = (p, opts = {}) => designFiles(inventoryOf(p), manifestOf(p), opts);

// ---- decisions -------------------------------------------------------------------------------

export const designDecisions = (home, project, kind) => decisionsOfKind(home, project, kind);
export const openOfKind = (home, project, kind) => designDecisions(home, project, kind).filter((d) => d.status === 'open');
// The open design_due (D7 §11): at most one per project. Its `evidence`
// holds the question's text fields (SEAM.md §485): {stage, held_stages, stale_screens, command}.
export function openDesignDue(home, project) {
  const open = openOfKind(home, project, 'design_due');
  assert.ok(open.length <= 1, `one design_due open per project at a time (D7 §11) (${open.length} open)`);
  return open[0] ?? null;
}
// The batch a close raised: {design_approval, spec_change} under one batch_key.
export function batchOf(home, project) {
  const approval = openOfKind(home, project, 'design_approval').at(-1) ?? null;
  if (!approval) return null;
  const members = approval.batch_key ? rows(home, 'SELECT "id", "kind" FROM "decisions" WHERE "project" = ? AND "batch_key" = ? AND "status" = \'open\' ORDER BY "kind"', project, approval.batch_key) : [];
  const change = members.find((m) => m.kind === 'spec_change');
  return { design_approval: approval, spec_change: change ? decision(home, change.id) : null, batch_key: approval.batch_key, members };
}
// An answer through the owner's route with extra fields (`assets_held`, a note).
export const answerWith = (fx, project, row, option, extra = {}) => fx.engine.post(`/v1/projects/${project}/decisions/${row.id}/answer`, { option, preview_hash: row.preview_hash, ...extra });

// ---- store reads (D7 A.3) ----------------------------------------------------------------------

export const designRevisions = (home, project) => rows(home, 'SELECT * FROM "design_revisions" WHERE "project" = ? ORDER BY rowid', project).map((r) => ({ ...r, selection: parse(r.selection), targets: parse(r.targets) }));
export const effectiveAssets = (home, project) => rows(home, 'SELECT * FROM "design_effective_assets" WHERE "project" = ? ORDER BY "slot", "variant"', project);
export const assetBindings = (home, project) => rows(home, 'SELECT * FROM "asset_bindings" WHERE "project" = ? ORDER BY rowid', project);
export const designReviews = (home, project) =>
  rows(home, 'SELECT r.* FROM "design_reviews" r JOIN "design_revisions" d ON d."id" = r."design_revision" WHERE d."project" = ? ORDER BY r.rowid', project).map((r) => ({ ...r, subject: parse(r.subject), verdicts: parse(r.verdicts) }));
export const designEvents = (home, type, project) => eventsOfType(home, type).filter((e) => e.subject?.project === project);
export const workItems = (home, project, kind) =>
  rows(home, kind === undefined ? 'SELECT * FROM "work_items" WHERE "project" = ? ORDER BY "seq"' : 'SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = ? ORDER BY "seq"', ...(kind === undefined ? [project] : [project, kind])).map((w) => ({
    ...w,
    subject: parse(w.subject),
    depends_on: parse(w.depends_on),
    held_intervals: parse(w.held_intervals) ?? [],
    milestones_met: parse(w.milestones_met) ?? [],
  }));
export const stagesOf = (home, project) => rows(home, 'SELECT * FROM "stages" WHERE "project" = ? ORDER BY rowid', project);
// Stage n of the project's newest plan for phase `phase` (by insertion).
export function stageRow(home, project, number, phase = 1) {
  const plan = one(home, 'SELECT "id" FROM "phase_plans" WHERE "project" = ? AND "phase_number" = ? ORDER BY rowid DESC LIMIT 1', project, phase);
  return plan ? one(home, 'SELECT * FROM "stages" WHERE "phase_plan" = ? AND "number" = ?', plan.id, number) : null;
}
export const stageWork = (home, project, number, phase = 1) => {
  const s = stageRow(home, project, number, phase);
  return s ? workItems(home, project, 'stage_build').find((w) => w.id === s.work_item) ?? null : null;
};
export const revisionsOfKind = (home, project, kind) => rows(home, 'SELECT * FROM "revisions" WHERE "project" = ? AND "kind" = ? ORDER BY rowid', project, kind);
export const recordsOfKind = (home, kind) => rows(home, 'SELECT * FROM "records" WHERE "kind" = ? ORDER BY rowid', kind);

// GET /v1/projects/:p/design (D7 A.8; SEAM.md §480).
export async function readDesign(fx, project) {
  const res = await fx.engine.get(`/v1/projects/${project}/design`);
  assert.equal(res.status, 200, `GET …/design (D7 A.8) (→ ${res.status} ${res.text?.slice(0, 400)})`);
  return res.body;
}

// ---- the invariant of D7 §11 (BS6 §4.1 rule 25) ------------------------------------------------

// No design hold without an open design_due naming it: every stage_build
// item held `design_pending` or `design_stale` has its stage among the open
// design_due's `held_stages`. Returns the held items.
export function assertNoSilentHold(home, project, where = 'here') {
  const held = workItems(home, project, 'stage_build').filter((w) => ['design_pending', 'design_stale'].includes(w.held));
  if (held.length === 0) return held;
  const due = openDesignDue(home, project);
  assert.ok(due, `${where}: ${held.length} UI stage(s) held ${held.map((w) => w.held).join(', ')} with no open design_due (D7 §11: no silent stall)`);
  const named = due.evidence?.held_stages ?? [];
  for (const w of held) assert.ok(named.includes(w.subject?.stage), `${where}: the open design_due names held stage ${w.subject?.stage} (it names ${JSON.stringify(named)})`);
  return held;
}

// ---- the `surety design` and `surety env` commands, in the test's own home ----------------------

// One CLI command with this test's SURETY_HOME only: {status, body, stdout, stderr}.
export function cli(fx, args, { timeoutMs = 300_000 } = {}) {
  const done = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, SURETY_HOME: fx.home } });
  let body;
  try {
    body = JSON.parse(done.stdout);
  } catch {
    body = undefined;
  }
  return { status: done.status, body, stdout: done.stdout ?? '', stderr: done.stderr ?? '' };
}

// GET over loopback, bytes kept as bytes (nothing rendered or decoded, rule 21).
export function getBytes(url, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.on('error', (err) => resolve({ status: null, error: err.code ?? String(err) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: null, error: err.code ?? String(err) }));
  });
}

// ---- the roles' scripts (SEAM.md §482) ---------------------------------------------------------

const writes = (files) => Object.entries(files).map(([path, text]) => step.write(path, text));

// The Builder of each Pantry stage: the API writes server.mjs; each UI
// Builder places the effective logo and (web) the generated tokens.css from
// its own package, writes its source and returns a binding for the file it
// placed (B.17). `dump`: the package dumped first (M509; M536 (g)).
export function builderScript(number, { dump = false, noDesign = false } = {}) {
  const pre = dump ? [step.probe('context_dump')] : [];
  if (number === 1) return roleThat([...pre, ...writes({ 'server.mjs': SERVER_MJS })]);
  // A UI stage built with no design (design off or waived): its own files, nothing placed, no binding.
  if (noDesign && number === 2) return roleThat([...pre, ...writes({ 'web/index.html': INDEX_HTML, 'web/app.css': APP_CSS, 'web/tokens.css': ':root { --color-text-primary: #1a1a1a; }\n' })]);
  if (noDesign && number === 3) return roleThat([...pre, ...writes({ 'mobile/App.js': APP_JS })]);
  if (number === 2) return roleThat([...pre, step.copyContext(PACKAGE_TOKENS_CSS, 'web/tokens.css'), step.copyContext(PACKAGE_LOGO, WEB_LOGO_PATH), ...writes({ 'web/index.html': INDEX_HTML, 'web/app.css': APP_CSS })], { asset_bindings: [bindingOf('web', WEB_LOGO_PATH)] });
  if (number === 3) return roleThat([...pre, step.copyContext(PACKAGE_LOGO, ANDROID_LOGO_PATH), ...writes({ 'mobile/App.js': APP_JS })], { asset_bindings: [bindingOf('android', ANDROID_LOGO_PATH)] });
  throw new Error(`no Builder for stage ${number}`);
}
// The `asset_updated` fix (D7 §6.5): the new effective logo placed at every bound path, rebound.
export const assetFixScript = () =>
  roleThat([step.probe('context_dump'), step.copyContext(PACKAGE_LOGO, WEB_LOGO_PATH), step.copyContext(PACKAGE_LOGO, ANDROID_LOGO_PATH)], { asset_bindings: [bindingOf('web', WEB_LOGO_PATH), bindingOf('android', ANDROID_LOGO_PATH)] });

// Every role of the journey by work kind; each stage's Builder by its own
// work item once the plan is published (`scriptBuilders`).
export function designScripts(fx) {
  fx.scripted.kindScript('check_authoring', [0, 1, 2, 3].map(() => roleThat(writes(authoringFiles()), { proposal: { rationale: 'The Verifier authors phase 1\'s checks before any stage builds.', requested_change_kind: 'unclassifiable' } })));
  fx.scripted.kindScript('verification', script.complete());
  fx.scripted.kindScript('review', { steps: [{ review_auto: { reason: 'The approved specification requires these checks.' } }] });
  fx.scripted.kindScript('phase_verification', roleThat([], { signoffs: [{ scope: 'phase' }] }));
  // The batch's Spec Writer one-shot (D7 §7.1): spec version 2 on its side ref.
  fx.scripted.kindScript('spec_change', roleThat(writes({ '.surety/spec/spec.md': SPEC_V2 }), { changes: SPEC_V2_CHANGES }));
  // The design criteria's checks (D6 §4.5's check_correction).
  fx.scripted.kindScript('check_correction', roleThat(writes(CORRECTION_FILES), { proposal: { rationale: 'The approved design added R2.2, R2.3 and R3.2: their checks.', requested_change_kind: 'tightening' } }));
  fx.scripted.kindScript('fix', assetFixScript());
  fx.scripted.defaultScript(script.complete());
}
// Each stage's Builder of phase `phase`, by its work item (repairs repeat the script).
export function scriptBuilders(fx, project, { dump = [], phase = 1, numbers = STAGES.map((s) => s.number), noDesign = false } = {}) {
  for (const n of numbers) {
    const w = stageWork(fx.home, project, n, phase);
    if (!w) continue;
    fx.scripted.script(w.id, [0, 1, 2].map(() => builderScript(n, { dump: dump.includes(n), noDesign })));
  }
}

// ---- the kernel variants of the reference project (M505, M507, M509) ----------------------------

// The roadmap and phase-1 plan of a variant; the replan writes phase 2's
// plan (prepared against the head, as M5's replan script).
const roadmapOf = (phases) => ({ version: 1, architecture_version: 1, phases: phases.map((ph, i) => ({ number: i + 1, goal: `phase ${i + 1}`, modules: ph.modules, requirement_ids: ph.requirements, depends_on: i === 0 ? [] : [i] })) });
const stage = (n, over = {}) => ({ ...STAGES.find((s) => s.number === n), ...over });
export const VARIANTS = Object.freeze({
  // One phase of three stages (the journey's).
  base: { phases: { R1: 1, R2: 1, R3: 1 }, files: {}, replan: null },
  // Phase 1 the API alone; phase 2 the two UI stages (M505 (h), (j)).
  late: {
    phases: { R1: 1, R2: 2, R3: 2 },
    files: { roadmap: roadmapOf([{ modules: ['api'], requirements: ['R1'] }, { modules: ['web', 'mobile'], requirements: ['R2', 'R3'] }]), stages: [stage(1)] },
    replan: [stage(2, { depends_on: [] }), stage(3, { depends_on: [] })],
  },
  // Phase 1 the API and the web page; phase 2 the Android app (M505 (l)).
  webFirst: {
    phases: { R1: 1, R2: 1, R3: 2 },
    files: { roadmap: roadmapOf([{ modules: ['api', 'web'], requirements: ['R1', 'R2'] }, { modules: ['mobile'], requirements: ['R3'] }]), stages: [stage(1), stage(2)] },
    replan: [stage(3, { depends_on: [] })],
  },
  // No UI stage of android anywhere: R3 built by the API stage (M505 (i)).
  noAndroidStage: {
    phases: { R1: 1, R2: 1, R3: 1 },
    files: { stages: [stage(1, { implements: ['R1', 'R3'], validation: { ...stage(1).validation, criteria: ['R1.1', 'R1.2', 'R3.1'] } }), stage(2)] },
    replan: null,
  },
});
// The variant's specification (its index phases) and Architect files.
export function variantSpec(name) {
  const v = VARIANTS[name];
  return { spec: specTextWith(v.phases), files: v.files };
}
export const specTextWith = (phases) => specText({ requirements: REQUIREMENTS.map((r) => ({ ...r, phase: phases[r.key] ?? r.phase })) });
// The replan of a variant: phase 2's plan.
export function replanScriptFor(name, { spec_version = 1 } = {}) {
  const stages = VARIANTS[name].replan;
  if (!stages) return null;
  const plan = { phase: 2, prepared_against: { spec_version, architecture_version: 1, roadmap_version: 1, revision: '__HEAD__' }, stages, conformance: 'within_baseline' };
  return {
    steps: [
      { write: { path: '.surety/phases/phase-2.json', content: `${JSON.stringify(plan, null, 2)}\n`, substitute_head: true } },
      step.write('.surety/phases/phase-2.md', `# Phase 2\n\n${stages.map((s) => `- Stage ${s.number}: ${s.goal}`).join('\n')}\n`),
      step.result({ status: 'completed', summary: 'phase 2 planned', plan: 'phase-2', conformance: 'within_baseline' }),
    ],
  };
}
// The batch's Spec Writer one-shot for a given version 2.
export const specChangeScriptFor = (v2) => roleThat(writes({ '.surety/spec/spec.md': v2.text }), { changes: v2.changes });

// ---- the Designer's turns of the journey (D7 §1 step 5a) ---------------------------------------

// Turn 1: the design with S1 missing the `empty` state of list-items;
// turn 2: the whole design; turn 3: talk only.
export function journeyDesignerTurns(p, { defect }) {
  return [
    { files: validDesign(p, { omit: [defect] }), say: 'Draw Pantry for the web and Android: one list, add an item.' },
    { files: validDesign(p), say: 'Fix what the engine reported.' },
    { files: {}, say: 'Looks right. We are done.', result: { reply: 'Closing the design.', done: true }, save: false },
  ];
}

// The package a run's launch dumped, with each file's bytes' sha256 and its text: {name: {sha256, text}}.
export function dumpedPackage(fx, run, index = 0) {
  const launch = fx.scripted.launches({ run })[index];
  if (!launch) return null;
  const dump = fx.scripted.probes(launch.invocation, 'context_dump').at(-1);
  if (!dump || dump.outcome !== 'dumped') return null;
  return Object.fromEntries((dump.files ?? []).filter((f) => f.type === 'file').map((f) => [f.name, { sha256: f.sha256 ?? null, text: f.text ?? null, size: f.size }]));
}
