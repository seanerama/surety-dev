// M01, the kernel journey read through the public API (slice 7). Plan §3.1
// M01, "API and event history agree with durable rows"; D1 §11.3; SEAM.md
// §§86, 91, 92, 95; E39.
//
// Nothing new: this is the journey of M01-kernel-journey.test.mjs (slice 5),
// made again by harness/journey.mjs, and observed where a person would
// observe it. That file reads the event history from the store, because the
// public reads did not exist when slice 5 was specified. Slice 6 pins them,
// and this file reads the same journey through them:
//
//   - the event history, from `GET /v1/events` (SEAM.md §92);
//   - the project, from `GET /v1/projects/:p` (§91);
//   - the candidate and its gates, from `GET /v1/projects/:p/candidates/:c`
//     (§95);
//   - the decisions, from `GET /v1/projects/:p/decisions` (§91): at each of
//     the journey's two chain boundaries the decision to answer is found in
//     that read and answered with the preview hash the read showed, not with
//     one taken from the store.
//
// Each of those routes is pinned by its own row (M70, M72, M74). The two
// cases here pin only that what they show of a whole journey is what the
// durable rows hold. The journey is made once, in the `before` hook; if it
// cannot be made, both cases fail.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { maxEventSeq } from './harness/fixtures.mjs';
import { effectiveVersion, sharedFixture } from './harness/gates.mjs';
import { candidatesOf } from './harness/journal.mjs';
import { journey } from './harness/journey.mjs';
import { awayFromMidnight, ledgerRows } from './harness/ledger.mjs';
import { listDecisions, readCandidate, readProject } from './harness/reads.mjs';
import { tickUntil } from './harness/runs.mjs';
import { replayMessages } from './harness/sse.mjs';
import { parseJson, withStore } from './harness/store.mjs';

// What the decisions read showed each time the journey looked for a decision to answer.
const listings = [];

// The open decision of `kind` about `subjectId`, as the decisions read lists
// it: the person at the chain boundary sees it there. Ticks until the engine
// has raised it.
async function listedDecision(fx, project, kind, subjectId) {
  const listed = await tickUntil(
    fx.engine,
    project,
    async () => {
      const { decisions } = await listDecisions(fx.engine, project);
      return decisions.some((shown) => shown.kind === kind && shown.subject_id === subjectId) ? decisions : undefined;
    },
    { max: 4, what: `the decisions read to list an open ${kind} decision about ${subjectId}` },
  );
  listings.push({ subject: subjectId, listed });
  return listed.find((shown) => shown.kind === kind && shown.subject_id === subjectId);
}

describe('M01 the kernel journey, read through the API', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    // The project's spend is read for the engine's current day: the journey is not made across midnight.
    await awayFromMidnight();
    J = await journey(shared.context, { decisionAbout: listedDecision });
  });
  after(() => shared.cleanup());

  test('the event history read from the event stream is the durable event log: every event once, in order, as its row has it', async () => {
    const { fx, project } = J;
    const upTo = maxEventSeq(fx.home);
    const rows = withStore(fx.home, (db) => db.prepare('SELECT "seq", "type", "at", "subject", "payload" FROM "events" WHERE "seq" <= ? ORDER BY "seq"').all(upTo));
    const messages = (await replayMessages(fx.engine)).filter((message) => Number(message.id) <= upTo);

    assert.deepEqual(messages.map((message) => [Number(message.id), message.event]), rows.map((row) => [row.seq, row.type]), 'the stream replays every stored event once, in the order of the log, each under its sequence number and its type');
    const stored = new Map(rows.map((row) => [row.seq, row]));
    for (const message of messages) {
      const row = stored.get(Number(message.id));
      if (message.data === null) continue; // too large for the client to keep; none of the journey's events is expected to be
      assert.ok(message.json, `the data of event ${message.id} is one line of JSON`);
      assert.deepEqual(
        [message.json.seq, message.json.type, message.json.at, message.json.subject, message.json.payload ?? {}],
        [row.seq, row.type, row.at, parseJson(row.subject) ?? {}, parseJson(row.payload) ?? {}],
        `event ${message.id} (${row.type}) is shown as its row has it`,
      );
    }

    // The journey, as a client of the stream alone sees it.
    const shown = (type) => messages.filter((message) => message.event === type);
    const created = shown('project.created');
    const registered = shown('project.registered');
    assert.deepEqual(created.map((message) => [message.json?.subject?.project, message.json?.payload?.test_fixture === true]), [[project.id, false]], 'one project was created, through the public route and not as a fixture');
    assert.ok(registered.length === 1 && registered[0].json?.subject?.project === project.id && Number(registered[0].id) > Number(created[0].id), 'and was registered after it');
    assert.equal(shown('authorization.issued').length, 1, 'one authorization was issued');
    assert.equal(shown('candidate.advanced').length, 0, 'and no candidate advanced');
  });

  test('the decisions, the project and the candidate are read from the API as the durable rows have them', async () => {
    const { fx, project, candidate, verification, reviewed, answered } = J;
    const engine = fx.engine;

    // Decisions. At each chain boundary the read listed the one decision there was to answer, and its answer was accepted with the preview hash the read showed.
    assert.deepEqual(
      listings.map(({ subject, listed }) => [subject, listed.map((shown) => [shown.kind, shown.subject_type, shown.subject_id])]),
      [
        [verification.id, [['blocker', 'work_item', verification.id]]],
        [reviewed.item, [['blocker', 'work_item', reviewed.item]]],
      ],
      "while the candidate's verification, and later its review, waited at the chain boundary, the decisions read listed exactly that one open decision",
    );
    for (const { decision: shown } of answered) {
      assert.ok(shown.options?.some((option) => option.key === 'continue'), `the listed decision offered "continue" (${JSON.stringify(shown.options)})`);
      const row = withStore(fx.home, (db) => db.prepare('SELECT "status", "preview_hash", "question" FROM "decisions" WHERE "id" = ?').get(shown.id));
      assert.deepEqual([row?.status, row?.preview_hash, row?.question], ['consumed', shown.preview_hash, shown.question], 'the decision the read showed is the row that was consumed, with the preview hash and the question shown');
    }
    const open = withStore(fx.home, (db) => db.prepare(`SELECT "id" FROM "decisions" WHERE "project" = ? AND "status" = 'open'`).all(project.id));
    assert.deepEqual([(await listDecisions(engine, project.id)).decisions, open], [[], []], 'at the end of the journey no decision is open, and none is listed');

    // The project: nothing under way, nothing to answer, nothing left to dispatch, and three roles paid for.
    const shown = (await readProject(engine, project.id)).project;
    assert.deepEqual(
      [shown.now?.state, shown.execution?.runs, shown.open_decisions?.count, shown.spend_today?.no_dispatch, shown.spend_today?.invocations],
      ['idle', [], 0, false, 3],
      `the project is idle, with no run under way, no open decision and the three invocations of the journey (NOW gives: ${shown.now?.reason})`,
    );
    assert.equal(ledgerRows(fx.home, project.id).filter((row) => row.corrects === null).length, 3, "which are the ledger's three original rows");

    // The candidate: still developing, under the version it was nominated under, with its two satisfied gates and no successor.
    const row = candidatesOf(fx.home, project.id).find((stored) => stored.id === candidate.id);
    const latest = (kind) => withStore(fx.home, (db) => db.prepare('SELECT "id", "outcome", "stale" FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = ? ORDER BY rowid DESC LIMIT 1').get(candidate.id, kind));
    const read = await readCandidate(engine, project.id, candidate.id);
    assert.deepEqual([read.progress, read.successor ?? null], [row.progress, null], 'the candidate is shown with its stored progress and no successor');
    assert.equal(read.progress, 'developing', 'which is still developing: nothing was deployed');
    assert.deepEqual(read.protected_version, { nominated: row.nominated_protected_version, effective: effectiveVersion(fx.home, project.id).id }, "with the protected version it was nominated under and the project's effective one");
    assert.equal(read.protected_version.effective, read.protected_version.nominated, 'which are one version: no protected change was applied on the way');
    assert.deepEqual(Object.keys(read.gates ?? {}).sort(), ['alpha_authorize', 'stage'], 'with the two gate kinds that were evaluated for it, and no other');
    for (const kind of ['stage', 'alpha_authorize']) {
      const stored = latest(kind);
      assert.deepEqual([read.gates[kind].id, read.gates[kind].outcome, read.gates[kind].stale], [stored.id, stored.outcome, Boolean(stored.stale)], `its ${kind} gate is the latest stored evaluation of that kind`);
      assert.deepEqual([read.gates[kind].outcome, read.gates[kind].stale], ['satisfied', false], `which is satisfied and current, as the ${kind} command answered`);
    }
  });
});
