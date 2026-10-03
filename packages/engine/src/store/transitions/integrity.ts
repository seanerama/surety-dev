// Repository integrity, the store's side (D1 §7.6; build spec §6
// corrections 6 and 15; SEAM.md §32): what integrity reads, and the one
// transaction that records what it observed. An observation changes no
// expected value and no baseline; unknown is not clean.

import { movingRefs } from './accept.js';
import { type Baseline, type CheckoutRow, type RegistryRow, addCheckout, closeRepositoryObservation, integrationRef, projectRepoRow, recordObservation, releaseCheckouts } from './repo.js';
import type { Tx } from './tx.js';

export interface IntegrityFacts {
  repo: string;
  ref: string;
  registry: RegistryRow[];
  moving: Record<string, string[]>;
  // `pending`: the baseline a journaled adoption of the checkout's edits will
  // record when its branch update is finalized (brief B2). What the checkout
  // holds while that update is in flight is the engine's own write, never an
  // observation.
  checkouts: (CheckoutRow & { active: boolean; adminDir: string | null; pending: Pending | null })[];
}

export function integrityFacts(tx: Tx, args: { project: string }): IntegrityFacts {
  const p = projectRepoRow(tx, args.project);
  const checkouts = (
    tx.db
      .prepare(
        `SELECT c.*, r."state" AS "run_state", w."metadata_baseline" FROM "managed_checkouts" c
         LEFT JOIN "runs" r ON r."id" = c."owner_run" LEFT JOIN "workspaces" w ON w."run" = c."owner_run" AND w."path" = c."path"
         WHERE c."project" = ? AND c."released_at" IS NULL ORDER BY c."id"`,
      )
      .all(args.project) as (CheckoutRow & { run_state: string | null; metadata_baseline: string | null })[]
  ).map(({ run_state, metadata_baseline, ...c }) => ({
    ...c,
    active: c.owner_run !== null && run_state !== 'ended',
    adminDir: metadata_baseline ? ((JSON.parse(metadata_baseline) as { adminDir?: string }).adminDir ?? null) : null,
    pending: adoptionInFlight(tx, args.project, c.id),
  }));
  return {
    repo: p.dev_repo_path,
    ref: integrationRef(p.integration_branch),
    registry: tx.db.prepare('SELECT * FROM "ref_registry" WHERE "project" = ? ORDER BY "id"').all(args.project) as RegistryRow[],
    moving: movingRefs(tx.db, args.project),
    checkouts,
  };
}

// An adoption in flight: its commit, or the branch update that follows it,
// not yet finalized or failed. What the checkout may hold meanwhile: HEAD at
// the parent or the adopted commit, the index as found or as adopted, the
// tracked files as reviewed.
export interface Pending {
  heads: string[];
  indexes: string[];
  tree: string;
}

function adoptionInFlight(tx: Tx, project: string, checkout: string): Pending | null {
  const row = tx.db
    .prepare(
      `SELECT o."finalizer_inputs" FROM "operations" o JOIN "git_journal_state" s ON s."operation" = o."id"
       WHERE o."project" = ? AND s."state" NOT IN ('finalized', 'failed')
       AND ((json_extract(o."finalizer_inputs", '$.purpose') = 'oob_adopt' AND json_extract(o."finalizer_inputs", '$.checkout') = ?)
         OR (json_extract(o."finalizer_inputs", '$.purpose') = 'adopt' AND json_extract(o."finalizer_inputs", '$.follow.finalizer.checkout') = ?))
       ORDER BY o."seq" DESC LIMIT 1`,
    )
    .get(project, checkout, checkout) as { finalizer_inputs: string } | undefined;
  if (!row) return null;
  const inputs = JSON.parse(row.finalizer_inputs) as { purpose: string; follow?: { finalizer: AdoptInputs } } & AdoptInputs;
  const f = inputs.purpose === 'adopt' ? inputs.follow?.finalizer : inputs;
  if (!f?.baseline) return null;
  return { heads: [f.baseline.head, f.parent ?? f.baseline.head], indexes: [f.baseline.index_hash, f.before_index ?? f.baseline.index_hash], tree: f.baseline.tracked_tree_hash };
}

interface AdoptInputs {
  baseline?: Baseline;
  parent?: string;
  before_index?: string;
}

export interface IntegrityReport {
  project: string;
  unreadable: boolean;
  refs?: { registry: string; expected: string; found: string | null }[];
  checkouts?: { id: string; expected: string; found: Baseline }[];
  released?: string[];
  added?: { path: string; baseline: Baseline }[];
}

export function recordIntegrity(tx: Tx, report: IntegrityReport): { observed: number } {
  let observed = 0;
  if (report.unreadable) {
    recordObservation(tx, report.project, { subject: 'repository', expected: 'readable', found: null });
    return { observed: 1 };
  }
  closeRepositoryObservation(tx, report.project);
  for (const id of report.released ?? []) releaseCheckouts(tx, { id });
  for (const c of report.added ?? []) addCheckout(tx, { project: report.project, kind: 'integration_worktree', path: c.path, baseline: c.baseline, run: null });
  for (const r of report.refs ?? []) {
    recordObservation(tx, report.project, { subject: 'ref', ref: r.registry, expected: r.expected, found: r.found });
    observed++;
  }
  for (const c of report.checkouts ?? []) {
    recordObservation(tx, report.project, { subject: 'checkout', checkout: c.id, expected: c.expected, found: JSON.stringify(c.found) });
    observed++;
  }
  return { observed };
}
