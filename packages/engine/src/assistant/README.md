# Workspace assistant

This module is separate from project-role sessions and Vision. `api/server.ts`
instantiates it behind the existing Host, origin, token, startup-mode and body
limits. Which provider answers is decided by real configuration (the assistant
design of 2026-10-27, §2):

- with no `workspace_assistant` block in config.json the assistant is
  **unconfigured** outside the engine's test mode, and only the test mode
  selects the deterministic in-process fake (`seamScriptedProvider()`);
- with a block, the **real path** runs (even in the test mode, where the
  scripted backend stands in for a real one): `GET /v1/assistant` derives
  `state` (unconfigured, credential_missing, qualification_pending,
  limit_reached, ready) from the block, the held credential, the active
  assistant-template trust entry and the usage account; a message is admitted
  in the store's transaction of its receipt, reserving the turn limit against
  the account's day (store/transitions/assistant.ts), dispatched by the
  scheduler's tick through the choke point (invoke/assistant-turn.ts) in a
  domain with no repository, and charged one ledger row of the
  `workspace_assistant` account. The engine chooses the reads; the model's
  reply is held to its schema and its evidence (turn-package.ts) and never
  becomes an action.

`contract.ts` describes messages, context, evidence and fake usage. The gateway
reads the same store projections used by ordinary GET routes, with an allowlist,
closed arguments, fixed scope and limits. A gate request must identify its
candidate; reading a gate never evaluates it. Evidence contains the source read,
observation/read timestamps, snapshot sequence and the actual returned state.
Missing data and oversized reads remain explicit unknown/error evidence. Fake
answers are commentary, not engine-authored consequences or approval answers.

## Persistence and attribution

Conversations are private mode-600 JSON files in the engine home's `assistant/`
directory (mode 700), atomically replaced and fsynced. Message intent fingerprints
bind text and context and survive process restart. A persisted owner request with
no completed response remains unknown and is never replayed. A new read can use a
new intent; it cannot retroactively complete an old one. A maximum of 20
conversations and 100 messages per conversation refuses further writes rather
than silently discarding history. Explicit DELETE removes conversation text when no unresolved action receipt needs it.

Action receipts live separately in `assistant-actions/`, with the same private,
atomic persistence. They survive conversation deletion to preserve duplicate
protection and remain readable through `GET /v1/assistant/actions`. Deletion is
refused while a conversation has a claimed, partial or unknown action, so its
recovery context cannot disappear. At 500 receipts new actions are refused. There is intentionally no
receipt purge endpoint that could erase an unknown action and permit replay.
This retention policy is experimental; production retention/accounting need an
explicit design decision before real provider enablement.

API request IDs attribute owner messages and claims to their real initiating HTTP
request. Assistant messages have a distinct assistant actor label. Fake usage is
attributed to `workspace_assistant`, cost `measured_zero`, and unknown token counts
remain null. Real assistant accounting cannot borrow a project's or a provider
qualification fixture's budget.

## Action bridge

A clear owner message may request `create_app` or `start_planning`. This fake-only
bridge accepts an explicit claim referencing the stored **user** message intent,
never a tool string or assistant reply. Missing create fields come from the owner
form. Default settings are displayed by the UI and no widening fields exist.
Planning claims require an unambiguous start request and the project's identity
bound to that message. A named, potentially different app is not silently replaced
by the current scope.

The browser uses the existing request builders and shared action implementations;
this module performs no project mutation. Before each ordinary API action, the UI
records a closed, exact step claim (`create`, `resume`, `open`, `turn`). The same step
cannot be claimed twice. A global target lock prevents another conversation or
new intent from replaying an unresolved action. Claims compare canonical JSON, so
object key order is irrelevant. Unknown claimed steps cannot advance or be reset.

The UI subsequently records an immutable `client_report` with outcome and, when
available, the ordinary API mutation's request ID. This report is supplemental
correlation, **not authoritative completion evidence**. The existing public API
still applies its own guards, journal transitions, owner actor, audit and budget
checks. Fresh ordinary reads establish what happened. Receipt `completed` means
the client reported the last API step; it does not establish planning completion.
An uncertain outcome offers inspection/recovery in the existing workspace, never
automatic replay. A rejected partial start can be resumed only after the UI's
fresh session reads establish the safe next step.

This bridge does not grant a future model authority to fabricate claims, populate
forms or choose mutation arguments. Real provider use requires separately reviewed
execution qualification, charging limits, authorization binding and attribution.
There is no approve, policy, deploy, shell, filesystem or arbitrary-URL tool.

## Safety limits

Provider input and persisted/output text pass through the engine redactor, secret
detectors and explicit API-token masking. Raw records, logs, transcripts, secrets
and repositories are not read into model context. Requests are capped at 4,000
characters, 16 tool reads, 48,000 evidence characters and two concurrent responses.
There is no retry loop. A real turn is admitted against the account's day in
billable tokens (dollars shown, never limited), stopped at its turn limit, its
deadline or the owner's cancel, and recovered, never replayed, after a
restart.
