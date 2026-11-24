# M602 (a) amended: the preparation approval's question leads with the decision; M602 (b) read as a race (Verifier report, 2026-11-24)

**Branch.** `verify/m602-approval-wording`, cut from 809bb57f (engine main 60319f5f plus the driver's companion amending row M602 (a) in the M7 plan, DECISIONS item 48). My commits are fff033f4 for (a) and 672d02eb for (b). This report is committed after them.

**Engine.** This branch carries the **pre-fix** engine. The Builder's change is on `build/m602-approval-question`: 4cf62c8a (item 48, the question and option texts in `src/prototype/brief.ts`) and ddb3492c (item 49, the unit demo test). The post-fix gate used ddb3492c, which this branch has not merged.

**Source.** DECISIONS item 48. Sean, 2026-11-24 ~17:40Z: "Lead with the decision I'm making: “Approve one Spec Writer run to prepare the prototype brief?” Then show Requested model and Backend as separate labeled values. Keep the paid or unpaid consequence, token allowance, and cost estimate visible before approval. Have M602 assert those facts and the authorization boundary instead of requiring the phrase “on scripted model.” Preserve existing approval records." DECISIONS item 49 is the Builder's finding on the work item's state race, which the driver applied to M602 (b) on condition it is confirmed.

## What changed in the assertions

File: `packages/engine/test/acceptance/M602-preparation-is-authorized-before-it-runs.test.mjs`. No harness file changed and no objection was filed.

### (a)

The removed assertion matched `/Spec Writer \(role spec_writer\) on scripted model /`. It pinned a phrase, not what the owner needs to read before approving.

Added in its place:

1. The question starts with `Approve one Spec Writer run to prepare the prototype brief?`, so it leads with the decision.
2. The question contains `Requested model: ${m.model}` and `Backend: ${m.provider}`. `m` is the decision's own `dependency_manifest`, so the assertion proves the question and the manifest name the same model and backend. It does not quote a constant: the manifest's `model` is the requested model (item 45, asserted by M629), and `provider` is the backend.
3. Both labels come after the opening sentence and before `Approving authorizes exactly one preparation run`, so they are shown before the authorization boundary.
4. The approve option (`label` plus `consequence_text`) contains the same two labels and does not contain `on scripted model`.
5. Stored decisions keep their recorded question. After the existing tick, the same decision is re-read through `GET …/decisions/:d`, and its `question` and `options` must equal what was read when it was raised.

Kept exactly as before:
- the per-run allowance sentence ("Its effective token limit is 1500000 billable tokens: the per-run limit of 5000000, capped at …");
- the unpaid consequence ("The scripted provider is unpaid: no paid work follows");
- the own-subtotal note;
- the authorization boundary ("Approving authorizes exactly one preparation run; it approves neither the brief nor the build");
- the manifest assertions (`paid` false, `estimated_usd` null, `estimate_basis` starting `scripted provider: unpaid`, `run_token_limit` 1,500,000, `authorizes`);
- the options' keys;
- no run and no work item before the answer.

The estimate requirement ("the estimated cost labelled an estimate with its basis; scripted: unpaid") stays asserted through the manifest's `estimated_usd` (null, never 0) and `estimate_basis`, and through the question's unpaid sentence. The scripted lane has no paid estimate to show.

### (b)

The removed assertion was `[[brief_preparation, 'eligible']]`, read straight after the approval's answer.

The answer's commit requests a tick: the approve option returns the decision effect `tick`, and `runtime.afterCommit` calls `requestTick`. That tick runs in the engine process, which is separate from the test. Its dispatch claims the item and creates its run in one transaction, and the launch then moves the item to executing and complete. So the test's read can land on any of these states. This is the same race the Builder found in the unit demo test (item 49).

**Confirmed in M602 itself.** I ran a probe copy of the file outside the repo with a 1.5 s wait between the answer and the read, against the post-fix tree. The old line failed with actual `[['brief_preparation', 'complete']]` against expected `'eligible'`. The race has not been seen in an unaltered run.

Asserted in its place:
- exactly one work item, of kind `brief_preparation`;
- its status is one of `eligible`, `claimed`, `executing` or `complete`;
- no run of anything but that item;
- if the item was read `eligible`, at most one run since that read;
- if it was read `claimed` or later, exactly one run.

The rest of (b) is unchanged: the item names its approval, the authorization event, the pump to `awaiting_brief_approval`, exactly one completed run attributed to the iteration, the receipt's allowance, `totals.preparation`, and the approval counted once. With the 1.5 s wait the amended file passes 4/4.

## Pre-fix (this branch's engine, old wording)

`npm ci`, `npm run build`, then `node --test` on M602 alone, with TMPDIR=/tmp/m602-v.

- **4 tests: 2 pass, 2 fail (exit 1).** Recorded with (a) at fff033f4, before the (b) change.
- **(a) fails** at its first new assertion. The question starts "Authorize one brief preparation run for prototype iteration 1? It runs the Spec Writer (role spec_writer) on scripted mo…".
- **(b) fails only as a knock-on of (a).** (a) never stores the decision (`S.aQuestion`), so (b) hits `TypeError: Cannot read properties of undefined (reading 'id')` in the harness's `answer`.
- **(c) and (d) pass.**

To see every failure, I ran a probe copy outside the repo whose assertions record a failure and carry on. Exactly the new checks fail:
- the opening sentence;
- `Requested model: opus` in the question;
- `Backend: scripted` in the question;
- the position of each label (two checks);
- the requested-model label in the approve option;
- the backend label in the approve option.

The old approve text is "Authorize one preparation run One brief preparation run is dispatched to the scripted provider, requesting model opus; no paid work follows. …". Every carried-over assertion passes, and so does the stored-question re-read.

## Post-fix gate

Throwaway worktree `/tmp/m602-v/vgate`, branch `gate/tmp-m602-verify`, built from fff033f4. I merged ddb3492c into it (merge commit ba8f4063), then merged 672d02eb (a4e09df6). I ran `npm ci` and `npm run build`, then each file serially with `node --test`, with TMPDIR=/tmp/m602-v:

| File | Tests | Pass | Fail | Skipped/todo/cancelled |
|---|---|---|---|---|
| M602 | 4 | 4 | 0 | 0 |
| M603 | 5 | 5 | 0 | 0 |
| M604 | 6 | 6 | 0 | 0 |
| M629 | 6 | 6 | 0 | 0 |
| M612 | 4 | 4 | 0 | 0 |

The question served post-fix, from M629 (a)'s diagnostic:

"Approve one Spec Writer run to prepare the prototype brief? (prototype iteration 1) Requested model: opus. Backend: scripted. The run reads the idea (.surety/idea.md, version 1) and writes the brief and the minimal specification for your approval. Its effective token limit is 1500000 billable tokens: the per-run limit of 5000000, capped at what the iteration has left of its token allowance. The scripted provider is unpaid: no paid work follows. This limit is an estimated allowance, … Its usage is counted in the prototype's totals as its own subtotal (brief preparation). Approving authorizes exactly one preparation run; it approves neither the brief nor the build."

## The Builder's text against the row

The text agrees with row M602 (a) as amended. It leads with the decision. It then gives the labelled Requested model and Backend, the allowance, the unpaid consequence, the own subtotal and the boundary. The row lists these facts but fixes only the opening and the labels' place after it; the allowance sentence comes before the consequence sentence, as it did before the amendment. No objection.

## Not claimed

- The stored-question assertion shows a recorded decision is not rewritten while one engine runs. It does not show that a decision recorded under the old code keeps its old text after an upgrade. The Builder reports a unit test for that, which I did not run.
- No paid or real-lane path was run. The paid approve-option text (`m.paid` true) is not exercised by this kernel-lane file.
- The gate was these five files, serially. It was not the full slice or `npm test`.
