# 001, answer: upheld; the assertion now compares with the integration branch's head read before the retry

Row: M45
Test: packages/engine/test/acceptance/M45-blocker-manifest.test.mjs, case "the stored continuation changes while the subject stays parked: the old preview is stale, nothing is resumed, and the next generation binds the continuation as it now is", the last assertion
Answered by: Verifier, M2 slice 2, 2026-10-03, on branch `verify/m2-s2-obj`

## Decision

**Upheld.** The objection is right about the sources and about the engine, and the case's last assertion compared the retried run's base with the wrong commit. The test is changed; nothing of what it pins is weakened.

## Why

`SEAM.md` §27, "A valid change": a valid policy change is answered 200 and "the engine commits `.surety/policy.json` to the integration branch through the journal (a `commit_tree` and a `ref_update` operation, as for bootstrap)". So after the case's own `changePolicy(fx.engine, project.id, { repair_attempts_max: 0 })` the integration branch, and the registry's expected commit for it, are the policy commit, one past `project.base`, which `addGitProject` captured before the change (`harness/gitruns.mjs`: `base` is "the commit the integration branch is at once the project exists"). The retried run's base is the head the registry expects (D1 §7.4; `SEAM.md` §16, "`base_revision` the commit the project's integration branch points at"; §105, "a `retry` on it starts a run whose `base_revision` is the integration branch's head"), which is the policy commit. The case asserted `project.base`.

Checked by running, on `main`'s engine (`d8e4137`, the slice-1 engine), with a scratch script of the same steps, kept outside the repository: `project.base` `ceb94a37…`; the head before the policy change `ceb94a37…`; the head after it `83dd0364…`; the registry's expected commit `83dd0364…`; the checkpoint `b7f5d5cb…`; the two runs' `base_revision` `83dd0364…` (the first, from the head) and `b7f5d5cb…` (the continuation, from the checkpoint). This is what the Builder's scratch run showed.

## What changed

One assertion, and a fixture-liveness check before it, in the case named above (`M45-blocker-manifest.test.mjs`, the end of the case; imports of `registryOf` and `refOid` added):

Before:

```js
    await consume(fx, project.id, next, 'retry');
    const resumed = await runToEnd(fx, project.id, item, { index: 2 });
    assert.equal(resumed.base_revision, project.base, "the retried run starts from the integration branch's head, as the answered preview said, not from the checkpoint");
```

After:

```js
    const head = refOid(project.repo.path, project.repo.ref);
    assert.deepEqual(
      [registryOf(fx.home, project.id)[project.repo.ref].expected_oid, runsOf(fx.home, item)[0].base_revision, head === checkpoint.sha],
      [head, head, false],
      "the fixture is live: the registry expects the head, the first run started from it, and it is not the checkpoint",
    );
    await consume(fx, project.id, next, 'retry');
    const resumed = await runToEnd(fx, project.id, item, { index: 2 });
    assert.equal(resumed.base_revision, head, "the retried run starts from the integration branch's head, as the answered preview said, not from the checkpoint");
```

The head is read from the repository before the answer is given (the objection's first proposal); the liveness check requires it to be the commit the registry expects and the first run's base (the objection's second proposal), and to differ from the checkpoint, so that the final assertion still tells "from the head" from "from the checkpoint", which is what the case pins. `SEAM.md` §105's wording ("the integration branch's head") was already right; no seam change is needed beyond the note added to §105's case description that the head is the policy commit the case's own fixture made.

## What was run

- `node --test test/acceptance/M45-blocker-manifest.test.mjs` alone, after `npm run build`, on `main`'s engine: 2 of 4. Cases 2 and 3 pass. Case 1 fails at the continuation's form (the string `eligible` where `{status: 'eligible', from: null}` is expected), as before. Case 4 fails at `M45-blocker-manifest.test.mjs:115`, the preview's `continuation` (the string `eligible` where `{status: 'eligible', from: <the checkpoint>}` is expected), as before: `main` holds the slice-1 engine, which does not bind the continuation's revision, so the case cannot reach the changed assertion there.
- The changed assertion was therefore exercised in a scratch copy of the file, run once and not kept, in which the three steps that need the slice-2 engine's manifest (the preview's form, the stale answer after the store change, the next generation) were replaced by answering the open blocker directly after `continue_from` was cleared; everything else was the case as committed. Case 4 of the copy passes on `main`'s engine: the head read before the retry is the registry's expected commit and the first run's base, differs from the checkpoint, and the retried run's `base_revision` is that head. The real case's remaining assertions are as the Builder reports them on `build/m2-s2`.
