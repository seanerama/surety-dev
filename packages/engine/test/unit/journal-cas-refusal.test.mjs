// Developer test for the driver's ruling on M53 case 8 (slice 37): a ref
// update this incarnation's own finalizer intended (a commit's follow-on) and
// never attempted, whose ref was moved by hand to a commit the engine did not
// put there, is attempted, and git's compare-and-swap refusal is a definite
// failure without effect (compare_and_swap_failed), never an ambiguity. The
// same update found so by recovery after a restart blocks (M29, M70), and
// an outcome the engine does not know (the ref cannot be read) blocks. Real git in a
// scratch repository; a stub runtime records what the driver asks the store.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { configureGit } = await import(join(dist, 'git', 'exec.js'));
const { Journal } = await import(join(dist, 'journal', 'driver.js'));

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 20, home: join(dir, 'home'), incarnation: 'inc_unit' });
  const path = join(dir, 'repo');
  const g = (...a) => execFileSync('git', ['-C', path, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' } }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  const commit = (name) => {
    writeFileSync(join(path, name), `${name}\n`);
    g('add', name);
    g('commit', '-q', '-m', name);
    return g('rev-parse', 'HEAD');
  };
  return { path, g, commit };
}

// A stub of the store side of the driver: one operation, the calls recorded.
function runtime(op) {
  const calls = [];
  // A commit already confirmed, whose finalizer intends op_1 next.
  const commit = { id: 'op_c', project: 'prj_1', kind: 'commit_tree', state: 'confirmed', attempts: [], payload: {}, inputs: { purpose: 'run' } };
  const rt = {
    incarnation: 'inc_unit',
    home: '/nonexistent-home',
    engine: async (name, args) => {
      calls.push(name);
      if (name === 'journal.detail') return args.operation === 'op_c' ? commit : op;
      if (name === 'journal.finalize') {
        commit.state = 'finalized';
        return { revision: 'rev_1', follow: 'op_1' };
      }
      if (name === 'journal.refuse_moved_base') return false;
      if (name === 'journal.start_attempt') {
        op.attempts = [{ attempt_number: 1, status: 'started', incarnation: 'inc_unit' }];
        op.state = 'in_progress';
        return { attempt: 1 };
      }
      if (name === 'journal.failed') {
        op.state = 'failed';
        op.failed = args.detail;
        return null;
      }
      if (name === 'journal.block' || name === 'journal.ambiguous') {
        op.state = 'ambiguous';
        return null;
      }
      return null;
    },
    read: async () => null,
  };
  return { rt, calls };
}

const refUpdate = (path, ref, old, next) => ({
  id: 'op_1',
  project: 'prj_1',
  kind: 'ref_update',
  state: 'intended',
  attempts: [],
  payload: { repo: path, ref, old_oid: old, new_oid: next },
  inputs: { purpose: 'nomination', ref_kind: 'nomination' },
});

test("a never-attempted ref update its own commit's finalizer intended, its ref moved by hand, is attempted, and git's refusal fails it without effect: no ambiguity, no blocker", async (t) => {
  const r = repo(t);
  const H = r.commit('a');
  const N = r.commit('b');
  r.g('update-ref', 'refs/surety/cand/1', H);
  // Moved by hand after the update was intended from H.
  const R = r.commit('c');
  r.g('update-ref', 'refs/surety/cand/1', R);
  const op = refUpdate(r.path, 'refs/surety/cand/1', H, N);
  const { rt, calls } = runtime(op);
  const journal = new Journal(rt);
  assert.equal((await journal.drive('op_c')).end, 'finalized', 'the commit finalized, intending op_1');
  const settled = await journal.drive('op_1');
  assert.equal(settled.end, 'failed');
  assert.equal(op.failed?.reason, 'compare_and_swap_failed', `the detail names the refused swap (${JSON.stringify(op.failed)})`);
  assert.ok(calls.includes('journal.start_attempt'), 'git was asked: the swap was attempted');
  assert.ok(!calls.includes('journal.block') && !calls.includes('journal.ambiguous'), `never blocked or ambiguous (${calls.join(', ')})`);
  assert.equal(r.g('rev-parse', 'refs/surety/cand/1'), R, 'the ref stays where the hand put it');
});

test('the same update found by recovery after a restart (not intended by this incarnation) blocks: nothing is attempted or overwritten (M29)', async (t) => {
  const r = repo(t);
  const H = r.commit('a');
  const N = r.commit('b');
  r.g('update-ref', 'refs/surety/cand/1', H);
  const R = r.commit('c');
  r.g('update-ref', 'refs/surety/cand/1', R);
  const op = refUpdate(r.path, 'refs/surety/cand/1', H, N);
  const { rt, calls } = runtime(op);
  const settled = await new Journal(rt).drive('op_1');
  assert.equal(settled.end, 'blocked');
  assert.ok(calls.includes('journal.block') && !calls.includes('journal.start_attempt'), `blocked, not attempted (${calls.join(', ')})`);
  assert.equal(r.g('rev-parse', 'refs/surety/cand/1'), R);
});

test('a ref update whose ref cannot be read is not attempted: its outcome is unknown, and it blocks', async (t) => {
  const r = repo(t);
  const H = r.commit('a');
  const N = r.commit('b');
  const op = refUpdate(join(r.path, 'not-a-repository'), 'refs/surety/cand/1', H, N);
  const { rt, calls } = runtime(op);
  const settled = await new Journal(rt).drive('op_1');
  assert.equal(settled.end, 'blocked');
  assert.ok(calls.includes('journal.block'), `blocked as ambiguous (${calls.join(', ')})`);
  assert.ok(!calls.includes('journal.start_attempt'), 'nothing was attempted');
});
