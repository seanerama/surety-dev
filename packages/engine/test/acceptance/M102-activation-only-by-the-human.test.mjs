// M102, an entry becomes active only by the human's `trust_activation`
// (M2 slice 10, kernel lane). M2 plan §3.1 M102; D2 §4.1, A.4, A.7
// (D2-T02); D1 §10.5; AR B04/N03; CH incident 10; SEAM.md §§116 to 118.
//
// A fixture installs a `proposed` entry with its evidence and raises
// `trust_activation` through the transition a succeeded attempt uses. The
// preview binds the binary and help hashes, the template, the capabilities,
// the profile fingerprint, the host identity, the host's current
// eligibility and the entry's status; the approval makes the entry active
// and launches nothing. No route and no direct write makes an entry active
// otherwise. A dependency that changed between preview and answer, the
// host's eligibility or an evidence record's bytes, stales the answer and
// leaves the entry proposed; a rejection leaves it proposed and closes the
// question; a consumed decision cannot be answered again.
//
// Every case here is expected to fail on the engine these tests were
// written against, which has no trust table (COVERAGE.md, "M2 slice 10").

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { approvalsOf, decision, decisionsOn } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { recordFile, recordRow } from './harness/records.mjs';
import { countOf, runsOfProject } from './harness/runs.mjs';
import {
  BACKENDS,
  answerEngine,
  assertEngineQuestionClosed,
  assertStaleEngineAnswer,
  consumeEngine,
  directUpdateRefused,
  entryShown,
  hostId,
  hostShown,
  installTrustEntry,
  listEngineDecisions,
  nextEngineGeneration,
  openEngineDecision,
  realBackendProject,
  trustEntry,
  trustEvents,
} from './harness/trust.mjs';

const KIND = 'trust_activation';

// The capabilities the fixture entry declares, so the preview can be
// compared with what was installed and not with what the engine says.
const CAPABILITIES = Object.freeze({ tools: ['Read', 'Edit', 'Bash'], denied: ['Agent', 'Task', 'ScheduleWakeup', 'Workflow'], features_disabled: ['background_sessions'], delegation_verified: true });

// A proposed fixture entry and the open trust_activation decision about it.
async function proposedEntry(t) {
  const ctx = await realBackendProject(t);
  const entry = await installTrustEntry(ctx.fx.engine, ctx.standIn, { status: 'proposed', capabilities: CAPABILITIES, profile_fingerprint: 'fixture-profile-m102' });
  const previewed = await openEngineDecision(ctx.fx, ctx.project, KIND, entry.id);
  return { ...ctx, entry, previewed };
}

const nothingLaunched = (fx, standIn, project, what) => {
  assert.equal(runsOfProject(fx.home, project).length, 0, `${what}: no run was created`);
  assert.equal(standIn.launches().length, 0, `${what}: the stand-in binary was not launched`);
  assert.equal(fx.scripted.launches().length, 0, `${what}: no scripted role was launched`);
};

describe('M102 activation only by the human', () => {
  test('(a) the preview binds the hashes, template, capabilities, profile, host identity and eligibility and the entry status; the approval makes the entry active with the decision as its activator, and launches nothing', async (t) => {
    const { fx, standIn, project, entry, previewed } = await proposedEntry(t);
    const row = trustEntry(fx.home, entry.id);
    assert.deepEqual([row.status, row.activated_by, row.binary_path, row.binary_sha256], ['proposed', null, standIn.path, standIn.sha256], 'the fixture is live: a proposed entry bound to the stand-in binary');
    assert.equal(decisionsOn(fx.home, KIND, entry.id).length, 1, 'the fixture raised one trust_activation decision, as a succeeded attempt would');

    const m = previewed.manifest;
    assert.deepEqual(
      { binary: m.binary_sha256, help: typeof m.help_sha256, template: typeof m.template, template_version: m.template_version, capabilities: m.capabilities, profile: m.profile_fingerprint, host: m.host_id, status: m.entry_status, fingerprint: m.evidence_fingerprint },
      { binary: standIn.sha256, help: 'string', template: 'string', template_version: row.template_version, capabilities: CAPABILITIES, profile: 'fixture-profile-m102', host: hostId(), status: 'proposed', fingerprint: row.evidence_fingerprint },
      'the preview binds the entry as installed',
    );
    assert.ok(m.template.length > 0 && m.help_sha256.length === 64, 'the template is the adapter\'s text and the help hash a SHA-256');
    assert.deepEqual({ eligible: m.host_eligibility?.eligible, source: m.host_eligibility?.source }, { eligible: true, source: 'harness' }, 'the host\'s current eligibility is bound, and in the kernel lane it is the harness\'s say-so');
    assert.deepEqual(m.evidence.map((item) => item.record).sort(), [...entry.evidence].sort(), 'the evidence records are bound by id');
    assert.ok(m.evidence.every((item) => item.quarantined === false && item.missing === false), 'each present and clean');
    const listed = await listEngineDecisions(fx.engine);
    assert.deepEqual(listed.decisions.filter((item) => item.id === previewed.id).map((item) => [item.kind, item.subject_type, item.subject_id, item.preview_hash]), [[KIND, 'trust_entry', entry.id, previewed.preview_hash]], 'GET /v1/decisions shows the open engine-scoped decision with the preview hash an answer needs');
    const host = hostShown(await fx.engine.engineInfo());
    assert.deepEqual([host.eligible, host.source, host.row], [true, 'harness', null], 'the engine read agrees: eligible by the harness, with no host_qualifications row');

    await consumeEngine(fx, previewed, 'approve');
    const activated = trustEntry(fx.home, entry.id);
    assert.deepEqual([activated.status, activated.activated_by], ['active', previewed.id], 'the entry is active, activated by that decision');
    assert.equal(approvalsOf(fx.home, previewed.id).length, 1, 'one approval is recorded');
    assert.equal(trustEvents(fx.home, entry.id, 'trust.activated').length, 1, 'one trust.activated names the entry');
    nothingLaunched(fx, standIn, project, 'answering the decision');
    const info = await fx.engine.engineInfo();
    assert.deepEqual([entryShown(info, entry.id).status, entryShown(info, entry.id).activated_by], ['active', previewed.id], 'the engine read shows the entry active and by whom');
    assert.ok(info.backends.includes(BACKENDS.claude), 'the backend is now one the engine would dispatch to');
    assert.deepEqual((await listEngineDecisions(fx.engine)).decisions.filter((item) => item.id === previewed.id), [], 'and the consumed decision is no longer listed');
  });

  test('(b) no route and no direct write sets an entry active: the fixture route installs rows and changes none, and the store refuses status active without an activator', async (t) => {
    const { fx, standIn, entry } = await proposedEntry(t);
    const res = await fx.engine.post('/v1/harness/fixtures/trust-entry', { id: entry.id, backend: BACKENDS.claude, status: 'active', binary: standIn.binary });
    assertRefused(res, 400, 'unknown_field', 'the fixture route given an existing entry to change');
    assert.equal(res.body.subject?.field, 'id', 'it knows no "id": it creates and never updates');
    assert.equal(trustEntry(fx.home, entry.id).status, 'proposed');

    await fx.engine.stop();
    const attempt = directUpdateRefused(fx.home, 'UPDATE "trust_entries" SET "status" = \'active\' WHERE "id" = ?', entry.id);
    assert.equal(attempt.refused, true, `the store refuses status active with no activated_by (${attempt.code})`);
    assert.match(attempt.code, /^SQLITE_CONSTRAINT/, 'with a constraint error, not a silently ignored write');
    assert.deepEqual([trustEntry(fx.home, entry.id).status, trustEntry(fx.home, entry.id).activated_by], ['proposed', null], 'the entry is as it was');
    assert.equal(trustEvents(fx.home, entry.id, 'trust.activated').length, 0, 'and nothing says it was activated');
  });

  test('(c) a dependency changed between preview and answer: the host\'s eligibility lapsed, then an evidence record\'s bytes replaced; each answer is stale and the entry stays proposed', async (t) => {
    const { fx, standIn, project, entry, previewed } = await proposedEntry(t);
    assert.equal(previewed.manifest.host_eligibility.eligible, true, 'the fixture is live: the first preview was taken on an eligible host');

    // 1. The host is no longer eligible: the engine restarts with a check the harness forces to fail.
    await fx.engine.stop();
    await fx.start({ args: ['--harness-host-check', 'H6=failed'] });
    const host = hostShown(await fx.engine.engineInfo());
    assert.deepEqual([host.eligible, host.checks.find((check) => check.id === 'H6')?.result], [false, 'failed'], 'the fixture is live: the engine reports H6 failed and the host not eligible');
    await assertStaleEngineAnswer(fx, previewed, 'approve');
    assert.equal(trustEntry(fx.home, entry.id).status, 'proposed', 'nothing was activated on the earlier preview');
    const second = await nextEngineGeneration(fx, project, previewed, { changed: 'host_eligibility' });
    assert.deepEqual([second.manifest.host_eligibility.eligible, second.manifest.entry_status, second.manifest.evidence_fingerprint], [false, 'proposed', previewed.manifest.evidence_fingerprint], 'the next preview shows the host as it now is, and the rest as it was');

    // 2. An evidence record's bytes are replaced on disk while the engine is
    // stopped; the audit at the next start finds them not to have the
    // recorded hash (SEAM.md §58), and the preview's evidence is stale.
    const [evidenceId] = entry.evidence;
    const record = recordRow(fx.home, evidenceId);
    assert.equal(record?.published, 1, 'the fixture is live: the evidence is a published record');
    await fx.engine.stop();
    writeFileSync(recordFile(fx.home, record), 'the bytes of this evidence record were replaced after the preview\n');
    await fx.start({ args: ['--harness-host-check', 'H6=failed'] });
    await assertStaleEngineAnswer(fx, second, 'approve');
    assert.equal(trustEntry(fx.home, entry.id).status, 'proposed', 'nothing was activated on that preview either');
    const third = await nextEngineGeneration(fx, project, second, { changed: 'evidence' });
    assert.equal(third.manifest.evidence.find((item) => item.record === evidenceId)?.missing, true, 'the next preview says the evidence record is missing');
    assert.equal(third.manifest.host_eligibility.eligible, false, 'and the host is still not eligible');
    assert.equal(standIn.launches().length, 0, 'nothing was launched by any of it');
  });

  test('(d) reject: the entry stays proposed, the decision is closed with the answer recorded, and the question is not raised again at once', async (t) => {
    const { fx, standIn, project, entry, previewed } = await proposedEntry(t);
    assert.deepEqual(previewed.options.map((option) => option.key).sort(), ['approve', 'reject'], 'the fixture is live: the activation offers reject');
    await consumeEngine(fx, previewed, 'reject');
    assert.equal(approvalsOf(fx.home, previewed.id).length, 0, 'a rejection approves nothing');
    assert.deepEqual([trustEntry(fx.home, entry.id).status, trustEntry(fx.home, entry.id).activated_by], ['proposed', null], 'the entry is still proposed');
    await assertEngineQuestionClosed(fx, project, previewed);
    assert.equal(trustEntry(fx.home, entry.id).status, 'proposed', 'and the ticks activated nothing');
    assert.equal(trustEvents(fx.home, entry.id, 'trust.activated').length, 0);
    nothingLaunched(fx, standIn, project, 'rejecting');
    assert.equal(countOf(fx.home, 'decisions', '"kind" = ? AND "subject_id" = ?', KIND, entry.id), 1, 'one decision in all');
  });

  test('(e) answering again: a consumed activation is refused decision_consumed, and the entry is as the first answer left it', async (t) => {
    const { fx, entry, previewed } = await proposedEntry(t);
    await consumeEngine(fx, previewed, 'approve');
    const again = await answerEngine(fx.engine, previewed, 'approve');
    assertRefused(again, 409, 'decision_consumed', 'answering a consumed trust_activation');
    assert.equal(again.body.subject?.decision, previewed.id, 'the refusal names the decision, so a client that lost the first response learns that its answer took effect');
    assert.deepEqual([decision(fx.home, previewed.id).status, trustEntry(fx.home, entry.id).status, trustEntry(fx.home, entry.id).activated_by], ['consumed', 'active', previewed.id]);
    assert.equal(trustEvents(fx.home, entry.id, 'trust.activated').length, 1, 'activated once');
  });
});
