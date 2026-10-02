// M64, streaming redaction and a later detector (slice 4). Plan §3.6 M64; D1
// §§14.2, 17(5), D1-16; E16c; SEAM.md §57.
//
// A secret the engine holds never reaches its disk or its API, wherever the
// role's output happens to be cut: between two writes, at the boundary of a
// stored chunk, or inside a multibyte character; and in whatever form the
// role's output encodes it: a secret with a character JSON escapes, sent
// inside a JSON protocol line, is on the wire in its escaped form (the
// slice-4 review; E37 item 2). A detector registered later is run over what
// is already stored; a record it matches is marked and is no longer served.
// Every secret here is synthetic.
//
// Deferred (COVERAGE.md): the Critical finding a later hit raises and the
// quarantine of evidence and gates that depend on the record, to slice 5;
// the event stream and the output tail, which do not exist yet, to slice 6.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { CHUNK_MAX, assertRecordsSound, filesHolding, holdSecret, readRecord, registerDetector, waitForPostScan } from './harness/records.mjs';
import { addProject, addWork, assertRunEnded, runsOf, scriptedEngine, tickUntil, workItem } from './harness/runs.mjs';
import { VALID_RESULT, script, step } from './harness/scripted.mjs';

const SECRET = 'SURETY-SYNTHETIC-SECRET-4f9a1c7e2b6d';
const MULTIBYTE_SECRET = 'clé-synthétique-ß9Zq7-ünïcode-3d8e5a';
// Two secrets with a character that a JSON string must escape.
const QUOTE_SECRET = 'SURETY-SYNTHETIC"QUOTE-secret-7731c2';
const BACKSLASH_SECRET = 'SURETY-SYNTHETIC\\BACKSLASH-secret-90d4e1';

// The forms in which a role's output can carry a secret: as it is, and as a
// JSON string holds it. They differ only for a secret with a character JSON
// escapes.
const formsOf = (secret) => [...new Set([secret, JSON.stringify(secret).slice(1, -1)])];

// One verification run with `steps`, in an engine that holds `secret` (one
// value, or several). Returns what the checks need.
async function runHolding(t, secret, steps, result = VALID_RESULT) {
  const fx = await scriptedEngine(t);
  const project = (await addProject(fx)).id;
  for (const [i, value] of [secret].flat().entries()) await holdSecret(fx.engine, i === 0 ? 'FIXTURE_SECRET' : `FIXTURE_SECRET_${i + 1}`, value);
  const item = await addWork(fx.engine, project, 'verification');
  fx.scripted.script(item, [{ steps: [...steps, step.result(result)] }]);
  await tickUntil(fx.engine, project, () => workItem(fx.home, item).status === 'complete', { what: 'the item to complete' });
  const [run] = runsOf(fx.home, item);
  assertRunEnded(fx.home, run.id, { outcome: 'completed' });
  return { fx, project, run };
}

// The secret (one value, or several) is nowhere under the engine home and in
// nothing the API returns about the run, in neither of its forms; the text
// around it is retained; the post-write scan is clean.
async function assertRedacted({ fx, project, run }, secret, around) {
  await waitForPostScan(fx.home, run.transcript, 'clean');
  await waitForPostScan(fx.home, run.result, 'clean');
  const forms = [secret].flat().flatMap(formsOf);
  for (const form of forms) assert.deepEqual(filesHolding(fx.home, form), [], `no file under the engine home holds the secret, here in the form ${JSON.stringify(form)}: not the store, not a record, not a log`);
  assertRecordsSound(fx.home, project);
  const transcript = await readRecord(fx.engine, project, run.transcript);
  assert.equal(transcript.status, 200, `GET the transcript (body: ${transcript.text.slice(0, 200)})`);
  for (const form of forms) assert.ok(!transcript.text.includes(form), `the transcript the API serves does not hold the secret, here in the form ${JSON.stringify(form)}`);
  for (const text of around) assert.ok(transcript.text.includes(text), `the text around the secret is retained: ${JSON.stringify(text)}`);
  for (const path of [`/v1/projects/${project}/runs/${run.id}`, `/v1/projects/${project}/records/${run.result}`]) {
    const res = await fx.engine.get(path);
    assert.equal(res.status, 200, `GET ${path}`);
    for (const form of forms) assert.ok(!res.text.includes(form), `GET ${path} does not return the secret, here in the form ${JSON.stringify(form)}`);
  }
}

describe('M64 a secret the engine holds is redacted before it is stored or served', () => {
  test('across chunk boundaries: split between two writes of the role, and across the boundary of a stored chunk', async (t) => {
    const lead = `before ${SECRET} after\n`;
    const steps = [
      // The secret arrives in two pieces, with a pause between them.
      step.stdout(`before ${SECRET.slice(0, 15)}`),
      step.sleep(400),
      step.stdout(`${SECRET.slice(15)} after\n`),
      // Then filler up to ten bytes short of the first megabyte, so that the secret's second occurrence straddles it.
      step.stdoutFill(CHUNK_MAX - Buffer.byteLength(lead) - 10),
      step.stdout(`${SECRET}\nend of output\n`),
    ];
    const seen = await runHolding(t, SECRET, steps, { status: 'completed', summary: `done; the token was ${SECRET}` });
    await assertRedacted(seen, SECRET, ['before ', ' after\n', 'end of output\n']);
  });

  test('across a multibyte boundary: the role\'s write ends inside a character of the secret', async (t) => {
    const bytes = Buffer.from(`x ${MULTIBYTE_SECRET} y\n`);
    const cut = bytes.indexOf(Buffer.from('é')) + 1;
    assert.equal(bytes[cut - 1], 0xc3, 'the fixture cuts between the two bytes of é');
    const steps = [step.stdoutBytes(bytes.subarray(0, cut)), step.sleep(400), step.stdoutBytes(bytes.subarray(cut))];
    const seen = await runHolding(t, MULTIBYTE_SECRET, steps);
    await assertRedacted(seen, MULTIBYTE_SECRET, ['x ', ' y\n']);
  });

  test('inside a JSON protocol line: a secret with a quote and one with a backslash, which the line carries escaped, are stored and served in neither form', async (t) => {
    // The role's result line is JSON: on the role's standard output the quote
    // is \" and the backslash is \\, so neither secret is there byte for byte.
    const result = { status: 'completed', summary: `quoted: ${QUOTE_SECRET} ; backslashed: ${BACKSLASH_SECRET} ; end of summary` };
    for (const secret of [QUOTE_SECRET, BACKSLASH_SECRET]) assert.equal(formsOf(secret).length, 2, 'the fixture: the escaped form differs from the secret itself');
    const seen = await runHolding(t, [QUOTE_SECRET, BACKSLASH_SECRET], [step.stdout('a plain line\n')], result);
    await assertRedacted(seen, [QUOTE_SECRET, BACKSLASH_SECRET], ['a plain line\n', 'quoted: ', ' ; backslashed: ', ' ; end of summary']);
  });
});

describe('M64 a detector registered later', () => {
  test('is run over the records already stored: the record it matches is marked as a hit and no longer served, and the others are untouched', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const matching = await addWork(fx.engine, project, 'verification');
    const other = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(matching, [script.complete([step.stdout('ticket MARKER-482913 filed\n')])]);
    fx.scripted.script(other, [script.complete([step.stdout('nothing to see\n')])]);
    await tickUntil(fx.engine, project, () => [matching, other].every((id) => workItem(fx.home, id).status === 'complete'), { what: 'both items to complete' });
    const [hit, clean] = [matching, other].map((item) => runsOf(fx.home, item)[0].transcript);
    for (const id of [hit, clean]) await waitForPostScan(fx.home, id, 'clean');
    assert.equal((await readRecord(fx.engine, project, hit)).status, 200, 'before the detector exists the record is served');

    await registerDetector(fx.engine, 'fixture-marker', 'MARKER-[0-9]{6}');
    await waitForPostScan(fx.home, hit, 'hit');
    assert.deepEqual(eventsOfType(fx.home, 'record.secret_found').map((e) => e.subject.record), [hit], 'one record.secret_found, for the record that matched');
    assertRefused(await readRecord(fx.engine, project, hit), 409, 'record_quarantined', 'reading a record a detector matched');
    await waitForPostScan(fx.home, clean, 'clean');
    assert.equal((await readRecord(fx.engine, project, clean)).status, 200, 'a record the detector does not match is still served');
  });
});
