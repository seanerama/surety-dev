// The UI Builder's package (D7 §8.4, §6.5; E151; `339e116`; SEAM.md §482):
// a UI stage's `stage_build` (and an `asset_updated` fix) is given the
// approved design version's neutral tokens, `tokens.css` where its
// technology is `html_css` or `three_js`, its targets' screens and
// navigation, the mockups and fixtures those screens name (read-only, as
// reference, each simulation labelled), the effective asset set with each
// file's slot@version and source and any Architect-declared path, and its
// design criteria; and the plain statement that the Builder implements the
// design in source, writes nothing under `.surety/`, and returns a binding
// for every file it places. A backend stage's package carries none of it.
// The approved revision's files only, never a newer checkpoint's (§3.1).

import type Database from 'better-sqlite3';

import { parseJson } from '../store/transitions/common.js';
import type { Runtime } from '../runtime.js';
import { tokensCss } from './bindings-css.js';
import { approvedModuleMap, publishedStages, stageModuleNames, stageRequirementKeys } from './policy.js';
import { blobAt } from './tree.js';
import { DESIGN_ROOT } from './inventory.js';
import { observationsFor } from './review-driver.js';
import type { ReviewPackageFacts } from './review-package.js';
import { SCREENSHOT_FORMATS } from './evidence.js';
import { repoContext } from '../git/exec.js';
import { listTree, treeOf } from '../git/repo.js';
import { recordsDir } from '../records/files.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSafeRelative, isSlug } from './paths.js';

export interface DesignPackageFacts {
  // The approved design revision's commit and the files the package reads of it.
  revision: string;
  repo: string;
  technologies: string[];
  targets: string[];
  screens: Record<string, unknown>[];
  navigation: Record<string, unknown>[];
  mockups: { path: string; kind: string; target: string; screens: string[]; simulation: boolean }[];
  fixtures: string[];
  effective: { slot: string; variant: string; slot_version: number; source: string; digest: string; format: string; revision: string; file: string; declared_path?: string }[];
  criteria: { id: string; kind: string; targets: string[]; paths?: string[]; slot?: string; variant?: string }[];
  // An asset_updated fix: what it is to update.
  asset_update?: Record<string, unknown> | null;
}

export interface DesignPackage {
  files: { path: string; content: Buffer }[];
  prompt: string[];
}

const BUILDER_DESIGN_TEXT = [
  'This stage builds a user interface to an approved design (D7 §8.4). /surety/context/design/ holds it, read-only, as reference:',
  '- `design/tokens.json`: the design tokens (neutral, logical units); `design/tokens.css` the CSS binding where your technology is HTML and CSS.',
  "- `design/screens.json` and `design/navigation.json`: your targets' screens with their states, layouts, inputs and conventions, and each target's navigation.",
  '- `design/mockups.json` lists the mockups; each `simulation` mockup is a drawing of a native screen in HTML, never the native behaviour.',
  '- `design/effective-assets.json`: the effective asset set, each file with its `slot@version` and source (approved, or the engine placeholder), under `design/assets/`; `declared_path` is where the Architect says it goes.',
  '- `design/criteria.json`: the design criteria your requirements carry, by their specification ids.',
  '',
  'You implement the design in source. You write nothing under `.surety/`: the design is not yours to change.',
  'Copy each effective asset file you place to the source path your stage needs, and return `asset_bindings` in your result, one for every file you placed: `{slot, variant, target, path, form}`, `form` `copy` (the file at `path` is the effective file byte for byte) or `derived` (made from it).',
];

// What the package of `run` reads of the design, or null when it carries none.
export function designPackageFacts(db: Database.Database, args: { run: string }): DesignPackageFacts | null {
  const run = db.prepare('SELECT r."project", r."role", w."kind", w."subject" FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."id" = ?').get(args.run) as
    | { project: string; role: string; kind: string; subject: string }
    | undefined;
  if (!run || run.role !== 'builder') return null;
  const subject = parseJson<{ stage?: string; cause?: string }>(run.subject) ?? {};
  const fix = run.kind === 'fix' && subject.cause === 'asset_updated';
  if (run.kind !== 'stage_build' && !fix) return null;
  const rev = db
    .prepare(`SELECT "id", "revision", "content" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`)
    .get(run.project) as { id: string; revision: string; content: string | null } | undefined;
  if (!rev) return null;
  const map = approvedModuleMap(db, run.project)?.map ?? null;
  const content = parseJson<{ design?: { mockups?: Record<string, unknown>[] }; screens?: { screens?: Record<string, unknown>[] }; navigation?: { targets?: Record<string, unknown>[] }; criteria?: { criteria?: Record<string, unknown>[] } }>(rev.content) ?? {};
  let modules: string[] = [];
  let requirementKeys: string[] = [];
  if (!fix) {
    const stage = publishedStages(db, run.project).find((s) => s.id === subject.stage) ?? (db.prepare('SELECT "id", "modules", "implements" FROM "stages" WHERE "id" = ?').get(subject.stage ?? '') as { id: string; modules: string; implements: string } | undefined);
    if (!stage) return null;
    modules = stageModuleNames(db, run.project, stage.modules);
    requirementKeys = stageRequirementKeys(db, run.project, stage.implements);
  }
  const ui = (map?.modules ?? []).filter((m) => m.surface === 'ui' && (fix || modules.includes(m.name)));
  if (ui.length === 0) return null;
  const targets = [...new Set(ui.flatMap((m) => (m.targets ?? []).map((t) => t.target)))];
  const technologies = [...new Set(ui.flatMap((m) => (m.targets ?? []).map((t) => t.ui_technology)))];
  const screens = fix ? [] : (content.screens?.screens ?? []).filter((s) => targets.includes(String(s.target)));
  const keys = new Set(screens.map((s) => String(s.key)));
  const navigation = fix ? [] : (content.navigation?.targets ?? []).filter((t) => targets.includes(String(t.target)));
  const mockups = (content.design?.mockups ?? [])
    .filter((m) => Array.isArray(m.screens) && (m.screens as string[]).some((k) => keys.has(k)))
    .map((m) => ({ path: String(m.path), kind: String(m.kind), target: String(screens.find((s) => (m.screens as string[]).includes(String(s.key)))?.target ?? ''), screens: (m.screens as string[]).filter((k) => keys.has(k)), simulation: m.kind === 'simulated_html' }));
  const fixtures = [...new Set(screens.flatMap((s) => (Array.isArray(s.states) ? (s.states as Record<string, unknown>[]) : []).map((st) => st.fixture).filter((f): f is string => typeof f === 'string')))];
  const declared = ui.flatMap((m) => m.asset_paths ?? []);
  const effective = (
    db.prepare('SELECT "slot", "variant", "slot_version", "source", "digest", "format", "revision", "file", "platforms" FROM "design_effective_assets" WHERE "project" = ? ORDER BY "slot", "variant"').all(run.project) as {
      slot: string;
      variant: string;
      slot_version: number;
      source: string;
      digest: string;
      format: string;
      revision: string;
      file: string;
      platforms: string;
    }[]
  )
    .filter((e) => (fix ? e.slot === (subject as { slot?: string }).slot : (parseJson<string[]>(e.platforms) ?? []).some((p) => targets.includes(p))))
    .map((e) => {
      const d = declared.find((a) => a.slot === e.slot && a.variant === e.variant && targets.includes(a.target));
      return { slot: e.slot, variant: e.variant, slot_version: e.slot_version, source: e.source, digest: e.digest, format: e.format, revision: e.revision, file: e.file, ...(d ? { declared_path: d.path } : {}) };
    });
  // The design criteria the stage's requirements carry, by their spec ids:
  // each criterion of criteria.json under one of them, matched by its text.
  const reqs = db.prepare('SELECT "key", "criteria_text" FROM "requirements" WHERE "project" = ?').all(run.project) as { key: string; criteria_text: string | null }[];
  const criteria: DesignPackageFacts['criteria'] = [];
  for (const c of content.criteria?.criteria ?? []) {
    const req = String(c.requirement);
    if (fix || !requirementKeys.includes(req)) continue;
    const texts = parseJson<{ id: string; text: string }[]>(reqs.find((r) => r.key === req)?.criteria_text ?? null) ?? [];
    const match = texts.find((t) => t.text.trim() === String(c.text).trim());
    if (!match) continue;
    criteria.push({
      id: match.id,
      kind: String(c.kind),
      targets: Array.isArray(c.targets) ? (c.targets as string[]) : [],
      ...(Array.isArray(c.paths) ? { paths: c.paths as string[] } : {}),
      ...(typeof c.slot === 'string' ? { slot: c.slot } : {}),
      ...(typeof c.variant === 'string' ? { variant: c.variant } : {}),
    });
  }
  const repo = (db.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(run.project) as { dev_repo_path: string }).dev_repo_path;
  return { revision: rev.revision, repo, technologies, targets, screens, navigation, mockups, fixtures, effective, criteria, ...(fix ? { asset_update: subject as Record<string, unknown> } : {}) };
}

const REVIEW_TEXT = [
  'This is a review of the deployed build against the approved design (D7 §10). /surety/context/design/ holds, read-only:',
  "- `design/review.json`: the review's subject (the Alpha's candidate and its deployment), the approved design revision, and whether this review draws the first design (`first_design: true`: none is approved, so you draw it from what is observed and what the owner asks for, `origin: observed`).",
  "- `design/approved/`: the approved design tree, if there is one; `design/source/`: the candidate's UI source; `design/check-results.json`: the latest result, on the candidate, of each check covering a design criterion.",
  '- `design/observations.json`: what the engine observed: for each web screen with a route, the HTTP response the engine fetched from the running service (`provenance: engine_observed`, its `record` and its `evidence` id), its bytes under `design/observations/<evidence id>`; every native screen is listed under `not_observed` (`no_native_runtime`): nothing here runs it. The owner browses the web Alpha himself through his relay and tells you what he sees.',
  "Write your review to `.surety/design/reviews/review-<n>.json` (B.14): per screen a verdict (`matches`, `deltas` or `not_observed` with its reason), `observed_on`, the evidence ids it rests on (only ids this review holds), and the deltas, each with the owner's words and whether it is a `design` change, an `implementation` defect, or `both`. Never a `status`: your verdicts are proposals; the owner confirms them. If the owner agrees a design change, revise the design in the same tree and say `revised_design: true`.",
];

const OWNER_REVIEW_TEXT = [
  'This is a review of a build the owner names (D7 §10.5), not of a deployment: /surety/context/design/review.json holds its subject (the target and the build as he named it, and the candidate if he named one: his word, never verified). The engine observed nothing of it and runs nothing of it; what you know of it is what the owner tells you in this session and the evidence he supplied.',
  "`design/evidence.json` lists his evidence, each `owner_supplied`, by its name: a screenshot's bytes are at its `file`; a recording is named only, never given to you.",
  'Write your review to `.surety/design/reviews/review-<n>.json` (B.14): per screen of that target a verdict (`matches`, `deltas` or `not_observed` with its reason), `observed_on` as the owner says he saw it (`device`, `emulator`, `simulator` or `simulation`), the evidence ids it rests on, and the deltas. A verdict on a simulation is never evidence about the native build. Never a `status`: your verdicts are proposals; the owner confirms them.',
];

const RETROFIT_TEXT = [
  '## Retrofit mode: capture the design of the adopted UI as observed (D7 §12)',
  '',
  'This project was adopted from an existing repository with a user interface. Its UI source is your input, read-only, under /surety/context/design/source/. Describe before you prescribe: write the design as the code shows it, `origin: observed` in design.json.',
  '- Tokens extracted from the existing stylesheets or theme files; a screen inventory and navigation graph of the existing routes, mapped to the confirmed requirements; for web, mockups that are copies of the existing pages as static files.',
  '- Conventions as the code shows them; where the code cannot tell you, write `unknown` (the design check reports it, DESIGN_CONVENTION_UNKNOWN). An interface the inventory lists with `shape_known: false` has no shape: never invent one (DESIGN_INTERFACE_SHAPE_UNKNOWN on every screen that uses it).',
  "- An existing logo, icon or banner becomes a slot with provenance `observed`, status `proposed`; default slots with no file keep the engine's placeholders.",
  '- Proposed criteria go through the consolidated specification change; they are scheduled to the first change phase, never to the conformance set.',
];

const SOURCE_FILES_MAX = 2000;
const SOURCE_BYTES_MAX = 16 * 1024 * 1024;

// A record's stored bytes (redacted at write), or null.
async function readRecordBytes(rt: Runtime, record: string): Promise<Buffer | null> {
  const row = await rt.read<{ path: string | null; published: number } | null>('record.row', { record });
  if (!row || row.published !== 1 || row.path === null || !/^[A-Za-z0-9_]+$/.test(row.path)) return null;
  try {
    return await readFile(join(recordsDir(rt.home), row.path));
  } catch {
    return null;
  }
}

// The design files of a review-mode or retrofit-mode Designer session's
// package (D7 §3.4, §10.2, §10.5, §12; SEAM.md §§489, 523, 528).
async function reviewPackage(rt: Runtime, project: string, run: string): Promise<DesignPackage | null> {
  const f = await rt.read<ReviewPackageFacts | null>('design.review_package_facts', { run });
  if (!f) return null;
  const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);
  const files: DesignPackage['files'] = [];
  const prompt: string[] = [];
  if (f.mode === 'review') {
    files.push({ path: 'design/review.json', content: json({ subject: f.review.subject, design_revision: f.review.design_revision, first_design: f.review.first_design }) });
  }
  // The approved design, byte for byte.
  if (f.approved) {
    for (const p of f.approved.paths) {
      if (!isSafeRelative(p)) continue;
      const b = await blobAt(f.repo, f.approved.revision, `${DESIGN_ROOT}${p}`);
      if (b) files.push({ path: `design/approved/${p}`, content: b });
    }
  }
  // The UI source, read-only: every file under the ui modules' paths.
  const omitted: string[] = [];
  if (f.source) {
    const ctx = repoContext(f.repo);
    const tree = await treeOf(ctx, f.source.revision);
    const entries = tree === null ? null : await listTree(ctx, tree);
    let total = 0;
    let count = 0;
    for (const e of [...(entries?.values() ?? [])].sort((a, b) => a.path.localeCompare(b.path))) {
      if (e.type !== 'blob' || !f.source.paths.some((m) => e.path === m || e.path.startsWith(m.endsWith('/') ? m : `${m}/`)) || !isSafeRelative(e.path)) continue;
      if (count >= SOURCE_FILES_MAX || total >= SOURCE_BYTES_MAX) {
        omitted.push(e.path);
        continue;
      }
      const b = await blobAt(f.repo, f.source.revision, e.path);
      if (!b) continue;
      total += b.length;
      count += 1;
      files.push({ path: `design/source/${e.path}`, content: b });
    }
  }
  const left = omitted.length > 0 ? ['', `Left out of design/source/ (past the package's bounds): ${omitted.length} file(s), the first ${omitted.slice(0, 20).join(', ')}.`] : [];
  if (f.mode === 'retrofit') {
    prompt.push('', ...RETROFIT_TEXT, ...left);
    return { files, prompt };
  }
  files.push({ path: 'design/check-results.json', content: json(f.check_results) });
  if (f.review.owner) {
    const listed: Record<string, unknown>[] = [];
    for (const e of f.evidence) {
      const entry: Record<string, unknown> = { id: e.id, provenance: e.provenance, format: e.format, target: e.target, build_ref: e.build_ref, observed_on: e.observed_on, name: e.name };
      // Screenshots as images; recordings by name only (D7 §10.5).
      if (e.format !== null && SCREENSHOT_FORMATS.includes(e.format) && e.record) {
        const bytes = await readRecordBytes(rt, e.record);
        if (bytes) {
          const path = `design/evidence/${e.id}.${e.format === 'jpeg' ? 'jpg' : e.format}`;
          files.push({ path, content: bytes });
          entry.file = path;
        }
      }
      listed.push(entry);
    }
    files.push({ path: 'design/evidence.json', content: json({ evidence: listed }) });
    prompt.push('', '## The review', '', ...OWNER_REVIEW_TEXT, ...left);
    return { files, prompt };
  }
  const o = await observationsFor(rt, project, run);
  files.push({ path: 'design/observations.json', content: json({ observations: o.observations, not_observed: o.not_observed, ...(o.unobservable ? { unobservable: o.unobservable } : {}) }) });
  for (const ob of o.observations) {
    if (!ob.record) continue;
    const bytes = await readRecordBytes(rt, ob.record);
    if (bytes) files.push({ path: `design/observations/${ob.evidence}`, content: bytes });
  }
  prompt.push('', '## The review', '', ...REVIEW_TEXT, ...left);
  return { files, prompt };
}

// The package's design files, read from git (main thread).
export async function designPackageFor(rt: Runtime, run: string): Promise<DesignPackage | null> {
  const who = await rt.read<{ project: string; role: string; mode: string | null } | null>('design.run_facts', { run });
  if (who?.role === 'designer') return reviewPackage(rt, who.project, run);
  const f = await rt.read<DesignPackageFacts | null>('design.package_facts', { run });
  if (!f) return null;
  // What this package carries of the effective set, recorded for the
  // validation of the run's bindings at integration (m4).
  await rt.engine('design.record_carried', { run, effective: f.effective.map((e) => ({ slot: e.slot, variant: e.variant, slot_version: e.slot_version, digest: e.digest })) });
  const files: DesignPackage['files'] = [];
  const at = async (path: string): Promise<Buffer | null> => blobAt(f.repo, f.revision, `${DESIGN_ROOT}${path}`);
  const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);
  if (!f.asset_update) {
    const tokens = await at('tokens.json');
    if (tokens) {
      files.push({ path: 'design/tokens.json', content: tokens });
      if (f.technologies.some((t) => t === 'html_css' || t === 'three_js')) {
        try {
          files.push({ path: 'design/tokens.css', content: Buffer.from(tokensCss(JSON.parse(tokens.toString('utf8')))) });
        } catch {
          // A tokens file that does not parse gives no binding.
        }
      }
    }
    files.push({ path: 'design/screens.json', content: json({ screens: f.screens }) });
    files.push({ path: 'design/navigation.json', content: json({ targets: f.navigation }) });
    files.push({ path: 'design/mockups.json', content: json(f.mockups) });
    for (const p of [...f.mockups.map((m) => m.path), ...f.fixtures]) {
      // A Designer-written path: only a safe relative one is read and placed.
      if (!isSafeRelative(p)) continue;
      const b = await at(p);
      if (b) files.push({ path: `design/${p}`, content: b });
    }
    files.push({ path: 'design/criteria.json', content: json({ criteria: f.criteria }) });
  }
  const listed: Record<string, unknown>[] = [];
  for (const e of f.effective) {
    // Slot, variant and format are slugs (the design check refuses any
    // other slot key): anything else is left out, never written.
    if (!isSlug(e.slot) || !isSlug(e.variant) || !isSlug(e.format)) continue;
    const path = `design/assets/${e.slot}/${e.variant}.${e.format}`;
    const b = await blobAt(f.repo, e.revision, `${DESIGN_ROOT}${e.file}`);
    if (b) files.push({ path, content: b });
    listed.push({ slot: e.slot, variant: e.variant, slot_version: e.slot_version, source: e.source, digest: e.digest, format: e.format, path, ...(e.declared_path ? { declared_path: e.declared_path } : {}) });
  }
  files.push({ path: 'design/effective-assets.json', content: json(listed) });
  const prompt = ['', '## The design', '', ...BUILDER_DESIGN_TEXT];
  if (f.asset_update) {
    const u = f.asset_update;
    prompt.push('', `This fix updates the asset slot ${String(u.slot)} from ${String(u.from_version)} to ${String(u.to_version)} (D7 §6.5): place the new effective file at every bound path below (re-deriving a derived one) and return the bindings anew.`, ...((u.bindings as { path: string; form: string; target: string }[] | undefined) ?? []).map((b) => `- \`${b.path}\` (${b.target}, ${b.form})`));
  }
  return { files, prompt };
}
