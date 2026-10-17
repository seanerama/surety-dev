// The release-policy hook (D7 §6.7; G10; Q8; SEAM.md §509): for D5's
// authorization of a Beta or a Live, one condition: every selected slot whose
// platforms include a deployed target has an effective version whose source
// is `approved` (`ASSETS_NOT_APPROVED`, naming the slots). It applies at the
// tier `assets_required_for` names and every later one (`none` requires
// nothing; `beta` Beta and Live; `live` Live). Its range excludes Alpha by
// construction: there is no Alpha tier to ask about.
//
// Inert until D5: no production gate calls it. `alpha_authorize`,
// `design_ready`, dispatch and every D6 gate never read an asset's status.
// Its callers are the test seam and `GET …/design`'s count; the seam keeps
// every evaluation in order so that a test can count who evaluated it.

import type Database from 'better-sqlite3';

import { Refusal } from '../refusal.js';
import { parseJson } from '../store/transitions/common.js';
import { projectEffective } from '../store/transitions/settings.js';
import type { AssetManifest } from './assets.js';
import { type PlaceholderRecord, currentInventory, laterDefaults } from './store.js';

export const RELEASE_TIERS = ['beta', 'live'] as const;
export const ASSETS_REQUIRED_FOR = ['none', 'beta', 'live'] as const;
export type ReleaseTier = (typeof RELEASE_TIERS)[number];
// Who evaluated it: `design_view` here; the seam names its own caller.
export type HookCaller = string;

export interface HookEvaluation {
  caller: HookCaller;
  project: string;
  tier?: ReleaseTier;
}

// Who keeps the evaluations: nobody in production (nothing would read them,
// and a list kept for every read would only grow); the seam installs its
// own recorder in the store worker (SEAM.md §509).
let recorder: ((e: HookEvaluation) => void) | null = null;
export function recordHookEvaluationsWith(fn: ((e: HookEvaluation) => void) | null): void {
  recorder = fn;
}
const record = (e: HookEvaluation): void => recorder?.(e);

// The selected slots and their selected variants with their platforms (D7
// §5.8, §6.2): the current approved revision's manifest under its
// selection; before any approval, every default slot and variant of the
// inventory's placeholder record. A default kind the selection leaves out is
// not selected; a kind the design adds is its own; a default slot or variant
// a later target added (one the approved manifest could not have selected)
// is selected (S3). A default slot's platforms include the derivation's.
export function selectedSlots(db: Database.Database, project: string): { key: string; variants: string[]; platforms: string[] }[] {
  const inv = currentInventory(db, project);
  const record = parseJson<PlaceholderRecord>(inv?.row.manifest ?? null);
  const invSlots = record?.slots ?? [];
  const rev = db.prepare(`SELECT "selection", "asset_manifest" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(project) as
    | { selection: string | null; asset_manifest: string | null }
    | undefined;
  if (!rev) return invSlots.map((s) => ({ key: s.key, variants: s.variants.map((v) => v.name), platforms: [...s.platforms] }));
  const selection = parseJson<{ slots?: { kind: string; variants: string[] }[] }>(rev.selection);
  const defaults = new Set(invSlots.map((s) => s.kind));
  const manifest = parseJson<AssetManifest>(rev.asset_manifest);
  const out = new Map<string, { key: string; variants: string[]; platforms: string[] }>();
  for (const s of manifest?.slots ?? []) {
    const chosen = selection?.slots?.find((x) => x.kind === s.kind);
    const variants = chosen ? s.variants.map((v) => v.name).filter((n) => chosen.variants.includes(n)) : Array.isArray(selection?.slots) && defaults.has(s.kind) ? [] : s.variants.map((v) => v.name);
    const derived = invSlots.find((x) => x.key === s.key)?.platforms ?? [];
    out.set(s.key, { key: s.key, variants, platforms: [...new Set([...s.platforms, ...derived])] });
  }
  for (const { slot, variant } of laterDefaults(manifest, record)) {
    const has = out.get(slot.key) ?? { key: slot.key, variants: [], platforms: [...slot.platforms] };
    if (!has.variants.includes(variant)) has.variants.push(variant);
    has.platforms = [...new Set([...has.platforms, ...slot.platforms])];
    out.set(slot.key, has);
  }
  return [...out.values()].filter((s) => s.variants.length > 0);
}

// The selected slots of `targets` (every target when null) one of whose
// selected variants has no effective version from an approval.
export function slotsNotApproved(db: Database.Database, project: string, targets: string[] | null): string[] {
  const effective = db.prepare(`SELECT "slot", "variant" FROM "design_effective_assets" WHERE "project" = ? AND "source" = 'approved'`).all(project) as { slot: string; variant: string }[];
  return selectedSlots(db, project)
    .filter((s) => targets === null || s.platforms.some((p) => targets.includes(p)))
    .filter((s) => !s.variants.every((v) => effective.some((e) => e.slot === s.key && e.variant === v)))
    .map((s) => s.key)
    .sort();
}

// The project's `assets_required_for` (S3): the effective policy's value,
// unless the recorded policy holds a value outside the range, which the
// effective read would replace with the default: that is unknown, returned
// as recorded so that the caller refuses it rather than assume `live`.
function assetsRequiredFor(db: Database.Database, project: string): unknown {
  const row = db.prepare('SELECT r."effective" FROM "projects" p JOIN "policy_revisions" r ON r."id" = p."policy_revision" WHERE p."id" = ?').get(project) as { effective: string } | undefined;
  const recorded = row ? (parseJson<Record<string, unknown>>(row.effective) ?? null) : undefined;
  if (row && recorded === null) return undefined;
  if (recorded && Object.hasOwn(recorded, 'assets_required_for') && !(ASSETS_REQUIRED_FOR as readonly unknown[]).includes(recorded.assets_required_for)) return recorded.assets_required_for ?? null;
  return (projectEffective(db, project) as Record<string, unknown>).assets_required_for;
}

// D7 §6.7's condition for a tier's authorization, evaluated and counted.
export function evaluateReleaseHook(
  db: Database.Database,
  args: { project: string; tier: unknown; public?: unknown; targets?: unknown },
  caller: HookCaller,
): { tier: ReleaseTier; policy: string; outcome: 'met' | 'not_met'; reasons: { code: 'ASSETS_NOT_APPROVED'; subjects: string[] }[] } {
  if (!(RELEASE_TIERS as readonly unknown[]).includes(args.tier)) {
    throw new Refusal(400, 'invalid_value', `"tier" must be beta or live: the hook's range excludes Alpha (D7 §6.7).`, 'Ask about a Beta or a Live.', { field: 'tier', value: args.tier ?? null });
  }
  if (args.public !== undefined && typeof args.public !== 'boolean') throw new Refusal(400, 'invalid_value', '"public" must be a boolean.', 'Send true or false, or leave it out.', { field: 'public' });
  if (args.targets !== undefined && !(Array.isArray(args.targets) && args.targets.every((t) => typeof t === 'string'))) {
    throw new Refusal(400, 'invalid_value', '"targets" must be a list of targets.', 'Name the deployed targets, or leave it out for every target of the inventory.', { field: 'targets' });
  }
  if (!db.prepare('SELECT 1 FROM "projects" WHERE "id" = ?').get(args.project)) throw new Refusal(404, 'not_found', `No project ${String(args.project)}.`, 'Name a project of this engine.', { project: args.project ?? null });
  const tier = args.tier as ReleaseTier;
  record({ caller, project: args.project, tier });
  // A policy the engine cannot read, or a value outside the range, is
  // unknown: the hook answers nothing rather than `met` (S3).
  const policy = assetsRequiredFor(db, args.project);
  if (typeof policy !== 'string' || !(ASSETS_REQUIRED_FOR as readonly string[]).includes(policy)) {
    throw new Refusal(409, 'policy_unknown', `The project's assets_required_for is ${policy === undefined ? 'not readable' : `not one of ${ASSETS_REQUIRED_FOR.join(', ')} (${JSON.stringify(policy)})`}: the release condition is unknown.`, 'Set assets_required_for to none, beta or live.', {
      key: 'assets_required_for',
      value: policy ?? null,
    });
  }
  // `none` requires nothing; `beta` from Beta on; `live` Live alone.
  const applies = policy === 'beta' || (policy === 'live' && tier === 'live');
  const inventoryTargets = [...new Set((currentInventory(db, args.project)?.inventory.targets ?? []).map((t) => t.target))];
  const deployed = Array.isArray(args.targets) ? (args.targets as string[]) : inventoryTargets;
  const subjects = applies ? slotsNotApproved(db, args.project, deployed) : [];
  return { tier, policy, outcome: subjects.length > 0 ? 'not_met' : 'met', reasons: subjects.length > 0 ? [{ code: 'ASSETS_NOT_APPROVED', subjects }] : [] };
}

// `GET …/design`'s count against the policy (D7 §6.7, A.8; SEAM.md §§496,
// 508): the selected slots without an approved effective version, over
// every target; counted as an evaluation by `design_view`.
export function assetsRequired(db: Database.Database, project: string): { for: string | { unknown: string }; not_approved: string[]; count: number; text?: string } {
  record({ caller: 'design_view', project });
  const notApproved = slotsNotApproved(db, project, null);
  // The policy read gives every key its value or default; a value it lacks
  // is unknown, never assumed (the review's N5).
  const requiredFor = assetsRequiredFor(db, project);
  if (typeof requiredFor !== 'string' || !(ASSETS_REQUIRED_FOR as readonly string[]).includes(requiredFor)) return { for: { unknown: 'assets_required_for could not be read from the effective policy' }, not_approved: notApproved, count: notApproved.length };
  return { for: requiredFor, not_approved: notApproved, count: notApproved.length, text: `required for ${requiredFor}: ${notApproved.length} slots not approved` };
}
