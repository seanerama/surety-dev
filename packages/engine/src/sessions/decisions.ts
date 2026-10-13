// The decisions a session's close raises (D6 §3.4; D1 A.8; SEAM.md §346;
// contract/decisions.json): `idea_accept` (not floor), `spec_approval`
// (floor, with its option blockers), `architecture_approval` consolidated
// with `plan_approval` under one batch_key and bound to the prospective
// bundle (B02). Each is about the session's run (`subject_type` `run`),
// offers `approve` and `reject`, binds what the contract names, and takes
// its effect in the answer's own transaction (no effect intent). No role
// answers any of them (E12): the route is the owner's.

import { Refusal } from '../refusal.js';
import { type KindSpec, type Subject, consumed, recordApproval, recordIntent } from '../store/transitions/queue.js';
import { consumeDecision } from '../store/transitions/decisions.js';
import type { Tx } from '../store/transitions/tx.js';
import { approveBundlePart, bundleGuard, bundleManifest, bundleOfDecision } from '../plan/bundle.js';
import { approvedRepresentation, latestSemantics, specBlockers } from '../spec/approval.js';
import { integrationRef } from '../store/transitions/repo.js';
import { policyRevision } from '../store/transitions/settings.js';
import { saveNotesOf } from './session.js';
import { retrofitBlockers } from '../adopt/records.js';

type Db = Tx['db'];

function projectOfRun(db: Db, run: string): string | null {
  return (db.prepare('SELECT "project" FROM "runs" WHERE "id" = ?').get(run) as { project: string } | undefined)?.project ?? null;
}

function headOf(db: Db, project: string | null): string | null {
  if (project === null) return null;
  const p = db.prepare('SELECT "integration_branch" FROM "projects" WHERE "id" = ?').get(project) as { integration_branch: string } | undefined;
  if (!p) return null;
  return (db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(project, integrationRef(p.integration_branch)) as { expected_oid: string } | undefined)?.expected_oid ?? null;
}

// The products' evidence (D1 §3.4): a machine file `observed`, the prose
// `claimed`, each named by its path (SEAM.md §346).
type Evidence = { record: string; provenance: 'observed' | 'claimed' | 'configured' };
const MACHINE = /\.json$|\.surety\/adrs\/ADR-[0-9]+\.md$|\.surety\/idea\.md$/;
const evidenceOf = (blobs: Record<string, string>): Evidence[] =>
  Object.keys(blobs)
    .sort()
    .map((path) => ({ record: blobs[path]!, path, provenance: MACHINE.test(path) ? ('observed' as const) : ('claimed' as const) }) as Evidence & { path: string });

// ---- idea_accept (D6 §3.1; SEAM.md §345) -------------------------------------------------------

export const IDEA_ACCEPT_KEYS = ['baseline_revision', 'blob', 'idea_version', 'policy_revision'];

function ideaManifest(db: Db, run: string): Record<string, unknown> {
  const project = projectOfRun(db, run);
  const notes = saveNotesOf(db, run);
  const p = project === null ? undefined : (db.prepare('SELECT "idea_version" FROM "projects" WHERE "id" = ?').get(project) as { idea_version: number | null } | undefined);
  return { run, baseline_revision: headOf(db, project), blob: notes.blobs?.['.surety/idea.md'] ?? null, idea_version: (p?.idea_version ?? 0) + 1, identity: notes.identity ?? null, policy_revision: project === null ? null : policyRevision(db, project) };
}

export const IDEA_ACCEPT: KindSpec = {
  preview(tx, d: Subject) {
    const manifest = ideaManifest(tx.db, d.subject_id);
    if (manifest.blob === null) return null;
    const parsed = manifest.identity !== null;
    return {
      manifest,
      question: `Accept the idea record the Vision session ${d.subject_id} wrote as version ${String(manifest.idea_version)}?${parsed ? '' : ' Its identity block did not parse; the record is accepted as prose only.'}`,
      options: [
        { key: 'approve', label: 'Accept', consequence: "The idea record becomes the project's idea, its identity block the project's identity; the baseline stays idea.", effect: { run: d.subject_id, idea_version: manifest.idea_version, blob: manifest.blob } },
        { key: 'reject', label: 'Reject', consequence: 'The record stays committed as the session left it; nothing is accepted.', effect: {} },
      ],
      evidence: evidenceOf({ '.surety/idea.md': String(manifest.blob) }),
    };
  },
  manifest: (tx, d) => ideaManifest(tx.db, d.subject_id),
  reraise: false,
  answer(tx, d, option, note) {
    consumeDecision(tx, d, option, note);
    if (option !== 'approve') return consumed(d);
    const m = ideaManifest(tx.db, d.subject_id);
    const version = Number(m.idea_version);
    const row = tx.db.prepare('SELECT "idea_history" FROM "projects" WHERE "id" = ?').get(d.project!) as { idea_history: string };
    const history = JSON.parse(row.idea_history) as unknown[];
    history.push({ version, blob: m.blob, binding: { kind: 'idea_accept', actor: tx.actor.actor_kind, decision: d.id, run: d.subject_id }, at: tx.at });
    tx.db.prepare('UPDATE "projects" SET "idea_version" = ?, "idea_blob" = ?, "idea_identity" = ?, "idea_history" = ? WHERE "id" = ?').run(version, m.blob, m.identity === null ? null : JSON.stringify(m.identity), JSON.stringify(history), d.project);
    recordApproval(tx, d, { consequence: `idea record version ${version} accepted`, subjectType: 'idea', subjectId: String(m.blob) });
    tx.emit('baseline.idea_recorded', { project: d.project!, run: d.subject_id }, { version, blob: m.blob, actor: tx.actor.actor_kind, decision: d.id });
    return consumed(d);
  },
};

// ---- spec_approval (D6 §3.4; floor) -------------------------------------------------------

export const SPEC_APPROVAL_KEYS = ['baseline_revision', 'blob', 'semantic_digest', 'spec_version', 'policy_revision'];

function specManifest(db: Db, run: string): Record<string, unknown> {
  const project = projectOfRun(db, run);
  const row = latestSemantics(db, run);
  const latest = project === null ? 0 : ((db.prepare('SELECT "version" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { version: number } | undefined)?.version ?? 0);
  return {
    run,
    baseline_revision: headOf(db, project),
    blob: row?.git_blob ?? null,
    semantic_digest: row?.semantic_digest ?? null,
    spec_version: latest + 1,
    readable: row ? row.readable === 1 : null,
    // D6-R09 (SEAM.md §384): an adopted project's mode rules, naming each
    // requirement that keeps `approve` blocked.
    blocking: [...specBlockers(row, project === null ? null : approvedRepresentation(db, project)), ...retrofitBlockers(db, project, run)],
    policy_revision: project === null ? null : policyRevision(db, project),
  };
}

export const SPEC_APPROVAL: KindSpec = {
  preview(tx, d: Subject) {
    const manifest = specManifest(tx.db, d.subject_id);
    if (manifest.blob === null) return null;
    const row = latestSemantics(tx.db, d.subject_id);
    const blockers = [...specBlockers(row, d.project === null ? null : approvedRepresentation(tx.db, d.project)), ...retrofitBlockers(tx.db, d.project, d.subject_id)];
    let findings: { where: string; code: string; why: string }[] = [];
    try {
      findings = row ? (JSON.parse(row.findings) as { where: string; code: string; why: string }[]) : [];
    } catch {
      findings = [];
    }
    return {
      manifest,
      question: `Approve the specification the Spec Writer session ${d.subject_id} saved as version ${String(manifest.spec_version)}?${findings.length > 0 ? ` The engine found ${findings.length} thing(s) it could not read or accept: ${findings.map((f) => `${f.where}: ${f.why}`).join('; ')}.` : ''}`,
      options: [
        {
          key: 'approve',
          label: 'Approve',
          consequence: 'The specification becomes the approved baseline: its requirements, criteria, modules and environments are registered, and the project is spec_ready.',
          effect: { run: d.subject_id, blob: manifest.blob, semantic_digest: manifest.semantic_digest, spec_version: manifest.spec_version },
          blockers,
        },
        { key: 'reject', label: 'Reject', consequence: 'The specification stays committed as the session left it; nothing is approved.', effect: {} },
      ],
      evidence: [{ record: String(manifest.blob), path: '.surety/spec/spec.md', provenance: manifest.readable === true ? 'observed' : 'claimed' } as Evidence],
    };
  },
  manifest: (tx, d) => specManifest(tx.db, d.subject_id),
  reraise: false,
  answer(tx, d, option, note) {
    consumeDecision(tx, d, option, note);
    if (option !== 'approve') return consumed(d);
    // The effect (D6 §3.4; the coordinator's ruling on question 2): TPL §11's
    // change log row committed by the engine through the journal, whose
    // finalizer is the approval (spec/approval-effect.ts). The answer
    // launches nothing (D1 §10.5).
    const m = specManifest(tx.db, d.subject_id);
    const approval = recordApproval(tx, d, { consequence: `specification version ${String(m.spec_version)} approved`, subjectType: 'spec_blob', subjectId: String(m.blob) });
    return consumed(d, [recordIntent(tx, d, { approval, kind: 'spec_approval_application', plan: { run: d.subject_id } })]);
  },
  // An effect whose precondition failed: the question is asked again.
  withdraw: () => true,
};

// ---- architecture_approval and plan_approval (D6 §3.4, §5.5; B02) ---------------------------

export const BUNDLE_KEYS = ['baseline_revision', 'spec_version', 'bundle', 'blobs', 'versions', 'policy_revision'];
export const PLAN_KEYS = [...BUNDLE_KEYS, 'plan_check', 'plan_generation'];

function bundleSpec(kind: 'architecture_approval' | 'plan_approval'): KindSpec {
  const what = kind === 'architecture_approval' ? 'the architecture, module map and ADRs' : 'the phase plan';
  return {
    preview(tx, d: Subject) {
      const b = bundleOfDecision(tx.db, d);
      if (!b || b.status !== 'proposed') return null;
      if (kind === 'plan_approval' && b.phase_number === null) return null;
      const manifest = bundleManifest(tx.db, d.subject_id, b, kind);
      const check = b.plan_check ? (tx.db.prepare('SELECT "outcome", "conformance" FROM "plan_checks" WHERE "id" = ?').get(b.plan_check) as { outcome: string; conformance: string } | undefined) : undefined;
      return {
        manifest,
        question: `Approve ${what} the Architect session ${d.subject_id} proposed${b.phase_number === null ? '' : ` for phase ${b.phase_number}`} (bundle ${b.id})?${check ? ` The mechanical check ${check.outcome}; conformance declared ${check.conformance}.` : ''}${b.phase_number === null ? '' : ' Both approvals of the batch publish it once.'}`,
        options: [
          {
            key: 'approve',
            label: 'Approve',
            consequence:
              kind === 'architecture_approval'
                ? b.phase_number === null
                  ? 'The architecture revision, module map and ADR texts are published.'
                  : 'With the plan approval, the architecture revision, module map, ADRs and roadmap are published.'
                : 'With the architecture approval, the phase plan is published with its stages and their work.',
            effect: { run: d.subject_id, bundle: b.id, kind, versions: manifest.versions },
          },
          { key: 'reject', label: 'Reject', consequence: 'The bundle is refused; the saves stay committed as checkpoints with no effect.', effect: { bundle: b.id, refused: true } },
        ],
        evidence: evidenceOf(JSON.parse(b.blobs) as Record<string, string>),
      };
    },
    manifest: (tx, d) => bundleManifest(tx.db, d.subject_id, bundleOfDecision(tx.db, d), kind),
    // A bundle that can no longer publish (D6 §5.5; M448 (d)): marked
    // stale, and the answer refused `plan_generation_stale`, committed.
    guard: (tx, d, option) => bundleGuard(tx, d, option),
    reraise: false,
    answer(tx, d, option, note) {
      consumeDecision(tx, d, option, note);
      const b = bundleOfDecision(tx.db, d);
      if (!b) throw new Refusal(409, 'decision_invalidated', `Decision ${d.id} names no bundle.`, 'Read the current decisions about the session.', { decision: d.id });
      const made = approveBundlePart(tx, { bundle: b.id, kind, decision: d.id, option: option === 'approve' ? 'approve' : 'reject' });
      if (option === 'approve') recordApproval(tx, d, { consequence: made.published ? `bundle ${made.bundle} published${made.plan ? ` as plan ${made.plan}` : ''}` : `bundle ${made.bundle} approved in part (${kind})`, subjectType: 'plan_bundle', subjectId: made.bundle });
      // The answer launches nothing (D1 §10.5): what the publication made
      // eligible is dispatched by the next tick.
      return consumed(d);
    },
  };
}

export const ARCHITECTURE_APPROVAL: KindSpec = bundleSpec('architecture_approval');
export const PLAN_APPROVAL: KindSpec = bundleSpec('plan_approval');
