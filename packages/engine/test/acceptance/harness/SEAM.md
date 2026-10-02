# The test seam

**Owner:** the Verifier (build spec §4). **Written:** slice 1, 2026-10-01. **Amended:** 2026-10-01, after the slice-1 review (section 11). The owner's decisions on that review are cited below as E23, the erratum that records them. **Extended:** slice 2, 2026-10-01 (sections 12 to 20, and the amendments to sections 1, 6 and 7 that section 20 lists). **Amended:** 2026-10-01, after the slice-2 review (section 22 lists every change; the owner's decisions on that review are E25), and 2026-10-02, after the second (section 23; E27). **Extended:** slice 3, 2026-10-02, by the first of its two Verifier sessions (section 24: what the final slice-2 review carried forward, E28 and E29). Later slices extend it; a change to anything below is made by a Verifier session, normally in answer to an objection.

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
- **It is malformed.** The token is the file's content with trailing whitespace removed. It is well formed when it has at least 32 characters and every one of them is a visible ASCII character (0x21 to 0x7E). So an empty file, a file of whitespace only, a shorter token, leading whitespace, a line break or control character inside the token, and any non-ASCII character are all refused. A space or a tab inside the token is refused like any other character that is not visible ASCII (E24 item 8; pinned in slice 3, section 24). A token the engine creates itself is well formed by this rule.

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
| `{"type": "heartbeat"}` | renews the run lease (D1 §8.3), unless the lease has expired or the engine has decided to end the run (section 16, "The run lease"). |
| `{"type": "usage", "semantics": "cumulative" \| "delta", "raw": {...}}` | appends one `usage_observations` row with that `semantics` and `raw` (as JSON text equal to the object sent), `seq` counting from 1 per invocation. |
| `{"type": "result", "result": <value>}` | takes `<value>` as the role's structured result. A second `result` line for the same invocation changes nothing (D1 §4.3: duplicate terminal callbacks are idempotent on the invocation id). |

Every line is a callback on behalf of the run and is fenced (D1 §8.3): once the run's lease is `closing`, or has expired, a `result` line has no effect. What the engine does with a line that is not one of these is not pinned.

**A last line without a line ending is a line** (E27 item 1). When the engine stops reading the role's output, whatever it has read after the last line ending is processed like any other line. That holds whether it stopped at the end of the stream or, after the role's exit, while another process still held the stream open: a valid `result` written as the role's last, unterminated line is the role's result in both cases.

**When the role exits.** The run-end protocol begins when the process the engine launched exits. What that process wrote to its standard output before it exited is read and acted on first; the end of the stream is not waited for. A descendant of the role that inherited the stream can hold it open for as long as it lives, and a run must not sit in `validating` until its deadline for that. Such a descendant is a member of the domain like any other: it is terminated in step 2 of the run-end protocol (section 14), and the outcome is the one the role earned.

The end of the stream is not the exit either. A role may close its standard output and go on working; nothing begins then. The engine does not signal a role because its output has ended, and it decides nothing until the process exits: a role that sent a valid result, closed its output and exits 0 some seconds later ends `completed`, and was never signalled.

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
| The run's lease expires before anything has decided its outcome (section 16, "The run lease") | `recovered` | `recovered` |

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
- While it is establishing termination the engine observes the boundary at least once a second, and goes on as soon as it reports `terminated`. If the boundary has not reported `terminated` when `terminate_grace` plus `kill_grace` have passed, the run is quarantined (D1 §4.5 step 3; section 16, "Quarantine"). If the boundary reports `unknown`, the run is quarantined then, at that report, without waiting for either grace period: the grace periods are time for signalled processes to exit, and no signal makes an unreadable boundary readable. A later report of `terminated` clears the quarantine like any other; it does not undo it. The report ends the wait for a report. It does not end the signalling: the processes the engine found and sent SIGTERM are still sent SIGKILL once `terminate_grace` has passed (D1 §4.5 step 2), not earlier, and without a tick having to run. A role that ignores SIGTERM is therefore gone by the time the boundary can be read again, and the next observation clears the quarantine.
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

**Engine git** (D1 §7.1; E25 item 3). Engine git never runs code from the repository. A role runs as the engine's user and can write to the repository's hooks directory and configuration; whatever those ask git to execute would run in the engine's own process tree, outside every execution domain, with the engine's environment. So on every git command the engine spawns, hooks are disabled, wherever they are (the repository's hooks directory, or a directory its configuration names as `core.hooksPath`), and so is every other way the repository's configuration or content can name a program for git to run. Slice 2's only git effects are `git worktree add` and `git worktree remove`; the tests pin two things about the first. The `post-checkout` and `reference-transaction` hooks do not run when the engine creates a workspace. Neither does the program the repository's configuration names as its file-system monitor, `core.fsmonitor` (E27 item 4): git runs that program whenever it refreshes an index of the repository, a checkout into a new worktree included, and `core.hooksPath` does not govern it, so switching hooks off leaves it on. A role can set it through its linked worktree, which shares the repository's configuration. Slice 3 extends the tests to commits, ref updates and snapshots, and settles the remaining ways (filter drivers, external diff and merge drivers, `core.sshCommand`, credential helpers, signing programs) with the commands that can reach them.

**The run lease** (D1 §8.1 step 1, §8.3; E25 item 1; E27 items 2, 3 and 5). Times are the engine's clock (section 18).

- *Renewal.* While the engine holds a run and has not decided to end it, it renews the run lease by itself at least every `lease_ttl`/3, whether or not the role sends a heartbeat. That is while it prepares the run, from the claim until the role is spawned (E27 item 2), and while it supervises the run's live process, from the launch until that process exits. A renewal sets `renewed_at` to the time it is made and `expires_at` no earlier than `lease_ttl` after it. A role that sends no heartbeat for longer than `lease_ttl` therefore keeps its lease, and its result is accepted. So does a run whose preparation (its workspace, above all) takes longer than `lease_ttl`: its role is then spawned on the lease that was kept.
- *Once the end is decided, nothing renews* (E27 item 5). From the moment the engine has decided to end a run (it found the run's deadline passed, a Stop or Abandon was confirmed, the role exited, the lease was found expired), nothing renews that run's lease: not the engine, and not a heartbeat of the role, however long the role goes on sending them. `renewed_at` and `expires_at` no longer move. It is the decision that counts, not its record: this holds also when the transaction that would have entered `finalizing` failed, and the run is still `executing` with no outcome. The engine retries the end itself; the expiry of the lease is the backstop, not the mechanism.
- *Expiry is final.* A lease whose `expires_at` has passed is expired. It is not renewed, by a heartbeat or by the engine, and a callback that presents it is refused: a `result` has no effect. The store makes that check in the transaction, as it does for `closing`.
- *Reconciliation.* The tick's first step takes every unreleased `run` lease past its expiry through the run-end protocol, whether or not the engine that owns it is alive and whatever that engine is doing with the run: the run ends as "A run that has ended" describes, or is quarantined. A launch that had not yet spawned finds its run ending or over when it comes back, and spawns nothing; the tick does not wait for it before it begins the run-end protocol.
- *What a run whose lease expired ends as* (E27 item 3, which replaces E26 item 2). If an outcome was decided before the lease expired, it stands, with its own consequence for the work: an outcome already recorded; a deadline (`timed_out`); a Stop or an Abandon; a result the engine accepted while the lease was live. The tests pin the last of these for a role that had also exited 0 before the expiry (`completed`); what a run ends as when the role whose result was accepted is still running at the expiry is not pinned. If nothing had decided the run's outcome when its lease expired, the run is treated as recovered, like a run found after a crash (E7 §3.9.4): `outcome` `recovered`, `reason_class` `recovered`; its work item `held` until an explicit Resume; `repair_attempts` unchanged; no blocker. What the role does after the expiry decides nothing: a `result` presented on the expired lease is refused, and the role's exit afterwards does not make the run `failed`. No startup recovery ended such a run, so its `run.ended` event has no `recovery` key. The expected values are `lease_expiry` in `../contract/run-lifecycle.json`.
- *Renewal while preparing and reconciliation of a stalled launch do not conflict.* Renewal prevents an expiry; it never reverses one. While the clock moves in steps shorter than `lease_ttl`/3, a renewal falls due before the lease can expire, and the engine makes it: a launch held before its spawn keeps its lease. When the clock passes the lease's whole lifetime in one jump, the lease has expired before any renewal could be made; the renewal is then refused like any other, and the tick reconciles the run although its launch has not come back. Both are pinned.
- *The safety net.* This is what keeps one failed store transaction from holding a project until the next restart. If the transaction that enters `finalizing`, or the one that sets `ended`, fails once, the run still reaches `ended` within a bounded number of ticks, with the outcome that was decided, and the project's next item is dispatched. That holds whatever the run's role does meanwhile, because a role that is alive and sends heartbeats can no longer keep the lease from expiring (second bullet): the ticks may be ones between which the clock moves by less than `lease_ttl`. The engine may retry sooner; it may not wait for a restart.

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
| `recovered` | `held` (E7 §3.9.4: the same end state as Stop), after a startup recovery and after a lease expiry alike (E27 item 3). `repair_attempts` is not changed, and the item leaves `held` only by an explicit Resume. |

**Quarantine** (D1 §4.5 step 3; corrections 1 and 2). While termination is not established the run is `finalizing` with `quarantined` 1 and its `outcome` already recorded; at least one of its domains is `quarantined`; its workspace's `disposition` is `quarantined` and the directory is untouched; no unreleased `run` lease names the run and exactly one unreleased lease has `resource_kind` `quarantine` and `resource_id` the run id; an open `blocker` decision has `subject_type` `run` and `subject_id` the run id. Events: `run.quarantined`, `domain.quarantined`, `engine.quarantine`. The run is not ended, its work item is neither `complete` nor dispatched again, and nothing else of its project is dispatched. All of this is as true after a restart as before it, and after a restart the run's grant is revoked if it was not before (D1 §16.2: no grant is live after recovery). The same blocker is still the open one: the question is not asked a second time. The blocker offers the option `acknowledge`; answering it consumes the decision and changes nothing else.

**Clearance** (correction 13). When the boundary reports a quarantined domain `terminated` (section 14), the domain becomes `terminated` and, once all the run's domains are, the run ends as "A run that has ended" describes, with the outcome it already had. The quarantine reservation is released once. Nothing is written twice, however often the observation is repeated.

**Recovery at startup** (D1 §16.1, corrections 12 and 13), in the `recovery` step, before full mode. Every run that has not ended is brought to `ended` through the same run-end protocol, or left `finalizing` and quarantined if the boundary does not report its domains `terminated`. A run in `created` is ended from there. An `outcome` already recorded is kept; a run that had none gets `recovered`. That recovery ended the run is recorded apart from the outcome: its `run.ended` event has `payload.recovery = {"incarnation": <the recovering incarnation's id>}`, and a run that ended any other way has no `recovery` key (or a null one). No run is created until recovery is complete. A run that recovery has to leave quarantined does not keep the engine restricted: the step completes and the engine goes on to full mode.

**Events.** `run.*` events carry `subject.run`, `subject.project` and `subject.work_item`. `run.ended` has `payload.outcome`. `domain.*` events carry `subject.domain` and `subject.run`. `engine.quarantine` carries `subject.run`. The run's path is read from the event types as D1 §4.1 names them (`run.created`, `run.claimed`, `run.started`, `run.validating`, `run.proposal_captured`, `run.finalizing`, `run.ended`) and checked against `../contract/run-lifecycle.json`.

## 17. Commands and reads

| Route | Behavior |
|---|---|
| `POST /v1/projects/:p/tick` | **202**. Section 15. |
| `POST /v1/projects/:p/runs/:r/stop`, `/abandon` | D1 §10.1, §11.4: the route raises and consumes a `stop_confirm` / `abandon_confirm` decision; it cannot bypass the queue. With body `{}`: **409** `confirm_required`, `subject: {"decision": "dec_<ULID>", "preview_hash": <string>}`; the decision (`subject_type` `run`, `subject_id` the run) is `open`, and nothing else has happened. With body `{"preview_hash": <that value>}`: **200**; the decision is `consumed` and the run-end protocol has begun: when the response is sent the run's lease is `closing`, so no later callback of the role has effect (D1 §8.3). A `preview_hash` that is not the open decision's: **409** `decision_stale`, no effect. A run that has already ended, or whose end the engine has already decided for another cause (section 24): **409** `illegal_transition`. A run that is not of project `:p`, or does not exist: **404** `not_found`. |
| `POST /v1/projects/:p/work/:w/resume` | **200**. A `held` item becomes `eligible`; `dispatch_hold` is cleared. For an `eligible` item on dispatch hold, whose status does not change, the transaction that clears the hold writes exactly one `work.resumed` event, which carries the request id (section 15, "Work events"); if that event cannot be written the hold stays. The next dispatch of the item is a new run whose `parent_run` is the run that was stopped, timed out or recovered (D1 §15.3). What Resume answers for an item that is neither `held` nor on dispatch hold is not pinned in slice 2. |
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

**Controlled clock.** `POST /v1/harness/clock/advance` with `{"seconds": <positive integer>}` → **200** `{"now": <timestamp>}`. The engine's clock, from which it takes every timestamp, deadline and expiry, jumps forward by that much and stays ahead. Whatever became due is acted on within two seconds of real time, without waiting for a tick request. The advance does not survive a restart; the tests never restart an engine whose clock they moved. To move the clock past a run deadline the tests advance in steps shorter than the configured `lease_ttl` and leave real time for a heartbeat between steps, so no lease expires merely because the clock moved. A renewal by the engine that has become due (section 16, "The run lease") is among the things acted on within two seconds, for a run being prepared as for a role being supervised; so is the decision to end a run whose deadline has passed. A single jump of more than `lease_ttl` leaves every run lease expired, since nothing can renew a lease between its last renewal and the jump; the tests use such a jump to make a lease expire, and section 16 says what follows. `terminate_grace` and `kill_grace` are waited in real time; the tests set them small. The controlled clock is the host's wall clock plus the offset the tests give it, and a host's wall clock can step back (section 23, "The host's clock"): where a test asks whether the engine did something after a clock advance, it allows the engine's timestamp to be up to two seconds earlier than the `now` of that advance.

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
| The outcome of a run ended because its lease expired | Not pinned, except that it is `completed` only if a valid result was accepted on a live lease. **Superseded:** the owner named one (E27 item 3); section 23. | D1 §4.1 names no outcome for it. `failed`/`infra_error` is the plainest reading; the owner may want to name one. |
| What `auto` reports for a process it cannot read | Not counted; the limit is stated in section 14 | Any rule that counts it must tell a process that hides from one that is exiting, through details of `/proc` that a stand-in should not depend on, and would still miss a process that leaves the role's process group. The scripted boundary qualifies no containment. |
| The event of a Resume that only lifts a hold | `work.resumed`, `payload.from` = `payload.to` = the status kept | D1 §4.3 and §15.3 name `work.resumed`; section 15 gives every `work.*` event `from` and `to`. |
| When the run-end protocol begins for a role that has exited | At the exit of the launched process, after what it had already written is read | D1 §4.5 step 2 treats descendants as members to terminate, not as part of the role's output. |
| A renewal's effect | `renewed_at` = the time of renewal, `expires_at` ≥ that time + `lease_ttl` | D1 §8.3; the plainest reading of a time to live. |
| The engine-git rule's first pinned form | Hooks disabled on every engine git call, by hooks directory and by `core.hooksPath` | E25 item 3. The other repository-configured programs wait for the commands that reach them (slice 3). `core.fsmonitor` does not wait: `git worktree add` reaches it (E27 item 4; section 23). |
| Rows for the two git cases | M31 and M23, each with one file listed under slice 2 | They are the Plan rows that own the worktree-add probe and the confinement of engine git; slice 2 already makes the call they pin. |

## 23. Amendments after the second slice-2 review

A second Reviewer probed the slice-2 engine after its first fix round (`build/slice-2`, 906c563), on which all 183 slice-2 tests passed, and confirmed four more defects by running it. The owner's decisions on that review are E27. Each defect and each decision that needed a test became one (2026-10-02). Each new or changed test was run against that engine. Nine fail there, each for the reason given in its row; three pass there, as they should: the two marked "guard", and the case changed only for the host's clock (below). Of the 183 tests that passed before, 181 still pass; the other two are the lease-expiry cases that E27 item 3 changed, counted among the nine.

| Finding or decision | Now stated in | Test |
|---|---|---|
| A run whose end the engine had decided, and whose `run.finalizing` transaction failed once, was never ended while its role lived and sent heartbeats: each heartbeat renewed the lease, so it never expired and no tick reconciled it. E27 item 5: once the engine has decided to end a run, nothing renews that run's lease | section 16, "The run lease" (second bullet; the safety net); section 13 (the heartbeat line) | `M15-lease-supervision.test.mjs`: "after the engine has decided to end a run, a heartbeat of its role does not move the lease"; "a run past its deadline whose entry into finalizing fails once still ends timed_out, although its role keeps sending heartbeats and never exits by itself" |
| Engine git ran the program the repository names as `core.fsmonitor`, although hooks were switched off (E27 item 4) | section 16, "Engine git" | `M23-engine-git-runs-no-repository-code.test.mjs`: "a program the repository's configuration names as core.fsmonitor is not run when the engine creates a workspace" |
| An `unknown` report stopped the signalling after SIGTERM and before SIGKILL, so a role that ignored SIGTERM lived on and its quarantine could not clear before a restart (a regression from the first fix round) | section 14, third rule | `M16-quarantine.test.mjs`: "with the boundary reporting unknown, a stopped role that ignores SIGTERM is still sent SIGKILL after terminate_grace, and the quarantine clears once the boundary reads again". The case of section 22 ("… quarantined at once …") stays: both must hold |
| A role that sent a valid result, closed its stdout and exited 0 three seconds later was recorded `failed` / `infra_error`, and was terminated before it exited: the engine took the end of the stream for the end of the role | section 13, "When the role exits" (second paragraph) | same file: "a role that sends a valid result, closes its stdout and exits 0 later is not signalled before it exits, and ends completed" |
| E27 item 1: a final line without a line ending is still a line. An unterminated `result` was accepted when nothing else held the stream and lost when a descendant did | section 13, "A last line without a line ending is a line" | same file: "a valid result with no line ending, from a role that exits 0 and leaves a descendant holding its stdout, ends completed"; and, as a guard, "a valid result with no line ending, from a role that exits 0, ends completed" |
| E27 item 2: the engine renews a run's lease while it is preparing that run | section 16, "The run lease" (renewal; why it does not conflict with the reconciliation of a stalled launch) | `M15-lease-supervision.test.mjs`: "the engine renews the lease of a run it is preparing: a launch held before the spawn for longer than lease_ttl keeps its lease, and the role is spawned and completes" |
| E27 item 3, replacing E26 item 2: a run ended because its lease expired, with no outcome decided before, is treated as recovered; its work is held until an explicit Resume; no repair attempt is charged. An outcome decided before the expiry stands | section 16, "The run lease" (what a run whose lease expired ends as) and "What the work item becomes"; section 13 (outcome table); `../contract/run-lifecycle.json`, `lease_expiry` | same file, two cases changed: "a lease nobody renews expires, and the next tick puts its run through the run-end protocol …" and "a lease past its expiry is not renewed, the result presented on it is refused …" now require `recovered` / `recovered`, the work `held`, `repair_attempts` 0 and no blocker; the second also requires that the held work is not dispatched again by itself and that a Resume gives it a new run linked to the first. One case tightened as a guard: "the transaction that enters finalizing fails once …" now requires `completed`, the outcome decided before the expiry |

**What changed for a case that passed before.** Two cases that the slice-2 engine passed now fail on it, both because of E27 item 3: the two lease-expiry cases named in the last row. That engine ends such a run `failed` / `infra_error`, returns the work to `eligible` and charges a repair attempt. Neither case, as written before, expected the expired run's own work to be retried automatically (they asserted only that the project's *next* item is dispatched), and that assertion is still right when the first item is `held`: a held item is not eligible, so selection passes over it. No other existing case expects a run to end by lease expiry.

**What an ended-by-expiry run records, and what it does not.** `outcome` and `reason_class` are `recovered`. The `recovery` key of `run.ended` stays what section 16 says it is: the mark of a *startup* recovery, naming the recovering incarnation. A run that a live engine's tick ended because its lease expired has no such key. The owner may prefer one record for both; see the Verifier's report.

**What the harness gained.** The role program (`scripted/child.mjs`) has one new step, `{"close_stdout": true}`, which closes the role's stdout for good while the role goes on, and `{"stdout": <text>}` is now documented as writing its text with no line ending added. `scripted.mjs` gained `step.stdout`, `step.closeStdout`, `RESULT_LINE` and `script.completeUnterminated`. `git.mjs` gained `plantFsmonitor`. `../contract/run-lifecycle.json` gained `lease_expiry`. The self-check exercises each, and the witness engine has one defect for each new or changed case.

**The host's clock.** The engine's clock is the host's wall clock plus the offset of section 18. On the host these tests were written on (WSL2), the wall clock steps back by about three quarters of a second roughly every half minute, when the guest's time is synchronised (measured: 0.74 to 0.78 s, 31.5 s apart, against the monotonic clock). A timestamp the engine takes just after answering a clock advance can then be earlier than the `now` of that answer. One case written after the first review compared the two exactly ("a role that sends no heartbeat for longer than lease_ttl keeps its lease …") and failed on the unchanged slice-2 engine in about one run in ten for that reason alone. It now allows two seconds, which cannot hide a missing renewal: a renewal made before the advance is at least `lease_ttl`/3 older. The cases added in this pass are written the same way. Nothing else about the engine's clock is pinned here; whether the engine should take durations from a monotonic clock is not a slice-2 question.

**Names and rules the Verifier fixed in this pass.** The Builder may object; the first two carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| Which outcomes count as decided before a lease expiry | An outcome already recorded; a deadline the engine acted on; a Stop or Abandon; a result accepted on a live lease. Pinned for the deadline and for an accepted result whose role had exited 0 | E27 item 3 names "a deadline, a Stop, a result accepted on a live lease". Not pinned: an accepted result whose role is still running when the lease expires (by section 13's table a role earns `completed` with its exit status, which that role does not have yet). |
| The `recovery` key of `run.ended` for a run ended by lease expiry | Absent | Correction 12 asks for a record of the recovery apart from the outcome; section 16 defined it as the startup recovery's. No startup recovery took place. |
| When "the engine has decided to end a run" | When it acts on the cause (a deadline found passed, a confirmed Stop or Abandon, the role's exit, an expired lease), whether or not the transaction that records it succeeds | E27 item 5 exists for the case in which that transaction fails. |
| When SIGKILL is sent after an `unknown` report | Once `terminate_grace` has passed since SIGTERM, without a tick; not at the report | D1 §4.5 step 2 gives the order TERM, `terminate_grace`, KILL, and attaches it to the run-end protocol, not to the tick. |
| What the engine does with a role whose output has ended | Nothing, until the role exits | Section 13 already put the start of the run-end protocol at the exit. |
| The slack allowed for the host's clock | Two seconds | Above. Far below any step of the controlled clock a test takes. |

**Open in E27, not pinned.** E27 ends with a question for the owner: should a run that the engine is still supervising, with a live process, survive the expiry of its lease, and should held work resume by itself after a pause? The answers may change "Expiry is final" and the `held` consequence above before M2. The slice-2 tests pin the stricter rule the build continues on. `../COVERAGE.md` records this for the next Verifier.

---

# Slice 3, part 1: what the final slice-2 review carried forward

Section 24 was written by the first of slice 3's two Verifier sessions (2026-10-02), before the slice-3 rows. Slice 2 was merged after three reviews; its final review named what was still weak (E28): a retried step of ending a run re-reads the store, while some of that step's inputs live only in memory or cannot be repeated. The owner's decision is to stop pinning such defects one at a time. The slice-3 rows themselves follow in later sections.

## 24. Ending a run is repeatable; outcomes that meet; reading a role's output

**The rule** (E28 item 1). Every step of ending a run is repeatable: if any step is repeated after a partial failure, it writes the same facts it would have written the first time. A step is a store transaction of the run-end protocol (D1 §4.5), of the command or observation that began the end (a role's result, a refusal, a confirmed Stop or Abandon, a deadline found passed, an expired lease reconciled, a quarantine and its clearance), or of the journaled worktree removal an Abandon performs. A partial failure is one failure of one such transaction: the transaction rolls back (section 6) and the engine, without being restarted, comes to the same end.

**The matrix.** `../contract/run-end-faults.json` lists ten endings, the ways a run can end in slice 2, and for each the store transactions on its path. `M15-run-end-fault-matrix.test.mjs` generates from it one reference case per ending (the ending with no fault) and one case per transaction (a cell). A cell arms a one-shot fault on its transaction, lets the ending happen, lets the project go on to its next item, and requires the same final durable facts as the reference.

| Ending | How the test causes it | What it leaves (`expect`) |
|---|---|---|
| `role_completes` | a held role is released, sends a valid result and exits 0 | `completed` / `none`; work `complete` |
| `invalid_result` | a held role is released and sends a result that is not valid | `failed` / `invalid_result`; the work is repaired by a second run and ends `complete` with `repair_attempts` 1 |
| `preflight_refused` | an engine with no qualified backend dispatches | `refused` / `preflight_refused`; nothing launched, no ledger row; after `preflight_refusals_max` refusals the work is `parked` |
| `deadline` | the clock is moved past the run's deadline | `timed_out` / `deadline`; work `parked`, blocker `deadline` |
| `stop_claimed`, `stop_executing` | Stop, at the `launch.before_spawn` barrier and with the role running | `stopped` / `human_stop`; work `held`; from claimed nothing was launched: the receipt is `refused` and not charged |
| `abandon_claimed`, `abandon_executing` | Abandon, the same two ways | `abandoned` / `human_abandon`; workspace discarded, on disk and in the repository; work `eligible` with `dispatch_hold` |
| `lease_expiry` | one jump of the clock past `lease_ttl`, then a tick | `recovered` / `recovered`; work `held` |
| `quarantine_cleared` | Stop with the boundary reporting `unknown`; later the boundary reports `terminated` and a tick runs | `stopped` / `human_stop`; work `held` |

**A transaction is named by an event it writes.** D1 §12.1 has every change write its event in the transaction that makes it, and D1 A.6 names the events, so every transaction on these paths writes an event that can be named, and the `before_event` fault of section 7 is enough: no new fault point is needed. The worktree removal's transactions, for one, are the ones that write `git.journal_intended` (the intent, with `operation.intended`) and `git.journal_applied`, `git.journal_confirmed` and `git.journal_finalized` (the settle, with `operation.succeeded` and `operation.finalized`). The table lists, per ending, the events D1 §§3.5, 3.6, 4.1, 4.3, 4.5 and 10 give its facts; it is not read from the engine. Where an engine commits several of them together, several cells arm the same transaction, which costs time and nothing else; where it commits them apart, each cell arms its own. Before a cell judges anything it checks, on the reference, that the unfaulted ending does write the named event after the point at which the fault is armed; a table entry that names no transaction on the path fails loudly instead of passing empty.

The events the table names beyond those section 16 already fixed: `run.validating` is written by the transaction that records a role's result; `invocation.status` by every transaction that appends a status observation, and `ledger.row` by the one that writes a ledger row (D1 §3.6); `decision.answered` and `decision.consumed` by the transaction that consumes a Stop or Abandon confirmation, and `decision.raised` by the one that raises a blocker; `work.complete`, `work.held` and `work.parked` by the transition into that status; **`work.advanced` by a work item's return to `eligible`** after a failed or refused run and after an Abandon (a name the sources left open: D1 §4.3 lists the `work.*` types without assigning this change; A.6 has no other type that fits).

**When the fault is armed** (`stage`). `before_end`: the last moment before the test causes the end. For Stop and Abandon that is between the two requests of section 17, after the confirmation has been raised. `quarantined`, for the clearance transactions of `quarantine_cleared`: after the run is quarantined and before the boundary reports `terminated`.

**A command whose own transaction fails.** If the fault lands in the transaction of the confirming request, that request is answered **500** `store_error` and has changed nothing (section 6): the run has no outcome, the confirmation is still open. The operator sends the same request again, with the same preview hash, and it takes effect. The cell does exactly that, once.

**What the engine is given** (`retry` in the table). The engine retries a failed step itself (E27 item 5); the expiry of the lease is the backstop (section 16, "The run lease"). A cell first only waits, five seconds. If the run has not ended it gives the engine, at most four times, the clock moved by two thirds of `lease_ttl`, a tick, and the wait again. It never restarts the engine. A run that has still not ended fails the cell with its state, outcome and leases.

**The facts compared** (`../harness/endings.mjs`, `projectFacts`). Everything the project's store holds, reduced so that two executions of the same history give the same value: no id, no timestamp, no path; rows in creation order, naming each other by position. For every work item: kind, status, `repair_attempts`, `preflight_refusals`, `no_progress_count`, `dispatch_hold`, the blocker's reason, its path of statuses, the decisions about it. For every run: role, state, outcome, reason class, `quarantined`, whether `finished_at` is set, its parent, its path of states, the number of `run.ended` events, its leases (kind, released or not), its grants (revoked or not), its domains (status, termination confirmed, the number of `domain.terminated` and `domain.quarantined` events), its workspace (disposition, `disposed_at` set, the directory on disk, the worktree in the repository), its receipts (the status observations in order, the usage observations, each ledger row's fields), its journaled operations (kind, journal kind, status, finalized or not, the journal's last event kind), the decisions about it (kind, status, answer). And the number of events of every type in the store, except `run.heartbeat`, `engine.tick` and `api.act`, whose number says how long a role lived, how many ticks the test asked for and how many requests it sent. The reference's facts are also checked against the table's `expect`, so a cell is compared with the sources and not only with the engine's own unfaulted behaviour.

**What follows for the engine**, stated because the slice-2 engine does otherwise:

- A worktree removal that succeeded on disk and whose record failed is recorded by the retry: one `worktree_remove` operation, `succeeded` and finalized, the workspace `discarded`. A second intent for the same removal must not collide with the first on the operation's idempotency key and strand the run.
- What the running engine knows of a spawn it never made is kept for as long as that engine lives. A repeated end of a run stopped or abandoned before its spawn records the receipt `refused`, once, and writes no ledger row, as the first attempt would have. `unknown` is for an engine that cannot tell (section 16), not for one that could and forgot.
- A preflight refusal whose record failed is still a refusal: the run ends `refused` / `preflight_refused`, not `failed` / `infra_error`, and the work's `preflight_refusals` is counted once.
- A role's result whose record failed once is recorded by a retry (the slice-2 engine already does this, briefly). What the engine does when every attempt fails stays where `../COVERAGE.md` put it, with row M61.

**Outcomes that meet** (`M15-decided-outcome-stands.test.mjs`).

- *A Stop or Abandon confirmed after the engine has decided to end the run for another cause is refused.* "Decided" is section 23's: the engine has acted on the cause, whether or not the transaction that records it has succeeded. The request is answered **409** `illegal_transition`, as for a run that has ended (section 17); the confirmation is not consumed; the outcome decided stands. The test pins it for a Stop confirmed while a deadline end is being retried (six faults armed on `run.finalizing`, the Stop sent three seconds after the deadline passed): the run ends `timed_out` / `deadline`, the work is `parked` with a `deadline` blocker and was never `held`. The test first shows that the run has in fact not recorded its end when the Stop is sent; an engine whose own retries have used up six attempts in three seconds fails that check with a message that says so.
- *A Stop or Abandon confirmed after the lease has expired, and before a tick has acted on the expiry, is recorded as given* (E28 item 2). An expiry that nothing has acted on has decided nothing. The run ends `stopped` / `human_stop` with its work `held`, or `abandoned` / `human_abandon` with its workspace discarded and its work `eligible` on dispatch hold; the tick that follows does not make it `recovered`. Section 16's "Expiry is final" is about the role's callbacks and the lease's renewal, not about the operator's commands.
- *A role that exited 0 after its result was accepted ends `completed`,* whenever the engine comes to act on the exit. The test lets the role exit, sees the process gone, and only then moves the clock past `lease_ttl`; the role leaves a descendant that keeps its stdout open and keeps writing to it, so an engine that reads on for a while after the exit has not acted on the exit when the clock jumps. The result was accepted on a live lease and the role exited cleanly before the expiry: that is an outcome decided before the expiry (section 16). E27 item 7 is the other case, a role still running when the lease expires, and is unchanged.

**Reading a role's output** (`M16-role-output-long-line.test.mjs`). The time the engine takes to read a role's standard output is linear in the length of a line, and a long line costs nothing of what follows it. Pinned as: a role that writes one line of 64 MiB, a line ending, a `usage` line and a valid `result`, and exits 0, ends `completed`, with that usage recorded, no later than **eight seconds** after its launch. A reader that is linear needs about a second for it on the host these tests were written on; the slice-2 engine, which searched everything it had read of the line again at every chunk, needs fifteen. What the engine does with the long line itself (it is no protocol line) is not pinned, and a cap on what it buffers is still slice 4's (`../COVERAGE.md`).

The role program no longer cuts its own output short. `scripted/child.mjs` used to exit half a second after its last step whether or not its output had been written; it now exits only once everything it wrote has left the process, however slowly it is read, and at once if the reader is gone. Without that the test above would have measured the harness.

**The token file** (`M69-token-interior-whitespace.test.mjs`; E24 item 8). Section 6 left open whether a space or a tab inside the token is refused. It is: a well-formed token is at least 32 visible ASCII characters and nothing else, so a file whose token has a space or a tab inside it refuses the start with status 5, `token_file_refused`, and is left as it was.

**Timing** (E29 item 2). After the slice-2 merge the suite failed once on `main`, 190 of 191, and then passed six times; the failing run's output was not kept. Every existing test and helper was read for a comparison between an engine timestamp and the controlled or real clock that is exact or too tight, for a real-time wait that assumes something cannot happen meanwhile, and for anything else that could fail one run in ten on a host whose wall clock steps back by three quarters of a second every half minute. The failure was not reproduced (two full runs of the unchanged suite passed while this was written), so what follows removes causes that were found, and does not claim to have identified the one that fired. What was changed, and why none of it can hide a defect of the engine:

| What could go wrong | Change | Why it hides nothing |
|---|---|---|
| `tick()` sent one request per project in each of its two rounds. The engine's tick is engine-wide, so several projects meant several ticks; a round returned at the first tick's end, and `tick()` could return with a tick still pending or under way. In `M15-deadlines.test.mjs`, "a prerequisite step that overruns its budget …", that pending tick could dispatch project A's item before the test had armed its fault, and the test then failed on "the other project was dispatched in the same tick". No clock is involved; a few percent of runs by the timing of two messages. This is the likeliest cause of the unidentified failure. | `tick()` (`runs.mjs`) sends one request per round, to the first project given. | The tick is engine-wide by section 15. An engine whose tick served only the project in the route would now leave the other projects undispatched and fail every case with two projects; a request per project used to mask that. |
| `M15-lease-supervision.test.mjs`, the two "… fails once: the run still ends …" cases, moved the clock past `lease_ttl` as soon as the role's process was gone. The role's exit can be seen before the engine has recorded the result the role sent; a jump that lands there makes `recovered` the right outcome, and the test expects `completed`. | Both cases wait for the run's `run.validating` event before the clock is moved. | The cases' stated premise is "a valid result was accepted on a live lease"; the wait establishes it and changes no assertion. That a clean exit after an accepted result must still give `completed` when the clock jumps before the engine acts on the exit is pinned on its own (above), with a window the test controls. |
| `M06-engine-lock.test.mjs` read the incarnations `ORDER BY "id"` and asserted that a restarted engine's incarnation id is greater than its predecessor's. Ids are time-ordered within a process; two engine processes take their time from a clock that can step back between their starts, about a third of a second apart. Roughly one suite run in fifty. | The rows are read in the order they were recorded (`ORDER BY rowid`); the `>` assertion is gone. | No source requires ids ordered across processes, and no engine can give that on such a clock without persisting a high-water mark. The cases still prove exactly which incarnations were recorded, in which order. |
| `M07-settings-used-by-scheduler.test.mjs` released its roles and then ran three ticks at once, expecting one of them to start after a run had ended and freed a slot. On a loaded host all three can run first, and the case times out. | `tickUntil` every item is complete. | `tickUntil` is bounded, and the assertion the case is about, never more runs at one time than the limit, is unchanged. |
| `advanceClockInSteps` paused 1.2 s between steps and assumed a renewal landed in the pause. An engine stalled for most of a second lost a lease to the next step, and a deadline case ended `recovered` instead of `timed_out`. | Between steps it now also waits, for at most five seconds, until every live run lease has been renewed since the step just taken. | A renewal that never comes is not waited for beyond the bound; the next step then expires the lease as before and the case fails as before. |
| `Scripted.log()` parsed every line of the role program's log, including one a process was still writing. | A last line with no line ending is left for the next read. | An entry is only ever read whole. |
| `harness/ids.mjs` made ids that were not ordered across a step back of the clock. | The time part never goes below the last one used. | Test-made ids only. |
| The timers of `Engine.stop()`, `startRefused()` and one case of `M05-migrations.test.mjs` were never cancelled, so each test file's process stayed alive for up to thirty seconds after its last test. The suite took 454 s for 224 s of tests, which doubled the number of clock steps a run met. | `within(promise, ms)` (`engine.mjs`) cancels its timer when the promise settles; `startRefused()` also waits for the process's output to end before it parses it. | The same limits apply while the wait is undecided. |

Read and judged safe, so the audit's coverage is on record: every comparison of a lease's or a deadline's timestamp with a `now` has seconds of slack or the two-second allowance of section 23; no test sorts rows by a timestamp, and rows ordered by id are only ever searched or counted; every fixed sleep is followed by an assertion that something has *not* happened, or has two seconds or more of margin against the engine's own timers; no acceptance test but the new long-line case asserts on elapsed real time; ports are safe because files run one at a time. Two things were seen in the engine and left to it, since no test depends on them yet: the tick's budget is measured on the wall clock, and the scheduler orders projects and items by `created_at`, which a step back between two inserts reverses. The run-end fault matrix does not depend on that order: it adds the project's next item only once the first has got where its ending leaves it.

**What the harness gained.** `endings.mjs` (the drivers for the ten endings, `projectFacts`, `assertEndingExpectations`, `matrixCells`, the lazily produced reference). In the role program: the exit that drops nothing; `{"stdout_fill": {"bytes": n}}`; a descendant's `chatter_ms`; and the file and git steps the slice-3 rows use. `scripted.mjs` gained `step.stdoutFill`, `step.writeFill`, `step.delete`, `step.rename`, `step.symlink` and `step.git`. The self-check runs each against something real (`selfcheck/slice3.mjs`), and the witness engine, which now retries a failed run end as this section says, has one defect for each kind of failure the cases are meant to catch (`selfcheck/witness.mjs`).

**Against the slice-2 engine** (`main`, 656bd26). All ten references pass. Of the 77 cells, 62 pass and 15 fail: the two cells the final review named (an Abandon whose worktree removal succeeded on disk and whose record failed stays `finalizing` until a restart: six cells, the three settle events from claimed and from executing; a run stopped at `launch.before_spawn` whose end failed once is recorded `dispatch_started`, `unknown` and charged: three cells) and two failures the reviews had not found (a run abandoned before its spawn is recorded and charged the same way whichever of its end's transactions fails: four cells; a preflight refusal whose record fails ends the run `failed` / `infra_error`: two cells). Of the single cases, three fail there as stated (the Stop during a deadline retry is answered 200 and the run ends `stopped`; the role that exited 0 ends `recovered`; the 64 MiB line takes fifteen seconds) and five pass (the two E28 item 2 cases and the three token files): the slice-2 engine already does what those pin.

**Names and rules the Verifier fixed in this section.** The Builder may object.

| What | Fixed as | Why this choice |
|---|---|---|
| The event of a work item's return to `eligible` | `work.advanced` | A.6 has no other type for it; the slice-2 engine already writes it. |
| A Stop or Abandon after the engine has decided the run's end | **409** `illegal_transition`, confirmation not consumed | The same answer as for a run that has ended (section 17). Answering 200 would tell the operator that a Stop took effect whose consequence, held work, did not happen. |
| A confirming request whose transaction failed | **500** `store_error`, nothing changed; the same request again takes effect | Section 6; the confirmation must not be burnt by a failure. |
| The bound for a long line | 64 MiB, eight seconds from launch to the run's end | Far from both sides: about eight times what a linear reader needs here, about half of what the quadratic one needs. |
| Which transactions an ending has | The events of `../contract/run-end-faults.json` | E28 item 1 asks for "each store transaction on that path"; D1 §12.1 lets an event name each. |
