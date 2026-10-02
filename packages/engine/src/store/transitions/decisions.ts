// The attention queue's kinds through slice 3 (D1 §3.4, §10; A.8): `blocker`,
// `stop_confirm`, `abandon_confirm` and `out_of_band_change`. Only transition functions raise
// decisions. Identity is (project, kind, subject_type, subject_id,
// semantic_generation, scope), unique across all statuses; a raise with an
// open decision of the same identity and preview returns it. The preview
// hash covers the identity, the options and their plan hashes, the schema
// version and every manifest value; an answer whose hash differs from the one
// recomputed from current rows is refused as stale.

import { Refusal } from '../../refusal.js';
import { canonical, nextSeq, notFound, sha256 } from './common.js';
import { engineSettings } from './settings.js';
import type { Tx } from './tx.js';

export const TRANSITION_SCHEMA_VERSION = 1;

export type DecisionKind =
  | 'blocker'
  | 'stop_confirm'
  | 'abandon_confirm'
  | 'out_of_band_change'
  | 'policy_widening'
  | 'finding_disposition'
  | 'severity_lower'
  | 'finding_applicability_exclusion'
  | 'check_correction_tightening'
  | 'check_correction_loosening'
  | 'check_correction_unclassifiable';

export interface OptionSpec {
  key: string;
  label: string;
  consequence: string;
  effect: Record<string, unknown>;
  // Reason codes that keep the option from being chosen now (SEAM.md §76).
  blockers?: string[];
}

export interface DecisionRow {
  id: string;
  project: string;
  seq: number;
  kind: DecisionKind;
  subject_type: string;
  subject_id: string;
  semantic_generation: number;
  scope: string;
  question: string;
  options: string;
  dependency_manifest: string;
  preview_hash: string;
  blocked_while_open: string;
  status: 'open' | 'answered' | 'consumed' | 'invalidated';
}

export interface DecisionSpec {
  project: string;
  kind: DecisionKind;
  subjectType: string;
  subjectId: string;
  // The identity's scope: 'subject' unless a kind asks several questions
  // about one subject (a policy widening: one per submitted change).
  scope?: string | undefined;
  question: string;
  options: OptionSpec[];
  manifest: Record<string, unknown>;
  blockedWorkItems?: string[] | undefined;
  blockedOperation?: string | undefined;
}

const SCOPE = 'subject';

export interface OptionJson {
  key: string;
  label: string;
  effect_plan: Record<string, unknown>;
  plan_hash: string;
  consequence_text: string;
  blockers: string[];
}

export function optionsJson(options: OptionSpec[]): OptionJson[] {
  return options.map((o) => ({
    key: o.key,
    label: o.label,
    effect_plan: o.effect,
    plan_hash: sha256(canonical({ key: o.key, effect_plan: o.effect })),
    consequence_text: o.consequence,
    blockers: [...(o.blockers ?? [])].sort(),
  }));
}

// The preview hash (D1 §§9.7, 10.2): the identity, the options with their
// plan hashes and blockers, the schema version and every manifest value.
// Never the order of a submission, a presentation time or how often the
// question was asked.
export function previewHash(
  identity: { project: string; kind: string; subject_type: string; subject_id: string; semantic_generation: number; scope: string },
  options: { key: string; plan_hash: string; blockers?: string[] }[],
  manifest: Record<string, unknown>,
): string {
  return sha256(
    canonical({
      identity,
      options: options.map((o) => ({ key: o.key, plan_hash: o.plan_hash, blockers: o.blockers ?? [] })),
      transition_schema_version: TRANSITION_SCHEMA_VERSION,
      manifest,
    }),
  );
}

const identityOf = (d: DecisionRow) => ({
  project: d.project,
  kind: d.kind,
  subject_type: d.subject_type,
  subject_id: d.subject_id,
  semantic_generation: d.semantic_generation,
  scope: d.scope,
});

// The preview hash of an existing decision against a manifest read now, and
// the options as they are now (or as they were offered).
export function currentPreview(d: DecisionRow, manifest: Record<string, unknown>, options?: OptionSpec[]): string {
  return previewHash(identityOf(d), options ? optionsJson(options) : (JSON.parse(d.options) as OptionJson[]), manifest);
}

export function getDecision(tx: Tx, id: string): DecisionRow | undefined {
  return tx.db.prepare('SELECT * FROM "decisions" WHERE "id" = ?').get(id) as DecisionRow | undefined;
}

export function openDecision(tx: Tx, project: string, kind: DecisionKind, subjectType: string, subjectId: string, scope: string = SCOPE): DecisionRow | undefined {
  return tx.db
    .prepare(
      `SELECT * FROM "decisions" WHERE "project" = ? AND "kind" = ? AND "subject_type" = ? AND "subject_id" = ? AND "scope" = ? AND "status" = 'open'
       ORDER BY "semantic_generation" DESC LIMIT 1`,
    )
    .get(project, kind, subjectType, subjectId, scope) as DecisionRow | undefined;
}

const decisionSubject = (d: { project: string; id: string; subject_type: string; subject_id: string; kind: string }) => ({
  project: d.project,
  decision: d.id,
  subject_type: d.subject_type,
  subject_id: d.subject_id,
});

// Raise a decision, or return the open one with the same identity and
// preview. An open one whose preview no longer matches its manifest is
// invalidated and the next semantic generation is raised (D1 §4.6).
export function raiseDecision(tx: Tx, spec: DecisionSpec): DecisionRow {
  const scope = spec.scope ?? SCOPE;
  const open = openDecision(tx, spec.project, spec.kind, spec.subjectType, spec.subjectId, scope);
  if (open) {
    if (currentPreview(open, spec.manifest, spec.options) === open.preview_hash) return open;
    invalidateDecision(tx, open, 'dependency manifest changed');
  }
  const { g } = tx.db
    .prepare(
      `SELECT COALESCE(MAX("semantic_generation"), 0) AS g FROM "decisions"
       WHERE "project" = ? AND "kind" = ? AND "subject_type" = ? AND "subject_id" = ? AND "scope" = ?`,
    )
    .get(spec.project, spec.kind, spec.subjectType, spec.subjectId, scope) as { g: number };
  const id = tx.newId('dec_');
  const seq = nextSeq(tx, spec.project, 'decisions');
  const identity = { project: spec.project, kind: spec.kind, subject_type: spec.subjectType, subject_id: spec.subjectId, semantic_generation: g + 1, scope };
  const options = optionsJson(spec.options);
  const preview = previewHash(identity, options, spec.manifest);
  const target = engineSettings().decision_targets[spec.kind] ?? null;
  const blocked = { work_items: spec.blockedWorkItems ?? [], gate: null, operation: spec.blockedOperation ?? null };
  tx.db
    .prepare(
      `INSERT INTO "decisions" ("id", "created_at", "project", "seq", "kind", "subject_type", "subject_id", "semantic_generation", "scope",
         "question", "options", "dependency_manifest", "transition_schema_version", "preview_hash", "evidence", "blocked_while_open",
         "raised_at", "target_seconds", "status")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 'open')`,
    )
    .run(
      id,
      tx.at,
      spec.project,
      seq,
      spec.kind,
      spec.subjectType,
      spec.subjectId,
      identity.semantic_generation,
      scope,
      spec.question,
      JSON.stringify(options),
      JSON.stringify(spec.manifest),
      TRANSITION_SCHEMA_VERSION,
      preview,
      JSON.stringify(blocked),
      tx.at,
      target,
    );
  const row = getDecision(tx, id)!;
  tx.emit('decision.raised', decisionSubject(row), { kind: spec.kind, semantic_generation: identity.semantic_generation, preview_hash: preview });
  return row;
}

export function invalidateDecision(tx: Tx, d: DecisionRow, reason: string): void {
  if (d.status !== 'open') return;
  tx.db.prepare(`UPDATE "decisions" SET "status" = 'invalidated', "invalidated_reason" = ? WHERE "id" = ?`).run(reason, d.id);
  tx.emit('decision.invalidated', decisionSubject(d), { kind: d.kind, reason });
}

// Answer and consume in one transaction (D1 §4.6, §10.5): open → answered →
// consumed. The caller has already checked the preview and the option, and
// records the effect in the same transaction.
export function consumeDecision(tx: Tx, d: DecisionRow, option: string, note: string | null): void {
  const answer = { option, note, actor: tx.actor.actor_kind, at: tx.at };
  tx.db.prepare(`UPDATE "decisions" SET "status" = 'answered', "answer" = ? WHERE "id" = ?`).run(JSON.stringify(answer), d.id);
  tx.emit('decision.answered', decisionSubject(d), { kind: d.kind, option });
  tx.db.prepare(`UPDATE "decisions" SET "status" = 'consumed', "consumed_at" = ? WHERE "id" = ?`).run(tx.at, d.id);
  tx.emit('decision.consumed', decisionSubject(d), { kind: d.kind, option });
}

// The checks every answer passes before its effect (D1 §10.5): the decision
// is this project's, still open, offers the option, and its preview is the
// one a fresh read of its manifest gives.
export function checkAnswer(tx: Tx, args: { project: string; decision: string; option: unknown; preview_hash: unknown }, manifest: (d: DecisionRow) => Record<string, unknown>): DecisionRow {
  const d = getDecision(tx, args.decision);
  if (!d || d.project !== args.project) throw notFound('decision', args.decision);
  if (d.status === 'invalidated') {
    throw new Refusal(409, 'decision_invalidated', `Decision ${d.id} was invalidated: what it was bound to changed, or its subject was settled another way.`, 'Read the current decision about its subject, if there is one.', {
      decision: d.id,
      status: d.status,
    });
  }
  if (d.status !== 'open') {
    throw new Refusal(409, 'decision_consumed', `Decision ${d.id} is ${d.status}, not open.`, 'Read the decision again; it cannot be answered twice.', { decision: d.id, status: d.status });
  }
  const keys = (JSON.parse(d.options) as { key: string }[]).map((o) => o.key);
  if (typeof args.option !== 'string' || !keys.includes(args.option)) {
    throw new Refusal(400, 'invalid_value', `"option" must be one of ${keys.join(', ')}.`, 'Answer with an option the decision offers.', { field: 'option' });
  }
  if (typeof args.preview_hash !== 'string' || args.preview_hash !== d.preview_hash || currentPreview(d, manifest(d)) !== d.preview_hash) {
    throw stale(d);
  }
  return d;
}

export function stale(d: DecisionRow): Refusal {
  return new Refusal(
    409,
    'decision_stale',
    `The preview of decision ${d.id} is not the one presented, or what it depends on has changed.`,
    'Nothing was done. Read the decision again and answer with its current preview hash.',
    { decision: d.id },
  );
}
