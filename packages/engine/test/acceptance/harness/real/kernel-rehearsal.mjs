// The rehearsal on the kernel lane (M5 slice 38; M442 (b), (c); SEAM.md
// §455): every role played by the package-driven fakes
// (harness/standin/package-fakes.cjs, step `package_fake`) on the scripted
// backend, the owner's acts made through the owner's routes, and the
// rehearsal's judgement of each product against what the whole package
// states.
//
// The judgement (`judge*`): for each element a role's product is read by, a
// predicate over the product given the element's data as the whole package
// states it (taken from the fakes' own logged reads, the union over every
// play: an element omitted from one package is whole in another), naming the
// element when it fails. The engine's own reaction (a save's findings, a
// refused close, a blocked option, the plan check's routing) is read beside
// it by the cases.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runningClassifier, setEngineConfig } from '../checks/classifier.mjs';
import { consume, decision } from '../decisions.mjs';
import { configContent, configure, qualifyByFixture, scriptCall } from '../deploy/kernel.mjs';
import { JOURNEY_POLICY, createWithIdea, journeyContext, waitPublished } from '../journey/drive.mjs';
import { pauseProject, resumeProject, scriptedEngine } from '../runs.mjs';
import { openSession, saveSession, sayAndSettle, scriptTurns } from '../sessions.mjs';
import { step } from '../scripted.mjs';
import { TALLY_ARCHITECTURE, ownerSays, tallyBrief, tallyContent } from './rehearsal-content.mjs';

export const FAKE = Object.freeze({ steps: [step.packageFake()] });
const KINDS = ['check_authoring', 'check_correction', 'stage_build', 'verification', 'review', 'phase_verification', 'replan', 'spec_change', 'fix'];
export const SECRET_REF = 'deploy/ref_secret';

// A scripted engine whose every role is the package-driven fake, the
// classifier `authoritative` (the journey's, SEAM.md §351), a deployment
// secret the environment allows its checks (so `verifier.secrets` has
// something to state).
export async function fakeEngine(t, { content = tallyContent(), config = {} } = {}) {
  const fx = await scriptedEngine(t, { config });
  const version = await runningClassifier(fx.engine);
  setEngineConfig(fx, { classifier_authority: { mode: 'authoritative', version } });
  await fx.engine.kill();
  const secret = join(fx.root, 'ref_secret');
  writeFileSync(secret, `surety-m442-${Date.now().toString(36)}\n`, { mode: 0o600 });
  await fx.start({ args: ['--secret-file', `${SECRET_REF}=${secret}`] });
  fx.scripted.packageFakes(content);
  for (const k of KINDS) fx.scripted.kindScript(k, FAKE);
  fx.scripted.defaultScript(FAKE);
  return fx;
}

// The omission set (SEAM.md §453): replaced whole; [] clears it.
export async function omit(fx, ids) {
  const res = await fx.engine.post('/v1/harness/package-omit', { elements: ids });
  assert.equal(res.status, 200, `POST /v1/harness/package-omit ${JSON.stringify(ids)} (SEAM.md §453) (→ ${res.status} ${res.text})`);
}

// A session whose every turn the fake plays.
export async function fakeSession(fx, project, role) {
  const run = await openSession(fx, project, role);
  scriptTurns(fx, run.id, Array.from({ length: 16 }, () => FAKE));
  return run;
}

// The fakes' plays (the `package_fake` log entries), and the whole data of
// every element they read: the union over the plays.
export const plays = (fx, filter) => fx.scripted.fakePlays(filter);
export function wholeElements(fx) {
  const out = {};
  for (const p of fx.scripted.fakePlays()) for (const [id, v] of Object.entries(p.blocks ?? {})) out[id] ??= v;
  return out;
}
export const lastPlay = (fx, filter) => fx.scripted.fakePlays(filter).at(-1) ?? null;

// ---- the owner's acts on the journey -------------------------------------------------------------

export const SPEC_WORDS = (brief = tallyBrief()) => ownerSays('Write the specification from this.', 'rehearsal-owner', brief);
export const ARCH_WORDS = (arch = TALLY_ARCHITECTURE) => ownerSays('Design it from the approved specification and plan phase 1.', 'rehearsal-architecture', arch);

// A project created with its idea, its specification written by the fake
// and approved by the owner.
export async function specApproved(fx, { policy = JOURNEY_POLICY, brief = tallyBrief() } = {}) {
  const p = await createWithIdea(fx, { policy });
  const run = await fakeSession(fx, p.id, 'spec_writer');
  await sayAndSettle(fx, p.id, run.id, SPEC_WORDS(brief));
  const saved = await saveSession(fx, p.id, run.id);
  const res = await fx.engine.post(`/v1/projects/${p.id}/sessions/${run.id}/close`, {});
  assert.equal(res.status, 200, `the Spec Writer's session closes (→ ${res.status} ${res.text}; the save's findings ${JSON.stringify(saved.findings)})`);
  const approval = (res.body.decisions ?? []).find((d) => d.kind === 'spec_approval');
  assert.ok(approval, `the close raised spec_approval (${res.text})`);
  const answered = await fx.engine.post(`/v1/projects/${p.id}/decisions/${approval.id}/answer`, { option: 'approve', preview_hash: decision(fx.home, approval.id).preview_hash });
  assert.equal(answered.status, 200, `the owner approves the specification the fake wrote (→ ${answered.status} ${answered.text}; the save's findings ${JSON.stringify(saved.findings)})`);
  return { p, run, saved };
}

// The Architect's session played by the fake; the close's answer.
export async function architectTurn(fx, p, { arch = TALLY_ARCHITECTURE } = {}) {
  const run = await fakeSession(fx, p.id, 'architect');
  await sayAndSettle(fx, p.id, run.id, ARCH_WORDS(arch));
  const saved = await saveSession(fx, p.id, run.id);
  const close = await fx.engine.post(`/v1/projects/${p.id}/sessions/${run.id}/close`, {});
  return { run, saved, close };
}

// The first plan published while the project is paused (nothing of it
// dispatched), alpha configured with the check secret, the adapter qualified
// by the labelled fixture, then resumed.
export async function publishedPaused(fx, p, { arch } = {}) {
  const a = await architectTurn(fx, p, { arch });
  assert.equal(a.close.status, 200, `the Architect's session closes with the pair raised (→ ${a.close.status} ${a.close.text})`);
  await pauseProject(fx.engine, p.id);
  for (const d of a.close.body.decisions ?? []) await consume(fx, p.id, decision(fx.home, d.id), 'approve');
  const plan = await waitPublished(fx, p.id);
  assert.ok(plan, 'the first plan is published');
  return { ...a, plan };
}

export async function alphaConfigured(fx, p, { answers = [{ result: 'issued', apply: true }] } = {}) {
  const content = configContent({ start: [process.execPath, 'server.mjs'], port: 8080, secrets: { REF_SECRET: SECRET_REF }, check_secrets: [SECRET_REF] });
  const configured = await configure(fx.engine, p.id, 'alpha', content);
  if (answers) await scriptCall(fx.engine, configured.environment.id, 'deploy', answers);
  await qualifyByFixture(fx.engine, { adapter_version: content.adapter_version });
  return { env: { ...configured.environment, name: 'alpha' }, content };
}

export const resume = (fx, p) => resumeProject(fx.engine, p.id);
export const contextOf = (fx, p, tier = 'T2') => journeyContext(fx, p, { lane: 'kernel', tier });

// ---- the judgement ----------------------------------------------------------------------------

const fail = (out, element, why) => out.push({ element, why });
const sectionLines = (text, n) => {
  const lines = String(text ?? '').split('\n');
  const i = lines.findIndex((l) => new RegExp(`^## ${n}\\.`).test(l));
  if (i < 0) return null;
  const j = lines.findIndex((l, k) => k > i && /^## \d+\./.test(l));
  return lines.slice(i + 1, j < 0 ? undefined : j);
};

// The Spec Writer's specification against the whole Spec Writer package and
// what the owner said (the brief).
export function judgeSpec(text, W, brief) {
  const out = [];
  const t = String(text ?? '');
  const has = (s) => t.includes(s);
  const h = W['spec_writer.header_fields'];
  for (const f of h?.fields ?? []) if (!new RegExp(`^${f.line.replace(/[*.]/g, '\\$&')} \\S`, 'm').test(t)) fail(out, 'spec_writer.header_fields', `no header line ${f.line}`);
  const form = W['spec_writer.requirement_form'];
  for (const r of brief.requirements) {
    if (!new RegExp(`^### ${r.key}\\b`, 'm').test(t)) fail(out, 'spec_writer.requirement_form', `no ${form?.heading ?? '### R<n>'} heading for ${r.key}`);
    for (const c of r.criteria) if (!new RegExp(`^- ${c.id.replace('.', '\\.')} `, 'm').test(t)) fail(out, 'spec_writer.requirement_form', `no criterion item - ${c.id}`);
  }
  const marks = W['spec_writer.marks'];
  for (const r of brief.requirements.filter((x) => x.human_test)) if (!has(marks?.human_test ?? '**Human test.**')) fail(out, 'spec_writer.marks', `${r.key} carries no human-test mark`);
  const q = W['spec_writer.question_form'];
  const s10 = sectionLines(t, 10) ?? [];
  for (const x of brief.questions ?? []) if (!s10.some((l) => l.startsWith(`- ${x.id} `))) fail(out, 'spec_writer.question_form', `${x.id} is not an item of ${q?.section ?? 'section 10'}`);
  const blockers = W['spec_writer.approval_blockers'];
  if ((blockers?.blockers ?? []).some((b) => b.code === 'QUESTION_NO_PHASE_HINT')) for (const x of brief.questions ?? []) if (!s10.some((l) => l.startsWith(`- ${x.id} `) && /\(phase \d+\)\s*$/.test(l))) fail(out, 'spec_writer.approval_blockers', `${x.id} has no phase hint, which blocks approve (QUESTION_NO_PHASE_HINT)`);
  const idx = W['spec_writer.index_columns'];
  if (idx && !has(`| ${idx.columns.join(' | ')} |`)) fail(out, 'spec_writer.index_columns', 'no index table in its columns');
  const mt = W['spec_writer.module_table'];
  if (mt && !has(`| ${mt.columns.join(' | ')} |`)) fail(out, 'spec_writer.module_table', 'no module table in its columns');
  const ef = W['spec_writer.environment_fields'];
  for (const e of brief.environments ?? []) {
    if (!new RegExp(`^### ${e.name}\\s*$`, 'm').test(t)) fail(out, 'spec_writer.environment_fields', `no subsection for ${e.name}`);
    for (const f of ef?.fields ?? []) if (!has(`- **${f}:**`)) fail(out, 'spec_writer.environment_fields', `no field ${f}`);
  }
  const areas = W['spec_writer.sensitive_areas'];
  if (areas) {
    const allowed = new Set([...(areas.areas ?? []).map((a) => a.id), areas.none]);
    for (const m of t.matchAll(/^\*\*Sensitive areas:\*\*\s*(.*)$/gm)) for (const a of m[1].split(',').map((s) => s.trim()).filter(Boolean)) if (!allowed.has(a)) fail(out, 'spec_writer.sensitive_areas', `"${a}" is not in the closed list`);
  }
  const tiers = W['spec_writer.tier_table'];
  const tier = /^\*\*Tier:\*\*\s*(.*)$/m.exec(t)?.[1]?.trim();
  if (tiers && tier !== undefined && !(tiers.tiers ?? []).some((x) => x.tier === tier)) fail(out, 'spec_writer.tier_table', `the tier "${tier}" is not one of ${(tiers.tiers ?? []).map((x) => x.tier).join(', ')}`);
  const ct = W['spec_writer.claims_table'];
  if (ct && (brief.claims ?? []).length > 0 && !has(`| ${ct.columns.join(' | ')} |`)) fail(out, 'spec_writer.claims_table', 'no claims table in its columns');
  return out;
}

const parsed = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

// The Architect's files (a session's or a replan's) against the whole
// Architect package.
export function judgeArchitect(written, W, { tier = 'T2', adrs = [], routing = null } = {}) {
  const out = [];
  for (const id of ['architect.schema.modules', 'architect.schema.roadmap']) {
    if (!(id in W) || routing === 'replan') continue;
    const d = W[id];
    const v = parsed(written[d.file]);
    if (!v) fail(out, id, `${d.file} not written`);
    else for (const k of d.schema?.required ?? []) if (!(k in v)) fail(out, id, `${d.file} lacks ${k}`);
  }
  const pp = W['architect.schema.phase_plan'];
  const planPath = Object.keys(written).find((p) => /^\.surety\/phases\/phase-\d+\.json$/.test(p));
  const plan = planPath ? parsed(written[planPath]) : null;
  if (pp && !plan) fail(out, 'architect.schema.phase_plan', 'no phase plan written');
  const adr = W['architect.schema.adr'];
  if (adr && routing !== 'replan') for (const k of adrs) if (!(String(adr.file).replace('ADR-<nnn>', k) in written)) fail(out, 'architect.schema.adr', `${k} not written`);
  const reasons = W['architect.plan_reasons'];
  if (plan && reasons) for (const s of plan.stages ?? []) for (const k of reasons.kinds_by_tier?.[tier] ?? []) if (!(s.validation?.kinds ?? []).includes(k)) fail(out, 'architect.plan_reasons', `stage ${s.number} does not validate the kind ${k} its tier needs (PLAN_KIND_MISSING)`);
  if (plan && W['architect.routing'] && plan.conformance !== 'within_baseline') fail(out, 'architect.routing', `the plan declares ${plan.conformance}: routing is computed from the artifacts, and a plan that changes none is within its baseline`);
  return out;
}

// A phase authoring's product against the whole Verifier package: the
// definitions written (path → JSON), its result.
export function judgeAuthoring(written, result, W, { first = true, environments = [], retrofit = false } = {}) {
  const out = [];
  const defs = Object.entries(written).filter(([p]) => /\/defs\/[^/]+\.json$/.test(p)).map(([, t]) => parsed(t)).filter(Boolean);
  if (defs.length === 0) fail(out, 'verifier.kinds', 'no definition written');
  const kinds = W['verifier.kinds'];
  for (const d of defs) if (kinds && !(kinds.kinds ?? []).includes(d.kind)) fail(out, 'verifier.kinds', `${d.key} has no kind the engine knows (${d.kind})`);
  const floor = W['verifier.gate_kinds_floor'];
  if (floor && first) {
    for (const k of floor.floor ?? []) {
      const of = defs.filter((d) => d.kind === k);
      if (of.length === 0) fail(out, 'verifier.gate_kinds_floor', `no check of the floor kind ${k}`);
      else if (!of.some((d) => (floor.gate_kinds ?? []).every((g) => (d.gate_kinds ?? []).includes(g)))) fail(out, 'verifier.gate_kinds_floor', `no ${k} check lists ${floor.gate_kinds.join(' and ')} (E135)`);
    }
  }
  const cv = W['verifier.covers'];
  for (const d of defs) if (cv && (cv.criteria_kinds ?? []).includes(d.kind) && !(d[cv.member]?.[cv.criteria]?.length > 0)) fail(out, 'verifier.covers', `${d.key}, of a covering kind, names no criterion in covers.criteria`);
  const pd = W['verifier.post_deploy'];
  const post = defs.filter((d) => (pd?.kinds ?? []).includes(d.kind) || /post_deploy/.test(d.kind ?? ''));
  const targeted = (pd?.environments ?? []).some((e) => Array.isArray(e?.targets) && e.targets.length > 0);
  if (pd && first && targeted && !post.some((d) => d.kind === pd.required && (d.gate_kinds ?? []).includes(pd.gate_kind))) fail(out, 'verifier.post_deploy', `no ${pd.required} check listing ${pd.gate_kind}`);
  const rq = W['verifier.requires'];
  for (const d of post) if (rq && !(rq.values ?? []).every((v) => (d[rq.member] ?? []).includes(v))) fail(out, 'verifier.requires', `${d.key} does not require ${rq.values.join(', ')}`);
  const sc = W['verifier.secrets'];
  const allowed = [...new Set((sc?.environments ?? []).filter((e) => Array.isArray(e?.check_secrets)).flatMap((e) => e.check_secrets))];
  for (const d of post) if (sc && allowed.length > 0 && !allowed.every((r) => (d[sc.member] ?? []).includes(r))) fail(out, 'verifier.secrets', `${d.key} names none of the secrets its environment allows its checks (${allowed.join(', ')})`);
  const tc = W['verifier.toolchain'];
  if (tc && first) {
    const g = parsed(written[tc.file]);
    const names = (tc.runtimes ?? []).map((r) => r.name);
    if (!g) fail(out, 'verifier.toolchain', `${tc.file} not written: the first phase names its toolchain`);
    else if (!Object.keys(g.check_commands ?? {}).some((n) => names.includes(n) && (tc.runtimes ?? []).some((r) => r.name === n && g.check_commands[n]?.path === r.path))) fail(out, 'verifier.toolchain', `the governed file names none of the runtimes the package offers (${names.join(', ')})`);
  }
  const ar = W['verifier.authoring_result'];
  if (ar && first && !(result?.governed_changes?.check_commands === true)) fail(out, 'verifier.authoring_result', 'the first phase\'s result declares no governed_changes.check_commands');
  const ad = W['verifier.adoption_rule'];
  if (ad && retrofit && !(Array.isArray(result?.adopted_tests) && result.adopted_tests.length > 0 && result.adopted_tests.every((x) => Array.isArray(x.dependency_boundary)))) fail(out, 'verifier.adoption_rule', 'no adopted_tests with their dependency boundary in the result');
  return out;
}

// A Builder's product against the whole Builder package for its stage.
export function judgeBuilder(written, result, W) {
  const out = [];
  const tasks = W['builder.tasks'];
  const named = [...new Set((tasks?.tasks ?? []).flatMap((t) => [...String(t).matchAll(/`([^`]+)`/g)].map((m) => m[1])))];
  for (const p of named) if (!(p in written)) fail(out, 'builder.tasks', `${p}, which a task names, not written`);
  const impl = W['builder.implements'];
  if (impl && (impl.implements ?? []).length > 0 && Object.keys(written).length === 0) fail(out, 'builder.implements', `nothing written for ${impl.implements.join(', ')}`);
  for (const [p, text] of Object.entries(written)) if (/MISSING-DEPENDENCY-/.test(text)) fail(out, 'builder.dependency_interfaces', `${p} imports a dependency whose interface it was not given`);
  const ob = W['builder.integration_obligations'];
  for (const o of ob?.integration_obligations ?? []) if (!String(result?.summary ?? '').includes(o)) fail(out, 'builder.integration_obligations', `the result does not account for the obligation "${o}"`);
  return out;
}

export const named = (failures) => [...new Set(failures.map((f) => f.element))];
