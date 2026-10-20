# 207: M433 (h) "the owner is told" reads the `cancel` option's `consequence`, but a stored option holds its text as `consequence_text` (D1 A)

Row: M433 (h), S3 (E173 item 4; Sean's ruling of 2026-10-20, option B; SEAM.md §557)
Test: packages/engine/test/acceptance/M433-old-generation-runs-and-what-resolves-an-obligation.test.mjs, case "(h) S3, the owner is told: the parked correction's question and its cancel option name `surety spec correct`; after the cancel, GET …/spec lists the request's open obligation with a next_action naming it"
Filed by: Builder, S3, 2026-10-20

## Claim

The case reads the parked correction's blocker from the store (`decisionsOn(fx.home, 'blocker', w.id)`, `SELECT * FROM "decisions"`), finds its `cancel` option, and asserts:

```js
assert.ok(cancel?.consequence?.includes(command), …);
```

A decision's options are stored, and answered by the API, in D1 A's shape `{key, label, effect_plan{}, plan_hash, consequence_text}` (with `blockers`); no option on any decision has a field named `consequence`. `consequence` is the name of the field on the *approval* record (D1 A, `approvals.consequence`), not on an option. So `cancel?.consequence` is `undefined` on every engine and the assertion cannot pass, whatever the text says.

Observed on `build/s3` (this branch, the file alone with `node --test`, `TMPDIR=/tmp/bs3tmp`): 4/5, the told case failing at that assertion with the option as the engine stores it:

```
S3: the cancel option's consequence names surety spec correct --project proj_01M5CKZTXW1XQCBTMN26QS2B9E --request scr_01M5CKZYJ0DCA3AV3DDP3B8W48
({"key":"cancel","label":"Cancel","effect_plan":{"work_item":"wi_01M5CM00FB292A2XJZAG7AEWFN","to":"cancelled"},"plan_hash":"16ebdff4…","consequence_text":"The item is cancelled and never dispatched again. The specification change's obligations stay open; `surety spec correct --project proj_01M5CKZTXW1XQCBTMN26QS2B9E --request scr_01M5CKZYJ0DCA3AV3DDP3B8W48` registers its correction again.","blockers":[]})
```

The option's `consequence_text` contains the exact command. A scratch copy of the file (not committed; in `/tmp/bs3tmp`, its harness imports made absolute) with only `cancel?.consequence?.includes` changed to `cancel?.consequence_text?.includes`, run with `--test-name-pattern "owner is told"`, passed 1/1 on this branch: the question, the cancel consequence, and `GET …/spec`'s `change_requests` entry (`open_obligations` keys `['accept-r2']`, `next_action` naming the command).

**Asked:** the assertion reads `cancel?.consequence_text` (the option's stored field). The SEAM's prose ("its `cancel` option's `consequence`") reads naturally as the option's consequence text and needs no change; if the Verifier prefers, it may say `consequence_text`.

I have not added a `consequence` alias to stored options: it would change D1 A's option shape for every decision kind, which is not this row's to change.

## Sources

- D1 (`docs/design/sdlc-design-D1-engine-core.md`), Appendix A, `decisions`: "`options* [{key, label, effect_plan{}, plan_hash, consequence_text}]`".
- `src/store/transitions/decisions.ts`, `optionsJson`: `consequence_text: o.consequence` (the stored form of every option).
- SEAM.md §557, "How the owner is told": "Its `cancel` option's `consequence` contains the same exact command … The option's key and effect are unchanged."
