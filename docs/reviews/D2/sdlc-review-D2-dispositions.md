# D2 Cross-Review Dispositions

**Draft 1 review:** `sdlc-review-D2-Astra.md` (approve with amendments; 9 blocking, 5 non-blocking; K1 to K9 accepted, five with a variant; one new correction K10 from B04). Applied in draft 2.
**Dispositions by:** Sean, one at a time, 2026-10-03, with the driver's recommendation on each (errata E56). The "draft 2" column is filled by the architect when draft 2 is written and checked by the driver.
**Rule in force:** E20 and E48 item 2. This was the one cross-review. Draft 2 applies these dispositions; there is no draft 3 unless Sean asks for one. After draft 2, a finding is a decision for Sean or a failing acceptance test.

## Blocking objections → draft 2

| # | Finding, in short | Disposition | Draft 2 (section) |
|---|---|---|---|
| B01 | An empty cgroup is not closed: a launcher not yet placed can enter after termination was recorded; recovery trusts absence without observing prior supervisor leaves empty | **Accepted as written.** Termination requires closure to future placement and observed emptiness; a launcher needs a current authorization bound to domain, invocation, incarnation and lease generation before any role code; an ending run never authorizes; recovery observes every prior supervisor leaf empty or establishes its absence in the verified hierarchy; otherwise unknown and quarantine; once terminated, never repopulated. Folded into K1 and K4. | |
| B02 | A read-only bind can expose a live socket or credential; `sandbox_read_paths` and whole `/etc` carry authority; git metadata view unspecified | **Accepted as written.** The mount plan resolves and validates sources, submounts and aliases before launch; no widening can expose the control plane, other workspaces, the developer's checkout, credential locations, host sockets, devices or WSL interop; only enumerated `/etc` files; an engine-constructed git metadata view; nothing inherited by descriptor; `/dev/shm` private; qualification covers the effective profile. | |
| B03 | The proxy must connect to the address it validated | **Accepted as written.** Resolve once per attempt, validate every address under one IPv4/IPv6 policy, connect only to a validated numeric address, refuse a set containing a forbidden address, bounded tunnels and bytes, the probe-only echo exception bound to one test endpoint. | |
| B04 | The trust table cannot bootstrap: no entry, no launch; only a launch creates an entry. The cancellation canary's usage trigger may never fire | **Accepted as written.** A distinct operator-authorized qualification attempt, fully bound before launch, whose authority cannot dispatch project work; unknown egress destinations are refusals to review; the cancellation canary cancels at an independently observed work barrier. **K10**, a correction to D1 §17.11 and §15.1, decided by Sean. | |
| B05 | Cgroup containment does not stop backend-native delegation from reporting success with work unfinished (Codex `multi_agent` on by default, verified); the containment canary trusts the transcript | **Accepted as written.** One-shot templates disable delegation, scheduling and background continuation; qualification establishes the effective tool surface, and no inventory is not passing evidence; canary attempts are witnessed by their effects against real targets. | |
| B06 | Usage reporting per model call is not a per-call enforcement boundary; a role-held key makes backend usage attributed evidence, not a meter | **Accepted as written.** Reporting granularity and enforceable boundary are separate entry fields; `model_turn` enforceable only where qualification shows admission control or a bounded overshoot; otherwise `invocation`, and a finer policy is refused; a hard maximum the engine cannot enforce is refused; no confirmation labels an estimate as a maximum. Folded into K6. | |
| B07 | The draft nulls known usage on a cancelled run; the kernel keeps it (`chargeInvocation`), and must | **Accepted as written.** Observed usage retained with `usage_complete = false`; only the unobserved remainder unknown; the C4 allowance charged separately and once; D2-A09 replaced. Folded into K6. | |
| B08 | Redaction after collection leaves raw provider files on disk before collection and after a crash | **Accepted as written.** Provider home, temporary output and the unvalidated result in bounded volatile, swap-excluded storage; only redacted, validated collection into durable records; a crash loses volatile output and records it missing, never an empty success; registered raw and escaped secret forms screened before workspace content or output is admitted to evidence or git, a hit refusing publication and raising the security finding. The engine home stays on disk (E36 item 7). Folded into K4. | |
| B09 | Memory and pids limits do not bound writable storage, supervisor-side work or concurrent domains | **Accepted as written.** A host resource envelope reserving capacity for the engine; the profile bounds processes, memory with a stated swap policy, writable bytes and inodes (a profile without enforceable storage bounds is refused); supervisor-side bounds on parsing, queued bytes, collection entries, egress connections and log growth; bounds cancel and record incomplete evidence; each resource tested alone and together. | |

## Non-blocking suggestions → draft 2

| # | Finding, in short | Disposition | Draft 2 (section) |
|---|---|---|---|
| N01 | A buffered heartbeat read after a pause proves nothing fresh | **Accepted.** Pause recovery uses a bounded fresh challenge-response on the init channel bound to invocation and lease generation; the response reports an already-exited backend; re-grant never changes the deadline, restores budget or reverses an ending. Folded into K5. | |
| N02 | Exit class and domain observation need separate, total classification | **Accepted.** A tested precedence for overlapping observations; an engine cancellation keeps its initiating outcome; a resource counter rise is recorded whether or not it caused exit; unknown domain termination forbids collection and ending; known termination with unknown exit permits redacted unaccepted-output collection and failed/recovered, never completion. Folded into K4. | |
| N03 | A trust entry's host qualification is historical; dispatch needs a current compatible one | **Accepted.** `trust_entries.host_qualification` is evidence; dispatch requires a current active qualification of a compatible mechanism and profile; a compatible restart restores dispatch without a paid canary; the activation preview binds the full evidence and configuration fingerprint. | |
| N04 | Canary diagnostics and the qualified capability scope made explicit | **Accepted.** Structured redacted provider errors kept and classified; unexpected contacts reported with destination and refusal; the entry records the exact template, auth mode and capabilities; one-shot qualification never establishes continuation; D2-T07 claims no `open_idle`. | |
| N05 | Keep the insecure bootstrap opt-in out of a normal M2 run | **Accepted.** `ui_bootstrap` false in M2's qualified configuration; the opt-in only in labelled compatibility tests; the engine read and the report state when the exception is in force. With K3. | |

## Corrections to D1 (K1 to K10)

| # | Astra's judgment | Sean's decision |
|---|---|---|
| K1 | Accept with a variant (B01) | Accepted with the variant |
| K2 | Accept | Accepted |
| K3 | Accept (M1 bootstrap case opts in; add a default-off case) | Accepted |
| K4 | Accept with a variant (B01, B08, N02) | Accepted with the variant |
| K5 | Accept with a variant (N01) | Accepted with the variant |
| K6 | Accept with a variant (B06, B07) | Accepted with the variant |
| K7 | Accept; a stricter policy choice, not a necessary reading of F §6.3 | Accepted |
| K8 | Accept | Accepted |
| K9 | Accept with a variant (conditional on B01 to B03 and profile qualification) | Accepted with the variant |
| K10 | New, from B04: a narrowly scoped qualification authority as a correction to D1 §17.11 and §15.1 | Accepted |

## Open questions and carried decisions

| Q | Decided by | Decision |
|---|---|---|
| Q1 | **Sean** | Dedicated API keys per provider, delivered by the grant; the key-delivery path is qualified, not assumed from a name in the binary |
| Q2 | **Sean** | The role holds its provider key in M2, recorded with the limitation that backend usage is attributed evidence, not an independent meter of all that key could spend; a provider-enforced cap where a hard maximum is required; proxy credential injection deferred until its transport and accounting are qualified |
| Q3 | **Sean** | WSL2 is eligible to qualify as a host, subject to H1 to H10 including the WSL-specific checks; qualified only by executable evidence |
| Q4 | **Sean** | Filter drivers, Git LFS and partial clones stay unsupported in M2 (E29 item 1, E37 items 1 and 5 stand) |
| Q5 | **Sean** | Codex's inner sandbox disabled in the qualified template; the outer sandbox carries the guarantee |
| Q6 | **Sean** | Decided with the UI; a one-time CLI-delivered code preferred over `/proc/net/tcp` attribution; nothing needed for M2 |
| Q7 | **Sean** | A paid canary runs only by the operator's explicit command and approval, bound to the attempt, showing the enforceable cap or a labelled estimate; a binary change may offer qualification, never run it |
| C1 | **Sean** | The finding-disposition flow; a real Reviewer's argument is `claimed` evidence with its references resolved into retained records before the decision is consumed |
| C2 | **Sean** | Both restrictions (K7, K8); neither approval turns a non-passed check into a pass |
| C3 | **Sean** | The M1 acceptance of roles reading the token is withdrawn once the sandbox exists; the harness lane stays labelled kernel evidence; every production isolation claim is tested through the real boundary |
| C4 | **Sean** | Estimated cost counts toward the daily limit, shown apart from reported dollars; the unknown allowance charged once per invocation; known partial usage retained; the estimated component is never called verified |

## Astra's four questions for Sean

1. Q1 to Q7 and C1 to C4: decided above; Q2's limitation is recorded as she asked.
2. The qualification authority (B04, K10): approved.
3. The raw-storage contract (B08): the volatile-storage and screened-publication form; the before-disk promise stands unchanged.
4. The bootstrap opt-in (N05): kept out of qualified production M2.
