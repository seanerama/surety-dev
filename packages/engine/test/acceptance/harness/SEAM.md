# The test seam

**Owner:** the Verifier (build spec §4). **Written:** slice 1, 2026-10-01. **Amended:** 2026-10-01, after the slice-1 review (section 11). The owner's decisions on that review are cited below as E23, the erratum that records them. **Extended:** slice 2, 2026-10-01 (sections 12 to 20, and the amendments to sections 1, 6 and 7 that section 20 lists). **Amended:** 2026-10-01, after the slice-2 review (section 22 lists every change; the owner's decisions on that review are E25). Later slices extend it; a change to anything below is made by a Verifier session, normally in answer to an objection.

This file states exactly what the engine must provide for the acceptance tests to observe it (build spec §8). The tests are the contract; this file says in prose what they rely on. Where the sources (build spec §2) left a name, code, format or range open, the Verifier fixed it here; section 10 lists those choices. Everything else follows D1 Appendix A as corrected by build spec §6.

Paths are relative to the repository root unless they start with `$SURETY_HOME`.

---

## 1. The process

The tests run the built binary as `node packages/engine/dist/cli.js serve [flags]` with the working directory set to `$SURETY_HOME` and a constructed environment containing only `SURETY_HOME`, `PATH`, `HOME` (= `$SURETY_HOME`), `LANG=C.UTF-8` and `TZ=UTC`.

**Flags.** `--harness` enters harness mode (section 7). The flags below are accepted only together with `--harness`; given without it, or any unknown flag or command, the process exits with status **2** before doing anything else.

| Flag | Meaning |
|---|---|
| `--harness-migrations <dir>` | Read migrations from `<dir>` instead of `packages/engine/migrations/`. |
| `--harness-barrier <name>=<action>` | Arm a barrier at startup. Repeatable. `<action>` is `pause` or `kill`. |
| `--harness-scripted <dir>` | The scripted backend's directory (section 13). Without it the `scripted` backend is not qualified and nothing is dispatched. |

**Exit statuses.**

| Status | When |
|---|---|
| 2 | Usage error: unknown command or flag, or a harness flag without `--harness`. |
| 3 | `engine_locked`: another live incarnation holds the lock (section 3). |
| 4 | The configuration was refused (section 2). |
| 5 | `token_file_refused`: an existing `api.token` cannot be trusted: it grants a permission to group or others, is not a regular file, or does not hold a well-formed token (section 6). |
| 6 | The engine could not start listening: `home_unusable` (the engine home cannot be used) or `listen_failed` (the API port cannot be bound). See "A start that fails before listening", below. |

Statuses 4 and 5 are decided from what the engine can read before it takes the lock: such a start writes nothing under `$SURETY_HOME`, takes no lock and opens no store.

**Startup refusals** (statuses 3, 4, 5 and 6) write one line to stderr that is a JSON object `{"code", "reason", "what_to_do", "subject"}`, the same shape as an API refusal. Other stderr lines may be logs; the tests take the last line that parses as a JSON object with a string `code`.

**A start that fails before listening** (E23 item 11). Whatever stops a start before the listener is up, the process writes the one-line refusal and exits with a status from the table. It never ends in an uncaught error: no stack trace on stderr, and never Node's own exit status for one. Anything about the engine home that prevents the start and is not covered by statuses 3, 4 and 5 is status **6** with `code: "home_unusable"` and `subject: {"path": <the path that could not be used, relative to the engine home; "." for the home itself>}`. For a home that is not writable the tests accept `"."` or the name of the first file the engine could not create. The tests pin three causes: the home is not writable; a directory sits where `engine.lock.guard` should be; a directory sits where `api.token.tmp` should be. Such a start does not become an owner: it leaves no `engine.lock` and no `api.token` behind that were not there before, and once the cause is removed the next start succeeds. A port that cannot be bound is status **6** with `code: "listen_failed"` and `subject: {"port": <api_port>}`. A failure after the listener is up is not an exit: it leaves the engine restricted with `startup.failed` set (section 4), which is what a directory at `store.db` produces (`step: "store"`).

**Signals.** SIGKILL is used freely. SIGTERM is used to stop an engine before a test reads or copies its store; the tests do not pin what SIGTERM does beyond ending the process (they fall back to SIGKILL after 15 s).

**Engine home** (D1 §1.6). `$SURETY_HOME/config.json` (optional, written by the tests), `$SURETY_HOME/engine.lock`, `$SURETY_HOME/api.token`, `$SURETY_HOME/store.db` (with its `-wal` and `-shm` files).

## 2. Engine configuration

Engine-scope settings come from `$SURETY_HOME/config.json`, a JSON object. An absent file means every key takes its default. The file is read and validated **before** the lock is taken; a refused configuration exits with status 4 and writes nothing under `$SURETY_HOME`.

The closed key set, defaults, ranges and units are in `../contract/config.json` under `engine`. Values are JSON numbers in the unit stated there (durations are integer seconds, except `api_latency_bound` in milliseconds), except:

- `api_authority`: a string, exactly `127.0.0.1:<api_port>` or `localhost:<api_port>`. Default `127.0.0.1:<api_port>`. The API binds `127.0.0.1` regardless; the authority is what the Host check compares against.
- `body_cap`, `upload_cap`: fixed. Any other value is refused.
- `decision_targets`: an object mapping a `DecisionKind` (D1 A.2 plus `finding_applicability_exclusion` and `check_correction_tightening`) to an integer number of seconds in 300–2,592,000. `stop_confirm` and `abandon_confirm` have no target and cannot be given one. The effective map merges overrides over the defaults in `../contract/config.json` `decision_target_defaults` (`null` = no target).

**Validation.** Integers must be integers; `null` is never accepted for any key (it does not mean "default" or "unlimited"); strings are not coerced to numbers.

| Problem | `code` | `subject` |
|---|---|---|
| Unknown key | `unknown_field` | `{"field": "<key>"}` |
| Unknown decision kind | `unknown_field` | `{"field": "decision_targets.<kind>"}` |
| Wrong type, out of range, not allowed, `null`, fixed key changed | `invalid_value` | `{"field": "<key>"}` or `{"field": "decision_targets.<kind>"}` |

**Inspection.** `GET /v1/engine` returns `config`: an object with exactly one entry per engine key, each `{"value", "source"}` where `source` is `"file"` if the key was in `config.json` and `"default"` otherwise. For `decision_targets`, `value` is the effective map and `source` is `"file"` only if at least one override was given: an absent key and an empty object `{}` both override nothing, are valid, and report `"default"`.

**Project scope.** Ungoverned project keys (`../contract/config.json` `project`) are read with `GET /v1/projects/:p/policy`, which returns `{"effective": {<key>: <value>}, "revision": <the project's current policy revision number, or null if it has none>, ...}`, and changed with `POST /v1/projects/:p/policy`, whose body is an object of the keys to change. The submission is validated whole against the closed schema before anything else happens: an unknown key is `unknown_field`, any invalid value is `invalid_value`, both with `subject: {"field": "<key>"}` and HTTP 400, and a refused submission changes nothing (not the effective policy, the repository or the store). `max_concurrent_runs` accepts only `1` through M3 (E18). Slice 1 pins only refusals; a valid change commits through the journaled git path and is pinned in slice 3. Governed keys (`.surety/checks/protected-policy.json`, RN R2) are slice 5.

## 3. Engine lock and incarnation

`$SURETY_HOME/engine.lock` is a JSON object:

```json
{"incarnation_id": "inc_<ULID>", "pid": 12345, "pid_start_time": "987654", "started_at": "2026-10-01T12:00:00.000Z", "host_boot_id": "<uuid>"}
```

- `pid` is the pid of the `surety serve` process the test spawned.
- `pid_start_time` is field 22 of `/proc/<pid>/stat` (start time in clock ticks since boot), as a decimal string.
- `host_boot_id` is `/proc/sys/kernel/random/boot_id`, trimmed.

The lock is taken before the store is opened (D1 §1.3–1.4). An existing lock is held by a **live owner** when its `host_boot_id` equals the current boot id, a process with its `pid` exists, and that process's start time equals `pid_start_time`. Then the new process exits with status 3, `code: "engine_locked"`, `subject: {"incarnation_id": <the owner's>}`, and changes nothing: not the lock file, not the store (which it does not open). Otherwise the lock is **stale** and the new process takes it over without signalling the process named in it. Simultaneous starts produce exactly one owner.

A start refused with status 4 or 5 (section 1) never becomes an owner. It leaves `engine.lock` exactly as it found it: an absent lock stays absent, and a stale lock is not taken over. It adds no `engine_incarnations` row. Once the cause is removed, the next start proceeds as if the refused one had not happened.

Each incarnation that opens the store inserts one `engine_incarnations` row whose `id` is the lock's `incarnation_id` and whose `pid`, `started_at` and `host_boot_id` match the lock. `GET /v1/engine` reports it as `incarnation`.

## 4. Startup sequence and restricted mode

Steps, in order, with the names the engine reports (D1 §1.4): `lock`, `listen`, `store`, `recovery`, `integrity`, `full`, `scheduler`.

`GET /v1/engine` returns, among other fields:

| Field | Value |
|---|---|
| `version` | the engine version string |
| `incarnation` | the current incarnation id |
| `mode` | `"restricted"` or `"full"` |
| `harness` | `true` in harness mode, else `false` |
| `backends` | backends the engine would dispatch to; `[]` outside harness mode in M1 |
| `config` | section 2 |
| `startup.step` | the step in progress, or the failed step, or the last step once all completed |
| `startup.completed` | names of completed steps, in the order completed |
| `startup.failed` | `null`, or `{"step", "code", "reason", "subject"}` |

`GET /v1/health` returns 200 with `{"mode": ...}` in both modes.

**Restricted mode.** Only `GET /v1/health`, `GET /v1/engine` and the harness barrier routes answer; every other route returns **503** with `code: "engine_starting"` and `subject: {"step": <startup.step>}`. A failure in `store`, `recovery` or `integrity` leaves the engine running and restricted, with the failure in `startup.failed`; the scheduler is not started and `engine.started` is not emitted.

**Events.** Lifting to full mode emits `engine.mode_changed`; starting the scheduler emits `engine.started`, exactly once per incarnation.

## 5. Migrations

- Files in `packages/engine/migrations/` (or the `--harness-migrations` directory) whose names match `^(\d{4})_[a-z0-9_]+\.sql$`; the number is the order. Other files are ignored.
- All pending migrations are applied in one transaction at the `store` step, each recorded in table **`schema_migrations`** with columns `seq` (integer, the file's number), `name` (file name), `checksum` (lowercase hex SHA-256 of the file's bytes) and `applied_at` (timestamp format of section 8). A row is never rewritten.
- A migration that fails: `startup.failed = {"step": "store", "code": "migration_failed", "subject": {"migration": "<file name>"}}`; nothing from the batch is committed.
- An applied migration whose file is missing or whose checksum differs: `startup.failed = {"step": "store", "code": "migration_checksum_mismatch", "subject": {"migration": "<file name>"}}`.

**The one exception to the store-write rule** (E23; recorded, no test yet). D1 §6.3: no code outside `packages/engine/src/store/transitions/` writes to the store. The migration runner, `packages/engine/src/store/migrate.ts`, is the single named exception: it creates `schema_migrations`, appends to it and executes the migration files' SQL. A later lint for store writes must allow exactly that file and nothing else. The seam folder (section 7) is not an exception: a fixture installer there writes through a transition function exported from `src/store/transitions/`.

## 6. HTTP API in slice 1

Every request, before routing or reading the body:

1. **Host.** The `Host` header, and the authority of an absolute-form request target if present, must equal `api_authority` exactly. Otherwise **400** `host_refused`. A request with more than one `Host` header line is refused the same way whatever the lines say, including two identical lines that each name the authority (HTTP/1.1, RFC 9112 §3.2): the check is made on every `Host` line the client sent, not on the one a parser kept.
2. **Token.** Header `X-Surety-Token` must equal the content of `$SURETY_HOME/api.token` (compared after trimming trailing whitespace from the file). Missing: **401** `token_required`. Present but wrong (including wrong length): **401** `token_invalid`. Every slice-1 route needs it, `GET /v1/health` included (D1 §11.1: every origin-less request).

**`Expect: 100-continue`** (D1 §11.1). The Host check comes before any interim response: a request it refuses gets its 400 and no `100 Continue`. A request with a valid Host and token for a command that reads a body is sent `100 Continue`, and its final response once the body has arrived. Slice 1 does not pin whether a token refusal or an unknown route is answered before or after `100 Continue`; the Origin, Referer, fetch-metadata and body-cap refusals are slice 6.

`api.token` is created at first start before the listener starts, with mode 0600 (no group or other bits), holds at least 32 characters, and is unchanged by a restart.

An existing `api.token` with any group or other permission bit set (`mode & 0o077 != 0`) refuses the start with status **5**, `code: "token_file_refused"`, `subject: {"file": "api.token"}`. The file may already have been read by someone else, so the engine neither repairs its mode nor replaces the token; it writes nothing under `$SURETY_HOME` (section 1) and leaves the lock as it found it (section 3).

The same refusal, with the same status, code and subject and the same "writes nothing, replaces nothing", answers an existing `api.token` that cannot be a token (E23 items 8 and 12):

- **It is not a regular file.** A named pipe at `api.token`, with any mode, is refused promptly. The engine must not block opening or reading it; the tests allow ten seconds and send nothing into the pipe.
- **It is malformed.** The token is the file's content with trailing whitespace removed. It is well formed when it has at least 32 characters and every one of them is a visible ASCII character (0x21 to 0x7E). So an empty file, a file of whitespace only, a shorter token, leading whitespace, a line break or control character inside the token, and any non-ASCII character are all refused. Whether a space or a tab inside the token is refused is not pinned. A token the engine creates itself is well formed by this rule.

**`Expect` other than `100-continue`** (E23 item 12). The engine answers such a request itself; the HTTP library's automatic `417` must not get there first. The order of checks is unchanged: with a Host the Host check refuses, the answer is **400** `host_refused`. With a valid Host and token, on any route, the answer is **417** with `code: "expect_refused"` and `subject: {"expect": <the header value>}`; no interim response is sent, the route is not reached, and on a mutating request in full mode the refusal is audited like any other (`api.act` with `status: 417`). What a request with a valid Host, no valid token and such an `Expect` gets (401 or 417) is not pinned.

**Refusals** are a top-level JSON object `{"code", "reason", "what_to_do", "subject"}` with non-empty `reason` and `what_to_do` (D1 §11.5). Status codes used in slice 1:

| Status | Codes |
|---|---|
| 400 | `host_refused`, `unknown_field`, `invalid_value` |
| 401 | `token_required`, `token_invalid` |
| 404 | `not_found` |
| 409 | `illegal_transition`, `confirm_required`, `decision_stale`, `decision_consumed` (slice 2, section 17) |
| 417 | `expect_refused` |
| 500 | `store_error`, `audit_failed` |
| 501 | `unsupported` |
| 503 | `engine_starting` |

**Audit.** In full mode, every mutating request (any method other than GET and HEAD) that passes the Host check, including every refusal after it, writes one `api.act` event with `actor_kind = "human"`, a non-null `request_id`, and `payload` containing at least `{"method", "path", "status"}`, where `path` is the request path without query string and `status` the HTTP status returned. No event row contains a presented token value. The response carries header `X-Surety-Request-Id` with the same request id, and the domain events the command writes carry the same `request_id`. If the `api.act` write fails, the mutation is refused with **500** `audit_failed` and has no effect. In restricted mode the store may not be open, so no refusal issued while the engine is in restricted mode needs an audit event (E23): not a `503 engine_starting`, and not a `401` for a missing or wrong token during startup. The tests neither require nor forbid an `api.act` event for such a refusal.

**Routes slice 1 needs.**

| Route | Behavior |
|---|---|
| `GET /v1/health` | section 4 |
| `GET /v1/engine` | section 4 |
| `GET /v1/projects/:p/policy` | section 2 |
| `POST /v1/projects/:p/policy` | section 2 (refusals only in slice 1) |
| `POST /v1/projects/:p/pause`, `/resume` | Set or clear `projects.paused` and emit `project.paused` / `project.resumed` in the same transaction (D1 §8.4, §11.4). 200 on success. |
| `POST /v1/projects/:p/sessions`, `POST /v1/projects/:p/sessions/:r/turns`, `/save`, `/close` | **501** `unsupported` regardless of whether `:r` exists; no row written except the audit event. |
| `GET /v1/projects/:p/management`, `GET /v1/projects/:p/releases` | **501** `unsupported`. |
| Any request for deploy, publish, export or management activation | Refused with `unsupported` or `not_found`, no effect. M1 defines no route for them. |

A store failure inside a command's transaction is **500** `store_error` and leaves no partial change and no event of that transition.

## 7. Harness mode

Entered only by `--harness` at startup (build spec §8). `GET /v1/engine` reports `harness: true`. Outside harness mode every `/v1/harness/...` route is **404** `not_found` and has no effect, and the harness flags are a usage error.

Harness routes pass the same Host and token checks, write no `api.act` event, and are not part of `api/schema.json`.

| Route | Body | Result |
|---|---|---|
| `POST /v1/harness/fixtures/project` | `{"name", "tier", "dev_repo_path", "integration_branch"}` | **201** `{"project": {"id": "proj_<ULID>"}}`. A registered project on that repository, written by a transition that emits `project.created` with `subject.project` = the id and `payload.test_fixture = true`. The tests always pass a real git repository with one commit on the integration branch, which is checked out nowhere else; later slices' startup integrity must accept a project installed this way. |
| `POST /v1/harness/faults` | `{"point": "before_event", "event_type": "<EventType>"}` or `{"point": "audit_write"}` | **2xx**. Arms a one-shot fault. `before_event`: the next transaction that is about to append an event of that type fails after its domain writes and before the event write. `audit_write`: the next `api.act` write fails. |
| `GET /v1/harness/barriers` | — | **200** `{"barriers": [{"name", "action", "state"}]}`, `state` one of `armed`, `waiting`, `released`, `fired`. Answers in every mode. |
| `POST /v1/harness/barriers/:name/release` | `{}` | **2xx**. Releases a `pause` barrier that is `waiting`. Answers in every mode. |

**Barriers in slice 1.**

| Name | Where | Fires |
|---|---|---|
| `migration.before_commit` | In the `store` step, after every pending migration's SQL has run and its `schema_migrations` row has been inserted, before the transaction commits. | Only when at least one migration is pending. `kill`: the engine sends itself SIGKILL. `pause`: the store step waits until released while the listener keeps answering in restricted mode. |

Slice 2 adds the scripted backend and execution boundary (sections 13 and 14), the plan and trigger fixtures and the work-item transition route (section 15), and more barriers, the controlled clock, a tick fault and the allocation route (section 18). Every one of them follows the rules of this section: a `/v1/harness/...` route exists only in harness mode, passes the Host and token checks, writes no `api.act` event and is implemented in the seam folder. Later slices add the notification sink of build spec §8.

### Confinement (row M74)

Build spec §8: "Production code reaches the seam through one module. Nothing else in `src/` branches on being under test." The owner tightened this after the slice-1 review (E23). In this section:

- the **seam folder** is `packages/engine/src/testing/`;
- the **seam module** is `packages/engine/src/testing/seam.ts`, imported as `…/testing/seam.js`;
- the **CLI entry point** is `packages/engine/src/cli.ts`;
- **production source** is every `.ts` file under `packages/engine/src/` outside the seam folder, the CLI entry point included.

**The rule.** Every harness-only behaviour is implemented in the seam folder: serving the `/v1/harness/...` routes, arming and firing faults, the barrier registry and its waits, fixture installation and its label, the store operations those need, and the `harness` field of `GET /v1/engine`. Production source does three things only. The CLI entry point parses the `--harness…` flags and hands the result to the seam module. A production file may import the seam module. It may call the functions the seam module exports, at the points where the harness has a hook (a route that no production route matched, a barrier point, an event about to be written, the engine description). Nothing in production source asks whether harness mode is on; outside harness mode each seam function does nothing, or refuses, by its own check. The seam folder may import production modules, and its store writes go through transition functions (section 5).

**The test.** `M74-seam-confinement.test.mjs` reads the source text with comments removed (`source-lint.mjs`) and fails on each of the following, naming the file and line:

1. **One door.** In production source, a string or template literal that names a path inside the seam folder, unless it is the module specifier of a static `import` declaration and resolves to the seam module. A relative literal is resolved against its file; any other literal counts if it contains the path segment `testing/`. So: no import of a second module of the seam folder, no `import()` or `require()` of the seam module, no `export … from` it, no worker file or URL inside the folder.
2. **Call only.** In production source, a value imported from the seam module that is used in any way other than being called: `name(…)`, or `ns.name(…)` for a namespace import. Types are not values: an `import type` declaration or a `type` specifier is not checked. A use is any occurrence of the imported name outside import and re-export declarations, except as a property of something else (`x.name`) or as a key or parameter name (`{ name: …`, `, name: …`, `(name: …`).
3. **No harness names.** In production source, the word `harness` or `test_fixture`, in any letter case, inside an identifier, a property name, or a string, template or regular-expression literal. These are the names this file fixes for what a client can observe of harness mode (the route segment, the `GET /v1/engine` field, the startup flags, the fixture label), so code that produces or tests them has to spell them. One exception: in the CLI entry point the word `harness` may appear in identifiers, and in string and template literals only as part of a `--harness…` flag.

**What a passing test proves.** No production file imports anything of the seam folder but the seam module, or holds a seam export as a value. No production code spells a harness route, a harness-named store operation, the `harness` field or the fixture label, so those are produced inside the seam folder. The flags are named in the CLI entry point and in no other production file.

**What it does not prove.**

- That production code never branches on what a seam function returned. The inspection cannot tell a hook from a question about the mode: a seam export that reports the mode under another name and is only ever called passes all three rules (the harness self-check pins this limit). The behaviour is observed from outside by row M08, "the test seam is unreachable outside harness mode".
- Anything about a name assembled at run time, about `dist/`, or about the seam folder's own code, including that every seam function is inert outside harness mode.
- Anything about behaviour selected by a plain parameter that only a harness flag sets. `--harness-migrations` reaches the store as an ordinary migrations directory.
- Scope. The inspection is lexical and does not resolve bindings, so a local name that shadows a seam import is reported as a use of it.

## 8. Store schema the tests write against

Rows M02, M03 and M04 open `$SURETY_HOME/store.db` directly with the pinned driver (`PRAGMA foreign_keys = ON`, `busy_timeout = 5000`) and insert rows. The schema must accept those inserts.

**Columns.** Table and column names are D1 A.3's. Every table has `id` (TEXT, primary key) and `created_at`. The project-scoped tables written by the tests have a `project` column (TEXT, NOT NULL, references `projects`): `work_items`, `runs`, `turns`, `execution_domains`, `capability_grants`, `invocation_receipts`, `invocation_status_observations`, `usage_observations`, `ledger_rows`, `operations`, `git_journal_events`. `events` has no required `project` column; a project-related event carries the project id at `subject.project`. Every A.3 field marked `*` is NOT NULL; every unmarked field, and any column the engine adds, is nullable or has a default. The tests supply exactly `id`, `created_at`, `project` where listed, and the `*` fields (`../harness/seed.mjs`).

**Value formats.** Ids: the A.1 prefix plus a 26-character ULID in Crockford base32. Timestamps: ISO-8601 UTC with milliseconds, `YYYY-MM-DDTHH:MM:SS.sssZ`. `day_utc`: `YYYY-MM-DD`. Booleans: integers 0 and 1. JSON-typed fields (`{}`, `[]` in A.3): JSON text. Shas: 40 lowercase hex. Enumerations: A.2 values. `events.tx`: an opaque string.

**Foreign keys.** Declared with `REFERENCES`. `turns`, `invocation_receipts` and `execution_domains` reference each other; the tests insert a turn, then its receipt, then its domain, in one transaction with `PRAGMA defer_foreign_keys = ON`, and the schema must accept that order.

**Constraints the tests pin** (build spec §6 correction 10; D1 §6.2):

- `invocation_receipts`: unique `run` where `turn IS NULL`; unique `turn` where `turn IS NOT NULL`; an insert is refused if `turn` is non-null and that turn's `run` differs from the receipt's `run` (the turn row exists by then), or if `turn` nullability disagrees with the run's `kind` (`one_shot` ⇔ null).
- `ledger_rows`: unique `invocation` where `corrects IS NULL`. A correction row (`corrects` set, `correction_seq` set) for the same invocation is accepted.
- Append-only: UPDATE and DELETE are refused on `invocation_receipts`, `invocation_status_observations`, `usage_observations`, `ledger_rows`, `git_journal_events` and `events`.

Every refusal must raise an error whose code starts with `SQLITE_CONSTRAINT` (a constraint, or a trigger using `RAISE(ABORT|FAIL|ROLLBACK, ...)`); a silently ignored write (`RAISE(IGNORE)`, `INSERT OR IGNORE`) fails the tests.

**Absent in M1.** `mechanic_issues`, `triage_dispositions`, `product_intent_contracts`, `adoption_analyses`, `export_records`, `promotion_records` (reserved, build spec §3), `observation_jobs`, `observation_history` (not built).

`stream_chunk_receipts` is not written by slice-1 tests: its parent is the pre-publication stream identity of build spec §6 correction 21, which slice 4 fixes.

## 9. Events

`events` columns are A.3's: `seq` (store-wide, strictly increasing), `at`, `type` (A.6), `subject` (JSON), `actor_kind`, `actor_id`, `request_id`, `operation`, `payload` (JSON), `tx`. Slice-1 tests read `project.created`, `project.paused`, `project.resumed`, `engine.started`, `engine.mode_changed` and `api.act`. They tolerate `engine.tick` appearing at any time.

## 10. Names the Verifier fixed in slice 1

Each of these was open in the sources (build spec §4, "Who decides what the sources leave open"). The Builder may object.

| What | Fixed as | Why this choice |
|---|---|---|
| CLI command and harness flags | `surety serve`, `--harness`, `--harness-migrations`, `--harness-barrier` | D1 §1.1 names `surety serve`; flags are the plainest form. |
| Exit statuses | 2 usage, 3 `engine_locked`, 4 configuration refused, 5 `token_file_refused` | The scaffold already uses 2 for an unknown command. 5 is the next free status (section 11). |
| Where engine config lives | `$SURETY_HOME/config.json`, read before the lock | The port must be known at step 2, before the store opens at step 3 (D1 §1.4), so it cannot live only in the store's `config` table. |
| New engine keys | `api_port`, `api_authority`, `git_deadline`, `git_deadline_long`, `git_output_cap`, `decision_targets` | Correction 20 and Review B17 require them; D1 §7.1 gives the 60 s and 600 s git deadlines. |
| New project keys | `snapshot_max_files`, `snapshot_max_bytes`, `snapshot_max_file_bytes` | D1 §7.3 step 5 "size and kind caps per policy". Kind caps are not separately configurable. |
| Ranges and units | `../contract/config.json` | A.9 where given, converted to seconds; otherwise the Verifier's choice, recorded there. |
| Decision-target defaults for the two RN R4 kinds | 1 day each | The same as their siblings in A.8 (`finding_disposition`; `check_correction_*`). |
| Config error codes | `unknown_field` (A.7), `invalid_value` (new) | A.7 has no code for a bad value. |
| Excluded-capability code | `unsupported`, HTTP 501 | No A.7 code fits; build spec §3 calls these "present only as a refusal". |
| Startup step names | `lock`, `listen`, `store`, `recovery`, `integrity`, `full`, `scheduler` | D1 §1.4's seven steps. |
| Migration table and failure codes | `schema_migrations(seq, name, checksum, applied_at)`; `migration_failed`, `migration_checksum_mismatch` | Correction 19 requires the table; D1 names neither. |
| Migration file names | `NNNN_name.sql` | Build spec §5 says "numbered .sql files". |
| Lock record | adds `pid_start_time` to D1 §1.3's fields | Distinguishing a reused pid (Plan M06) needs the process start time. |
| HTTP status codes | section 6 table | D1 fixes only 503 for `engine_starting`. |
| Request id header | `X-Surety-Request-Id` | D1 §12.1 requires events to name the request; the header lets a client tie a response to its audit record. |
| `api.act` payload keys | `method`, `path`, `status` | Plainest attributable record. |
| Fixture label | `project.created` with `payload.test_fixture = true` | Build spec §3: fixtures are "clearly labeled". |
| Harness routes, faults, barrier | section 7 | Build spec §8 leaves the mechanism to the Verifier. |
| Project-scoped tables carry `project` | section 8 list | A.3: "every project-scoped table has `project`"; the list makes it explicit. |
| Token-file refusal | `token_file_refused`, `subject: {"file": "api.token"}`, decided before the lock | A.7 has no code for it. `token_invalid` is the API's answer to a wrong presented token and is not reused. The form follows `host_refused`, `origin_refused`, `backend_refused`. Refusing, rather than repairing the mode, keeps an exposure visible. Deciding it before the lock makes it behave like the configuration refusal. |
| Seam module and folder | `packages/engine/src/testing/seam.ts` in `packages/engine/src/testing/`; CLI entry point `packages/engine/src/cli.ts` | Build spec §7 puts the engine side of the seam in `src/testing/`; the Builder named the module; section 7 "Confinement" needs fixed paths to inspect. |
| `100 Continue` for an accepted request | Sent to a request with a valid Host and token for a command that reads a body, before the body is read | D1 §11.1 places `100 Continue` after the Host check, which presumes it is sent; HTTP/1.1 requires a server to answer the expectation with 100 or a final status. |

## 11. Amendments after the slice-1 review

A Reviewer found four behaviors of the slice-1 build that the tests did not catch. Each was a contract defect and became a failing test (2026-10-01). What changed in this file:

| Finding | Now stated in | Test |
|---|---|---|
| A second `Host` header line got past the Host check | section 6, item 1 | `M69-boundary-core.test.mjs`: "a request with more than one Host header is refused, whatever the copies say" |
| `100 Continue` was sent before the Host check | section 6, "`Expect: 100-continue`" | `M69-boundary-core.test.mjs`: "100 Continue is not sent to a request the Host check refuses" |
| An `api.token` with group or other bits crashed the engine and left a lock behind | section 1 (status 5), section 3, section 6 | `M69-boundary-core.test.mjs`: "a token file open to group or others refuses the start and is left as it was"; `M06-engine-lock.test.mjs`: "a start refused for its token file takes no lock and does not block the next start" |
| `"decision_targets": {}` was reported with source `"file"` | section 2, "Inspection" | `M07-closed-configuration.test.mjs`: "an empty decision-target map is valid and is reported as the default" |

The harness gained one capability for these: `rawRequest` in `engine.mjs` now reports interim (1xx) responses and can hold a body back until `100 Continue` arrives. `selfcheck/run.mjs` checks it against a byte-level server.

The owner's decisions on the review's other findings (E23) changed this file as follows:

| Decision | Now stated in | Test |
|---|---|---|
| No refusal issued in restricted mode needs an `api.act` event | section 6, "Audit" (was: only `503 engine_starting`) | none needed; no test asserted the narrower rule |
| Test-mode code is confined to the seam module and folder | section 7, "Confinement"; section 10 | `M74-seam-confinement.test.mjs`, three cases |
| The migration runner is the one named exception to the store-write rule | section 5 | none yet (recorded for a later lint) |

The obligations the same decisions defer to later slices are in `../COVERAGE.md`, "Obligations recorded after the slice-1 review".

---

# Slice 2: work, runs and interruption

Sections 12 to 20 were written with the slice-2 acceptance tests (rows M09 to M18 and the cases of M02, M05, M06, M07 and M08 deferred to this slice). They follow D1 §§2.5–2.7, 3.2, 4, 8, 13.1, 15 and 16 with build spec §6 corrections 1, 2, 10, 11, 12, 13 and 16. Where those sources left something open, the choice is listed in section 20.

The expected transition tables are `../contract/work-items.json` and `../contract/run-lifecycle.json`. The tests generate their cases from those files and never ask the engine what is legal.

## 12. What the slice-2 tests assume throughout

- **Ticks happen when asked.** The tests set `tick_interval` to its maximum and request each tick with `POST /v1/projects/:p/tick` (section 15). They do not depend on whether a tick runs at scheduler start.
- **The scripted backend is the only backend.** In harness mode with `--harness-scripted`, every run is dispatched to backend `scripted` and `GET /v1/engine` reports `backends: ["scripted"]`. In every other start `backends` is `[]` and a dispatch is refused before launch (section 16, "Preflight refusal").
- **No dispatch in slice 2 is a chained dispatch.** `max_chained_roles` (D1 §8.1 step 8, D1-34) limits how many roles run one after another without a human step. In slice 2 nothing a run produces creates further work, so no chain exists: work created by a fixture, the re-dispatch of the same work item after a failed run, and a Resume are not chained, and the default limit of 1 never stops them. The chaining boundary itself is pinned with row M12's chaining case in slice 3.
- **Integration is not built.** For the kinds whose path integrates (`stage_build`, `fix`, `replan`, `assessment`), what follows a run that returns a valid result is not pinned until slice 3; slice-2 tests never let such a run complete normally. `verification` and `review` complete in slice 2. `check_correction` is not dispatched until slice 5.
- **The tests clean up after themselves.** A scripted child that outlives its engine is killed by the test that launched it.

## 13. The scripted backend

Build spec §8: "Deterministic role output: files written in the workspace, the structured result, usage observations, delays, exit, callbacks arriving late." The role's behavior is the Verifier's: the engine launches a program the test supplies, so what the "agent" did and how many times it was launched are recorded by the test side, not by the engine under test. The engine side of the backend is the launch, the protocol below, and the boundary of section 14.

**The scripted directory.** `--harness-scripted <dir>` names a directory the test owns, outside the engine home. The engine uses two things in it and nothing else:

| Path | Used by the engine |
|---|---|
| `<dir>/child.mjs` | The program launched for every invocation. |
| `<dir>/boundary.json` | The scripted execution boundary's instructions (section 14). Read, never written. |

The rest of the directory (`scripts/`, `release/`, `launches.jsonl`) belongs to `child.mjs` and the tests; `../harness/scripted/child.mjs` documents it.

**Launch** (the choke point, D1 §15.1). For each invocation the engine spawns exactly one process:

- command `process.execPath` with the single argument `<dir>/child.mjs`: an argument array, never a shell string;
- working directory: the run's workspace (`workspaces.path`);
- a new process group whose leader is the child (its process group id equals its pid);
- a constructed environment (D1 §17(4)): it contains `SURETY_DOMAIN=<execution domain id>` and `SURETY_INVOCATION=<invocation receipt id>`; it does not contain `SURETY_HOME`, and no variable's value is the API token. Other variables (a `PATH`, say) are the engine's choice;
- standard input: one line, a JSON object, then end of input. It has at least `invocation`, `domain`, `run`, `project`, `work_item`, `work_kind`, `role` and `workspace` (the ids and the workspace path of this dispatch). More keys may be added by later slices;
- standard output: read by the engine as the protocol below. Standard error is the engine's to keep or drop.

Process ownership (D1 §3.2) is written with `pid` null before the spawn and completed after it with the child's `pid`, `pgid` and `pid_start_time` (field 22 of `/proc/<pid>/stat`, a decimal string, as in section 3).

**Protocol.** The child writes JSON objects, one per line:

| Line | The engine |
|---|---|
| `{"type": "heartbeat"}` | renews the run lease (D1 §8.3), unless the lease has expired (section 16, "The run lease"). |
| `{"type": "usage", "semantics": "cumulative" \| "delta", "raw": {...}}` | appends one `usage_observations` row with that `semantics` and `raw` (as JSON text equal to the object sent), `seq` counting from 1 per invocation. |
| `{"type": "result", "result": <value>}` | takes `<value>` as the role's structured result. A second `result` line for the same invocation changes nothing (D1 §4.3: duplicate terminal callbacks are idempotent on the invocation id). |

Every line is a callback on behalf of the run and is fenced (D1 §8.3): once the run's lease is `closing`, or has expired, a `result` line has no effect. What the engine does with a line that is not one of these is not pinned.

**When the role exits.** The run-end protocol begins when the process the engine launched exits. What that process wrote to its standard output before it exited is read and acted on first; the end of the stream is not waited for. A descendant of the role that inherited the stream can hold it open for as long as it lives, and a run must not sit in `validating` until its deadline for that. Such a descendant is a member of the domain like any other: it is terminated in step 2 of the run-end protocol (section 14), and the outcome is the one the role earned.

**The structured result in slice 2.** A result is valid when it is a JSON object whose `status` is the string `"completed"` and whose `summary` is a string. Later slices add fields (a checkpoint request, a nomination request, findings); the slice-2 tests send exactly those two. Anything else (not an object, `status` missing or not a string the schema knows) is `invalid_result`.

**How an invocation ends, and the run outcome it gives** (D1 §4.1). `runs.outcome` and `runs.reason_class`:

| What happened | `outcome` | `reason_class` |
|---|---|---|
| A valid result, exit status 0, and termination observed (section 14) | `completed` | `none` |
| A result that is not valid | `failed` | `invalid_result` |
| The child exits without having sent a result, with any status; or it cannot be spawned | `failed` | `infra_error` |
| The backend is not qualified (section 16, "Preflight refusal") | `refused` | `preflight_refused` |
| The run's deadline passes | `timed_out` | `deadline` |
| Stop | `stopped` | `human_stop` |
| Abandon | `abandoned` | `human_abandon` |
| Startup recovery ends a run that had no outcome yet | `recovered` | `recovered` |

The scripted backend proves the engine's reactions. It qualifies no real containment, runner or adapter (Plan §2).

## 14. The scripted execution boundary

Build spec §6 corrections 1 and 2: termination is established only by the execution boundary; process groups and environment markers are aids for finding and signalling processes; unknown means quarantine; a quarantine ends only on observed termination. In M1 the scripted boundary is that service. It answers one question, asked per execution domain: is this domain `running`, `terminated` or `unknown`?

**Instructions.** `<dir>/boundary.json`, written by the test (atomically, by rename) and read by the engine **each time it observes a domain**, never cached, including after a restart:

```json
{"default": "auto", "domains": {"dom_<ULID>": "unknown"}}
```

A domain's instruction is its entry in `domains`, else `default`, else `auto` (also when the file is absent). The four instructions:

| Instruction | The boundary reports |
|---|---|
| `auto` | what is true of the scripted children: `running` while any live process has `SURETY_DOMAIN=<that domain id>` in its environment (as `/proc/<pid>/environ` shows it), `terminated` when none has, `unknown` if `/proc` cannot be listed. A single process whose environment cannot be read is not counted: see "What `auto` does not see", below. |
| `running` | `running`, whatever any process does. This is how a test scripts a failed cancellation or a parent that exited while a descendant lives on. |
| `terminated` | `terminated`. |
| `unknown` | `unknown`: membership cannot be read. |

**What the engine does with it.**

- Termination of a domain is established when, and only when, the boundary reports `terminated`. The exit of the child the engine spawned establishes nothing, on normal completion included (D1 §4.5 step 2). One case needs no observation: a domain the running engine knows it never spawned into, because the run was refused or ended before the spawn. Outside harness mode there is no boundary, and that is the only way a domain is terminated there. After a restart the engine does not know this of a domain whose ownership row has `pid` null: it asks the boundary.
- How the engine signals is its own (D1 §4.5 step 2: TERM, `terminate_grace`, KILL, `kill_grace`), with one rule the tests pin: it never signals a process whose pid equals a recorded `process_ownership.pid` but whose start time differs from the recorded `pid_start_time` (D1 §16.1). A child that was spawned but whose ownership row still has `pid` null (a crash between the two) is found by its marker and terminated like any other.
- While it is establishing termination the engine observes the boundary at least once a second, and goes on as soon as it reports `terminated`. If the boundary has not reported `terminated` when `terminate_grace` plus `kill_grace` have passed, the run is quarantined (D1 §4.5 step 3; section 16, "Quarantine"). If the boundary reports `unknown`, the run is quarantined then, at that report, without waiting for either grace period: the grace periods are time for signalled processes to exit, and no signal makes an unreadable boundary readable. A later report of `terminated` clears the quarantine like any other; it does not undo it.
- Every quarantined domain is observed again at startup recovery and at every tick. When the boundary then reports `terminated`, the quarantine is cleared (section 16, "Clearance"). Nothing else clears it: not a decision, not an answer, not a restart.

**What `auto` does not see.** `auto` finds a domain's processes by their marker, and it can read the marker only where it can read the environment. A process whose `/proc/<pid>/environ` the engine cannot read is not counted, as a member or as a reason for `unknown`. It cannot be otherwise without a rule this file does not have: every exiting process and every zombie is unreadable for a moment, the role itself included at each run end, and on an ordinary host some lasting processes of the engine's own user are unreadable too (a user's `systemd`, for one), so "unreadable means `unknown`" would make most observations `unknown`. The consequence is stated here so it is not mistaken for containment: a descendant that makes its own environment unreadable (a process that is not dumpable) is invisible to `auto`, and `auto` can report `terminated` while it lives. Membership that cannot be escaped is the execution boundary's to provide (build spec §6 correction 1) and D2's to qualify; M1 claims no isolation of a role from the engine (E25 item 2). A test that needs the engine's reaction to unreadable membership scripts it with the `unknown` instruction. `../COVERAGE.md` records why no test pins more.

## 15. Work items, triggers and the tick

**Fixtures.** Both install through the engine's ordinary transition functions and label what they create: every event they cause has `payload.test_fixture = true`.

| Route | Body | Result |
|---|---|---|
| `POST /v1/harness/fixtures/trigger` | `{"project", "kind", "trigger_source", "trigger_id", "trigger_generation", "subject"?, "depends_on"?}`. `subject` is an object with D1 A.3's work-item subject keys (default `{}`; the slice-2 tests do not send it); `depends_on` is an array of work item ids (default `[]`). | Observes the trigger (D1 §8.2). **201** `{"work_item": {"id": "wi_<ULID>"}, "created": true}` when this trigger identity had no work item: one is created, `eligible`, with that kind, subject and dependencies. **200** `{"work_item": {"id": <the existing one>}, "created": false}` when it has one, in any status, terminal included: nothing is created or changed and no error is raised. A `kind` that is a `WorkItemKind` but is not dispatchable in M1 (build spec §3) is refused **501** `unsupported` and creates nothing; a `kind` that is not a `WorkItemKind` is **400** `invalid_value`. |
| `POST /v1/harness/fixtures/plan` | `{"project", "stages": [{"number", "goal"}]}` | **201** `{"plan": {"id": "plan_<ULID>"}, "stages": [{"id": "stage_<ULID>", "number", "work_item": "wi_<ULID>"}]}`. Installs an approved baseline and a phase plan (whatever rows the engine's schema needs for them), the `stages` rows (`status` `planned`), and for each stage one `stage_build` work item, `eligible`, with `subject.stage` the stage and trigger `("plan", <stage id>, 1)`. `stages.work_item` is set. The stages' work items do not depend on one another. Later slices extend the body (requirements, modules, dependencies between stages, protected checks); they do not replace the route. |

**Work-item transitions.** The legal transitions are one table held as data (correction 11); the engine's single work-item transition function checks it. One harness route applies that function directly, so the tests can attempt an edge no public route can request:

| Route | Body | Result |
|---|---|---|
| `POST /v1/harness/work/:w/transition` | `{"to": <WorkItemStatus>}` | If the engine's table allows the item's kind to go from its current status to `to`: **200** `{"work_item": {"id", "status": <to>}}`, the status changes and one `work.*` event is written. Otherwise **409** `illegal_transition`, and nothing changes: no column of the row, no event. The route checks the table and the stored continuation only; it launches nothing, ends nothing and raises no decision. Entering `awaiting_decision` stores the status the item left as its continuation; leaving it for `executing`, `integrating` or `verifying` is legal only for the stored one. |

What the table must contain is `../contract/work-items.json`: each kind's path; the common templates, each limited to the statuses that kind can reach; Stop and Abandon from every status that owns a run, `integrated` and `awaiting_decision` included.

**Work events.** Every change of a work item's status writes exactly one `work.*` event (D1 §4.3) with `subject.work_item`, `subject.project`, and `payload.from` and `payload.to` (the statuses). `work.created` has `payload.to` only. Which of the `work.*` types carries a given change is D1 §4.3's; the tests rebuild each item's path from `from` and `to` and check every step against the contract table. One `work.*` event carries no change of status: the Resume of an item that is on dispatch hold (section 17) writes one `work.resumed` event whose `payload.from` and `payload.to` are both the status the item keeps. The tests do not count it as a step of the path.

**Claiming.** A dispatch creates the run and moves its work item `eligible → claimed` in one transaction; the item becomes `executing` when the run does.

**The tick.** `POST /v1/projects/:p/tick` answers **202** and sets the tick flag (D1 §1.5); scheduler logic never runs in the request. The tick is engine-wide: D1 §8.1 runs each step for every project, and the project in the route only has to exist. Each tick, when it ends, writes one `engine.tick` event, after everything else the tick wrote. A tick that starts after the request was answered sees everything committed before the request. One tick runs at a time. Within a tick, the rows of a dispatch that section 16 lists as written before the spawn are committed before the tick ends; the spawn itself is not waited for (D1 §8.1 step 9).

**Selection** (D1 §8.1 step 8). A work item is not dispatched while any of these holds: its project is paused; its project has a run that has not ended (one run per project, a quarantined run included); the engine already has `max_concurrent_runs` runs that have not ended; its status is not `eligible`; `dispatch_hold` is set; a work item in its `depends_on` is not `complete`. D1 §8.1 also skips an item that an open decision holds in `blocked_while_open`; slice 2 has no eligible item in that position, so that is not pinned here.

**Counters and parking** (D1 §4.3).

- A run that ends `failed` returns its work item to `eligible`. Each automatic re-dispatch after a failed run adds one to `repair_attempts`. When a run fails and `repair_attempts` already equals `repair_attempts_max`, the item is parked instead. So an item whose every run fails is launched `1 + repair_attempts_max` times and is then `parked` with `repair_attempts = repair_attempts_max`.
- A run that ends `refused` returns its work item to `eligible` and adds one to `preflight_refusals`; when that reaches `preflight_refusals_max` the item is parked instead.
- A run that ends `timed_out` parks its work item (F §5.8: an exhausted time budget produces a visible blocker; D1 §13.3 does the same for tokens).
- A parked item has `work_items.blocker` set to `{"reason", "raised_at", "decision"}` and an open `blocker` decision with `subject_type` `work_item`, `subject_id` the item, and the item in `blocked_while_open.work_items`. `reason` is `repair_attempts_max`, `preflight_refusals_max` or `deadline`.

## 16. Runs

**Role of a run.** `stage_build` and `fix`: `builder`. `verification`: `verifier`. `review`: `reviewer`. `replan`: `architect`. The role of an `assessment` run is not pinned.

**What a dispatch has written before the spawn.** A `runs` row (`kind` `one_shot`, `state` `claimed`, `backend` `scripted`, the role above, `base_revision` the commit the project's integration branch points at, `deadline_at` its creation time plus the role's deadline setting); its work item `claimed`; an unreleased `leases` row with `resource_kind` `run` and `resource_id` the run id, owned by the current incarnation, not `closing`; an unrevoked `capability_grants` row; one `invocation_receipts` row with no turn; an `execution_domains` row, `allocated`; a `process_ownership` row with `pid` null; the status observation `dispatch_started`; and a `workspaces` row (`disposition` `active`, `base_revision` and `current_base` the run's base) whose `path` is a directory under `$SURETY_HOME/workspaces/` that is a detached worktree of the project's repository at that base, created through the journal (a `git_worktree` operation with a `worktree_add` journal whose first event is `intended`). `runs.workspace` and `runs.grant` name them.

**The workspace path and symbolic links.** Git prints the worktrees of a repository with their symbolic links resolved. The engine must recognise the worktree it has just added however its home is reached: with `$SURETY_HOME` a symbolic link to the directory that holds its files, a dispatch still launches, the `worktree_add` operation is recorded `succeeded`, and no worktree stays registered in the repository that no `workspaces` row names. Whether `workspaces.path` holds the path as given or resolved is the engine's choice; where the home may be a link the tests compare resolved paths.

**Engine git** (D1 §7.1; E25 item 3). Engine git never runs code from the repository. A role runs as the engine's user and can write to the repository's hooks directory and configuration; whatever those ask git to execute would run in the engine's own process tree, outside every execution domain, with the engine's environment. So on every git command the engine spawns, hooks are disabled, wherever they are (the repository's hooks directory, or a directory its configuration names as `core.hooksPath`), and so is every other way the repository's configuration or content can name a program for git to run. Slice 2's only git effects are `git worktree add` and `git worktree remove`; the tests pin that the `post-checkout` and `reference-transaction` hooks do not run when the engine creates a workspace. Slice 3 extends the test to commits, ref updates and snapshots, and settles the other ways (filter drivers, `core.fsmonitor`, external diff and merge drivers, `core.sshCommand`, credential helpers, signing programs) with the commands that can reach them.

**The run lease** (D1 §8.1 step 1, §8.3; E25 item 1). Times are the engine's clock (section 18).

- *Renewal.* While the engine supervises a run's live process, from the launch until that process exits or the lease is `closing`, the engine renews the run lease by itself at least every `lease_ttl`/3, whether or not the role sends a heartbeat. A renewal sets `renewed_at` to the time it is made and `expires_at` no earlier than `lease_ttl` after it. A role that sends no heartbeat for longer than `lease_ttl` therefore keeps its lease, and its result is accepted.
- *Expiry is final.* A lease whose `expires_at` has passed is expired. It is not renewed, by a heartbeat or by the engine, and a callback that presents it is refused: a `result` has no effect. The store makes that check in the transaction, as it does for `closing`.
- *Reconciliation.* The tick's first step takes every unreleased `run` lease past its expiry through the run-end protocol, whether or not the engine that owns it is alive and whatever that engine is doing with the run: the run ends as "A run that has ended" describes, or is quarantined. An outcome already recorded is kept. A run that had none gets one of D1 §4.1's outcomes; which one is not pinned, except that it is `completed` only if a valid result was accepted while the lease was live. A launch that had not yet spawned finds its run ending or over when it comes back, and spawns nothing; the tick does not wait for it before it begins the run-end protocol.
- *The safety net.* This is what keeps one failed store transaction from holding a project until the next restart. If the transaction that enters `finalizing`, or the one that sets `ended`, fails once, the run still reaches `ended` within a bounded number of ticks, and the project's next item is dispatched. The engine may retry sooner; it may not wait for a restart.

**After the spawn.** One transaction completes the ownership row, appends the status observation `launched`, marks the domain `launched` and moves the run and its work item to `executing`. A test that sees the run `executing` sees all of it.

**Preflight refusal** (D1 §15.1, row M08). When the backend is not qualified, which in M1 is every start without `--harness --harness-scripted`, nothing is spawned. The run ends `refused` / `preflight_refused`; its receipt has the status observation `refused` and never `launched`; it has no ledger row. `GET /v1/projects/:p/runs/:r` reports `code: "backend_refused"`.

**A run that has ended** (D1 §4.5, §16.2). Whatever the outcome, by the transaction that sets `state` `ended`:

- `outcome` and `reason_class` are set and `finished_at` is set; `quarantined` is 0;
- every execution domain of the run is `terminated`, each with exactly one `domain.terminated` event, and its ownership row has `termination_confirmed_at`;
- no unreleased lease names the run (`resource_id` the run id, any kind);
- the run's grant has `revoked_at`;
- the workspace's `disposition` is `retained` for `completed`, `failed`, `timed_out`, `stopped` and `recovered`, and its directory is still there; for `abandoned` it is `discarded`, with `disposed_at` set, the directory gone and the worktree no longer registered in the project's repository. For `refused` it is not pinned;
- every receipt is in one of two forms (D1 §4.5 step 5). An invocation that was never launched has the observation `refused` once, no `launched`, no `ended` or `unknown`, and no ledger row. Every other receipt has exactly one terminal observation, its last (`ended`, or `unknown` when the end could not be established), no `refused`, and exactly one original ledger row (`corrects` null) naming the invocation and the run. A receipt with the observation `launched` is always of the second form, and so is one whose child was in fact spawned: recovery must not record "never launched" for a role that ran. Where the engine cannot tell whether the spawn happened (`dispatch_started` without `launched`, and no process found), `unknown` is the honest record. A ledger row for an invocation with no usage observation has null `billable_in`, `cached_in` and `out`, `usage_complete` 0 and `cost_status` `unknown`. Normalized amounts are slice 4's;
- there is exactly one `run.ended` event for the run. Finalizing again, by a repeated callback, a second command or recovery, adds no row and no event.

**What the work item becomes.**

| Run outcome | Work item |
|---|---|
| `completed`, kind `verification` or `review` | `complete` |
| `failed`, `refused`, `timed_out` | section 15, "Counters and parking" |
| `stopped` | `held`, once the run has ended |
| `abandoned` | its recorded prior status, which for a run dispatched from `eligible` is `eligible`, with `dispatch_hold` set, once the run has ended |
| `recovered` | `held` (E7 §3.9.4: the same end state as Stop) |

**Quarantine** (D1 §4.5 step 3; corrections 1 and 2). While termination is not established the run is `finalizing` with `quarantined` 1 and its `outcome` already recorded; at least one of its domains is `quarantined`; its workspace's `disposition` is `quarantined` and the directory is untouched; no unreleased `run` lease names the run and exactly one unreleased lease has `resource_kind` `quarantine` and `resource_id` the run id; an open `blocker` decision has `subject_type` `run` and `subject_id` the run id. Events: `run.quarantined`, `domain.quarantined`, `engine.quarantine`. The run is not ended, its work item is neither `complete` nor dispatched again, and nothing else of its project is dispatched. All of this is as true after a restart as before it, and after a restart the run's grant is revoked if it was not before (D1 §16.2: no grant is live after recovery). The same blocker is still the open one: the question is not asked a second time. The blocker offers the option `acknowledge`; answering it consumes the decision and changes nothing else.

**Clearance** (correction 13). When the boundary reports a quarantined domain `terminated` (section 14), the domain becomes `terminated` and, once all the run's domains are, the run ends as "A run that has ended" describes, with the outcome it already had. The quarantine reservation is released once. Nothing is written twice, however often the observation is repeated.

**Recovery at startup** (D1 §16.1, corrections 12 and 13), in the `recovery` step, before full mode. Every run that has not ended is brought to `ended` through the same run-end protocol, or left `finalizing` and quarantined if the boundary does not report its domains `terminated`. A run in `created` is ended from there. An `outcome` already recorded is kept; a run that had none gets `recovered`. That recovery ended the run is recorded apart from the outcome: its `run.ended` event has `payload.recovery = {"incarnation": <the recovering incarnation's id>}`, and a run that ended any other way has no `recovery` key (or a null one). No run is created until recovery is complete. A run that recovery has to leave quarantined does not keep the engine restricted: the step completes and the engine goes on to full mode.

**Events.** `run.*` events carry `subject.run`, `subject.project` and `subject.work_item`. `run.ended` has `payload.outcome`. `domain.*` events carry `subject.domain` and `subject.run`. `engine.quarantine` carries `subject.run`. The run's path is read from the event types as D1 §4.1 names them (`run.created`, `run.claimed`, `run.started`, `run.validating`, `run.proposal_captured`, `run.finalizing`, `run.ended`) and checked against `../contract/run-lifecycle.json`.

## 17. Commands and reads

| Route | Behavior |
|---|---|
| `POST /v1/projects/:p/tick` | **202**. Section 15. |
| `POST /v1/projects/:p/runs/:r/stop`, `/abandon` | D1 §10.1, §11.4: the route raises and consumes a `stop_confirm` / `abandon_confirm` decision; it cannot bypass the queue. With body `{}`: **409** `confirm_required`, `subject: {"decision": "dec_<ULID>", "preview_hash": <string>}`; the decision (`subject_type` `run`, `subject_id` the run) is `open`, and nothing else has happened. With body `{"preview_hash": <that value>}`: **200**; the decision is `consumed` and the run-end protocol has begun: when the response is sent the run's lease is `closing`, so no later callback of the role has effect (D1 §8.3). A `preview_hash` that is not the open decision's: **409** `decision_stale`, no effect. A run that has already ended: **409** `illegal_transition`. A run that is not of project `:p`, or does not exist: **404** `not_found`. |
| `POST /v1/projects/:p/work/:w/resume` | **200**. A `held` item becomes `eligible`; `dispatch_hold` is cleared. Either way the transaction that makes the change writes exactly one `work.resumed` event carrying the request id; for an `eligible` item on dispatch hold, whose status does not change, see section 15, "Work events". The next dispatch of the item is a new run whose `parent_run` is the run that was stopped, timed out or recovered (D1 §15.3). What Resume answers for an item that is neither `held` nor on dispatch hold is not pinned in slice 2. |
| `POST /v1/projects/:p/decisions/:d/answer` | Body `{"option": <key>, "preview_hash": <string>}`. **200**: the decision is `consumed` and its effect has been recorded. A `preview_hash` that differs from the decision's: **409** `decision_stale`. A decision that is not `open`: **409** `decision_consumed`. Slice-2 options: a parked item's `blocker` offers `retry` (the item returns to `eligible`, its `blocker` is cleared, and it is dispatched again like any eligible item) and `cancel` (the item becomes `cancelled`); a quarantine `blocker` offers `acknowledge` (section 16). The dependency manifests of these kinds are rows M45, M47 and M48, slice 5. |
| `GET /v1/projects/:p/runs/:r` | **200** `{"run": {"id", "state", "outcome", "reason_class", "code", ...}}`. `code` is D1 A.7's public code for the run's reason class (`backend_refused` for a refused backend), else null. **404** `not_found` if the run is not of project `:p`. |

The tests read `decisions.preview_hash` and `decisions.options` (a JSON array of objects with `key`) from the store. D1 §11.4 also has `POST /v1/projects/:p/work/:w/cancel`; no slice-2 test uses it, so nothing about it is pinned here. A parked item is cancelled through its blocker.

## 18. Barriers, the clock, faults and allocation

**Barriers.** Armed at startup with `--harness-barrier`, as in section 7; each fires once, the first time its point is reached. `pause` waits there until released while the API keeps answering; `kill` makes the engine send itself SIGKILL there. A barrier is defined by what is durable when it fires, not by how the engine groups its transactions: where the engine commits two of these facts together, the two barriers fire one after the other with the same store.

| Name | Fires |
|---|---|
| `dispatch.run_created` | In a tick's dispatch, after the transaction that creates the run (and claims its work item) has committed. |
| `dispatch.domain_allocated` | After the run's execution domain (`allocated`) and its pid-null ownership row are durable. |
| `dispatch.receipt_committed` | After the run's invocation receipt is durable. |
| `launch.before_spawn` | Immediately before the child is spawned: everything section 16 lists as written before the spawn is durable. |
| `launch.before_ownership` | After the child has been spawned and its request written to its standard input, and before the transaction that completes its ownership row and appends `launched`. |
| `run.result_received` | When a valid result has arrived from the child and before the engine has acted on it in any way. |
| `run_end.before_ended` | In the run-end protocol, when the run is durably `finalizing` with its outcome and its domains are `terminated`, before the transaction that sets `ended`. |

The engine checks the run's lease again after `launch.before_spawn`: a run stopped or abandoned while it waited there is not left with a live child.

**Controlled clock.** `POST /v1/harness/clock/advance` with `{"seconds": <positive integer>}` → **200** `{"now": <timestamp>}`. The engine's clock, from which it takes every timestamp, deadline and expiry, jumps forward by that much and stays ahead. Whatever became due is acted on within two seconds of real time, without waiting for a tick request. The advance does not survive a restart; the tests never restart an engine whose clock they moved. To move the clock past a run deadline the tests advance in steps shorter than the configured `lease_ttl` and leave real time for a heartbeat between steps, so no lease expires merely because the clock moved. A renewal by the engine that has become due (section 16, "The run lease") is among the things acted on within two seconds. A single jump of more than `lease_ttl` leaves every run lease expired, since nothing can renew a lease between its last renewal and the jump; the tests use such a jump to make a lease expire, and section 16 says what follows. `terminate_grace` and `kill_grace` are waited in real time; the tests set them small.

**Faults.** The `before_event` fault of section 7 is armed in slice 2 on `run.finalizing`, `run.ended` and `work.resumed`. `POST /v1/harness/faults` also accepts `{"point": "tick_step", "step": "recover" | "journal", "project": "proj_<ULID>", "delay_ms": <n>}`: one-shot; the next time a tick runs that prerequisite step (D1 §8.1 steps 1 and 2) for that project, the step takes `delay_ms` of real time longer. D1 §8.1: a prerequisite step that overruns `tick_step_budget` makes that project's dispatch ineligible for that tick, also when the step completes later; other projects and the API go on. A tick whose steps have used up `tick_budget` dispatches nothing further.

**Allocation.** `POST /v1/harness/allocate` with `{"run": "run_<ULID>"}` → **200** `{"invocation": "inv_<ULID>"}`. It calls the engine's own receipt allocation for that run (D1 §2.6, correction 10): create or read in one transaction. Called again, concurrently, after the run has ended, or after a restart, it returns the same id; one receipt row exists and nothing is launched by it.

## 19. Store rows the slice-2 tests read

Names are D1 A.3's (section 8 applies). The tests read, and so the schema must have, with their A.3 columns: `leases`, `workspaces`, `process_ownership`, `decisions`, `stages`, and the `workspace` column of `runs`. `workspaces`, `process_ownership`, `decisions` and `stages` carry `project`. A table or column the engine adds beyond A.3 (where it stores an item's continuation, for one) is its own; the tests do not read it.

`leases.resource_id` is the run id for the kinds `run` and `quarantine`. The tests read `leases.renewed_at` and `leases.expires_at` as timestamps of the engine's clock, and `operations.status` of a `git_worktree` operation, which is `succeeded` once its worktree is in place.

The tests write to the store directly in two places, both while the engine is stopped: row M08 inserts a work item of an excluded kind (`../harness/seed.mjs`), and row M18 changes `process_ownership.pid` to model a reused pid.

## 20. Names the Verifier fixed in slice 2

Each of these was open in the sources. The Builder may object. The first five carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| What a chain of roles is | Section 12: nothing in slice 2 is chained; the boundary is pinned in slice 3. | D1 §8.1 and D1-34 use `max_chained_roles` without defining a chain. With the default of 1, any wider reading would stop every second run of a project. |
| Launches before a repair park | `1 + repair_attempts_max` | D1 §4.3 counts re-dispatches, and the range starts at 0, which must mean "no repair", not "no launch". |
| What a timed-out run does to its work | `parked` with a `blocker`, reason `deadline` | F §5.8 (exhausted budgets produce a visible blocker), D1 §13.3. D1 §8.5 says only that the run is cancelled. |
| What a recovered run does to its work | `held` | E7 §3.9.4: "the same end state as Stop". |
| How recovery is recorded apart from the outcome | `run.ended` `payload.recovery.incarnation` | Correction 12 requires a separate record and names none. |
| Scripted backend: directory flag, launch, protocol, result schema | Sections 1 and 13 | Build spec §8 leaves the mechanism to the Verifier. The role program is the Verifier's so that launch counts and role behavior are not the engine's own account of itself. |
| Scripted boundary: instruction file, `auto`, observation cadence | Section 14 | Correction 1. A file is readable in restricted mode and after a restart, which a route is not. |
| Fixture routes for a trigger and a plan; the work-item transition route | Section 15 | Build spec §8; Plan M09 ("inject each illegal edge"). |
| `work.*` payload `from` / `to`; event subjects | Sections 15 and 16 | D1 names the events and not their payloads; the tests need each item's path. |
| Blocker reasons and option keys | `repair_attempts_max`, `preflight_refusals_max`, `deadline`; `retry`, `cancel`, `acknowledge` | The reason names the limit that was reached. |
| Stop and Abandon as two requests | `confirm_required` with the decision and its `preview_hash`, then the same route with the hash | D1 §10.1 and §11.4 ("raise and consume ... with the preview hash"); A.7 has `confirm_required`. |
| HTTP statuses | 202 for a tick; 409 for `illegal_transition`, `confirm_required`, `decision_stale`, `decision_consumed` | D1 fixes none. |
| Run representation `code` | Section 17 | D1 A.7: the public code is reported "on the run's API representation". |
| `leases.resource_id` | the run id for `run` and `quarantine` | D1 §3.2 names the column and not its content. |
| Barrier names; clock, tick-step fault and allocation routes | Section 18 | Build spec §8; Plan M18's six boundaries; Review B11 ("attempt duplicate allocation"). |
| Exit status 6, `home_unusable`, `listen_failed` | Section 1 | E23 item 11 requires a defined status and names none. Status 1 is what Node uses for an uncaught error, so it cannot be the defined one. |
| A well-formed token | at least 32 visible ASCII characters after trailing whitespace is removed | E23 item 8; D1 §11.1 sends the token in a header. |
| `Expect` other than `100-continue` | 417 `expect_refused`, after the Host and token checks, audited | E23 item 12. 417 is HTTP's status for it; the code follows `host_refused`. |
| Role of each work kind | Section 16 | F §4.1. `assessment` is left open. |

## 21. What stands behind these tests before the engine exists

Build spec §8 warns that a test written before its engine cannot be shown right by running it. For slice 2 the harness self-check (`selfcheck/run.mjs`) does what can be done without the engine:

- every helper with logic is run against something real: the case generators against mutants of the contract table, each store assertion against a witness store and one mutant per defect, the role program launched as a process, the HTTP helpers against a stand-in;
- every slice-2 test file is run against a **witness engine** (`selfcheck/witness-engine.mjs`), a single-file stand-in that does what sections 12 to 18 ask. Every test passes against it, so the tests and this file do not contradict each other;
- the witness has defects that can be switched on one at a time (`selfcheck/witness.mjs` lists them). With each one on, the test meant to catch it fails.

The witness engine is not the engine, not a design for it and not a contract. It keeps no transaction discipline, journals nothing it could recover, runs its store on the main thread, and takes its legal transitions from the Verifier's own table. The Builder builds from the sources and from this file. A run against the witness can never count as an acceptance run: when the harness is pointed at it, every test file gains one test that fails (`engine.mjs`).

The four carried-over cases of sections 1 and 6 were also run against the slice-1 engine on `main`, where each fails for the reason this file gives.

## 22. Amendments after the slice-2 review

A Reviewer probed the slice-2 engine (`build/slice-2`, 642320f), on which every slice-2 test passed, and confirmed defects the tests did not catch. The owner's decisions on that review are E25. Each defect and each decision that needed a test became one (2026-10-01); each of those tests was run against that engine and fails there for the reason given, and the tests that passed before still pass.

| Finding or decision | Now stated in | Test |
|---|---|---|
| A completed run did not end while a descendant of the role held the role's stdout open; it timed out and parked the work | section 13, "When the role exits" | `M16-quarantine.test.mjs`: "a role that completes and exits, leaving a descendant with its output open, ends completed once the descendant is terminated" |
| One failed store transaction in the run-end path stranded the run, and its project, until restart | section 16, "The run lease" (the safety net) | `M15-lease-supervision.test.mjs`: "the transaction that enters finalizing fails once …"; "the transaction that ends the run fails once …" |
| E25 item 1: the engine renews the lease itself; a lease nobody renews expires and the tick reconciles it; an expired lease admits no callback | section 16, "The run lease"; section 13 (protocol); section 18 (clock) | same file: "a role that sends no heartbeat for longer than lease_ttl keeps its lease …"; "a lease nobody renews expires, and the next tick puts its run through the run-end protocol …"; "a lease past its expiry is not renewed, the result presented on it is refused …" |
| With the engine home behind a symbolic link, an added worktree was recorded as absent and leaked | section 16, "The workspace path and symbolic links" | `M31-worktree-add-symlinked-home.test.mjs` (row M31, one case moved forward from slice 3) |
| Resume of an item on dispatch hold wrote no event | section 15, "Work events"; section 17 | `M14-abandon.test.mjs`: "Resume of an eligible item on dispatch hold writes exactly one work.resumed event, in the transaction that clears the hold" |
| An `unknown` report was acted on only after both grace periods, and a flip to `terminated` in that window skipped the quarantine | section 14, third rule | `M16-quarantine.test.mjs`: "with the boundary reporting unknown, a stopped run is quarantined at once, not after the grace periods" |
| E25 item 3: engine git never runs code from the repository | section 16, "Engine git" | `M23-engine-git-runs-no-repository-code.test.mjs`, two cases (row M23, moved forward from slice 3) |
| `auto` takes a process whose environment it cannot read for one that is not a member, where this file said "`unknown` if that cannot be read" | section 14, the `auto` row and "What `auto` does not see": the sentence is narrowed to what `auto` can do, and the limit is stated | none; `../COVERAGE.md`, "Obligations recorded after the slice-2 review", says why |

**On the `unknown` finding.** Section 14 already said that an `unknown` report means quarantine. The sentence named two conditions, the grace periods passing and an `unknown` report; if the second had to wait for the first it would add nothing to it. The slice-2 engine's reading (keep signalling, quarantine only if the last report is not `terminated`) is safe in one sense, since nothing is released before a `terminated` report either way. It is still not what the sentence said, and it loses the record that the boundary could not be read. The sentence is now two sentences.

**What the harness gained.** The role program (`scripted/child.mjs`) has one new script step, `{"descendant": {"holds_stdout": <bool, default true>, "on_term": "exit" | "ignore"}}`; the head of that file documents it. It starts the program again in descendant mode: a process of the role's process group that carries the role's domain marker, outlives the role and, unless told otherwise, keeps the role's stdout open. The role logs a `descendant` entry for it; `Scripted.descendants()` reads the entries and `killStrays()` kills what is left. `runs.mjs` gained `scriptedEngine(t, {homeSymlink: true})`, `unownedWorktrees`, `worktreeOperations` and `resolvedPath`; `git.mjs` gained `plantHook`. `invariants.mjs` no longer counts the `work.resumed` of a lifted dispatch hold as a step of an item's path. The self-check exercises each, and the witness engine has one defect for each new case.

**Names and rules the Verifier fixed in this pass.** The Builder may object; the first three carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| What expiry means | Final: an expired lease is never renewed, by a heartbeat or by the engine, and the tick ends its run | D1 §8.3 accepts a transition for a run only on an unexpired lease, and names renewal in the same paragraph; E25 item 1 sends an expired lease to the run-end protocol. A lease that a late renewal could bring back would not bound anything. |
| The outcome of a run ended because its lease expired | Not pinned, except that it is `completed` only if a valid result was accepted on a live lease | D1 §4.1 names no outcome for it. `failed`/`infra_error` is the plainest reading; the owner may want to name one. |
| What `auto` reports for a process it cannot read | Not counted; the limit is stated in section 14 | Any rule that counts it must tell a process that hides from one that is exiting, through details of `/proc` that a stand-in should not depend on, and would still miss a process that leaves the role's process group. The scripted boundary qualifies no containment. |
| The event of a Resume that only lifts a hold | `work.resumed`, `payload.from` = `payload.to` = the status kept | D1 §4.3 and §15.3 name `work.resumed`; section 15 gives every `work.*` event `from` and `to`. |
| When the run-end protocol begins for a role that has exited | At the exit of the launched process, after what it had already written is read | D1 §4.5 step 2 treats descendants as members to terminate, not as part of the role's output. |
| A renewal's effect | `renewed_at` = the time of renewal, `expires_at` ≥ that time + `lease_ttl` | D1 §8.3; the plainest reading of a time to live. |
| The engine-git rule's first pinned form | Hooks disabled on every engine git call, by hooks directory and by `core.hooksPath` | E25 item 3. The other repository-configured programs wait for the commands that reach them (slice 3). |
| Rows for the two git cases | M31 and M23, each with one file listed under slice 2 | They are the Plan rows that own the worktree-add probe and the confinement of engine git; slice 2 already makes the call they pin. |

