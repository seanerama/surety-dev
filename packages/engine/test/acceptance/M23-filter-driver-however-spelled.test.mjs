// M23, a filter driver the repository's configuration names in a spelling an
// engine's own reader of that file can miss (the slice-3 review; listed
// under slice 4). Plan §3.3 M23; D1 §7.1; E25 item 3; E29 item 1; SEAM.md
// §31 ("No code from the repository").
//
// The rule is about what git honours, not about what the engine can parse:
// engine git runs no filter driver from the repository's own configuration,
// however the configuration spells it. An engine that reads the filter names
// out of the config file itself and switches each one off by name runs every
// driver whose name it did not find. The Reviewer confirmed four such
// spellings on the slice-3 engine; each is a case here.
//
// Each case first shows, with ordinary git on the same fixture, that git
// runs the planted program; then a Builder's run goes through workspace
// creation (where git would smudge), snapshot (where it would clean), commit
// and integration, and the program has left no evidence. The evidence file
// and the programs are outside the repository.

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { installProject } from './harness/engine.mjs';
import { git } from './harness/git.mjs';
import { addItem, roleThat, runToEnd } from './harness/gitruns.mjs';
import { assertCommitted } from './harness/journal.mjs';
import { commitOnRef, evidenceProgram, fileAt, makeProjectRepo, readEvidence, refOid } from './harness/repos.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

// The driver's two keys, as a config file spells them under a section header.
const keys = ({ clean, smudge }) => `\tclean = ${clean}\n\tsmudge = ${smudge}\n`;
const config = (repo) => join(repo, '.git', 'config');

// Each spelling writes the driver into the repository's configuration and
// returns the name git knows it by, which is the name .gitattributes uses.
const SPELLINGS = {
  'an old-style dotted section whose name is not all lower case, [filter.EVIL]': (repo, programs) => {
    // git lower-cases a dotted subsection when it reads the file.
    appendFileSync(config(repo), `[filter.EVIL]\n${keys(programs)}`);
    return 'evil';
  },
  'a second section header on one line, [core] [filter "evil"]': (repo, programs) => {
    appendFileSync(config(repo), `[core] [filter "evil"]\n${keys(programs)}`);
    return 'evil';
  },
  'an include written on one line, with the filter defined only in the included file': (repo, programs) => {
    appendFileSync(config(repo), '[include] path = other.cfg\n');
    writeFileSync(join(repo, '.git', 'other.cfg'), `[filter "evil"]\n${keys(programs)}`);
    return 'evil';
  },
  'an included config file reached through a symbolic link': (repo, programs, dir) => {
    writeFileSync(join(dir, 'real.cfg'), `[filter "evil"]\n${keys(programs)}`);
    symlinkSync(join(dir, 'real.cfg'), join(repo, '.git', 'link.cfg'));
    appendFileSync(config(repo), '[include]\n\tpath = link.cfg\n');
    return 'evil';
  },
};

describe("M23 engine git runs no filter driver from the repository's configuration, however the configuration spells it", () => {
  for (const [spelling, plant] of Object.entries(SPELLINGS)) {
    test(`${spelling}: the driver is not run on workspace creation, snapshot or commit, and its files are committed unfiltered`, async (t) => {
      const fx = await scriptedEngine(t);
      const dir = join(fx.root, 'planted-filter');
      mkdirSync(dir, { recursive: true });
      const evidence = join(fx.root, 'filter-evidence.txt');
      const repo = makeProjectRepo(join(fx.root, 'repo-planted'));
      const programs = { clean: evidenceProgram(join(dir, 'filter-clean'), evidence, 'filter clean'), smudge: evidenceProgram(join(dir, 'filter-smudge'), evidence, 'filter smudge') };
      const name = plant(repo.path, programs, dir);
      commitOnRef(repo.path, repo.ref, { '.gitattributes': `*.dat filter=${name}\n`, 'data/seed.dat': 'seed\n' }, { message: 'fixture: a filter attribute' });

      // The fixture is live: ordinary git runs the driver when it checks the attributed file out.
      const probe = join(fx.root, 'probe-worktree');
      git(repo.path, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--quiet', '--detach', probe, repo.ref]);
      assert.ok((readEvidence(evidence) ?? '').includes('filter smudge ran'), `ordinary git runs the planted filter driver on a checkout (evidence: ${readEvidence(evidence)})`);
      rmSync(probe, { recursive: true, force: true });
      git(repo.path, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'prune']);
      rmSync(evidence);

      // A Builder's whole course: workspace, snapshot, commit, ref update, and two ticks with their integrity step.
      const project = { id: await installProject(fx.engine, { repoPath: repo.path }), repo, base: refOid(repo.path, repo.ref) };
      const item = await addItem(fx, project.id, 'fix');
      const files = { 'data/new.dat': 'new data, as the Builder wrote it\n', 'data/seed.dat': 'seed, changed by the Builder\n' };
      fx.scripted.script(item, [roleThat(Object.entries(files).map(([path, content]) => step.write(path, content)))]);
      const run = await runToEnd(fx, project.id, item);
      const committed = assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true });
      for (let i = 0; i < 2; i++) await tick(fx.engine, project.id);

      const ran = readEvidence(evidence);
      assert.ok(ran === null, `engine git executed a filter driver named in the repository's configuration:\n${ran}`);
      for (const [path, content] of Object.entries(files)) assert.equal(fileAt(repo.path, committed.sha, path), content, `${path} is committed as the role left it, unfiltered`);
    });
  }
});
