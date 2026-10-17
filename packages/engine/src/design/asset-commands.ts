// The owner's asset commands, main thread (D7 §6.3, §6.4, A.8; SEAM.md
// §508). No transaction is held across a git call (D1 §6.1):
//
// - `surety design asset add <slot> <variant> <file>` (POST …/design/assets):
//   the file checked against the slot and variant by its header alone (the
//   same checks as a save, D7 §6.3), the design tree's bounds applied (§5.5:
//   `design_tree_too_large`), then committed by the engine as one `intent`
//   revision touching `.surety/design/assets/` only: the file, and the
//   manifest with the slot `proposed`, provenance `owner`, its slot_version
//   and the manifest's version each one higher, its history extended. An
//   invalid file is refused `design_asset_invalid` with its reasons and
//   nothing is committed. Nothing the owner sent is executed or decoded.
// - `surety design assets submit` (POST …/design/assets/submit): the
//   asset-only revision (§6.4): the approved revision's design with the
//   head's assets, checked here (the design check, never executing
//   anything), recorded and raised by the store command.

import { messageText } from '../git/commit.js';
import { treeOf } from '../git/repo.js';
import { repoContext } from '../git/exec.js';
import type { Journal } from '../journal/driver.js';
import { prepareCommit } from '../projects/commands.js';
import { Refusal } from '../refusal.js';
import type { Runtime } from '../runtime.js';
import { ASSET_FORMATS, ASSET_VARIANTS, type AssetManifest, MANIFEST_FILE, headerReasons, sha256hex } from './assets.js';
import { isSlug } from './paths.js';
import { type CheckContext, checkDesign } from './check.js';
import { DESIGN_ROOT } from './inventory.js';
import { designTreeAt, designTreeSize } from './tree.js';

// The upload's own body cap: a file as large as the largest design tree
// bound (D7 A.7: design_tree_max_bytes up to 128 MiB), base64, and its JSON.
const TREE_BYTES_MAX = 128 * 1024 * 1024;
export const ASSET_BODY_CAP = Math.ceil(TREE_BYTES_MAX / 3) * 4 + 64 * 1024;
export const assetTooLarge = (cap: number, limit?: { key: string; max: number; bytes: number }) =>
  limit
    ? new Refusal(413, 'design_asset_too_large', `The asset is ${limit.bytes} bytes, more than ${limit.key} (${limit.max} bytes). Nothing was committed.`, `Supply a file of at most ${limit.max} bytes, or raise ${limit.key}.`, { limit: limit.key, max: limit.max, bytes: limit.bytes })
    : new Refusal(413, 'design_asset_too_large', `The asset upload exceeds ${cap} bytes, its body's limit (a file of at most ${TREE_BYTES_MAX} bytes, base64).`, `Supply a file of at most ${TREE_BYTES_MAX} bytes.`, { limit: 'body', max: cap });

const invalid = (field: string, why: string) => new Refusal(400, 'invalid_value', `"${field}" ${why}.`, 'Send {"slot": <slot key>, "variant": <variant>, "content_base64": <the file, base64>, "name"?: <its file name>}.', { field });

export interface AssetAddBody {
  slot: string;
  variant: string;
  bytes: Buffer;
  name: string | null;
}

export function parseAssetAdd(b: unknown): AssetAddBody {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw invalid('body', 'must be a JSON object');
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['slot', 'variant', 'content_base64', 'name'].includes(k)) throw new Refusal(400, 'unknown_field', `"${k}" is not a field of an asset.`, 'Send slot, variant, content_base64 and optionally name.', { field: k });
  if (typeof o.slot !== 'string' || o.slot === '') throw invalid('slot', 'must name a slot of the asset manifest');
  if (typeof o.variant !== 'string' || o.variant === '') throw invalid('variant', 'must name a variant of the slot');
  if (typeof o.content_base64 !== 'string' || o.content_base64 === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(o.content_base64)) throw invalid('content_base64', 'must be the file\'s bytes, base64');
  if (o.name !== undefined && (typeof o.name !== 'string' || o.name.length > 255)) throw invalid('name', 'must be a file name');
  const bytes = Buffer.from(o.content_base64, 'base64');
  if (bytes.length === 0) throw invalid('content_base64', 'decodes to no bytes');
  return { slot: o.slot, variant: o.variant, bytes, name: typeof o.name === 'string' ? o.name : null };
}

const parseManifest = (bytes: Buffer | undefined): AssetManifest | null => {
  if (!bytes) return null;
  try {
    const v = JSON.parse(bytes.toString('utf8')) as AssetManifest;
    return v && Array.isArray(v.slots) ? v : null;
  } catch {
    return null;
  }
};

// The owner's file committed as a proposal of `slot`'s `variant`; the answer
// (201) or a refusal. Under the project's journal: the head read, the
// commit and the branch's move to it are one chain.
export async function addOwnerAsset(rt: Runtime, journal: Journal, project: string, body: AssetAddBody): Promise<{ status: number; body: Record<string, unknown> }> {
  return journal.withProject(
    project,
    async () => {
      const facts = await rt.read<{ repo: string; head: string | null }>('design.repo_facts', { project });
      if (facts.head === null) throw new Refusal(409, 'design_unreadable', 'The project has no integration head to commit an asset onto.', 'Register the project first.', { project });
      const tree = await designTreeAt(facts.repo, facts.head);
      const manifest = parseManifest(tree?.files.get('assets/manifest.json'));
      if (tree === null || manifest === null) throw new Refusal(409, 'design_unreadable', 'The asset manifest at the integration head cannot be read.', 'Let the engine derive the inventory and its placeholders first.', { project, revision: facts.head });
      const info = await rt.read<{ design_version: number; policy: Record<string, unknown> }>('design.asset_facts', { project });
      const maxBytes = Number(info.policy.design_tree_max_bytes);
      if (!Number.isFinite(maxBytes)) throw new Error('the design_tree_max_bytes of the project could not be read');
      if (body.bytes.length > maxBytes) throw assetTooLarge(ASSET_BODY_CAP, { key: 'design_tree_max_bytes', max: maxBytes, bytes: body.bytes.length });
      const slot = manifest.slots.find((s) => s.key === body.slot);
      const variant = slot?.variants.find((v) => v.name === body.variant);
      const subject = { slot: body.slot, variant: body.variant, file: body.name ?? `${body.slot}/${body.variant}` };
      const reasons = !slot || !variant ? [{ code: 'DESIGN_ASSET_SLOT_MISSING', subjects: { slot: body.slot, variant: body.variant, why: !slot ? 'the manifest has no such slot' : 'the slot has no such variant' } }] : headerReasons(body.bytes, variant, subject);
      if (reasons.length > 0 || !slot || !variant) {
        throw new Refusal(422, 'design_asset_invalid', `The file is not a valid ${body.slot}/${body.variant}: ${reasons.map((r) => r.code).join(', ')}. Nothing was committed.`, 'Supply a file in the variant\'s declared format, size and transparency; an SVG with no script, event attribute or external reference.', {
          slot: body.slot,
          variant: body.variant,
          reasons,
        });
      }
      const digest = sha256hex(body.bytes);
      if (variant.digest === digest) throw new Refusal(409, 'design_asset_unchanged', `${body.slot}/${body.variant} already is this file (${digest}).`, 'Supply a different file.', { slot: body.slot, variant: body.variant, digest });
      // The slot key and the variant name make the file's path: a slug and a
      // variant of the closed list, nothing else (the review's note).
      if (!isSlug(slot.key) || !(ASSET_VARIANTS as readonly string[]).includes(variant.name) || !(ASSET_FORMATS as readonly string[]).includes(variant.format)) {
        throw new Refusal(422, 'design_asset_invalid', `${slot.key}/${variant.name} cannot name a file: its key, variant or format is not one the engine writes. Nothing was committed.`, 'Correct the manifest in a Designer session first.', {
          slot: body.slot,
          variant: body.variant,
          reasons: [{ code: 'DESIGN_SCHEMA_INVALID', subjects: { slot: body.slot, variant: body.variant, why: 'a slot key is a slug, a variant one of D7 6.1, a format svg, png, webp or ico' } }],
        });
      }
      // The new manifest: the slot proposed by the owner at its next version.
      const slotVersion = slot.slot_version + 1;
      const file = `assets/${slot.key}/owner-${variant.name}-${slotVersion}.${variant.format}`;
      const next: AssetManifest = structuredClone(manifest);
      const s = next.slots.find((x) => x.key === slot.key)!;
      s.variants = s.variants.map((v) => (v.name === variant.name ? { ...v, file, digest } : v));
      s.slot_version = slotVersion;
      s.status = 'proposed';
      s.provenance = 'owner';
      s.status_since = info.design_version;
      s.history = [...(s.history ?? []), { slot_version: slotVersion, design_version: info.design_version, status: 'proposed', files: s.variants.filter((v) => typeof v.digest === 'string').map((v) => ({ variant: v.name, digest: v.digest! })) }];
      next.version = manifest.version + 1;
      const manifestText = `${JSON.stringify(next, null, 2)}\n`;
      // The design tree's bounds (§5.5), applied to the tree the commit would make.
      const headTree = await treeOf(repoContext(facts.repo), facts.head);
      const size = headTree === null ? null : await designTreeSize(facts.repo, headTree);
      if (size === null) throw new Error('the design tree at the head could not be measured');
      const oldManifest = tree.files.get('assets/manifest.json')!.length;
      const after = { files: size.files + 1, bytes: size.bytes + body.bytes.length + Buffer.byteLength(manifestText) - oldManifest };
      for (const [key, n, unit] of [
        ['design_tree_max_files', after.files, 'files'],
        ['design_tree_max_bytes', after.bytes, 'bytes'],
      ] as const) {
        const max = Number(info.policy[key]);
        if (!Number.isFinite(max)) throw new Error(`the project's ${key} could not be read`);
        if (n > max) throw new Refusal(413, 'design_tree_too_large', `The asset was refused: the design tree would hold ${n} ${unit}, more than ${key} (${max}). Nothing was committed.`, `Keep .surety/design/ within ${key}.`, { key, [unit]: n, max });
      }
      const files = { [`${DESIGN_ROOT}${file}`]: { bytes: body.bytes, mode: '100644' }, [MANIFEST_FILE]: manifestText };
      const message = messageText({ title: `surety: the owner's ${slot.key}/${variant.name}`, trailers: [['Surety-Project', project], ['Surety-Kind', 'intent'], ['Surety-Asset', `${slot.key}@${slotVersion}`]] });
      const commit = await prepareCommit(facts.repo, facts.head, files, message, rt.scratch);
      if (commit === null) throw new Error('the asset commit could not be prepared');
      const made = await journal.intend(
        'design.intend_asset',
        { project, repo: facts.repo, head: facts.head, commit, asset: { slot: slot.key, variant: variant.name, slot_version: slotVersion, digest, file, format: variant.format }, manifest: next, deadlineSeconds: rt.setting('git_deadline') },
        'commit_tree',
      );
      if (!('operation' in made)) throw new Refusal(409, 'integration_conflict', 'The integration branch moved while the asset was prepared; nothing was committed.', 'Ask again.', { project });
      const settled = await journal.drive(made.operation);
      const follow = (settled.receipts as { follow?: unknown }).follow;
      if (settled.end !== 'finalized' || typeof follow !== 'string' || (await journal.drive(follow)).end !== 'finalized') {
        throw new Error('the asset commit or the branch move to it did not finalize');
      }
      return { status: 201, body: { asset: { slot: slot.key, variant: variant.name, slot_version: slotVersion, status: 'proposed', provenance: 'owner', file, digest }, manifest_version: next.version, revision: commit.sha } };
    },
    'design:asset',
  );
}

// `surety design assets submit`, its main-thread part: the asset-only
// revision's tree (the approved revision's design, the head's assets) read
// and checked. The store command records the check and raises the approval.
export async function prepareAssetsSubmit(rt: Runtime, project: string): Promise<Record<string, unknown>> {
  const facts = await rt.read<{ repo: string; head: string | null }>('design.repo_facts', { project });
  const approved = await rt.read<{ id: string; version: number; blobs: Record<string, string>; content: Record<string, unknown> | null } | null>('design.approved_revision', { project });
  if (!approved) throw new Refusal(409, 'no_approved_design', 'This project has no approved design whose assets could be submitted.', 'Approve a design first.', { project });
  if (facts.head === null) throw new Refusal(409, 'design_unreadable', 'The project has no integration head.', 'Register the project first.', { project });
  const tree = await designTreeAt(facts.repo, facts.head);
  if (tree === null) throw new Error(`the design tree at ${facts.head} could not be read`);
  // An asset-only revision touches only assets/ (§6.4): the rest of the
  // design at the head is the approved revision's (the engine's inventory aside).
  const outside = (blobs: Record<string, string>) => Object.fromEntries(Object.entries(blobs).filter(([p]) => !p.startsWith('assets/') && !p.startsWith('inventory/')));
  const a = outside(approved.blobs);
  const h = outside(tree.blobs);
  const differ = [...new Set([...Object.keys(a), ...Object.keys(h)])].filter((p) => a[p] !== h[p]).sort();
  if (differ.length > 0) {
    throw new Refusal(409, 'design_not_asset_only', `The design at the integration head differs from approved version ${approved.version} outside assets/ (${differ.slice(0, 5).join(', ')}${differ.length > 5 ? ', …' : ''}): an asset-only revision touches only assets/.`, 'Have the Designer session\'s design approved or withdrawn first.', { project, paths: differ });
  }
  const manifest = parseManifest(tree.files.get('assets/manifest.json'));
  if (manifest === null || approved.content === null) throw new Refusal(409, 'design_unreadable', 'The asset manifest at the integration head cannot be read.', 'Save the design again.', { project });
  const ctx = await rt.read<CheckContext>('design.check_context', { project });
  const result = checkDesign({ files: tree.files }, ctx);
  return {
    project,
    revision: facts.head,
    tree: tree.tree,
    blobs: tree.blobs,
    content: { ...approved.content, manifest },
    inventory_digest: ctx.inventory?.inventory_digest ?? null,
    outcome: result.outcome,
    reasons: result.reasons,
  };
}
