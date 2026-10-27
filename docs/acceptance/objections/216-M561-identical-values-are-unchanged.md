# 216: a policy submission of values identical to the effective ones is `unchanged` by the owner's ruling; M561 (b) still describes it as a new revision, and five cases (through the harness's `changePolicy`) wait for a revision it no longer makes

Row: M561 (also M105, M426, M451, M528, through `test/acceptance/harness/journal.mjs` `changePolicy`)
Test: packages/engine/test/acceptance/M561-policy-submission-outcomes.test.mjs, case "(a) accepted with its revision and commit pending, then read committed; (b) unchanged; (c) refusals unchanged"; and the five cases listed under "Cases that fail"
Filed by: Builder, branch build/policy-unchanged (from engine main 7ef35529), 2026-10-27

## Claim

The owner's ruling of 2026-10-27, verbatim:

> "For policy updates, submitting values identical to the current effective values should return unchanged, without creating another revision. Preserve validation and intent-id behavior. Handle this as a small separate fix."

On build/policy-unchanged the engine answers a submission whose every ordinary key equals its current effective value (the recorded revision's effective policy with the defaults filled in, compared key by key with the validated, typed submitted value by its canonical JSON) `200 {"outcome":"unchanged","revision":null,"committed":false,"commit":null}`, with no revision, no journal operation and no `policy.changed` event. A body with at least one changed key is accepted as before. Validation, the widening refusal (409 `confirm_required`) and the intent_id behaviour are unchanged. A key at its default counts as identical: the default is the effective value.

### M561 (b): the old behaviour pinned in a comment

M561 does not fail on the branch (run alone: 2 tests, 2 pass, 0 fail): it asserts `unchanged` only for `{}`. But its header says (b) is "A submission with nothing to commit (no ordinary key: `{}`)", and the comment in (b) states the overruled behaviour:

> Nothing to commit: a submission with no ordinary key. (A key sent at its current value is still a change the engine commits as a new revision, as before the batch; preparePolicy prepares a commit for every non-empty ordinary change.)

Nothing in the suite asserts the ruling. I ask the Verifier to restate (b) to it: a key at its current effective value (for example `budget_run_billable_tokens` at the value (a) committed, and a key at its default) is answered `{outcome: "unchanged", revision: null, committed: false, commit: null}` with no new policy revision; a body mixing an unchanged key with a changed one is accepted with the next revision; with an intent_id, the repeat of an unchanged submission is the same answer and a different body under it is 409 `policy_intent_conflict`.

### Cases that fail: an identical submission through `changePolicy`

`harness/journal.mjs` `changePolicy` asserts 200 and then waits for revision `before + 1`. Under the ruling an identical submission is 200 `unchanged` and makes no revision, so each case below times out. Each was observed failing in a run three files at a time and again with the file run alone (private TMPDIR, build/policy-unchanged at the commit that files this objection):

| File, case | The identical submission | Observed (alone) |
|---|---|---|
| M105-alpha-exception-proposal, "(c) the field from a Builder and from a Verifier makes the result invalid" | `changePolicy(…, { repair_attempts_max: 0 })` after `nominated(fx, { policy: { repair_attempts_max: 0 }, … })` already made it effective | 7 tests, 6 pass, 1 fail: "timed out after 30000 ms waiting for policy revision 2 of … to be effective" |
| M426-plan-dependencies-and-validation, "(f) a plan of two stages under the default phase_size {3, 5}: …" | `specReady(fx, { policy: { phase_size: { min: 3, max: 5 } } })`: the default | 7 tests, 6 pass, 1 fail: "… waiting for policy revision 1 …" |
| M426-replans-against-the-roadmap, "(b) dropping R4 and assigning it twice are refused; (f) …" | `journey35(t, { policy: { phase_size: { min: 3, max: 5 }, repair_attempts_max: 3 } })`: both defaults | 2 tests, 1 pass, 1 fail: "… waiting for policy revision 1 …" |
| M451-the-profile-is-part-of-the-qualification, "(a) an entry qualified at role_memory_max 8 GiB …; (b) …" | `changePolicy(…, { role_memory_max: 4 * GIB })`: the default, never changed by `POLICY` | 2 tests, 1 pass, 1 fail: "… waiting for policy revision 2 …" |
| M528-the-owner-invoked-review-of-a-native-build, "(h) under design off: the review refused, nothing opened" | `createPantry(fx, { …, policy: { autonomy: 'phase' } })`: the default | 7 tests, 6 pass, 1 fail: "… waiting for policy revision 1 …" |

None of these cases is about the policy revision itself: each sets a value as setup, and the value is in effect either way. I ask the Verifier to make the setup hold under the ruling, by whichever means it prefers: `changePolicy` returning the policy read without waiting when the answer is `outcome: "unchanged"` (asserting the value is effective), or the cases not submitting a value already in effect.

## Sources

The owner's ruling, 2026-10-27, quoted above (relayed by the driver in the Builder's brief for build/policy-unchanged).

`packages/engine/test/acceptance/harness/journal.mjs`, `changePolicy`: "assert.equal(res.status, 200, `a valid policy change (body: ${res.text})`); return waitFor(async () => { … return policy.revision === before + 1 ? policy : undefined; }, { what: `policy revision ${before + 1} of ${project} to be effective` });".

`packages/engine/src/projects/commands.ts`, `preparePolicy` (on the branch): "Every ordinary key at its current effective value (the owner's ruling of 2026-10-27): nothing to commit, so nothing is prepared and the answer is `unchanged`; validated and checked for widening first, as any change."; `packages/engine/src/store/transitions/project.ts`, `changedPolicyKeys` and `submitPolicy`.

The defaults (`projectEffectiveDefaults`, `src/config/project-policy.ts`): `repair_attempts_max` 3, `role_memory_max` 4294967296, `autonomy` "phase", `phase_size` {"min":3,"max":5}.
