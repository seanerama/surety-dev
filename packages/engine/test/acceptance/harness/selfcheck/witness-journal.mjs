// The journal of the witness engine (witness-engine.mjs) for the second
// slice-3 session's rows: operations with their attempts and journal events,
// the ordinary course of one through the five boundaries, and the recovery of
// one this incarnation did not see through (SEAM.md §§44 to 46). Like the
// rest of the witness this is NOT the engine and not a design for it. It
// does what the sections ask as plainly as it can, so that rows M26 to M34
// can be shown to be satisfiable and to bite. Each `mutant(...)` is one
// defect a test is meant to catch.
//
// What a journal kind does to git, how its effect is probed and what its
// finalizer writes is the engine file's (`handlers`): this file only knows
// the order of things.

export function makeJournal({ one, all, exec, tx, insert, emit, iso, now, newId, barrier, mutant, raiseDecision, injected, deadlineMs }) {
  const handlers = {};
  // What this incarnation knows of the operations it is carrying out itself:
  // how far each got, so that a step repeated after a failed transaction does
  // not repeat the effect (E28 item 1). An operation that is not here was
  // left by another incarnation, or given up as ambiguous: recovery's.
  const inflight = new Map();
  const failures = new Map();
  const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));

  function load(id) {
    const row = one('SELECT * FROM "operations" WHERE "id" = ?', id);
    const events = all('SELECT * FROM "git_journal_events" WHERE "operation" = ? ORDER BY "seq"', id);
    const attempts = all('SELECT * FROM "operation_attempts" WHERE "operation" = ? ORDER BY "attempt_number"', id);
    return {
      ...row,
      plan: json(row.witness_plan),
      events,
      state: events.at(-1).event_kind,
      journalKind: events[0].journal_kind,
      payload: json(events[0].payload),
      attempts,
      latest: attempts.at(-1) ?? null,
    };
  }
  const subjectOf = (op) => ({ operation: op.id, project: op.project, run: op.payload.run ?? null });
  // A journal event, the projection's move and the event-log row that names
  // them are one transaction (D1 §§3.5, 12.1). The defect
  // `journal_row_outside_tx`: the journal's rows are committed by themselves,
  // so a failure before the event-log row leaves them behind.
  const step = (fn) => (mutant('journal_row_outside_tx') ? fn() : tx(fn));

  // The operation and its `intended` event, in the caller's transaction. An
  // intent is recorded once per key: a repeated intent finds the operation
  // it recorded before.
  function intend({ project, kind, journalKind, key, payload, plan, linkedPrior = null, again = false }) {
    const existing = one('SELECT * FROM "operations" WHERE "idempotency_key" = ?', key);
    if (existing && !again) return existing.id;
    const id = newId('op_');
    insert('operations', {
      id,
      created_at: iso(),
      project,
      seq: one('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "operations" WHERE "project" = ?', project).n,
      kind,
      target: JSON.stringify({ repo: payload.repo ?? null, ref: payload.ref ?? null }),
      subject: '{}',
      idempotency_key: key,
      semantic_generation: 1,
      status: 'intended',
      linked_prior: linkedPrior,
      deadline_at: iso(now() + deadlineMs),
      witness_plan: JSON.stringify(plan ?? {}),
    });
    emit('operation.intended', { operation: id, project, run: payload.run ?? null });
    insert('git_journal_events', { id: newId('gje_'), created_at: iso(), project, operation: id, seq: 1, journal_kind: journalKind, event_kind: 'intended', payload: JSON.stringify(payload) });
    insert('git_journal_state', { id: newId('gjs_'), created_at: iso(), project, operation: id, journal_kind: journalKind, state: 'intended', last_event_seq: 1 });
    emit('git.journal_intended', { operation: id, project, run: payload.run ?? null });
    // A linked successor supersedes the operation it replaces (D1 §4.4).
    if (linkedPrior) exec(`UPDATE "operations" SET "status" = 'superseded' WHERE "id" = ?`, linkedPrior);
    return id;
  }

  // One more journal event, and the projection moved with it in the same
  // transaction (D1 §3.5). The defect `projection_lags`: the projection is
  // not told of the finalizer.
  function append(op, eventKind, extra = {}) {
    const seq = one('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "git_journal_events" WHERE "operation" = ?', op.id).n;
    insert('git_journal_events', { id: newId('gje_'), created_at: iso(), project: op.project, operation: op.id, seq, journal_kind: op.journalKind, event_kind: eventKind, payload: JSON.stringify({ ...op.payload, ...extra }) });
    if (!(mutant('projection_lags') && eventKind === 'finalized')) exec('UPDATE "git_journal_state" SET "state" = ?, "last_event_seq" = ? WHERE "operation" = ?', eventKind, seq, op.id);
    if (eventKind !== 'failed') emit(`git.journal_${eventKind}`, subjectOf(op));
  }
  function setStatus(op, status) {
    exec('UPDATE "operations" SET "status" = ? WHERE "id" = ?', status, op.id);
    if (['succeeded', 'failed', 'ambiguous', 'partial'].includes(status)) emit(`operation.${status}`, subjectOf(op));
  }
  function startAttempt(op) {
    const n = (op.latest?.attempt_number ?? 0) + 1;
    insert('operation_attempts', {
      id: newId('att_'),
      created_at: iso(),
      project: op.project,
      operation: op.id,
      attempt_number: n,
      status: 'started',
      started_at: iso(),
      timeline: JSON.stringify([{ at: iso(), event: 'started', detail: null }]),
      reconciliation_reads: '[]',
    });
    exec(`UPDATE "operations" SET "status" = 'in_progress' WHERE "id" = ?`, op.id);
    emit('operation.attempt_started', subjectOf(op), { attempt: n });
  }
  function setAttempt(attempt, status, reads) {
    const settled = !['started', 'ambiguous'].includes(status);
    exec(
      'UPDATE "operation_attempts" SET "status" = ?, "finished_at" = ?, "reconciliation_reads" = ? WHERE "id" = ?',
      status,
      settled ? iso() : null,
      reads === undefined ? attempt.reconciliation_reads : JSON.stringify(reads),
      attempt.id,
    );
  }
  function fail(op) {
    if (op.latest && op.latest.status === 'started') setAttempt(op.latest, 'failed');
    append(op, 'failed');
    setStatus(op, 'failed');
  }
  function finalize(op) {
    handlers[op.journalKind].finalize(op.plan, op);
    append(op, 'finalized');
    exec('UPDATE "operations" SET "finalized_at" = ? WHERE "id" = ?', iso(), op.id);
    emit('operation.finalized', subjectOf(op));
  }

  // Carry an operation on from wherever its journal says it is. Every step is
  // one transaction; a step that fails throws, and calling this again takes
  // the operation up where it was, without repeating its effect. Resolves
  // with 'finalized', 'failed' or 'ambiguous'. `fenced` says whether the run
  // the operation acts for has had its end decided (D1 §8.3): its effect is
  // then refused before it is made.
  function execute(id, opts = {}) {
    const mem = inflight.get(id) ?? {};
    inflight.set(id, mem);
    if (!mem.promise) {
      mem.promise = carry(id, mem, opts).finally(() => {
        mem.promise = null;
      });
    }
    return mem.promise;
  }
  async function carry(id, mem, { fenced } = {}) {
    for (;;) {
      const op = load(id);
      const h = handlers[op.journalKind];
      const at = (boundary) => `journal.${op.journalKind}.${boundary}`;
      if (op.state === 'finalized' || op.state === 'failed') {
        inflight.delete(id);
        return op.state;
      }
      if (op.state === 'confirmed') {
        step(() => finalize(load(id)));
        await barrier(at('finalizer_committed'));
        continue;
      }
      if (op.state === 'applied') {
        step(() => {
          const fresh = load(id);
          if (fresh.latest && fresh.latest.status === 'started') setAttempt(fresh.latest, 'succeeded');
          append(fresh, 'confirmed', mem.receipt ?? {});
          if (fresh.status !== 'succeeded') setStatus(fresh, 'succeeded');
        });
        await barrier(at('probe_confirmed'));
        continue;
      }
      // `intended`, or `ambiguous` and being taken up again by recovery.
      if (op.state === 'ambiguous' && !mem.resumed) {
        inflight.delete(id);
        return 'ambiguous';
      }
      if (!mem.passedIntent) {
        await barrier(at('intent_committed'));
        mem.passedIntent = true;
        continue;
      }
      if (mem.skipReceipt) {
        // The defect `receipt_not_reconstructed`: an effect found applied is confirmed with no `applied` event before it.
        mem.skipReceipt = false;
        tx(() => {
          const fresh = load(id);
          append(fresh, 'confirmed');
          if (fresh.status !== 'succeeded') setStatus(fresh, 'succeeded');
        });
        continue;
      }
      if (!mem.effectDone) {
        if (!op.latest || ['reconciled_absent', 'reconciled_partial'].includes(op.latest.status)) {
          tx(() => startAttempt(load(id)));
          // The defect `extra_attempt`: the first attempt is admitted twice.
          if (mutant('extra_attempt') && !op.latest) {
            tx(() => {
              const fresh = load(id);
              setAttempt(fresh.latest, 'reconciled_absent', [{ at: iso(), read: fresh.journalKind, result: 'absent', detail: null }]);
              startAttempt(load(id));
            });
          }
          continue;
        }
        const refused = h.refuse ? h.refuse(op.plan, op, { fenced: mem.mode ? false : (fenced?.() ?? false), recovery: Boolean(mem.mode) }) : null;
        if (refused) {
          failures.set(id, refused);
          tx(() => fail(load(id)));
          continue;
        }
        const result = mem.mode === 'complete' ? await h.complete(op.plan, op, mem.found) : mem.mode === 'overwrite' ? await h.overwrite(op.plan, op, mem.found) : await h.effect(op.plan, op);
        if (result === 'ambiguous') {
          // A command that could have written was killed at its deadline.
          tx(() => {
            const fresh = load(id);
            if (fresh.latest) setAttempt(fresh.latest, 'ambiguous');
            if (fresh.state !== 'ambiguous') append(fresh, 'ambiguous');
            setStatus(fresh, 'ambiguous');
          });
          inflight.delete(id);
          return 'ambiguous';
        }
        if (result && result.failed) {
          failures.set(id, result.failed);
          tx(() => fail(load(id)));
          continue;
        }
        mem.effectDone = true;
        mem.receipt = result?.receipt ?? {};
        await barrier(at('effect_applied'));
        // The defect `issued_effect_abandoned`: an effect that was made for a run whose end was decided meanwhile is left unrecorded.
        if (mutant('issued_effect_abandoned') && fenced?.()) {
          inflight.delete(id);
          return 'ambiguous';
        }
      }
      step(() => append(load(id), 'applied', mem.receipt ?? {}));
      await barrier(at('receipt_committed'));
    }
  }

  const openBlocker = (op) => one(`SELECT * FROM "decisions" WHERE "kind" = 'blocker' AND "subject_type" = 'operation' AND "subject_id" = ? AND "status" = 'open'`, op.id);

  // Recovery of one operation this incarnation is not carrying out
  // (correction 14): a confirmed one runs only its finalizer; any other that
  // is not finalized is probed, whether or not a receipt survived, and what
  // the probe found decides the way on. Resolves with 'finalized', 'failed',
  // 'blocked' or 'inflight'.
  async function recover(id) {
    if (inflight.has(id)) return 'inflight';
    let op = load(id);
    if (op.state === 'finalized') {
      if (mutant('recovery_refinalizes')) {
        // The defect: a finalizer that has run is run again.
        tx(() => {
          const fresh = load(id);
          append(fresh, 'finalized');
          emit('operation.finalized', subjectOf(fresh));
        });
      }
      return 'finalized';
    }
    if (op.state === 'failed') return 'failed';
    const h = handlers[op.journalKind];
    if (op.state === 'confirmed') {
      // The defect `recovery_skips_confirmed`: D1 §7.10 as drafted.
      if (mutant('recovery_skips_confirmed')) return 'skipped';
      return execute(id);
    }
    if (op.state === 'applied' && mutant('recovery_skips_applied')) return 'skipped';

    let found;
    // --harness-probe: while the engine runs with it, every probe of that kind reports the outcome given.
    const forced = injected.get(op.journalKind);
    if (forced) found = { outcome: forced, detail: 'injected' };
    else found = await h.probe(op.plan, op);
    let way = h.ways[found.outcome];
    if (mutant('probe_absent_fails') && found.outcome === 'absent') way = 'fail';
    if (mutant('probe_applied_repeats') && found.outcome === 'applied') way = 'retry';
    if (mutant('probe_partial_is_applied') && found.outcome === 'partial') way = 'finalize';
    if (mutant('probe_conflict_overwrites') && found.outcome === 'conflicting') way = 'overwrite';
    if (mutant('probe_unknown_is_absent') && found.outcome === 'unknown') way = 'retry';
    if (mutant('blind_retry') && op.state === 'ambiguous') way = 'blind';
    // Two defects of a withdrawal: the effect is made after all, for nobody; owned residue is left where it was.
    if (mutant('withdrawn_is_retried') && way === 'withdraw') way = found.outcome === 'partial' ? 'complete' : 'retry';
    if (way === 'withdraw' && !mutant('withdraw_leaves_residue')) await h.withdraw(op.plan, op, found);

    const read = { at: iso(), read: op.journalKind, result: found.outcome, detail: found.detail ?? null };
    tx(() => {
      op = load(id);
      const a = op.latest;
      const reads = a ? [...(json(a.reconciliation_reads) ?? []), read] : undefined;
      if (way === 'block') {
        if (a && ['started', 'ambiguous'].includes(a.status)) setAttempt(a, 'ambiguous', reads);
        if (op.state !== 'ambiguous') append(op, 'ambiguous');
        if (op.status !== 'ambiguous') setStatus(op, 'ambiguous');
        if (!openBlocker(op) || mutant('blocker_repeated')) {
          raiseDecision(op.project, 'blocker', 'operation', op.id, ['acknowledge'], `The ${op.journalKind} operation ${op.id} cannot go on: its effect was found ${found.outcome}${found.detail ? ` (${found.detail})` : ''}.`, [], { operation: op.id });
        }
        return;
      }
      const blocker = openBlocker(op);
      if (blocker) {
        exec(`UPDATE "decisions" SET "status" = 'invalidated', "invalidated_reason" = 'the operation was reconciled' WHERE "id" = ?`, blocker.id);
        emit('decision.invalidated', { decision: blocker.id, project: op.project });
      }
      if (way === 'blind') return; // the defect `blind_retry`: a new attempt with nothing reconciled
      const reconciled = way === 'finalize' ? 'reconciled_succeeded' : way === 'complete' || (way === 'withdraw' && found.outcome === 'partial') ? 'reconciled_partial' : 'reconciled_absent';
      if (a && ['started', 'ambiguous', 'failed'].includes(a.status)) setAttempt(a, reconciled, reads);
      if (op.state === 'applied' && way !== 'finalize') append(op, 'ambiguous');
      if (way === 'complete') exec('UPDATE "operations" SET "remaining_scope" = ? WHERE "id" = ?', JSON.stringify(found.remaining ?? { remaining: found.detail ?? 'the rest of the effect' }), id);
      emit('operation.reconciled', subjectOf(op), { result: found.outcome });
      // The defect `interval_status_stale`: between a reconciliation and the retry the operation keeps the status it had.
      if (way === 'finalize') setStatus(op, 'succeeded');
      else if (way === 'fail' || way === 'withdraw') fail(load(id));
      else if (mutant('interval_status_stale')) return;
      else if (way === 'complete') setStatus(op, 'partial');
      else exec(`UPDATE "operations" SET "status" = 'intended' WHERE "id" = ?`, id);
    });
    await barrier(`journal.${op.journalKind}.reconciled`);
    if (way === 'block') return 'blocked';
    if (way === 'fail' || way === 'withdraw') return 'failed';
    const mem = { passedIntent: true, resumed: true };
    if (way === 'finalize') {
      mem.effectDone = true;
      mem.receipt = { reconstructed: true };
      if (mutant('receipt_not_reconstructed') && load(id).state !== 'applied') mem.skipReceipt = true;
    } else if (way === 'blind') {
      mem.mode = 'retry';
      tx(() => {
        const fresh = load(id);
        insert('operation_attempts', { id: newId('att_'), created_at: iso(), project: fresh.project, operation: id, attempt_number: (fresh.latest?.attempt_number ?? 0) + 1, status: 'started', started_at: iso(), timeline: '[]', reconciliation_reads: '[]' });
      });
    } else {
      mem.mode = way;
      mem.found = found;
    }
    inflight.set(id, mem);
    return execute(id);
  }

  // Every operation of a project that is not finalized and not failed, oldest
  // first. Returns what became of each: {id, journalKind, result}.
  async function recoverProject(project, { all: everything = false, skip = () => false } = {}) {
    const out = [];
    const rows = everything
      ? all('SELECT "id" FROM "operations" WHERE "project" = ? ORDER BY "seq"', project)
      : all(`SELECT "id" FROM "operations" WHERE "project" = ? AND "finalized_at" IS NULL AND "status" NOT IN ('failed', 'superseded') ORDER BY "seq"`, project);
    for (const row of rows) {
      if (inflight.has(row.id)) continue;
      const before = load(row.id);
      if (skip(before)) continue;
      let result;
      try {
        result = await recover(row.id);
      } catch (err) {
        process.stderr.write(`journal recovery of ${row.id}: ${err.stack}\n`);
        inflight.delete(row.id);
        result = 'error';
      }
      out.push({ id: row.id, journalKind: before.journalKind, plan: before.plan, result });
    }
    return out;
  }

  // The operations of a project that are blocked: ambiguous, with nothing of
  // this incarnation carrying them on.
  const blockedOf = (project) =>
    all(`SELECT "id" FROM "operations" WHERE "project" = ? AND "finalized_at" IS NULL AND "status" = 'ambiguous'`, project).filter((row) => !inflight.has(row.id));

  return { handlers, inflight, failures, load, intend, execute, recover, recoverProject, blockedOf, append, setStatus };
}
