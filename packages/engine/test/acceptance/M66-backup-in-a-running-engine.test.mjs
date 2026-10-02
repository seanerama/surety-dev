// M66, the backup a running engine takes (slice 6; the slice-6 review). Plan
// §3.6 M66; D1 §§6.5, 7.1; E37 item 4; E42 items 2 and 3; SEAM.md §§59, 93.
//
// Slice 4 pinned `surety store backup`, which runs while no engine holds the
// home. A running engine takes the same backup as its own job, started here
// through the harness route. The rule is one rule for both: a backup is
// `complete` only if every commit its manifest lists is in the repository,
// and whether a commit is there is what git says, asked by the engine within
// the git deadline. The engine does not read a repository's object files
// itself: those are files a role can write.
//
// Two things the slice-6 review found by running the engine, each a case:
//
//   - a commit whose object does not have the content its name stands for
//     was reported present, and a backup that could not be restored was
//     labelled complete;
//   - a file in the repository's pack directory, named as a pack index and
//     being a link to /dev/zero or a named pipe, exhausted the engine's
//     memory or held the backup for ever.
//
// A backup that ends is one `engine.backup` event, whatever it found. What a
// label must be is taken from git, asked by the test under the same deadline,
// never from the engine. Every wait and duration is monotonic.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, test } from 'node:test';
import { deflateSync } from 'node:zlib';

import { STORE_REFUSED, storeCommand } from './harness/backup.mjs';
import { maxEventSeq } from './harness/fixtures.mjs';
import { gitEnv } from './harness/git.mjs';
import { addGitProject, addItem, permittedEdit, roleThat } from './harness/gitruns.mjs';
import { eventsOfType, revisionsOf } from './harness/journal.mjs';
import { Control, LIMITS, MIB, assertWithinBound, mib, residentMemory, sample, summary } from './harness/load.mjs';
import { now, sleep, until } from './harness/mono.mjs';
import { gitQuiet } from './harness/repos.mjs';
import { pauseProject, scriptedEngine, tickOnce, waitForRun } from './harness/runs.mjs';

const LABELS = ['complete', 'incomplete_for_recovery'];

// The engine's git deadline in the cases where git is made to wait, in seconds.
const GIT_DEADLINE_S = 2;
// What a backup may take beyond the git deadlines it has to sit out: the copy
// of a store of well under a megabyte and of two small records, on a host
// that may be busy with other things.
const ALLOWANCE_MS = 30_000;
// How far the engine's peak resident memory may rise while it takes a backup
// of this home. What a backup has to hold here is small: a store of well
// under a megabyte, two records of a few hundred bytes, and git's answers,
// which are capped (git_output_cap, 8 MiB by default). The bound is 256 MiB,
// the figure SEAM.md §93 already uses for an engine that keeps what it reads;
// nothing legitimate comes near it. The engine the review ran rose from
// 104 MB past 2 GB in two and a half seconds, so it crosses this bound in a
// fraction of a second, and the case kills it there.
const MEMORY_RISE_BOUND = 256 * MIB;

// An engine with one project whose history is worth a backup: a Builder's
// run that left a transcript and a result and whose commit is a checkpoint.
// The project is paused, so nothing more is dispatched.
async function projectWithHistory(t, config = {}) {
  const fx = await scriptedEngine(t, { config });
  const project = await addGitProject(fx);
  const item = await addItem(fx, project.id, 'fix');
  fx.scripted.script(item, [roleThat([permittedEdit()], { checkpoint: true })]);
  await tickOnce(fx.engine, project.id);
  const run = await waitForRun(fx.home, item, { state: 'ended' });
  assert.equal(run.outcome, 'completed', 'the fixture run completed');
  await pauseProject(fx.engine, project.id);
  const [checkpoint, ...others] = revisionsOf(fx.home, { run: run.id }).map((revision) => revision.sha);
  assert.ok(checkpoint !== undefined && others.length === 0, 'the fixture run recorded one commit');
  return { fx, project, repo: project.repo.path, checkpoint };
}

// Start the running engine's backup (SEAM.md §93). Returns where the event
// log stood and when the request was answered.
async function startBackup(engine) {
  const since = maxEventSeq(engine.home);
  const res = await engine.post('/v1/harness/backup', {});
  assert.equal(res.status, 202, `POST /v1/harness/backup is answered at once (body: ${res.text})`);
  return { since, at: now() };
}

// The `engine.backup` events after `since`.
const backupsEnded = (home, since) => eventsOfType(home, 'engine.backup', since);

// What an `engine.backup` event carries (SEAM.md §93): a label of the two,
// and the directory the backup left, absolute, or null if it left none.
function assertBackupEvent(event) {
  const { backup, label } = event.payload ?? {};
  assert.ok(LABELS.includes(label), `engine.backup carries a label, one of ${LABELS.join(', ')} (payload: ${JSON.stringify(event.payload)})`);
  assert.ok(backup === null || (typeof backup === 'string' && isAbsolute(backup)), `engine.backup names the directory the backup left, absolute, or null (payload: ${JSON.stringify(event.payload)})`);
  if (label === 'complete') assert.ok(typeof backup === 'string', `a complete backup names its directory (payload: ${JSON.stringify(event.payload)})`);
  return { payload: event.payload, manifest: manifestOf(event.payload.backup) };
}

// Start a backup and wait for it to end. Returns {payload, manifest, ms};
// `manifest` is null if the backup left no directory.
async function takeBackup(engine, { withinMs, what }) {
  const { since, at } = await startBackup(engine);
  const ended = await until(() => backupsEnded(engine.home, since)[0], { timeoutMs: withinMs, intervalMs: 25, what: `${what} to end (an engine.backup event)` });
  return { ...assertBackupEvent(ended), ms: Math.round(now() - at) };
}

const manifestOf = (dir) => (dir === null || !existsSync(join(dir, 'manifest.json')) ? null : JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));

// The commits a manifest lists for the project.
const listedFor = (manifest, project) => manifest.git.find((entry) => entry.project === project)?.objects ?? [];

// A backup that ended without being complete says so everywhere: in its
// event, and in whatever it left under backups/. `complete` names the
// directories of the backups that were complete, which stay as they are.
function assertNotComplete(home, ended, { complete, what }) {
  assert.equal(ended.payload.label, 'incomplete_for_recovery', `${what}: the label of its engine.backup event (payload: ${JSON.stringify(ended.payload)})`);
  if (ended.manifest !== null) assert.equal(ended.manifest.label, 'incomplete_for_recovery', `${what}: the label in the manifest it left`);
  const backups = join(home, 'backups');
  for (const name of existsSync(backups) ? readdirSync(backups) : []) {
    const dir = join(backups, name);
    if (complete.includes(dir)) continue;
    const manifest = manifestOf(dir);
    if (manifest !== null) assert.equal(manifest.label, 'incomplete_for_recovery', `${what}: the label in ${join(dir, 'manifest.json')}`);
  }
}

// What git says of a commit, asked by the test with its own deadline: 'a
// commit', 'not a commit' (git answered, and the object is not there or is
// not that commit), or 'no answer' (git was still waiting at the deadline).
function gitSays(repo, oid, deadlineMs) {
  const done = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, 'cat-file', '-e', `${oid}^{commit}`], {
    env: gitEnv(repo),
    timeout: deadlineMs,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (done.error?.code === 'ETIMEDOUT' || done.signal !== null) return 'no answer';
  return done.status === 0 ? 'a commit' : 'not a commit';
}

// What git says of all the listed commits: the first answer that is not 'a
// commit', or 'a commit' if every one is confirmed.
function gitSaysOfAll(repo, oids, deadlineMs) {
  for (const oid of oids) {
    const said = gitSays(repo, oid, deadlineMs);
    if (said !== 'a commit') return said;
  }
  return 'a commit';
}

describe('M66 the backup a running engine takes', () => {
  test('a listed commit whose object does not hold what its name stands for is not confirmed: no engine.backup says complete, as git says and as surety store backup says of the same repository', async (t) => {
    const { fx, project, repo, checkpoint } = await projectWithHistory(t);
    const engine = fx.engine;

    // The repository as the engine left it: the backup ends, and it is complete.
    const sound = await takeBackup(engine, { withinMs: 60_000, what: 'the backup of the sound repository' });
    assert.equal(sound.payload.label, 'complete', `with every listed commit in the repository the backup is complete (payload: ${JSON.stringify(sound.payload)})`);
    assert.equal(sound.manifest?.label, 'complete', 'and its manifest says so');
    assert.ok(listedFor(sound.manifest, project.id).includes(checkpoint), `the manifest lists the checkpoint commit ${checkpoint}`);
    assert.equal(gitSays(repo, checkpoint, 10_000), 'a commit', 'the fixture: git confirms the commit');

    // The commit's loose object is replaced by one that is well formed and
    // says it is a commit, and whose content is not what the name stands for.
    const loose = join(repo, '.git', 'objects', checkpoint.slice(0, 2), checkpoint.slice(2));
    assert.ok(existsSync(loose), 'the fixture: the checkpoint commit is a loose object');
    chmodSync(loose, 0o644);
    writeFileSync(loose, deflateSync(Buffer.from('commit 9999\0not the commit at all')));
    assert.equal(gitSays(repo, checkpoint, 10_000), 'not a commit', 'the fixture: git answers that the object is not that commit');

    // Git answers at once here, so nothing has a deadline to wait for.
    const ended = await takeBackup(engine, { withinMs: 60_000, what: 'the backup of the repository with the corrupt commit' });
    assertNotComplete(fx.home, ended, { complete: [sound.payload.backup], what: 'a backup that lists a commit git does not confirm' });
    assert.equal(manifestOf(sound.payload.backup).label, 'complete', 'the earlier backup is what it was');

    // The same repository, asked by the command: it agrees.
    await engine.stop();
    const command = storeCommand(fx.home, ['backup']);
    assert.notDeepEqual([command.status, command.last?.label], [0, 'complete'], `surety store backup does not call it complete either (stdout: ${command.stdout})`);
    assert.equal(command.status, STORE_REFUSED, `surety store backup exits ${STORE_REFUSED} (stdout: ${command.stdout}; stderr: ${command.stderr})`);
    assert.equal(command.refusal?.code, 'backup_incomplete');
  });

  // A file in the pack directory, named as the index of a pack that is
  // beside it. Git goes to the index of every pack it finds until it has the
  // object it is looking for; this pack is the newest, so git goes to it first.
  const FORMS = [
    {
      name: 'a link to /dev/zero',
      plant: (index) => symlinkSync('/dev/zero', index),
      // Git finds an index that is too small, says so, and looks elsewhere.
      git: 'a commit',
    },
    {
      name: 'a named pipe',
      plant: (index) => execFileSync('mkfifo', [index]),
      // Git waits at the pipe: only a deadline ends it.
      git: 'no answer',
    },
  ];

  for (const form of FORMS) {
    test(`a backup always ends: with a pack index in the repository that is ${form.name}, it ends within a bound with the label git gives, the engine's memory stays bounded and health is answered within the latency bound`, async (t) => {
      const { fx, project, repo } = await projectWithHistory(t, { git_deadline: GIT_DEADLINE_S });
      const engine = fx.engine;
      const control = await Control.start(t);
      const info = await engine.engineInfo();
      assert.deepEqual(info.config?.api_latency_bound, { value: LIMITS.api_latency_bound_ms, source: 'default' }, 'the engine runs with its default api_latency_bound');
      const latencyBoundMs = info.config.api_latency_bound.value;

      // The commits are packed, so that finding one means going to the pack
      // indexes; the real packs are made older than the one about to be planted.
      gitQuiet(repo, ['gc', '-q']);
      const packs = join(repo, '.git', 'objects', 'pack');
      const hourAgo = new Date(Date.now() - 3_600_000);
      const realPacks = readdirSync(packs).filter((name) => name.endsWith('.pack'));
      assert.ok(realPacks.length >= 1, 'the fixture: the repository has a pack');
      for (const name of realPacks) utimesSync(join(packs, name), hourAgo, hourAgo);

      // The repository before anything is planted: the backup ends, complete,
      // and its manifest says which commits a backup of this home lists.
      const sound = await takeBackup(engine, { withinMs: 60_000, what: 'the backup of the sound repository' });
      assert.equal(sound.payload.label, 'complete', `before anything is planted the backup is complete (payload: ${JSON.stringify(sound.payload)})`);
      const listed = listedFor(sound.manifest, project.id);
      assert.ok(listed.length >= 1, 'the manifest lists commits of the project');

      // Plant the pack and its index, and take them away again before the
      // fixture goes: a process still waiting at the pipe is let go first.
      const planted = join(packs, `pack-${'0'.repeat(40)}`);
      writeFileSync(`${planted}.pack`, '');
      form.plant(`${planted}.idx`);
      fx.beforeCleanup.push(() => {
        try {
          // Opening a pipe for writing without blocking succeeds only if a reader waits.
          if (statSync(`${planted}.idx`).isFIFO()) closeSync(openSync(`${planted}.idx`, constants.O_WRONLY | constants.O_NONBLOCK));
        } catch {
          // nobody is waiting at it, or it is not a pipe
        }
        rmSync(`${planted}.idx`, { force: true });
        rmSync(`${planted}.pack`, { force: true });
      });

      // What git says of the listed commits now, under the engine's deadline.
      const said = gitSaysOfAll(repo, listed, GIT_DEADLINE_S * 1000);
      assert.equal(said, form.git, `the fixture: asked for the listed commits with a deadline of ${GIT_DEADLINE_S} s, git gives ${JSON.stringify(form.git)}`);
      const truthful = said === 'a commit' ? 'complete' : 'incomplete_for_recovery';

      // Each listed commit may cost one git deadline.
      const endsWithinMs = listed.length * GIT_DEADLINE_S * 1000 + ALLOWANCE_MS;

      // The engine's memory is watched from before the backup starts, on a
      // timer of its own so that a request the engine is slow to answer does
      // not delay it; an engine that crosses the bound is killed at once, so
      // that it does not take the machine's memory with it.
      const pid = engine.pid;
      const memory = { before: residentMemory(pid).peak, peak: 0, killedAfterMs: null, startedAt: now() };
      memory.peak = memory.before;
      const watch = setInterval(() => {
        let peak;
        try {
          peak = residentMemory(pid).peak;
        } catch {
          return; // the process is gone
        }
        memory.peak = Math.max(memory.peak, peak);
        if (memory.killedAfterMs === null && peak - memory.before > MEMORY_RISE_BOUND) {
          memory.killedAfterMs = Math.round(now() - memory.startedAt);
          void engine.kill();
        }
      }, 10);
      t.after(() => clearInterval(watch));

      const { since, at } = await startBackup(engine);
      const health = [];
      const sampleHealth = async () => health.push(await sample(control, () => engine.get('/v1/health').catch((error) => ({ status: null, text: String(error) }))));
      let ended;
      while (memory.killedAfterMs === null && now() - at < endsWithinMs) {
        [ended] = backupsEnded(fx.home, since);
        if (ended !== undefined) break;
        await sampleHealth();
        await sleep(100);
      }
      const endedAfterMs = Math.round(now() - at);
      // A backup that ended at once was sampled too little to say anything: a few more.
      while (memory.killedAfterMs === null && health.length < 5) {
        await sampleHealth();
        await sleep(100);
      }
      clearInterval(watch);
      const rise = memory.peak - memory.before;
      t.diagnostic(`M66 a pack index that is ${form.name}: git says ${JSON.stringify(said)} of the ${listed.length} listed commits; backup ${ended ? `ended after ${endedAfterMs} ms, ${JSON.stringify(ended.payload)}` : `not ended after ${endedAfterMs} ms`}; peak resident memory rose by ${mib(rise)} (bound ${mib(MEMORY_RISE_BOUND)}); health ${JSON.stringify(summary(health))}`);

      assert.equal(memory.killedAfterMs, null, `the engine's memory stays bounded while it takes the backup: its peak resident memory rose by ${mib(rise)} within ${memory.killedAfterMs} ms, over the bound of ${mib(MEMORY_RISE_BOUND)}, and the test killed it`);
      assert.ok(rise <= MEMORY_RISE_BOUND, `the engine's peak resident memory rose by ${mib(rise)}, within ${mib(MEMORY_RISE_BOUND)}`);
      assert.ok(ended !== undefined, `the backup ends: no engine.backup event within ${endsWithinMs} ms of its start (${listed.length} listed commits at a git deadline of ${GIT_DEADLINE_S} s, and ${ALLOWANCE_MS} ms)`);
      assert.equal(engine.isRunning(), true, 'the engine is still running');

      // The label is the one git gives.
      const result = assertBackupEvent(ended);
      if (truthful === 'complete') {
        assert.equal(result.payload.label, 'complete', `git confirms every listed commit, so the backup is complete (payload: ${JSON.stringify(result.payload)})`);
        assert.equal(result.manifest?.label, 'complete', 'and its manifest says so');
      } else {
        assertNotComplete(fx.home, result, { complete: [sound.payload.backup], what: 'a backup whose commits git did not confirm within the deadline' });
      }

      // Health was answered throughout, each valid sample within the bound.
      for (const taken of health) assert.equal(taken.response.status, 200, `health answers 200 while the backup is under way (${taken.response.text ?? ''})`);
      assertWithinBound(health, { boundMs: latencyBoundMs, minValid: 3, what: `GET /v1/health while the backup is under way (a pack index that is ${form.name})` });
    });
  }
});
