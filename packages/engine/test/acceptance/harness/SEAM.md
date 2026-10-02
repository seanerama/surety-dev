# The test seam

**Owner:** the Verifier (build spec §4). **Written:** slice 1, 2026-10-01. **Amended:** 2026-10-01, after the slice-1 review (section 11). The owner's decisions on that review are cited below as E23, the erratum that records them. **Extended:** slice 2, 2026-10-01 (sections 12 to 20, and the amendments to sections 1, 6 and 7 that section 20 lists). **Amended:** 2026-10-01, after the slice-2 review (section 22 lists every change; the owner's decisions on that review are E25), and 2026-10-02, after the second (section 23; E27). **Extended:** slice 3, 2026-10-02, by the first of its two Verifier sessions (section 24: what the final slice-2 review carried forward, E28 and E29; sections 25 to 38: rows M19 to M25 and the slice-3 cases of earlier rows that concern snapshots, validation, commits and integrity). **Extended:** slice 3, 2026-10-02, by the second of its two Verifier sessions (sections 39 to 51: rows M26 to M34, and the slice-3 cases of rows M04, M09, M12 to M15 and M24 that pass through an integration; one flag added to section 1). **Extended:** slice 4, 2026-10-02 (sections 52 to 64: rows M59 to M67 and the slice-4 cases of rows M02, M04, M12 and M61; one exit status added to section 1). **Extended:** slice 5, 2026-10-02 (sections 65 to 85: rows M35 to M58 and the slice-5 cases of rows M08, M09, M12, M24, M27, M61, M62, M64 and M65; section 65 lists what it changes in earlier sections; one sentence added to section 31 for the slice-3 review). **Extended:** slice 7, 2026-10-02 (section 86: row M01, the journey, which adds nothing to the contract). Later slices extend it; a change to anything below is made by a Verifier session, normally in answer to an objection.

This file states exactly what the engine must provide for the acceptance tests to observe it (build spec §8). The tests are the contract; this file says in prose what they rely on. Where the sources (build spec §2) left a name, code, format or range open, the Verifier fixed it here; section 10 lists those choices. Everything else follows D1 Appendix A as corrected by build spec §6.

Paths are relative to the repository root unless they start with `$SURETY_HOME`.

---

## 1. The process

The tests run the built binary as `node packages/engine/dist/cli.js serve [flags]` with the working directory set to `$SURETY_HOME` and a constructed environment containing only `SURETY_HOME`, `PATH`, `HOME` (= `$SURETY_HOME`), `LANG=C.UTF-8` and `TZ=UTC`. One slice-3 case, row M23's, adds hostile variables to that environment and starts the engine in another directory (section 31).

**Flags.** `--harness` enters harness mode (section 7). The flags below are accepted only together with `--harness`; given without it, or any unknown flag or command, the process exits with status **2** before doing anything else.

| Flag | Meaning |
|---|---|
| `--harness-migrations <dir>` | Read migrations from `<dir>` instead of `packages/engine/migrations/`. |
| `--harness-barrier <name>=<action>` | Arm a barrier at startup. Repeatable. `<action>` is `pause` or `kill`. |
| `--harness-scripted <dir>` | The scripted backend's directory (section 13). Without it the `scripted` backend is not qualified and nothing is dispatched. |
| `--harness-probe <kind>=<outcome>` | While this engine runs, every probe of that journal kind reports that outcome (section 45). Since slice 3. |

**Exit statuses.**

| Status | When |
|---|---|
| 2 | Usage error: unknown command or flag, or a harness flag without `--harness`. |
| 3 | `engine_locked`: another live incarnation holds the lock (section 3). |
| 4 | The configuration was refused (section 2). |
| 5 | `token_file_refused`: an existing `api.token` cannot be trusted: it grants a permission to group or others, is not a regular file, or does not hold a well-formed token (section 6). |
| 6 | The engine could not start listening: `home_unusable` (the engine home cannot be used) or `listen_failed` (the API port cannot be bound). See "A start that fails before listening", below. |
| 7 | A `surety store` command was refused (section 59). Since slice 4. |

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

**Project scope.** Ungoverned project keys (`../contract/config.json` `project`) are read with `GET /v1/projects/:p/policy`, which returns `{"effective": {<key>: <value>}, "revision": <the project's current policy revision number, or null if it has none>, ...}`, and changed with `POST /v1/projects/:p/policy`, whose body is an object of the keys to change. The submission is validated whole against the closed schema before anything else happens: an unknown key is `unknown_field`, any invalid value is `invalid_value`, both with `subject: {"field": "<key>"}` and HTTP 400, and a refused submission changes nothing (not the effective policy, the repository or the store). `max_concurrent_runs` accepts only `1` through M3 (E18). Slice 1 pins only refusals; a valid change commits through the journaled git path and is pinned in slice 3 (section 27). Governed keys (`.surety/checks/protected-policy.json`, RN R2) are slice 5.

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

**Role of a run.** `stage_build` and `fix`: `builder`. `verification`: `verifier`. `review`: `reviewer`. `replan`: `architect`. `assessment`: `architect` (E24 item 5; left open in slice 2, pinned in slice 3, section 25).

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

**Barriers.** Armed at startup with `--harness-barrier`, as in section 7 (slice 3 adds arming while the engine runs, and the journal's barriers: section 33); each fires once, the first time its point is reached. `pause` waits there until released while the API keeps answering; `kill` makes the engine send itself SIGKILL there. A barrier is defined by what is durable when it fires, not by how the engine groups its transactions: where the engine commits two of these facts together, the two barriers fire one after the other with the same store.

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

**Faults.** The `before_event` fault of section 7 is armed in slice 2 on `run.finalizing`, `run.ended` and `work.resumed`. `POST /v1/harness/faults` also accepts `{"point": "tick_step", "step": "recover" | "journal", "project": "proj_<ULID>", "delay_ms": <n>}` (slice 3 adds the step `integrity`, section 32): one-shot; the next time a tick runs that prerequisite step (D1 §8.1 steps 1 and 2) for that project, the step takes `delay_ms` of real time longer. D1 §8.1: a prerequisite step that overruns `tick_step_budget` makes that project's dispatch ineligible for that tick, also when the step completes later; other projects and the API go on. A tick whose steps have used up `tick_budget` dispatches nothing further.

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

Section 24 was written by the first of slice 3's two Verifier sessions (2026-10-02), before the slice-3 rows. Slice 2 was merged after three reviews; its final review named what was still weak (E28): a retried step of ending a run re-reads the store, while some of that step's inputs live only in memory or cannot be repeated. The owner's decision is to stop pinning such defects one at a time. Sections 25 onward are the slice-3 rows themselves.

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

**The harness's own waits** (added by the Verifier pass before the slice-5 build, 2026-10-02; E36, "Still open"). The audit above looked at what the tests compare. It did not look at the clock the harness itself waits on, and that was the wall clock: `waitFor` and `Engine.waitUntil` (`engine.mjs`) computed a deadline from `Date.now()`. A step back of the wall clock only lengthens such a wait. A step forward ends it: the wait throws "timed out" at its next look, however little real time has passed and whatever the engine is doing. This host's wall clock does step forward. Its system journal stamps every entry with both clocks, and the difference between them jumps: by about 900 s in one step, and again, by a quarter of an hour to two hours, in a second step a moment later, on three occasions in the 24 hours before this was written (2026-10-01 11:29; 2026-10-02 00:36; 2026-10-02 09:17 and 09:31, local time), each beside the kernel's line for the hypervisor's time synchronisation, which is what a virtual machine logs when it resumes after its host slept. The third falls inside the hours of the slice-4 build. The Builder's failure, "timed out waiting for full" 2.7 s into a 30 s wait in `M24-tracked-refs-versus-developer-refs.test.mjs` with the engine in full mode, is exactly what such a step does to a restart that is under way when it lands, and the message has no other source in the harness: it is thrown in one place, on that comparison. The failing run's report was not kept (the two slice-4 reports that were kept both pass), so the cause is shown for the mechanism, the host and the morning, and inferred for that run. The half-minute step back cannot produce it (0.8 s every 32 s when this was written: the time-sync service polls every 32 s and steps the clock back each time). Nor does the forward step explain the one-off failure of E29 item 2: in the hour between the slice-2 merge and the change that made the runner keep its reports (2026-10-01, 22:12 to 23:04) the journal shows no forward step, and a step back cannot end a wait early. That failure stays unidentified, with the `tick()` race above its likeliest cause. What changed:

| What | Change |
|---|---|
| `waitFor`, `Engine.waitUntil` (`engine.mjs`) | Elapsed time is read from `performance.now()`. `waitUntil`'s message now gives the wait's length, like `waitFor`'s. |
| `PowerLoss.cut` (`powerloss.mjs`) | The same, for its 15 s limit on the processes it kills. |
| `concurrentInserts` and its child (`concurrent.mjs`, `concurrent-insert.mjs`) | The children meet at an instant of the monotonic clock (`process.hrtime.bigint()`, one clock for every process on Linux), not at a wall-clock instant. |
| `M15-deadlines.test.mjs` and `M15-git-deadline-and-integrity-step.test.mjs` ("a prerequisite step that overruns …"), `M16-quarantine.test.mjs` ("… still sent SIGKILL after terminate_grace …") | Each measured a real-time interval with `Date.now()` (how long to sleep until a delayed step is over; how long a role may live after Stop). They use `performance.now()`. No assertion changed. |

Left on the wall clock because they are about the wall clock: the ids and timestamps the tests make (`ids.mjs`), the UTC-day margin of `awayFromMidnight` (`ledger.mjs`), a deferral's target date (rows M42 and M50), the role program's log timestamps, and every comparison with an engine timestamp, which keeps the two-second allowance of section 23. Node's timers (`sleep`, `within`, a request's timeout) were already monotonic. None of this changes what a test requires of the engine: a wait still gives up after the same real time.

**An engine whose start-up wait fails is stopped** (the same pass). `startEngine` spawned the engine and then waited for it; a fixture learned of the engine only from the value `startEngine` returned, so when the wait threw, no cleanup list held the process. It outlived its test, and its open pipes kept the test file's process alive until the runner's limit (600 s). `startEngine` now kills the engine it spawned before it passes the error on; the error's text, made before the kill, still says whether the engine was running and what it had written. Every fixture that starts an engine (`engineFixture`, `scriptedEngine`'s `start`, `storeTemplate`) goes through `startEngine`.

Both were checked directly, old harness against new, outside any test: with `Date.now` made to step forward by 900 s during a wait, the old `waitFor` and `waitUntil` threw at once (the engine then reached full mode) and the new ones returned when their condition came true; with a start-up wait of 1 ms, the old `startEngine` left its engine running and the new one left none.

**What the harness gained.** `endings.mjs` (the drivers for the ten endings, `projectFacts`, `assertEndingExpectations`, `matrixCells`, the lazily produced reference). In the role program: the exit that drops nothing; `{"stdout_fill": {"bytes": n}}`; a descendant's `chatter_ms`; and the file and git steps the slice-3 rows use (section 26). `scripted.mjs` gained `step.stdoutFill`, `step.writeFill`, `step.delete`, `step.rename`, `step.symlink` and `step.git`. The self-check runs each against something real (`selfcheck/slice3.mjs`), and the witness engine, which now retries a failed run end as this section says, has one defect for each kind of failure the cases are meant to catch (`selfcheck/witness.mjs`).

**Against the slice-2 engine** (`main`, 656bd26). All ten references pass. Of the 77 cells, 62 pass and 15 fail: the two cells the final review named (an Abandon whose worktree removal succeeded on disk and whose record failed stays `finalizing` until a restart: six cells, the three settle events from claimed and from executing; a run stopped at `launch.before_spawn` whose end failed once is recorded `dispatch_started`, `unknown` and charged: three cells) and two failures the reviews had not found (a run abandoned before its spawn is recorded and charged the same way whichever of its end's transactions fails: four cells; a preflight refusal whose record fails ends the run `failed` / `infra_error`: two cells). Of the single cases, three fail there as stated (the Stop during a deadline retry is answered 200 and the run ends `stopped`; the role that exited 0 ends `recovered`; the 64 MiB line takes fifteen seconds) and five pass (the two E28 item 2 cases and the three token files): the slice-2 engine already does what those pin.

**Names and rules the Verifier fixed in this section.** The Builder may object.

| What | Fixed as | Why this choice |
|---|---|---|
| The event of a work item's return to `eligible` | `work.advanced` | A.6 has no other type for it; the slice-2 engine already writes it. |
| A Stop or Abandon after the engine has decided the run's end | **409** `illegal_transition`, confirmation not consumed | The same answer as for a run that has ended (section 17). Answering 200 would tell the operator that a Stop took effect whose consequence, held work, did not happen. |
| A confirming request whose transaction failed | **500** `store_error`, nothing changed; the same request again takes effect | Section 6; the confirmation must not be burnt by a failure. |
| The bound for a long line | 64 MiB, eight seconds from launch to the run's end | Far from both sides: about eight times what a linear reader needs here, about half of what the quadratic one needs. |
| Which transactions an ending has | The events of `../contract/run-end-faults.json` | E28 item 1 asks for "each store transaction on that path"; D1 §12.1 lets an event name each. |

---

# Slice 3, first session: snapshots, validation, commits, integrity

Sections 25 to 38 were written with the slice-3 acceptance tests of the first of two Verifier sessions (2026-10-02): rows M19 to M25, and the slice-3 cases of rows M06, M07, M09, M11, M15, M16, M18 and M31 that concern snapshots, validation, commits and repository integrity. They follow D1 §§3.1, 3.3, 3.5, 4.5, 5, 7, 8.1, 12 and 16 with build spec §6 corrections 1, 6, 14, 15 and 16, and the decisions E23 item 3, E24 item 5, E25 item 3, E27 item 4 and E29 item 1. Where those left something open, the choice is listed in section 36. Rows M26 to M34 are the second session's; section 37 says what is left for it and what it must not have to rename.

The expected tables are `../contract/snapshot-validation.json` (what a role may change, what a snapshot may not hold, which reason class a violation has) and `../contract/journal.json` (the journal kinds, the barrier boundaries, an operation's ordinary course).

## 25. What the slice-3 tests assume throughout

- **Integration is built for the Builder's and the Architect's kinds.** A run of `stage_build` or `fix` (role `builder`) or of `replan` or `assessment` (role `architect`; E24 item 5, now pinned: section 16 left it open) that returns a valid result is snapshotted, validated, committed and integrated as sections 28 to 30 say. The slice-2 sentence "what follows a run that returns a valid result is not pinned until slice 3" ends here for these four kinds.
- **`verification` and `review` are as in slice 2.** They complete on a valid result. What validation does with what such a run wrote is pinned in slice 5 with proposal capture (row M36): a Verifier's protected-only diff becomes a proposal, and its other writes, like any write of a Reviewer, are role violations (F §4.1). Four slice-2 cases had a verification role write `report.txt` and complete; they stood until slice 5 changed them with the rule (`../COVERAGE.md`). Three of them no longer write the file; the fourth, whose run is quarantined and never snapshotted (section 68), still does.
- **What happens after `integrated` is the second session's** (sections 40 and 41). For `stage_build` and `fix` the path goes on to `verifying`, which needs a chain of roles (E24 item 1); the finalizers of a plan and a stage are row M26. These tests assert a work item's path as far as `integrated` and that it is legal for its kind; they do not assert what follows.
- **The repositories.** Unless a case is about something else, a project's integration branch is checked out nowhere: the repository's own work tree is detached at the branch's commit (`makeProjectRepo` in `repos.mjs`; Plan §2). The slice-2 fixtures (`makeRepo`) leave the integration branch checked out in the repository's work tree. That still works for everything slice 2 does: such a checkout is a managed checkout (section 32), a project with one dispatches as before, and only an integration is refused (section 30).
- **The fixture installer in slice 3.** `POST /v1/harness/fixtures/project` still installs a registered project without a bootstrap commit. It registers the integration branch in the ref registry with its current commit as the expected one, and registers a non-engine checkout of the integration branch, if there is one, as a managed checkout with what it holds as its baseline (section 32). The repository has no `.surety/project.json`; context resolution and integrity accept that for a project installed this way, and a role that creates the file is still rejected (section 28).
- **Nothing in these sections needs a restart to move the clock.** As before, the tests never restart an engine whose clock they moved.

## 26. The scripted role in slice 3

**The structured result.** A valid result is a JSON object whose `status` is `"completed"` and whose `summary` is a string (section 13), and which may carry `checkpoint` and `nominate`. Each, if present, must be a JSON boolean; anything else there is `invalid_result`. `checkpoint: true` asks for a checkpoint (section 29). `nominate: true` asks for a nomination (D1 §7.7); what the engine does with it is row M27, the second session's, and no test of this session sends it. (Section 42 now says what it does.) A result that carries a key the schema does not know is not pinned.

**What a role can do.** The role program (`scripted/child.mjs`) gained steps: `write` with `fill` (a file of n bytes), `write_many` (n files in a directory), `delete`, `rename`, `symlink`, and `git` (the git binary, run in the workspace with the arguments given and a small environment of its own). File steps take paths relative to the workspace or absolute. A scripted role runs as the engine's user, so its script can reach the repository's `.git`, another run's workspace, or anywhere else that user can write; that is how the tests script what validation must reject. M1 claims no isolation of a role from the engine or from the repository (E25 item 2): what a role writes *outside* its workspace, the repository and the other managed checkouts is neither prevented nor seen. The tests pin only that nothing of it is ever committed.

**The request** is unchanged (section 13).

## 27. Projects: creation through the API, the effective policy, a policy change

**`POST /v1/projects`** (D1 §§3.1, 11.4). Body: `{"name", "tier", "dev_repo_path", "integration_branch"}`, all required; an unknown key is **400** `unknown_field`; a `tier` that is not `T1`, `T2` or `T3` is **400** `invalid_value` with `subject.field` `tier`. `dev_repo_path` must be a git repository the engine can read (**409** `repo_unreadable` otherwise) and `integration_branch` a branch that exists in it (**400** `invalid_value`, `subject.field` `integration_branch`). If the integration branch is checked out in a worktree the engine does not own, the bootstrap commit could not be integrated (section 30): the request is refused **409** `integration_conflict`, with the worktree's path in `subject.worktree` and in `what_to_do` the instruction to switch that worktree to another branch or detach it. A refused request creates nothing: no project row, no ref, no commit.

Accepted: **201** `{"project": {"id": "proj_<ULID>", "registration_state": "pending_bootstrap" | "registered"}}`. The bootstrap transaction writes the project as `pending_bootstrap` and emits `project.created` (with `subject.project`, and no `test_fixture` label); it journals a commit that adds `.surety/project.json` to the integration branch: one `git_commit` operation (journal kind `commit_tree`) and one `git_ref_update` operation (journal kind `ref_update`), each running its ordinary course (section 33). The integration finalizer sets `registration_state` `registered` and emits `project.registered`. The project becomes `registered` without a tick; the tests wait for it. Afterwards:

- the integration branch points at a commit whose only parent is the commit it pointed at before and whose tree differs from that parent's by exactly one added path, `.surety/project.json`;
- that file is a JSON object whose `id` is the project's id (other keys are the engine's);
- the ref registry holds the integration branch with that commit as its expected one, and the next integrity observation finds nothing out of band;
- every other ref, the repository's configuration and every checkout are as they were.

Work is dispatched only for a `registered` project.

**The effective policy** (E23 item 3). A project's effective policy is the policy revision the engine has recorded; with none recorded it is the schema defaults and `revision` is `null`. A `.surety/policy.json` that is in the repository and that the engine never recorded is not effective, whatever it says: bootstrap leaves such a file exactly as it is, does not record it, and `GET /v1/projects/:p/policy` reports the defaults with `revision: null`.

**A valid change** (D1 §11.4; section 2 pinned only the refusals). `POST /v1/projects/:p/policy` with a body that passes the closed schema and widens nothing is answered **200**. The engine commits `.surety/policy.json` to the integration branch through the journal (a `commit_tree` and a `ref_update` operation, as for bootstrap) and records a `policy_revisions` row: `revision` (1 for the first, counting up), `git_path` `.surety/policy.json`, `git_blob` the blob id of the committed file, `committed` 1, `widens_authority` 0. `projects.policy_revision` names it, `policy.changed` is emitted, and from then on `GET …/policy` reports `revision` and, in `effective`, the changed keys with their new values and every other key at its default. The tests wait for the revision to be reported. The committed file is a JSON object; every key in it is a project key of the closed schema and has the effective value. It is written from what the engine has recorded plus the change: content of an unrecorded file that was in the repository before does not survive into it and never becomes effective.

Which changes widen authority is row M49's (slice 5). The tests of this slice change only what cannot widen: they lower `repair_attempts_max`, `deadline_reviewer` and `snapshot_max_file_bytes`. The settings take effect: the scheduler parks work at the new repair limit, a run's deadline is the new one, and validation applies the new cap.

A policy change needs the repository: with an unreconciled out-of-band change on the project it is refused **409** `out_of_band_change`, and with an unreadable repository **409** `repo_unreadable` (section 32). Both leave nothing behind.

## 28. Snapshot, validation and commit

For a run of the Builder's or the Architect's kinds, in this order after the role has sent a valid result and exited 0 (the run is `validating`):

**1. Termination before any snapshot** (correction 1; D1 §7.3 "snapshot admission"). The run's domain must be reported `terminated` by the boundary before the workspace is snapshotted. While it is not, nothing is captured: `workspaces.snapshot_tree` is null and the run has no `commit_tree` operation. If termination is not established, by an `unknown` report or by the grace periods running out (section 14), the run is quarantined as section 16 says, and the outcome recorded with the quarantine is `failed` / `infra_error`, with a `reason_text` that says so: the engine could not establish what the role left. Such a run is never snapshotted, not while it is quarantined and not when the quarantine clears; it ends with the outcome it had, its workspace is retained, and its work returns to `eligible` for a repair like any failed run's.

**2. The snapshot.** `workspaces.snapshot_tree` is set to the id of the tree that `git add -A` gives for the workspace in an index of its own that started as the tree of `workspaces.current_base` (D1 §7.3). The workspace's real index and its HEAD are not used and not changed. The tests compute that tree themselves (`snapshotTree` in `repos.mjs`).

**3. Validation** of the snapshot tree against `current_base`, and of what lies outside the diff. `../contract/snapshot-validation.json` holds the rules and the cases:

- *Role paths* (F §4.1). A Builder may change any path that is not under `.surety/`. An Architect may change only paths under `.surety/adrs/`, `.surety/architecture/`, `.surety/roadmap/` and `.surety/phases/`. Any other changed path rejects the run.
- *The protected set and the identity file.* For these two roles any change under a protected root (`.surety/checks/`, the default; the governed policy file is slice 5's) and any change to `.surety/project.json`, its creation included, rejects the run. The role rule already says so for both; they are listed because D1 §7.3 steps 2 and 3 name them.
- *Containment.* A symbolic link whose target leads outside the workspace, directly or through other links, rejects the run; a link to a path inside the workspace is content like any other. An entry that is not a regular file or such a link rejects the run: a repository of its own inside the workspace, which a snapshot holds as a gitlink, is the case pinned.
- *Caps* (the project settings `snapshot_max_files`, `snapshot_max_bytes`, `snapshot_max_file_bytes`). A snapshot that exceeds one of them rejects the run. The tests exceed each cap in a way that is over it however it is counted (5,001 new files; one new file of 10 MiB and a byte; eleven new files of 9.6 MB), and lower one cap through a policy change to show that the setting is the one used. Whether a cap counts what the run changed or all the tree holds is not pinned.
- *Outside the diff* (correction 15; D1 §7.3 steps 3 and 4). The run's own workspace must still have its HEAD detached at `current_base` and its real index as the engine left it; the git metadata must be as it was; every registered ref must have its expected commit; every other managed checkout must be as its baseline says. For the workspace's own files, content is judged by the diff and by nothing else: a permitted edit is never a ref violation and never an out-of-band observation, during the run or at validation. "Git metadata" is pinned as: the repository's configuration file, its hooks directory, and the workspace's `.git` file. Another managed checkout is pinned as: a tracked file of another run's retained workspace.

**The reason class** is decided by one rule: a violation found in the captured diff is `diff_violation`; a violation found outside it is `ref_violation`. So role paths, the protected set, the identity file, links, kinds and caps are `diff_violation`; a registered ref, the workspace's HEAD or index, git metadata and another checkout are `ref_violation`.

**A rejected run** ends `failed` with that reason class and a non-empty `runs.reason_text`; for a path its role may not change, the text names the path. Nothing of it is accepted: no commit, no `revisions` row, no `commit_tree` or `ref_update` operation that succeeded, the integration branch where it was, the registry unchanged, no ref created under `refs/surety/`. The workspace is retained with what the role left. The work returns to `eligible` like any failed run's (section 15), with its repair counted when it is dispatched again. A ref or checkout the role altered is, besides, an out-of-band change of its own (section 32): the engine does not undo it and does not absorb it.

**4. The commit.** A snapshot that passes is committed with `git commit-tree`: parent `current_base`, tree `snapshot_tree`, through the journal (kind `commit_tree`, operation kind `git_commit`; section 33). The journal's `intended` event carries the tree in `payload.tree`, the parent in `payload.old_oid` and the run in `payload.run`. A `revisions` row records it: `sha`, `parent_sha` the base, `created_by_run` the run, and `kind` `engine_commit` for a Builder's run, `intent` for an Architect's (D1 §7.8), `checkpoint` when the result asked for one. `revision.recorded` is emitted. The commit is reachable from at least one ref the registry holds (D1 §6.5, §7.10: a `keep` ref, or the integration branch once it is integrated). The validated, recorded and committed trees are one tree: `snapshot_tree`, the journal's `payload.tree`, the commit's tree and the tree the test computes are equal.

**The commit message** (D1 §7.4) carries the trailers `Surety-Run` (the run's id), `Surety-Role` (the role), `Surety-Base` (the base commit), `Surety-WorkItem` (the work item's id) and `Surety-Kind` (the work item's kind), each exactly once: text a role supplies, its `summary` for one, never adds a second or changes the first. Its author and committer are the engine's choice and are not taken from the engine's ambient environment (section 31). The first line is not pinned.

**Data stays data** (D1 §17(3); row M20). File names a role chooses, a stage's goal, a role's summary and a branch's name reach git and the store as data. A file named like an option or holding shell syntax is committed under exactly that name; nothing is executed and no other file appears.

**5.** A result that asked for a checkpoint goes on as section 29 says; any other is integrated as section 30 says. The run then ends `completed`.

**The progress key** (D1 §4.3; row M11). When a run fails validation, the engine takes the progress key of that attempt over its snapshot tree (and, from slice 5, its findings). A key equal to the work item's stored `progress_key` adds one to `no_progress_count`; when that reaches `no_progress_max` the item is parked instead of repaired, with blocker reason `no_progress_max`. A key that differs replaces the stored one and counts nothing. So a role that leaves the same rejected tree every time is launched `1 + no_progress_max` times, and one that leaves a different rejected tree every time is launched `1 + repair_attempts_max` times and parks at the repair limit. Timestamps, run ids and workspace paths are not part of a tree, so they are not part of the key.

**Recovery after a normal result** (row M18; D1-32). An engine killed after a role's valid result arrived and before it acted on it recovers the run as section 16 says: `recovered`, its work `held`, its workspace retained. In slice 3 the recovery also captures the snapshot, after it has established the domain's termination: `workspaces.snapshot_tree` is the tree of what the role left. Nothing is validated, committed or integrated by a recovery, and what a Resume does with the captured tree is not pinned.

## 29. Checkpoints

D1 §7.4; E2 ("checkpoints confer no git authority"); E11 ("a checkpoint is always a working revision"). A Builder's result with `checkpoint: true` is snapshotted, validated and committed like any other (section 28), and then:

- the `revisions` row has `kind` `checkpoint`;
- the integration branch does not move, no candidate is nominated and no ref is created under `refs/surety/cand/`;
- `workspaces.current_base` becomes the checkpoint commit and `workspaces.checkpoints` names the revision; `workspaces.base_revision` and `runs.base_revision` keep the original base;
- the run ends `completed`; its work item returns to `eligible` (not `integrating`), with no repair attempt charged, then or at its next dispatch;
- the next dispatch of the item is a new run that continues from the checkpoint: its `base_revision` is the checkpoint commit, its `parent_run` the checkpointing run, and its own, new workspace is a detached worktree at that commit and holds what was checkpointed. When that run completes without asking for a checkpoint, its commit's parent is the checkpoint commit and the integration branch moves to it (section 30), so the checkpoint is then an ancestor of the integration branch.

The validation of a later snapshot compares against the base of the run that made it. A checkpoint that fails validation is a failed run like any other.

## 30. Integration, and the branch checked out elsewhere

**The ordinary course** (D1 §7.5). After the commit the work item is `integrating`. The engine journals the ref update (kind `ref_update`, operation kind `git_ref_update`; `payload.ref` the integration branch's full name, `payload.old_oid` the commit the branch is at, `payload.new_oid` the commit, `payload.run` the run) and moves the branch by compare-and-swap. The commit the branch is at is the run's base; for a run that continues from a checkpoint it is the commit the checkpointed work started from, of which the new commit is a descendant through the checkpoint. The finalizer advances the registry's expected commit to the new one and moves the work item to `integrated` (`work.integrated`). The run ends `completed`. No checkout is touched: the engine's workspaces stay where they are, and a developer's worktree on another branch or detached keeps its HEAD, its index and its files. Nothing is reported out of band: the move is the engine's own.

What a moved integration branch behind the base does (rebase and re-validation), and what a failed compare-and-swap does, are row M28's.

**The branch is engine-owned** (correction 6; RN R5). If the integration branch is checked out in any worktree the engine does not own, an integration is refused before the ref moves. The engine owns the workspaces it created under `$SURETY_HOME/workspaces/`; it never checks the integration branch out in one. Every other worktree of the repository, its own work tree included, is the developer's. The check is made when the integration is reached and again immediately before the compare-and-swap, so a checkout made in between is found.

A refused integration:

- leaves the branch where it was, and leaves the checkout exactly as it was: its HEAD, its index, its tracked and untracked files, a dirty one's edits included. No checkout-updating protocol exists;
- ends the run `failed` / `integration_conflict` (the run's `code` is `integration_conflict`), with a `reason_text` that names the worktree's path;
- parks the work item with a `blocker` whose reason is `integration_branch_checked_out` and whose `question` names the worktree's path and says how to free the branch: switch that worktree to another branch, or detach it;
- if the ref update had been journaled before the checkout was found (the second check), leaves that operation `failed`, its journal `intended` then `failed`, and never applied.

When the developer has switched or detached the worktree, the blocker's `retry` returns the item to `eligible` (section 17); its next run integrates in the ordinary course.

## 31. Engine git: one repository, no ambient influence, no repository code

**One resolved target** (D1 §§7.1, 7.2; D1-07). Every git command the engine spawns names its repository and work tree explicitly and gets a constructed environment. Nothing in the environment or the working directory of the engine process selects a repository, an index, an object store, a configuration, an identity, a credential or a program for it. Row M23 starts the engine with a hostile environment (`hostileEnvironment` in `repos.mjs`: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_COUNT` with its keys and values, the author and committer variables, `GIT_EDITOR`, `EDITOR`, `VISUAL`, the pager, external-diff, ssh, askpass and proxy variables, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, and `GH_REPO`, `GH_HOST`, `GH_TOKEN`, `GITHUB_TOKEN`, `GH_EDITOR`) and with its working directory inside a third repository, and runs work in two projects. Each project's commits, refs and worktrees are in its own repository and nowhere else; the third repository is exactly as it was; no program an ambient variable names was run; no commit carries an ambient identity. This is the one place where the tests start the engine with more than section 1's five variables and with another working directory (`scriptedEngine(t, {env, cwd})`).

**No code from the repository** (E25 item 3; E27 item 4; E29 item 1). Section 16 pinned this for the workspace's creation. It holds for every git call: workspace creation, snapshot, commit, ref update, integrity reads, worktree removal. Pinned in slice 3, each with a fixture that first shows git running the program the ordinary way:

- *hooks*: none of git's hooks runs, from the repository's hooks directory or from a directory its configuration names;
- *the file-system monitor*: the program named as `core.fsmonitor` does not run, on a snapshot's `git add` as on a checkout;
- *filter drivers*: a `filter.<name>.clean`, `.smudge` or `.process` program named in the repository's own configuration does not run, on workspace creation (where git would smudge), on a snapshot (where it would clean) or on a commit. **A repository that needs such a filter, any repository using Git LFS among them, is not supported in M1**: the engine checks out and snapshots its files unfiltered. Supporting it is a later decision that belongs with the isolation design (E29 item 1);
- *filter drivers, however the configuration spells them* (the slice-3 review; `M23-filter-driver-however-spelled.test.mjs`, listed under slice 4). The rule is about what git honours, not about what the engine can parse. A driver is not run whatever form the repository's configuration gives it: an old-style dotted section whose name is not all lower case (`[filter.EVIL]`, which git reads as `filter.evil`, while a `-c filter.EVIL.clean=` override names another key); a second section header on the same line as another (`[core] [filter "evil"]`); an include written on one line (`[include] path = other.cfg`) with the driver defined only in the included file; an included file reached through a symbolic link. An engine that finds the filter names by reading the config file itself, and switches each off by name, runs every driver it did not find. How the engine makes git run none is its own choice; the four cases pin only that none runs and that the files are committed unfiltered;
- *other configured programs*: an external diff program (`diff.external`), a diff driver's `command` and `textconv`, a signing program (`gpg.program`, with `commit.gpgsign` set), an editor and a pager do not run.

Not reachable from any git call M1 makes, and so not pinned: `core.sshCommand`, credential helpers and `core.askPass` (M1 has no remote operation), merge drivers (no merge; a rebase is row M28's).

## 32. The ref registry and repository integrity

**Registered refs** (D1 §7.2). `ref_registry` holds, per project, the refs the engine tracks: `ref` is the full ref name, `kind` a `RefKind`, `expected_oid` the commit the engine last put there or adopted, `immutable` 0 or 1. The integration branch (`refs/heads/<name>`, kind `integration`) is registered when the project is created or installed. Engine refs live under `refs/surety/`: `keep` refs (`refs/surety/keep/<n>`) and `oob` refs (`refs/surety/oob/<n>`) are registered when the engine creates them; nomination refs (`refs/surety/cand/<seq>`) are row M27's. Every other ref is the developer's: it is no gate input, it is never reset or adopted, and whatever happens to it (created, moved, deleted) has no effect and produces no observation.

**Managed checkouts.** `managed_checkouts` holds the developer's checkout of the integration branch, if any (`kind` `integration_worktree`, `path`, `owner_run` null), and every run workspace (`kind` `run_workspace`, `owner_run` the run), each with its `baseline`: a JSON object `{"head", "index_hash", "tracked_tree_hash"}`. A checkout of the integration branch that the developer makes later becomes a managed checkout when integrity first sees it, with what it then holds as its baseline. A developer who switches such a checkout to another branch, or detaches it, with nothing else changed, has done what the engine asks for when it refuses an integration (section 30): the checkout is then no longer a managed checkout, and that is no observation.

**When integrity runs.** At startup, in the `integrity` step, for every registered project, before full mode; and at every tick, as prerequisite step 3, before any dispatch or integration of that project (D1 §§1.4, 7.6, 8.1). The `tick_step` fault of section 18 accepts `"step": "integrity"`; a step that overruns `tick_step_budget` suppresses that project for the tick like the other prerequisites.

**What it observes.** Each observation is an `out_of_band_changes` row, with `repo.out_of_band` emitted and an `out_of_band_change` decision raised (`subject_type` `out_of_band_change`, `subject_id` the row's id; the row's `decision` names it). An observation that is already recorded and unreconciled is not recorded again.

| Subject (`subject_kind`) | Observed when | `expected`, `found` | Options offered |
|---|---|---|---|
| `ref` | a registered ref has a commit that is neither its expected one nor one the engine's own journal is moving it to; or it is gone | the expected commit id; the commit id found, or null if the ref is gone | `discard` and `adopt` for a ref that moved; `discard`, and never `stash`, for one that is gone |
| `checkout` | a managed checkout that is not an active run's workspace differs from its baseline: tracked files edited, staged or not, or another HEAD | JSON objects with the baseline's three keys | `stash` and `adopt`; never `discard` |
| `repository` | the repository cannot be read | `found` is null | none: the decision's `options` is `[]` |

A run workspace owned by a run that has not ended is never observed here: its content is the validator's (section 28). The engine's own journaled writes are never observed: after an integration, a commit, a policy change, a bootstrap, a `discard` or a `stash`, however many ticks and restarts follow.

**Nothing is absorbed, nothing is undone.** An observation changes no expected value and no baseline, and the engine resets nothing by itself: the moved ref stays where the developer put it, the edited file keeps the developer's edit, until a person answers the decision. Unknown is not clean: an unreadable repository leaves every expected commit and baseline as it was.

**What is blocked.** While a project has an unreconciled observation on its integration branch or on its repository, nothing of that project is dispatched and nothing is integrated; other projects go on. A command that needs the repository (a policy change) is refused **409** `out_of_band_change`, or **409** `repo_unreadable` for an unreadable repository. A project is not dispatched in the tick that makes the observation either. Whether an observation on a `keep` or `oob` ref, or on a checkout, blocks dispatch is not pinned; that such observations block the gates they affect is slice 5's.

**Answers** (D1 §7.6; D1-11). Slice 3 pins the two answers for a moved ref; the decision's dependency manifest, with its fresh comparison before the effect, is row M46's (slice 5), and so are the checkout's answers.

- `discard`: the engine journals a compare-and-swap that puts the ref back on its expected commit (kind `ref_update`), keeps the commit that was found under a new, registered `refs/surety/oob/<n>` ref, records `disposition` `discard`, consumes the decision and emits `repo.reconciled`. For a ref that was gone it recreates the ref on its expected commit and keeps nothing.
- `adopt`: the expected commit becomes the commit found; a `revisions` row of kind `out_of_band` records that commit; `disposition` is `adopt`; the decision is consumed and `repo.reconciled` emitted.

After either, the next integrity observation finds nothing, and the project is dispatched again, from the expected commit after `discard` and from the adopted one after `adopt`.

**An unreadable repository becoming readable.** At the next tick the engine observes the repository afresh, before anything of the project is dispatched: every registered ref and managed checkout is read again. If all is as expected the repository observation is closed (its decision becomes `invalidated`, `repo.reconciled` is emitted) and dispatch resumes. If a ref moved while the repository could not be read, that is observed in the same step, and the project stays blocked.

## 33. The journal: operations, barriers, and what the tests read

**Operations.** Every repository mutation is an `operations` row with its journal (D1 §§2.5, 3.5, 6.3): `kind` is `git_ref_update`, `git_commit` or `git_worktree`; its `git_journal_events` carry `journal_kind` (`ref_update`, `commit_tree`, `worktree_add`, `worktree_remove`), `event_kind` and a `payload` with `repo` and, as section 28 and 30 say, `ref`, `tree`, `old_oid`, `new_oid`, `run`. An operation that runs its ordinary course has the events `intended`, `applied`, `confirmed`, `finalized`, in that order, `status` `succeeded` and `finalized_at` set. The tests read operations through `journal.mjs` (`operationsOf`), by run and by journal kind, and take an operation's state from its last event; the `git_journal_state` projection (A.3) is read by the second session, with the row M04 case about it. Attempts (`operation_attempts`), the probes and the statuses of an operation that did not run its ordinary course are the second session's, with two exceptions this session pins: a ref update refused before its effect is `failed` with the journal `intended`, `failed` (section 30), and a git call killed at its deadline leaves its journal with an `ambiguous` event (section 34).

**Barriers at the journal's boundaries** (build spec §8; Plan §2). One barrier per journal kind and boundary, named `journal.<kind>.<boundary>`: twenty names, `journal.ref_update.intent_committed` to `journal.worktree_remove.finalizer_committed`. `../contract/journal.json` says what is durable at each boundary:

| Boundary | Fires |
|---|---|
| `intent_committed` | after the transaction that records the operation and its `intended` event, before the effect is attempted |
| `effect_applied` | after the git effect has been applied, before any event records it |
| `receipt_committed` | after the `applied` event is durable, before the probe confirms it |
| `probe_confirmed` | after the `confirmed` event is durable, before the finalizer runs |
| `finalizer_committed` | after the finalizer's transaction: `finalized`, `finalized_at` and the domain receipts |

As in section 18, a barrier is defined by what is durable when it fires: where the engine commits two of these facts together, the two barriers fire one after the other with the same store. A barrier fires once, the first time an operation of its kind reaches its boundary after it was armed, whichever operation that is; `pause` and `kill` are as before. This session uses `journal.ref_update.intent_committed` (row M22); the second session uses all twenty for rows M29 to M33.

**Arming a barrier while the engine runs.** `POST /v1/harness/barriers` with `{"name", "action"}` arms a barrier, or arms it again after it fired or was released: **2xx**; an unknown name or action is **400** `invalid_value`. So a test can let earlier operations of a kind pass and stop the next one. `--harness-barrier` at startup is unchanged.

## 34. Git deadlines, and integrity as a prerequisite step

**A git call past its deadline** (D1 §§7.1, 8.5; E7 §3.9.5; row M15). Every git command has a deadline, `git_deadline` seconds (`git_deadline_long` for clone and fetch, which M1 does not make). When it passes the engine kills the child. A deadline on a read fails the read. A deadline on a command that could have written marks its operation ambiguous: the journal gets an `ambiguous` event (`operation.ambiguous`, `git.journal_ambiguous`), the operation is not `succeeded`, and what depends on it does not go on: a workspace whose `worktree add` was killed gets no role launched in it on the strength of a timer. The tests hold a repository's git calls open by putting a named pipe where its configuration file is (`holdGit` in `repos.mjs`), stop the dispatch before its `worktree add` with the barrier `dispatch.receipt_committed`, and set `git_deadline` to two seconds. They find the held command among the processes whose command is `git` and whose arguments name the engine home (the workspace's path), and require it gone a few seconds after the deadline. While the call is held and after it was killed, the API answers and another project is dispatched. How the ambiguous operation is then reconciled, and what its run ends as, is the second session's (rows M31, M34).

**Integrity as the overrunning step.** With the `tick_step` fault on `integrity`, a project whose integrity step overruns `tick_step_budget` is not dispatched in that tick, also when the step completes later; the other project is dispatched in the same tick; the next tick dispatches it.

## 35. Store rows the slice-3 tests read

Names are D1 A.3's (sections 8 and 19 apply). The tests read, and so the schema must have, with their A.3 columns and a `project` column: `revisions`, `ref_registry`, `managed_checkouts`, `out_of_band_changes`, `policy_revisions`; and the columns `projects.registration_state`, `projects.policy_revision`, `workspaces.snapshot_tree`, `workspaces.current_base`, `workspaces.checkpoints` (a JSON array of revision ids), `runs.reason_text`, `work_items.progress_key` and `work_items.no_progress_count`. `revisions.lineage` is A.3's and is not read by this session. JSON-typed columns hold JSON text.

**Where a workspace is.** A run's workspace is at `$SURETY_HOME/workspaces/<run id>` (section 16 said "a directory under `$SURETY_HOME/workspaces/`"; the run id as its name is now fixed, because a test has to be able to occupy the path before the engine does). If that path already exists when the engine comes to create the workspace, whatever is there is not the engine's: a symbolic link in particular, to another run's worktree or to anything else, is refused. The `worktree_add` operation does not succeed, no `workspaces` row is written for the run, the role is not launched there, the run ends `failed` / `infra_error`, and what the link points to is untouched: still registered as the other run's worktree, its files as they were. The engine does not judge a worktree present at a path by resolving a link it did not create.

## 36. Names the Verifier fixed in slice 3, first session

Each of these was open in the sources. The Builder may object. Those marked † carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| The reason class of a validation failure † | In the diff: `diff_violation`. Outside it: `ref_violation`. | D1 names two classes and gives one example of each (D1-10; §7.3 step 4). One rule that a reader can apply beats a list. |
| What a Builder and an Architect may change † | Builder: nothing under `.surety/`. Architect: only `.surety/adrs/`, `architecture/`, `roadmap/`, `phases/`. | F §4.1's "may not" columns, and D1 §5.1's list of what lives under `.surety/`. |
| Verifier's and Reviewer's writes † | Not pinned before slice 5. | Row M36 owns the Verifier's diffs; four slice-2 cases would otherwise have to change now. |
| "Git metadata" for correction 15 | The repository's configuration, its hooks directory, the workspace's `.git` file. | What a role can use to make the engine's git run something (E25 item 3), and the link that says whose worktree this is. |
| A run that cannot be shown empty before its snapshot † | Quarantined with `failed` / `infra_error`; never snapshotted. | D1 sets the outcome on entering `finalizing` and quarantine is in `finalizing`; `completed` would claim a validation that did not happen. |
| The snapshot tree | `git add -A` in an index started from `current_base`. | D1 §7.3. Starting from the base keeps tracked files that an ignore rule would otherwise drop. |
| Commit trailers | The five of D1 §7.4, with ids and names as values, each once. | D1 names the trailers and not their values. |
| A checkpointing run's work | Back to `eligible`; the next run's base is the checkpoint, its `parent_run` the checkpointing run; no repair charged. | D1 §7.4: "continues with a new run from that checkpoint". |
| An integration refused for a checked-out branch † | Run `failed` / `integration_conflict`; work `parked`, blocker reason `integration_branch_checked_out`; `retry` after the branch is freed. | D1 §7.5 treats a failed compare-and-swap this way; A.2 has no closer reason class and adding one is a design change. |
| Bootstrap refused for a checked-out branch | **409** `integration_conflict`, nothing created. | Correction 6: refused before the ref moves; a project that could never finish its bootstrap should not exist. |
| `POST /v1/projects` | Body, statuses and codes of section 27; `.surety/project.json` has `id`. | D1 §11.4 names the route only. |
| A valid policy change | **200**; `.surety/policy.json`; a `policy_revisions` row; the file written from recorded policy plus the change. | D1 §11.4; E23 item 3. |
| Ref names | `ref_registry.ref` is the full name; engine refs under `refs/surety/`. | D1 §7.2 writes `surety/keep/<n>`; the full name is unambiguous. |
| Out-of-band rows | `expected` and `found` as section 32's table; `options` `[]` for a repository. | D1 §7.6 gives the dispositions; "repository → none". |
| What an unreconciled observation blocks in slice 3 | Dispatch and integration of that project, for its integration branch and its repository; commands that need the repository. | D1 §7.2: a context whose registered refs do not match cannot be resolved; §11.5 names the codes. |
| Journal barrier names; runtime arming | `journal.<kind>.<boundary>`; `POST /v1/harness/barriers`. | Build spec §8; one naming for all four kinds so the second session adds none. |
| `tick_step` fault on `integrity` | The existing fault, one more step name. | D1 §8.1 step 3. |
| The workspace path | `$SURETY_HOME/workspaces/<run id>`; an existing path, a link included, is refused. | The second slice-2 review's finding (E27); the slice-2 engine already uses this path. |
| The progress key in slice 3 | Over the snapshot tree of a run that failed validation; `no_progress_max` as a park reason. | D1 §4.3. |
| Snapshot at recovery † | `snapshot_tree` is recorded by the recovery of a run killed after a normal result; nothing else. | D1-32: "snapshot and receipts recovered". |
| Filter drivers | Not run; LFS repositories unsupported in M1. | E29 item 1. |

## 37. What is left for the second slice-3 session

Rows M26 to M34 and these cases of earlier rows, none of which this session wrote: the plan and stage finalizers and what follows `integrated` (M26, and the rest of M09's integrating paths); nomination and the `nominate` result field (M27); a moved integration branch, rebase and re-validation, and a failed compare-and-swap (M28); the four probes with five outcomes each, among them the worktree-add probe's "foreign or conflicting occupancy" beyond the symbolic link pinned here (M29 to M32); crashes at the twenty journal barriers and at the finalizer (M33); operation attempts (M34); the chain of roles and `max_chained_roles` (M12; E24 item 1); Stop and Abandon from `integrating`, `integrated` and `verifying` and with a journal operation in flight (M13, M14); the journal state projection changing only with a journal event (M04); a registered nomination ref moved or deleted (M24); the two recovery obligations of the slice-2 review (an ambiguous worktree removal followed by a crash; a git child that outlives a killed engine).

What this session fixed and that session builds on, without renaming: the barrier names and their runtime arming (section 33); `operationsOf` and the journal reads of `journal.mjs`, which return every event with its payload and are indifferent to the journal kind; `../contract/journal.json`, to which the journal's transition table with corrections 14 and 16 and the probe outcomes are added; the role program's steps; `repos.mjs`. The tests of this session assert an operation's ordinary course and two failures (sections 30, 34) and nothing else about attempts or probes, so that session is free to fix those. One thing to keep in view: this session's cases never let two operations of one journal kind race for a barrier; where that session needs the second operation of a kind, runtime arming is how.

**Done.** The second session wrote all of it: sections 39 to 51.

## 38. What stands behind these tests before the engine exists

As in section 21. The helpers with logic are run against real repositories and witness stores (`selfcheck/slice3.mjs`); every test file of this session is run against the witness engine, which was extended to do what sections 25 to 35 ask, as plainly as it can (`selfcheck/witness-git.mjs` holds its git side, `selfcheck/witness-slice3.sql` its tables), and passes there; and for every case the witness has a defect that makes that case fail (`selfcheck/witness.mjs`). The witness engine is still not the engine and not a design for it: its journal is rows written around synchronous git calls, it recovers nothing it journaled, and its integrity is a handful of comparisons. The part-1 cases were run against the slice-2 engine (section 24). Of the 84 cases of sections 25 to 35, 83 fail there at their first slice-3 step, which shows nothing about them; one passes, the git call killed at its deadline (section 34), which the slice-2 engine already does for the one git effect it has.

## 39. What the second slice-3 session's tests assume throughout

Sections 39 to 51 are the second of slice 3's two Verifier sessions: rows M26 to M34 and the slice-3 cases of rows M04, M09, M12 to M15 and M24 that pass through an integration. Nothing of sections 25 to 38 is renamed; where a sentence there said "the second session's", the answer is here.

- **Every journaled operation has attempts and a state projection.** From this session on the tests read `operation_attempts` and `git_journal_state` for every operation they look at (section 44), including those of the first session's scenarios when they recur here. The first session's own files still read only `operationsOf`.
- **The journal's contract is a table.** `../contract/journal.json` holds the transition table, what is durable at each boundary, the five probe outcomes per kind with what each leads to, the attempt statuses with the derivation of an operation's status, and the receipts of each finalizer. The probe cases (rows M29 to M32), the crash cases (M33) and the status checks (M34) are generated from it or compared with it. No test asks the engine what a probe outcome leads to.
- **Recovery is two things, and both do the same.** The startup `recovery` step visits every operation that is not finalized before the engine reaches full mode. The journal step of a tick visits every operation that is still not finalized: one that was blocked, or one a git deadline left ambiguous while the engine ran. What an operation is found as decides what happens to it, not which of the two found it (section 45).
- **The chain boundary is on.** With the default `max_chained_roles` of 1, work that a run's outcome created waits for a person (section 40). A test that needs such work to run answers the boundary's decision with `continue` first, as a person would.
- **Nothing here asserts a gate.** M1 computes the `stage` and `alpha_authorize` gates in slice 5. A nomination produces a candidate and its verification work; a completed verification completes the work the candidate holds. Slice 5 puts the gate between the two (section 40; `../COVERAGE.md`).
- **Clocks.** No case of this session moves the controlled clock. The deadline cases wait for a real `git_deadline` of two or six seconds with margins that a step of the host's clock cannot use up, and compare no engine timestamp with a clock. The host's step back had grown when this session ended: measured on 2026-10-02 at 1.7 to 1.8 s every 30.5 s (section 23 measured about 0.75 s the day before). The two-second slack of section 23 still covers it, without much to spare. One slice-2 case did not: `M15-deadlines.test.mjs`, "a tick that has used up its budget dispatches nothing more", put a tick one second over `tick_budget`, and an engine that times its tick by the wall clock sees such a tick as within budget when a step of more than a second falls inside it (the self-check showed it against the witness). Its two delays are now four seconds each, three seconds over the budget. Nothing else about the case changed.

## 40. What follows `integrated`, and the chain of roles

**The Architect's kinds** (`replan`, `assessment`). The work is `complete` once its commit is integrated: the integration's finalizer moves it `integrating → integrated → complete`, and for a commit that holds a phase plan the plan is registered in the same finalizer (section 41). No candidate is involved.

**The Builder's kinds** (`stage_build`, `fix`). The work stays `integrated` until a candidate that holds it is nominated: the nomination's finalizer moves every `stage_build` and `fix` item of the project that is `integrated` at that moment to `verifying` (section 42). It becomes `complete` when that candidate's `verification` work item becomes `complete`, in that item's completing transaction or with it. A verification run that fails completes nothing: the Builder's work is still `verifying` when the failed run has ended and its repair has begun, and is complete only when a verification run of that candidate completes. Work integrated after a nomination is not held by that candidate: it stays `integrated` when the candidate is verified, and waits for the next nomination. A `verification` item that is cancelled leaves the work it would have verified `verifying`.

From slice 5 a stage's work is complete only when its `stage` gate is satisfied (section 70 states that rule): the paragraph above then holds for a `fix` as it stands, and for a `stage_build` item as far as `verifying`, where the completion of the candidate's `verification` item leaves it. The cases changed with the gate (`../COVERAGE.md`): where they asserted a stage's work `complete` they now assert `verifying`.

**A chain of roles** (D1 §8.1 step 8; D1-34; E24 item 1). A run is chained when it is dispatched for work that a previous run's outcome created. In slice 3 two outcomes create work: a nomination that follows a Builder's run creates the candidate's `verification` item, and the integration of a committed plan creates its stages' `stage_build` items. Work created by a fixture or a person, the repair of a failed run and a Resume are not chained. `max_chained_roles` counts the roles of a chain, the first included; a run that is not chained starts a chain of one.

With the default, 1, chained work is not dispatched without a human step. The scheduler leaves it `eligible` (it is not parked) and, the first time it would have dispatched it, raises one decision on it: `kind` `blocker`, `subject_type` `work_item`, `subject_id` the item, `options` with the keys `continue` and `cancel`, and `blocked_while_open.work_items` containing the item. The work item's `blocker` is set to `{"reason": "max_chained_roles", "raised_at", "decision"}`. The decision is raised once: further ticks and a restart raise no second one. Other work of the project and of other projects is dispatched meanwhile. `continue` closes the decision and clears the blocker; the answer launches nothing by itself, and the scheduler then dispatches the item once, as any eligible work. `cancel` cancels the item without a launch.

What a limit above 1 does is not pinned in slice 3: raising `max_chained_roles` widens what the engine may do unasked and takes the `policy_widening` route (row M49, slice 5).

## 41. Plans, and the finalizer of an integration

**A phase plan** is a file the Architect commits: `.surety/phases/phase-<n>.json`, a JSON object `{"phase": <n>, "stages": [{"number": <int>, "goal": <string>}, ...]}`. Later slices add keys to a stage (modules, requirements); they do not rename these.

**Validation.** A plan file in a run's diff that could not be registered rejects the whole result, like any other violation in the diff: the run ends `failed` / `diff_violation`, `reason_text` names the plan's path, and nothing of the run is accepted (section 28). The tests pin two causes: the file is not JSON; a stage has no goal. What else makes a plan unregistrable (no stage, a stage number twice, a `phase` that is not the `<n>` of the file's name) is the engine's to refuse the same way and is not pinned. So a committed plan is registrable by construction (D1 §7.8).

**The integration finalizer** (D1 §§7.7 to 7.10; correction 14). The finalizer of an integration's ref update writes, in one transaction with the journal's `finalized` event:

- the registry's expected commit for the integration branch, and the work item `integrated` (as in section 30);
- for the work of a stage (`subject.stage`): that stage's `status` `integrated` and its `integrated_revision`, the commit's id;
- for a commit that adds a phase plan file (a commit that changes an existing one is not pinned): one `phase_plans` row (`phase_number`, `git_path` the file's path), one `stages` row per stage of the file (`number`, `goal`, `status` `planned`, `integrated_revision` null), and for each stage one `stage_build` work item, `eligible`, with `subject.stage` the stage, trigger `("plan", <stage id>, 1)`, and `stages.work_item` set. Their `work.created` events do not carry `test_fixture`. The plan's stages do not depend on one another in slice 3;
- for the Architect's kinds: the work item `complete`.

**Its inputs are fixed with the intent.** Everything the finalizer writes is determined when the intent is committed, before the effect: the plan's stages are those of the plan file in the commit being integrated, and the stage a run finalizes is the one its work item names. A finalizer that runs later, after a delay or after a crash, writes exactly that: it does not read a newer plan in the store, a stage with the same number in another plan, or the plan file in the role's workspace. The tests stop the engine between the effect and the finalizer (`journal.ref_update.receipt_committed`, or a kill at `journal.ref_update.probe_confirmed`), install a newer plan with `POST /v1/harness/fixtures/plan` or rewrite the workspace's plan file, and let the finalizer run or recovery run it.

**Repeating a finalizer** returns the receipts it wrote: a second restart and further ticks add no plan, stage, work item, candidate, revision, registry row or workspace row and change none of their ids (`receiptSnapshot` in `journal.mjs` compares them all by identity). A committed plan always has its owner: after a crash between confirmation and finalizer, recovery registers it and the `replan` work is `complete`, not `held` beside a plan nobody registered.

## 42. Nomination

**What a nomination is** (D1 §§3.3, 7.2, 7.7; E11; E18). The engine nominates the commit the integration branch is at. A nomination is a journaled ref update that creates `refs/surety/cand/<seq>` at that commit: `payload.ref` the ref, `payload.old_oid` null or absent, `payload.new_oid` the commit, and no `payload.run`: a nomination is the engine's act, not a run's. `<seq>` is the candidate's sequence number in its project, from 1. Its finalizer writes, in one transaction with `finalized`:

- the `candidates` row: `seq`, `revision` the commit's id, `lineage` the lineage that was open, `nominated_by`, `progress` `developing`;
- the ref in the registry: `kind` `nomination`, `expected_oid` the commit, `immutable` 1;
- that lineage closed (`open` 0) and one successor opened, with `started_from_candidate` the new candidate;
- one `verification` work item, `eligible`, `subject.candidate` the candidate, trigger `("nomination", <candidate id>, 1)`;
- every `stage_build` and `fix` item that is `integrated` on the lineage just closed moved to `verifying`.

The revision row of the nominated commit keeps the `kind` it was recorded with (`engine_commit`). `revisions.lineage` is the lineage that was open when the revision was recorded, so a commit integrated after a nomination is on the successor.

**Lineages.** A registered project has exactly one open lineage for its integration branch, with `started_from_candidate` null for the first. The tests read it in projects the fixture installer made, which therefore creates it; a project created through the API needs one as soon as anything is recorded on a lineage.

**Cadence** (F §5.6; E11). For tier T2 (and T3, by the same rule; the tests use T2) the engine nominates when a `stage_build` item's integration is finalized: `nominated_by` `engine_cadence`. For T1 it nominates only when a Builder's result carried `nominate: true` and that run's work was integrated: `nominated_by` `builder_request`. A T2 Builder's `nominate: true` outside the cadence point (the tests use a `fix` item) is not a nomination and is not an error: the run integrates as usual and no candidate, ref or nomination operation exists. A checkpoint is never a candidate, whatever its result asked for. A `nominate` that is not a JSON boolean is `invalid_result` (section 26). T1's nomination at phase completion is not pinned: M1 has no phase verification.

**When.** The nomination follows the integration without a person: by the time the integrating run has ended, or within the next ticks (the tests tick until the candidate exists). It happens once: ticks and restarts nominate nothing again, and the engine's own nomination ref is never observed out of band. If the engine dies after a T2 stage was integrated and before its nomination was journaled, the stage is nominated after the restart, once. If it dies after the nomination's ref update was confirmed and before its finalizer, the startup recovery step runs the finalizer: the candidate exists before full mode, with no tick (D1-18).

**A candidate is immutable.** A later integration and a later nomination leave an earlier candidate's row, its ref and its closed lineage as they were; the next candidate's lineage is the successor the earlier nomination opened.

**A nomination ref changed by someone else** (row M24). It is observed as in section 32, once, with `expected` the nominated commit and `found` the commit it was moved to (null if deleted), and never absorbed. Because the ref is immutable the decision offers `discard` only, never `adopt`. `discard` puts the ref back on the nominated commit through the journal, keeps a commit it had been moved to under a registered `oob` ref, and is not observed in turn. The candidate row is untouched throughout. Whether such an observation blocks dispatch of its project is not pinned; that it blocks the candidate's gates is slice 5's.

## 43. An integration branch that moved: rebase, conflict, compare-and-swap

(D1 §§7.3, 7.5; D1-19; row M28.) Section 30's integration assumed the branch was still at the run's base. When the registry's expected commit for the branch is no longer the run's base, because the engine committed a policy change or a person adopted an out-of-band commit, the engine rebases the run's changes onto that head:

- **A clean rebase.** The rebased tree is the head's tree with the run's changes applied; it is validated like a snapshot (section 28), committed through the journal as a `commit_tree` operation whose `payload.old_oid` is the head and whose `payload.tree` is the rebased tree, and that commit is the one integrated: its only parent is the head, its `Surety-Base` trailer names the head, the run's `revisions` row for it has `kind` `engine_commit` and `parent_sha` the head, and the ref update's `payload.old_oid` is the head. The run ends `completed`. That validation is run again on the rebased tree is pinned by this result only; no case makes a rebased tree fail validation.
- **A conflict.** If the run's changes do not apply (the tests: both sides changed one file), nothing is integrated: the run ends `failed` / `integration_conflict` with a `reason_text`, the public code `integration_conflict`, no ref update of the run `succeeded`, the branch and the registry where they were; the work is `parked` with `blocker.reason` `integration_conflict` and an open `blocker` decision that names it. No role is launched and no work is created to resolve it. `retry` on the blocker lets the work run again; its new run starts from the head.
- **A compare-and-swap that fails.** If the branch moves behind the engine's back between the journaled intent and the swap, the swap fails: the unexpected head is not overwritten, the operation's journal is `intended`, `failed`, its attempt `failed`, its status `failed`; the registry still expects the commit it expected, so that integrity observes the move as an out-of-band change (section 32); the run and the work end as for a conflict.
- **No repository code.** The rebase is a merge, and it runs no merge driver the repository's configuration or attributes name (E25 item 3; like filter drivers, E29 item 1). What the engine makes of two changes to one file is its own: the tests accept a clean merge or a conflict, and require only that the planted program did not run.

## 44. Operations, attempts, and the journal's states

**The journal's transition table** (D1 A.5 with correction 14; `../contract/journal.json` `transitions`). `intended → applied | failed | ambiguous`; `applied → confirmed | ambiguous`; `confirmed → finalized`; `ambiguous → applied | failed`. `finalized` and `failed` are terminal; no state follows itself. An operation's journal events are numbered from 1 without a gap, start with `intended`, all carry its journal kind, and form a path through that table. A blocked operation gets no further journal event while it is blocked: it stays at `ambiguous`.

**The state projection** (D1 §3.5; row M04). `git_journal_state` holds exactly one row per operation: `journal_kind`, `state` the kind of the operation's last journal event, `last_event_seq` that event's number. It moves only in the transaction that appends a journal event. A transaction that fails takes its journal event and its projection change with it: the tests arm `{"point": "before_event", "event_type": "git.journal_<kind>"}` (section 18) and require each event of the ordinary course exactly once afterwards, with the projection at the last. The store refuses a second journal event with a sequence number already used.

**The event log.** Each journal event except `failed` is written with exactly one `git.journal_<event kind>` event whose `subject.operation` is the operation, in the journal's order (D1 A.6 has no `git.journal_failed`).

**Attempts** (D1 §2.5; correction 16; `contract` `attempts`). Each execution of an operation's effect is an `operation_attempts` row: `operation`, `attempt_number` from 1 without a gap, `status`, `started_at`, `finished_at`, `reconciliation_reads` (a JSON array; each entry has `result`, the probe outcome that read found: `absent`, `applied`, `partial`, `conflicting` or `unknown`), and a `project` column. The store refuses a second attempt with a number already used.

- The operation is committed before its first attempt is issued. At `intent_committed` an operation has no attempt (status `intended`) or its first, `started` (status `in_progress`).
- An attempt becomes `succeeded` when the probe confirms its effect (the journal's `confirmed`), not when the command returns. `finished_at` is then set.
- An attempt whose effect was refused or failed before anything was applied is `failed`. An attempt whose command was killed at its deadline is `ambiguous`.
- Reconciliation changes the status of the attempt that was in flight: `reconciled_succeeded` (the effect was found applied), `reconciled_absent`, `reconciled_partial`; its last `reconciliation_reads` entry names the outcome. An attempt that could not be reconciled is `ambiguous`.
- A further attempt is admitted only after the previous one is `reconciled_absent`, or `reconciled_partial` with `operations.remaining_scope` set to a non-empty object that says what remains. Never after `failed`, `ambiguous`, `started` or a success. It is a new attempt of the same operation: same id, same `idempotency_key`.

**An operation's status** is derived (contract `attempts.derivation`, rules tried in order): with a linked successor and no success, `superseded`; latest attempt `succeeded` or `reconciled_succeeded`, `succeeded`; no attempt and the journal `confirmed` or `finalized` (an effect found applied before any attempt was recorded), `succeeded`; the journal `failed`, `failed`; no attempt and the journal `ambiguous`, `ambiguous`; no attempt, `intended`; latest `started`, `in_progress`; `failed`, `failed`; `ambiguous`, `ambiguous`; `reconciled_partial`, `partial`; `reconciled_absent`, `intended`: the interval before an allowed retry, in which the effect is positively absent and nothing is in flight. `finalized_at` is set exactly when the journal is `finalized`, and a finalized operation is `succeeded`. Only a succeeded, finalized operation completes what depends on it.

**A failed operation is not retried** by a tick or a restart: failed is not proven absent. When a new operation is recorded to do what a failed one was to do (the tests: the integration of the same work item into the same ref, by a later run), it names the failed one in `linked_prior`, and the failed one's status becomes `superseded`; it is never finalized.

`assertOperation` in `journal.mjs` checks all of this section for one operation, and `assertOperations` for every operation of a project; most cases of this session end with it.

## 45. Journal recovery: the five probe outcomes

(Build spec §6 corrections 14 and 16; Review B05, B17; D1 §§7.10, 16; rows M29 to M34.) Recovery visits every operation that is not finalized. An operation whose journal is `confirmed` runs only its finalizer: its effect is never attempted again, and its attempts are as they were. One whose journal is `finalized` or `failed` is not touched. One whose journal is `intended`, `applied` or `ambiguous` is probed: the engine reads what git holds of the frozen intent, and the outcome decides.

| Way on | What happens | Journal, operation |
|---|---|---|
| `finalize` | The effect is there. A missing `applied` receipt is appended, the probe confirms, the finalizer runs. No new attempt: the attempt in flight becomes `reconciled_succeeded`. | `finalized`, `succeeded` |
| `retry` | The effect is positively absent. The attempt in flight becomes `reconciled_absent`; one new attempt applies the effect; then the ordinary course. | `finalized`, `succeeded` |
| `complete` | Part of the effect is there and the rest is bounded and declared (`remaining_scope`). The attempt becomes `reconciled_partial`; one new attempt completes the rest, touching only what the operation owns. | `finalized`, `succeeded` |
| `withdraw` | The effect is absent, or only owned residue of it is there, and what the operation was for is over. The attempt becomes `reconciled_absent`, or `reconciled_partial` once the residue is removed. Nothing is retried and no finalizer runs. | `failed`, `failed` |
| `block` | Nothing is retried, completed or finalized, and nothing the probe found is changed. The attempt in flight, if any, is `ambiguous`. One open `blocker` decision has the operation as its subject (`subject_type` `operation`). | `ambiguous`, `ambiguous` |

Where the engine died before it had issued the first attempt, there is none to reconcile: an effect found applied is finalized with no attempt or with one `reconciled_succeeded`; an effect to be made is made by attempt 1.

**What each outcome means for each kind, and where it leads** (`contract` `probe.kinds`):

| Kind | `absent` | `applied` | `partial` | `conflicting` | `unknown` |
|---|---|---|---|---|---|
| `ref_update` | the ref is at the intent's old commit: **retry** | at the new commit: **finalize** | cannot exist for one ref; if claimed, with no remaining effect declared: **block** | at a third commit, or gone: **block** | the ref cannot be read: **block** |
| `commit_tree` | no commit object, no keep ref: **retry** | the commit exists under its keep ref: **finalize** | the commit exists, its keep ref does not: **complete** (publish it) | the keep ref points at another commit: **block** | the object store cannot be read: **block** |
| `worktree_add` | nothing at the owned path, no metadata for it: **withdraw** | a complete worktree, detached at the base: **finalize** | owned residue (metadata without its directory; or metadata and directory with the checkout not finished): **withdraw**, residue removed | something that is not the operation's at the owned path: **block** | the worktree metadata cannot be read: **block** |
| `worktree_remove` | the worktree is still there: **retry** | nothing left: **finalize** | owned residue remains: **complete** | the worktree is gone and something foreign is at its path: **block** | the worktree metadata cannot be read: **block** |

Each row is tested from each of three durable states: the journal `intended` and `applied`, as a kill at a barrier leaves them, and `ambiguous`, as a restart that could only find `unknown` leaves it. That is fifteen separately reported cases per kind. `worktree_add` has three more, for the second form of `partial`.

**A complete worktree is a checked-out one.** `git worktree add` writes the repository's metadata and the directory's link first and checks the files out last, so a command cut short leaves a worktree that the repository lists, with its HEAD at the base, and no tracked file in it. That is `partial`, not `applied`: the engine judges a workspace complete by its checkout (every tracked file there and unmodified), not by the repository listing it. Adopted, it would be a retained workspace whose snapshot deletes every file.

**What a probe must not take for absence.** `git worktree list` leaves out, without an error, the worktrees whose metadata it cannot read; a ref that cannot be read is not a ref that does not exist; an object that cannot be read is not an object that was never written. An engine that asks only the command sees `absent` in all three and retries. The `unknown` fixtures are these: the repository, its object store or its `worktrees` directory made unreadable.

**A commit's identity is stable across a retry.** The commit an attempt of a `commit_tree` operation makes is determined by the frozen intent: when the first attempt's commit was deleted and the operation is retried, the retry's commit has the same id (the tree, parent, message, identities and dates are the intent's, not the retry's moment). When it survives, it is the one recorded: exactly one commit names the run.

**A worktree add is not retried.** A workspace is made for one run. By the time recovery looks at an unfinished `worktree_add`, that run is over: its dispatch died with the engine (the run ends `recovered`), or its command was killed at the deadline (below). So an absent or partially present workspace is withdrawn rather than made: nothing is added for a run that has ended, the owned residue is removed under owned-path checks, no `workspaces` row is written and `runs.workspace` stays null. A complete worktree is adopted, once, as the ended run's retained workspace (one `workspaces` row, one managed checkout, one worktree in the repository), and no role is launched in it.

**What the recovered run and its work end as.** The end of a run of the dead incarnation sees what the journal's recovery made of its operations (so the journal is recovered first). A run whose `worktree_add` or `commit_tree` was recovered ends `recovered` / `recovered` with its work `held`, as in slice 2; recovery integrates nothing it did not find journaled, so a recovered commit stays off the branch, reachable from its registered keep ref. A run whose integration (`ref_update`) was recovered ends `recovered` with its work `integrated`, by the finalizer, once: the work is not held, because nothing is left for a resumed run to do. A run whose `worktree_remove` was recovered ends `abandoned` / `human_abandon` with its workspace `discarded` and its work back at `eligible` under the dispatch hold. Recovery launches no replacement run, and the engine's own recovered effect is never observed out of band.

**A blocked operation.** The engine still reaches full mode. Nothing of the operation's project is dispatched while its journal has a blocked operation. The work the operation belongs to stays where it was: an integration's work item is `integrating`, neither integrated nor held; an abandoned run whose removal is blocked stays `finalizing` with outcome `abandoned`, is not ended, its workspace is not recorded `discarded` and its work is not released. No finalizer receipt is written, what the probe found is left as it was (the unexpected head is not overwritten, the registry goes on expecting what it expected, a foreign directory keeps its content), and further ticks add no journal event, attempt or blocker. The journal step of every tick probes the operation again. When the probe then finds another outcome, that outcome's way on is taken and the blocker is closed (any status but `open`). The tests unblock the way an operator would: they restore readability; discard the out-of-band observation of the moved branch; delete a keep ref that points elsewhere; remove a foreign directory; or, for a claimed partial result, restart the engine without the claim.

**`--harness-probe <kind>=<outcome>`** (harness mode only). While an engine started with it runs, every probe of that journal kind reports that outcome, whatever git holds. The tests use it for one thing: `ref_update=partial`, the claimed partial result of a single-ref swap, which git cannot be made to hold. Like the other harness flags it is refused without `--harness` (section 1); a kind or outcome the contract table does not name is a usage error, which no test pins.

**The barrier `journal.<kind>.reconciled`** (contract `recovery_boundaries`) fires after the transaction that records what the probe found (the attempt `reconciled_*`, or the block) and before anything that follows from it: no new attempt issued, no receipt appended, no finalizer run. Armed with `=pause` at startup it lets a test read the interval before an allowed retry (row M34): the operation `intended` after `reconciled_absent`, `partial` with its `remaining_scope` after `reconciled_partial`. A paused startup is waited for with `barrier:journal.<kind>.reconciled` and released as any barrier.

**An operation a git deadline left ambiguous** (section 34; rows M15, M32, M34). Its attempt is `ambiguous` and so is the operation. It is not retried before a probe has reconciled it; while the repository does not answer, the probe finds `unknown` and the operation is blocked as above, with one blocker, asked once. Once the repository answers, the next tick's journal step reconciles it:

- *A killed `worktree add`.* The run it was for is ended when the deadline kills the command: `failed` / `infra_error`, its invocation never launched and not charged, and the work is repaired by a new run in a workspace of its own (one repair, counted once). Found absent, the operation is withdrawn. Found complete (the killed command had in fact finished: a late completion), the worktree is adopted as the ended run's retained workspace; no role is launched in it, and the run stays what it ended as.
- *A killed `worktree remove`* (an Abandon's). The run cannot end: an abandoned run ends with its workspace discarded. Found absent (the worktree still there), the same operation is retried as attempt 2 and the workspace is discarded once; the run then ends `abandoned`. No second removal operation is recorded for the run, with the engine still running and also when it crashed in between: recovery then completes and the engine reaches full mode (the slice-2 review's finding).

## 46. Crashes at the journal's boundaries, and a git child that outlives its engine

**What is durable at each boundary** (contract `durable`; row M33). Reopening the store after a kill at a boundary shows:

| Boundary | Journal events | Effect in git | Finalizer receipts |
|---|---|---|---|
| `intent_committed` | `intended`, exactly | absent | none |
| `effect_applied` | `intended`, exactly | applied | none |
| `receipt_committed` | `intended`, `applied`, exactly | applied | none |
| `probe_confirmed` | begins `intended`, `applied`, `confirmed` | applied | there exactly if the journal is `finalized` |
| `finalizer_committed` | all four | applied | there |

`receipt_committed` is exact: the `applied` receipt commits by itself, because no store transaction is held across the probe's git call. The confirmation may commit together with the finalizer. The finalizer's receipts are there exactly when the journal says `finalized`. At every boundary the operation passes `assertOperation`: legal journal, projection at its last event, attempts and status as section 44.

**After the restart** the operation has gone the way section 45 gives for what the kill left (at `intent_committed`: retry, or withdraw for a worktree add; afterwards: finalize), with its effect in git exactly once, the receipts of its finalizer, and the run and work as section 45 says. A second kill and restart, with ticks, changes no receipt: every row a finalizer wrote has the id and content it had. The project then goes on through the public API.

**A git child that outlives its engine** (the slice-2 review's finding; rows M31, M33). A probe says what git holds now, not what a process that is still alive is about to write. Before recovery acts on a probe of an operation it accounts for the dead incarnation's git children: by the time the engine is in full mode, either no git child of the dead incarnation is alive, or the operation is not reconciled (it is blocked, as for `unknown`). The test holds the engine's `git worktree add` before it has written anything, stops it (SIGSTOP), kills the engine, restores the repository and restarts. If the child is still alive at full mode the operation must be `ambiguous` with an open blocker and no workspace row. The child is then continued and ends; after two ticks no worktree is registered in the repository that no `workspaces` row names, the operation is finalized with its complete worktree and one row, or failed with nothing at the path and no row, and no role was launched. How the engine finds the children of an incarnation that died is not pinned.

## 47. Stop and Abandon while the work is integrating or integrated

(D1 §§4.5 step 4, 8.3, 8.4; rows M13, M14; `../contract/work-items.json`.) A Stop or an Abandon is admitted while the run is `validating`, with its work `integrating` or `integrated` (sections 17 and 24 covered `claimed` and `executing`). The run's lease is closing when the command is answered. The run is not ended while an operation it issued is in flight: issued effects are reconciled first.

- **An integration whose effect has not been made is not made.** An effect on behalf of a closing lease is refused: the ref update's journal is `intended`, `failed`, its status `failed`, its attempt (if one was issued) `failed`; the branch and the registry are where they were. Nothing is undone: the run's commit stays recorded and reachable from its keep ref.
- **An integration whose effect was made is recorded and finalized**, by the attempt that made it (one attempt; the swap is not repeated): the branch has moved, the registry expects it there, and the work is `integrated` by the finalizer before the command's own transition.
- **Then the command takes its course.** Stop: the run ends `stopped` / `human_stop`, workspace retained, the work `held` (`integrating → held`, or `integrating → integrated → held`); usage observed before the Stop is kept; an explicit Resume gives the work a new run, linked by `parent_run`, which starts from whatever the branch then holds. Abandon: the workspace is removed through the journal, the run ends `abandoned` / `human_abandon`, the work returns to `eligible` under the dispatch hold (`integrating → eligible`, or `integrating → integrated → eligible`). What was integrated stays integrated: an Abandon discards a workspace, not history.

The tests hold the integration at `journal.ref_update.intent_committed`, `effect_applied` or `finalizer_committed` with a paused barrier, send the confirmed command, require the run not ended a second and a half later, and release the barrier.

**`verifying` is owned by no run of the work.** When a Builder's work is being verified its own run has ended (Stop on it is `illegal_transition`), and the run under way belongs to the candidate's `verification` item. Stopping that run holds the verification item and leaves the Builder's work `verifying`; a resumed verification that completes then completes it. (From slice 5 that last clause holds for a `fix` only: a stage's work is still `verifying` when the resumed verification completes, and is completed by its `stage` gate, section 70.) The table's Stop and Abandon edges from `verifying` are therefore not reachable through a run in slice 3 (`../COVERAGE.md`).

## 48. The run-end fault matrix through integration

(E28 item 1; section 24.) `../contract/run-end-faults.json` gains five endings marked `"through": "integration"`: `integrates` (a role completes and its work integrates), `integration_conflict` (the branch is checked out in a worktree the engine does not own), `stop_integrating` and `abandon_integrating` (the command is confirmed while the ref update waits at `journal.ref_update.intent_committed`), and `checkpoint` (the snapshot is committed as a working revision and a second run continues and integrates). Their faults name the transactions on each path: the role's result, the domain's termination, each journal event of the commit and the revision row, the work item's moves, each journal event of the ref update, the refused operation, the blocker, the removal of an abandoned workspace, the run's end. 61 cells in all, each its own case, plus one reference per ending.

A fault with `"stage": "committed"` is armed after the run's commit is finalized and before its integration is intended (the tests pause at `journal.commit_tree.finalizer_committed`), so that it lands in the integration's transaction and not in the commit's, which writes events of the same types.

The rule is section 24's: with a one-shot fault on one transaction, and without a restart, the project reaches the same final facts as with no fault. For these endings the compared facts also hold what the repository and the journal hold (`gitFacts` in `endings.mjs`): the commits the branch gained and the paths they changed, each registered ref against what the registry expects, the revisions by kind and run, and each operation's journal events, state projection and attempt statuses. So a step that was repeated as a recovery would show: a reconciled attempt, a second attempt, a second commit. Each ending's `expect` adds the run's journaled operations with their statuses and the number of commits the branch gained.

## 49. Store rows the second session's tests read

Names are D1 A.3's (sections 8, 19 and 35 apply), each table with a `project` column. The tests read: `operation_attempts` (`operation`, `attempt_number`, `status`, `started_at`, `finished_at`, `reconciliation_reads`); `git_journal_state` (`operation`, `journal_kind`, `state`, `last_event_seq`); `operations.idempotency_key`, `linked_prior`, `remaining_scope`, `finalized_at`; `lineages` (`started_from_candidate`, `open`); `candidates` (`seq`, `revision`, `lineage`, `nominated_at`, `nominated_by`, `progress`); `phase_plans` (`phase_number`, `git_path`); `stages` (`phase_plan`, `number`, `goal`, `status`, `integrated_revision`, `work_item`); `revisions.lineage`; `work_items.blocker`, `subject`, `trigger_source`, `trigger_id`, `trigger_generation`; `decisions` with `subject_type` `operation`. The other A.3 columns of `candidates` and `phase_plans` (spec, architecture and roadmap revisions, the protected version, approval) are whatever the engine's schema needs for them in slice 3; no test reads them before the slice that owns them. The tests write to the store only in two cases of row M34 (a second attempt and a second journal event with a number already used, both of which the store must refuse).

## 50. Names the Verifier fixed in slice 3, second session

Each of these was open in the sources. The Builder may object. Those marked † carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| The ways on from a probe | Five: `finalize`, `retry`, `complete`, `withdraw`, `block` (contract `probe.dispositions`). | Correction 14 names what must not happen (blind retry, a second effect, a finalizer on an unconfirmed effect); a closed list of what does happen is what cases can be generated from. |
| `partial` for a commit | The commit object without its keep ref; completed by publishing it. | The commit's two effects are the object and its publication (D1 §7.3); the remainder is bounded and the operation's own. |
| `partial` for a ref update | Cannot exist; a claimed one blocks. | Plan M29: "a claimed partial result with no declared remaining effect". |
| A worktree add found absent or partial at recovery † | Withdrawn, not retried: journal and operation `failed`, residue removed, no workspace. | Its run is over by then; adding a workspace nobody will use leaves a worktree to clean up. Correction 14 allows a retry after positive absence; it does not require one. |
| A complete worktree found at recovery | Adopted once as the ended run's retained workspace. | Plan M31: "adopted once". |
| What blocking is | Journal, attempt and operation `ambiguous`; one open `blocker` decision with `subject_type` `operation`; the project not dispatched; probed again at every tick; the blocker closed when it proceeds. † | D1 §7.10: "ambiguous blocks the project"; a block that nothing ever re-examines could not be left by repairing the repository. |
| The status in the interval before an allowed retry † | `intended` after `reconciled_absent`; `partial` after `reconciled_partial`. | Correction 16 asks for a total derivation "including the interval before an allowed retry" and names no status. Positively absent with nothing in flight is what `intended` means. |
| No attempt, journal confirmed or finalized | `succeeded`. | The engine died between intent and first attempt and the effect was found applied: nothing was executed, and the operation has what it was for. |
| When an attempt succeeds | At the probe's confirmation. | D1 §7.10: the probe, not the command's exit, says the effect is there. |
| `reconciliation_reads[].result` | The probe outcome's name. | A.3 gives the column and not its vocabulary. |
| A linked successor † | A later integration of the same work item into the same ref names the failed one in `linked_prior`, which becomes `superseded`. A retry after reconciliation is a new attempt, never a new operation. | D1 §4.4: "superseded only when a linked successor is recorded". |
| `journal.<kind>.reconciled`; `--harness-probe` | Section 45. | The interval and the claimed partial result cannot be observed or produced otherwise. |
| A recovered integration's run and work † | Run `recovered`; work `integrated`, not `held`. | E24 item 3 holds recovered work so that a person resumes it; integrated work has nothing left to resume. |
| A `worktree add` killed at its deadline † | Its run ends `failed` / `infra_error`, never launched, not charged; the work is repaired; a late completion is adopted and launches nothing. | D1 §8.5: "any late completion is rejected"; Plan M15: "dependent ... dispatch stays suppressed after late completion". |
| A removal blocked or ambiguous | The abandoned run stays `finalizing`, not ended; the same operation is retried after reconciliation. | An abandoned run ends with its workspace discarded (D1 §4.5); the slice-2 review's collision came from a second intent. |
| A git child of a dead engine | By full mode: gone, or the operation blocked. How children are found is the engine's. | The review's finding; either answer closes the window. |
| Stop and Abandon during integration | Section 47: an effect not yet made is refused, one made is finalized; the run does not end while its operation is in flight. | D1 §4.5 step 4, "Reconcile issued effects"; §8.3, new effects are fenced at once. |
| The phase plan file † | `.surety/phases/phase-<n>.json`, `{"phase", "stages": [{"number", "goal"}]}`; a plan that cannot be registered is a `diff_violation`. | D1 §5.1 names the directory; §7.8 says a committed plan is schedulable by construction. |
| Work a plan registers | `stage_build`, trigger `("plan", <stage id>, 1)`, as the fixture installer's. | One trigger identity for a stage's work however it came to exist. |
| Completion of the Builder's work before gates exist † | `verifying` at the nomination that holds it; `complete` when that candidate's `verification` item completes. | The path of A.5 must end somewhere in slice 3; slice 5 puts the `stage` gate there. |
| Nomination ref, payload and trigger † | `refs/surety/cand/<seq>`; a ref update with no `run` in its payload; verification trigger `("nomination", <candidate id>, 1)`. | D1 §7.2 writes `surety/cand/<n>`; the nomination is the engine's act. |
| Cadence in M1 | T2 and T3 at each `stage_build` integration; T1 only on `nominate: true`; a T2 request outside the cadence point is ignored without error. | F §5.6, E11; Plan M27: "early T2 request cannot bypass cadence". |
| A changed nomination ref | Observed; `discard` only. | E18: immutable; adopting would change which commit the candidate is. |
| The chain boundary † | `max_chained_roles` counts the roles of a chain, the first included; at the boundary the work stays `eligible` with `blocker.reason` `max_chained_roles` and one `blocker` decision offering `continue` and `cancel`. | D1-34: "the next step is a decision"; E24 item 1. |
| A moved branch | Rebase onto the registry's expected head; `Surety-Base` and the commit's parent are that head; conflict and failed swap both end `integration_conflict` with `blocker.reason` `integration_conflict`. | D1 §7.5. |
| Merge drivers † | Not run by the engine's rebase. | E25 item 3 as E29 item 1 applied it to filters. |
| `operation_attempts.project`; `git_journal_state.project` | Present, like every table the tests read by project. | Section 8's rule. |
| Journal events in the log | One `git.journal_<kind>` per journal event but `failed`, with `subject.operation`. | D1 A.6; §12.1. |

## 51. What stands behind these tests before the engine exists

As in sections 21 and 38. The witness engine was extended to do what sections 39 to 48 ask (`selfcheck/witness-journal.mjs` holds its journal, attempts, probes and recovery; `selfcheck/witness-slice3b.sql` its tables), every file of this session passes against it, and for every case it has a defect that makes the case fail: one mutant entry per probe cell, per crash cell and per fault-matrix cell among them (`selfcheck/witness.mjs`). `selfcheck/slice3b.mjs` checks the tables for the properties the cases rely on (the transition table is closed and carries correction 14; no outcome lets a conflicting or unknown effect proceed; the derivation gives a status for every combination), runs every hand-built git state against real git, and runs the operation reads against witness stores with one unsound history per assertion.

Two things found on the way, both in the harness and neither about the engine. `holdGit`'s release could leave the held git call waiting for ever: git reads its configuration more than once, and the second read could arrive while the pipe was still under the name (10 of 40 releases hung before the change; `repos.mjs` now renames the file into place first). And the fact that says whether a registered ref is where the registry expects it was worded so that the expectation accepted both answers; the self-check for it found that.

The witness is still not the engine and not a design for it: it runs its git synchronously inside one process, finds a dead incarnation's children by a marker in their environment, freezes a finalizer's inputs in a column of its own, and knows nothing of gates. Against the slice-2 engine on `main` every case of this session fails at its first slice-3 step, which shows nothing about the cases.

---

# Slice 4: ledger, records, backup and power loss

Sections 52 to 64 were written with the slice-4 acceptance tests (2026-10-02): rows M59 to M67, and the cases of rows M02, M04, M12 and M61 that earlier slices left for this one. They follow D1 §§3.6, 6.5, 6.6, 13, 14 and 16.2, E16b and E16c, with build spec §6 correction 21. Where those left something open, the choice is listed in section 63.

**The procedure changed with this slice** (E31). Nothing stands behind these tests but the sources and a reading of the test: there is no stand-in engine and no self-check for them, and the frozen one under `selfcheck/` was neither extended nor run. The cases are few, by the owner's decision: one test per row, and a separately reported case only where the Plan names a finite case set. Only the five shim cases of row M67 were run, because only they need no engine (section 60). A defect in any other test will show during the build and goes through the objection procedure (build spec §4).

## 52. What the slice-4 tests assume throughout

- **Runs.** Most cases dispatch `verification` work, which completes on a valid result and integrates nothing. The cases that need a commit use `fix`.
- **The role's output is known byte for byte.** A scripted role writes exactly what its script says (`usageLine` and `resultLine` in `scripted.mjs` give the protocol lines as `scripted/child.mjs` writes them). Where a case compares a transcript with what the role wrote, the role waits silently (`heartbeat_ms: 0`), so no heartbeat line is in its output.
- **Policy.** The budget cases lower a budget through `POST /v1/projects/:p/policy` (section 27). Lowering a limit widens nothing.
- **The day.** A day budget is counted per UTC day of the engine's clock. The budget cases wait out midnight if it is less than two minutes away (`awayFromMidnight` in `ledger.mjs`).
- **The clock.** One case moves it: the retention case jumps 91 days in one step, with no run under way, and does not restart the engine afterwards.
- **Faults that keep failing.** A fault can now be armed for many transactions and taken away again (section 61), so that a case can show what the engine does when a store transaction or read fails every time, whatever the engine's own number of retries.

## 53. The scripted provider: its usage and its normalization

A real adapter declares what its provider reports and how that is normalized (D1 §13.2). For the scripted provider the Verifier fixes both here.

**What a `usage` line's `raw` may hold.** All keys are optional.

| Key | Meaning |
|---|---|
| `input_tokens` | billable input tokens, cache reads not included |
| `cache_read_tokens` | input tokens read from cache |
| `output_tokens` | output tokens |
| `cost_usd` | the cost the provider reports, a number |
| `model` | the model the provider says it used |

**Folding observations** (D1 §3.6). An invocation's observations are folded key by key: for `cumulative` observations the value is that of the latest observation that carries the key; for `delta` observations it is the sum over the observations that carry it. A key no observation carries is unknown. The tests never mix the two semantics in one invocation.

**Normalization `scripted-1`.** `billable_in` is `input_tokens`, `cached_in` is `cache_read_tokens`, `out` is `output_tokens`; an unknown key gives `null`, never zero, and cache reads are never added to `billable_in`. `model_observed` is `model`, or null. Cost:

| What is known | `cost_status` | `cost_usd` |
|---|---|---|
| `cost_usd` greater than zero | `reported` | that number |
| `cost_usd` equal to zero | `measured_zero` | `0` |
| no `cost_usd`; `model` is in the price table and all three token amounts are known | `estimated` | by the table |
| anything else, an invocation with no observation included | `unknown` | `null` |

**The price table `scripted-prices-1`** has one model, `scripted-priced`: 2 USD per million `billable_in`, 0.5 USD per million `cached_in`, 8 USD per million `out`. It is the one labeled rule by which a cost that was not reported becomes a number.

**The original ledger row** (D1 §13.1; section 16 fixed when it is written and that there is one). Its `provider` is `scripted`. `normalization_version` starts with `scripted-1`, and on an estimated row also contains `scripted-prices-1`. `raw_usage` is JSON text; for an invocation with one observation it equals that observation's `raw` (for several it is not pinned). `usage_complete` is 1 when the role ended by itself and at least one usage observation was recorded: the figures are then the provider's last word. It is 0 when the engine ended the invocation (a Stop, a deadline, a budget, a recovery after a crash) or when nothing was observed: what was observed is kept in the row, and the remainder is unknown.

## 54. The ledger: corrections, the fold, and the read

**A correction** (D1 §§3.6, 13.1; Review N04) is a ledger row with `corrects` naming the invocation's original row and `correction_seq` counting from 1. Its identity is `(invocation, correction_seq)`. It carries deltas: `billable_in`, `cached_in` and `out` are the normalized amounts of its own `raw_usage`, null where the raw has no such key. If its raw has `cost_usd`, the row's `cost_usd` is that number, a delta, and its `cost_status` is `reported`; otherwise `cost_usd` is null and `cost_status` repeats the status in force before it. `usage_complete` is what the correction says, or, if it says nothing, what was in force before it. `invocation` and `run` are the original's, and so is `day_utc`: a correction belongs to the day of the invocation it corrects. Appending one emits `ledger.correction`. The original row is never changed (section 8).

In M1 a correction comes from the scripted provider through a harness route (no public route appends one):

| Route | Body | Result |
|---|---|---|
| `POST /v1/harness/ledger/corrections` | `{"invocation", "correction_seq", "raw", "usage_complete"?}` | **201** `{"ledger_row": {"id"}, "created": true}` when that identity had no row: one correction row is appended through the engine's own transition. **200** `{"ledger_row": {"id": <the existing row>}, "created": false}` when it has one: nothing is written, however often and after however many restarts it is sent. |

**The fold** of one invocation is its original row and its corrections in `correction_seq` order: each token amount is the sum of the rows that know it, and null if none does; `cost_usd` likewise; `cost_status` and `usage_complete` are those of the last row. Each row counts once.

**`GET /v1/projects/:p/ledger`** (D1 §11.3), optionally with `?day=YYYY-MM-DD`. **200**:

```json
{"day": null, "rows": [...], "totals": {...}, "by_role": {"verifier": {...}}, "budget": {"exhausted": []}}
```

- `rows`: the project's ledger rows, originals and corrections, in the order they were written. Each has at least `id`, `billable_in`, `cached_in`, `out`, `cost_status`, `cost_usd`, `corrects` and `correction_seq` with the stored values; the tests compare those. With `day`, the rows of the invocations whose original row has that `day_utc`; without it, every row, and `day` is null.
- `totals`, over the invocations in scope, each folded:

| Key | Value |
|---|---|
| `invocations` | the number of original rows. A dispatch refused before launch has none and is not counted. |
| `billable_in`, `cached_in`, `out` | the sum over the invocations that know the amount; `null` when none does |
| `usage_incomplete` | the number of invocations whose `usage_complete` is false |
| `reported_usd` | the sum of `cost_usd` over the invocations whose status is `reported` or `measured_zero`; `null` when there is none |
| `estimated_usd` | the same for `estimated` |
| `unknown_cost_invocations` | the number of invocations whose status is `unknown` |
| `unknown_cost_tokens` | the billable tokens (`billable_in` plus `out`, as far as known) of those invocations; `null` when there is none |

  A sum is null, not zero, when nothing contributed to it: a project that dispatched nothing reports `invocations: 0` and null amounts.
- `by_role`: the same object for each role that has an invocation in scope; `{}` when there is none.
- `budget`: section 55.

## 55. Budgets

(D1 §13.3; E16b; D1-13.) The limits are the project settings `budget_run_billable_tokens`, `budget_day_verified_usd` and `budget_day_unknown_tokens`. An invocation's billable tokens are `billable_in` plus `out`; cache reads do not count.

**What is spent.** A run's spend is its invocation's billable tokens as observed so far. A project's day is the UTC day of the engine's clock; its unknown-cost tokens are the billable tokens of that day's invocations whose cost is unknown, and its verified cost is the reported cost of that day's invocations, the invocation under way included, from its observations as they arrive. Whether an estimated cost counts against `budget_day_verified_usd` is not pinned.

**The enforceable boundary.** The scripted adapter can be stopped at a usage observation. When an observation takes the run over `budget_run_billable_tokens`, or the project's day over one of the two day limits, the engine ends the run through the run-end protocol (section 16): `stopped` / `budget`, the run's `code` is `budget_exhausted`, termination is observed before the run ends, the workspace is retained, the usage observed is kept and charged with `usage_complete` 0, and the role's output up to its termination is its transcript (section 56). The work item is `parked` with `blocker.reason` the limit's key and one open `blocker` decision that offers `retry` and `cancel` (section 17). `retry` makes the work eligible again; its next run is a new invocation with its own charge. Work that had completed is not run again.

**At dispatch.** A project whose day has reached one of its day limits is not dispatched: no run is created, its eligible work stays eligible, and other projects go on. `GET /v1/projects/:p/ledger` reports it in every response as `budget.exhausted`: the keys of the day limits the project's current day has reached, sorted; `[]` when none. The tests only ever put a project clearly over a limit; what holds at exactly the limit is not pinned.

**A budget that cannot be read** (D1 §6.6, D1-13). A budget check reads the ledger. If that read fails, the check has failed: nothing of the project is dispatched on it, whatever an earlier check found (the fault `budget_read`, section 61).

## 56. Records: the durable path, streams and chunk receipts

(D1 §§3.6, 14.1; build spec §6 correction 21.) A record is a row of `records` and a file under `$SURETY_HOME/records/`. `records.path` is that file's path relative to `$SURETY_HOME/records/`.

**A stream's identity is its `records` row, before publication.** A streamed record is registered before its first chunk receipt is written: a row with `published` 0, whose `sha256` and `bytes` are null (they are not known yet; D1 A.3 marks both required, which correction 21 cannot keep) and whose `path` names the file its chunks are written to. Its `stream_chunk_receipts` rows reference it. An unpublished stream is not a record anyone may depend on: no run names it, the API does not serve it, and from slice 5 it is never gate evidence.

**Chunks.** A chunk is at most 1 MiB (1,048,576 bytes). A full chunk is made durable without waiting for the stream to end; the last, shorter chunk when it ends. A chunk receipt (`record`, `offset`, `length`, `sha256`) is written only when its bytes are durable in the stream's file. A record's receipts are contiguous from offset 0. Receipts are append-only (section 8's rule; row M04).

**Publication.** When the stream has ended the file is synced, renamed to its immutable name, its directory synced, and then, in a transaction, the row gets its `sha256`, its `bytes`, its final `path` and `published` 1, with `record.written` (`subject.record`, `subject.project`). A published stream's receipts cover exactly its bytes. A record written whole (a result) has no receipts and is published the same way. A transaction refers to a record only once it is published.

**A run's records.** Every launched invocation has a `transcript` stream: the role's standard output, byte for byte, after redaction (section 57). The stream ends when the engine stops reading the role's output (section 13: once the role's process is gone and what it had written has been read), however the run ends; so a run that was stopped, or failed, has its transcript too. When the engine accepts a valid result it writes a `result` record: JSON text that parses to the result the role sent, after redaction. `runs.transcript` and `runs.result` name them, and only published records; they are set no later than the transaction that ends the run. A run that launched nothing has neither.

**The cap.** A transcript retains at most 8 MiB (8,388,608 bytes) of a role's output. What the role writes beyond that is still read and acted on as protocol, and is not retained. A transcript that does not hold all the role wrote is not published: the stream stays unpublished with the chunks it retained, and the run's `transcript` stays null. The run ends as the role earned.

**After a crash.** A stream that was not published when the engine died stays unpublished: recovery cannot know it to be whole. Its receipts and its retained bytes stay as they were, which is how known output is told from an unknown remainder. One exception is allowed and not required: a stream whose every byte had been written and synced may be published by recovery, whole. A record whose publication had been committed is whole on restart.

**Barriers** (`pause` and `kill` as in section 18), for a streamed record:

| Name | Fires |
|---|---|
| `stream.before_registration` | immediately before the transaction that registers a stream, that is, commits its `records` row. Whether an engine registers the stream at the launch or at the role's first output is its choice. |
| `stream.chunk_durable` | after the first chunk receipt of a stream is durable |
| `stream.before_rename` | when the stream has ended and its file is synced, before the rename |
| `stream.published` | after the transaction that publishes the record, before any transaction refers to it |

**Post-write scan.** `post_scan` is `pending` until the scan of the stored bytes has run, then `clean` or `hit` (section 57). A published record is served while it is `pending` or `clean`. Where a case is about the scan, it waits for it.

**`GET /v1/projects/:p/records/:id`** (D1 §11.3). **200** with the record's bytes as the body (`Content-Type: application/octet-stream`). Refusals, in the usual shape:

| Status, code | When |
|---|---|
| 404 `not_found` | no such record, or it is not of project `:p` |
| 409 `record_unpublished` | the record is a stream that is not published |
| 410 `record_expired` | the record has expired (section 58) |
| 409 `record_missing` | its bytes are missing or do not have its hash (section 58) |
| 409 `record_quarantined` | a detector matched it (section 57) |

Unknown is not empty: none of these is ever answered with 200 and an empty body.

## 57. Redaction, and a detector registered later

(D1 §§14.2, 17(5); E16c.) Every secret value the engine holds is redacted from a record's bytes before they reach the disk, and from anything else derived from a role's output: store rows, events, logs under the engine home, API responses. The match is made on the stream, not on the pieces it arrives in: a secret is found when it is split between two writes of the role, when it lies across the boundary of a stored chunk, and when a write ends inside one of its multibyte characters. The text around it is retained. What is put in its place is not pinned. `records.redaction_version` is a non-empty string.

M1 resolves no real secret, so the tests give the redactor one, and later a detector, through harness routes:

| Route | Body | Result |
|---|---|---|
| `POST /v1/harness/secrets` | `{"ref", "value"}` | **2xx**. From now on the engine holds `value` as the resolved secret `ref`, in memory only: it is written nowhere. |
| `POST /v1/harness/detectors` | `{"name", "pattern"}` | **2xx**. Registers a detector: `pattern` is the source of an ECMAScript regular expression (the tests use ASCII). Registration starts a rescan of the stored records. |

**A later hit.** A stored record that a detector matches gets `post_scan` `hit`, and one `record.secret_found` event (`subject.record`, `subject.project`). It is no longer served (`record_quarantined`). Records the detector does not match stay `clean` and served. The Critical finding D1 §14.2 raises, and the quarantine of evidence and gates that depend on the record, are slice 5's.

## 58. Retention, and bytes that are missing or corrupt

(D1 §14.3, §16.1 step 5.) A record is retained while something live refers to it. In slice 4 the one such thing is a run whose work item is not terminal (`complete` or `cancelled`): the records of a `held` item's run are retained however old they are. Decisions, findings, gate evaluations, effect intents and journal entries refer to no record before slice 5.

**Expiry.** A published record nothing refers to expires once `record_retention_days` have passed (default 90). The test lets the whole period pass in one jump of the clock after the record's work is over, so it does not pin whether the days count from the record's publication or from the moment nothing referred to it. The tick performs it: the file is removed, the row is kept with `path` null and its `id`, `kind`, `sha256`, `bytes` and `published` as they were, and `record.expired` is emitted (`subject.record`). Reading it is **410** `record_expired`.

**The audit at startup.** The `recovery` step checks every published, unexpired record that something refers to: a file that is missing, or whose bytes do not have the recorded hash, gets one `record.missing` event (`subject.record`), before the engine reaches full mode. The engine reaches full mode all the same. Reading such a record is **409** `record_missing`. That its dependent gates report `EVIDENCE_MISSING` is slice 5's.

## 59. Backup and restore; a repository that moved

(D1 §§6.5, 11.6.) `surety store …` commands run against `$SURETY_HOME` while no engine holds it. The tests run them as `node packages/engine/dist/cli.js store …` with section 1's environment.

**`surety store backup [--database-only]`.** Exit status 0, and on stdout one last line that is a JSON object `{"backup": <the directory it wrote, absolute>, "label": "complete" | "incomplete_for_recovery"}`. The directory is under `$SURETY_HOME/backups/` and is self-contained apart from the git objects: it can be copied elsewhere and restored from there. It holds `manifest.json`:

```json
{"label": "complete",
 "store": {"file": "store.db", "sha256": "…", "bytes": 0},
 "records": [{"id": "rec_…", "file": "records/…", "sha256": "…", "bytes": 0}],
 "git": [{"project": "proj_…", "objects": ["<commit id>"]}]}
```

`file` paths are relative to the backup directory. `store` is a consistent snapshot of the database. `records` lists every published, unexpired record the snapshot refers to, each copied into the backup. `git` lists, per project, the commits the snapshot refers to (every `revisions.sha` at least); they are not copied: the engine keeps each reachable in the repository from a ref it has registered (section 28), so that a garbage collection does not remove them. With `--database-only` only the snapshot is written, and the label, in the manifest and on stdout, is `incomplete_for_recovery`.

**`surety store restore --from <backup directory> --bind <project id>=<repository path>`**, one `--bind` per project, into a `$SURETY_HOME` that has no store (it may hold a `config.json`). The command verifies the whole closure before it writes anything: the label, every member's presence, length and hash, and that every listed git object exists in the repository bound to its project. Then it installs the store and the records and records each project's repository path as bound. Exit status 0. An engine started on that home goes through recovery and integrity as on any start and reaches full mode; the API token is that home's own.

A restore that cannot be verified is refused with exit status **7** and section 1's one-line refusal on stderr, and leaves no `store.db` in the home:

| `code` | When |
|---|---|
| `backup_incomplete` | a member is missing, a member's length or hash differs, a listed git object is missing from the bound repository, or a project has no binding |
| `incomplete_for_recovery` | the backup's label says it is a database-only copy |

Not pinned: the name of a backup directory; the scheduler's daily backup, `engine.backup` and `backup_keep`; `surety store export` and `import`; what a restored engine does about workspaces, which are not part of a backup; that a store command is refused with status 3 while an engine holds the lock.

**A repository that moved.** A project whose repository is no longer at `dev_repo_path` is a project whose repository cannot be read (section 32): the engine reaches full mode and dispatches nothing of it. `POST /v1/projects/:p/rebind` with `{"dev_repo_path": <the new absolute path>}` binds it again: **200**, `projects.dev_repo_path` is the new path, and the next integrity observation is made there. Reads that do not need the repository (the ledger, the records) answer before and after as they did. What the route answers for a path that is not that project's repository is not pinned.

## 60. Power loss: the shim, and what it stands for

(Plan M67 and §2 resource V; D1 §18; E31 item 5.) Row M67 cuts power with an unprivileged shim, `powerloss/shim.c`: a library compiled with `cc` at test time into the test's temporary directory and loaded with `LD_PRELOAD` into the process under test. If it cannot be compiled or does not load, the case fails. `powerloss.mjs` is its test side.

**The model.** A regular file's durable content is what it held at its last `fsync` or `fdatasync`, or at the start of the session if it has not been synced since. A file created during the session and never synced holds nothing. Names are durable at once: a creation, a rename, a link or a removal is kept as the process left it, and a synced file keeps its synced content under whatever name it has at the cut.

**The mechanism.** The shim changes nothing a call does. After a successful `fsync` or `fdatasync` it copies the file, as it is then, into its control directory under a key that identifies the file and not its name (device, inode number and birth time), so a file synced under a temporary name and then renamed is found under its final one. `sync` and `syncfs` copy every regular file under the session's directories. When the process starts another (`execve`, `execv`, `execvp`, `execvpe`, `posix_spawn`, `posix_spawnp`), the shim adds itself to the child's environment if it is not there: the engine constructs its children's environments (D1 §7.1), and its git must be under the shim all the same. A session begins with `baseline()`, taken while nothing is writing: everything on disk then is durable. `cut()` kills, with SIGKILL, every process the shim is in; then every regular file under the session's directories is given the content of its copy, and a file with no copy is emptied. Directories, links and names are left as they are.

**What "synced" means for the two things under test.**

- *SQLite, WAL mode, `synchronous=FULL`.* The driver's SQLite calls the C library's `fsync` or `fdatasync` on the write-ahead log at every commit and on the database file at every checkpoint, and the shim sees those calls. After a cut the log is as it was at the last commit's sync and the database file as it was at the last checkpoint's; SQLite recovers the committed transactions from that pair as it does after any crash. The shared-memory file is never synced, is emptied by the cut, and is rebuilt by the first connection. A transaction committed under a weaker setting was never synced and is gone.
- *git.* git writes an object or a ref into a temporary file or a lock file and renames it into place; it syncs that file first only if `core.fsync` covers the component (by default it covers neither loose objects nor refs). Synced, the content survives under the final name. Not synced, the final name is there after the cut and the file is empty: an object that cannot be read, a ref that does not resolve. That is what the shim's two git cases show, and it is why an engine whose store records a git effect must have made git sync it. git syncs no directory, which the model does not ask for. `git worktree add` syncs neither the worktree's `gitdir` and `commondir` files, nor the workspace's `.git` file, nor the files it checks out, under any setting (tried with `core.fsync=all`): after a cut, a workspace made since the last `sync` is a directory of empty files that the repository no longer lists. The M67 cases assert nothing about a workspace beyond what section 16 asks of a retained one, that its directory is there.

**The shim is shown faithful** by `M67-power-loss-shim-is-faithful.test.mjs`, five cases that need no engine and pass today: a transaction committed through the pinned driver under `synchronous=FULL` survives a cut; one committed under `synchronous=OFF` after it does not, and the first still does; a commit and a branch written by git with `core.fsync=all` survive; a commit and a branch written with `core.fsync=none` do not, while what was synced in the same session does; and a git started by a process under the shim, with an environment that process constructed, is under the shim.

**The engine under the shim** (`M67-power-loss-durability.test.mjs`). A project is set up by an engine that is then stopped, and the session begins there. The engine is started under the shim with one barrier armed to pause, ticked, and waited for at the barrier; power is cut; the engine is started again without the shim. The three boundaries are the Plan's:

| Boundary | Barrier | Required |
|---|---|---|
| after an intent commit | `journal.worktree_add.intent_committed` | The dispatch and the operation with its `intended` event are in the store; no worktree exists. Recovery ends the run `recovered` with its work `held`; a Resume completes it with one launch in all. |
| after a record publication | `stream.published` | The transcript's row is published and its file holds exactly what the role wrote. The restarted engine serves it and reports no record missing. |
| after an effect was applied, before its receipt | `journal.ref_update.effect_applied` | The integration's intent is in the store. After recovery the branch is at the run's commit, the registry expects it there, the commit and its content are readable, one commit names the run, and the one ref update is finalized: recovered, not made a second time. |

For the engine this means, at least: the store commits with `synchronous=FULL`; a record's file is synced before it is published; every git write whose effect the store records is synced by git (`core.fsync` covering objects and refs) or by the engine; and nothing the engine needs in order to start, `engine.lock` included, is left unsynced. The engine may run `sync`; the shim honours it.

**What a pass shows.** That the engine and git recover from the state in which every file holds exactly what was last synced, or nothing if it never was, with every name as it was at the cut.

**What it does not show.**

- Anything about names. A rename, creation or removal that a real filesystem could lose because its directory was not synced is kept by the shim. A missing directory sync (D1 §14.1 asks for one after a record's rename) is not detected.
- Partial loss. Unsynced data is lost whole, never in part, never torn, never reordered; a state in which some later write survived is not produced.
- Data made durable by a way the shim does not see: `msync`, files opened `O_SYNC` or `O_DSYNC`, `sync_file_range`, io_uring, a direct system call, a statically linked program, a child started through `system`, `popen` or `execl`. The shim takes such data for unsynced, which can fail an engine that is in fact safe, and cannot pass one that is not.
- File metadata: modes, times, sizes apart from content.
- The medium. That the host's filesystem and device honour a sync is not tested by anything here (D1 §6.1's refusal to start on storage that does not is an open item; `../COVERAGE.md`).
- It is not a process kill. Rows M18 and M33 are those, and their results are reported separately (Plan §5).

## 61. Faults, barriers and routes added in slice 4

Every harness route follows section 7's rules.

| What | Form | Meaning |
|---|---|---|
| A fault that repeats | `"times": <n ≥ 1>` in the body of any `POST /v1/harness/faults` (default 1) | The fault fires that many times: the next n matching transactions, or reads, fail. |
| Disarming | `DELETE /v1/harness/faults` | **2xx**. Every fault still armed is taken away. |
| Budget read | `{"point": "budget_read", "project": "proj_…"}` | The next read of that project's spend that a budget check makes fails as a store error. |
| Lease read | `{"point": "lease_read"}` | The next read of a run's lease that a launch makes before its spawn (section 18: the check after `launch.before_spawn`) fails as a store error. No role is spawned on it; the run ends `failed` / `infra_error`, its invocation never launched and not charged, and its work is repaired like any failed run's. |
| Stream barriers | `stream.before_registration`, `stream.chunk_durable`, `stream.before_rename`, `stream.published` | Section 56. |
| Corrections | `POST /v1/harness/ledger/corrections` | Section 54. |
| Secrets and detectors | `POST /v1/harness/secrets`, `POST /v1/harness/detectors` | Section 57. |

The `before_event` fault of section 7 is armed in slice 4 on `git.journal_intended` (while it keeps failing, a dispatch makes no worktree and launches nothing) and on `run.validating`.

**A result whose recording keeps failing** (E27; E30 item 9 retries one failure). When the transaction that records a role's valid result fails every time, the engine stops retrying within a minute and ends the run `failed` / `infra_error` with a `reason_text` that says the result could not be recorded. The result is not lost silently: the run's transcript, published as for any run, holds the line the role sent. The work is repaired like any failed run's, one repair attempt charged.

**Public routes added:** `GET /v1/projects/:p/ledger` (section 54), `GET /v1/projects/:p/records/:id` (section 56), `POST /v1/projects/:p/rebind` (section 59). **Commands added:** `surety store backup`, `surety store restore` (section 59), with exit status 7.

## 62. Store rows the slice-4 tests read and write

Names are D1 A.3's (sections 8, 19, 35 and 49 apply), each table with a `project` column.

- `records`: `kind`, `path`, `sha256`, `bytes`, `redaction_version`, `published`, `post_scan`, `post_scan_finding`, `retain_until`. `sha256` and `bytes` are nullable (section 56); `path` is nullable (section 58).
- `stream_chunk_receipts`: `record` (references `records`), `offset`, `length`, `sha256`. UPDATE and DELETE are refused as section 8 says for the other history tables.
- `runs.transcript`, `runs.result` (reference `records`, nullable); `runs.reason_text`.
- `ledger_rows`: every A.3 column; `usage_observations`; `projects.dev_repo_path`; `work_items.blocker`, `repair_attempts`.

The tests write to the store directly in one case, with the engine stopped: row M04 inserts an unpublished stream (`id`, `created_at`, `project`, `kind`, `path`, `redaction_version`, `published` 0, `post_scan` `pending`) and one chunk receipt of it (`id`, `created_at`, `project`, `record`, `offset`, `length`, `sha256`), and then tries to change and to delete the receipt (`seedStream`, `seedChunkReceipt` in `seed.mjs`). The schema must accept those two inserts.

## 63. Names the Verifier fixed in slice 4

Each of these was open in the sources. The Builder may object. Those marked † carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| The scripted provider's usage keys and normalization | Section 53: `input_tokens`, `cache_read_tokens`, `output_tokens`, `cost_usd`, `model`; `scripted-1`. | D1 §13.2 leaves a provider's vocabulary to its adapter. Input and cache reads reported apart is the plainest form in which "billable excludes cache reads" can still be got wrong. |
| When a cost is estimated † | Only by the price table `scripted-prices-1`, for its one model, when all three token amounts are known. | D1 §3.6: "estimated (from a price table whose version is recorded)". One model and round prices keep the fixture's arithmetic readable. |
| `measured_zero` | A reported cost of exactly zero. | D1 §13.1: "a dispatched invocation that reported zero". |
| `usage_complete` † | 1 only for an invocation whose role ended by itself with usage observed; 0 whenever the engine ended it. | D1 §4.5 step 5 gives only the no-usage case. An invocation cut short has an unknown remainder (Plan M60). |
| A correction's shape and identity; its day | Section 54; `day_utc` is the original's. | D1 §3.6; a correction corrects that day's account. |
| The fold | Sums of what is known; status and completeness from the last row. | Review N04 asks for a defined fold and gives none. |
| The correction route | `POST /v1/harness/ledger/corrections`, 201 then 200. | No public route appends a correction; in M1 only the scripted provider sends one. |
| The ledger read † | Section 54: `rows`, `totals` with nine keys, `by_role`, `budget`; null for a sum nothing contributed to. | D1 §11.3 names the route and "per-role totals, verified and unknown separately". Reported and estimated are kept apart so that no total mixes them (E16b). |
| Billable tokens | `billable_in` plus `out`. | E16b: "billable tokens ... with cache reads recorded separately". |
| The scripted adapter's enforceable boundary | A usage observation. | D1 §13.3: adapters declare what they can enforce. |
| What a budget stop leaves † | Run `stopped` / `budget`, code `budget_exhausted`; work `parked`, blocker reason the limit's key, `retry` and `cancel`. | D1 §4.1 and §13.3 ("parks the item, raises a blocker"); the reason names the limit, as in section 15. |
| A project over a day limit at dispatch † | Not dispatched; its work stays `eligible`; reported as `budget.exhausted`. | D1 A.5 has no edge from `eligible` to `parked`; §13.3 "pauses dispatch for the project". |
| Whether an estimate counts as verified cost | Not pinned. | "Verified" can be read either way; the tests use reported costs only. |
| The stream's identity † | The `records` row itself, `published` 0, with null `sha256` and `bytes`. | Correction 21 asks for a durable pre-publication identity; A.3 already has `published`, and chunk receipts keep their A.3 parent. |
| Chunk size; when a chunk is durable | At most 1 MiB; a full chunk at once. | D1 §14.1 gives no size. A bound is what makes "long output is retained as it comes" testable. |
| The transcript | The role's standard output, byte for byte, after redaction. | D1 names the kind and not its content. |
| The cap on a role's output † | 8 MiB retained; beyond it the transcript is not published. | E25 asks for a cap. A truncated transcript published as a record would be a "prematurely complete transcript" (Plan M63); A.3 has no column to mark one. |
| A stream cut by a crash | Stays unpublished. | D1-23: "record either fully published or absent". |
| Stream barrier names | `stream.<point>`, four. | Plan M63's four crash points. |
| Record read statuses and codes | Section 56: `record_unpublished`, `record_expired`, `record_missing`, `record_quarantined`. | A.7 has none; the names follow the events `record.expired`, `record.missing`. |
| Secret and detector routes | `POST /v1/harness/secrets`, `POST /v1/harness/detectors`. | M1 has no resolver and no public registry. |
| What a later hit does in slice 4 | `post_scan` `hit`, `record.secret_found`, the record no longer served. | D1 §14.2; the finding is slice 5's. |
| What refers to a record in slice 4 | A run whose work item is not terminal. | D1 §14.3's list, as far as slice 4 has built it. |
| When expiry and the audit happen | Expiry at a tick; the audit in the `recovery` step. | D1 §14.3, §16.1 step 5. |
| Store commands † | Section 59: `surety store backup [--database-only]`, `surety store restore --from … --bind …`; exit status 7; `backup_incomplete`, `incomplete_for_recovery`; the manifest. | D1 §6.5 names the commands and the label. |
| Rebinding a moved repository † | `POST /v1/projects/:p/rebind`. | Plan M62: "relocate and explicitly rebind the repo"; D1 has no route for it. |
| A lease read that fails before the spawn | The run ends `failed` / `infra_error`, never launched. | Section 13's row for a role that cannot be spawned. |
| A result whose recording keeps failing † | Section 61. | E27 left it to this slice: retry, or end with the failure visible. Both: bounded retries, then a failed run that says why. |
| Repeating faults and their disarming | `times`; `DELETE /v1/harness/faults`. | A one-shot fault cannot tell an engine that retries from one that fails open. |
| The power-loss model † | Section 60. | E31 item 5 leaves the mechanism to the Verifier. |

## 64. What stands behind these tests before the engine exists

Less than before, by decision (E31). The shim is the one piece with logic of its own, and it is tested: the five cases of section 60 pass on the host these tests were written on (git 2.43, the pinned driver, ext4). It was also loaded once into the slice-2 engine on `main`, outside any test: the shim was in the engine, in each git the engine started and in the role; after a cut the store held the dispatch that had been committed; the workspace made since the session began was empty; and the engine refused to start again, because its `engine.lock` is written and renamed without a sync and was therefore empty. That last observation is the first thing row M67 will ask of the build.

Every other file was checked for syntax, and its imports and names were resolved against the harness; none was run, since each fails at its first slice-4 step on an engine that has none. The shared helpers that changed (`fx.start({env})` in `runs.mjs`; new steps and helpers in `scripted.mjs` and `scripted/child.mjs`; `clearFaults` in `engine.mjs`; `seedStream` and `seedChunkReceipt` in `seed.mjs`) are additions, and `M02-dispatch-identity.test.mjs` was run on the slice-2 engine afterwards and passes. The frozen self-check was not run and is not known to pass or fail with them.

---

# Slice 5: the protected path, gates and decisions

Sections 65 to 85 were written with the slice-5 acceptance tests (2026-10-02): rows M35 to M58, and the cases of rows M08, M09, M12, M24, M27, M61, M62, M64 and M65 that earlier slices left for this one. They follow D1 §§2.4, 3.3, 3.4, 5, 7.9, 9 and 10 with build spec §6 corrections 3, 4, 5, 8, 9, 17, 18 and 22, RN R1, R2, R4 and R7, Review B01, B03, B12, B18 and B19, and E13, E19, E25 item 4 and E30 items 1 and 16. Where those left something open, the choice is listed in section 84.

**What slice 5 changes in earlier sections.** Section 6's table: 202 answers a governed policy submission (section 66), and 409 gains `decision_invalidated`, `batch_conflict` and `quarantined`. Section 17: a confirmation taken while a run was `claimed` is good when it is `executing`, and Stop or Abandon of a quarantined run is `quarantined` (section 80); an answer may also be refused `decision_invalidated` (section 76). Section 27: a widening is not answered 200 (section 78). Sections 25 and 28: a Verifier's and a Reviewer's runs are validated (section 68). Section 40: a stage's work completes with its `stage` gate, not with its candidate's verification (section 70). Sections 32, 57 and 58: what an observation, a detector hit and missing bytes do to gates (section 72). The tests of slices 1 to 4 were not changed; `../COVERAGE.md` lists the ones whose assertions these changes make wrong.

The procedure is E31's, as in slice 4: the fewest cases that pin each row's required result, no stand-in engine, no self-check. None of these tests was run: every one fails at its first slice-5 step on an engine that has none. Two helpers with logic of their own were exercised directly (the protected fingerprint against a scratch repository, the notification sink program as a process); everything else was read, and its imports and names were resolved against the harness.

The expected table is `../contract/decisions.json` (the eleven enabled decision kinds, what each one's preview must bind, and the answer codes). `gates.mjs` and `decisions.mjs` are the test side.

## 65. What the slice-5 tests assume throughout

- **Candidates are made by runs, as in slice 3.** A case that needs a candidate builds a stage and has it nominated (`nominated` in `gates.mjs`). Most cases use tier T1, where a nomination is the Builder's request and no sign-off is needed; a later candidate of a T1 project is a `fix` whose Builder asks for a nomination (`successor`).
- **Observations are fixtures; reports are a role's.** Check executions, the classification of a protected diff, a validation-scope approval, a reuse entry, the evidence of an Alpha exception and a test target enter through harness routes and are labelled as test setup (section 67). M1 has no check runner and no classifier, and no test claims to qualify one (Plan §2). Findings, sign-offs, dispositions, severity changes, assessments and proposals are not fixtures: a scripted Verifier or Reviewer reports them in its result, as an agent would, and the engine records them (section 68).
- **Work a fixture creates for a role is not chained.** A `review`, `verification` or `check_correction` item made with the trigger fixture is dispatched at the next tick. The `verification` item a nomination creates still waits at the chain boundary (section 40) and is let through only by the cases that are about it.
- **Three rows read one history.** The cases of M38, M39 and M41 are separately reported readings of one fixture built in the suite's `before` hook: one candidate (or two), one check per case, one evaluation. If the fixture cannot be built, every case of the row fails.
- **The clock.** M40 (retention), M42 and M50 (a deferral's target) and M58 (aging) move the controlled clock, each in one jump with no run under way. M58 is the first test that restarts an engine whose clock it moved; section 82 says what it relies on.
- **The store is written directly in two rows,** M45 and M51, with the engine stopped (section 83), to change a dependency that no engine path changes while the question stands.
- **A rejected run's repair.** Where a case rejects a Verifier's or a Reviewer's run and then needs the project again, it first lowers `repair_attempts_max` to 0, so that the rejected work is parked and nothing else is launched for it.

## 66. The protected set, its fingerprint and its versions

(RN R2; build spec §6 correction 3; D1 §§2.4, 5.2; Review B19; rows M35 to M37.)

**The governed file.** The governed settings live in `.surety/checks/protected-policy.json`, a JSON object whose keys are `protected_paths`, `check_commands`, `check_discovery`, `runner_config`, `result_collection` and `required_checks`. A key that is absent has its default; the default of `protected_paths` is `[".surety/checks/"]`. The values of the other five are D3's; M1 stores them and gives them no meaning, except that a change of `required_checks` is a change of the required set (section 69). `.surety/policy.json` holds only the ungoverned keys of `../contract/config.json`.

**The protected set** of a revision is every file under the protected roots. The roots are those the governed file of the effective protected version names; a root is a path prefix ending in `/`.

**The fingerprint** of a revision is SHA-256, in lower-case hex, of the UTF-8 JSON text (no white space) of the array of `[path, blob id]` pairs of the protected set, sorted by path. Nothing of any file's content is projected into it. `protectedFingerprint` in `gates.mjs` computes it from `git ls-tree`; the tests compare `protected_versions.fingerprint` with that and never read the engine's computation. A repository with no file under its roots has the fingerprint of `[]`.

**Versions.** `protected_versions` holds one row per version: `seq`, `fingerprint`, `change_kind`, `proposal`, `approver_authority`, `authorized` (0 or 1), `effective_from`, `superseded_by`, `check_ids`. Creating a project, through `POST /v1/projects` or the fixture installer, records its first version: `change_kind` `initial`, `authorized` 1, `effective_from` set, the fingerprint of the integration branch's commit under the roots its governed file names. The **effective version** of a project is the one row that is authorized, has `effective_from`, and has no `superseded_by`; the tests require exactly one at every moment (`effectiveVersion`). The only writer of a later authorized version is the application of an approved proposal (section 69).

**An ordinary policy change** (section 27) commits `.surety/policy.json` and nothing else. It leaves the fingerprint, the effective version and the proposals as they were.

**A governed change through the policy route** (D1 §11.4, §7.9; D1-35). `POST /v1/projects/:p/policy` with a body whose keys are governed keys is answered **202** `{"proposal": {"id": "prop_<ULID>"}}`. The engine has recorded a `protected_proposals` row: `proposed_by` `human`, `status` `captured`, `base_revision` the commit the integration branch is at, and `tree_id` a tree that differs from the base's in exactly `.surety/checks/protected-policy.json`, whose content there is the recorded governed fields with the submitted ones replaced. Nothing is applied: no commit, no policy revision, no new version, and no `policy_widening` decision. From there the proposal goes the way of any proposal (classification, approval, application: sections 67 and 69). A body that mixes governed keys with a widening is in section 78; one that mixes them with an ordinary change is not pinned.

**Roots are judged by the authorized set.** A diff is partitioned by the roots of the effective version, not by roots it proposes: a change of `protected_paths` is a change to a protected file and takes the protected route, and while it is not applied every path the authorized roots protect stays protected (a Builder's edit under an authorized root other than `.surety/checks/` is still a `diff_violation`). What the protected set is once a version is authorized whose roots no longer hold the governed file is not pinned (section 84, the owner's question).

**An unauthorized protected set.** When the protected set at the integration branch's commit has a fingerprint that is not the effective version's, which in M1 can only follow the adoption of an out-of-band commit, the engine emits `protected.unauthorized_detected` and every gate evaluation of the project carries the reason `PROTECTED_PATH_UNAUTHORIZED`. Adopting a commit authorizes nothing: the effective version stays the authorized one.

## 67. Fixtures of slice 5

Each route follows section 7's rules. Each installs through the engine's transition functions and labels what it creates: every event it causes has `payload.test_fixture = true`.

| Route | Body | Result |
|---|---|---|
| `POST /v1/harness/fixtures/plan` (extended) | adds `"requirements": [{"key"}]`, `"modules": [{"name", "paths", "sensitive_areas"?}]`, and per stage `"implements": [<requirement key>]` | **201**; the answer adds `"requirements": [{"id": "req_<ULID>", "key"}]` (always present, `[]` when none was sent). Requirements belong to the fixture's approved spec; a stage's `implements` (and `requirement_ids`) are the requirements of those keys. A stage that omits `implements` implements nothing. A second call adds a plan and its stages to the same project. |
| `POST /v1/harness/fixtures/checks` | `{"project", "checks": [{"key", "kind", "gate_kinds", "requirements": [<key>], "required"?, "tier_floor"?, "sensitive_areas"?, "runner_class"?, "requires"?}]}` | **201** `{"protected_version": "pv_<ULID>", "checks": [{"id": "chk_<ULID>", "key"}]}`. Declares checks of the project's effective protected version, in addition to those it has: the stand-in for what D3 discovers in the protected set. `required` defaults to true, `runner_class` to `direct`, `requires` to `[]`; `requires` may name `environment` and `artifact_digest` (section 71). A version that has just become effective has no check until the fixture declares some. |
| `POST /v1/harness/fixtures/check-result` | `{"project", "check", "candidate", "exit_status": <integer or null>, "source_revision"?, "protected_version"?, "runner_class"?, "runner_id"?, "environment"?, "artifact_digest"?, "execution_established"?, "signaled"?, "deadline_hit"?, "started_at"?, "finished_at"?, "output"?}` | **201** `{"check_result": {"id": "cr_<ULID>", "execution_seq": <n>}}`. Records one execution of a check as an observation. Defaults: the candidate's revision, the effective protected version, the check's runner class, `execution_established` true, `signaled` and `deadline_hit` false, no environment and no artifact. `execution_seq` is the engine's: it rises with every result recorded in the project, whatever timestamps the body gives. `output`, a string, is published through the record path as a `check_output` record, which `check_results.output` names. `check.result` is emitted. |
| `POST /v1/harness/fixtures/environment` | `{"project", "name", "target_set": [<string>]}` | **201** `{"environment": {"id": "env_<ULID>"}}`. A configured test target. Nothing is ever deployed to it. |
| `POST /v1/harness/fixtures/classification` | `{"proposal", "change_kind": "tightening" \| "loosening" \| "unclassifiable"}` | **200**. What D3's classifier would say of a captured proposal: the proposal becomes `classified` with that `classified_change_kind`, `protected.classified` is emitted, and the engine routes it (section 69). Sent again for a proposal that is not yet approved, it replaces the classification, and the routing follows. |
| `POST /v1/harness/fixtures/approval` | `{"project", "kind": "validation_scope", "proposal"}` | **201** `{"approval": {"id"}}`. The validation-scope approval of a proposal that changes the required set: a baseline approval, which M1 takes as a fixture (build spec §3). |
| `POST /v1/harness/fixtures/alpha-exception` | `{"finding", "containment_evidence": <string>, "testing_purpose": <string>}` | **201**. Records the two things F §6.1 asks for before a High finding may be nonblocking at Alpha, on `findings.alpha_exception`; the evidence is published as a `containment_evidence` record. |
| `POST /v1/harness/fixtures/evidence-reuse` | `{"project", "candidate", "check", "check_result"?, "record"?, "assessed": <boolean>}` | **201** `{"reuse": {"id"}}`. A reuse entry offered for a candidate and a check (section 73). The fixture stores what it is given, complete or not. |

## 68. The scripted role in slice 5: what it reports, what it may change, and proposal capture

**The structured result.** Beside `status`, `summary`, `checkpoint` and `nominate` (sections 13 and 26) a valid result may carry the fields below. Each, if present, must have the form given; anything else there is `invalid_result`. A finding, sign-off or assessment is about the candidate the run's work item names in `subject.candidate`.

| Field | From | Form | The engine |
|---|---|---|---|
| `findings` | Verifier, Reviewer | `[{"category": <FindingCategory>, "severity": <Severity>, "message": <string>, "scope"?: "candidate" \| "lineage" \| "project", "sensitive_area"?: <string>, "check"?: <check key>}]` | records one `findings` row each, in the order given: `status` `open`, `proposed_severity` and `effective_severity` the severity, `candidate` the subject candidate, `source_run`, `source_role`; `finding.raised`. |
| `signoffs` | Reviewer | `[{"scope": "candidate" \| "module" \| "security", "module"?: <name>}]` | records one `signoffs` row each: `candidate`, `revision`, `role` `reviewer`, `scope`, `module`, `run`, and the `acceptance_content_hash` of what was reviewed; `signoff.recorded`. |
| `dispositions` | Reviewer | `[{"finding", "disposition": "fix" \| "defer" \| "accept", "linked_issue"?, "defer_target"?: <timestamp>}]` | section 74. |
| `severity_changes` | Verifier, Reviewer | `[{"finding", "to": <Severity>}]` | section 74. |
| `applicability` | Verifier | `[{"finding", "candidate", "reason", "evidence": <string>}]` | records one `applicability_assessments` row each, `proposed`, with `proposed_by_run`; the evidence is published as an `assessment_evidence` record; `assessment.proposed`. |
| `assessments` | Reviewer | `[{"assessment", "verdict": "not_applicable" \| "applicable"}]` | section 74. |
| `proposal` | Verifier | `{"rationale": <string>, "requested_change_kind": "tightening" \| "loosening" \| "unclassifiable"}` | used when the run's diff is captured as a proposal (below); the rationale is published as a `proposal_rationale` record. |
| `proposal_approval` | Reviewer | `{"proposal", "reason": <string>}` | section 69. |

What the engine does with a field from a role that may not send it is pinned in one case only: a Verifier's `proposal_approval` approves nothing (row M53). What such a run ends as is not pinned.

**What a Verifier and a Reviewer may change** (F §4.1; D1 §7.3 steps 1 and 2; sections 25 and 28 left this for slice 5). From slice 5 a run of the Verifier's kinds (`verification`, `check_correction`) and of the Reviewer's (`review`) is snapshotted and validated like a Builder's, once its role has sent a valid result and exited and its domain is reported terminated:

- a run that changed nothing is as in slice 2: it completes;
- a **Verifier** whose diff consists of protected changes and nothing else has it captured as a proposal;
- a Verifier whose diff holds any other path, alone or beside protected ones, and a **Reviewer** whose diff holds any path at all, protected or not, is rejected whole as section 28 says: `failed` / `diff_violation`, `reason_text` naming the path, nothing accepted and no proposal. (That nothing its result reported is recorded either follows from "rejected whole"; no case pins it.)

A Verifier's or Reviewer's run whose termination cannot be established is quarantined as section 16 says, with the outcome slice 2 gives it, and is not snapshotted; no test of this slice makes such a run write anything.

**Proposal capture** (D1 §§4.1, 7.3; D1-21). The run goes `validating → proposal_captured → finalizing → ended` and ends `completed` / `none`, its workspace retained and its work item `complete`: a `check_correction` item completes this way. The engine records a `protected_proposals` row: `proposed_by` `verifier_run`, `run`, `base_revision` the run's base, `tree_id` the run's snapshot tree, `status` `captured`, `requested_change_kind` and `rationale` from the result's `proposal`; `protected.proposed` is emitted. Capture is not a commit: no `commit_tree` or `ref_update` operation, no `revisions` row, no ref created or moved, the registry and the effective version as they were.

## 69. Classifying, approving and applying a proposal

(D1 §7.9; E13; RN R2, R4; build spec §6 corrections 5, 14 and 17; rows M37, M53 to M55, M57.)

**Routing by classification.** When the fixture classifies a proposal the engine raises one decision about it, `subject_type` `protected_proposal`, `subject_id` the proposal, of the kind its class names: `check_correction_tightening`, `check_correction_loosening` or `check_correction_unclassifiable`; each offers `approve` and `reject`. A proposal classified `loosening` or `unclassifiable` becomes `awaiting_human`; one classified `tightening` stays `classified`, because a Reviewer may approve it too. A classification that is replaced before approval closes the decision of the old class and raises the one of the new.

**Who may approve** (E13). Tightening: the human, through `check_correction_tightening`, or a Reviewer's run whose result carries `proposal_approval` naming the proposal. Loosening and unclassifiable: the human only, through the decision of that kind; a Reviewer's `proposal_approval` for such a proposal approves nothing. A Verifier approves nothing. When a Reviewer's approval takes effect the open human decision about the proposal is closed as `invalidated`. A proposal whose tree changes the value of `required_checks` in the governed file also needs a validation-scope approval (the fixture of section 67): until one is recorded the decision's `approve` option lists the blocker `APPROVAL_MISSING` and an answer that picks it is refused (section 76).

**Application** follows the approval: as the effect of a human's answer (section 76), or by the next ticks after a Reviewer's approval. The approval is recorded on the proposal (`approved`, `approver`, `approver_authority` `reviewer` or `human`; for a Reviewer, `approver` is its run), for a human's answer in the consuming transaction. The application then begins with one transaction that records the intended `protected_versions` row, with `authorized` 0 and `effective_from` null, together with the journal intent of the commit: the intended version precedes any git effect. The commit is made through the journal like any other (`commit_tree`, then `ref_update` of the integration branch): its parent is the commit the branch is at, its protected set is the proposal's (the fingerprint of the new commit equals the fingerprint of `tree_id`), and it is recorded as a `revisions` row of kind `protected` with no run. The integration's finalizer, in one transaction, sets the version `authorized` 1 with `effective_from`, sets `superseded_by` on the previous version, sets the proposal `applied` with `resulting_version`, invalidates the evidence that depended on the old version (section 72), and emits `protected.applied`. Exactly one version results from one proposal, whatever crashes on the way: killed at `journal.commit_tree.intent_committed`, the store shows the intended version unauthorized and git shows no effect, and recovery applies the proposal once; paused at `journal.ref_update.effect_applied`, the branch has moved and the old version is still the effective one, and killed there, recovery runs the finalizer and makes no second commit.

**While an application is pending** every gate evaluation of the project carries `GIT_JOURNAL_PENDING` (section 72).

**Candidates.** A candidate nominated before the change keeps its row, `nominated_protected_version` included. The next nomination is a new candidate whose `nominated_protected_version` is the new version.

**Checks across versions.** A check is identified across protected versions by its `key`: the executions of a required check are those recorded for any check row with its key, for the candidate. So an execution recorded under the old version is `stale` for the same check under the new one (section 71), and is invalidated besides.

## 70. Gates: the two routes, scope, delivery, and what a satisfied stage gate does

(D1 §§9.1, 9.3; RN R1, R7; build spec §3 and §6 corrections 4, 8 and 9; rows M38, M44, and the gate half of M08.)

**Evaluating.** `POST /v1/projects/:p/candidates/:c/gates/:kind` evaluates one gate of one candidate and records the evaluation. For `stage` the body is `{"stage": "stage_<ULID>"}`; for `alpha_authorize` it is `{"authorization": "dauth_<ULID>"}` (section 75). The answer is **200** whether or not the gate is satisfied, because an unsatisfied gate is an answer and not an error:

```json
{"evaluation": {"id": "gate_…", "gate_kind": "stage", "outcome": "not_satisfied",
                "reasons": [{"code": "CHECK_NOT_PASSED", "subjects": ["chk_…"]}],
                "check_states": {"chk_…": "missing"}, "scope": "scope_…", "stale": false}}
```

`outcome` is `satisfied` exactly when `reasons` is empty. `reasons[].code` is a D1 A.4 code; `subjects` are the ids the reason is about (a check, a finding, a requirement, a record). `check_states` has one entry per required check of the scope and no other. `scope` names the `acceptance_scopes` row. The evaluation and its scope are rows (`gate_evaluations`, `acceptance_scopes`) written in one transaction that emits `gate.scope_built` and `gate.evaluated`; if it fails the answer is **500** `store_error` and nothing is left, no issued authorization included (the `before_event` fault on `gate.evaluated`).

**Every other gate kind** (`phase`, `alpha_complete`, `beta_authorize`, `beta_complete`, `live_authorize`, `live_complete`) is refused **501** `unsupported` on that route, whatever the body, with no row written but the audit event.

**Delivery** (correction 8) is computed per candidate when a scope is built, from the stages whose `implements` list the requirement: no such stage, or none of them integrated at the candidate's revision or an ancestor of it, is not started; some is partial; all is delivered. The scope row holds `delivered_requirement_ids` and `partial_requirement_ids`; a requirement in neither is not started. A stage integrated at a revision that is not an ancestor of the candidate's counts for nothing.

**The required set** of a scope (`required_check_ids`) is drawn from the checks of the effective protected version that are `required`, whose `gate_kinds` hold the gate kind, and whose `tier_floor`, if any, is not above the project's tier (T1 < T2 < T3). Of those:

- a check with no requirement is a release obligation and is in scope whenever its gate kind and tier are;
- at `alpha_authorize`, a check with requirements is in scope when at least one of them is delivered. Checks of requirements that are only partial or not started are not in the set, and those requirements are not listed as delivered;
- at `stage`, the scope names its stage (`acceptance_scopes.stage`) and holds the checks of the delivered requirements that stage implements, and no check whose requirements all belong to other stages. Whether the check of a requirement the stage implements only in part is required at that stage is not pinned.

**An incomplete scope.** A scope whose required set is empty, or in which a delivered requirement has no required check, is not validated (`validated` 0) and its evaluation carries `ACCEPTANCE_SCOPE_INCOMPLETE`; for an uncovered requirement the reason's `subjects` hold the requirement. Such a gate is never satisfied.

**A satisfied `stage` gate completes its stage's work** (E30 item 16 ends here). A `stage_build` item that is `verifying` becomes `complete` in the transaction of a satisfied `stage` evaluation of a candidate that holds it, for its stage, and not before: the completion of the candidate's `verification` work no longer completes it. The engine evaluates that gate by itself when the candidate's `verification` item completes, and each tick recomputes an evaluation that is stale (D1 §8.1 step 7); a test may also ask for the evaluation with the route above. So with a failing or missing execution the work stays `verifying` however many ticks run, and it completes at the first tick after a passing execution is recorded. A `fix` item has no stage and therefore no stage gate: slice 5 does not change what completes it (section 40). A satisfied `stage` gate issues no authorization and advances no candidate.

**Sign-offs** (D1 §9.3(6); F §5.7). T1 requires none. T2 requires the Reviewer's at candidate scope. T3 requires that, one at module scope for each module of the plan fixture, and one of scope `security` (the security review). A sign-off counts when its `acceptance_content_hash` is the scope's. While one is missing the evaluation carries `SIGNOFF_MISSING`.

## 71. Check states

(D1 §9.2; E8; row M39.) For each required check, in this order:

1. the executions recorded for the check (by key, section 69) and the candidate, together with those a valid reuse entry adds (section 73) and without those that are invalidated (section 72): if there is none, and none was ever recorded, **missing**;
2. of those, the ones whose bindings match the scope: `source_revision` the candidate's revision (a reused result excepted), `protected_version` the effective version, `runner_class` the check's, and, for a check whose `requires` names them, `environment` and `artifact_digest` those of the scope. A check that requires neither matches whatever environment its execution names. If none matches, **stale**. An invalidated execution counts here, not under 1: a check whose only executions are invalidated is `stale`;
3. of the matching ones, the one with the highest `execution_seq` decides, whatever its timestamps: `execution_established` false is **skipped**, whatever exit status came with it; `signaled`, `deadline_hit`, a null `exit_status` or a nonzero one is **failed**; otherwise **passed**.

Every required check that is not `passed` is a subject of `CHECK_NOT_PASSED`. Nothing a role's result says changes a state.

## 72. What blocks a gate from outside its evidence, and evidence that cannot be used

(D1 §§7.6, 9.3(3), 9.3(8), 9.5, 14.2, 14.3; build spec §6 correction 17; rows M37, M40, and the slice-5 halves of M24, M62, M64 and M65.)

- **An out-of-band observation.** While a project has an unreconciled observation of its integration branch, every gate evaluation of the project carries `OUT_OF_BAND_CHANGE`. The ledger and the records are read as before. (Section 32 left this for slice 5. Observations of other subjects are not pinned.)
- **A pending journal operation.** While a journaled operation of the project is not finalized (the tests: the application of a proposal, paused between its effect and its receipt), every gate evaluation of the project carries `GIT_JOURNAL_PENDING`.
- **Invalidation is durable and is not staleness** (correction 17). `check_results.invalidated_at` is null until the result is invalidated and a timestamp afterwards; no other column of the row changes. An invalidated result is never selected again, after a restart as before it, although its bindings still match. `gate_evaluations.stale` is set on every evaluation that used the result. Two things invalidate: the finalizer of a protected application invalidates every result recorded under the superseded version; and `adopt` of an observation on the integration branch invalidates at least the results of the candidate the open lineage started from (which other candidates' results it invalidates is not pinned).
- **Evidence a gate cannot use.** A result's `output` record that is missing or corrupt (section 58), or that a later detector matched (section 57), makes the evaluation carry `EVIDENCE_MISSING` with the record among its `subjects`. A later detector hit also raises one finding: `scope` `project`, `category` `security`, `effective_severity` `critical`, `source_run` null, `status` `open`; `records.post_scan_finding` names it; being Critical it is a subject of `FINDING_BLOCKING` at every gate of the project.
- **Retention.** A record that a check result of a recorded evaluation names is retained however old it is (section 58 listed what refers to a record in slice 4). Retention held by a finding or an open decision is not pinned.

## 73. Evidence reuse

(Build spec §6 correction 18; D1 §9.1; F §3.8; Review B17; row M41.) A reuse entry (the fixture of section 67) says that an identified result of an earlier candidate may count for a later one. The gate considers an entry only if it is assessed, names a `check_result`, and that result is an execution of the same check (by key). The referenced result then joins the executions of the check for the later candidate with its candidate and `source_revision` excused, and with nothing else excused: its protected version, runner class, and environment and artifact where the check requires them must match the scope like any other's, or the check is `stale`. An entry that is not assessed, that names a record and no result, or that names nothing, adds nothing: the check is `missing` as if the entry were not there. Reuse never changes the required set. Nothing in M1 creates a reuse entry but the fixture.

## 74. Findings: applicability, dispositions, severity, resolution, assessments

(D1 §§3.4, 9.3(5), 9.4, 9.5; F §§6.1 to 6.3; E19; rows M42, M43, M50 to M52.)

**Which findings a gate asks about.** Every finding whose `status` is `open` or `dispositioned` and that applies to the candidate: a `project` finding always; any other, on the candidate it was raised on and on every later candidate reached through `lineages.started_from_candidate`, unless an `approved` assessment excludes that candidate.

**Blocking.** A Critical finding is a subject of `FINDING_BLOCKING`. At `alpha_authorize` a High finding is too, unless its Alpha exception is recorded (`findings.alpha_exception`) and it has no `sensitive_area`; a High finding in a sensitive area blocks with or without the exception. The exception changes no check state. What a High finding does at a `stage` gate is not pinned.

**Nonblocking findings** (Medium, Low, and a High one under its exception) are subjects of `FINDING_UNSATISFIED` until one of these holds:

- a deferral (`disposition` `defer`) with a linked issue and a target, whose `disposition_authority` covers the finding's current `effective_severity` (`reviewer` covers Low only; `human` covers Low and Medium) and whose `defer_target` has not passed. The evaluation that accepts it appends `{"evaluation": <its id>, "effective_severity", "at"}` to `findings.reevaluations`. A deferral whose target has passed makes the finding a subject of `FINDING_DEFER_EXPIRED`;
- an accept (`disposition` `accept`) with `disposition_authority` `human`;
- a resolution. A `fix` disposition is a plan and satisfies nothing.

**Dispositions a Reviewer reports** (`dispositions` in its result). `fix` is recorded: `status` `dispositioned`, `disposition` `fix`. `defer` of a finding whose current severity is Low is recorded with `disposition_authority` `reviewer`, `linked_issue` and `defer_target`. `defer` of a Medium finding and `accept` of any finding are beyond a Reviewer: the finding is left as it was and the engine raises a `finding_disposition` decision about it (section 77). `finding.dispositioned` is emitted when a disposition is recorded.

**Severity** (`severity_changes`). Any role may raise: `effective_severity` changes, `severity_history` gains `{"actor", "authority", "from", "to", "at"}`, and `finding.severity_changed` is emitted. A Reviewer may lower within the nonblocking range (Medium to Low), with `authority` `reviewer`. A lowering out of the blocking range (from Critical or High to Medium or Low) is not applied: the engine raises a `severity_lower` decision (section 77). No severity change alters a check state.

**Resolution.** A finding reported with `check` (a check key), dispositioned `fix`, is resolved by an evaluation for a candidate it applies to in which that check is `passed` by an execution recorded after the disposition: the finding becomes `resolved`, `resolution_verification` is `{"evaluation": <the evaluation>, "check_result": <the execution>}`, and `finding.resolved` is emitted; that evaluation does not count the finding against the gate. When the verifying execution is invalidated the finding returns to `open` and `finding.reopened` is emitted.

**Applicability assessments** (E19). A Verifier proposes (`applicability`, section 68). A Reviewer's `assessments` entry with `not_applicable` makes the assessment `assessed` with `assessed_by_run`; with `applicable`, `rejected`. An assessed exclusion of a finding that would block any gate kind for the candidate (Critical or High) excludes nothing: the engine raises a `finding_applicability_exclusion` decision (section 77), and only its approval makes the assessment `approved`, with `authorized_by`. Whether an assessed exclusion of a Medium or Low finding is approved without the human is not pinned.

## 75. The Alpha authorization

(RN R1; build spec §3 and §6 correction 4; D1 §9.6; row M44.)

**Proposing.** `POST /v1/projects/:p/candidates/:c/authorizations` with `{"environment", "artifact_digest", "config_identity", "target_set"}` records a `deployment_authorizations` row with `status` `proposed` and answers **201** `{"authorization": {"id": "dauth_<ULID>", "status": "proposed", "generation": <n>}}`. The same binding sent again for the same candidate answers **200** with the row it already has. Another binding is another row.

**Issuing.** An `alpha_authorize` evaluation is made for one proposed authorization and takes its environment and artifact from it. A satisfied evaluation, in its own transaction, moves that row to `issued`, sets its `evaluation`, and emits `authorization.issued`; an authorization of the same candidate and environment that was `issued` before becomes `superseded` (`authorization.superseded`). Evaluating again for an authorization already issued issues nothing more. An authorization that is not the candidate's is **404** `not_found`. A restart changes no authorization.

The row's transitions are correction 4's: `proposed → issued`, `proposed → superseded`, `issued → consumed`, `issued → superseded`, `consumed → superseded`. M1 builds no consumer, so `consumed` is never reached.

**Nothing is deployed.** No route deploys; no operation of kind `deploy`, `publish`, `rollback` or `teardown` is ever recorded; every candidate's `progress` stays `developing`; `candidate.advanced` is never emitted.

## 76. Decisions in slice 5: previews, answers, generations and effects

(D1 §§3.4, 4.6, 9.7, 10; build spec §6 correction 22; Review B12; rows M45 to M57.) Slice 2 built three kinds with no manifest (section 17). Slice 5 completes the eleven kinds of build spec §3; `../contract/decisions.json` lists them with what each binds, and section 77 says when each is raised and what its answers do.

**What every decision row carries.** `kind`, `subject_type`, `subject_id`, `semantic_generation` (from 1), `status`, `preview_hash`, `options`, `dependency_manifest`, `blocked_while_open`, `target_seconds`, `escalated_at`, `answer`. `dependency_manifest` is a JSON object that holds at least the keys the contract lists for the kind; the tests name the values they pin and nothing fixes the form of the others. `options` is a JSON array; each option has `key`, `effect_plan` (an object: what choosing it will do), `plan_hash`, and `blockers` (an array of reason codes, empty when the option can be chosen). `preview_hash` covers the identity, the options with their plan hashes, and every manifest value; it does not cover the order in which a submission listed its content, a timestamp of presentation, or how often the question was asked. `answer`, once given, is `{"option", "note", "actor", "at"}`. Every `decision.*` event carries `subject.decision` and `subject.project`.

**One identity** (D1 §10.2). Raising a question that is already open returns the open row: the same id, the same `preview_hash`, before and after a restart. A decision about one subject never stands for another subject.

**Answering.** `POST /v1/projects/:p/decisions/:d/answer` with `{"option", "preview_hash", "note"?}`:

| Answer | When |
|---|---|
| **200** | The decision is open, the option can be chosen, and what the engine computes now, from current rows and the current time, is what `preview_hash` covers. One transaction sets the decision `consumed` with its `answer`, records the approval (an `approvals` row: `decision`, `actor`, `subject_type`, `subject_id`, and `result_hash` or `acceptance_content_hash` as section 77 says) for the kinds that approve something, applies the answer's local transition, and for an effect-producing option records one `effect_intents` row (`decision`, `operation`, `preconditions`, `status` `pending`). `decision.answered`, `decision.consumed` and `intent.recorded` are emitted. No role is launched by it. |
| **409** `decision_stale` | The decision is open and something it is bound to has changed since the preview: a manifest value, a plan, an expiry. Nothing is consumed, approved or intended. This holds also when the action is still eligible under the changed value. |
| **409** `decision_consumed` | The decision is consumed. `subject.decision` names it, so a client that lost the first response learns that its answer took effect. |
| **409** `decision_invalidated` | The decision is invalidated: its dependency changed, or its subject was settled by another path. |
| **409** `illegal_transition` | The option lists a blocker. |
| **500** `store_error` | The consuming transaction failed (the `before_event` fault on `decision.consumed`): the decision is still open, with no approval and no intent, and can be answered again. |

A test that answers with a preview taken before a change accepts `decision_stale` or `decision_invalidated`: the engine may find the change when the answer arrives, or may have invalidated the decision already.

**Invalidation and the next generation** (D1 §4.6). A decision whose dependency changed becomes `invalidated`, at the answer that found it or at the next tick's decision step. If the question still stands, the engine raises it again about the same subject with `semantic_generation` one higher, a manifest that shows the changed value, and another `preview_hash`; the new row has no approval. If the question no longer stands (a quarantine that cleared, a proposal a Reviewer approved, a deferral whose target passed) nothing is raised. A decision raised by a command (section 78, 80) gets its next generation when the command is sent again.

**Effects** (D1 §10.5). The kinds marked `effect` in the contract are followed by a journaled operation. Between the consuming transaction and the effect the engine reads every precondition of the intent again, from the store and, where the effect is on a repository, from the repository itself. `effect_intents.preconditions` is a JSON object holding the manifest's keys with the values expected **after** the consumption's own local transition: approving a correction moves its proposal to `approved`, and the intent expects `approved`, so an effect is never invalidated by its own consumption. If a precondition differs, the intent becomes `invalidated` with `invalidated_reason` `EFFECT_PRECONDITION_CHANGED` (`intent.invalidated`), the effect is not made, the consumption's local transition is withdrawn (a proposal returns to `classified` or `awaiting_human`), and the next generation of the decision is raised with no approval: the approval stays with the consumed decision. Otherwise the intent goes `executing` and, when the operation is finalized, `done`. An intent found `pending` after a restart is revalidated and executed then, once. The operation an intent names is `succeeded` once the effect is made, and its journal intent names the planned tree or ref. Whether the engine runs an effect within the answering request or in the next tick's effects step is its own choice; the tests ask for ticks while they wait.

**The barrier `intent.recorded`** (armed as section 33 says, `pause` or `kill`) fires after the consuming transaction and before the preconditions are read again. What the answer's HTTP response says when its effect is afterwards invalidated is not pinned.

## 77. The eleven kinds: when each is raised and what its answers do

The manifest keys of each kind are in `../contract/decisions.json`. `subject_type` is as there.

| Kind | Raised | Options | A positive answer |
|---|---|---|---|
| `blocker` | As in sections 15, 16, 40, 45 and 55: work parked, a quarantined run, the chain boundary, a blocked operation. | `retry`, `cancel` (parked work); `continue`, `cancel` (the chain boundary); `acknowledge` (a quarantine) | As before. `retry` makes the work eligible and launches nothing; it completes nothing and attests nothing. |
| `out_of_band_change` | Section 32. | `discard`, `adopt` (a ref); `stash`, `adopt` (a checkout) | Section 79. |
| `stop_confirm`, `abandon_confirm` | By the Stop and Abandon routes (section 17). | not read by the tests | Section 80. |
| `policy_widening` | By a policy submission that widens (section 78). `subject_type` `project`. | `approve`, `reject` | Section 78. |
| `finding_disposition` | When a Reviewer reports a disposition beyond its authority: `defer` of a Medium finding, `accept` of any (section 74). | `approve`, `reject` | `approve` records the proposed disposition with `disposition_authority` `human`, and for a deferral its `linked_issue` and `defer_target`. The approval's `acceptance_content_hash` is that of the candidate's scope. |
| `severity_lower` | When a Reviewer reports a lowering out of the blocking range. | `approve`, `reject` | `approve` sets `effective_severity` and records the change with `authority` `human`. |
| `finding_applicability_exclusion` | When an assessment of a finding that blocks a gate kind becomes `assessed`. `subject_type` `applicability_assessment`. | `approve`, `reject` | `approve` makes the assessment `approved` with `authorized_by`; the approval's subject is the assessment. The finding no longer applies to that candidate, and applies to every other as before. |
| `check_correction_tightening`, `check_correction_loosening`, `check_correction_unclassifiable` | When the fixture classifies a proposal (section 69). | `approve`, `reject` | `approve` approves the proposal with authority `human` and its application follows as the effect. The approval's subject is the proposal and its `result_hash` the proposal's `diff_hash`. The option's `effect_plan` holds at least `proposal`, `tree` (the proposal's `tree_id`) and `ref` (the integration branch's full name). |

**Manifest values the tests pin.**

- `blocker`: `subject_status` (`parked` for parked work), `cause` (the subject's recorded blocker reason: `work_items.blocker.reason`), `quarantined` (a boolean), `continuation` (`eligible` for parked work).
- `finding_disposition`: `finding_status`, `disposition` (null while none is recorded), `proposed_disposition`, `effective_severity`, `defer_target`, `linked_issue`, `candidate_revision`, `acceptance_content_hash`. A deferral whose target has passed cannot be approved.
- `severity_lower`: `effective_severity`, `to`, `sensitive_area` (null when the finding has none).
- `finding_applicability_exclusion`: `assessment_status`, `finding`, `candidate`, `proposed_by_run`, `assessed_by_run`, `effective_severity`, `blocks_gate` (a boolean).
- the three `check_correction_*` kinds: `proposal_status`, `tree`, `diff_hash`, `base_revision`, `integration_revision` (the commit the integration branch is at), `classification`, `effective_protected_version`, `scope_approval` (null, or the validation-scope approval). `evidence` covers the proposal's rationale record and its state, so that a rationale a later detector matched is a changed dependency.

The answers `reject` of the approving kinds are not exercised.

## 78. A widening policy change

(D1 §§10.1, 11.4; Review B12, B19; rows M49, M56; section 27 pinned the ordinary change.) A submission to `POST /v1/projects/:p/policy` that raises `max_chained_roles` or one of the three budgets widens what the engine may do unasked. It is not committed. The answer is **409** `confirm_required` with `subject: {"decision", "preview_hash"}`: a `policy_widening` decision, `subject_type` `project`, whose manifest holds `base_revision` (the number of the policy revision in effect, null when there is none), `base_blob`, `proposed_policy` (the complete policy that would be in effect: every ungoverned key with its value) and `widens` (the keys that widen, sorted). Whether raising any other key widens is not pinned.

- The same submission sent again, its keys in any order, before or after a restart, names the same decision with the same preview. Another submission against the same base is another decision.
- `approve` commits `.surety/policy.json` through the journal as section 27 says, as the decision's effect; the `policy_revisions` row has `widens_authority` 1 and `decision` the decision.
- When the base changes before the answer (another policy change was recorded), the decision is stale: nothing is widened and no update is lost. The same submission sent again raises the next generation, bound to the new base; approving it commits a policy that holds both changes.
- When the base changes after the answer and before the effect, the intent is invalidated as section 76 says and the engine raises the next generation itself.
- A submission that holds a widening and governed keys answers `confirm_required` with `subject.proposal` naming the proposal the governed part became (section 66). Approving the widening commits the ordinary policy only: no governed key is in `.surety/policy.json`, the governed file and the effective protected version are unchanged, and the proposal is still `captured`.

**The chain limit above one** (row M12; section 40). With `max_chained_roles` at 2, work that a run's outcome created is dispatched with no decision while its run is the second role of its chain, and the work that run's outcome creates waits at the boundary as section 40 says.

## 79. Reconciling an out-of-band observation: the fresh comparison, and a checkout's answers

(D1 §7.6; Review B05, B12; row M46; section 32 pinned the observation and a ref's two answers.) The manifest holds `subject_kind`, `expected` and `found` as the observation's row has them (for a ref, `found` is the commit id). Rereading that row is not a fresh read. Before an answer is consumed, and again before its effect is made, the engine reads the actual ref, or the actual HEAD, index and tracked files of the checkout, and compares them with `found`. If they differ:

- the answer is refused as stale, or the intent is invalidated, as section 76 says;
- nothing is reset, stashed or adopted, and the newer commit or edit is exactly where the developer left it;
- at the next tick the engine observes what is there now and raises a decision about that: the old decision is no longer open and exactly one other is.

**`stash`** for a checkout: the engine commits the checkout's tracked content as reviewed to a new registered `refs/surety/oob/<n>` ref, restores the checkout to its baseline (its files, its index and its HEAD as the baseline says), records `disposition` `stash`, and emits `repo.reconciled`; its own restore is never observed in turn. `adopt` for a checkout is not exercised.

## 80. What a Stop or Abandon confirmation binds

(E25 item 4; Review B12; D1 §§8.4, 10.5; rows M47, M48; section 17 has the two requests.) The manifest of `stop_confirm` and `abandon_confirm` holds `run`, `stoppable`, `domains`, `lease_generation`, `workspace`, `workspace_snapshot` (the workspace's `snapshot_tree`, null until a snapshot is captured), `workspace_fate` (`retained` for a Stop, `discarded` for an Abandon) and `work_fate` (`{"status": "held"}` for a Stop; `{"status": <the prior status>, "dispatch_hold": true}` for an Abandon).

- **Claimed or executing is not bound.** A preview taken while the run is `claimed`, at `launch.before_spawn`, confirms the run when it is `executing`: asking again returns the same decision and preview, and the confirmation is accepted. This replaces the stricter slice-2 behaviour section 17 allowed.
- **What the workspace holds is bound.** When the role has finished and its snapshot is captured (its commit integrated, in the tests), a confirmation that carries the earlier preview is refused, although the run can still be stopped or abandoned; the command sent again with `{}` raises the next generation, whose `workspace_snapshot` is the snapshot's tree. A refused confirmation stops nothing.
- **A quarantined run.** `POST …/stop` and `…/abandon` on a run that is quarantined is **409** `quarantined`, and raises no decision. (Section 17 said `illegal_transition` for a run "whose end the engine has already decided"; a quarantine has its own code, D1 §11.5.)
- An Abandon confirmed while termination is not observed discards nothing until it is: the run is quarantined with outcome `abandoned`, its workspace is there and its work is not released; when termination is observed the workspace is discarded and the work is where `work_fate` said. Stop and Abandon record no effect intent: they act through the run-end protocol.

## 81. A batch of answers

(D1 §10.3; row M56.) `POST /v1/projects/:p/decisions/answer-batch` with `{"answers": [{"decision", "option", "preview_hash"}]}`. The answers are evaluated as one combined plan and consumed in one transaction: **200** when every answer would be accepted by itself and their plans are compatible, and then every decision is consumed; **409** `batch_conflict` when two plans conflict (the tests: two widenings of one key previewed against one base), and then none is consumed, approved or intended. What a batch with a stale member answers is not pinned.

## 82. Aging, escalation and the scripted notification sink

(D1 §§8.1 step 6, 10.4; build spec §8; row M58.)

**Escalation.** A tick's decision step finds each open decision whose age on the engine's clock exceeds its `target_seconds` (the effective map of section 2; a kind with no target never ages) and, in one transaction, sets `escalated_at`, records one `notification_intents` row whose `source` is `{"decision": <id>}` and whose `key` is unique to that decision and generation, and emits `decision.escalated`. This happens once per decision generation, however many ticks and however much time follow. The decision stays open.

**The sink.** In harness mode with `--harness-scripted <dir>`, the project's external channel is the program `<dir>/notify.mjs`, if that file exists; `../harness/scripted/notify.mjs` documents it. The engine runs it as one process per call, with an argument array, a deadline, and never a shell:

| Call | Input | Exit status |
|---|---|---|
| `process.execPath <dir>/notify.mjs deliver` | one line on standard input: a JSON object with at least `key` and `decision` | 0: delivered and confirmed. 1: not delivered. Anything else, a signal or a timeout: the sink cannot say. |
| `process.execPath <dir>/notify.mjs lookup <key>` | none | 0: a notification with that key was delivered. 1: positively absent. Anything else: the sink cannot say. |

**Delivery is an attempt that is reconciled, never repeated blindly.** The intent is `queued`, then `sending` while an attempt is in flight, then `delivered`, `failed` or `unknown` (with `notification.delivered`, `notification.failed` or `notification.unknown`). An attempt whose outcome the engine does not hold (the engine died, or the sink could not say) is reconciled with `lookup` before anything else: found, the intent is `delivered` and nothing is sent again; positively absent, one new attempt is made; the sink cannot say, the intent is `unknown` and stays so, and nothing is sent again by later ticks or a restart.

**Barriers** (`pause` and `kill`): `notify.before_delivery` fires when the intent and its attempt are durable (`sending`) and before the sink is called; `notify.delivered` fires after the sink has returned from a `deliver` call and before the store records its outcome.

**The clock.** M58 moves the clock past the target, and in two cases the engine is then killed and restarted, which resets the clock (section 18). The cases rely on one thing: an escalation that was recorded is not undone, and its notification intent is reconciled, whatever the restarted engine's clock says about the decision's age.

## 83. Store rows the slice-5 tests read and write

Names are D1 A.3's (sections 8, 19, 35, 49 and 62 apply), each table with a `project` column. The tests read:

- `protected_versions` (`seq`, `fingerprint`, `change_kind`, `proposal`, `approved_by`, `approver_authority`, `authorized`, `effective_from`, `superseded_by`); `protected_proposals` (`seq`, `proposed_by`, `run`, `base_revision`, `tree_id`, `diff_hash`, `rationale`, `requested_change_kind`, `status`, `approver`, `approver_authority`, `resulting_version`);
- `check_results` (every A.3 column, and `invalidated_at`, which A.3 does not have); `acceptance_scopes` (`candidate`, `gate_kind`, `stage`, `delivered_requirement_ids`, `partial_requirement_ids`, `required_check_ids`, `validated`, `acceptance_content_hash`); `gate_evaluations` (`candidate`, `gate_kind`, `outcome`, `stale`);
- `deployment_authorizations` (`candidate`, `environment`, `artifact_digest`, `config_identity`, `target_set`, `protected_version`, `evaluation`, `status`); `evaluation` is null until issuance, and `status` has the value `proposed` (correction 4);
- `findings` (`seq`, `scope`, `candidate`, `source_run`, `category`, `effective_severity`, `severity_history`, `sensitive_area`, `status`, `disposition`, `disposition_authority`, `linked_issue`, `defer_target`, `reevaluations`, `resolution_verification`); `applicability_assessments` (`finding`, `candidate`, `proposed_by_run`, `assessed_by_run`, `authorized_by`, `status`); `signoffs` (`candidate`, `revision`, `role`, `scope`, `module`, `acceptance_content_hash`);
- `decisions` (section 76); `approvals` (`decision`, `actor`, `subject_type`, `subject_id`, `acceptance_content_hash`, `result_hash`); `effect_intents` (`decision`, `operation`, `preconditions`, `status`, `invalidated_reason`); `notification_intents` (`source`, `status`);
- `candidates.nominated_protected_version` and `candidates.progress`; `policy_revisions.widens_authority` and `.decision`; `stages.integrated_revision`; `records.post_scan_finding`.

The other A.3 columns of these tables are whatever the engine's schema needs. A table the engine keeps for reuse entries, for validation-scope approvals or for a check's `requires` is its own; the tests do not read it.

The tests write to the store directly in two cases, both with the engine stopped and started again afterwards: row M45 changes `work_items.blocker` (its `reason`), and row M51 sets `findings.sensitive_area`.

## 84. Names the Verifier fixed in slice 5

Each of these was open in the sources. The Builder may object. Those marked † carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| The fingerprint's input † | The JSON text of the sorted array of `[path, blob id]` pairs. | Correction 3 gives the content and not the encoding. JSON has no separator a path can contain. |
| Where the roots come from; the first version | The governed file of the effective version, default `[".surety/checks/"]`; an `initial` version recorded when the project is created or installed. | RN R2; D1 §2.4 ("project bootstrap"). |
| A governed edit through the policy route | **202** with the proposal; a tree that differs in the governed file only. | D1 §11.4, §7.9: such an edit "becomes a proposal". |
| What is not pinned about roots † | The protected set after an authorized roots change that leaves the governed file outside the roots. | The Plan asks only that the change cannot hide its delta or bypass the authorized set. |
| The fixtures of section 67 | Eight harness routes. | Plan §§1, 2: check results, classifications and baseline approvals are fixtures. Check discovery, test targets, reuse entries and the Alpha exception's evidence have no M1 source either. |
| A check's bindings | `requires` on the check names `environment` and `artifact_digest`; other checks match on revision, version and runner class. | D1 §9.2: "where the kind requires them", and no source says which kinds do. The fixture says it per check and decides nothing for D3. |
| A check across versions | Identified by its key. | D1-09 expects `stale` for "old protected version", which needs one check on both sides of a version change. |
| A role's result fields † | Section 68's table. | Section 13 left them for "later slices". |
| What a Verifier and a Reviewer may change | A Verifier only the protected set; a Reviewer nothing. | F §4.1; the first slice-3 session's obligation. |
| The gate routes † | `POST …/candidates/:c/gates/:kind`, 200 for either outcome; 501 for the six other kinds. | D1 §9.1 names the function and §11.3 only a read. |
| An incomplete scope | An evaluation with `ACCEPTANCE_SCOPE_INCOMPLETE`, not an HTTP refusal. | One shape for every evaluation. A.7's `scope_incomplete` is left unused. |
| The required set at each gate | Section 70. | D1 §9.1 and correction 8; "stage scope binds its stage obligations" (Plan M38). |
| When the stage gate is evaluated, and what a satisfied one does † | By the engine when the candidate's verification completes and at ticks; it completes the stage's work. `fix` work is unchanged. | E30 item 16 left the completion rule to this slice. |
| The security review | A sign-off of scope `security`, a value `SignOffScope` (A.2) does not have. † | F §5.7 requires a clear security review at T3; A gives it no representation. |
| Durable invalidation | `check_results.invalidated_at`. | Correction 17; A.3 has the same column on `deployment_verifications`. |
| The state of a check whose executions are all invalidated | `stale`. | The Plan: the gate "explains stale/invalidated evidence". |
| What blocks gates | An unreconciled observation of the integration branch, and a journal operation not finalized, each for every gate of the project. | D1 §9.3(3) says "on the lineage"; D1-11 says "gates blocked". |
| What `adopt` invalidates † | At least the results of the candidate the open lineage started from. | The Plan (M40) has an adoption invalidate a result that had passed a gate; D1 §7.6 says "on the lineage". |
| Evidence that cannot be used | `EVIDENCE_MISSING` naming the record, for missing, corrupt and quarantined evidence alike. | D1 §9.3(8). |
| A reuse entry | Assessed, naming a result of the same check; candidate and source revision excused and nothing else. | Correction 18. |
| How dispositions, lowerings and exclusions reach the human † | A role proposes in its result; what is beyond its authority raises a decision with `approve` and `reject`. | F §§6.2, 6.3 and E19 give the authorities; the answer body has no room for a deferral's target (D1 §11.4), so the target must come with the question. |
| How a fix is resolved † | By an evaluation in which the check the finding names passes, by an execution recorded after the disposition. | D1 A.3: a resolution is `{evaluation, check_result}`. No role's claim resolves a finding. |
| The Alpha exception's evidence † | A fixture. | F §6.1 says what must be recorded and not who records it. |
| Authorizations † | `POST …/candidates/:c/authorizations`; the gate is evaluated for one proposed row; 404 for another candidate's. | Correction 4: the row exists, proposed, before the evaluation. |
| The preview's parts | `options[].blockers`; manifest keys per `../contract/decisions.json`. | Review B12's table, one key per dependency it names, as far as M1 has the dependency. |
| `policy_widening`'s subject | The project. | A.8 says the policy revision, which a project with no recorded revision does not have. |
| What widens | Raising `max_chained_roles` or a budget. | Plan M49: "a budget/autonomy widening". Nothing else is pinned. |
| Answer codes | `decision_invalidated` and `batch_conflict` (409); `illegal_transition` for an option with a blocker. | A.7 has the first; nothing fits a conflicting batch. |
| A stale decision's fate | `invalidated`; the next generation raised if the question stands. | D1 §4.6. |
| An invalidated effect | The local transition is withdrawn; a proposal returns to `classified` or `awaiting_human`. † | D1 §10.5 invalidates the intent and raises the next generation; A.5 has no edge back from `approved`, and without one the proposal could never be approved again. |
| `intent.recorded`; `effect_intents.preconditions` | Section 76. | The interval between consumption and effect cannot be reached otherwise. |
| What Stop and Abandon bind † | Section 80. | E25 item 4, and Plan M48's "intervening git operation". |
| Stop of a quarantined run | 409 `quarantined`. | D1 §11.5; the slice-2 review left the choice to this slice. |
| The batch route's body and refusal | Section 81. | D1 §11.4 names the route. |
| The notification sink † | A program in the scripted directory with `deliver` and `lookup`; two barriers. | Build spec §8: "a local sink that can succeed, fail or leave delivery unknown". A program the test owns counts deliveries independently of the engine. |

## 85. What stands behind these tests before the engine exists

As section 64 says of slice 4: the sources and a reading of the tests. None was run. Each file was checked for syntax, and every name it imports was resolved against the module that exports it. Two pieces with logic of their own were exercised directly, outside any test: `protectedFingerprint` against a scratch repository (the files under the roots, sorted; unchanged by a change outside the roots; changed by a change to the governed file; the fingerprint of `[]` for an empty set), and `scripted/notify.mjs` as a process (each of its three delivery behaviours and three lookup answers, and its log). No shared helper of slices 1 to 4 was changed: `gates.mjs`, `decisions.mjs`, `scripted/notify.mjs` and `../contract/decisions.json` are new files. The frozen self-check was neither extended nor run.

The cases are few by decision (E31), and several pin a name this file fixed rather than one the sources give. A defect in a test, or a name the Builder finds unworkable, goes through the objection procedure.

---

# Slice 7: the journey

## 86. The journey adds nothing

Section 86 was written with the slice-7 acceptance test (2026-10-02): row M01, `M01-kernel-journey.test.mjs`. It fixes no name and asks for no route, fixture, barrier, table or column that sections 1 to 85 do not already give. The procedure is E31's: one file, the fewest cases, no stand-in engine, no self-check. The file was checked for syntax and every name it imports was resolved against the module that exports it. It was not run: it needs slice 5.

**What the journey uses,** in its order: `POST /v1/projects` (section 27); the plan fixture with a requirement, and the checks fixture (section 67); a scripted Builder's run, its commit and its integration (sections 28, 30); the T2 nomination and the verification work it registers (section 42); the chain boundary's `continue` (section 40); a scripted Reviewer's sign-off, on work the trigger fixture makes (sections 15, 68); the check-result and environment fixtures (section 67); the two gate routes and the authorization route (sections 70, 75); `GET /v1/projects/:p/runs/:r` (section 17).

**Three combinations no earlier test makes.** Each follows from the sections named; none is a new rule.

- The plan, checks, check-result and environment fixtures are applied to a project created through `POST /v1/projects`, where the slice-5 tests use the project fixture. Such a project has its lineage and its first protected version (sections 42, 66).
- The checks fixture is called before the project has a candidate. It declares checks of the effective protected version, whatever candidates exist (section 67).
- The Reviewer's sign-off is recorded before the check's execution is. It still counts: a sign-off is bound to the acceptance content hash, which holds the source revision, the protected fingerprint, the delivered requirements, the required checks and the sensitivity categories, and no check result (section 70; D1 §3.4).

**What the row names and the seam does not reach** is in `../COVERAGE.md`, under row M01: the event history read over HTTP, a candidate read, and engine-made review work.
