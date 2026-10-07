// M218, output and evidence presence (M3 slice 18; sandbox lane; a
// destructive file, listed last but one in its slice). M3 plan §3.4 M218;
// D3-R10; D3 §2.6 ("Output"); D1 §9.3 input 8, §14.2; T09; SEAM.md §§57,
// 152, 203, 207. Case (e)'s other half, a record removed after recording,
// is `M218-evidence-missing-apart-from-the-finding.test.mjs` (kernel lane).
//
// One candidate, four checks, `output_max_bytes` 4096, run one at a time:
//   (a), (b), (f) `flood`  64 MiB of 1 KiB lines, alternately on standard
//        output and standard error, then exit 0: the record keeps the
//        stream's first and last 2048 bytes and counts what it dropped; the
//        kept lines are in the order written, both streams in one; the
//        program's own exit at the end of the flood does not stall.
//   (f) `cut`  16 GiB of the same, `timeout_s` 12: the engine ends it at its
//        deadline during the flood, without stalling; the record is bounded.
//   (c) `silent`  writes nothing and exits 0: an empty output record.
//   (d), (e) `secret`  prints a value the engine holds as a secret, exit 0:
//        the publication is refused, `evidence.secret_refused`, the Critical
//        finding; no raw secret in what the engine publishes, derives or
//        serves; every
//        evaluation selecting the result carries EVIDENCE_MISSING naming it,
//        apart from the finding.
// No output changes a field of a result.
//
// SAFETY (E64; BS3 §4 rule 1): `flood` and `print` are guarded modes of the
// test's check program (SEAM.md §§198, 207); the test releases each only
// after reading its containment from the host. The flood is bounded (16 GiB
// at most, ended by the engine at 12 s) and the init keeps at most 4 KiB of
// it: nothing fills storage. The secret is synthetic.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { alphaTarget, findingsOf, reasonSubjects, sharedFixture, stageGate } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { filesHolding, holdSecret } from './harness/records.mjs';
import { withStore } from './harness/store.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import {
  GOVERNED_FILE,
  buildStage,
  checkProject,
  defPath,
  guardArgs,
  heldExecution,
  holdArgs,
  installCheckProgram,
  outputText,
  qualifyRunnerByFixture,
  resultRow,
  sandboxGoverned,
  smoke,
  waitRecorded,
} from './harness/checks/fixtures.mjs';
import { releaseContained } from './harness/checks/execution.mjs';

const OUTPUT_MAX = 4096;
const LINE = 1024;
const FLOOD_BYTES = 64 * 1024 * 1024;
const CUT_BYTES = 16 * 1024 * 1024 * 1024;

// The stream the program writes in flood mode after its hold (SEAM.md §207),
// as one string: the release line, then the numbered lines.
const floodLine = (seq) => {
  const stream = seq % 2 === 0 ? 'O' : 'E';
  const head = `${stream} ${String(seq).padStart(10, '0')} `;
  return `${head}${(stream === 'O' ? 'o' : 'e').repeat(LINE - head.length - 1)}\n`;
};
const releasedLine = (name) => `SURETY-CHECK released ${name}\n`;
function floodHead(name, bytes) {
  let s = releasedLine(name);
  for (let seq = 0; s.length < bytes; seq++) s += floodLine(seq);
  return s.slice(0, bytes);
}
function floodTail(totalLines, bytes) {
  let s = '';
  for (let seq = totalLines - 1; s.length < bytes && seq >= 0; seq--) s = floodLine(seq) + s;
  return s.slice(s.length - bytes);
}

async function history(t) {
  const fx = await sandboxEngine(t, { config: { terminate_grace: 3, kill_grace: 2 } });
  const prog = installCheckProgram(fx.root);
  await qualifyRunnerByFixture(fx.engine);
  const secret = `sk-m218-check-${randomBytes(12).toString('hex')}`;
  await holdSecret(fx.engine, 'm218/secret', secret);
  const command = {
    flood: ['probe', ...holdArgs(prog, 'flood'), ...guardArgs(), 'flood', String(FLOOD_BYTES)],
    cut: ['probe', ...holdArgs(prog, 'cut'), ...guardArgs(), 'flood', String(CUT_BYTES)],
    silent: ['probe', 'exit', '0'],
    secret: ['probe', ...holdArgs(prog, 'secret'), ...guardArgs(), 'print', `the token is ${secret} here`],
  };
  const files = { [GOVERNED_FILE]: sandboxGoverned(prog, { result_collection: { output_max_bytes: OUTPUT_MAX } }) };
  for (const [key, c] of Object.entries(command)) files[defPath(key)] = smoke(key, { command: c, timeout: key === 'cut' ? 12 : 120 });
  const project = await checkProject(fx, { files });
  const { stage, candidate } = await buildStage(fx, project);

  const pending = { flood: 'flood', cut: 'cut', secret: 'secret' };
  while (Object.keys(pending).length > 0) {
    const held = await heldExecution(fx, project.id, candidate.id, pending);
    releaseContained(prog, held, held.key);
    delete pending[held.key];
  }
  const recorded = await waitRecorded(fx, project.id, candidate.id, Object.keys(command), { what: 'every check, the floods included, to be recorded without stalling' });
  const ctx = { project, stage, candidate };
  const stageEval = await stageGate(fx, ctx);
  const alphaEval = await (await alphaTarget(fx, ctx)).evaluate();
  return { fx, project, candidate, secret, recorded, stageEval, alphaEval };
}

describe('M218 output and evidence presence', () => {
  const shared = sharedFixture();
  let H;
  before(async () => {
    H = await history(shared.context);
  });
  after(() => shared.cleanup());

  const result = (key) => resultRow(H.fx.home, H.recorded[key].result);

  test("(a), (b) a flood past output_max_bytes: the first and last halves kept, in the order written, both streams in one; the drop counted; the program's own exit at its end did not stall", () => {
    const r = result('flood');
    assert.deepEqual([r.execution_established, r.exit_status, r.signaled, r.deadline_hit], [1, 0, 0, 0], 'established, exit 0: the flood changed no field of the result');
    const text = outputText(H.fx.home, r);
    const total = releasedLine('flood').length + FLOOD_BYTES;
    assert.ok(text.startsWith(floodHead('flood', OUTPUT_MAX / 2)), `(a) the record begins with the stream's first ${OUTPUT_MAX / 2} bytes (it begins ${JSON.stringify(text.slice(0, 120))})`);
    assert.ok(text.endsWith(floodTail(FLOOD_BYTES / LINE, OUTPUT_MAX / 2)), `(a) and ends with its last ${OUTPUT_MAX / 2} bytes (it ends ${JSON.stringify(text.slice(-120))})`);
    assert.ok(text.length <= OUTPUT_MAX + 256, `(a) it holds the two halves and at most a short marker between them (${text.length} bytes)`);
    assert.equal(r.output_dropped_bytes, total - OUTPUT_MAX, '(a) the drop is counted exactly');
    const kept = text.split('\n').filter((l) => /^[OE] \d{10} /.test(l));
    const head = kept.filter((l) => text.indexOf(l) < OUTPUT_MAX / 2).map((l) => [l[0], Number(l.slice(2, 12))]);
    assert.ok(head.some(([s]) => s === 'O') && head.some(([s]) => s === 'E'), '(b) standard output and standard error are both in the one record');
    assert.deepEqual(head.map(([, n]) => n), head.map((_, i) => i), '(b) interleaved in the order the program wrote them');
  });

  test('(f) the engine ends a flood at its deadline without stalling; the record is bounded', () => {
    const r = result('cut');
    assert.deepEqual([r.execution_established, r.exit_status, r.deadline_hit, r.signaled], [1, null, 1, 1], 'ended at its deadline during the flood');
    const text = outputText(H.fx.home, r);
    assert.ok(text.startsWith(floodHead('cut', OUTPUT_MAX / 2)), 'the record begins with the stream\'s first half');
    assert.ok(text.length <= OUTPUT_MAX + 256, `bounded (${text.length} bytes)`);
    assert.ok(r.output_dropped_bytes > 0 && r.output_dropped_bytes < CUT_BYTES, `the fixture is live: the flood was cut short (dropped ${r.output_dropped_bytes} of ${CUT_BYTES})`);
  });

  test('(c) no output: an empty output record', () => {
    const r = result('silent');
    assert.deepEqual([r.execution_established, r.exit_status], [1, 0]);
    assert.equal(outputText(H.fx.home, r), '', 'the established result names its output record, and it is empty');
  });

  test('(d) a held secret printed: the publication refused, evidence.secret_refused, the Critical finding; no raw secret written or served', async () => {
    const r = result('secret');
    assert.deepEqual([r.execution_established, r.exit_status], [1, 0], 'the result is recorded as observed: no output changes a field');
    assert.equal(r.output, null, 'the refused record is not named (SEAM.md §207)');
    const refused = eventsOfType(H.fx.home, 'evidence.secret_refused').filter((e) => e.subject?.check_execution === H.recorded.secret.id);
    assert.equal(refused.length, 1, 'one evidence.secret_refused names the check execution');
    assert.equal(refused[0].payload?.what, 'check_output');
    const critical = findingsOf(H.fx.home, H.project.id).filter((f) => f.category === 'security' && f.effective_severity === 'critical' && f.status === 'open');
    assert.equal(critical.length, 1, `the Critical security finding is raised (D1 §14.2) (${JSON.stringify(findingsOf(H.fx.home, H.project.id).map((f) => [f.category, f.effective_severity]))})`);
    // The definition that names the program's argument is the test's own
    // protected text, stored as discovery read it; what must hold no raw
    // secret is everything the engine publishes or derives from the output.
    assert.deepEqual(filesHolding(join(H.fx.home, 'records'), H.secret), [], 'host-read: no published record holds the raw secret');
    const derived = withStore(H.fx.home, (db) => [
      ...db.prepare('SELECT "subject", "payload" FROM "events"').all(),
      ...db.prepare('SELECT * FROM "check_results" WHERE "project" = ?').all(H.project.id),
      ...db.prepare('SELECT "init_reports", "status", "not_run_reason" FROM "check_executions" WHERE "candidate" = ?').all(H.candidate.id),
      ...db.prepare('SELECT * FROM "findings" WHERE "project" = ?').all(H.project.id),
    ]);
    assert.ok(!JSON.stringify(derived).includes(H.secret), 'no event, result, execution or finding holds the raw secret');
    for (const path of [`/v1/projects/${H.project.id}/candidates/${H.candidate.id}/checks`, `/v1/projects/${H.project.id}/candidates/${H.candidate.id}/gates/stage`]) {
      const res = await H.fx.engine.get(path);
      assert.equal(res.status, 200, path);
      assert.ok(!res.text.includes(H.secret), `${path} serves no raw secret`);
    }
  });

  test('(e) a refused record: EVIDENCE_MISSING on every evaluation that selects the result, asserted apart from the finding', () => {
    const r = result('secret');
    for (const [what, evaluation] of [['stage', H.stageEval], ['alpha_authorize', H.alphaEval]]) {
      assert.equal(evaluation.outcome, 'not_satisfied', what);
      assert.ok(reasonSubjects(evaluation, 'EVIDENCE_MISSING').includes(r.id), `${what}: EVIDENCE_MISSING names the result whose record was refused (SEAM.md §207), whatever else blocks (reasons ${JSON.stringify(evaluation.reasons)})`);
    }
  });
});
