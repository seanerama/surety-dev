# What M1 does not claim

**Written by:** the Verifier, 2026-10-02, on branch `verify/journey-first`. **Status:** a list for the owner; it decides nothing.

Milestone M1 of Surety is accepted when every row of the acceptance plan has tests and all of them pass. A passing suite supports one claim: the engine behaves as the tests require. It supports no claim about behaviour that no test exercises. This document lists that behaviour, case by case, so that a passing M1 is not read as covering it.

## Where the list comes from

The acceptance plan (`docs/acceptance/sdlc-M1-acceptance-plan-Astra.md`) has 74 rows, M01 to M74. Each row describes a scenario and the result the engine must show. The Verifier, the role that writes the acceptance tests, split each row into named cases and recorded every case in `packages/engine/test/acceptance/COVERAGE.md`, with the test file that holds it or the reason it was left out.

From the fourth of the seven build stages (called slices) onward, the owner chose a faster procedure: the fewest cases that establish each row's required result. Cases beyond that were not written, and each was recorded with a reason. There are 33 of them. Twenty-nine are marked "not written" in a row's own table; four more are recorded as not written in the notes beside the tables (the entries for rows M27, M31 and M32, and the two entries for the decision rows M45 to M55).

This document repeats those 33 cases and puts each in one of three classes. The class is taken from the reason already recorded. The design was not examined again. Where the recorded reason does not settle whether a case belongs in class A or class B, it is in class B.

- **Class A, unreachable in M1.** The engine has no path to the behaviour: no API route, no test fixture and no output of a role can produce the situation. There is nothing to claim and nothing to build.
- **Class B, real behaviour, not tested.** A path to the behaviour exists, or could be built from the design documents, and no test establishes it. M1 does not claim it. Each entry says what a person using the engine would notice if the behaviour were absent or wrong.
- **Class C, cannot be observed from outside.** The behaviour may exist, but no test that watches the engine from outside can see it.

## Terms used below

- **Engine:** the Surety program under test. In M1 it drives a **scripted adapter**, a stand-in for an AI coding agent that does exactly what a test tells it to and calls no model.
- **Role:** one kind of agent the engine launches. The Builder writes code, the Verifier and the Reviewer check it, the Architect writes plans.
- **Work item:** one unit of work the engine schedules, such as building a stage of a plan or verifying a result. A **run** is one launch of a role on a work item.
- **Repair:** a new run the engine starts by itself after a run of the same work item failed, up to a limit.
- **Integration branch:** the git branch the engine commits accepted work to. **Workspace:** the separate git working directory a run works in.
- **Checkpoint:** a commit of unfinished work that a later run continues from.
- **Candidate:** a commit the engine has put forward (nominated) for acceptance. The engine marks it with a git reference of its own, called here the candidate's marker.
- **Check:** a required test of a candidate. Its state (passed, failed, missing and so on) is worked out from recorded executions, never from what a role says.
- **Gate:** the engine's evaluation of whether a candidate has met everything required of it. M1 has two kinds: the stage gate, and the Alpha-authorization gate, which issues a permission to deploy to a test target and deploys nothing.
- **Finding:** a problem a Verifier or Reviewer reports, with a severity.
- **Decision:** a question the engine puts to a person, with a fixed set of answers. The person sees a **preview** of what each answer will do and answers against it; if the facts behind the preview have changed, the answer must be refused as out of date.
- **Protected checks:** the files that define what must pass. Roles cannot change them directly: a change is a proposal that must be approved, and each approved state is a **protected version**.
- **Out-of-band change:** a change someone made to the repository behind the engine's back, which the engine detects and asks a person to resolve.
- **Journal:** the engine's record of each git operation it intends, so that after a crash it can tell whether the operation happened.
- **Record:** a stored file of evidence, such as a role's output.
- **Tier:** how much independent review a project requires, from T1 (least) to T3 (most).

## Class A: unreachable in M1 (14 cases)

| Plan row | Behaviour | Why nothing in M1 can reach it |
|---|---|---|
| M08 | A decision of a kind that M1 does not enable has no effect when it is answered. | The engine raises only the eleven kinds M1 enables. No route and no test fixture can raise any other kind, so there is no such decision to answer. |
| M09 | Work that the engine itself has put in the "awaiting decision" status goes back to the continuation it stored, once the decision is answered. | No path in the M1 engine puts work in that status. The status exists only in the table of legal transitions, which the tests check as a table. |
| M11 | Findings that are reported again unchanged, under new identifiers and times, count as "no progress" when the engine decides whether to repair again. | In M1 findings come only from Verifier and Reviewer runs, and the engine does not repair those runs on what they find. No failed run carries findings into the comparison. |
| M13 | Stopping a run while its work is in the "awaiting decision" status. | As for row M09: no path puts work in that status. |
| M14 | Abandoning a run while its work is in the "awaiting decision" status. | As for row M09. |
| M21 | Continuing work from a checkpoint does not make any gate count as satisfied. | A checkpoint nominates no candidate (this is tested), and a gate is evaluated only for a candidate. There is no gate that a continuation could have satisfied. |
| M38 | A requirement whose coverage by checks is "uncertain" keeps its gate unsatisfied. | The design documents name no condition that makes coverage uncertain, as distinct from missing or empty, which are tested. Nothing can produce the state. |
| M39 | An approval by a person never turns a check's state into "passed". | No approval in M1 has any path to a check's state. The one approval that comes near, the approval to lower a finding's severity, is tested to change no check state. |
| M56 | Asking the same question again after its decision was answered, with nothing changed, returns the answered decision and raises no new one. | Every M1 route that raises a decision on request (Stop, Abandon, and a policy change that widens what the engine may do unasked) changes the thing the decision is about when it is answered. The same question cannot be asked again unchanged. |
| M57 | A change to a deployment authorization, made between a decision's answer and the action the answer triggers, cancels that action. | No action in M1 uses up an authorization, because nothing deploys. |
| M61 | Answering a decision about an exhausted budget does not make a check pass. | The answer only lets the work run again. Nothing leads from it to a check's state except what a role then reports, and a role's report is tested to convert nothing. |
| M63 | Role output that is still being captured, and is not yet a published record, is never used as evidence for a gate. | No route can make a check's recorded execution point at unpublished output. Only a row written into the database by hand could, and that would test the test. |
| M65 | A record is kept past its retention period while a finding, an open decision, a pending action or a pending journal entry refers to it. | In M1 none of those four ever refers to a record of its own. Retention is tested for the one referrer that exists, the evidence of a gate evaluation. |
| M73 | The older script that checks the hand-written appendix of the design document for consistent names is run as part of acceptance. | This is not engine behaviour, and it was superseded: the resolution note to the design reversed the direction, so that the appendix is generated from the engine's own contract, and the script is kept only as history. The generated contract and appendix are tested. |

## Class B: real behaviour, not tested (18 cases)

| Plan row | Behaviour | Why no test establishes it | What a person would notice if it were absent or wrong |
|---|---|---|---|
| M11 | When a role reports that a requirement and the agreed contract contradict each other, the work goes to a person for a decision and is not repaired again. | The design gives this one clause and names two routes for it; M1 builds neither, and the owner has not said what the route is in M1. The recorded reason does not settle whether this is unreachable or unbuilt, so it is listed here. | Work that fails because the plan contradicts itself would be repaired again and again up to the repair limit and then parked as an ordinary failure, with nothing telling the person that the real cause is a contradiction. |
| M15 | A git commit or a branch update that overruns its time limit while the engine is running is recorded as having an unknown result, and blocks its project until the engine has checked what git actually did. | The test tool that makes git hang holds every git call, and the engine reads the repository before it writes to it, so the call that hangs is always a read. The unknown-result state of these two operations is reached only through a restart, where it is tested. The time limit is tested for creating and removing workspaces. | On a slow or locked repository, a commit or branch update that timed out could be repeated, or reported as failed although git completed it. The result would be accepted work that appears twice, or not at all. |
| M20 | A git command whose output is larger than the configured cap is cut off and fails cleanly. | No git command the M1 engine runs could be made to print more than the smallest cap, 64 KiB, without the case failing first for another reason. The limits on the size and number of files in a role's result are tested. | In a repository with a very large number of branches or tags, or with a very large change, the engine could hold unbounded output in memory and slow down or fail as a whole, where it should fail one command. |
| M24 | While someone has moved or deleted a candidate's marker and the change has not been resolved, that candidate's gates are blocked. | The rule the tests establish is per project, and they establish it for an unresolved change to the integration branch. They do not establish it for a change to a candidate's marker. That the change is detected, and how it is resolved, is tested. | A gate could be reported as satisfied, and an Alpha authorization issued, for a candidate whose marker had been tampered with and not yet put right. |
| M25, M46 | When the engine finds edits in the developer's checkout of the integration branch, the answer "adopt" takes those edits as the new starting point. | The acceptance row's required result names only the other answer, which sets the edits aside, and that one is tested. Both answers are tested to be offered. | Choosing "adopt" could lose the edits, fail to take them as the starting point, or leave the project blocked. It is one of two answers a developer is offered the first time they edit that checkout. |
| M27 | When the engine nominates a candidate, the set of work it marks as being verified with that candidate is fixed at the moment the nomination begins. | It is not one short case: it needs an integration and a nomination each held at a pause point of the same kind, and a second work item forced into the integrated status between them. | In a rare race, work integrated just after a nomination began could be tied to a candidate that does not contain it, and later be marked complete when that candidate's gate is satisfied. |
| M28 | A Builder's result that has to be replayed onto a moved integration branch is validated again, and is rejected if it now touches files that became protected in the meantime. | It needs an approved change to the protected checks to land between the start of a Builder's run and its integration, and with one run per project there is no cheap way to arrange that. The tests establish only that the replayed commit holds exactly what it should. | A Builder's edit to a file that became protected while the Builder was running could be accepted without the approval that protected files require. |
| M31, M32 | After a crash, recovery correctly classifies a leftover workspace directory that still has its link to the repository but whose entry in the repository has been removed. | Two forms of a half-made or half-removed workspace are tested, the two that git itself leaves when it is interrupted. This third form arises only if someone has cleaned up the repository's workspace entries by hand, and no case builds it. | After a crash that followed such a manual clean-up, the engine could stay blocked on that workspace, adopt it, or delete it wrongly. |
| M41 | A check result recorded for an earlier candidate is not reused for a later candidate if the protected checks were changed in between. | It needs an approved change to the protected checks between two candidates. The tests establish the underlying rule once, without reuse: a result recorded under an older protected version does not count. | A pass recorded before the checks were changed could count for a new candidate, so a gate would be satisfied by a test that no longer exists in that form. |
| M43 | A part of the project (a module) that is given a higher tier than the project is held to that tier; and a sensitive area brings required checks of its own. | The acceptance row's required result names neither, and what a sensitive area requires belongs to a later design (the one for the real check runner). | A module declared riskier than the rest would be accepted with only the project's lower level of review. |
| M45 to M55 | An answer to a decision is refused as out of date when any of the facts its preview was based on has changed. | For each of the eleven kinds of decision, one changed fact is tested, as the acceptance plan asks. The other facts each kind depends on are not: for a blocked piece of work, its evidence and its stored continuation; for a finding, its status, its evidence and its scope; for a proposed change to the protected checks, its content and the approved specification; for an exclusion of a finding, the ancestry of the candidate. | A person's approval, given on what they were shown, could be accepted although one of those facts had changed since. They would have approved something other than what took effect. |
| M49 to M55 | The answer "reject" to a decision leaves things as they were and closes the question. | No case exercises a "reject" answer for any of the seven kinds that offer one: a policy change that widens what the engine may do unasked, a finding's disposition, a lowering of severity, an exclusion of a finding, and the three kinds of correction to the protected checks. The plan's case set for each kind is a positive answer and a changed fact. | Rejecting could have an unexpected result: the same question raised again at once, the proposal left in a state from which nothing moves, or part of the rejected change applied. |
| M58 | What the engine does when a notification is plainly refused by its channel: whether it retries, how often, and when it gives up. | The acceptance row is about deliveries whose outcome is unknown, and those are tested. The design documents do not say what follows a plain failure. M1 has only a scripted notification channel. | A notice that a decision has waited too long could fail once and never be sent again, or be sent again without limit. |
| M61 | If the engine still cannot store a role's usage report after retrying, it stops the run, as it stops a run whose budget cannot be read, and marks that run's usage as incomplete. | It was decided after the review of the fourth slice (errata E37 item 3, provisional until the owner confirms it) to state this rule without a test. A single failed write followed by a successful retry is tested. | With a database that keeps failing, a run could go on unmetered, past its budget, while the ledger reported its usage as complete. |
| M70 | The API can show one decision by its identifier, a project's work items and their status, its git operations, a candidate's gate with its scope, reasons and per-check states, and its environments. | The design lists these reads, and no acceptance row names them. One read of that list, a project's open decisions, was added and is tested (errata E39); the others stay unbuilt in M1 unless the owner asks for them. | A person driving the engine through the API cannot see which work exists and in what status, why work is parked, which git operations are pending or blocked, or why a gate was not satisfied, except in the answer returned at the moment of evaluation or by opening the database. |
| M70 | The one-line status the API gives for each project shows "refused" when the repository cannot be read, when an out-of-band change is unresolved, or when the database fails; and "unknown" when the status cannot be worked out. | The test builds one "refused" situation, a run whose termination cannot be confirmed. The other situations are each tested for what they block, but not for what the status line says about them. | A project that is blocked for one of those reasons could be shown as idle, ready or waiting on the person, so the status line would point away from the real problem. |
| M70 | A request to read a record is refused when the record's file has been replaced by a real device file. | Making a real device file needs administrator rights, which the tests do not have. A link that leads to a device is tested, along with a link to another file, a named pipe and a file of another size. | Only if a process with administrator rights replaced a record's file: the read could hang or return endless data. |
| M72 | The event stream can be limited to the events of one project. | The design names this filter; the acceptance row does not, and the test does not use it. | A client that asks for one project's events could receive every project's, or have its request refused. |

## Class C: cannot be observed from outside (1 case)

| Plan row | Behaviour | Why no test can see it |
|---|---|---|
| M71 | Under the declared maximum load, the number of database commands waiting and the duration of each database transaction stay within bounds. | These are the engine's own internal measurements. A test that watches the engine from outside sees only how quickly it answers, and that is tested. |

## Counts

| Class | Cases |
|---|---|
| A, unreachable in M1 | 14 |
| B, real behaviour, not tested | 18 |
| C, cannot be observed from outside | 1 |
| Total | 33 |

Several entries stand for more than one situation and are counted once, as `COVERAGE.md` records them: for example M25 with M46, M31 with M32, the two entries for the decision rows, and the first M70 entry, which covers five reads.

## The class-B cases that matter most for a first hands-on run

Most important first. The order is the Verifier's judgement of what a person driving the engine by hand, with the scripted adapter, is most likely to meet.

1. **The reads that are not built (M70).** A person at the API can see a project's status line, its runs under way, its open decisions and a candidate's latest gate outcomes. They cannot list work items, see why work is parked, see pending git operations, or see why a gate was not satisfied after the fact. A hands-on run will need the database open beside it.
2. **The "reject" answers (M49 to M55).** A first run will try saying no. Nothing establishes what happens then for any of the seven kinds of decision that offer it.
3. **The status line's other causes of "refused" (M70).** The status line is the first thing a person reads. For a repository that cannot be read or an unresolved out-of-band change, nothing establishes that it says "refused".
4. **"Adopt" for edits found in the developer's checkout (M25, M46).** Editing a file in the checkout during a run is an easy thing to do by accident, and "adopt" is one of the two answers offered.
5. **An answer given on an outdated preview, for the facts that are not tested (M45 to M55).** A person who pauses between reading a preview and answering is the normal case in a hands-on run.
6. **A git commit or branch update that hangs while the engine runs (M15), and git output over the cap (M20).** Both depend on the repository and the machine. A hands-on run on a real repository, on a slow disk, is where they would first appear.

## What this list leaves out

This list covers named cases of the acceptance plan that were left unwritten. Three other kinds of thing are also not claimed by M1 and are recorded elsewhere:

- **Capabilities M1 excludes by design:** sessions, deployment, publication, any real agent backend, the user interface. The build specification, section 3, lists them, and the tests establish that each is refused.
- **Limits of the test instruments,** which the M1 acceptance report must state: that the host's storage really keeps what the engine syncs to it; that the engine measures durations on a clock that cannot step; that the scripted stand-ins for the agent and for process containment qualify no real agent and no real containment.
- **Details the tests leave open** inside behaviour they do establish, such as the exact wording of a reason or what holds at exactly a limit. `COVERAGE.md` and the test contract (`packages/engine/test/acceptance/harness/SEAM.md`) mark each as "not pinned".

One further item comes from this pass. Through the third slice a self-check, deleted since, verified a property of one of the Verifier's own tables: that the rule deriving a git operation's status covers every combination of inputs (row M34). That was a check of the tests' expectations, not of the engine, and nothing performs it now.
