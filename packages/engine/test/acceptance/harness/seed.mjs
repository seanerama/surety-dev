// Rows the store-constraint tests write directly (rows M02, M03, M04). Each
// insert supplies exactly `id`, `created_at`, `project` where the table is
// project-scoped, and the fields D1 A.3 marks required. SEAM.md "Store schema"
// states what the engine's schema must accept.

import { dayUtc, fakeSha, isoNow, newId } from './ids.mjs';

function insert(db, table, row) {
  const cols = Object.keys(row);
  const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  db.prepare(sql).run(...cols.map((c) => row[c]));
  return row;
}

const nextSeq = (db, table, project) =>
  db.prepare(`SELECT COALESCE(MAX("seq"), 1000) + 1 AS n FROM "${table}" WHERE "project" = ?`).get(project).n;

export function seedWorkItem(db, project, { kind = 'stage_build', status = 'executing' } = {}) {
  const id = newId('wi_');
  return insert(db, 'work_items', {
    id,
    created_at: isoNow(),
    project,
    seq: nextSeq(db, 'work_items', project),
    kind,
    subject: '{}',
    status,
    trigger_source: 'test',
    trigger_id: id,
    trigger_generation: 1,
    repair_attempts: 0,
    no_progress_count: 0,
    preflight_refusals: 0,
    dispatch_hold: 0,
  });
}

export function seedRun(db, project, { kind = 'one_shot', role = 'builder', workItem } = {}) {
  const wi = workItem ?? seedWorkItem(db, project).id;
  return insert(db, 'runs', {
    id: newId('run_'),
    created_at: isoNow(),
    project,
    seq: nextSeq(db, 'runs', project),
    work_item: wi,
    role,
    kind,
    state: 'executing',
    backend: 'scripted',
    backend_version: '0',
    model_requested: 'scripted',
    base_revision: fakeSha(),
    deadline_at: isoNow(3_600_000),
    quarantined: 0,
  });
}

export function seedGrant(db, project, run) {
  return insert(db, 'capability_grants', {
    id: newId('grant_'),
    created_at: isoNow(),
    project,
    run,
    capabilities: '[]',
    env_allowlist: '[]',
    issued_at: isoNow(),
    expires_at: isoNow(3_600_000),
  });
}

export function receiptRow(project, run, grant, { turn = null, id = newId('inv_') } = {}) {
  const row = {
    id,
    created_at: isoNow(),
    project,
    run,
    provider: 'scripted',
    model_requested: 'scripted',
    grant,
    budget_snapshot: '{}',
  };
  if (turn !== null) row.turn = turn;
  return row;
}

export const insertReceipt = (db, row) => insert(db, 'invocation_receipts', row);

// A one-shot run with its grant and its single null-turn receipt.
export function seedOneShot(db, project, opts = {}) {
  const run = seedRun(db, project, { ...opts, kind: 'one_shot' });
  const grant = seedGrant(db, project, run.id);
  const receipt = insertReceipt(db, receiptRow(project, run.id, grant.id));
  return { run, grant, receipt };
}

export function seedSessionRun(db, project, opts = {}) {
  const run = seedRun(db, project, { ...opts, kind: 'session' });
  const grant = seedGrant(db, project, run.id);
  return { run, grant };
}

// The circular turn ↔ receipt ↔ domain rows, written in one transaction with
// foreign keys deferred to commit. `receiptRun` lets a test point the receipt
// at a different run than the turn's.
export function seedTurn(db, project, { run, grant, number = 1, receiptRun = run, receiptGrant = grant, domainRun = run }) {
  const turnId = newId('turn_');
  const invId = newId('inv_');
  const domId = newId('dom_');
  const write = db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    insert(db, 'turns', {
      id: turnId,
      created_at: isoNow(),
      project,
      run,
      number,
      invocation: invId,
      domain: domId,
      started_at: isoNow(),
    });
    insertReceipt(db, receiptRow(project, receiptRun, receiptGrant, { turn: turnId, id: invId }));
    insert(db, 'execution_domains', {
      id: domId,
      created_at: isoNow(),
      project,
      run: domainRun,
      invocation: invId,
      status: 'allocated',
    });
  });
  write();
  return { turn: turnId, invocation: invId, domain: domId };
}

export function seedStatusObservation(db, project, invocation, seq = 1) {
  return insert(db, 'invocation_status_observations', {
    id: newId('iso_'),
    created_at: isoNow(),
    project,
    invocation,
    seq,
    status: 'dispatch_started',
    at: isoNow(),
  });
}

export function seedUsageObservation(db, project, invocation, seq = 1) {
  return insert(db, 'usage_observations', {
    id: newId('uo_'),
    created_at: isoNow(),
    project,
    invocation,
    seq,
    semantics: 'cumulative',
    raw: '{"input_tokens":10}',
    at: isoNow(),
  });
}

export function ledgerRow(project, { invocation, run }, extra = {}) {
  return {
    id: newId('led_'),
    created_at: isoNow(),
    project,
    invocation,
    run,
    role: 'builder',
    provider: 'scripted',
    model_requested: 'scripted',
    raw_usage: '{}',
    normalization_version: 'test-1',
    usage_complete: 0,
    cost_status: 'unknown',
    day_utc: dayUtc(),
    ...extra,
  };
}

export const insertLedgerRow = (db, row) => insert(db, 'ledger_rows', row);

export function seedOperation(db, project) {
  const id = newId('op_');
  return insert(db, 'operations', {
    id,
    created_at: isoNow(),
    project,
    seq: nextSeq(db, 'operations', project),
    kind: 'git_ref_update',
    target: '{"repo":"/nonexistent/fixture","ref":"refs/heads/main"}',
    subject: '{}',
    idempotency_key: fakeSha() + fakeSha().slice(0, 24),
    semantic_generation: 1,
    status: 'intended',
    deadline_at: isoNow(60_000),
  });
}

export function seedJournalEvent(db, project, operation, seq = 1) {
  return insert(db, 'git_journal_events', {
    id: newId('gje_'),
    created_at: isoNow(),
    project,
    operation,
    seq,
    journal_kind: 'ref_update',
    event_kind: 'intended',
    payload: '{"repo":"/nonexistent/fixture","ref":"refs/heads/main"}',
  });
}

export function seedEvent(db) {
  const seq = db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "events"').get().n;
  return insert(db, 'events', {
    id: newId('ev_'),
    created_at: isoNow(),
    seq,
    at: isoNow(),
    type: 'engine.tick',
    subject: '{}',
    actor_kind: 'engine',
    payload: '{}',
    tx: newId('tx_'),
  });
}
