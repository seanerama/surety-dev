// Developer tests for E106: a Reviewer's context names each commit of its
// diff's range that the engine or the owner made on no role run's behalf
// (the bootstrap, a policy revision, any other such commit), classified by
// the engine's own `revisions` records (created_by_run null), never by
// trailers; a commit with no record is named as unknown, never left out; the
// diff is unchanged; what cannot be read is unknown, never "none". Against a
// scratch store with the engine's migrations and a scratch git repository.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { contextFacts, revisionRecords } = await import(join(dist, 'store', 'reads.js'));
const { writeContextPackage, engineCommitLines } = await import(join(dist, 'invoke', 'sandbox', 'context.js'));
const { candidateDiff, engineCommitsInRange } = await import(join(dist, 'invoke', 'sandbox', 'prepare.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));

const AT = '2026-10-09T00:00:00.000Z';
const TRAILERS = 'Surety-Engine: bootstrap\nSurety-Project: prj_1';

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// The owner's first commit, the engine's bootstrap and policy commits, and a
// Builder's commit whose message carries the same trailers as the bootstrap.
function repository(t) {
  const dir = scratch(t);
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const g = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' }).trim();
  const commit = (path, text, message) => {
    execFileSync('mkdir', ['-p', dirname(join(repo, path))]);
    writeFileSync(join(repo, path), text);
    g('add', '-A');
    g('commit', '-q', '-m', message);
    return g('rev-parse', 'HEAD');
  };
  const owner = commit('README.md', 'a project\n', 'the owner');
  const bootstrap = commit('.surety/project.json', '{}\n', `bootstrap\n\n${TRAILERS}`);
  const policy = commit('.surety/policy.json', '{"a":1}\n', 'policy');
  const builder = commit('src/greeting.mjs', 'export const greeting = (n) => `Hello, ${n}!`;\n', `the stage\n\n${TRAILERS}`);
  configureGit({ deadlineSeconds: 30, outputCap: 8 << 20, home: dir, incarnation: 'inc_unit' });
  return { dir, repo, owner, bootstrap, policy, builder };
}

function store(t, { tier = 'T1' } = {}) {
  const db = new Database(join(scratch(t), 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_1', ?, 'p', ?, '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
  ).run(AT, tier);
  return db;
}

let n = 0;
const revision = (db, sha, kind, run, project = 'prj_1') => {
  n += 1;
  db.prepare(`INSERT INTO revisions (id, created_at, project, sha, lineage, parent_sha, kind, created_by_run, recorded_at) VALUES (?, ?, ?, ?, 'lin_1', NULL, ?, ?, ?)`).run(`rev_${n}`, AT, project, sha, kind, run, AT);
};
const commitOp = (db, inputs) => {
  n += 1;
  db.prepare(
    `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, deadline_at, finalizer_inputs)
     VALUES (?, ?, 'prj_1', ?, 'git_commit', '{}', '{}', ?, 1, 'succeeded', ?, ?)`,
  ).run(`op_${n}`, AT, n, `key_${n}`, AT, typeof inputs === 'string' ? inputs : JSON.stringify(inputs));
};

test("the records: a commit every revisions row of which names no run is the engine's or the owner's; any row naming a run makes it a role's; the operation names only its purpose", (t) => {
  const db = store(t);
  revision(db, 'b'.repeat(40), 'engine_commit', null);
  commitOp(db, { purpose: 'bootstrap', sha: 'b'.repeat(40) });
  revision(db, 'c'.repeat(40), 'working', 'run_1');
  // An operation claiming no run cannot make a role's recorded commit the engine's.
  commitOp(db, { purpose: 'policy', sha: 'c'.repeat(40) });
  revision(db, 'd'.repeat(40), 'out_of_band', null);
  revision(db, 'e'.repeat(40), 'engine_commit', null);
  revision(db, 'e'.repeat(40), 'nominated', 'run_2');
  revision(db, 'f'.repeat(40), 'engine_commit', null, 'prj_other');
  commitOp(db, 'not json');
  assert.deepEqual(revisionRecords(db, 'prj_1'), {
    ['b'.repeat(40)]: { by_run: false, kinds: ['engine_commit'], purpose: 'bootstrap' },
    ['c'.repeat(40)]: { by_run: true, kinds: ['working'], purpose: 'policy' },
    ['d'.repeat(40)]: { by_run: false, kinds: ['out_of_band'], purpose: null },
    ['e'.repeat(40)]: { by_run: true, kinds: ['engine_commit', 'nominated'], purpose: null },
  });
  assert.deepEqual(revisionRecords(store(t), 'prj_1'), {}, 'no record: an empty map, each commit then unknown');
  const broken = store(t);
  broken.exec('DROP TABLE revisions');
  assert.equal(revisionRecords(broken, 'prj_1'), null, 'records that cannot be read: unknown');
});

test('the range: by the records, the engine\'s and the owner\'s commits are named, a role\'s is not though it carries the same trailers, an unrecorded one is unknown; failed reads are unknown', async (t) => {
  const r = repository(t);
  const records = {
    [r.bootstrap]: { by_run: false, kinds: ['engine_commit'], purpose: 'bootstrap' },
    [r.policy]: { by_run: false, kinds: ['engine_commit'], purpose: 'policy' },
    [r.builder]: { by_run: true, kinds: ['working'], purpose: 'run' },
    ['9'.repeat(40)]: { by_run: false, kinds: ['engine_commit'], purpose: 'policy' },
  };
  const both = [
    { sha: r.bootstrap, purpose: 'bootstrap' },
    { sha: r.policy, purpose: 'policy' },
  ];
  assert.deepEqual(await engineCommitsInRange(r.repo, r.owner, r.builder, records), { state: 'known', commits: both, unrecorded: [], more: false });
  assert.deepEqual(await engineCommitsInRange(r.repo, r.bootstrap, r.builder, records), { state: 'known', commits: [both[1]], unrecorded: [], more: false });
  assert.deepEqual(await engineCommitsInRange(r.repo, r.policy, r.builder, records), { state: 'known', commits: [], unrecorded: [], more: false });
  assert.deepEqual(
    await engineCommitsInRange(r.repo, null, r.builder, records),
    { state: 'known', commits: both, unrecorded: [r.owner], more: false },
    "with no base, every ancestor; the owner's first commit has no record: unknown, not left out",
  );
  const { [r.policy]: _policy, ...withoutPolicy } = records;
  assert.deepEqual(await engineCommitsInRange(r.repo, r.owner, r.builder, withoutPolicy), { state: 'known', commits: [both[0]], unrecorded: [r.policy], more: false }, 'a commit with no record is unknown, never dropped');
  const { [r.builder]: _builder, ...withoutBuilder } = records;
  const unrecordedBuilder = await engineCommitsInRange(r.repo, r.owner, r.builder, withoutBuilder);
  assert.deepEqual(unrecordedBuilder.unrecorded, [r.builder], 'unrecorded, the Builder\'s commit is unknown, never the engine\'s for its trailers');
  assert.deepEqual((await engineCommitsInRange(r.repo, r.owner, r.builder, null)).state, 'unknown');
  assert.equal((await engineCommitsInRange(r.repo, 'a'.repeat(40), r.builder, records)).state, 'unknown', 'a base that cannot be read: unknown');
  assert.equal((await engineCommitsInRange(r.repo, r.owner, 'nope', records)).state, 'unknown');
  assert.equal((await engineCommitsInRange(join(r.dir, 'missing'), r.owner, r.builder, records)).state, 'unknown', 'a repository that cannot be read: unknown');
});

const facts = () => ({
  run: { id: 'run_rev', role: 'reviewer', base_revision: 'a'.repeat(40), content_hash: 'h' },
  work_item: { id: 'wi_rev', kind: 'review', subject: '{}', project: 'prj_1' },
  stage: null,
  requirements: [],
  modules: [],
  phase_plan: null,
  candidate: { id: 'cand_1', revision: 'b'.repeat(40), acceptance_content_hash: 'h' },
  review: { findings: [], assessments: [], signoffs: [], diff_base: { revision: 'a'.repeat(40), from: 'first_recorded_parent' } },
  resumed: null,
});

function reviewerPackage(t, diff) {
  const dir = join(scratch(t), 'context');
  writeContextPackage(dir, { run: 'run_rev', role: 'reviewer', work_item: 'wi_rev', work_kind: 'review', base_revision: 'a'.repeat(40), attempt: null }, facts(), { probe: false, diff });
  return { prompt: readFileSync(join(dir, 'prompt.md'), 'utf8'), review: JSON.parse(readFileSync(join(dir, 'review.json'), 'utf8')), diff: readFileSync(join(dir, 'candidate.diff'), 'utf8') };
}

test("the Reviewer's context names each such commit as the engine's or the owner's under the candidate.diff line; the diff itself is unchanged", async (t) => {
  const r = repository(t);
  const base = await candidateDiff(r.repo, { revision: r.owner, from: 'first_recorded_parent' }, r.builder);
  const engine = await engineCommitsInRange(r.repo, r.owner, r.builder, {
    [r.bootstrap]: { by_run: false, kinds: ['engine_commit'], purpose: 'bootstrap' },
    [r.policy]: { by_run: false, kinds: ['engine_commit'], purpose: 'policy' },
    [r.builder]: { by_run: true, kinds: ['working'], purpose: 'run' },
  });
  const { prompt, review, diff } = reviewerPackage(t, { ...base, engine_commits: engine });
  assert.equal(diff, base.text, 'the diff is unchanged');
  assert.ok(diff.includes('.surety/project.json') && diff.includes('.surety/policy.json') && diff.includes('src/greeting.mjs'));
  const line = prompt.indexOf('- /surety/context/candidate.diff');
  assert.ok(line >= 0);
  assert.ok(prompt.includes(`  - ${r.bootstrap}: the project's bootstrap (\`.surety/project.json\`), the engine's.`));
  assert.ok(prompt.includes(`  - ${r.policy}: a policy revision through the policy route (\`.surety/policy.json\`), the owner's.`));
  assert.ok(prompt.indexOf(r.bootstrap) > line);
  assert.match(prompt, /not the Builder's work to review/);
  // The candidate's revision is named once, on the diff line, as its end;
  // no line calls it the engine's or the owner's.
  for (const line of prompt.split('\n').filter((l) => l.includes(r.builder))) assert.ok(!/engine's|owner's/.test(line), `no line naming the Builder's commit calls it the engine's or the owner's: ${line}`);
  assert.ok(!prompt.includes(`- ${r.builder}:`), "the Builder's commit, though it carries the same trailers, is not listed");
  assert.deepEqual(review.diff.engine_commits, engine, 'review.json carries the same');
});

test('unknown is said as unknown; an unrecorded commit is named as unknown; a known empty range is said so', () => {
  const unknown = engineCommitLines({ state: 'unknown', detail: "the engine's records of the project's commits could not be read" }).join('\n');
  assert.match(unknown, /is unknown: the engine's records of the project's commits could not be read/);
  assert.ok(!/\bno commit\b/.test(unknown));
  assert.match(engineCommitLines({ state: 'known', commits: [], unrecorded: [], more: false }).join('\n'), /no commit in this range was made by the engine or the owner/);
  const partly = engineCommitLines({ state: 'known', commits: [], unrecorded: ['a'.repeat(40)], more: true }).join('\n');
  assert.match(partly, new RegExp(`- ${'a'.repeat(40)}: unknown\\.`));
  assert.match(partly, /who made its older commits is unknown/);
  assert.deepEqual(engineCommitLines(undefined), []);
  assert.match(engineCommitLines({ state: 'known', commits: [{ sha: 'a'.repeat(40), purpose: 'out_of_band' }], unrecorded: [], more: false }).join('\n'), /adopted by the owner, the owner's/);
  assert.match(engineCommitLines({ state: 'known', commits: [{ sha: 'a'.repeat(40), purpose: 'later' }], unrecorded: [], more: false }).join('\n'), /made on no role run's behalf \(later\), the engine's/);
});

test("contextFacts gives a Reviewer the engine's commits, a Verifier none of this", (t) => {
  const db = store(t);
  revision(db, 'b'.repeat(40), 'engine_commit', null);
  commitOp(db, { purpose: 'bootstrap', sha: 'b'.repeat(40) });
  db.prepare(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 1)`).run(AT);
  db.prepare(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_1', ?, 'prj_1', 1, ?, 'lin_1', ?, 'engine_cadence', 'developing')`).run(AT, 'c'.repeat(40), AT);
  const item = (id, seq, kind) =>
    db
      .prepare(
        `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
         VALUES (?, ?, 'prj_1', ?, ?, '{"candidate":"cand_1"}', 'executing', 'test', ?, 1, 0, 0, 0, 0)`,
      )
      .run(id, AT, seq, kind, id);
  const run = (id, seq, wi, role) =>
    db
      .prepare(
        `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, content_hash)
         VALUES (?, ?, 'prj_1', ?, ?, ?, 'one_shot', 'executing', 'scripted', '1', 'm', ?, ?, 0, NULL)`,
      )
      .run(id, AT, seq, wi, role, 'c'.repeat(40), AT);
  item('wi_rev', 1, 'review');
  item('wi_ver', 2, 'verification');
  run('run_rev', 1, 'wi_rev', 'reviewer');
  run('run_ver', 2, 'wi_ver', 'verifier');
  assert.deepEqual(contextFacts(db, { run: 'run_rev' }).review.revision_records, { ['b'.repeat(40)]: { by_run: false, kinds: ['engine_commit'], purpose: 'bootstrap' } });
  assert.equal(contextFacts(db, { run: 'run_ver' }).review.revision_records, undefined);
});
