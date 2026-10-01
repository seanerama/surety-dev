// Witness store states for the slice-2 self-check: rows and events shaped as
// SEAM.md §16 describes a dispatched, an ended and a quarantined run, written
// straight into a scratch database. `tweak` names one defect to build in, so
// the self-check can show that the assertion meant to catch it does.
// This is not a model of the engine and nothing here is a contract.

import { isoNow, newId } from '../ids.mjs';
import { seedGrant, seedRun, seedWorkItem } from '../seed.mjs';

function insert(db, table, row) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
  return row;
}

export function emit(db, type, subject, payload = {}) {
  const seq = db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "events"').get().n;
  insert(db, 'events', {
    id: newId('ev_'),
    created_at: isoNow(),
    seq,
    at: isoNow(),
    type,
    subject: JSON.stringify(subject),
    actor_kind: 'engine',
    payload: JSON.stringify(payload),
    tx: newId('tx_'),
  });
  return seq;
}

const ROLE = { verification: 'verifier', review: 'reviewer', stage_build: 'builder' };

// A work item with its work.* events along `path` (a list of statuses).
export function witnessWork(db, project, { kind = 'verification', path = ['eligible'], rowStatus } = {}) {
  const work = seedWorkItem(db, project, { kind, status: rowStatus ?? path.at(-1) });
  emit(db, 'work.created', { work_item: work.id, project }, { to: path[0] });
  for (let i = 1; i < path.length; i++) emit(db, 'work.advanced', { work_item: work.id, project }, { from: path[i - 1], to: path[i] });
  return work;
}

// phase: 'before_spawn' | 'launched' | 'ended' | 'quarantined'.
export function witnessRun(db, project, phase, { outcome = 'completed', reason = 'none', launched = true, kind = 'verification', tweak = {} } = {}) {
  const incarnation = newId('inc_');
  const subject = (run, work) => ({ run, project, work_item: work });
  const done = phase === 'ended';
  const quarantined = phase === 'quarantined';
  const afterSpawn = phase !== 'before_spawn' && launched;
  const workStatus = { before_spawn: 'claimed', launched: 'executing', ended: 'complete', quarantined: 'executing' }[phase];
  const workPath = { before_spawn: ['eligible', 'claimed'], launched: ['eligible', 'claimed', 'executing'], ended: ['eligible', 'claimed', 'executing', 'complete'], quarantined: ['eligible', 'claimed', 'executing'] }[phase];
  const work = witnessWork(db, project, { kind, path: workPath, rowStatus: tweak.workComplete ? 'complete' : workStatus });
  const run = seedRun(db, project, { kind: 'one_shot', role: tweak.wrongRole ? 'builder' : ROLE[kind], workItem: work.id });
  const state = { before_spawn: 'claimed', launched: 'executing', ended: 'ended', quarantined: 'finalizing' }[phase];
  const base = run.base_revision;
  const grant = seedGrant(db, project, run.id);
  const ws = insert(db, 'workspaces', {
    id: newId('ws_'),
    created_at: isoNow(),
    project,
    run: run.id,
    path: `/nonexistent/workspaces/${run.id}`,
    base_revision: tweak.workspaceOtherBase ? 'f'.repeat(40) : base,
    current_base: base,
    disposition: tweak.workspaceActive ? 'active' : done ? (tweak.workspaceDiscarded ? 'discarded' : 'retained') : quarantined ? (tweak.workspaceRetained ? 'retained' : 'quarantined') : 'active',
  });
  db.prepare(
    `UPDATE "runs" SET "state" = ?, "outcome" = ?, "reason_class" = ?, "finished_at" = ?, "quarantined" = ?, "grant" = ?, "workspace" = ? WHERE "id" = ?`,
  ).run(
    tweak.state ?? state,
    done || quarantined ? outcome : null,
    done || quarantined ? (tweak.wrongReason ? 'human_stop' : reason) : null,
    done && !tweak.noFinishedAt ? isoNow() : null,
    (quarantined && !tweak.notFlagged) || tweak.flagged ? 1 : 0,
    grant.id,
    ws.id,
    run.id,
  );
  if ((done || quarantined) && !tweak.grantLive) db.prepare('UPDATE "capability_grants" SET "revoked_at" = ? WHERE "id" = ?').run(isoNow(), grant.id);

  const receipt = insert(db, 'invocation_receipts', {
    id: newId('inv_'),
    created_at: isoNow(),
    project,
    run: run.id,
    provider: 'scripted',
    model_requested: 'scripted',
    grant: grant.id,
    budget_snapshot: '{}',
  });
  const domain = insert(db, 'execution_domains', {
    id: newId('dom_'),
    created_at: isoNow(),
    project,
    run: run.id,
    invocation: receipt.id,
    status: tweak.domainStatus ?? (done ? 'terminated' : quarantined ? 'quarantined' : afterSpawn ? 'launched' : 'allocated'),
  });
  insert(db, 'process_ownership', {
    id: newId('proc_'),
    created_at: isoNow(),
    project,
    domain: domain.id,
    invocation: receipt.id,
    incarnation,
    pid: afterSpawn || tweak.pidBeforeSpawn ? 4242 : null,
    pgid: afterSpawn ? (tweak.sharedGroup ? 1 : 4242) : null,
    pid_start_time: afterSpawn ? '123456' : null,
    termination_confirmed_at: done && !tweak.noConfirmedAt ? isoNow() : null,
  });

  const statuses = ['dispatch_started'];
  if (afterSpawn) statuses.push('launched');
  if (done) {
    if (launched) statuses.push('ended');
    else statuses.push('refused');
    if (tweak.twoTerminal) statuses.push('unknown');
    if (tweak.refusedAndEnded) statuses.push('refused');
  }
  if (tweak.statuses) statuses.splice(0, statuses.length, ...tweak.statuses);
  statuses.forEach((status, i) =>
    insert(db, 'invocation_status_observations', { id: newId('iso_'), created_at: isoNow(), project, invocation: receipt.id, seq: i + 1, status, at: isoNow() }),
  );
  const charge = (extra = {}) =>
    insert(db, 'ledger_rows', {
      id: newId('led_'),
      created_at: isoNow(),
      project,
      invocation: receipt.id,
      run: run.id,
      role: ROLE[kind],
      provider: 'scripted',
      model_requested: 'scripted',
      raw_usage: '{}',
      normalization_version: 'witness',
      billable_in: tweak.zeroedUsage ? 0 : null,
      cached_in: null,
      out: null,
      usage_complete: tweak.usageComplete ? 1 : 0,
      cost_status: tweak.measuredZero ? 'measured_zero' : 'unknown',
      day_utc: isoNow().slice(0, 10),
      ...extra,
    });
  if ((done && launched && !tweak.noLedger) || tweak.ledgerEarly || (done && !launched && tweak.chargedRefusal)) {
    const original = charge();
    // A correction is not a second charge and must not trip any assertion.
    if (tweak.withCorrection) charge({ corrects: original.id, correction_seq: 1 });
  }

  const lease = (kind, released, closing = 0) =>
    insert(db, 'leases', {
      id: newId('lease_'),
      created_at: isoNow(),
      resource_kind: kind,
      resource_id: run.id,
      owner_incarnation: incarnation,
      generation: 1,
      acquired_at: isoNow(),
      renewed_at: isoNow(),
      expires_at: isoNow(90_000),
      released_at: released ? isoNow() : null,
      closing,
      cleanup_authority: 1,
    });
  if (done) lease('run', !tweak.leaseHeld, 1);
  else if (quarantined) {
    lease('run', !tweak.runLeaseHeld, 1);
    if (!tweak.noReservation) lease('quarantine', false);
  } else lease('run', false, tweak.leaseClosing ? 1 : 0);
  if (done && tweak.reservationHeld) lease('quarantine', false);

  const s = subject(run.id, work.id);
  emit(db, 'run.created', s);
  emit(db, 'run.claimed', s);
  if (afterSpawn && !tweak.skipStarted) emit(db, 'run.started', s);
  if (tweak.extraPath) for (const type of tweak.extraPath) emit(db, type, s);
  if (done || quarantined) {
    if (!tweak.skipFinalizing) emit(db, 'run.finalizing', s);
    if (quarantined) {
      if (!tweak.noQuarantineEvents) {
        emit(db, 'run.quarantined', s);
        emit(db, 'domain.quarantined', { domain: domain.id, run: run.id });
        emit(db, 'engine.quarantine', { run: run.id, project });
      }
      if (!tweak.noBlocker) {
        insert(db, 'decisions', {
          id: newId('dec_'),
          created_at: isoNow(),
          project,
          seq: 1,
          kind: 'blocker',
          subject_type: 'run',
          subject_id: run.id,
          semantic_generation: 1,
          scope: 'run',
          question: 'Termination of this run could not be established.',
          options: '[{"key":"acknowledge"}]',
          dependency_manifest: '{}',
          transition_schema_version: 1,
          preview_hash: 'witness',
          evidence: '[]',
          blocked_while_open: JSON.stringify({ work_items: [work.id] }),
          raised_at: isoNow(),
          status: tweak.blockerConsumed ? 'consumed' : 'open',
        });
      }
    }
    if (done || tweak.endedEvent) {
      if (!tweak.noDomainEvent) emit(db, 'domain.terminated', { domain: domain.id, run: run.id });
      if (tweak.twoDomainEvents) emit(db, 'domain.terminated', { domain: domain.id, run: run.id });
      const payload = { outcome: tweak.eventOutcome ?? outcome };
      if (tweak.recovery) payload.recovery = { incarnation: tweak.recovery };
      if (!tweak.noEndedEvent) emit(db, 'run.ended', s, payload);
      if (tweak.twoEndedEvents) emit(db, 'run.ended', s, payload);
    }
  }
  return { run: run.id, work: work.id, domain: domain.id, receipt: receipt.id, workspace: ws.id, incarnation };
}
