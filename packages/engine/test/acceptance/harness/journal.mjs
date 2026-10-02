// What the slice-3 rows read of the store and the repository together
// (SEAM.md §§27–35): journaled operations with their events, revisions, the
// ref registry, managed checkouts, out-of-band observations and policy
// revisions; projects created through the public API; journal barriers; and
// the two judgements most cases end in: "this run's snapshot was committed,
// exactly" and "nothing of this run was accepted".
//
// The reads are indifferent to the journal kind and return every event with
// its payload, so the second slice-3 session can use them for the probe and
// crash rows without changing them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { waitFor } from './engine.mjs';
import { hasIdForm } from './ids.mjs';
import { assertWorkHistory } from './invariants.mjs';
import { changedPaths, identityOf, parentsOf, refOid, refsContaining, refsOf, snapshotTree, trailersOf, treeOf } from './repos.mjs';
import { getRow, resolvedPath } from './runs.mjs';
import { withStore } from './store.mjs';

export const JOURNAL = JSON.parse(readFileSync(new URL('../contract/journal.json', import.meta.url), 'utf8'));
export const VALIDATION = JSON.parse(readFileSync(new URL('../contract/snapshot-validation.json', import.meta.url), 'utf8'));

const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));

// ---- barriers -------------------------------------------------------------------

// The name of the barrier at one boundary of one journal kind.
export function journalBarrier(kind, boundary) {
  if (!(kind in JOURNAL.kinds)) throw new Error(`no journal kind ${kind} in the contract table`);
  if (!(boundary in JOURNAL.boundaries)) throw new Error(`no journal boundary ${boundary} in the contract table`);
  return `journal.${kind}.${boundary}`;
}

// Every journal barrier name: one per kind and boundary.
export const journalBarriers = () => Object.keys(JOURNAL.kinds).flatMap((kind) => Object.keys(JOURNAL.boundaries).map((boundary) => journalBarrier(kind, boundary)));

// Arm a barrier while the engine runs (SEAM.md §33).
export async function armBarrier(engine, name, action = 'pause') {
  const res = await engine.post('/v1/harness/barriers', { name, action });
  if (res.status < 200 || res.status > 299) throw new Error(`arm barrier ${name}=${action} → ${res.status} ${res.text}`);
}

// ---- store reads ----------------------------------------------------------------

// The journaled operations of a project, oldest first, each with its events
// in order: {id, kind, status, finalized, journal_kind, events: [{kind,
// payload}], state}. `state` is the kind of its last event. Filters: `run`
// (an event's payload names that run), `journalKind`, `kind`.
export function operationsOf(home, { project, run, journalKind, kind } = {}) {
  return withStore(home, (db) =>
    db
      .prepare('SELECT * FROM "operations" WHERE (? IS NULL OR "project" = ?) AND (? IS NULL OR "kind" = ?) ORDER BY "seq", "id"')
      .all(project ?? null, project ?? null, kind ?? null, kind ?? null)
      .map((op) => {
        const events = db
          .prepare('SELECT "journal_kind", "event_kind", "payload" FROM "git_journal_events" WHERE "operation" = ? ORDER BY "seq"')
          .all(op.id)
          .map((e) => ({ journal_kind: e.journal_kind, kind: e.event_kind, payload: json(e.payload) }));
        return {
          id: op.id,
          project: op.project,
          kind: op.kind,
          status: op.status,
          finalized: op.finalized_at !== null,
          journal_kind: events[0]?.journal_kind ?? null,
          events,
          state: events.at(-1)?.kind ?? null,
        };
      })
      .filter((op) => (journalKind === undefined || op.journal_kind === journalKind) && (run === undefined || op.events.some((e) => e.payload?.run === run))),
  );
}

// An operation ran its ordinary course (contract/journal.json).
export function assertOrdinaryCourse(op, what) {
  assert.ok(op, `${what}: the operation exists`);
  assert.equal(op.kind, JOURNAL.kinds[op.journal_kind]?.operation_kind, `${what}: a ${op.journal_kind} journal belongs to a ${JOURNAL.kinds[op.journal_kind]?.operation_kind} operation`);
  assert.deepEqual(op.events.map((e) => e.kind), JOURNAL.ordinary_events, `${what}: the journal's events`);
  assert.deepEqual([op.status, op.finalized], [JOURNAL.ordinary_status, true], `${what}: the operation's status, and that it is finalized`);
}

export const revisionsOf = (home, { project, run } = {}) =>
  withStore(home, (db) =>
    db
      .prepare('SELECT * FROM "revisions" WHERE (? IS NULL OR "project" = ?) AND (? IS NULL OR "created_by_run" = ?) ORDER BY "id"')
      .all(project ?? null, project ?? null, run ?? null, run ?? null),
  );

// The registry of a project as {ref: {kind, expected_oid, immutable}}.
export function registryOf(home, project) {
  const out = {};
  for (const row of withStore(home, (db) => db.prepare('SELECT * FROM "ref_registry" WHERE "project" = ?').all(project))) {
    out[row.ref] = { kind: row.kind, expected_oid: row.expected_oid, immutable: row.immutable };
  }
  return out;
}

export const managedCheckouts = (home, project) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "managed_checkouts" WHERE "project" = ? ORDER BY "id"').all(project)).map((row) => ({ ...row, baseline: json(row.baseline) }));

// The out-of-band observations of a project, oldest first, each with its
// decision's status and the keys of the options it offers.
export function outOfBand(home, project) {
  return withStore(home, (db) =>
    db
      .prepare('SELECT * FROM "out_of_band_changes" WHERE "project" = ? ORDER BY "id"')
      .all(project)
      .map((row) => {
        const decision = db.prepare('SELECT * FROM "decisions" WHERE "id" = ?').get(row.decision);
        const ref = row.ref === null ? null : db.prepare('SELECT "ref" FROM "ref_registry" WHERE "id" = ?').get(row.ref)?.ref ?? null;
        const checkout = row.checkout === null ? null : db.prepare('SELECT "path", "kind" FROM "managed_checkouts" WHERE "id" = ?').get(row.checkout) ?? null;
        return {
          id: row.id,
          subject_kind: row.subject_kind,
          ref_name: ref,
          checkout_path: checkout?.path ?? null,
          checkout_kind: checkout?.kind ?? null,
          expected: row.expected,
          found: row.found,
          disposition: row.disposition,
          decision: decision
            ? { id: decision.id, kind: decision.kind, subject_type: decision.subject_type, subject_id: decision.subject_id, status: decision.status, question: decision.question, options: json(decision.options).map((o) => o.key).sort() }
            : null,
        };
      }),
  );
}

export const eventsOfType = (home, type, sinceSeq = 0) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "events" WHERE "type" = ? AND "seq" > ? ORDER BY "seq"').all(type, sinceSeq)).map((e) => ({ ...e, subject: json(e.subject), payload: json(e.payload) }));

export const policyRevisions = (home, project) => withStore(home, (db) => db.prepare('SELECT * FROM "policy_revisions" WHERE "project" = ? ORDER BY "revision"').all(project));

// ---- projects through the public API ---------------------------------------------

// POST /v1/projects and, unless `wait` is false, the wait for the bootstrap
// to finish. Returns {id, res}.
export async function createProject(engine, { repoPath, name = 'api-project', tier = 'T2', branch = 'main', wait = true }) {
  const res = await engine.post('/v1/projects', { name, tier, dev_repo_path: repoPath, integration_branch: branch });
  assert.equal(res.status, 201, `POST /v1/projects (body: ${res.text})`);
  const id = res.body?.project?.id;
  assert.ok(hasIdForm(id, 'proj_'), `the response names the project: ${res.text}`);
  assert.ok(['pending_bootstrap', 'registered'].includes(res.body.project.registration_state), `the response gives the registration state: ${res.text}`);
  if (wait) await waitFor(() => getRow(engine.home, 'projects', id)?.registration_state === 'registered', { what: `project ${id} to be registered` });
  return { id, res };
}

export const getPolicy = async (engine, project) => {
  const res = await engine.get(`/v1/projects/${project}/policy`);
  assert.equal(res.status, 200, `GET policy (body: ${res.text})`);
  return res.body;
};

// A valid policy change, and the wait until its revision is the effective one.
export async function changePolicy(engine, project, change) {
  const before = (await getPolicy(engine, project)).revision ?? 0;
  const res = await engine.post(`/v1/projects/${project}/policy`, change);
  assert.equal(res.status, 200, `a valid policy change (body: ${res.text})`);
  return waitFor(
    async () => {
      const policy = await getPolicy(engine, project);
      return policy.revision === before + 1 ? policy : undefined;
    },
    { what: `policy revision ${before + 1} of ${project} to be effective` },
  );
}

// ---- the two judgements -----------------------------------------------------------

// What a "nothing of this run was accepted" judgement compares: taken before
// the run is released, and again after it has ended.
export function acceptanceState(fx, project) {
  const repo = getRow(fx.home, 'projects', project).dev_repo_path;
  return {
    refs: refsOf(repo),
    registry: registryOf(fx.home, project),
    revisions: revisionsOf(fx.home, { project }).length,
  };
}

// The run's snapshot was committed, exactly (SEAM.md §28). `expect` gives
// `kind` (the revision kind), `parent` (the commit it was made on),
// optionally `changes` ({path: status} against the parent) and `integrated`
// (true: the integration branch is at the commit and the registry expects
// it, and it was moved there from `branchWas`, by default the parent; false:
// the branch is still at `branchAt`). Returns {sha, tree}.
export function assertCommitted(fx, runId, expect) {
  const run = getRow(fx.home, 'runs', runId);
  const what = `run ${runId}`;
  assert.deepEqual([run.state, run.outcome, run.reason_class], ['ended', 'completed', 'none'], `${what}: its end (reason: ${run.reason_text})`);
  const project = getRow(fx.home, 'projects', run.project);
  const repo = project.dev_repo_path;
  const work = getRow(fx.home, 'work_items', run.work_item);
  const ws = getRow(fx.home, 'workspaces', run.workspace);

  const revisions = revisionsOf(fx.home, { run: runId });
  assert.equal(revisions.length, 1, `${what}: exactly one revision recorded for the run`);
  const [revision] = revisions;
  assert.deepEqual({ kind: revision.kind, parent_sha: revision.parent_sha }, { kind: expect.kind, parent_sha: expect.parent }, `${what}: the revision's kind and parent`);
  const sha = revision.sha;
  assert.match(sha, /^[0-9a-f]{40}$/, `${what}: the revision's commit id`);
  assert.deepEqual(parentsOf(repo, sha), [expect.parent], `${what}: the commit's only parent is the base it was validated against`);

  // One tree, four ways: recorded, journaled, committed, and computed here from the workspace.
  const commits = operationsOf(fx.home, { run: runId, journalKind: 'commit_tree' });
  assert.equal(commits.length, 1, `${what}: exactly one commit_tree operation`);
  assertOrdinaryCourse(commits[0], `${what}, its commit`);
  const intent = commits[0].events[0].payload;
  const trees = { recorded: ws.snapshot_tree, journaled: intent.tree, committed: treeOf(repo, sha), computed: snapshotTree(ws.path, expect.parent) };
  assert.deepEqual(trees, { recorded: trees.computed, journaled: trees.computed, committed: trees.computed, computed: trees.computed }, `${what}: the validated, recorded and committed trees are the tree of what the role left`);
  assert.equal(intent.old_oid, expect.parent, `${what}: the commit's journal names its parent`);
  if (expect.changes !== undefined) assert.deepEqual(changedPaths(repo, expect.parent, sha), expect.changes, `${what}: what the commit changes against its parent`);

  const trailers = trailersOf(repo, sha);
  assert.deepEqual(
    { run: trailers['Surety-Run'], role: trailers['Surety-Role'], base: trailers['Surety-Base'], work: trailers['Surety-WorkItem'], kind: trailers['Surety-Kind'] },
    { run: [runId], role: [run.role], base: [expect.parent], work: [run.work_item], kind: [work.kind] },
    `${what}: the commit message's trailers, each exactly once`,
  );

  const registry = registryOf(fx.home, run.project);
  const reachableFrom = refsContaining(repo, sha).filter((ref) => ref in registry);
  assert.ok(reachableFrom.length >= 1, `${what}: the commit is reachable from a registered ref (it is reachable from: ${refsContaining(repo, sha).join(', ') || 'no ref'})`);

  const integrationRef = `refs/heads/${project.integration_branch}`;
  if (expect.integrated === true) {
    assert.equal(refOid(repo, integrationRef), sha, `${what}: the integration branch is at the commit`);
    assert.equal(registry[integrationRef]?.expected_oid, sha, `${what}: the registry expects the integration branch there`);
    const moves = operationsOf(fx.home, { run: runId, journalKind: 'ref_update' });
    assert.equal(moves.length, 1, `${what}: exactly one ref_update operation`);
    assertOrdinaryCourse(moves[0], `${what}, its integration`);
    const move = moves[0].events[0].payload;
    assert.deepEqual({ ref: move.ref, old_oid: move.old_oid, new_oid: move.new_oid }, { ref: integrationRef, old_oid: expect.branchWas ?? expect.parent, new_oid: sha }, `${what}: the ref update's journal`);
    const path = withStore(fx.home, (db) => assertWorkHistory(db, run.work_item));
    const at = path.lastIndexOf('integrating');
    assert.deepEqual([path[at - 1], path[at], path[at + 1]], ['executing', 'integrating', 'integrated'], `${what}: its work item went from executing through integrating to integrated (path ${path.join(' → ')})`);
  } else if (expect.integrated === false) {
    assert.equal(refOid(repo, integrationRef), expect.branchAt, `${what}: the integration branch has not moved`);
    assert.equal(registry[integrationRef]?.expected_oid, expect.branchAt, `${what}: and the registry expects it where it was`);
    assert.equal(operationsOf(fx.home, { run: runId, journalKind: 'ref_update' }).length, 0, `${what}: no ref update was journaled`);
  }
  return { sha, tree: trees.committed, identity: identityOf(repo, sha), workspace: ws };
}

// Nothing of the run was accepted (SEAM.md §28, "A rejected run"). `before`
// is acceptanceState taken while the run was under way; `allow` names refs
// the role itself moved, which the engine neither undoes nor absorbs.
export function assertNothingAccepted(fx, runId, before, { reason, pathInReason, movedByRole = [] } = {}) {
  const run = getRow(fx.home, 'runs', runId);
  const what = `run ${runId}`;
  assert.deepEqual([run.state, run.outcome], ['ended', 'failed'], `${what}: a rejected run ends failed (reason class ${run.reason_class}: ${run.reason_text})`);
  if (reason !== undefined) assert.equal(run.reason_class, reason, `${what}: reason class (${run.reason_text})`);
  assert.ok(typeof run.reason_text === 'string' && run.reason_text.length > 0, `${what}: the rejection says why`);
  if (pathInReason !== undefined) assert.ok(run.reason_text.includes(pathInReason), `${what}: the rejection names the path ${pathInReason} (it says: ${run.reason_text})`);

  const after = acceptanceState(fx, run.project);
  const settle = (refs) => Object.fromEntries(Object.entries(refs).filter(([name]) => !movedByRole.includes(name)));
  assert.deepEqual(settle(after.refs), settle(before.refs), `${what}: no ref was created, moved or deleted by the engine`);
  assert.deepEqual(after.registry, before.registry, `${what}: the registry expects what it expected`);
  assert.equal(after.revisions, before.revisions, `${what}: no revision was recorded`);
  assert.deepEqual(revisionsOf(fx.home, { run: runId }), [], `${what}: no revision names the run`);
  for (const journalKind of ['commit_tree', 'ref_update']) {
    const accepted = operationsOf(fx.home, { run: runId, journalKind }).filter((op) => op.status === 'succeeded');
    assert.deepEqual(accepted.map((op) => op.id), [], `${what}: no ${journalKind} operation of the run succeeded`);
  }
  const ws = getRow(fx.home, 'workspaces', run.workspace);
  assert.equal(ws.disposition, 'retained', `${what}: its workspace is retained`);
  return { run, workspace: { ...ws, resolved: resolvedPath(ws.path) } };
}
