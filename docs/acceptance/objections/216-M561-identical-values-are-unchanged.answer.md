# 216, answered: upheld; M561 (b) restated to the owner's ruling, and the harness's `changePolicy` settles an `unchanged` answer by reading the value back

Answer to `216-M561-identical-values-are-unchanged.md`, by the Verifier on `verify/policy-unchanged`, cut from the Builder's `build/policy-unchanged` 4d78f618 (on engine main 7ef35529), 2026-10-27.

**Upheld.** The owner's ruling of 2026-10-27, verbatim: "For policy updates, submitting values identical to the current effective values should return unchanged, without creating another revision. Preserve validation and intent-id behavior." M561 (b)'s comment and SEAM §570's reading ("a key sent at its current value is still a change") state the behaviour the ruling overrules. `changePolicy` waited for a revision that, under the ruling, is correctly never made.

## What changed (tests only; SEAM.md §571)

- **M561 (b)** now pins the ruling. After (a) commits revision N, each of these is answered exactly `{outcome: "unchanged", revision: null, committed: false, commit: null}`:
  - the key (a) committed, sent again;
  - `repair_attempts_max: 3, autonomy: "phase"`, read first at their defaults;
  - `{}`.

  It then checks:
  - An identical key beside an unknown one is still 400 `unknown_field`, with no `outcome`: validation runs first.
  - An identical body with an `intent_id` is `unchanged`, and its repeat gets the same answer. A different body under that intent is 409 `policy_intent_conflict`.
  - After 1 s there is still revision N, with the same `policy_revisions` and `policy.changed` counts, and the value is as (a) left it.
  - A body mixing the identical key with a changed one is `accepted` at N+1. It settles `committed` with both keys in effect and exactly one revision and one `policy.changed` more.

  The header and the case name say so. (a), (c) and (d) are as they were.

  The restated (b) was run against 7ef35529: the M561 file at that commit, built, with the restated M561 and `journal.mjs` copied in. It **fails** at its first new assertion ("the value (a) committed, sent again: unchanged"; actual `{outcome: "accepted", revision: 2, committed: false, commit: {state: "pending"}}`). On 4d78f618 it passes.
- **`changePolicy`** (`harness/journal.mjs`) still asserts 200. On `outcome: "unchanged"` it asserts three things, then returns the policy read without waiting for a revision:
  - the exact unchanged shape;
  - no move of the revision;
  - every submitted key (`intent_id` aside) reading back in `effective` at the submitted value.

  Any other 200 waits for revision `before + 1`, as before.
- **The five cases** (M105 (c), M426-plan-dependencies (f), M426-replans (b)/(f), M451 (a)/(b), M528 (h)) are unchanged in text. Each set a value already in effect as setup. That value is now verified in effect rather than recommitted, and each case still asserts the property it was written for (SEAM §571 lists them). None needed a new revision.

## Runs

See `/home/smahoney/surety-evidence/batch-2026-10-27d/policy-unchanged-verifier/RECORD.md` for verbatim counts.

## Sources

The owner's ruling, quoted above (relayed in the Verifier's brief of 2026-10-27). `src/store/transitions/project.ts` on 4d78f618: `changedPolicyKeys` ("A key with no effective value (an unset backend) is a change") and `submitPolicy` ("Ordinary keys sent with none prepared: the route found every one at its current effective value. That holds still, or the policy moved since."). `src/store/reads.ts` `projectPolicy`: `effective: effectivePolicy(db, project)`, the read `changePolicy` checks the value against.
