# The test seam

**Owner:** the Verifier (build spec §4). **Written:** slice 1, 2026-10-01. **Amended:** 2026-10-01, after the slice-1 review (section 11). The owner's decisions on that review are cited below as E23, the erratum that records them. **Extended:** slice 2, 2026-10-01 (sections 12 to 20, and the amendments to sections 1, 6 and 7 that section 20 lists). **Amended:** 2026-10-01, after the slice-2 review (section 22 lists every change; the owner's decisions on that review are E25), and 2026-10-02, after the second (section 23; E27). **Extended:** slice 3, 2026-10-02, by the first of its two Verifier sessions (section 24: what the final slice-2 review carried forward, E28 and E29; sections 25 to 38: rows M19 to M25 and the slice-3 cases of earlier rows that concern snapshots, validation, commits and integrity). **Extended:** slice 3, 2026-10-02, by the second of its two Verifier sessions (sections 39 to 51: rows M26 to M34, and the slice-3 cases of rows M04, M09, M12 to M15 and M24 that pass through an integration; one flag added to section 1). **Extended:** slice 4, 2026-10-02 (sections 52 to 64: rows M59 to M67 and the slice-4 cases of rows M02, M04, M12 and M61; one exit status added to section 1). **Extended:** slice 5, 2026-10-02 (sections 65 to 85: rows M35 to M58 and the slice-5 cases of rows M08, M09, M12, M24, M27, M61, M62, M64 and M65; section 65 lists what it changes in earlier sections; one sentence added to section 31 for the slice-3 review). **Extended:** slice 7, 2026-10-02 (section 86: row M01, the journey, which adds nothing to the contract). **Extended:** M2 slices 1 and 2, 2026-10-03 (sections 99 to 112), M2 slice 12, 2026-10-03 (sections 132 to 142: rows M119 to M128), and M2 slice 10, 2026-10-03 (sections 113 to 121: rows M101 to M109, the kernel lane of the trust table), and M2 slice 11, 2026-10-03 (sections 122 to 131: rows M110 to M118, the sandbox lane's boundary; amended the same day after the slice-11 review: the section "Amended after the slice-11 review" lists the changes). Later slices extend it; a change to anything below is made by a Verifier session, normally in answer to an objection.

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

- That production code never branches on what a seam function returned. The inspection cannot tell a hook from a question about the mode: a seam export that reports the mode under another name and is only ever called passes all three rules (the harness self-check pinned this limit while it existed; section 21). The behaviour is observed from outside by row M08, "the test seam is unreachable outside harness mode".
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

The harness gained one capability for these: `rawRequest` in `engine.mjs` now reports interim (1xx) responses and can hold a body back until `100 Continue` arrives. The self-check of slices 1 to 3 checked it against a byte-level server (section 21).

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

**The self-check and the witness engine no longer exist.** Through slice 3 the directory `harness/selfcheck/` held a harness self-check and a stand-in ("witness") engine. E31 froze them from slice 4 on, and they were deleted in the Verifier pass after slice 6 was verified; they are in git history (present on `main` at commit `bd43265`). Nothing is to be run or extended in their place. This section and sections 22 to 24, 38 and 51 record what stood behind the tests of slices 1 to 3 when they were written, and the file names they give under `selfcheck/` are of that directory.

Build spec §8 warns that a test written before its engine cannot be shown right by running it. For slice 2 the harness self-check (`selfcheck/run.mjs`) did what could be done without the engine:

- every helper with logic was run against something real: the case generators against mutants of the contract table, each store assertion against a witness store and one mutant per defect, the role program launched as a process, the HTTP helpers against a stand-in;
- every slice-2 test file was run against a **witness engine** (`selfcheck/witness-engine.mjs`), a single-file stand-in that did what sections 12 to 18 ask. Every test passed against it, so the tests and this file did not contradict each other;
- the witness had defects that could be switched on one at a time (`selfcheck/witness.mjs` listed them). With each one on, the test meant to catch it failed.

The witness engine was not the engine, not a design for it and not a contract. It kept no transaction discipline, journaled nothing it could recover, ran its store on the main thread, and took its legal transitions from the Verifier's own table. The Builder builds from the sources and from this file. A run against a stand-in can never count as an acceptance run: when the harness is pointed at one (the environment variable `SURETY_WITNESS_ENGINE`, which `engine.mjs` still reads), every test file gains one test that fails.

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

**What the harness gained.** The role program (`scripted/child.mjs`) has one new script step, `{"descendant": {"holds_stdout": <bool, default true>, "on_term": "exit" | "ignore"}}`; the head of that file documents it. It starts the program again in descendant mode: a process of the role's process group that carries the role's domain marker, outlives the role and, unless told otherwise, keeps the role's stdout open. The role logs a `descendant` entry for it; `Scripted.descendants()` reads the entries and `killStrays()` kills what is left. `runs.mjs` gained `scriptedEngine(t, {homeSymlink: true})`, `unownedWorktrees`, `worktreeOperations` and `resolvedPath`; `git.mjs` gained `plantHook`. `invariants.mjs` no longer counts the `work.resumed` of a lifted dispatch hold as a step of an item's path. The self-check exercised each, and the witness engine had one defect for each new case (section 21: both are deleted since).

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

**What the harness gained.** The role program (`scripted/child.mjs`) has one new step, `{"close_stdout": true}`, which closes the role's stdout for good while the role goes on, and `{"stdout": <text>}` is now documented as writing its text with no line ending added. `scripted.mjs` gained `step.stdout`, `step.closeStdout`, `RESULT_LINE` and `script.completeUnterminated`. `git.mjs` gained `plantFsmonitor`. `../contract/run-lifecycle.json` gained `lease_expiry`. The self-check exercised each, and the witness engine had one defect for each new or changed case (section 21: both are deleted since).

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

**What the harness gained.** `endings.mjs` (the drivers for the ten endings, `projectFacts`, `assertEndingExpectations`, `matrixCells`, the lazily produced reference). In the role program: the exit that drops nothing; `{"stdout_fill": {"bytes": n}}`; a descendant's `chatter_ms`; and the file and git steps the slice-3 rows use (section 26). `scripted.mjs` gained `step.stdoutFill`, `step.writeFill`, `step.delete`, `step.rename`, `step.symlink` and `step.git`. The self-check ran each against something real (`selfcheck/slice3.mjs`), and the witness engine, which then retried a failed run end as this section says, had one defect for each kind of failure the cases are meant to catch (`selfcheck/witness.mjs`). Both are deleted since (section 21).

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

**No remote** (the slice-4 review; E37 item 1; `M23-partial-clone-no-remote.test.mjs`, listed under slice 4). This section used to say that no git call M1 makes can reach a remote, because M1 has no remote operation. That was false. The engine asks for no remote operation, but git performs one by itself: in a partial clone, any git command that needs an object the repository does not hold fetches it from the remote, and to do so runs the program the repository's configuration names as that remote's upload-pack (`remote.<name>.uploadpack`). The slice-4 engine did so when it created a workspace. What the engine must guarantee instead:

- **no git command the engine spawns contacts a remote**, whatever the repository's configuration says about remotes, promisors and partial clones;
- **none runs a program that a remote's configuration, or configuration git consults in order to reach a remote, names**: an upload-pack or receive-pack program, `core.sshCommand`, a credential helper, `core.askPass`, a remote helper, a proxy command;
- **for engine git an object that is not present in the repository is missing.** It is never fetched.

How the engine makes git behave so is its own choice. (One fact about git that bears on the choice, observed with git 2.43: a `-c remote.<name>.uploadpack=…` override does not replace a value the repository's configuration gives; for that key git keeps the first value it reads.) **A partial clone is therefore not supported in M1**, like a repository that needs a filter driver: where every object a run needs is present, the run takes its ordinary course; where the base of a run lacks an object, the workspace cannot be made, and that is section 35's worktree add that does not succeed: no role is launched and the run ends `failed` / `infra_error`, as it does on any repository with that object missing.

The one case is on a blob-less clone (`git clone --filter=blob:none`) whose `remote.origin.uploadpack` names a program that leaves evidence and then serves the fetch. It first shows that ordinary git, asked for an absent object, runs the program and fetches the object. Then, with a blob of the integration branch's commit absent: the program is not run, every object that was absent is still absent, no role is launched, the run ends `failed` / `infra_error` and the integration branch has not moved. The blob is then written into the object store by hand, and the item's next run is committed and integrated, with the program still not run and a blob that only the history needs still absent.

Not reachable from any git call M1 makes, and so not pinned: merge drivers (no merge; a rebase is row M28's).

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

As in section 21, and like it a record of what was done then: the self-check and the witness engine are deleted since. The helpers with logic were run against real repositories and witness stores (`selfcheck/slice3.mjs`); every test file of this session was run against the witness engine, which was extended to do what sections 25 to 35 ask, as plainly as it could (`selfcheck/witness-git.mjs` held its git side, `selfcheck/witness-slice3.sql` its tables), and passed there; and for every case the witness had a defect that made that case fail (`selfcheck/witness.mjs`). The witness engine was still not the engine and not a design for it: its journal was rows written around synchronous git calls, it recovered nothing it journaled, and its integrity was a handful of comparisons. The part-1 cases were run against the slice-2 engine (section 24). Of the 84 cases of sections 25 to 35, 83 fail there at their first slice-3 step, which shows nothing about them; one passes, the git call killed at its deadline (section 34), which the slice-2 engine already does for the one git effect it has.

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

From slice 5 a stage's work is complete only when its `stage` gate is satisfied (section 70 states that rule), and a `fix` only when the finding it fixes is resolved (section 74; E36 item 4): the paragraph above then holds for both kinds as far as `verifying`, where the completion of the candidate's `verification` item leaves them. The cases changed with the gate (`../COVERAGE.md`): where they asserted a Builder's work `complete` they now assert `verifying`.

**A chain of roles** (D1 §8.1 step 8; D1-34; E24 item 1). A run is chained when it is dispatched for work that a previous run's outcome created. In slice 3 two outcomes create work: a nomination that follows a Builder's run creates the candidate's `verification` item, and the integration of a committed plan creates its stages' `stage_build` items. From slice 5 there is a third: the `review` item the engine queues for a candidate once its verification has completed with its required checks passed (section 70; E36 item 3), which follows the Verifier's run as the verification follows the Builder's. With E43 there is a fourth: the `fix` item the engine registers when a Reviewer's run reports a `fix` disposition (section 74), which follows the Reviewer's run. Work created by a fixture or a person, the repair of a failed run and a Resume are not chained. `max_chained_roles` counts the roles of a chain, the first included; a run that is not chained starts a chain of one.

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

**The integration of a fix that names a finding is a cadence point too** (with E43; row M01's second path; section 84, the owner's question). At T2 and T3 the engine nominates when the integration of a `fix` item whose `subject.finding` names a finding is finalized, `nominated_by` `engine_cadence`, as it does for a stage. That is the fix's own candidate (E43): the one whose evaluation can resolve the finding and complete the fix (section 74), which at T2 no Builder's request can bring about (D1-18) and which E11 requires before any deployment gate. A `fix` item that names no finding (the trigger fixture's, rows M09 and M27) is nominated at T2 by nothing, as before: a Builder's request on it is still no nomination. At T1 the rule is unchanged: a fix is nominated on its Builder's request, whether or not it names a finding (row M42).

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

**A process of another engine home is never signalled** (E41 item 1; the slice-5 review's finding; row M31). What an engine may end are the processes of its own home: those it started itself, and those an earlier incarnation of the same home started and left behind (the paragraph above). Every other process on the machine is somebody else's, whatever it carries. A git child of an engine that has another home is not signalled: not when this engine reconciles a journal operation, not at a tick, not at its restart, and whether or not that other engine is still running. It follows that carrying what an engine gives its git children does not make a process this engine's: every engine gives its children the same kind of thing, and two engines on one machine must tell theirs apart. A process belongs to a home only if an engine of that home started it.

The test starts a second engine, in a home and on a repository of its own, holds one of its git reads, reads the environment that child carries, and starts a process that only sleeps with exactly that environment. Neither engine started it. That process must be alive after the engine under test has made an ordinary policy change and ticked, has built, committed and integrated a run, and has been killed and restarted. How an engine knows its own home's processes is the engine's: the test names nothing in the environment it copies, and the earlier case, that an engine accounts for the children of its own home's dead incarnation, stands as it was.

## 47. Stop and Abandon while the work is integrating or integrated

(D1 §§4.5 step 4, 8.3, 8.4; rows M13, M14; `../contract/work-items.json`.) A Stop or an Abandon is admitted while the run is `validating`, with its work `integrating` or `integrated` (sections 17 and 24 covered `claimed` and `executing`). The run's lease is closing when the command is answered. The run is not ended while an operation it issued is in flight: issued effects are reconciled first.

- **An integration whose effect has not been made is not made.** An effect on behalf of a closing lease is refused: the ref update's journal is `intended`, `failed`, its status `failed`, its attempt (if one was issued) `failed`; the branch and the registry are where they were. Nothing is undone: the run's commit stays recorded and reachable from its keep ref.
- **An integration whose effect was made is recorded and finalized**, by the attempt that made it (one attempt; the swap is not repeated): the branch has moved, the registry expects it there, and the work is `integrated` by the finalizer before the command's own transition.
- **Then the command takes its course.** Stop: the run ends `stopped` / `human_stop`, workspace retained, the work `held` (`integrating → held`, or `integrating → integrated → held`); usage observed before the Stop is kept; an explicit Resume gives the work a new run, linked by `parent_run`, which starts from whatever the branch then holds. Abandon: the workspace is removed through the journal, the run ends `abandoned` / `human_abandon`, the work returns to `eligible` under the dispatch hold (`integrating → eligible`, or `integrating → integrated → eligible`). What was integrated stays integrated: an Abandon discards a workspace, not history.

The tests hold the integration at `journal.ref_update.intent_committed`, `effect_applied` or `finalizer_committed` with a paused barrier, send the confirmed command, require the run not ended a second and a half later, and release the barrier.

**`verifying` is owned by no run of the work.** When a Builder's work is being verified its own run has ended (Stop on it is `illegal_transition`), and the run under way belongs to the candidate's `verification` item. Stopping that run holds the verification item and leaves the Builder's work `verifying`; a resumed verification that completes then completes it. (From slice 5 that last clause holds for neither kind: the Builder's work is still `verifying` when the resumed verification completes. A stage's work is completed by its `stage` gate, section 70, and a `fix` by the resolution of its finding, section 74.) The table's Stop and Abandon edges from `verifying` are therefore not reachable through a run in slice 3 (`../COVERAGE.md`).

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
| A git child of a dead engine | By full mode: gone, or the operation blocked. How children are found is the engine's. Only processes of the engine's own home are ever signalled (section 46, the last two paragraphs; E41 item 1). | The review's finding; either answer closes the window. |
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

As in sections 21 and 38, and like them a record of what was done then: the self-check and the witness engine are deleted since. The witness engine was extended to do what sections 39 to 48 ask (`selfcheck/witness-journal.mjs` held its journal, attempts, probes and recovery; `selfcheck/witness-slice3b.sql` its tables), every file of this session passed against it, and for every case it had a defect that made the case fail: one mutant entry per probe cell, per crash cell and per fault-matrix cell among them (`selfcheck/witness.mjs`). `selfcheck/slice3b.mjs` checked the tables for the properties the cases rely on (the transition table is closed and carries correction 14; no outcome lets a conflicting or unknown effect proceed; the derivation gives a status for every combination), ran every hand-built git state against real git, and ran the operation reads against witness stores with one unsound history per assertion.

Two things found on the way, both in the harness and neither about the engine. `holdGit`'s release could leave the held git call waiting for ever: git reads its configuration more than once, and the second read could arrive while the pipe was still under the name (10 of 40 releases hung before the change; `repos.mjs` now renames the file into place first). And the fact that says whether a registered ref is where the registry expects it was worded so that the expectation accepted both answers; the self-check for it found that.

The witness was still not the engine and not a design for it: it ran its git synchronously inside one process, found a dead incarnation's children by a marker in their environment, froze a finalizer's inputs in a column of its own, and knew nothing of gates. Against the slice-2 engine on `main` every case of this session fails at its first slice-3 step, which shows nothing about the cases.

---

# Slice 4: ledger, records, backup and power loss

Sections 52 to 64 were written with the slice-4 acceptance tests (2026-10-02): rows M59 to M67, and the cases of rows M02, M04, M12 and M61 that earlier slices left for this one. They follow D1 §§3.6, 6.5, 6.6, 13, 14 and 16.2, E16b and E16c, with build spec §6 correction 21. Where those left something open, the choice is listed in section 63.

**The procedure changed with this slice** (E31). Nothing stands behind these tests but the sources and a reading of the test: there is no stand-in engine and no self-check for them, and the frozen one under `selfcheck/` was neither extended nor run (it was deleted later; section 21). The cases are few, by the owner's decision: one test per row, and a separately reported case only where the Plan names a finite case set. Only the five shim cases of row M67 were run, because only they need no engine (section 60). A defect in any other test will show during the build and goes through the objection procedure (build spec §4).

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

**A usage observation that cannot be recorded** (the slice-4 review; E37 item 3). An observation whose store write fails is never dropped: a dropped observation is usage the ledger does not hold and a budget stop that does not happen, while the ledger says the usage is complete. The engine retries the write for the bounded time it retries a result's (section 61). After a write that failed once, the durable facts are those of the same run with no failure (the rule of E28 item 1 and section 24): the observation is stored once, a run that passes a limit on it is stopped as "The enforceable boundary" says, and the ledger holds the usage. The one case is the first budget case's over-limit run with `before_event` armed once on `invocation.usage` (section 61): the role sends the one observation that takes the run over `budget_run_billable_tokens` and waits, and within a minute the run has ended `stopped` / `budget` with that observation stored once, the ledger row holding it with `usage_complete` 0, and the work parked for `budget_run_billable_tokens`.

If the write still fails when that time is up, the run does not go on unmetered. The engine ends it through the run-end protocol as it ends a run under way whose budget cannot be read, `stopped` / `budget` with its work parked behind a blocker, and the invocation's ledger row has `usage_complete` 0: what the role used is not all known. No case pins this, and the blocker's reason for it is not named here.

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

**A secret as the role's output encodes it** (the slice-4 review; E37 item 2). Roles write JSON lines, and a JSON string escapes some characters: a held secret with a quote or a backslash in it is on the role's standard output with `\"` or `\\` in their place, so the secret's own bytes are not there, and a match on bytes alone lets it through to the transcript and to the API. Redaction covers a secret in the form the output carries it. A line of the role's output that parses as JSON is redacted on its decoded values; any other line is redacted as bytes; a line in which nothing is redacted is retained byte for byte, as section 56 says. Neither a held secret nor its JSON-escaped form (what `JSON.stringify` gives for it, without the enclosing quotes) is in any file under the engine home or in anything the API serves. The one case holds two secrets, one with a quote and one with a backslash, and sends both in the `summary` of the role's result line; the summary's text around them is retained in the transcript. Other encodings of a secret (a `\u` escape of a character that needs none, base64) are not pinned.

**A later hit.** A stored record that a detector matches gets `post_scan` `hit`, and one `record.secret_found` event (`subject.record`, `subject.project`). It is no longer served, by any route (the slice-6 review; E42 item 1): the record read is refused (`record_quarantined`, section 56), and so is the output tail of the run whose transcript it is (section 92). Records the detector does not match stay `clean` and served. The Critical finding D1 §14.2 raises, and the quarantine of evidence and gates that depend on the record, are slice 5's.

## 58. Retention, and bytes that are missing or corrupt

(D1 §14.3, §16.1 step 5.) A record is retained while something live refers to it. In slice 4 the one such thing is a run whose work item is not terminal (`complete` or `cancelled`): the records of a `held` item's run are retained however old they are. Decisions, findings, gate evaluations, effect intents and journal entries refer to no record before slice 5.

**Expiry.** A published record nothing refers to expires once `record_retention_days` have passed (default 90). The test lets the whole period pass in one jump of the clock after the record's work is over, so it does not pin whether the days count from the record's publication or from the moment nothing referred to it. The tick performs it: the file is removed, the row is kept with `path` null and its `id`, `kind`, `sha256`, `bytes` and `published` as they were, and `record.expired` is emitted (`subject.record`). Reading it is **410** `record_expired`.

**The audit at startup.** The `recovery` step checks every published, unexpired record that something refers to: a file that is missing, or whose bytes do not have the recorded hash, gets one `record.missing` event (`subject.record`), before the engine reaches full mode. The engine reaches full mode all the same. Reading such a record is **409** `record_missing`. That its dependent gates report `EVIDENCE_MISSING` is slice 5's.

## 59. Backup and restore; a repository that moved

(D1 §§6.5, 11.6.) `surety store …` commands run against `$SURETY_HOME` while no engine holds it. The tests run them as `node packages/engine/dist/cli.js store …` with section 1's environment.

**`surety store backup [--database-only]`.** Exit status 0 (except as "A backup that cannot be complete" says, below), and on stdout one last line that is a JSON object `{"backup": <the directory it wrote, absolute>, "label": "complete" | "incomplete_for_recovery"}`. The directory is under `$SURETY_HOME/backups/` and is self-contained apart from the git objects: it can be copied elsewhere and restored from there. It holds `manifest.json`:

```json
{"label": "complete",
 "store": {"file": "store.db", "sha256": "…", "bytes": 0},
 "records": [{"id": "rec_…", "file": "records/…", "sha256": "…", "bytes": 0}],
 "git": [{"project": "proj_…", "objects": ["<commit id>"]}]}
```

`file` paths are relative to the backup directory. `store` is a consistent snapshot of the database. `records` lists every published, unexpired record the snapshot refers to, each copied into the backup. `git` lists, per project, the commits the snapshot refers to (every `revisions.sha` at least); they are not copied: the engine keeps each reachable in the repository from a ref it has registered (section 28), so that a garbage collection does not remove them. With `--database-only` only the snapshot is written, and the label, in the manifest and on stdout, is `incomplete_for_recovery`.

**A backup that cannot be complete** (the slice-4 review; E37 item 4; E32 item 6). A backup is labeled `complete` only if every commit its manifest lists is in its project's repository when the backup is taken. If one is not (someone deleted the ref that kept it and pruned), a backup asked for without `--database-only` is refused: exit status **7** and section 1's one-line refusal on stderr with `code` `backup_incomplete`. It could not be restored, so nothing it leaves says `complete`: whether the command leaves a backup directory behind is not pinned, and if it leaves one, or names one on stdout, the label in the manifest and on stdout is `incomplete_for_recovery`. The one case removes a checkpoint commit from the repository while the engine is stopped (its refs deleted, the reflog expired, `git prune`) and takes a backup.

**How a commit is confirmed** (the slice-6 review; E42 item 2). Whether a listed commit is in the repository is what git says. The engine asks git, under `git_deadline` like every git call (section 34), whether the object is there and is a commit. It does not read a repository's object files itself: those are files a role can write, and a second reading of them inside the engine is not git's. A commit git confirms is confirmed. Every other outcome leaves it unconfirmed: git answers that the object is absent; git answers that what is there is not that commit (a loose object whose content does not have the hash its name is, which `git cat-file -e <id>^{commit}` refuses and `git cat-file -e <id>` does not); git has not answered when the deadline passes. Unknown is not present. A backup with an unconfirmed commit is not `complete`, whoever takes it: the command refuses as above, and the running engine's backup ends as section 93 says. The label follows git in the other direction too: where git confirms every listed commit, the backup is `complete`, whatever else lies in the repository.

**`surety store restore --from <backup directory> --bind <project id>=<repository path>`**, one `--bind` per project, into a `$SURETY_HOME` that has no store (it may hold a `config.json`). The command verifies the whole closure before it writes anything: the label, every member's presence, length and hash, and that every listed git object exists in the repository bound to its project. Then it installs the store and the records and records each project's repository path as bound. Exit status 0. An engine started on that home goes through recovery and integrity as on any start and reaches full mode; the API token is that home's own.

A restore that cannot be verified is refused with exit status **7** and section 1's one-line refusal on stderr, and leaves no `store.db` in the home:

| `code` | When |
|---|---|
| `backup_incomplete` | a member is missing, a member's length or hash differs, a listed git object is missing from the bound repository, or a project has no binding |
| `incomplete_for_recovery` | the backup's label says it is a database-only copy |

Not pinned: the name of a backup directory; the scheduler's daily backup and `backup_keep` (the backup a running engine takes when asked, and `engine.backup`, are section 93's); `surety store export` and `import`; what a restored engine does about workspaces, which are not part of a backup; that a store command is refused with status 3 while an engine holds the lock.

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

The `before_event` fault of section 7 is armed in slice 4 on `git.journal_intended` (while it keeps failing, a dispatch makes no worktree and launches nothing), on `run.validating`, and, once, on `invocation.usage` (section 55, "A usage observation that cannot be recorded").

**A result whose recording keeps failing** (E27; E30 item 9 retries one failure). When the transaction that records a role's valid result fails every time, the engine stops retrying within a minute and ends the run `failed` / `infra_error` with a `reason_text` that says the result could not be recorded. The result is not lost silently: the run's transcript, published as for any run, holds the line the role sent. The work is repaired like any failed run's, one repair attempt charged.

**Public routes added:** `GET /v1/projects/:p/ledger` (section 54), `GET /v1/projects/:p/records/:id` (section 56), `POST /v1/projects/:p/rebind` (section 59). **Commands added:** `surety store backup`, `surety store restore` (section 59), with exit status 7 for a restore that is refused and for a backup that cannot be complete.

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
| A base that lacks an object (the slice-4 review) † | Section 31, "No remote": never fetched; the run ends `failed` / `infra_error`, never launched. | E37 item 1: "an object that is not present is missing". Section 35 already says what a worktree add that does not succeed leaves. |
| The forms of a secret (the slice-4 review) | Section 57: the secret itself and its JSON-escaped form. | E37 item 2. Roles write JSON lines; no other encoding is in a protocol line a scripted role sends. |
| A usage observation whose write fails (the slice-4 review) | Section 55: retried like a result's; after one failure, the facts of the run with no failure. | E37 item 3; E28 item 1. |
| A backup that cannot be complete (the slice-4 review) † | Section 59: exit status 7, `backup_incomplete`; anything it leaves is labeled `incomplete_for_recovery`. | E37 item 4; E32 item 6 gives status 7 to an incomplete backup; the code is the one a restore gives for a listed git object that is missing. |

## 64. What stands behind these tests before the engine exists

Less than before, by decision (E31). The shim is the one piece with logic of its own, and it is tested: the five cases of section 60 pass on the host these tests were written on (git 2.43, the pinned driver, ext4). It was also loaded once into the slice-2 engine on `main`, outside any test: the shim was in the engine, in each git the engine started and in the role; after a cut the store held the dispatch that had been committed; the workspace made since the session began was empty; and the engine refused to start again, because its `engine.lock` is written and renamed without a sync and was therefore empty. That last observation is the first thing row M67 will ask of the build.

Every other file was checked for syntax, and its imports and names were resolved against the harness; none was run, since each fails at its first slice-4 step on an engine that has none. The shared helpers that changed (`fx.start({env})` in `runs.mjs`; new steps and helpers in `scripted.mjs` and `scripted/child.mjs`; `clearFaults` in `engine.mjs`; `seedStream` and `seedChunkReceipt` in `seed.mjs`) are additions, and `M02-dispatch-identity.test.mjs` was run on the slice-2 engine afterwards and passes. The frozen self-check was not run and is not known to pass or fail with them.

**After the slice-4 review** (E37 items 1 to 4). Four cases were added, one for each defect the review confirmed: sections 31 ("No remote"), 55 ("A usage observation that cannot be recorded"), 57 ("A secret as the role's output encodes it") and 59 ("A backup that cannot be complete"). Unlike the rest of this slice's tests they were written with the slice-4 engine built: each was run against it and fails on its own assertion, and the other cases of the three files that already existed still pass. No harness helper changed. The filter-driver race of E37 item 5 has no case, by decision.

---

# Slice 5: the protected path, gates and decisions

Sections 65 to 85 were written with the slice-5 acceptance tests (2026-10-02): rows M35 to M58, and the cases of rows M08, M09, M12, M24, M27, M61, M62, M64 and M65 that earlier slices left for this one. They follow D1 §§2.4, 3.3, 3.4, 5, 7.9, 9 and 10 with build spec §6 corrections 3, 4, 5, 8, 9, 17, 18 and 22, RN R1, R2, R4 and R7, Review B01, B03, B12, B18 and B19, and E13, E19, E25 item 4 and E30 items 1 and 16. Where those left something open, the choice is listed in section 84.

**What slice 5 changes in earlier sections.** Section 6's table: 202 answers a governed policy submission (section 66), and 409 gains `decision_invalidated`, `batch_conflict` and `quarantined`. Section 17: a confirmation taken while a run was `claimed` is good when it is `executing`, and Stop or Abandon of a quarantined run is `quarantined` (section 80); an answer may also be refused `decision_invalidated` (section 76). Section 27: a widening is not answered 200 (section 78). Sections 25 and 28: a Verifier's and a Reviewer's runs are validated (section 68). Section 40: a stage's work completes with its `stage` gate, not with its candidate's verification (section 70). Sections 32, 57 and 58: what an observation, a detector hit and missing bytes do to gates (section 72). The tests of slices 1 to 4 were not changed; `../COVERAGE.md` lists the ones whose assertions these changes make wrong.

The procedure is E31's, as in slice 4: the fewest cases that pin each row's required result, no stand-in engine, no self-check. None of these tests was run: every one fails at its first slice-5 step on an engine that has none. Two helpers with logic of their own were exercised directly (the protected fingerprint against a scratch repository, the notification sink program as a process); everything else was read, and its imports and names were resolved against the harness.

The expected table is `../contract/decisions.json` (the eleven enabled decision kinds, what each one's preview must bind, and the answer codes). `gates.mjs` and `decisions.mjs` are the test side.

## 65. What the slice-5 tests assume throughout

- **Candidates are made by runs, as in slice 3.** A case that needs a candidate builds a stage and has it nominated (`nominated` in `gates.mjs`). Most cases use tier T1, where a nomination is the Builder's request and no sign-off is needed; a later candidate of a T1 project is a `fix` whose Builder asks for a nomination (`successor`).
- **Observations are fixtures; reports are a role's.** Check executions, the classification of a protected diff, a validation-scope approval, a reuse entry, the evidence of an Alpha exception and a test target enter through harness routes and are labelled as test setup (section 67). M1 has no check runner and no classifier, and no test claims to qualify one (Plan §2). Findings, sign-offs, dispositions, severity changes, assessments and proposals are not fixtures: a scripted Verifier or Reviewer reports them in its result, as an agent would, and the engine records them (section 68).
- **Work a fixture creates for a role is not chained.** A `review`, `verification` or `check_correction` item made with the trigger fixture is dispatched at the next tick. The `verification` item a nomination creates still waits at the chain boundary (section 40) and is let through only by the cases that are about it; so the engine queues a `review` of its own (section 70) only in those cases, and where it does, that item waits at the boundary too. Likewise, since E43, every case in which a Reviewer's run reports a `fix` disposition leaves the engine's `fix` item waiting at the boundary (section 74): row M42's resolution case lets it through and builds it; its first case leaves it waiting, and the fixture fixes it builds beside it are dispatched as before (other work of the project is not held by that decision, section 40).
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

**A protected set that cannot be read** (E41 item 2; the slice-5 review's finding; row M35). The gate asks whether the protected set at the integration branch's commit is the effective version's. When the engine cannot read that set, because git does not answer within its deadline or the read fails, the question has no answer, and no answer is not a pass. The evaluation is made and recorded like any other and is answered 200 (section 70); it is `not_satisfied` and carries `PROTECTED_PATH_UNAUTHORIZED`: the protected path was not shown to be authorized. This holds at the `stage` gate and at `alpha_authorize` alike, and nothing a satisfied evaluation does happens: the stage's work stays `verifying` and no authorization is issued. The test holds the repository's git (`holdGit`, with `git_deadline` at 2 seconds) while both gates are evaluated for a candidate whose head carries an adopted, unauthorized set; neither gate was evaluated before the hold. Not pinned: whether the reason's `subjects` or anything else says that the set was unreadable rather than different, and whether `protected.unauthorized_detected` is emitted for a set that could not be read. The rule is general (section 72, "An input that could not be read"); this is the one input a case holds.

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
| `signoffs` | Reviewer | `[{"scope": "candidate" \| "module" \| "security", "module"?: <name>}]` | records one `signoffs` row each: `candidate`, `revision`, `role` `reviewer`, `scope`, `module`, `run`, and the `acceptance_content_hash` of what was reviewed, which is the content in force when the Reviewer's run was started (section 70, "Sign-offs"); `signoff.recorded`. |
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

**The report of a quarantined run is recorded like any other** (E41 item 3; the slice-5 review's finding; row M42). Such a run keeps the outcome it earned, so what its valid result reported is recorded as the table above says: findings, sign-offs and the other fields, whether the boundary reported its domain `terminated` at once, or `unknown` first and `terminated` later. The report is recorded no later than the transaction that completes the run's work item. At no moment is a `verification` item `complete` while a finding its Verifier reported is not recorded, so the `stage` gate the engine evaluates when the verification completes (section 70) counts that finding. The test: the Verifier of a candidate's own verification work reports a Critical finding; its domain is `unknown`, the run is quarantined with outcome `completed`, then the domain is `terminated`; the run ends `completed`, the work is `complete`, one finding is recorded (`open`, `critical`, the candidate, `source_run` the run), no evaluation of the candidate's `stage` gate is satisfied, the gate carries `FINDING_BLOCKING` and nothing else, and the stage's work is `verifying`. Whether the report is recorded when the run is quarantined or when the quarantine clears is not pinned.

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

**A satisfied `stage` gate completes its stage's work** (E30 item 16 ends here). A `stage_build` item that is `verifying` becomes `complete` in the transaction of a satisfied `stage` evaluation of a candidate that holds it, for its stage, and not before: the completion of the candidate's `verification` work no longer completes it. A candidate holds the work by ancestry (section 74, "Which candidate completes a stage's work"): after a fix, that is the fix's own candidate. The engine evaluates that gate by itself when the candidate's `verification` item completes, and each tick recomputes an evaluation that is stale (D1 §8.1 step 7); a test may also ask for the evaluation with the route above. So with a failing or missing execution the work stays `verifying` however many ticks run, and it completes at the first tick after a passing execution is recorded. A `fix` item has no stage and therefore no stage gate: it completes when the finding it names is resolved (section 74; E36 item 4), and the completion of its candidate's `verification` work does not complete it either. A satisfied `stage` gate issues no authorization and advances no candidate.

**Sign-offs** (D1 §9.3(6); F §5.7). T1 requires none. T2 requires the Reviewer's at candidate scope. T3 requires that, one at module scope for each module of the plan fixture, and one of scope `security` (the security review). A sign-off counts when its `acceptance_content_hash` is the scope's. While one is missing the evaluation carries `SIGNOFF_MISSING`.

**A sign-off binds the content its run was started on** (E41 item 4; the slice-5 review's finding; row M43; build spec §6 correction 14, inputs are frozen at intent). The hash a sign-off carries is the candidate's acceptance content as it was when the Reviewer's run was started, no later than its role's launch, and not as it is when the report is recorded. When the content changes while the run is under way, a sign-off that run then reports does not count toward the new content: an evaluation under the new content carries `SIGNOFF_MISSING`, and every `signoffs` row of the candidate carries the earlier hash. The test holds a Reviewer's run, has a tightening that adds a check approved and applied (a governed edit of `check_commands` through the policy route, classified, approved by the human), declares and passes the new version's checks, and releases the Reviewer. Whether a sign-off for content no longer in force is recorded at all, and what its run ends as, are not pinned.

**The engine queues the review a tier requires** (E36 item 3, which closes E35; rows M43 and M01). At a tier that requires a Reviewer's sign-off (T2, and T3 by the same rule; the tests use T2) the engine registers a candidate's review itself, once two things hold: the candidate's `verification` work item is `complete`, and every required check of the candidate is `passed` (section 71). It registers one `review` work item: `eligible`, `subject.candidate` the candidate, trigger `("verification", <candidate id>, 1)`; its `work.created` event does not carry `test_fixture`. It does so when the verification completes, if the checks have passed by then, and otherwise within the ticks that follow the execution that makes the last of them pass (the tests tick until the item exists). Until both hold there is no review: none at the nomination; none while the verification has not completed, whatever the checks say; none while a required check is failed or missing, however many ticks run. So a candidate whose verification fails gets no review. There is one review per candidate: further ticks, later executions and a restart register no second one. At T1, which requires no sign-off, none is registered.

The review is chained work (section 40): the engine created it on the outcome of the Verifier's run, whenever the checks came to pass. With the default `max_chained_roles` it is not dispatched: it waits at the chain boundary with one `blocker` decision offering `continue` and `cancel`, like the verification before it. Dispatched, it is a Reviewer's run like one on fixture-made work, and what its result reports is recorded as section 68 says. The trigger fixture can still make `review` work, and rows M42 to M44 and the decision rows use it; such work is not chained.

Not pinned (the owner's question, section 84): which required set counts where a candidate's `stage` scope and its Alpha scope differ (the tests declare one check that both require); what a candidate with an incomplete scope gets (no check declared: the T2 projects of slices 2 to 4, where nothing asserts either way); whether a T3 candidate gets one review or one for each sign-off it needs; and what becomes of a queued review whose check is later invalidated or fails again.

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
- **A gate that one of these two blocked is evaluated again when the block clears** (E41 item 5; the slice-5 review's finding; D1 §9.5; row M44). An observation that is reconciled, and a journal operation that reaches its end, make the evaluations they blocked stale, so the ticks recompute the `stage` gate as section 70 says, with nobody asking for it by its route. The test: a candidate's verification is complete and its one check has passed; an out-of-band commit on the integration branch is the only reason its `stage` gate carries (`OUT_OF_BAND_CHANGE`); the commit is discarded; within four ticks (four calls of the harness's `tick`) the stage's work is `complete` and the last `stage` evaluation is `satisfied`, and the test never asks for the gate after the discard. Only the discard of an observation of the integration branch is tested; `adopt`, `stash` and a journal operation that ends are the same rule with no case.
- **An input that could not be read** (E41 item 2; the standing rule that an unknown is not a pass). An evaluation that could not read one of its inputs, from git or from a record, is not satisfied, and carries the reason of the input that was not shown. The one case is the protected set (section 66, `PROTECTED_PATH_UNAUTHORIZED`); a record that cannot be read was already `EVIDENCE_MISSING` (below). Which reason an unreadable ancestry or an unreadable observation gives is not pinned.
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

**Dispositions a Reviewer reports** (`dispositions` in its result). `fix` is recorded at once: `status` `dispositioned`, `disposition` `fix`, `disposition_authority` `reviewer`, and no decision is raised (E43: asking to fix a finding relaxes nothing; E34 item 6's rule that the human approves a disposition stands for `accept`, `defer` and exclusions). `defer` of a finding whose current severity is Low is recorded with `disposition_authority` `reviewer`, `linked_issue` and `defer_target`. `defer` of a Medium finding and `accept` of any finding are beyond a Reviewer: the finding is left as it was and the engine raises a `finding_disposition` decision about it (section 77). `finding.dispositioned` is emitted when a disposition is recorded.

**The engine registers the fix work** (E43, which closes the gap E38 recorded; rows M42 and M01). In the transaction that records a `fix` disposition the engine registers one `fix` work item on the finding's project: `eligible`, `subject.finding` the finding (E38 item 6), trigger `("finding", <finding id>, 1)`; its `work.created` event does not carry `test_fixture`. So once the finding reads `dispositioned`, the item exists, with no tick in between. There is one per finding: further ticks and a restart register no second one (the trigger identity, section 15). Before the disposition there is none, however many ticks run. It is chained work (section 40): the engine created it on the outcome of the Reviewer's run, so at the default `max_chained_roles` it is not dispatched; it waits at the chain boundary with one `blocker` decision offering `continue` and `cancel`, its `blocker.reason` `max_chained_roles`, and no run, like the review the engine queues. That is the human's step (E43). Let through, it is a Builder's run like one on fixture-made `fix` work: at T1 its Builder asks for the nomination; at T2 its integration is a cadence point (section 42). The trigger fixture can still make `fix` work, naming a finding or not, and such work is not chained. Not pinned: whether fix work is registered for a finding that names no check (row M42's first case records such a disposition and reads no work item; section 74 says such a fix can never complete); a fix disposition the human approves from a proposal, which E43 says creates the work the same way, since no M1 path proposes `fix` to the human.

**Severity** (`severity_changes`). Any role may raise: `effective_severity` changes, `severity_history` gains `{"actor", "authority", "from", "to", "at"}`, and `finding.severity_changed` is emitted. A Reviewer may lower within the nonblocking range (Medium to Low), with `authority` `reviewer`. A lowering out of the blocking range (from Critical or High to Medium or Low) is not applied: the engine raises a `severity_lower` decision (section 77). No severity change alters a check state.

**Resolution.** A finding reported with `check` (a check key), dispositioned `fix`, is resolved by an evaluation for a candidate it applies to in which that check is `passed` by an execution recorded after the disposition: the finding becomes `resolved`, `resolution_verification` is `{"evaluation": <the evaluation>, "check_result": <the execution>}`, and `finding.resolved` is emitted; that evaluation does not count the finding against the gate. When the verifying execution is invalidated the finding returns to `open` and `finding.reopened` is emitted.

**A fix's work completes with its finding's resolution** (E36 item 4, which settles E34 item 2 and ends the interim rule of section 40; rows M09 and M42). A `fix` work item names the finding it fixes in `subject.finding`. It runs its path to `verifying` as section 40 says, and becomes `complete` in the transaction of the evaluation that resolves that finding, and not before. The completion of its candidate's `verification` work does not complete it. An evaluation in which the check the finding names has not passed does not complete it. Until then it is open work like any other: a failed run of it is repaired as section 15 says, and it can be stopped, parked or cancelled where `../contract/work-items.json` allows. The evaluation may be one a test asked for or one the engine made.

**Which candidate completes a stage's work** (E43; row M01's second path). The `stage` gate that completes a `stage_build` item (section 70) is a satisfied evaluation, for its stage, of a candidate that holds the work by ancestry: one whose revision is the stage's `integrated_revision` or a descendant of it on the lineage chain. The stage's first candidate holds it; so does the fix's candidate that follows a finding on the first, and after the fix it is that candidate's evaluation that completes the stage: the first candidate's stage gate, never satisfied (its finding blocked it and its sign-off was withheld), completes nothing. The journey pins it with one fix on one stage; which candidate completes a stage whose first candidate's gate was satisfied before a later fix is not pinned (such a stage's work is complete already).

Not pinned (the owner's questions, section 84): whether the engine sends a `verifying` fix back to its Builder when the named check fails on its candidate (nothing in M1 re-dispatches work on a check's result, a stage's included); what completes a fix that names no finding, or whose finding names no check (pinned only: its candidate's verification does not; every `fix` the trigger fixture makes is such an item, and none of them is awaited beyond `integrated` or `verifying`); and what a reopened finding does to fix work already `complete`. Who registers fix work for a finding dispositioned `fix` was open here until E43: the engine does (above).

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
| When the stage gate is evaluated, and what a satisfied one does † | By the engine when the candidate's verification completes and at ticks; it completes the stage's work. | E30 item 16 left the completion rule to this slice. |
| What completes a fix's work † | The evaluation that resolves the finding its `subject.finding` names, in that evaluation's transaction. Not its candidate's verification. | E36 item 4 (decided), replacing "`fix` work is unchanged" here. The questions it leaves are in section 74. |
| Who schedules a candidate's review † | The engine, at T2 and T3, once the candidate's verification work is complete and every required check is `passed`: one `review` item, trigger `("verification", <candidate id>, 1)`, chained. | E36 item 3 (decided). The trigger's name follows `("nomination", <candidate id>, 1)` for the verification; that the item is chained follows E24 item 1, and lets a test script the Reviewer before a person lets it run. The questions it leaves are in section 70. |
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
| *After the slice-5 review (E41):* the reason for a protected set that could not be read † | `PROTECTED_PATH_UNAUTHORIZED`, in an evaluation that is recorded and answered 200 (section 66). | D1 §9.3(2) names the input "protected path authorized", and that is what was not shown. A.4 has no code that says "unreadable"; a new one would be a name outside D1. |
| *After the review:* whose processes an engine may signal | Its own home's and no others; how it knows them is the engine's (section 46). | E41 item 1. The test copies what another engine's git child carries and names none of it. |
| *After the review:* when a quarantined run's report is recorded | No later than the completion of its work item; at the quarantine or at its clearance is the engine's choice (section 68). | E41 item 3: the run keeps its earned outcome and its report is recorded with it. |
| *After the review:* the content a sign-off carries | The acceptance content when its Reviewer's run was started (section 70). Whether a sign-off for content no longer in force is recorded is not pinned. | E41 item 4; correction 14. |
| *After the review:* how soon a cleared block is followed by an evaluation | Within four ticks, without the route (section 72). | D1 §9.5 says the evaluation becomes stale and §8.1 step 7 that a tick recomputes it; row M44 allows four ticks for a stale evaluation in its first case. |
| *With E43:* who registers fix work, and when | The engine, in the transaction that records a `fix` disposition: one `fix` item, `subject.finding` the finding, trigger `("finding", <finding id>, 1)`, not a fixture (section 74). | E43 (decided); E38 item 6 for the subject. The trigger follows `("nomination", <candidate id>, 1)` and `("verification", <candidate id>, 1)`, and gives the once-per-finding rule for free (section 15). |
| *With E43:* a Reviewer's `fix` needs no human approval | Recorded at once with authority `reviewer`; no `finding_disposition` decision (section 74). | E43's reading of E34 item 6, after the Builder found section 74 and E34 item 6 disagree: asking to fix relaxes nothing. |
| *With E43:* is engine-made fix work chained | Yes: it waits at the chain boundary for a `continue`, with no run (section 74). | E24 item 1: it is work a run's outcome created, like the review of E36 item 3; the boundary is the human step E43 names. The other reading, that a disposition the human approved creates unchained work, has no M1 path to test it by (section 74). |
| *With E43:* what nominates the fix's candidate at T2 † | The integration of a `fix` item that names a finding is a cadence point at T2 and T3 (section 42). A fix naming no finding, and a Builder's request, nominate nothing at T2, as rows M09 and M27 pin. | E43 needs "the fix's own candidate"; D1-18 forbids a Builder's nomination at T2; E11 requires a nomination before any deployment gate, and nothing else in M1 would make one for a fix in a one-stage project. Recommended; the alternatives are a fix that waits for an unrelated stage's nomination, or every fix integration at T2 nominating, which overturns two pinned cases. |
| *With E43:* which candidate completes a stage's work | The candidate that holds it by ancestry: after a fix, the fix's candidate (section 74). | E43 (the driver's reading, with the Builder's point). |
| *With E43:* who raises the journey's finding | The Verifier, in the first candidate's verification; the Reviewer proposes `fix` by the finding's id (section 86). | A `dispositions` entry names a finding by id (section 68), which a Reviewer cannot know for a finding in the same report. The alternatives, a result field that lets a finding carry its own disposition, or a second review made with the trigger fixture, were not needed; the first is a name for the owner to ask for if a Reviewer must do both in one report. † |
| *With E43:* the journey's finding is Critical | `FINDING_BLOCKING` at the stage gate and at `alpha_authorize` (section 74). | The one severity the seam pins as blocking at the stage gate; what a High finding does there stays not pinned. |

## 85. What stands behind these tests before the engine exists

As section 64 says of slice 4: the sources and a reading of the tests. None was run. Each file was checked for syntax, and every name it imports was resolved against the module that exports it. Two pieces with logic of their own were exercised directly, outside any test: `protectedFingerprint` against a scratch repository (the files under the roots, sorted; unchanged by a change outside the roots; changed by a change to the governed file; the fingerprint of `[]` for an empty set), and `scripted/notify.mjs` as a process (each of its three delivery behaviours and three lookup answers, and its log). No shared helper of slices 1 to 4 was changed: `gates.mjs`, `decisions.mjs`, `scripted/notify.mjs` and `../contract/decisions.json` are new files. The frozen self-check was neither extended nor run.

The cases are few by decision (E31), and several pin a name this file fixed rather than one the sources give. A defect in a test, or a name the Builder finds unworkable, goes through the objection procedure.

**After the slice-5 review** (E41; 2026-10-02). Five cases, one for each defect the review confirmed, each in its row's existing file: `M31-git-child-outlives-engine.test.mjs`, `M35-separate-governed-policy-file.test.mjs`, `M42-findings-dispositions-and-inherited-applicability.test.mjs`, `M43-severity-tier-and-independence-floors.test.mjs` and `M44-stage-gate-versus-alpha-authorization.test.mjs`. Sections 46, 50, 66, 68, 70, 72 and 84 were amended in place; no harness module was changed. Unlike the rest of the slice-5 tests these were run, each file by itself: against the slice-5 engine as the review saw it (`build/slice-5` merged with `main`, before any of the five fixes), where each new case fails on its own assertion and every other case of the five files passes; `../COVERAGE.md`, "After the slice-5 review", has what each failure said. The M31 case is exposed to the defect it pins: while an engine without the fix runs anywhere on the machine, that engine can kill the process the case plants, and the case then fails although the engine under test did nothing wrong.

---

# The journey: slice 5, and slice 7 for the same journey read through the API

## 86. The journey: a slice-5 target, read again through the API in slice 7

Section 86 was written with the journey's acceptance test (2026-10-02), row M01, and rewritten in place when the journey became a target of the slice-5 build (the Verifier pass after slice 6 was verified; the owner's response to the milestone review, which found that components had been proved before the complete workflow), and again when the journey gained its second path (E43, the same day). The first path fixes no name and asks for no route, fixture, barrier, table or column that the other sections do not already give; what the second path needed is in sections 42 and 74 and listed in section 84. The procedure is E31's: the fewest cases, no stand-in engine, no self-check.

**Two files, one journey, two paths.** `journey.mjs` makes the journey: `journey()` is the path where nothing goes wrong, `fixLoop()` the path with a finding (E43). Both begin with the same steps (`start()`, steps 1 to 5 below). Each file makes each path once, in the `before` hook of a group of its own, and each of their cases reads one clause of the row's required result from it.

| File | Listed under | What it reads the journey from | Needs |
|---|---|---|---|
| `M01-kernel-journey.test.mjs` (seven cases on the first path, four on the second) | slice 5, first in its list | the store, the repository, the scripted roles' launches, the run read (section 17) and the answers of the gate and authorization commands (sections 70, 75) | slices 1 to 5 |
| `M01-journey-through-the-api.test.mjs` (two cases on the first path, one on the second) | slice 7 | the event stream in replay pages (section 92), the project read and the decisions read (section 91), the candidate read (section 95) | slice 6 as well |

The first file is the central target of the slice-5 build: it is the one place where what slices 1 to 5 build is made to work together, from a project's creation to an issued Alpha authorization, and it needs nothing of slice 6. The second adds no behaviour. It is the same journey observed where a person would observe it, and it exists because the row's last clause, "API and event history agree with durable rows", could only be read from the store before slice 6 pinned the public reads. (The runner also refuses `--slice 7` when slice 7 lists nothing.)

**What the first path uses,** in its order: `POST /v1/projects` (section 27); the plan fixture with a requirement, and the checks fixture (section 67); a scripted Builder's run, its commit and its integration (sections 28, 30); the T2 nomination and the verification work it registers (section 42); the chain boundary's `continue` (section 40); the review the engine queues once the check's execution is observed, let through the chain boundary like the verification, and the scripted Reviewer's sign-off (sections 40, 68, 70; changed with E36 item 3: the journey made this work with the trigger fixture before); the check-result and environment fixtures (section 67); the two gate routes and the authorization route (sections 70, 75); `GET /v1/projects/:p/runs/:r` (section 17).

**The second path** (E43) is the first as far as the candidate's verification, and then: the Verifier of that verification reports a Critical finding naming the check (`findings` with `check`, section 68; the one severity section 74 pins as blocking at the stage gate); the engine queues the review as before; the Reviewer reports `dispositions` with `fix` for that finding and no sign-off; the engine records the disposition and registers the fix work in that transaction (section 74), which waits at the chain boundary; the stage gate asked for on the first candidate is `not_satisfied` with `FINDING_BLOCKING` naming the finding and `SIGNOFF_MISSING`, and nothing else; a person lets the fix through; a scripted Builder writes one source file (`FIX_EDIT`), and the engine commits it on the first candidate's revision, integrates it and nominates the fix's candidate at the fix's integration (section 42); that candidate's verification is let through (its Verifier reports nothing), and until its check is executed the finding is `dispositioned` and the fix `verifying`; the check-result fixture records the check passed on it, the engine queues its review, a person lets it through, and the Reviewer signs it off; the stage gate and the Alpha authorization are then asked for on the fix's candidate. At the end: the finding is `resolved` by a `stage` evaluation of the fix's candidate with that execution, once; the fix's work is `complete`; the stage's work is `complete` (section 74, "Which candidate completes a stage's work") and no evaluation of the first candidate's stage gate was ever satisfied; the one authorization, proposed for the fix's candidate, is `issued`; six roles were launched (builder, verifier, reviewer, twice over) and five chain-boundary decisions answered. The journey creates no work item but the plan fixture's stage; the review and the fix are the engine's, and it fails if either is missing.

Why the Verifier raises the finding and not the Reviewer (section 84): a `dispositions` entry names its finding by id, which a Reviewer cannot know for a finding in the same report. A result field that lets a finding carry its own disposition would be a new name; a second review made with the trigger fixture would be a fixture where E43 asks for none. The Verifier's `findings` and the Reviewer's `dispositions` are both section 68's as they stand.

**How a decision is found at a chain boundary.** In the slice-5 file, in the store (`openDecision` in `decisions.mjs`, which also checks the preview against the contract). In the slice-7 file, in `GET /v1/projects/:p/decisions`: the journey ticks until that read lists an open `blocker` about the waiting work, and answers it with the `id` and the `preview_hash` the read showed. So the slice-7 journey is one a person could make with the API alone, on either path: the fix's decision is found where the verification's and the review's are.

**Two combinations no earlier test makes.** Each follows from the sections named; none is a new rule.

- The plan, checks, check-result and environment fixtures are applied to a project created through `POST /v1/projects`, where the slice-5 tests use the project fixture. Such a project has its lineage and its first protected version (sections 42, 66).
- The checks fixture is called before the project has a candidate. It declares checks of the effective protected version, whatever candidates exist (section 67).

A third, a sign-off recorded before the check's execution, went with E36 item 3: the engine queues the review only once the check has passed, so in the journey the execution now comes first. The first stage-gate evaluation of the journey, made with the candidate verified and no execution on record, therefore lacks the check and the sign-off both (`CHECK_NOT_PASSED`, `SIGNOFF_MISSING`).

**What the slice-7 file reads, and how far that goes beyond the rows that own the routes.** Each route is pinned by its own row (M70, M72, M74). The journey's two cases compare what the routes show of one whole journey with the durable rows, and in doing so read four things those rows' own cases do not; each follows from the section named:

- every stored event up to the read is one message of the replay, in `seq` order, and its `data` holds the stored `seq`, `type` and `at` and the stored `subject` and `payload` as objects (section 92 says the data is the event; row M72 compares `seq`, `type` and the subject's project);
- a project whose work is all complete, with no run under way and no open decision, is `idle`, and its `spend_today.invocations` is the number of original ledger rows of the day, three here on the first path and six on the second (section 91; the journey is not started within two minutes of midnight UTC);
- while work waits at a chain boundary, the decisions read lists exactly the one open `blocker` about it, and at the journey's end it lists nothing (section 91);
- a candidate's `gates` entry for a kind is the latest stored evaluation of that kind, with the stored `outcome` and `stale` (section 95), and `protected_version.effective` is the project's effective version, here the one the candidate was nominated under.

The second path's one case in that file reads the same three things of the fix loop, and nothing new: the five decisions listed one at a time, the project idle with six invocations, and the fix's candidate with both gates satisfied.

**What stands behind the two files.** Both were run once against the slice-4 engine with `node --test`: both load, and both fail in their `before` hook at the plan fixture, which that engine has without requirements (`unknown_field`), as they must. `replayMessages` (`sse.mjs`) and the event comparison of the first slice-7 case were exercised outside any test, against a scratch server that served a real slice-4 store's events in section 92's wire form in pages shorter than asked for: 33 events, each compared field by field. Nothing else of the slice-7 file can be run before slices 5 and 6 are built. A defect in either file will show then and goes through the objection procedure.

**The second path, against the complete M1 engine** (E43; `../COVERAGE.md`, "With E43"). Both files were run with `node --test` after the second path was written: every first-path case passes as before; each second-path group fails in its `before` hook at "the engine registered fix work when the fix disposition was recorded (E43); the journey makes none", after the Verifier's finding and the Reviewer's disposition were accepted. The steps that engine can take were also run outside any test, with the trigger fixture standing in for the fix work: the stage gate asked for after the disposition carries exactly `FINDING_BLOCKING` (the finding) and `SIGNOFF_MISSING`; a fixture fix is committed and integrated on the first candidate's revision; and at T2 that integration nominates nothing, which is the cadence point section 42 now pins. The rest of the path cannot be run before E43 is built.

---

# Slice 6: the API, load and the contract

Sections 87 to 97 were written with the slice-6 acceptance tests (2026-10-02): rows M68 to M74, the unsafe-filesystem case E36 item 7 added (attached to row M67), and the cases of rows M64, M69, M71 and M74 that earlier slices left for this one. They follow D1 §§6.1, 11, 12, 14.2, 15.4 and 17 with build spec §6 correction 7, RN R6 and §3, Review B14, B17, N02, N03, N06 and §8.3, and E36 items 1, 2 and 7. Where those left something open, the choice is listed in section 96. The procedure is E31's: the fewest cases that pin each row's required result, no stand-in engine, no self-check.

The expected tables added are `../contract/load-limits.json` (the qualified load limits) and `../contract/filesystems.json` (the kinds of filesystem an engine home may not be on). The test side is in new modules only: `mono.mjs`, `boundary.mjs`, `browser.mjs` with `shell/`, `sse.mjs`, `stream-clients.mjs`, `load.mjs`, `reads.mjs`, `filesystem.mjs` and `launch-lint.mjs`. No module of slices 1 to 5 was changed.

## 87. What the slice-6 tests assume throughout

- **Time is monotonic.** The host these tests were written on steps its wall clock back by about 1.8 s every half minute (section 39). Every wait, deadline and duration of the slice-6 tests is taken from `performance.now()` (`mono.mjs`), never from `Date.now()`. Two timestamps of the engine's own clock are still subtracted from each other where a case is about the engine's clock (an observation ten seconds older than a read's `served_at`); no test compares an engine timestamp with the test's own clock.
- **Where engine homes are.** Under the system temporary directory, as before. From this slice the engine refuses a home on a memory-backed filesystem (section 88), so on a host whose temporary directory is one, the tests must be run with `TMPDIR` set to a directory on a disk filesystem; `M67-unsafe-filesystem-refused.test.mjs` says so when it finds the temporary directory on a refused kind.
- **Fixtures several cases read.** Rows M68, M70, M71 and M72 each build one engine that several cases read, the first time a case asks for it; a case that cannot have it fails with the reason. Row M71's store of one gibibyte is built once for its file (section 93).
- **Ticks happen when asked,** as in section 12; no slice-6 case depends on a timer tick.

**What slice 6 changes in earlier sections.** Section 1: two flags (`--harness-shell`, section 90; `--harness-home-fstype`, section 88), one more cause of exit status 6 (section 88), exit status 8 and the `surety contract` commands (section 94). Section 6: two more checks before a route is reached, and when `100 Continue` may be sent (section 89); 403 `origin_refused` and 413 `payload_too_large` join its status table; "every slice-1 route needs [the token]" now has two exceptions, the shell routes and the token bootstrap (section 90); a request with no `Host` header is answered by the engine (section 89). Section 17: the run read gains three fields (section 95). Section 56: what a record read refuses (section 91). The tests of slices 1 to 5 were not changed by this session.

**After the slice-6 review** (E42 items 1 to 3; section 97 says what was run). Section 57: a quarantined record is served by no route. Section 59: how a commit is confirmed. Section 92: the tail's refusal. Section 93: what `engine.backup` says of a backup that is not complete, a backup while a repository's git does not answer, and that a backup always ends; the load case no longer expects a complete backup while one project's git is held.

## 88. The engine home's filesystem

(E36 item 7, which settles E32 item 2; D1 §6.1; `M67-unsafe-filesystem-refused.test.mjs`.) The engine cannot check that storage honours a sync. It refuses a home on a kind of filesystem known not to keep what is written to it or not to give sync guarantees: memory-backed, network and user-space filesystems.

**The kind** of the home's filesystem is the filesystem type of the mount that holds the home, named as `/proc/self/mountinfo` names it (`ext4`, `tmpfs`, `nfs4`, `9p`, `fuse.sshfs`). A type with a subtype is of the kind before the dot. `../contract/filesystems.json` lists the names the tests pin as refused: `tmpfs`, `ramfs` (memory); `nfs`, `nfs4`, `cifs`, `smb3` (network); `fuse`, `fuse.<subtype>`, `fuseblk`, `9p` (user space; `9p` is what a Windows drive is when seen from inside WSL). The engine may refuse further names of those three classes. **Any other kind starts normally,** a name the engine has never heard of included.

**The refusal** is a start that fails before listening (section 1): exit status **6**, one refusal line with `code: "unsafe_filesystem"` and `subject: {"path": ".", "filesystem": <the type as found>}`, a `reason` that names the kind and a `what_to_do`. It is decided before the lock is taken and before anything is written: the home holds exactly what it held, with no `engine.lock`, no `api.token` and no store.

**How a test makes the engine see such a kind without privilege.** The memory-backed kind for real: a home under `/dev/shm`, a tmpfs any user can write to, started with no harness flag, so the engine's own detection is what is tested. (The case first checks that `/dev/shm` is a tmpfs, and fails if it is not: a missing lane is not a pass.) The other kinds cannot be mounted without privilege. For them harness mode has one flag:

| Flag | Meaning |
|---|---|
| `--harness-home-fstype <name>` | The engine takes `<name>` as the type of the home's filesystem instead of detecting it. Accepted only with `--harness` (section 1). |

The flag replaces the detection, not the judgement: which names are refused is the engine's own table, the one a start without the flag uses. It reaches production code as an ordinary parameter (section 7, "Confinement": like `--harness-migrations`).

**What a pass shows:** that the engine refuses the kinds listed and starts on the others. It shows nothing about the storage of the host the tests ran on; the M1 report must say so (E36 item 7).

## 89. The HTTP boundary completed

(D1 §§11.1, 17(1), 17(2), 17(13), 17(14), D1-29; Review §8.3; E23 item 10; `M69-boundary-matrix.test.mjs`.) Section 6 has the Host check and the token. Every request now passes these checks, in this order, before routing, before any of its body is read and before any interim response:

1. **Host** (section 6, item 1). New: a request with no `Host` header is answered by the engine, **400** `host_refused`, not by the HTTP library's bare 400.
2. **Origin evidence.** The engine's own origin is `http://<api_authority>`: scheme, host and port. A present `Origin` or `Referer` header whose value, parsed as an origin, is not exactly that origin refuses the request: **403** `origin_refused`. That covers another host, another port, `https`, `localhost` where the authority is `127.0.0.1`, a host that only begins with the authority, `null`, and a value that cannot be parsed. A present `Sec-Fetch-Site` header other than `same-origin` refuses it the same way (`cross-site` and `same-site` are pinned; `none` is accepted on a shell route, section 90, and not pinned elsewhere). A request with none of the three headers is an origin-less client and goes on to the token check. A request of the engine's own origin, by either header or both, goes on too.
3. **Token** (section 6, item 2), except on the routes of section 90.
4. **Declared length.** A `Content-Length` greater than `body_cap` refuses the request, **413** `payload_too_large`, with none of the body read: the tests send the head only and the engine must answer it. A body of exactly `body_cap` bytes is read.

**`100 Continue`** is sent only to a request that has passed all four. A request refused for its origin evidence or its declared length gets its refusal and no interim response. (Section 6 pinned this for Host.)

**A streamed body** (chunked) is counted as it arrives. When the count crosses `body_cap` the engine stops reading and answers **413** `payload_too_large` without waiting for the end of the body: the tests send seventeen chunks of 64 KiB, never finish the body, and require the answer within ten seconds, with `request_body_deadline` set to sixty so that the answer cannot be the deadline's. A chunked body under the cap is accepted like any other.

**No CORS.** No response carries an `Access-Control-…` header. `OPTIONS` is not special: a preflight from another origin is a request with a foreign `Origin` and is refused like one.

**Audit and effect.** Each of these refusals comes before the route: the mutation it refused has no effect. On a mutating request in full mode it is audited like any refusal after the Host check (section 6): one `api.act` with `status` 403 or 413.

**A request the HTTP parser rejects** (a request line that is not HTTP; a header section far over any limit) is answered by the engine: status **400** (431 is accepted for an oversized header section), a body in the refusal form of section 6, and the defensive headers. The `code` of these two is not pinned.

**Defensive headers.** Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a `Cache-Control` that holds `no-store`, and `X-Frame-Options: DENY`: every status, the parser-level refusals and the head of an event stream included.

**A failing client does not stop the engine.** A request whose body stops arriving and whose connection is then reset, and an event stream whose client resets the connection while events are being written to it, leave the engine the same process, answering, carrying out the next mutation and serving the next stream.

## 90. The shell and the token bootstrap

(RN R6; build spec §6 correction 7; D1 §§11.1, 17(2), D1-29; Review B14; E36 item 1; `M68-browser-bootstrap.test.mjs`.)

**The shell is the harness's.** M1 has no UI (build spec §3; `packages/ui/README.md`). The page a browser loads in row M68 is `shell/index.html` with `shell/assets/shell.js`, the Verifier's files, which the test copies to a directory and hands to the engine:

| Flag | Meaning |
|---|---|
| `--harness-shell <dir>` | The engine serves the files of `<dir>` as its static shell: `GET /` is `<dir>/index.html`, and `GET /assets/<name>` is `<dir>/assets/<name>` for each regular file that is there when the engine starts. Accepted only with `--harness`. |

It reaches production code as an ordinary parameter, the directory of static files to serve. Without it the engine has no shell route: `GET /` is a path like any other that no route matches.

**Shell routes** are the enumerated ones and no others. They are served after the Host check and the origin-evidence check of section 89 (with `Sec-Fetch-Site: none`, a first navigation, accepted) and **without a token**. The response is 200 with the file's bytes exactly as they are: nothing is put into them, no cookie is set, and no header holds the token or anything of a project. `index.html` is `text/html`; a `.js` file is `text/javascript` (or `application/javascript`). They carry the defensive headers of section 89, and the document also carries a `Content-Security-Policy` whose `default-src` is `'none'` or `'self'`, which has `frame-ancestors 'none'`, and which names no `'unsafe-inline'`, no `'unsafe-eval'` and no origin but `'self'`: the browser must refuse the shell's inline script and run its `/assets/shell.js`. The exact policy is the engine's. A path under `/assets/` that is not an enumerated file, and every API route, need the token as before.

**`GET /v1/token/bootstrap`** needs no token and gives the token to a page of the engine's own origin and to nobody else. After the Host check it requires positive evidence: `Sec-Fetch-Site: same-origin`, and an `Origin` or a `Referer`, at least one, each one that is present being of the engine's own origin. Then: **200** `{"token": <the API token>}`, with `Cache-Control: no-store` and no `Access-Control-…` header. Everything else is **403** `origin_refused`, in the refusal form, with a `what_to_do` a person can act on and no token anywhere in the response: no evidence at all; fetch metadata with neither `Origin` nor `Referer`; either of those without fetch metadata; `same-site` or `cross-site`; a foreign, `null` or unparseable `Origin` or `Referer`; an `Origin` of the engine with a foreign `Referer`. That evidence authorizes the bootstrap and nothing else: an API read with it and no token is still 401. What the route answers in restricted mode, and to a request that also carries a token header, is not pinned.

**What the browsers do** (the cases print it; both were observed while the tests were written, Chromium 145 and Firefox 146). A same-origin `fetch` of the bootstrap with `referrerPolicy: "same-origin"` carries `Sec-Fetch-Site: same-origin` and a `Referer` of the page, and no `Origin`. The same `fetch` without that option, from a page served with `Referrer-Policy: no-referrer`, carries `Sec-Fetch-Site: same-origin` and neither `Origin` nor `Referer`: Review B14's counterexample, which the engine must refuse. A page on another loopback port sends `Sec-Fetch-Site: same-site` and its own `Origin` or `Referer`. A same-origin `POST` by `fetch` carries the page's `Origin`.

**The browser lane.** Playwright 1.58.2 (E36 item 1) with its Chromium and its Firefox, headless, a new browser context for each case. No header is added, no request is intercepted and no token is injected. A browser that cannot be launched fails its cases; none is skipped. Each case prints the browser's version.

## 91. Reads: projects, NOW, facts beside it, an observation, and record reads that refuse

(D1 §§11.3, 12.2 to 12.4, 13.1, 14, A.10, D1-28; Review N03; E39; `M70-scoped-reads-and-now.test.mjs`; the spend keys also `M74-fixture-semantics.test.mjs`; the project and decisions reads also `M01-journey-through-the-api.test.mjs`.)

**Every read** of this section is a JSON object with `served_at` (a timestamp of the engine's clock) and `snapshot_seq` (the highest event `seq` of the store snapshot it was computed from). A read writes nothing: no row changes, no event is appended, no adapter is called (the tests count the launches of the scripted role, which is the adapter call a test can count from outside).

**`GET /v1/projects`** → **200** `{"served_at", "snapshot_seq", "projects": [...]}`, every project once, each with at least `id`, `now` and `spend_today` as below. **`GET /v1/projects/:p`** → **200** `{"served_at", "snapshot_seq", "project": {...}}` with at least:

| Key | Value |
|---|---|
| `id` | the project |
| `now` | `{"state", "primary_action", "reason"}`: `state` a `NowState`; `reason` one sentence; `primary_action` a string or null |
| `execution` | `{"runs": [{"id", "state", "quarantined"}]}`: the project's runs that have not ended, oldest first; `quarantined` a JSON boolean |
| `open_decisions` | `{"count": <the number of open decisions of the project>}` |
| `spend_today` | the totals of section 54 for the invocations of the engine clock's current UTC day (`invocations`, `billable_in`, `cached_in`, `out`, `usage_incomplete`, `reported_usd`, `estimated_usd`, `unknown_cost_invocations`, `unknown_cost_tokens`), and `no_dispatch` |
| `environments` | `[{"id", "name", "observed": {...}}]`, see "An observation" |

**NOW** (D1 §12.3) is exactly one state, by this priority. `refused`: the engine cannot act on the project; the tests pin a quarantined run. `waiting_on_you`: the project has an open decision. `running`: a run of it is under way. `ready`: it has eligible work that the next tick could dispatch. `idle`: otherwise. So a project with a quarantined run is `refused` although its blocker is open, and a project with a run executing and an open decision (a Stop asked for and not confirmed) is `waiting_on_you`. The other causes of `refused` D1 names (an unreadable repository, an integrity block, a store error) and `unknown` are not pinned.

**The facts beside NOW stay what they are.** `execution.runs` lists a run as `executing` whatever NOW says, and a quarantined run as `{"state": "finalizing", "quarantined": true}`.

**A project's open decisions** (D1 §11.3; E39, "one addition"; added by the Verifier pass after slice 6 was verified). **`GET /v1/projects/:p/decisions`** → **200** `{"served_at", "snapshot_seq", "decisions": [...]}`: the decisions of project `:p` whose `status` is `open`, and no decision of another project. Each has at least:

| Key | Value |
|---|---|
| `id` | the decision |
| `kind` | its `DecisionKind` |
| `subject_type`, `subject_id` | the stored ones: what the decision is about |
| `question` | the stored question, a non-empty string |
| `options` | an array in the stored order; each option has at least the stored `key`, `effect_plan` and `plan_hash` (section 76) |
| `preview_hash` | the stored one. It is the value an answer must carry (section 76), so a person can answer from this read alone: the test confirms a Stop with the hash the read showed |

A decision that is no longer open is not in the list: the test consumes one and it is gone, and the list is then `[]`. D1's table says the route returns "open decisions", so this is D1's rule and not a choice. The number of entries is the project read's `open_decisions.count`. Not pinned: the order of several open decisions (each test project has one at a time); D1's consolidation by batch key and "evidence resolved to records"; any further key (`semantic_generation`, `dependency_manifest`, `blocked_while_open`, an option's `blockers`); a read of consumed or invalidated decisions; `GET /v1/projects/:p/decisions/:d`; what the route answers for a project that does not exist. Of the other reads D1 §11.3 lists and no row names, E39 left all unbuilt in M1 unless the owner asked; with E47 the owner asked for two, a project's work and a candidate's gate, which section 98 fixes. A project's operations, one decision by id and environments as a route of their own are still not part of the seam.

**No dispatch is a fact of its own** (D1 §13.1). `spend_today.no_dispatch` is true when none of the day's invocations of the project was launched; the amounts are then null and `invocations` is 0. A project whose launched role reported nothing has `no_dispatch` false, `invocations` 1, `unknown_cost_invocations` 1 and `reported_usd` null. One whose role reported a cost of exactly zero has `reported_usd` 0, the number, and its ledger row is `measured_zero` (section 53). Null is never shown as zero and zero never as null. A dispatch whose launch is unknown, and a day with only a refused dispatch, are not pinned.

**An observation** (D1 §3.5; D1-28). M1 builds no observation job and no observation history (section 8). What it has is the current observation on an environment's record, and that enters as a fixture:

| Route | Body | Result |
|---|---|---|
| `POST /v1/harness/fixtures/observation` | `{"project", "environment", "condition": <ObservedCondition>, "observed_at": <timestamp>, "source": <string>}` | **201**. Records that observation as the environment's current one, on its `environment_records` row (`environment`, and `observed`, JSON text holding at least `condition`, `observed_at` and `source` as given), through a transition that emits `environment.observed` with `payload.test_fixture = true`. It follows section 7's rules. |

The project read shows it as `environments[].observed`: `{"condition", "observed_at", "source", "provenance", "freshness", "expires_at"}`. `observed_at` and `source` are the stored ones, always. `freshness` is computed at the read from the engine's clock and the project's `observation_freshness_bound` (default 90 s): `fresh`, `stale` past half the bound, `expired` past it (the tests pin `fresh` and `expired`). An expired observation is projected with `condition` `unknown`. `provenance` is a `Provenance` value. Reading rewrites nothing: the stored `observed` is byte for byte what the fixture recorded, before the bound and after it. What an environment that was never observed shows is not pinned.

**Record reads that refuse** (D1 §11.1; section 56 has the route). The engine serves a record only from the regular file it wrote. If the path now holds anything else, the read is **409** `record_missing`, promptly, with nothing of what is there in the response: a symbolic link (one that leads to a copy of the same bytes included, and one that leads to `api.token`), a named pipe (the engine does not wait at it: the tests allow ten seconds, and require health to answer within two while the read is open), a link to a device (a real device node cannot be made without privilege), and a file whose size is not the recorded one (the tests put a sparse gibibyte there; the response is at most a refusal, never the content). Another project's record is **404** `not_found`, as section 56 says.

## 92. The two streams

(D1 §§11.3, 12.1, 14.2, 17(5), D1-33; Review B14; `M72-bounded-event-streams.test.mjs`, `M64-secrets-in-streams.test.mjs`.) Both are server-sent event streams: **200**, `Content-Type: text/event-stream`, the defensive headers, and a body of messages. A message is lines that end with one line feed, then an empty line; a line that begins with a colon is a comment and may appear anywhere between messages. The token is the `X-Surety-Token` header as on every route. **It is never taken from a URL:** a request with the token as a query parameter and no header is **401** `token_required`.

**`GET /v1/events?since=<seq>`** is the event log (section 9) after a cursor. Each committed event with `seq` greater than `since` is one message, exactly once, in `seq` order:

```
id: <seq>
event: <type>
data: <one line of JSON: an object with at least "seq", "type", "at", "subject" and "payload", the last two as objects>
```

The stream first replays what is stored and then stays open and delivers each event as it commits. `id` is the cursor: a client that connects again with `since` set to the last `id` it has received loses nothing and sees nothing twice. An absent `since` is 0. D1's `project=` filter is not pinned.

**Replay pages.** With `&limit=<n>` (a positive integer) the response is one page: at most `n` events after the cursor, and then it ends. A request with a limit never waits for an event that is not yet committed; a page past the end of the log is empty and ends at once. The engine may end a page before `n` events (its own page size is its choice): the client goes on from the last `id` until a page is empty. A page of a million events is not built in memory.

**Bounded buffering, and a client that takes nothing.** The engine holds a bounded amount of undelivered stream data for a client, whatever the client asked for. A client that takes nothing for **five seconds** while the engine has data for it is let go of: the engine closes that client's connection. What the client was sent before is whole messages in order; a message cut off by the end of the connection is dropped by the client, so the last `id` it holds is a cursor. The tests pin this with a log of 256 MiB, a client that asks for all of it and reads nothing, and two measures: the engine's end of the connection is no longer established within forty seconds (`/proc/net/tcp`; `engineEndState` in `sse.mjs`), and the engine's peak resident memory (VmHWM) has risen by less than half of the log, 128 MiB. The same memory bound holds while the whole log is read in pages of a million. A client that reads its stream is never let go of. Whether the engine writes a last `slow_consumer` message (D1 A.7) before it closes is its choice: a client that is not reading could not be shown one, and the tests do not look for it.

**The number of clients changes no adapter call:** with twenty clients connected, no role is launched and no invocation allocated that would not have been without them.

**`GET /v1/projects/:p/runs/:r/tail?offset=<n>`** is a run's captured output from a byte offset (default 0), as it is captured, after redaction: the bytes its transcript holds or will hold (section 56). Messages:

```
id: <the offset after this chunk>
event: output
data: {"offset": <where this chunk begins>, "b64": "<the chunk's bytes, base64>"}
```

Chunks are contiguous from the offset asked for, and are delivered while the role runs, not when it ends. When the run's output has ended the engine sends `event: end` with `data: {"offset": <the total>}` and ends the response. What the tail delivered is byte for byte what the published transcript holds. A run that is not of project `:p` is **404** `not_found`. The rule for a client that takes nothing is the events stream's; a tail of output beyond the transcript cap is not pinned.

**A quarantined transcript has no tail** (the slice-6 review; E42 item 1). Once a detector has marked a run's transcript as a hit (section 57), the run's tail is refused as the record read is: **409** `record_quarantined`, in the refusal form, with none of the transcript's bytes in the response. The case asks for the tail of an ended run twice from offset 0: before the detector is registered it is 200 and delivers the output; after the hit it is the refusal. What happens to a tail that is open at the moment its transcript is marked is not pinned.

**No known secret reaches either stream** (section 57): a secret the engine holds, printed by a role in two writes, is in no byte the tail delivers while the text before and after it is; reported by the role in a usage line, it is in no event a client receives.

## 93. Load: the limits, the store at its size, and how a latency is judged

(Plan M71; D1 §§6.1, 6.5, 8.1, 8.5, D1-20; Review N03; E36 item 2; E42 items 2 and 3; `M71-latency-under-declared-load.test.mjs`, `M71-role-output-memory.test.mjs`, `M66-backup-in-a-running-engine.test.mjs`; `load.mjs`.)

**The limits** are `../contract/load-limits.json`: 5 projects, 20 connected clients, a store of 1,073,741,824 bytes, and `api_latency_bound` at its default, 250 ms, which the cases read from `GET /v1/engine` (`config.api_latency_bound` is `{"value": 250, "source": "default"}`). Nothing larger is qualified by a pass. Each case first shows that its fixture is at the limits (the store's files are at least that large, the store holds five projects, twenty clients are connected) and prints the numbers with what it measured.

**The store at its size.** `fillStore` grows a stopped engine's store by appending filler rows to `events` directly, as `seedEvent` does (section 9): `type` `engine.tick`, `actor_kind` `engine`, `subject` `{}`, a `payload` of 64 KiB of filler with `test_fixture: true`, `seq` counting on from the highest stored, one transaction. The engine must take such rows for what they are: events of its log. It numbers its next event after the highest stored `seq`, starts on that store, and replays the rows like any others. The store's journal mode is switched from WAL for the bulk write and back before the store is closed. On the host these tests were written on, building the gibibyte takes about two seconds.

**Two cases, two shapes of load.**

- *A startup migration over the full store.* The engine is started with `--harness-migrations` on a copy of its migrations plus one that makes eight full scans of the filler: the store's one connection is busy with one transaction for seconds. Until it has been applied the engine is restricted in step `store` (section 4). Throughout, `GET /v1/health` answers 200 with `mode` `restricted`, and a Stop is answered **503** `engine_starting`, each within the bound. (This case passes on the slice-3 engine, whose store is in a worker thread; an engine whose store call occupied the main thread would answer nothing for seconds.)
- *Full mode, everything else together.* Twenty clients on the event stream: seventeen follow it, two read the whole log again and again in pages of a million, one asks for the whole log and reads nothing. During the window a backup of the store runs (below), one project's git is held from before the backup starts (`holdGit`), so that a git child of the engine is open on its repository, a role writes six mebibytes that the engine hashes into chunks, and a tick recomputes a stage gate whose missing execution has just been recorded. `GET /v1/health` is sampled every hundred milliseconds or so for six and a half seconds at least, and for as long as the backup has not ended, and three runs are stopped. Each Stop is the two requests of section 17, and each request is a sample.

**The backup under way.** D1 §6.5's backup is the engine's own job (the scheduler's daily one); a test cannot wait for a day:

| Route | Body | Result |
|---|---|---|
| `POST /v1/harness/backup` | `{}` | **202** at once. The engine then takes a backup of its home as section 59 describes it, under `$SURETY_HOME/backups/`, while it goes on serving. When the backup has ended, however it ended, the engine emits one `engine.backup` with `payload: {"backup": <the directory the backup left, absolute, or null>, "label": "complete" \| "incomplete_for_recovery"}`. |

**What the event says** (the slice-6 review; E42 item 2). One `engine.backup` for each backup started, when it has ended. The label is `complete` only if git confirmed every commit the backup's manifest lists (section 59, "How a commit is confirmed"); `backup` is then its directory, and the manifest there says `complete`. With a commit git did not confirm the label is `incomplete_for_recovery`, the label section 59 has for a backup that is not enough to recover from. Whether such a backup leaves its directory behind is not pinned, as for the command: `backup` is the directory it left, or null if it left none; a manifest it left says `incomplete_for_recovery`; nothing it left says `complete`. A backup that was complete before stays as it was. Before the review this section had only the complete event, and said the engine "writes a complete backup": a backup that could not be complete ended with no event at all. The cases pin the event for a commit that is not confirmed; a backup that ends for another reason (a record's bytes missing, the copy itself failing) has no case, and whether it emits the event with `backup` null or only a log line is not shown by a test.

One case (`M66-backup-in-a-running-engine.test.mjs`, first case) takes a backup of a sound repository, which is `complete` and lists the checkpoint commit of the fixture's run; replaces that commit's loose object by one that is well formed, says it is a commit and does not have the content its name stands for; and takes another: `incomplete_for_recovery`. With the engine stopped, `surety store backup` on the same home agrees: exit status 7, `backup_incomplete` (section 59).

**A backup while a repository's git does not answer** (E42 item 2). The engine asks git for a backup's commits without holding up its event loop, and each call ends at `git_deadline`. So the backup ends, by the deadline and not by the repository; it has not confirmed that repository's commits; and it is `incomplete_for_recovery`. It does not wait for the repository to answer, and it does not answer for it. The snapshot of the store comes first, because the commits to confirm are the ones the snapshot refers to (section 59): the copy is under `$SURETY_HOME/backups/` while the backup waits for git, whatever its label turns out to be. The load case holds one project's git from before the backup starts until after it has ended, with `git_deadline` at 30 seconds, and creates that project's eligible work only once the hold is in place: the engine requests ticks of its own after the commands a tick commits, so a tick may still be under way when `tick()` returns, and work created before the hold was dispatched by one (seen on `build/slice-6`, three times in seven runs). It requires the `engine.backup` event within 180 seconds of the backup's start (the copy of the gibibyte takes seconds; each commit of the held repository the engine asks for may cost one deadline), with the label `incomplete_for_recovery`; it sees at least the store's declared size in bytes under `backups/` while the backup is under way, which is how it knows that the backup was the load the row names; and it goes on sampling health, under the same judgement, until the backup has ended.

**A backup always ends** (E42 item 3; `M66-backup-in-a-running-engine.test.mjs`, the two last cases). Whatever a repository's files are (a pipe, a device, a link), a backup started in a running engine ends within a bound with the label git gives, the engine's memory stays bounded, and health keeps answering. The two cases gc a repository so that its commits are packed, make its packs an hour old, and plant in its pack directory an empty `pack-<forty zeros>.pack` with an index of that name that is (a) a symbolic link to `/dev/zero`, (b) a named pipe nobody writes to. The pack beside the index is what makes git go to the index, and its being the newest makes git go there first. Each case asks git itself for the listed commits, under the engine's deadline, and requires the backup's label to be what git gave. On the git these were written with (2.43): at (a) git reports an index that is too small, looks elsewhere and confirms every commit, so the backup is `complete`; at (b) git waits at the pipe until it is killed, so the backup is `incomplete_for_recovery`. With `git_deadline` at 2 seconds, each case requires:

- the `engine.backup` event within the number of listed commits times the git deadline, plus thirty seconds;
- the label git gave, and for (b) nothing left that says `complete`;
- `GET /v1/health` answered 200 from the backup's start to its end, every valid sample within `api_latency_bound` ("How a latency is judged", below; three valid samples at least);
- the engine's peak resident memory (VmHWM) risen by less than 256 MiB since the backup started. The bound is not a measurement of an engine. What a backup of that home has to hold is a store of under a megabyte, two records of a few hundred bytes and git's answers, which `git_output_cap` caps at 8 MiB; 256 MiB is the figure this section already uses for an engine that keeps what it reads. The engine the review ran rose from 104 MB past 2 GB in two and a half seconds. The case reads the engine's memory every ten milliseconds and kills an engine that crosses the bound at once, so that a failing engine does not take the machine's memory with it.

**Admission and termination are two quantities** (Review N03). Admission is the answer to the request. When the confirming request of a Stop is answered, the run's lease is `closing` (section 17) and the run has not ended unless its role is gone. Termination is the time from that answer to the run's `ended`: it waits for the role's processes (section 14), is measured and printed by itself, and is not judged against the bound. A role that ignores SIGTERM is admitted within the bound and ends no sooner than `terminate_grace` later.

**A prerequisite that timed out dispatches nothing, even late** (D1 §8.1; section 34 pinned it without load). The project whose repository's git is held has eligible work. The tick whose integrity step overran `tick_step_budget` on it dispatches none of it, and neither does that step's late completion when the hold is released; a later tick dispatches it and it completes. Since the review the hold stays in place until the backup has ended, which is longer than `git_deadline`: the read of the window's tick may have been ended by its own deadline by then, and a completion that never came is not a late one. So before the hold is released the case requests one more tick, which dispatches nothing of the project either, and finds a git child of the engine waiting on the repository; that read is the one that completes late.

**How a latency is judged on a host that may be busy.** Every sample is paired with a control: at the same instant, from the same event loop, a request to a trivial server inside the test process. A sample whose control took more than 50 ms is void: the host or the test process was not responsive then, and the sample says nothing about the engine. Every valid sample must be within the bound, with whatever the control cost included in it; the bound is never widened and nothing is subtracted. A judgement needs a stated number of valid samples (thirty of health and four of the six Stop requests in full mode; five of health and two of Stop during the migration); with fewer the case fails as not judged, which is not a pass. The clients of the full-mode case run in a process of their own (`stream-clients.mjs`), so that their reading does not occupy the event loop that measures.

**Memory a role's output costs** (carried from the slice-2 review and the slice-4 session). A role writes 512 MiB to its standard output in lines of one mebibyte, then its result. The run completes, and the engine's peak resident memory rises by less than half of what the role wrote. The bound comes from the claim, not from a measurement of an engine: an engine that keeps the output must hold it. (The slice-3 engine rises by about 86 MiB on this host and passes.)

**The scripted boundary's process scan under load** (carried from the slice-2 review): the full-mode case samples health while two stopped runs are being terminated, which is when the boundary is observed every second. No separate case.

## 94. The executable contract

(Plan M73 and §5; RN §3; E20; D1 §11.2, D1-38; Review B10, B17, N02; build spec §2 item 6 and §5; `M73-executable-contract.test.mjs`.) The contract is what the engine executes. The engine states it as one JSON document and can check such a document and generate Appendix A from one.

**Commands.** They need no engine home and no running engine.

| Command | Result |
|---|---|
| `surety contract export` | Exit status 0; stdout is the contract document of this engine, computed from what it executes (its migrations, its enumerations, its transition tables). |
| `surety contract check [--file <path>]` | Checks this engine's contract, or the document in `<path>`. The last line of stdout is a JSON object `{"valid", "findings", "checked", "not_checked"}`. Valid: exit status 0, `valid` true, `findings` `[]`. Not valid: exit status **8**, `valid` false, at least one finding. |
| `surety contract appendix [--file <path>]` | Exit status 0; stdout is Appendix A generated from this engine's contract, or from the document in `<path>`. The same input gives the same text. |

**The committed files.** `packages/engine/api/schema.json` is the contract document: it parses to exactly what `surety contract export` prints, so a change to the engine that changes its contract fails the test until the file is regenerated (D1 §11.2: the pin fails on drift). `packages/engine/api/appendix-a.md` is exactly what `surety contract appendix` prints. Both are the Builder's files. The file may hold more than the sections below (the routes, for one); the tests read these.

**The document.** A JSON object with at least:

| Section | Holds |
|---|---|
| `enums` | `{<Name>: [<value>, ...]}`: every closed enumeration, `EventType` and `DecisionKind` among them |
| `tables` | `{<table>: {"fields": {<column>: {"required": <boolean>, "enum"?: <Name>, "references"?: <table>}}}}`: every table and column of the store the migrations create, no more and no fewer; `references` exactly where the schema has a foreign key |
| `work_items` | the work-item table in the form of `../contract/work-items.json`: `statuses`, `terminal`, `kinds` (`{<kind>: {"m1", "path"}}`), `templates` (`{<name>: {"from", "to", "only_kinds_with"?}}`; the `to` of `continue` is null), `run_owning`, `continuations` |
| `transitions` | `{<Name of the enumeration the states are of>: [<chain>, ...]}`; a chain is an array of two or more states, each consecutive pair an edge. The tests read `RunState`, `DomainStatus` and `AuthorizationStatus` |
| `decisions` | `{<DecisionKind>: {"enabled": <boolean>, "manifest": [<key>, ...], ...}}`; an enabled kind has its manifest |
| `events` | `{<EventType>: {"owner": <what emits it, a non-empty string>}}`, or `{"reserved": true}` for a type nothing in M1 emits |
| `config` | `{"engine": {<key>: {"default", "min"?, "max"?, ...}}, "project": {...}}` |

**What the engine's own contract must be.** Valid. Its `tables` are those of a store the engine created, compared with `PRAGMA table_info` and `PRAGMA foreign_key_list` on a real store. Every event type found in a real store's `events` is an `EventType` with an owner, not reserved. It agrees with the Verifier's tables, which hold the accepted corrections: every work kind has exactly the legal edges of `../contract/work-items.json` (correction 11); `RunState` and `DomainStatus` have the edges of `../contract/run-lifecycle.json` (corrections 12 and 13); `AuthorizationStatus` has `proposed` and the five edges of correction 4; the eleven kinds of `../contract/decisions.json` are enabled, each with at least the manifest keys listed there, and no other kind is (correction 5; build spec §3); the configuration keys, with their numeric defaults and ranges, are those of `../contract/config.json` (correction 20). D1's hand-written Appendix A is not an input to any of this.

**The checker** makes two kinds of check, and each finding says which: `{"check": "lexical" | "structural", "path": [<key>, ...], "message": <string>}`. `path` leads to the offending element of the document. *Lexical*: every name used is declared (a state of a transition, a path or a template is a value of its enumeration; a field's `enum` is a declared enumeration; a `references` names a declared table). *Structural*: the declarations are true and complete (the `tables` section agrees with the schema the engine's migrations create in a real SQLite database; an enabled decision kind has a manifest; an event type is owned or reserved). A valid result lists what was checked, `"checked": ["lexical", "structural"]`, and what was not: `not_checked` holds at least `"lifecycle_traces"`. A clean check certifies no lifecycle path; the acceptance rows do that.

The seven mutations of the Plan, each made on a copy of the engine's export and each refused with a finding at the path given:

| Mutation | `path` begins | `check` |
|---|---|---|
| the common transition `resume` leads to a state that is no `WorkItemStatus` | `work_items`, `templates`, `resume` | lexical |
| the path of `verification` ends in a state that is no `WorkItemStatus` | `work_items`, `kinds`, `verification` | lexical |
| `runs.state` is of an enumeration that is not declared | `tables`, `runs`, `fields`, `state` | lexical |
| `snapshot_tree` is declared on `runs` and no longer on `workspaces` | `tables`, `runs`, `fields`, `snapshot_tree` | structural |
| `runs.work_item` references `stages` | `tables`, `runs`, `fields`, `work_item` | structural |
| the enabled kind `blocker` has no manifest | `decisions`, `blocker` | structural |
| an event type is declared with neither owner nor `reserved` | `events`, `<the type>` | structural |

For the four structural ones the lexical check must find nothing: every name in those documents is declared, and they are wrong all the same.

**The appendix** states each enumeration as one line in D1 A.2's form, `- **<Name>:** <values, separated by ", ">.`, with the values in the contract's order, and names every table. It is generated from the document it is given: the same contract with one enumeration reordered gives an appendix with that line changed. The rest of its layout is the engine's. Where D1's hand-written appendix was corrected the generated one differs from it (`AuthorizationStatus`, `DecisionKind`).

## 95. Fixture semantics and the invocation boundary

(Plan M74; RN §3 N06; D1 §§7.3, 7.4, 11.2, 11.3, 15.4; Review N03, N06 and §8.3; `M74-fixture-semantics.test.mjs`, `M74-invocation-boundary.test.mjs`.)

**The run read** (section 17) gains three keys.

| Key | Value |
|---|---|
| `checkpoint` | null while the run's role has asked for none. `{"status": "pending", "revision": null}` from the moment a result that asks for a checkpoint has arrived until its snapshot is committed. `{"status": "accepted", "revision": <the id of the `revisions` row of kind `checkpoint`>}` afterwards. What a request whose snapshot failed validation shows is not pinned. |
| `parent_run` | the stored `runs.parent_run`, or null |
| `successor_run` | the run whose `parent_run` is this run, or null while there is none |

A request is not a checkpoint: while the role that asked is alive the engine has taken no snapshot (section 28), the workspace has no checkpoint and no `checkpoint` revision exists, and the read says `pending`. Whether such a run is still `executing` or already `validating` is the engine's choice; the slice-3 engine shows `validating`. An accepted checkpoint is shown on a run that has ended, and its successor only once that run exists.

**`GET /v1/projects/:p/candidates/:c`** → **200** `{"served_at", "snapshot_seq", "candidate": {...}}` with at least:

| Key | Value |
|---|---|
| `id`, `progress` | the stored ones; `progress` is `developing` for every candidate in M1 (section 75) |
| `protected_version` | `{"nominated": <the candidate's `nominated_protected_version`>, "effective": <the project's effective protected version>}` |
| `successor` | the candidate whose lineage started from this one (section 42), or null |
| `gates` | `{<gate kind>: {"id", "outcome", "stale"}}`: for each gate kind that was evaluated for the candidate, its latest stored evaluation; a kind never evaluated is absent |

After a protected correction is applied (section 69) a candidate nominated before it shows the old version as `nominated` and the new as `effective`, and its `gates.stage` is not a current satisfied one: it is the stored evaluation, stale or recomputed. The next candidate is its `successor`.

**The spend keys** for "no dispatch" and a measured zero are section 91's.

**The invocation boundary** (D1 §15.4). `launch-lint.mjs` reads the engine's source as text, with section 7's lexer. A file under `packages/engine/src/` may name a module that can start a process (`node:child_process` or `child_process`, `node:cluster` or `cluster`, and the internal bindings `spawn_sync` and `process_wrap`) only in three places: `invoke/`, the choke point; `git/exec.ts`, the one file that runs git; and `testing/`, the seam folder. So the scripted notification sink (section 82), which is harness-only, is run from the seam folder. Naming is any string or template literal that is such a name, in a static import, `import()`, `require()`, a re-export or `process.getBuiltinModule()`. A static import that binds types only is allowed anywhere. The mutation fixture inserts a launch path into the real source in seven forms, each of which the inspection must report; the same code under `invoke/` and a types-only import must not be reported. What it does not prove: anything about a name assembled at run time, that `git/exec.ts` runs only git, or that code under `invoke/` launches only through the choke function.

**The package graph** (D1 §11.2). `packages/engine/package.json` exports exactly one entry point and one command, `surety`. The module that entry names exports no function and no class: a client that imports the engine package cannot start an engine, open its store or launch a backend with it. No file under `packages/ui/` names a process-starting module or a path into the engine's `src`, `dist` or `migrations`.

## 96. Names the Verifier fixed in slice 6

Each of these was open in the sources. The Builder may object. Those marked † carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| The unsafe-filesystem refusal | Exit status 6, `unsafe_filesystem`, `subject: {"path": ".", "filesystem"}`, decided before anything is written | E36 item 7 asks for a clear message and names no code. Status 6 is section 1's status for a home that cannot be used; a code of its own says why. |
| How a kind is named; the refused names † | The mount's type as `/proc/self/mountinfo` gives it; `../contract/filesystems.json` | The name a person sees in `findmnt` and `mount`. The decision gives three classes and one example; the ten names are the common ones of each class. |
| Seeing a kind without privilege | A real home under `/dev/shm`; `--harness-home-fstype <name>` for the rest | The task asks that the test need no root. The flag replaces detection only. |
| The row of that case | M67 | The row where durability is pinned, and where `COVERAGE.md` carried the open item since slice 1. |
| The order of the boundary checks | Host, origin evidence, token, declared length; `100 Continue` after all four | D1 §11.1 lists them "before routing, body reads ... or `100 Continue`" without an order among them. |
| `origin_refused` | 403 | D1 names the code; 403 is HTTP's status for it. |
| `Sec-Fetch-Site` values | `same-origin` goes on; `cross-site` and `same-site` are refused; `none` only on a shell route | D1: "consistent with same-origin use". A first navigation is `none`. |
| A request with no `Host` | 400 `host_refused`, by the engine | E23 item 10. |
| Parser-level refusals | 400 (or 431), refusal form, defensive headers; code not pinned | D1 §17(13), (14). No A.7 code fits and no test needs one. |
| Frame denial | `X-Frame-Options: DENY` | D1 says "frame denial" and names no header. |
| The shell † | The harness's files, served from `--harness-shell <dir>`: `GET /`, `GET /assets/<name>` | `packages/ui/README.md`: the test shell "belongs to the acceptance harness". M1 has no UI to serve. |
| The shell's content security policy | Properties, not a text: default `'none'` or `'self'`, no inline, no eval, no other origin, `frame-ancestors 'none'` | D1 §17(13): "the UI's CSP is restrictive". |
| The bootstrap's answer | 200 `{"token"}`; 403 `origin_refused` otherwise | D1 §11.1 gives the predicate and not the body. |
| The project list and projection † | Section 91: `now`, `execution.runs`, `open_decisions.count`, `spend_today`, `environments` | D1 §11.3 names what the routes return in words. Only what row M70 reads is fixed. |
| The decisions read (added after slice 6 was verified; E39) | Section 91: `GET /v1/projects/:p/decisions` lists the project's open decisions with `id`, `kind`, `subject_type`, `subject_id`, `question`, `options` and `preview_hash`; a consumed decision is not listed | D1 §11.3 names the route and says it returns open decisions with their options, effect plans and preview hash. The keys are the stored column names (D1 A.3). Only what a person needs to see and answer a decision is fixed. |
| `no_dispatch` | A boolean beside the ledger's totals | D1 §13.1: "no dispatch is a projection fact with no row". |
| What `refused` is, as pinned | A quarantined run | D1 §12.3 lists four causes; the row needs one. |
| The observation fixture † | `POST /v1/harness/fixtures/observation`; the current observation on `environment_records.observed` | The Plan seeds "historical observation fixtures"; M1 has no observation job and no history table. |
| A substituted record file | 409 `record_missing` for a link, a pipe, a device and another size | D1 §11.1 says what is rejected and names no code; section 56 has this one for bytes that are not there. |
| The event stream's wire form | Section 92: `id` the `seq`, `event` the type, `data` the event as one line of JSON | D1 §11.3: "SSE: replay from `seq` with a resumable cursor". |
| Replay pages | `&limit=<n>`; a page ends; the engine may end it early | Plan M72: "request large replay pages". |
| A client that takes nothing † | Let go of after five seconds with data waiting; whole messages before; no last message required | D1: "bounded queue; slow consumers disconnected with a cursor". Without a time, an engine that only waits is never wrong. |
| The memory bounds | A rise of peak resident memory below half of the log (128 MiB of 256), below half of a role's output (256 MiB of 512) | Derived from the claim: an engine that buffers must hold what it buffers. No number measured on an engine. |
| The tail's wire form | `offset`, base64 chunks, `id` the end offset, `event: end` | D1 §11.3: "captured output from an offset". Output need not be text. |
| Adapter calls a test can count | Launches of the scripted role, and invocation receipts | The scripted boundary reads a file and `/proc`; a test cannot count that from outside. |
| The load limits' numbers | `../contract/load-limits.json`; 1 GB as 2^30 bytes | E36 item 2. A gibibyte is not less than a gigabyte. |
| The filler | `engine.tick` events of 64 KiB, labelled, written directly | The store must be large with what the engine really reads: replay and backup read events. |
| The backup trigger | `POST /v1/harness/backup`, 202, one `engine.backup` with `{backup, label}` when the backup has ended | D1 §6.5's backup is the scheduler's daily job; section 59 has the manifest. |
| What a valid latency sample is † | Paired with a control within 50 ms; every valid sample within the bound; a floor on valid samples | The task: reliable on a loaded machine without being loosened until it proves nothing. |
| Stop admission | Each of a Stop's two requests | Section 17 made Stop two requests. |
| The contract commands and exit status 8 † | `surety contract export`, `check [--file]`, `appendix [--file]` | RN §3: the appendix is generated from the contract. Something has to print the contract and check one. |
| Where the contract and the appendix are kept † | `packages/engine/api/schema.json`, `packages/engine/api/appendix-a.md` | Build spec §5 names `api/schema.json` as the contract; the appendix beside it is in the Builder's paths. D1's own Appendix A is the owner's file. |
| The contract document's sections | Section 94; the work-item table in the Verifier's own form | The mutations have to be made on a document of a known form. |
| Lexical and structural | The two labels of a finding; `not_checked` holds `lifecycle_traces` | Review N02 and B17: the checker's output "MUST identify that it checks lexical declarations only". |
| The appendix's form | D1 A.2's enumeration lines; every table named | Enough to show it follows its source. |
| The run read's `checkpoint`, `successor_run` | Section 95 | Review N06: a request is shown pending, an accepted checkpoint with its successor run. |
| The candidate read | Section 95: `protected_version`, `successor`, `gates` | D1 §11.3: "candidate, lineage ..., latest evaluation per gate kind". |
| Where a process may be started | `invoke/`, `git/exec.ts`, `testing/` | D1 §15.4 names `engine/invoke/`. git is run by `git/exec.ts` today; harness-only programs belong to the seam folder (section 7). |
| What the engine package exports | One entry with nothing callable | D1 §11.2: a client imports the engine's published API types. |
| A quarantined transcript's tail (after the slice-6 review; E42 item 1) | 409 `record_quarantined`, no byte of the transcript | "Served by no route." The code is the record read's. |
| A running engine's backup that is not complete (after the review; E42 item 2) † | `engine.backup` with `label` `incomplete_for_recovery` and `backup` the directory it left or null; one event for each backup started | The seam had the complete event only, and a test must see a backup end. The label and the "whether it leaves a directory" are section 59's. |
| How a commit is confirmed (after the review; E42 item 2) † | By git, as a commit, within `git_deadline`; the label is git's answer both ways | E42 item 2: the engine asks git; a commit git cannot confirm in time is not confirmed. E42 item 3: "a truthful label". |
| The bounds of "a backup always ends" (after the review; E42 item 3) † | The event within listed commits × `git_deadline` + 30 s; VmHWM risen by less than 256 MiB; health within `api_latency_bound`, three valid samples at least | E42 item 3 says "within a bound" and gives no number. Each listed commit may cost one deadline; the memory bound is argued in section 93. |
| The planted pack index (after the review; E42 item 3) † | An empty `pack-<forty zeros>.pack`, newer than the real packs, with its `.idx` a link to `/dev/zero` or a named pipe | The review planted the index alone, which the engine's own reader opened and git never does: git goes to an index only for a pack that is there. With the pack beside it the pipe is a file git itself waits at, and the deadline is what ends the backup. |
| The load case's backup (after the review; E42 item 2) | Git held before the backup starts; the event within 180 s, `incomplete_for_recovery`; the store's size seen under `backups/`; health sampled until it ends; one more tick before the hold is released | 180 s is the wait the case always gave the backup. The copy must be seen because a backup that is not complete need not leave a manifest to read its size from. |

## 97. What stands behind these tests before the engine exists

More than for slices 4 and 5, because part of slice 6 can be run on the engine as it is. On the slice-3 engine of this working copy, each new file was run once with `node --test`: all eleven load, and every failure is an assertion or a missing feature (a route that does not exist, a flag or command the engine does not know), none a syntax error, a bad import or a helper that throws for its own reasons. What passes already:

- `M71-latency-under-declared-load.test.mjs`, first case: the migration over the gibibyte keeps the slice-3 engine restricted for about seven seconds, during which 151 health samples (worst 3 ms) and 5 Stop samples were valid and within the bound. The fixture, the sampler and the control ran against a real engine.
- `M71-role-output-memory.test.mjs`: 512 MiB written, a rise of 86 MiB.
- `M74-invocation-boundary.test.mjs`, all three cases: the slice-3 source keeps to the rule, and each of the seven inserted launch paths is reported.
- `M68-browser-bootstrap.test.mjs`, the two lane cases: Chromium 145.0.7632.6 and Firefox 146.0.1 launch, report their versions and reach the real engine (a navigation to `/v1/health` is refused 401).
- `M69-boundary-matrix.test.mjs`, "a declared body over the cap ...": the slice-3 engine already refuses it unread. The streamed case got its 413 from the real engine too, and fails only on the defensive headers.
- `M67-unsafe-filesystem-refused.test.mjs`: the real `/dev/shm` home is made and removed; the slice-3 engine starts on it, which is the failure.

Helpers with logic of their own were exercised outside any test, against things that are not the engine and are not kept: the stream client (`sse.mjs`: parsing, a paused client, `engineEndState`, a cursor taken up again, replay pages) and the client process (`stream-clients.mjs`) against a scratch server that wrote messages and closed a stalled connection; the browser helpers against a scratch page server, where both browsers were seen to send what section 90 records; `fillStore`, the scans and a restart on the filled store against the slice-3 engine; the schema reading of row M73 against a real store. One finding of that work is in `sse.mjs`: a client that has stopped reading cannot see from its own socket that the engine closed the connection, so the test reads the state of the engine's end.

Everything else was read, and its imports and names resolved. The cases are few by decision (E31); a defect in a test, or a name the Builder finds unworkable, goes through the objection procedure.

**After the slice-6 review** (E42 items 1 to 3). Three cases were added and one changed, and unlike most of this slice's tests they were run against a built engine: the slice-6 engine on `build/slice-6`, each changed file alone with `node --test`. Each new case fails there on its own assertion, for the defect it was written for: the tail of a quarantined transcript answers 200 and delivers the transcript (at `4a5173a`, the branch's last commit before its own fix for E42 item 1; the case passes at `26c3535`, which has that fix); the backup of a repository with a corrupt commit says `complete`; with the index that is a link to `/dev/zero` the engine's peak resident memory crossed the bound within half a second of the backup's start and the case killed it; with the index that is a named pipe no `engine.backup` came within the bound. The changed load case fails on one assertion, the label: with one project's git held, that engine's backup ends within the window and says `complete`.

The Builder was fixing E42 on `build/slice-6` while this pass was written, from the errata text and before these cases existed. At its tip, `fb8ffae`, which holds a fix for each of the three items, every new case passes as written (the `/dev/zero` index: `complete` in about a tenth of a second, no rise in memory; the pipe: `incomplete_for_recovery` at the deadline, 2.2 s; the corrupt commit: `incomplete_for_recovery`, and the command refuses), and the changed load case passes in five runs of five (the backup ends about 36 s after its start, `incomplete_for_recovery`; 460 health samples, all valid, worst 7.4 ms). That says the cases can be passed; the expected results are the sources' and git's, and none was taken from the engine. The first runs of the load case on that tip found the race described under "A backup while a repository's git does not answer" (held work dispatched before the hold by a tick the engine had requested itself); the case now creates that work after the hold, and nothing else about its fixture changed. No harness module was changed; the helpers the new file needs are in the file.

## 98. Two reads added after M1 was accepted: a project's work items, and a candidate's gate evaluation

(D1 §§11.1, 11.3; E44 item 3, E47; `M70-scoped-reads-and-now.test.mjs`, one case each; `listWork` and `readGate` in `reads.mjs`. Written by the Verifier pass after M1 was accepted, on the accepted engine, which has neither route.) Both are reads as section 91 has them: a JSON object with `served_at` and `snapshot_seq`; nothing written (no row changes, no event is appended, no role is launched); every nested route verifies that the entity belongs to the project in the path. The keys are the stored column names (D1 A.3), as the decisions read's are.

**What this section changes in section 91:** its last sentence, which left every read E39 named unbuilt. Two of them are now fixed here; a project's operations, one decision by id and environments as a route of their own are still unpinned and unbuilt (the not-claimed list).

**`GET /v1/projects/:p/work`** → **200** `{"served_at", "snapshot_seq", "work_items": [...]}`: every work item of project `:p`, whatever its status, each once, in `seq` order (oldest first, as `execution.runs` lists runs), and no item of another project. D1's "work items by status" is this flat list with a `status` on each item; a grouping or a filter by status, and D1's "phase plan with stages", are not pinned. Each item has at least:

| Key | Value |
|---|---|
| `id` | the work item |
| `kind` | its `WorkItemKind` |
| `status` | its `WorkItemStatus`, as stored |
| `subject` | the stored object: D1 A.3's work-item subject keys (`stage`, `candidate`, `finding`, ...); `{}` for the trigger fixture's default |
| `trigger_source`, `trigger_id`, `trigger_generation` | the stored trigger identity (section 15) |
| `chain` | the stored column: the number of roles of the chain whose outcome created the item (section 40; D1-34). 0 for an item a person or a fixture made; 1 for the `verification` item a nomination made on a Builder's run, which is why the default `max_chained_roles` holds it |
| `blocker` | null while the item has none. Otherwise the stored object (sections 15 and 40: `reason`, `raised_at`, and `decision`, the open `blocker` decision that holds the item) and `options`: that decision's options in their stored order, each with at least its `key`, so that a person sees from this read why the work waits, which decision to answer and what can be answered. The preview hash an answer needs is the decisions read's (section 91) |

The case pins the two blockers M1 raises on a work item: the chain boundary (status `eligible`, reason `max_chained_roles`, options `continue` and `cancel`) and a parked item (status `parked`, reason `repair_attempts_max`, options `retry` and `cancel`), beside an item nothing blocks (the stage's work, `verifying`, `blocker` null) and another project's item. Not pinned: `depends_on`, the counters, `prior_status`, `dispatch_hold`, `continue_from`, `created_at`; the other parking reasons (`preflight_refusals_max`, `deadline`, `budget_exhausted`, `integration_branch_checked_out`), which are the same object; a quarantine's blocker, which is about a run (section 16) and not on a work item; what the route answers for a project that does not exist.

**`GET /v1/projects/:p/candidates/:c/gates/:kind`** → the latest stored evaluation of gate kind `:kind` for candidate `:c`: the `gate_evaluations` row of that candidate and kind with the highest sequence, the one the candidate read's `gates.<kind>` names (section 95). **It evaluates nothing:** it computes no scope, records no evaluation and writes no event, whatever the stored evaluation's staleness; the store's evaluations are the same before and after it. The evaluation route of section 70 is the one way to ask for an evaluation.

- With one: **200** `{"served_at", "snapshot_seq", "evaluation": {...}}`, where `evaluation` has at least the keys the evaluation route answers with (section 70), each with the stored value: `id`; `gate_kind`; `outcome`; `reasons`, `[{"code", "subjects"}]` as the evaluation route returned them, each reason naming the ids it is about; `check_states`, one entry per check of the scope's `required_check_ids` and no other, which is the scope's required checks with their states; `scope`; `stale`, a JSON boolean, the row's column. So a read after an evaluation returns exactly what that evaluation recorded, and once a second evaluation of the kind has been recorded (the case: a failed execution, then the route again) the read returns the second, with the check `failed`, and not the first.
- With none: **404** `not_found`, in the refusal form (section 6), with `subject` holding at least `candidate` and `gate_kind`, which is how it differs from a route the engine does not have (whose `subject` names the path). `not_found` is D1 A.7's code for a thing a read cannot find and D1 §11.1's for an entity outside the project; there is no evaluation to show, and the read makes none.
- A candidate that is not of project `:p`: **404** `not_found`, as a run or a record of another project is (sections 17 and 56; D1 §11.1).

Not pinned: D1's satisfiers, output records, the historical versus effective protected version and the delta since the last human-reviewed version; the `computed_at`, `candidate` and `stage` keys; a read of a gate kind the engine does not compute (the six of section 70, 501 on the evaluation route); a stale evaluation read while it waits for a tick (the case reads evaluations that are not stale, and the value is the row's); the ordering key among several evaluations beyond "the one the candidate read names"; a read for `alpha_authorize`, which is the same row shape.

**Names the Verifier fixed in this pass.** Each was open in the sources; the Builder may object. Those marked † carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| The work read's list key | `work_items` | The table's name, and the key `blocked_while_open.work_items` already uses for a list of them. |
| "By status" † | A flat list in `seq` order, each item with `status` | The simplest form D1's words admit; a grouping is a projection a client can make. |
| Which items | Every item of the project, whatever its status | The plainest rule; a filter is not pinned. |
| The trigger's keys | `trigger_source`, `trigger_id`, `trigger_generation`, flat | The stored columns (D1 A.3), as section 15 names them. |
| `chain` | The stored column, an integer | Engine-owned since slice 3; the one fact that says why the default chain limit holds an item. The values 0 and 1 follow from section 40's definition. |
| The blocker's form | The stored `{"reason", "raised_at", "decision"}` plus `options`, each with at least `key` | Sections 15 and 40 fixed the stored object; the options come from the decision it names, in the decisions read's form. |
| The gate read's envelope key | `evaluation` | The evaluation route's key (section 70). |
| Its keys | The evaluation route's seven, with `stale` a boolean | What section 70 already answers; "the latest evaluation per gate kind" of section 95 is the same row. |
| No evaluation yet † | 404 `not_found`, `subject` with `candidate` and `gate_kind` | D1 A.7 has no closer code; the subject tells it from a missing route. |
| Another project's candidate | 404 `not_found` | D1 §11.1: "`not_found` otherwise". |

**What was run.** The file alone with `node --test` after `npm run build`, on the accepted M1 engine (`main` at `d6de6e5`): 14 cases, 12 pass, 2 fail, the two new ones. Each makes its whole fixture and fails at its first read of the new route, which that engine answers 404 `not_found` with a `subject` naming the path: the work case at `listWork` (404 where 200 is expected), after the nominated candidate, the chain-boundary blocker, the parked fix and the other project's item were all seen in the store as this section says; the gate case at the refusal's `subject`, which has no `candidate` and no `gate_kind` (the status and code of a missing route are the same as this section fixes for "no evaluation yet", so the subject is what tells them apart), after the nominated candidate and its check were installed and no evaluation was found stored. Every other case of the file passes as before. What the two cases assert after their first read could not run; it was checked once with a scratch script, outside the suite and not kept, that built the same fixtures on that engine and printed the stored rows and the evaluation route's answers: the three work rows with the statuses, subjects, triggers, `chain` values (0, 1, 0) and blockers this section gives, the two decisions' option keys in the order `continue`, `cancel` and `retry`, `cancel`; the evaluation route answering exactly the seven keys of section 70, the first evaluation `missing` and the second `failed` with the same one subject, and the stored rows matching them. The expected values are the stored rows' and the evaluation route's answers, which sections 15, 40 and 70 already pin; none was taken from a read that does not exist.

---

# M2 slice 1: hardening before a backend

Written by the Verifier of M2 slice 1 (`docs/spec/M2-slice-1-hardening.md`; E48 item 1), on the accepted M1 engine (`main` at `49bd9bf`), which some of these cases already pass and some fail. Sections 99 to 103 take the five entries of the brief in order, A1 to A5. Each extends the sections it names and contradicts none; where an earlier section said a point was not pinned or not exercised, that sentence is now superseded by the section here that pins it, and is listed under "What this pass changes in earlier sections".

## 99. An unresolved observation of a nomination ref blocks that candidate's gates (A1)

(D1 §§7.2, 7.6, 9.3(3); D1-11, D1-18; E18; Plan M24 "unexpected registered changes block affected gates"; `M24-nomination-ref-blocks-gates.test.mjs`, listed under slice 8; sections 32, 42 and 72, which left this open.)

While a project has an unreconciled observation of a candidate's nomination ref (`refs/surety/cand/<seq>`, section 42), moved or deleted by someone other than the engine, **every gate evaluation of that candidate carries `OUT_OF_BAND_CHANGE`**: the `stage` gate and `alpha_authorize` alike, whatever the candidate's evidence says. The evaluation is made and recorded as any other (section 70), its `check_states` are computed as they would be without the observation (the case reads the check `passed`), and it is `not_satisfied`. Nothing a satisfied evaluation does happens: no authorization is issued (`deployment_authorizations.status` stays `proposed`, no `authorization.issued`), and no `stage_build` work completes on it. Once the observation is reconciled (`discard`, the one answer such a ref offers; section 42) and nothing is unresolved, an evaluation of the same candidate on the same evidence is `satisfied`, and a satisfied `alpha_authorize` evaluation then issues the proposed authorization. The case asks for the evaluations by their route after the discard; it does not rely on the engine re-evaluating a blocked gate by itself (section 72 pins that for the integration branch only).

Not pinned: whether such an observation blocks the gates of **other** candidates of the project, or the project's dispatch (section 42); the `subjects` of the reason; whether the observation of a nomination ref stales an earlier satisfied evaluation; `adopt`, which an immutable ref never offers.

## 100. A replayed result is validated against the protected set in force at integration (A2)

(D1 §7.3 steps 2 and 3, §7.5, §7.9; RN R2; Plan M28 "successful path validates the rebased tree, parent and protected set"; `M28-replayed-result-against-new-protected-set.test.mjs`, listed under slice 8; sections 28, 43 and 66.)

**The rule.** A Builder's result whose base is behind the integration branch is rebased onto the head (section 43) and the rebased tree is validated as section 28 says, **with the protected roots of the effective protected version at that moment**, not the roots in force when the run was launched or when its workspace was made. So an edit of a path that was nobody's when the Builder started and lies under a root an approved protected change added while the Builder worked is a protected change a Builder may not make: the run ends `failed` / `diff_violation` with a `reason_text` naming the path; nothing of the run is on the integration branch, which stays at the protected commit; the registry expects that commit; no `ref_update` of the run succeeded; no commit of the run is reachable from the integration branch; the effective version is the tightened one; the work item is not `integrated`.

**How the change lands mid-run.** With one run per project a role cannot propose while a Builder runs, but a human proposal needs no run: `POST /v1/projects/:p/policy` with `{"protected_paths": [".surety/checks/", "docs/policy/"]}` becomes a `captured` proposal by `human` (section 66; `governedEdit` in `gates.mjs`), the fixture classifies it `tightening`, the human approves it through `check_correction_tightening`, and the application is a journaled commit on the integration branch (section 69) that lands while the Builder is held in its workspace (`humanApplies`, which asks for ticks without waiting for the project's runs to end, as row M43's sign-off case does). The fixture then shows: one protected commit on the run's base, changing the governed file only; the new version's fingerprint equal to the harness's over both roots (`protectedFingerprint(repo, head, roots)`); the Builder's file in the protected set in force at integration.

Not pinned: **at which validation the rejection happens** (the snapshot's, which section 28 runs against the base, or the rebased tree's; the accepted engine rejects at the first, with no commit of the run made, and an engine that commits the snapshot under a keep ref and rejects the rebased tree would satisfy the case as long as nothing reaches the integration branch); the exact `reason_text` beyond the path; what the work item is after the rejection (`eligible`, or `parked` at `repair_attempts_max` 0) and its repair; whether the roots of a protected change approved **after** the result was validated but before the swap are consulted (the case lands the change before the role reports); a loosening that removes a root while a Builder works (an edit that was protected at the base and is not at integration), which the case does not exercise.

## 101. A correction's preview binds the proposal's content and the approved specification (A3)

(D1 §§4.6, 10.5; Review B12, "the same tree/diff and policy do not establish that the approved correction still applies to the current source and requirements"; build spec §6 correction 22; Plan M53 "change proposal status/tree/base, approved spec/scope", M54 "changed source/spec/scope approvals", M55 "replace evidence, classification or proposal base"; one case in each of `M53-…`, `M54-…`, `M55-…`, made by `harness/stale-correction.mjs`; sections 76 and 77.)

Two of the manifest keys section 77 lists for the three `check_correction_*` kinds had no case that changed them: `tree` and `spec_revision`. Each is a fact the preview rests on, and a change to either between preview and answer refuses the answer as section 76 says (`decision_stale` or `decision_invalidated`), consumes, approves and intends nothing, leaves the proposal and the branch as they were, and is followed by the next generation about the same proposal, whose manifest differs in that key and carries no approval (`nextGeneration`). The case takes both changes in turn, for each kind:

- **The proposal's content.** `tree` is the proposal's `tree_id` as stored. No engine path rewrites a captured proposal's tree, so the case changes it in the store with the engine stopped (`UPDATE "protected_proposals" SET "tree_id"`), as rows M45 and M51 change a dependency no path changes while the question stands (sections 65 and 83); the replacement is a real tree on the proposal's own base, made by a commit no ref points at. After the restart the earlier preview is refused, and the next generation's `tree` is the replaced tree. `diff_hash` is left as stored; whether the engine recomputes it from the tree is not pinned.
- **The approved specification.** `spec_revision` identifies the approved specification as M1 has it: the requirements the plan fixture installed, which belong to "the fixture's approved spec" (section 67). The one M1 path by which the approved specification changes is a further plan fixture call that adds a requirement; the case adds one (with the stage the fixture requires, whose Builder is scripted to exit without a result, so that the stage integrates nothing and `integration_revision` does not move). After it the earlier preview is refused and the next generation's `spec_revision` differs. **The form of `spec_revision` is not pinned**: null while the project has no requirement is acceptable, and so is any value that changes when the set of requirements changes (a count, a hash of the keys, a row id); only that it changes is pinned, and that it does not change when nothing of the specification does (the generation raised after the content change carries the first generation's value). The accepted engine records `spec_revision` as a constant null and accepts the approval after the change: that is the failure the Builder fixes.

The order of the two changes in the case is content first, then specification, so that the content half runs on the accepted engine. The policy widening is not in this section: see "Questions for the owner" below.

Not pinned: whether a change of `tree` by any future engine path is also a change of `diff_hash`; the manifest's value for `spec_revision` under a second plan whose requirements are all already known (the fixture says such keys are created once and returned after); what a `proposal_status` change by any path other than those sections 69 and 76 name does.

## 102. The answer `reject` (A4)

(D1 §§3.4, 10.2, 10.5, A.5 "Proposal" and "Assessment"; `../contract/decisions.json` `options`; Plan M49 to M55; one case in each of `M49-…` to `M55-…`; sections 76 to 78, whose last sentence of section 77, "the answers `reject` of the approving kinds are not exercised", this section supersedes.)

Each of the seven kinds that offers `reject` (`policy_widening`, `finding_disposition`, `severity_lower`, `finding_applicability_exclusion` and the three `check_correction_*` kinds) accepts it like any answer: **200**, the decision `consumed` with `answer.option` `reject`, no `approvals` row, no `effect_intents` row (`reject` in `decisions.mjs`). What it leaves is the least surprising reading of the sources, pinned per kind:

| Kind | After `reject` |
|---|---|
| `policy_widening` | The effective policy is as it was (`GET …/policy`: the same `revision`, the same `effective`); no `policy_revisions` row; nothing committed to the integration branch. |
| `finding_disposition` | The finding is as it was before the Reviewer proposed: `status` `open`, `disposition`, `disposition_authority`, `linked_issue`, `defer_target` null, severity and history unchanged (`findingState` in `gates.mjs` names the columns compared: those of section 83). The stage gate still names it under `FINDING_UNSATISFIED`. |
| `severity_lower` | The finding is as it was: `effective_severity` unchanged, `severity_history` unchanged (no entry is appended for a refused lowering). No check state changes. |
| `finding_applicability_exclusion` | The assessment is `rejected` (D1 A.5: `assessed → rejected`), `authorized_by` null, with one `assessment.rejected` naming it (D1 A.6). The finding is as it was and applies as before: the candidate's `alpha_authorize` gate still carries `FINDING_BLOCKING` naming it. |
| `check_correction_tightening`, `_loosening`, `_unclassifiable` | The proposal is `rejected` (D1 A.5: `classified → rejected`, `awaiting_human → rejected`), `resulting_version` null; nothing applied (the branch, the effective version as they were; `assertNotApplied`); no `protected_versions` row names the proposal, intended or otherwise; one `protected.rejected` names it (D1 A.6). For a tightening, a Reviewer's `proposal_approval` sent afterwards approves nothing: the proposal stays `rejected` and nothing is applied (A.5 gives `rejected` no exit; the human's decision stands against the other authorized approver). |

**The question is closed** (`assertQuestionClosed`): over three further `tick` calls the engine raises no decision of that kind about that subject, and the rejected decision still reads `consumed` with its answer and no approval. The thing is still as the table says after those ticks.

Not pinned: `protected_proposals.approver` and `approver_authority` after a rejection (whether the rejecter is recorded); whether `findings.proposed_disposition` and `proposed_severity_change`, engine-owned columns section 83 does not list, are cleared; what the same question raised again after a rejection does (the same submission to the policy route, a Reviewer proposing the same deferral or lowering again, a new assessment of the same finding and candidate), since D1 §10.2 returns the existing row for an identity already used and says a generation advances only on a material change, which may make a rejected widening unrepeatable until the base changes: a question for the owner, below; the classification fixture sent for a rejected proposal; the `effect_plan` of the `reject` option beyond its existence; events other than the two D1 names for the rejected states.

## 103. A result is not reused across a change of the protected checks (A5)

(D1 §7.9 "invalidates dependent evaluations and results", §9.2; build spec §6 corrections 17 and 18; Plan M41 "change one bound dependency at a time"; the second describe block of `M41-typed-evidence-reuse.test.mjs`; sections 69, 71, 72 and 73.)

A check result recorded for candidate 1 under protected version A, offered to candidate 2 by an assessed reuse entry (section 73) after an approved tightening was applied between the two nominations (version B, candidate 2 nominated under it, the check declared again for B under the same key), **does not pass for candidate 2**: the check is `stale` in candidate 2's evaluation, which carries `CHECK_NOT_PASSED` naming the check and no other reason, and is `not_satisfied`; the required set is unchanged by the entry. Two rules of slice 5 give this result together and the case does not say which applies first: the result's `protected_version` is not the effective version (section 73, "its protected version … must match the scope"), and the result is invalidated by the application's finalizer (section 72, "an invalidated execution counts here, not under 1"). An execution of the check for candidate 2 under version B then satisfies the gate, and the old result stays invalidated.

Not pinned: whether the reuse entry is recorded as rejected or marked in any way; the state the check would have if the result were not invalidated but merely bound to the older version (both give `stale`); reuse across a loosening or an unclassifiable change (the same rule; one case, for a tightening).

## 104. An integration between a protected application's commit and its branch update (the slice's review, S1)

(D1 §§7.5, 7.6, 7.9, 7.10, 10.5; E31; E50's last paragraph; the Reviewer's probe of M2 slice 1, confirmed by running; the last case of `M53-check-correction-tightening-manifest.test.mjs`; sections 33, 43, 45, 69 and 76.)

**The race.** Section 69 says the application of an approved proposal is a `commit_tree` and then a `ref_update` of the integration branch, each a journal operation of its own. Between the two a run's integration can take the project's journal lock and move the branch: the application's commit is then made on H while the branch is at R, and its branch update is intended with `old_oid` H. The case stages it with the barriers of section 33, as the Reviewer's probe did, and asks for no tick while a barrier is paused: a `fix` Builder held in its workspace (`roleThatHolds`, `runToHold`); a human tightening through the policy route (`governedEdit`), classified by the fixture, its decision open and previewed against H (`askingForTicks`, as `humanApplies` finds it); `journal.ref_update.intent_committed` armed and the Builder released, so its integration is intended with old = H and waits; `journal.commit_tree.intent_committed` armed and the decision answered `approve`, which is consumed with one intent; the first barrier released and the second reached, the branch still at H; the second released. The integration, queued first, moves the branch H → R; the application's branch update then finds R.

**What is pinned** (D1 §10.5: git compare-and-swap is the effect's conditional execution, and a changed precondition invalidates the intent; §7.5: a failed swap overwrites nothing). The Builder's work is `integrated`, its commit on H, and the branch stays at R from then on. The effect intent of the consumed decision is `invalidated` with `invalidated_reason` `EFFECT_PRECONDITION_CHANGED` within four ticks of the run's end, and it is the decision's only intent. The consumption's local transition is withdrawn as section 76 says: the proposal is `classified` again with `resulting_version` null, the effective version is the one that was in force, and no `protected_versions` row of the proposal is `authorized` or has `effective_from`, then or after the project has gone on. No `blocker` decision of the project is open and every operation of the project is `finalized` or `failed`: a swap that failed against a head the engine itself registered is not an ambiguity, and nothing is left for a person to acknowledge or for recovery to carry. The next generation of `check_correction_tightening` about the proposal is open, bound to R (`integration_revision`), with no approval, so the person decides again against the new head. A `fix` item added afterwards is dispatched on the next tick and its commit is integrated on R.

**What the accepted engine does** (the Reviewer's finding). The case reproduces it as far as the intent, where it stops: the run completes and the work is `integrated`, head R, and the intent stays `executing` after four ticks, with no reason. The Reviewer's probes, which the case does not repeat, saw the rest: the proposal stays `approved` with `resulting_version` null; the intended version stays `authorized` 0 beside the effective one; the application's `ref_update` is `ambiguous`, because its probe reads a branch at neither old nor new as `conflicting` (section 45's table) and blocks; one `blocker` with only `acknowledge` is open, saying git cannot be established; nothing of the project is dispatched again; a restart and the acknowledgement change none of it; a hand `update-ref` back to the protected commit is absorbed with no observation and drops the integrated commit from the branch. What the case asserts after the intent ran against no engine.

**Not pinned.** The journal state and attempt of the application's `ref_update` beyond "failed or finalized" (section 43 gives `intended`, `failed` for a run's integration whose swap failed; an engine that revalidates the head before intending the update, and never records one, satisfies the case too); the state the withdrawn version row takes, or whether it is kept, only that it is never authorized or effective; the fate of the protected commit under its keep ref and of its `revisions` row; the `reason_text` of anything; the answer's HTTP response (section 76); whether the invalidation is made in the answering request, at the run's end or at a tick; the same race for an approved `policy_widening`, which the Reviewer's variant probe reproduced: one case for the tightening, under E31; the race taken the other way round (the application's swap first, the integration's second), which is section 43's rebase. The case asks for no tick between arming the first barrier and releasing the second, and the accepted engine runs the answer's effect within the answering request, which section 76 leaves to the engine; an engine that runs it at a tick needs the case's step 3 to ask for one, which is an objection to the case's staging, not to the contract.

**What this changes in earlier sections.** Section 69, "Exactly one version results from one proposal, whatever crashes on the way": one or none; none when the branch moved under the application, and then the question is asked again. Section 77's M53 row, "the integration branch moves", is exercised at both moments: before the answer (section 77) and after the application's commit (this section).

## What this pass changes in earlier sections

- Section 42, "that it blocks the candidate's gates is slice 5's", and section 72, "Observations of other subjects are not pinned": a nomination ref's observation is pinned by section 99. Other subjects (`keep` and `oob` refs, checkouts) stay not pinned.
- Section 43, "no case makes a rebased tree fail validation": section 100 does, for the protected set.
- Section 77, "The answers `reject` of the approving kinds are not exercised": section 102.
- Section 77's manifest list for the correction kinds gains `tree` and `spec_revision` as values the tests pin (section 101), and `spec_revision` gains its M1 meaning.
- Section 73 and row M41's note that a reused result bound to another protected version "is not written": section 103.
- Section 65's "The store is written directly in two rows": three rows now, with M53 to M55 (the proposal's tree, section 101).

## Names the Verifier fixed in this pass

Each was open in the sources. The Builder may object. Those marked † carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| Which gates a nomination ref's observation blocks | That candidate's, both kinds (section 99). Other candidates and dispatch not pinned. | D1 §9.3(3) says "on the lineage"; D1-11 "gates blocked"; the Plan says "affected gates". The candidate whose marker moved is the one affected beyond doubt. |
| Which roots judge a replayed result | The effective version's at the moment of the (re)validation (section 100). | D1 §7.5 re-runs §7.3 validation; §7.3 partitions by the governed set, which section 66 reads as the effective version's roots. Roots frozen at launch would let the case's edit through. |
| At which validation the replay is rejected † | Not pinned (section 100). | D1 §7.5 says "journals that commit instead", which leaves open whether the snapshot's own commit is made first; only the outcome matters to the entry. |
| How a protected change lands mid-run | A human proposal through the policy route, classified by the fixture, approved by the human (section 100; `governedEdit`, `humanApplies`). | The only M1 path that needs no run while the project's one run is held; row M43 already uses it. |
| What `spec_revision` means in M1 † | The approved specification as the plan fixture installs it: it changes when a requirement is added, its form is not pinned (section 101). | The manifest key exists (section 77, the contract); the sources give M1 no spec revision entity, and the fixture's requirements are "the fixture's approved spec" (section 67). |
| How the proposal's content changes | In the store, engine stopped (section 101). | No M1 path rewrites a captured proposal; rows M45 and M51 set the precedent (section 65). |
| What `reject` leaves, per kind | Section 102's table. | D1 A.5 names `rejected` for proposals and assessments and nothing for findings and policy, so those are left as they were (the brief's rule). |
| "Not raised again at once" | No open decision of the kind about the subject within three `tick` calls (section 102). | D1 §10.2: a generation advances only on a material change; a rejection changes nothing of the subject. |
| Re-asking after a rejection † | Not pinned (section 102). | D1 §10.2 returns the existing row for an identity already used; whether a rejection is a material change that admits a next generation is the owner's. |
| The policy widening in A3 † | No case (section 101). | Every fact B12 names for the widening is in its manifest and exercised by row M49's base-change cases; binding the protected version or anything "governed" would be a new manifest key. |
| Reuse across versions | `stale`, `CHECK_NOT_PASSED` (section 103). | Sections 71 to 73 already give it; the case joins them in one history. |

## What was run

Each touched file alone, with `node --test` after `npm run build`, on the accepted M1 engine (`main` at `49bd9bf`, which `verify/m2-s1` was cut from); never two at once. The results are in `../COVERAGE.md`, "M2 slice 1: hardening before a backend", with the failing assertion and what the engine did for each case that fails. In short: the seven `reject` cases (A4), the replay case (A2) and the reuse case (A5) pass on the accepted engine, and are kept, as the brief says, to turn unclaimed behaviour into claimed; the nomination-ref case (A1) fails at its first gate assertion (the stage gate was `satisfied` with no reason while the marker's observation was unresolved); the three A3 cases fail at the second stale answer, after the approved specification changed (the accepted engine answered 200 and consumed the decision, since it records `spec_revision` as a constant null), their content half having passed. What the three A3 cases assert after that point ran against no engine; it is the same `nextGeneration` judgement the content half ran, with another key.

---

# M2 slice 2: a first real project is usable and legible

Written by the Verifier of M2 slice 2 (`docs/spec/M2-slice-2-legibility.md`; E48 item 1, E52), on the merged slice-1 engine (`main` at `8b0c7da`), which some of these cases already pass and some fail. Sections 105 to 110 take the six entries of the brief in order, B1 to B6. Each extends the sections it names and contradicts none, except where it says so under "What this pass changes in earlier sections"; where an earlier section said a point was not pinned or not exercised, the section here that pins it supersedes that sentence.

## 105. The remaining preview facts: a blocked item's continuation, a finding's status and scope, an exclusion's evidence and ancestry (B1)

(D1 §§4.6, 9.3(5), 10.2, 10.5, A.8; Review B12; Plan M45 "changed blocker cause, evidence, quarantine condition or allowed continuation", M50 "change finding status, current disposition, evidence, sensitivity, defer target/expiry or applicable scope", M51 "a changed relevant scope", M52 "change evidence/ancestry/scope"; one case in `M45-…`, one in `M50-…`, two in `M51-…`, two in `M52-…`; sections 76, 77, 83 and 101.) Each case follows section 76: a change of the fact between preview and answer refuses the answer (`decision_stale` or `decision_invalidated`), consumes, approves and records nothing, and is followed, where the question still stands, by the next generation about the same subject whose manifest differs in that key and carries no approval (`nextGeneration`).

**A parked item's continuation** (`blocker`, row M45). Section 77 gave `continuation` the value `eligible` for parked work. It is now an object, `{"status", "from"}`: `status` the status a `retry` resumes the item to (`eligible` for parked work), `from` the revision its next run starts from as the item stores it (`work_items.continue_from`: the checkpoint a run of it took, section 29; null when the next run starts from the integration branch's head). The case parks a fix whose first run checkpointed and whose continuation run then crashed with no repair allowed (`repair_attempts_max` 0; `runsOf` 2), so the preview binds `{"status": "eligible", "from": <the checkpoint>}`; it then clears `continue_from` in the store with the engine stopped, as row M45's cause case and row M51's sensitivity case change a dependency no engine path changes (section 65), and `retry` on the earlier preview is refused, the item stays parked and is not run again, the next generation binds `{"status": "eligible", "from": null}` with the cause and status as before, and a `retry` on it starts a run whose `base_revision` is the integration branch's head (the policy commit the case's own `repair_attempts_max` change made, section 27, read from the repository before the answer and checked against the registry and the first run's base; objection 001, upheld, corrected the case, which had compared with the commit before that change). Row M45's first case now reads the same form for an item that never checkpointed, `{"status": "eligible", "from": null}`. Not pinned: the form of `continuation` for the chain boundary (section 77 said `dispatch`; whether it becomes `{"status": "dispatch", "from": null}` or stays a string is the Builder's, no case reads it) and for a quarantine (null); whether a `continue_from` set while the item is parked by any future path is also a changed dependency (it is the same key).

**A blocker's evidence is not pinned.** The manifest key `evidence` exists for every blocker (section 77) and the engine binds nothing under it: M1 records no evidence of its own for a parked item, a quarantine or a blocked operation beyond the cause, the quarantine condition and, for an operation, the attempt's own record, which the preview does not bind by the engine's choice. No M1 path changes "the evidence of a blocker" while its question stands, and binding something under the key would be a design decision (what a blocker's evidence is): the Verifier's report carries it as a question for the owner, with the recommendation that in M1 the key stays empty and the entry is closed as having no evidence fact to pin. No case.

**A finding's status** (`severity_lower`, row M51). `finding_status` is the finding's `status` column. The case opens a lowering of a High finding, then has a Reviewer disposition the finding `fix` (recorded at once with the Reviewer's authority, E43, section 74), so the finding is `dispositioned`: the earlier approval is refused, the severity stays `high`, the next generation binds `finding_status` `dispositioned` and still asks the same lowering (`to` unchanged), and approving it lowers the severity while the disposition stands. The `finding_disposition` manifest carries the same key (section 77); no case changes it for that kind, the rule being one. A `resolved` finding ends either question (section 77's `preview`, "no longer stands"), which no case exercises.

**A finding's scope**, in both readings the sources admit. *The acceptance content* (`finding_disposition`, row M50; Plan M50 "answer binds the current finding and acceptance content"): `acceptance_content_hash` is the content hash of the finding's candidate as the stage gate computes it (section 70, `acceptance_scopes.acceptance_content_hash`), which changes when a check that covers a delivered requirement is declared (`installChecks` adds `import` for R1 after the preview; the required set is part of the content, section 70). The earlier approval is refused and nothing is recorded; the next generation binds the new hash, and its approval's `approvals.acceptance_content_hash` is that hash. *The applicable scope* (`severity_lower`, row M51; Plan M50 "applicable scope", M51 "changed relevant scope"): `applicable` is whether the finding applies to its own candidate (section 74: the originating candidate and its successors, unless an approved assessment excludes the candidate). The case has the Verifier propose, an independent Reviewer assess and the human approve an exclusion of the High finding for its own candidate while the lowering is open (row M52's path): the earlier approval is refused, the severity stays, the next generation binds `applicable` false and still asks the same lowering. Not pinned: whether a lowering of a finding that applies to no candidate should still be asked (the engine asks; the human sees `applicable` false).

**An exclusion's evidence** (`finding_applicability_exclusion`, row M52). `evidence` is `{"record", "quarantined", "missing"}` as section 77 gives it for a correction's rationale: the record the Verifier's applicability entry was published as (`assessment_evidence`, section 68), whether a detector has matched it (`post_scan` `hit`, section 57) and whether its bytes are missing. The case registers a detector that matches the evidence's text after the preview (`registerDetector`, section 57): the record is `hit`, the earlier approval is refused, the assessment stays `assessed`, the finding still blocks the candidate's `alpha_authorize` gate, and the next generation binds `quarantined` true. The detector's hit also raises the Critical findings D1 §14.2 names about every record it matched (the role's transcript among them); the case does not pin them and the gate's other reasons with them. Not pinned: whether `approve` carries a blocker once the evidence is quarantined; a `missing` change (no M1 path removes a record's bytes while a question stands).

**The candidate's ancestry** (`finding_applicability_exclusion`, row M52; Plan M52 "change evidence/ancestry/scope"). `ancestry` covers the assessed candidate's descent from the finding's candidate: the chain of `lineages.started_from_candidate` from the assessed candidate back to the candidate the finding was raised on (section 74's "successor reached through `started_from_candidate`", `predecessors`), so that an exclusion previewed for a candidate that descended from the finding's candidate cannot be approved once it no longer does. **Its form is not pinned**: the finding's candidate alone (what the merged engine records) does not change when the lineage does, so it is not enough; the list of candidates on the chain, or null when the assessed candidate does not descend, is enough; only that the value changes when the chain changes is pinned. No M1 path rewrites a lineage, so the case changes it in the store with the engine stopped (`lineages.started_from_candidate` set to null for the assessed candidate's lineage; section 65's precedent). After the restart the earlier approval is refused, the assessment stays `assessed` with nobody authorizing it and the finding is as it was. **Whether the question still stands is not pinned**: an exclusion of a finding that no longer applies to the candidate may be withdrawn (the earlier decision `invalidated`, nothing raised) or asked again about what is there now; the case accepts either, and requires that after three ticks the earlier decision is not open and at most one exclusion question about the assessment is, with another preview, another `ancestry` and no approval. The merged engine accepts the earlier approval (200, consumed): that is the failure the Builder fixes.

## 106. `adopt` of a checkout observation (B2)

(D1 §§7.6, 7.8; Plan M25, M46; `docs/spec/M2-slice-2-legibility.md` B2; two cases in a new describe block of `M46-out-of-band-change-manifest.test.mjs`; sections 32 and 79, whose "`adopt` for a checkout is not exercised" this section supersedes.) D1 §7.6 names the answer and says nothing of what it does to a checkout; the brief fixes the reading: the developer's edits become the new starting point.

**What `adopt` does.** The answer is accepted like `stash` (200, the decision `consumed`, one `effect_intents` row, `intent.recorded`; the `intent.recorded` barrier applies), and its effect is made through the journal, as a commit and a branch update: the engine commits the checkout's tracked content **as reviewed** (the tree the observation's `found.tracked_tree_hash` names, which is the tree of the checkout's tracked content as section 111 defines it, `trackedTree` in `repos.mjs`, computed test-side from the checkout's own index with `add -u` on a copy of it) as one commit whose only parent is the checkout's baseline `head`, and moves the integration branch to it by a journaled compare-and-swap from that commit (`ref_update` with `old_oid` the baseline, `new_oid` the commit, `succeeded`, finalized). Afterwards: the branch is at the commit and the registry expects it there; one `revisions` row of kind `out_of_band` records the commit with `created_by_run` null (section 32's `adopt` of a ref, the same kind); the commit changes exactly the edited paths against the baseline (the case: `src/lib.js` modified, nothing else); the observation's `disposition` is `adopt`, its decision consumed, `repo.reconciled` emitted once; every operation of the project passes `assertOperations`; the intent is `done`. **Nothing is lost or duplicated**: the branch gained exactly one commit, holding the edit once; no stray copy of it is needed on the branch. **The developer's files are left as they were**: the tracked files hold the developer's content byte for byte, nothing is reset or stashed, and the checkout, still on the integration branch, stands at the adopted commit (its HEAD follows the branch); its index is reset to the adopted commit so that `git status` is clean (E53 item 3; pinned by section 111's case). A kill between the adoption's journal entry and that index reset leaves a staged reversal, which the next integrity step observes as a checkout change and asks about: honest, nothing lost, and not pinned (the review's N1). **The engine's own adoption is not observed in turn**: across ticks and a restart the project has the one observation, dispositioned, and no other; so the checkout's baseline is advanced to what the checkout holds after the adoption (the mechanism of section 32; the case pins the absence of a second observation, not the baseline row). **The project dispatches again**, and the next run's `base_revision` is the adopted commit, its workspace checked out at it with the edit in it (the case holds that run; its integration is refused as row M22 says while the branch is checked out in the developer's worktree, which is the fixture's topology and not the adoption's doing).

**The fresh comparison** (section 79) holds for `adopt` as for `stash`: the file edited again after the answer and before the effect invalidates the intent (`EFFECT_PRECONDITION_CHANGED`, section 76), nothing is committed, the branch and the registry are where they were, no revision is recorded, no observation is reconciled, the newer edit is where the developer left it, and the next tick raises a decision about what is there now (`raisedAgain`). The case fixes nothing about the answer's HTTP response when its effect is afterwards invalidated (section 76); on an engine that refuses the answer, the case fails there.

Not pinned: the commit's message, author and committer (the engine's, as for a stash); whether an `oob` ref is also created for the reviewed tree (none is required; none is forbidden); what `adopt` invalidates of the open lineage's evidence (section 72 pins it for a ref's `adopt`; a checkout's is the same rule and no case reads it); `adopt` of a checkout that is a linked worktree rather than the repository's own work tree (the engine manages both, section 32; the case uses the latter); the order of the two journal operations beyond "the branch is at the commit when the intent is done".

## 107. NOW: the other causes of `refused`, and `unknown` (B3)

(D1 §§6.6, 7.6, 12.3, 13.3; Plan M70 "Correct NOW priority"; rows M24, M25, M61; four cases in a new describe block of `M70-scoped-reads-and-now.test.mjs`; section 91, whose "The other causes of `refused` D1 names ... and `unknown` are not pinned" this section supersedes.) The priority of section 91 stands: `refused` first, then `waiting_on_you`, `running`, `ready`, `idle`. The list and the project read give the same NOW. **The reason names the cause**: a sentence a person can act on, matched by the cases on a word of the cause and not pinned beyond that; `primary_action` is present (a string or null) and its value is not pinned.

| Cause | NOW | The reason names | The case |
|---|---|---|---|
| The repository cannot be read (an unreconciled `repository` observation, section 32) | `refused`, although the observation's decision is open | the repository (`/repositor/i`) | the repository made unreadable with eligible work (row M25); once readable again and the work run, NOW is not `refused` |
| An out-of-band change of the integration branch is unresolved (an unreconciled `ref` observation of the `integration` ref, section 32) | `refused`, although the observation is a decision waiting for a person | the change, or the branch (`/out[ -]of[ -]band\|integration branch\|refs\/heads\/main/i`) | the branch moved by hand with eligible work (row M24); after `discard` and a tick, NOW is not `refused` |
| The store fails for the project: the read of its spend that a budget check makes fails (the `budget_read` fault, section 61; row M61 pins that nothing is dispatched on it) | `refused` | the store or the budget (`/store\|budget/i`) | the fault armed to keep failing, two ticks dispatch nothing; another project's NOW is its own; once the fault is cleared NOW is `ready` and the work completes |
| The status itself cannot be computed (the store fails in the read) | `unknown`, in the project list, with the other projects' NOW computed as before | that it could not be computed (`/unknown\|comput/i`) | the harness fault `status_read`, below; once cleared NOW is `idle` |

**Two consequences for the engine, pinned by the cases.** The projection makes the budget read the dispatch's check would make (with its fault point), so that what would refuse a dispatch refuses the status, and the one store failure M1 can inject at a budget check is seen at the read; the merged engine reads the spend without the check and showed `ready`. And a failure while computing one project's NOW does not fail the list: that project is listed with `now.state` `unknown`.

**The harness fault `status_read`** (new; section 61's rules): `POST /v1/harness/faults` with `{"point": "status_read", "project": "proj_…", "times"?}`: the next computation of that project's NOW by a read, in the project list or the project read, fails as a store error. The merged engine does not know the fault (400 `invalid_value`); the Builder adds it with the rule. Not pinned: what the single project read (`GET /v1/projects/:p`) answers for a project whose status cannot be computed (200 with `now.state` `unknown`, or 500 `store_error`; the case reads the list), and whether `spend_today` and `execution` are given beside an `unknown` NOW.

Not pinned: NOW for a checkout observation (section 32 does not pin that it blocks dispatch; the merged engine shows `waiting_on_you`, which is honest, and it stays so until pinned); NOW for a nomination ref's observation (section 99 blocks gates, not dispatch); NOW while the journal has a blocked or unreconciled operation (`journalBlocks`; section 110's case does not read it); NOW for a paused project; whether a `refused` project's `primary_action` names the decision to answer; the exact sentences.

## 108. The three reads that were left: one decision by id, a project's operations, its environments (B4)

(D1 §§11.1, 11.3; E39, E47; `docs/spec/M2-slice-2-legibility.md` B4; three cases in a new describe block of `M70-scoped-reads-and-now.test.mjs`; `readDecision`, `listOperations`, `listEnvironments` in `reads.mjs`; sections 91 and 98, whose "a project's operations, one decision by id and environments as a route of their own are still unpinned and unbuilt" this section supersedes.) All three are reads as sections 91 and 98 have them: `served_at` and `snapshot_seq`; nothing written (no row changes, no event is appended, no role is launched, no observation's time moves); every nested route verifies that the entity belongs to the project in the path (404 `not_found` otherwise, section 98). The keys are the stored column names where a column exists. The fewest fields a person needs, as section 98 did.

**`GET /v1/projects/:p/decisions/:d`** → **200** `{"served_at", "snapshot_seq", "decision": {...}}`: the decision `:d` of project `:p`, **whatever its status**, with the list item's keys of section 91 (`id`, `kind`, `subject_type`, `subject_id`, `question`, `options` with each option's `key`, `effect_plan` and `plan_hash`, `preview_hash`), the same values the list gives while the decision is open, and `status`; once consumed, `answer` with at least `option` (section 76's object). So a person can read one decision without listing them all, answer from the read (the case confirms a Stop with the hash the read showed), and afterwards see that the answer took effect and what it was, although the list no longer shows the decision. A decision of another project through this path, and an id no decision has, are **404** `not_found` (D1 §11.1). Not pinned: `dependency_manifest`, `semantic_generation`, `blocked_while_open`, an option's `blockers`, `escalated_at`, the `note` and `actor` of an answer; D1's consolidation and "evidence resolved to records".

**`GET /v1/projects/:p/operations`** → **200** `{"served_at", "snapshot_seq", "operations": [...]}`: every journaled operation of project `:p` (the `operations` table, section 33), each once, in `seq` order (oldest first), and no operation of another project; pending and blocked ones included, as the case has them (one `intended` and held before its effect by the `journal.ref_update.intent_committed` barrier; one `ambiguous` and blocked by a restart whose probe found the ref `conflicting`, section 45). Each has at least:

| Key | Value |
|---|---|
| `id` | the operation |
| `kind` | the stored `OperationKind` (`git_ref_update`, `git_commit`, `git_worktree`) |
| `journal_kind` | its `JournalKind` (`ref_update`, `commit_tree`, `worktree_add`, `worktree_remove`): the kind of its journal events |
| `state` | the journal state: the kind of its last journal event (`git_journal_state.state`, section 44) |
| `status` | the stored `operations.status`, derived as section 44 says |
| `intent` | the frozen intent: the payload of the `intended` journal event as stored (`repo`, and `ref`, `old_oid`, `new_oid`, `tree`, `run`, `path`, `base` as the kind has them, sections 28, 30, 33), so that a person sees what the operation was to do |
| `attempts` | the operation's `operation_attempts` in `attempt_number` order, each with at least `attempt_number`, `status`, `started_at`, `finished_at` and `reconciliation_reads` as stored (section 44); `[]` for an operation not yet attempted |
| `finalized_at` | the stored column; null until finalized |
| `blocker` | the id of the open `blocker` decision whose subject is the operation (section 45, "One open `blocker` decision has the operation as its subject"), or null |

The case compares every listed operation with the store's rows for these keys, for a project with a finalized workspace and commit and a blocked integration, and for one with a finalized workspace and commit and a pending integration whose `intent` names the ref and the commits it moves from and to. Not pinned: the journal events themselves (D1 lists them; `state` is their last; an engine may add an `events` key); `idempotency_key`, `linked_prior`, `remaining_scope`, `created_at`, `deadline_at`, `target`, `subject`; `GET /v1/projects/:p/operations/:o` (D1 lists it; no case); a filter by state; the attempt's `timeline` and `incarnation`.

**`GET /v1/projects/:p/environments`** → **200** `{"served_at", "snapshot_seq", "environments": [...]}`: the environments of project `:p`, each once, and no environment of another project, **each exactly as the project read's `environments[]` entry shows it** (section 91: `id`, `name`, `observed` with `condition`, `observed_at`, `source`, `provenance`, `freshness`, `expires_at`), computed at the read from the same rows and clock, so the two reads agree at the same moment. A never-observed environment is shown with `observed.condition` `unknown` and `observed_at` null (what section 91 left not pinned; unknown is a value, and nothing says when). Past the freshness bound the entry is projected as section 91 says, `condition` `unknown` and `freshness` `expired`, with the stored observation untouched. Not pinned: D1's history, observation jobs and "operations in flight" (M1 has none, section 91); `target_set`; the order of several environments.

## 109. A usage observation whose write keeps failing stops the run (B5)

(E37 item 3, decided; D1 §§6.6, 13.3; row M61; one case in the budget block of `M61-budget-boundaries-and-failed-reads.test.mjs`; section 55, whose last paragraph said "No case pins this, and the blocker's reason for it is not named here", which this section supersedes.) With the `before_event` fault on `invocation.usage` armed to keep failing (`times` 1000, section 61) and a role that sends one observation well within every limit and waits, the engine retries the write for the bounded time it retries a result's (section 61) and then ends the run through the run-end protocol as it ends a run under way whose budget cannot be read: within 90 seconds of the observation the run is `stopped` / `budget`, `code` `budget_exhausted`, termination observed before the end, the workspace retained; no `usage_observations` row exists for the invocation; its original ledger row has `billable_in`, `out` and `cost_usd` null, `cost_status` `unknown` and `usage_complete` 0, and the ledger's totals count one invocation, `usage_incomplete` 1, `unknown_cost_invocations` 1 and `billable_in` null, never zero; the work is `parked` with `blocker.reason` **`budget_unreadable`**, the name the engine already gives a run stopped because its budget could not be read, with one open `blocker` offering `retry` and `cancel`. Once the fault is cleared, `retry` runs the work again as a new invocation and the stopped run's charge is as it was. The merged engine does all of this (the case passes on it); the entry is claimed by it. Not pinned: how many times the write is retried and at what intervals (only the bound); the run's `reason_text`; whether the blocker's question says the observation was lost.

## 110. A git write that overruns its deadline while the engine runs (B6)

(D1 §§7.1, 7.5, 7.10, 8.1 step 2, 8.5; Plan M15 "possible writes become ambiguous, dependent integration/dispatch stays suppressed after late completion"; build spec §6 corrections 14 and 16; `M15-git-write-deadline-in-a-running-engine.test.mjs`, listed under slice 9, one case; `heldGitWrites` in `harness/held-writes.mjs`; sections 34, 44, 45 and 47, and `../COVERAGE.md` "What the second session could not turn into a test", whose first item this section supersedes.)

**The tool.** `holdGit` (section 34) holds every git call on a repository, so the first call held is a read and a write is never reached in a running engine. `heldGitWrites(t)` holds a write by what it is: the engine is started with a `git` on its PATH (`scriptedEngine(t, {env})`) that is a shell wrapper of the real git; it looks at the subcommand the engine asked for and, while a hold is in place for it, waits before handing over to the real git, and hands every other command over at once. Two holds: the commit object's write (`hash-object -w`, which is how the engine writes a commit, section 45) and `update-ref` of a ref under a given prefix (`refs/heads/` holds the integration branch and lets the keep ref through). A held command never starts; when the engine kills it at the deadline nothing of it is in git, and that is what the engine then has to establish. Reads, probes, the snapshot and the worktree commands go through. Like the power-loss shim (section 60), it stands for one thing, a write that does not return in time, and not for a git that completes after the engine gave up (a late completion); the wrapper logs the commands it held (`heldLog`), which the case reads to see that exactly the two writes were held.

**What is pinned**, for the commit object write and then the branch update of one run, each held past `git_deadline` (2 s in the case):

1. **Killed and ambiguous.** The engine kills the write at the deadline and records the operation `ambiguous`: one `ambiguous` journal event, the one attempt `ambiguous`, the status `ambiguous`, no `applied` or `confirmed` event (sections 34, 44). Nothing is taken for made: no commit names the run; the branch is where it was.
2. **Nothing is taken for failed either.** While the operation is unresolved, the run is **not ended** (section 47: "The run is not ended while an operation it issued is in flight: issued effects are reconciled first"; a timer is not an outcome, section 34), no second run of the work is started, the work is neither `integrated` nor given up (not `eligible`, not `parked`), and nothing else of the project is dispatched (an eligible verification item added meanwhile has no run; section 45, "Nothing of the operation's project is dispatched while its journal has a blocked operation", read as "unresolved"). The merged engine ends the run `failed` / `infra_error` ("the run's commit could not be made (ambiguous: {})") when its commit goes ambiguous, returns the work for repair, and then, at the next tick, reconciles the commit and makes it for a run that is over, under a keep ref that nothing integrates: the work would be done twice by the repair, which is the risk the not-claimed entry named. That is the failure the Builder fixes.
3. **Established by a probe, before anything goes on.** The next tick's journal step probes the operation (D1 §8.1 step 2): the effect is positively absent (the object does not exist, the ref is at its old commit), the killed attempt is `reconciled_absent` with its last read `absent`, the journal is still `ambiguous`, and the engine pauses at `journal.<kind>.reconciled` (section 45) with nothing made and the facts of item 2 unchanged.
4. **Made exactly once.** One new attempt makes the effect: the journal goes `intended, ambiguous, applied, confirmed, finalized`, the attempts `reconciled_absent`, `succeeded`, the status `succeeded`; `assertOperation` holds. The commit has the tree and the parent the frozen intent named (section 45, "A commit's identity is stable across a retry") and is published under its keep ref; exactly one commit names the run. The branch update is a compare-and-swap from the base to that commit, made once: the branch gained exactly one commit.
5. **The run completes and the work is integrated once.** Within a bound of ticks after the integration is finalized the run ends `completed` / `none`, its work is `integrated` by its one run with `repair_attempts` 0, one `engine_commit` revision records the commit, the branch and the registry are at it, the commit changes the role's edit and nothing else, and the project goes on: the waiting item is dispatched and completes, and the integrated work is never run again.

Not pinned: NOW while the operation is unresolved (section 107); a late completion (git finishing after the kill), which the tool cannot produce and which section 45's `applied` row covers through a restart (rows M29, M30); what happens when the retry is itself killed at its deadline (the hold is lifted before the retry; one retry per reconciliation is section 45's rule, and the journal cannot carry a second `ambiguous` event, section 44); how the run learns that its operation was finalized by the journal rather than by its own driving (the finalizer, a wait in the acceptance, or a tick); the run's lease during the wait (section 16 renews it while the engine holds the run); a `worktree_remove` or `worktree_add` held the same way (rows M15 and M31 pin those through `holdGit`); whether the second item's dispatch waits for the run's end or only for the journal (both hold in the case, which reads it after the run has ended).

## 111. A checkout's tracked content includes what the developer staged (the slice-2 review, S1 and S2)

(D1 §7.6; `docs/spec/M2-slice-2-legibility.md` B2; E53 item 3; the slice-2 review's findings S1 and S2, confirmed by running; one case in the stash block and one in the adopt block of `M46-out-of-band-change-manifest.test.mjs`; `trackedTree` in `repos.mjs`; sections 32, 79 and 106.)

**The defect.** The engine's reading of a checkout's tracked content (`checkoutBaseline`: the tree of HEAD with the tracked paths refreshed from the work tree) left out every path that is in the index and not in HEAD. So a file the developer had staged was not in the tree the observation found, not in the stash's `oob` ref and not in the adopted revision; `stash` then removed it from the index and from disk when it restored the baseline (lost), and `adopt` left it untracked on disk and out of the next run's base. A version staged and then superseded in the work tree was committed as the work tree had it and the staged version dropped, which is right (below), but the baseline restore of a stash dropped it too. The harness's own `trackedTree` had the same reading, from HEAD, and is corrected with the engine's.

**The reading, pinned.** A checkout's tracked content, for the observation's `found.tracked_tree_hash`, for what `stash` keeps and for what `adopt` commits, is **what `git commit -a` would commit**: the checkout's index with every path the index lists refreshed from the work tree. A staged addition is in it; a staged version superseded in the work tree gives way to the work tree's version; a tracked file deleted from the work tree is not in it; an untracked file is not in it. `trackedTree(checkout)` computes it test-side from a copy of the checkout's index. The fixture (`stagedCheckout`) stages a new file `src/new.js`, stages an edit of `src/lib.js` and then edits it again on disk, and reads the tree before the engine looks: it holds the new file and the on-disk edit.

- **`stash`** (S2; section 79): the `oob` ref's tree is that tree (against the baseline: the addition and the edit, nothing else; the new file's content and the on-disk version of the edit); the checkout is back at its baseline, clean (`git status --porcelain --untracked-files=all` empty, HEAD at the baseline, the edited file at its baseline content), so the staged file is in the stash and not on disk as a stray; whatever is on disk of the new file, if anything, is what the ref holds; the observation is reconciled `stash` and nothing is observed again. The merged engine fails at the ref's tree: it changes only `src/lib.js` against the baseline.
- **`adopt`** (S1; section 106): the adopted revision's tree is that tree, one commit on the baseline adding the staged file and changing the edited one; afterwards the new file and the on-disk edit are on disk as the developer left them, and the checkout is on the branch at the adopted commit with `git status` clean (nothing staged, modified or untracked: the index is reset to the adopted commit, E53 item 3); not observed again; the next run's base is the adopted commit and its workspace holds the file and the edit. The merged engine answers 501, as for section 106's cases.

Not pinned: a tracked file deleted from the work tree (in the reading, not in the case); a staged deletion; an untracked file beside a staged one (not tracked content: neither stashed nor adopted, and left where it is); the dangling blob of a superseded staged version (git's, not the engine's); the index's stat information after a stash's restore.

## 112. A Stop confirmed while a run's write is ambiguous waits for the journal (the slice-2 review, S3)

(D1 §§4.5 step 4, 7.10, 8.1 step 2; E27 item 5; Plan M13, M14 "the run is not ended while its operation is in flight; a made integration is integrated, then held"; the slice-2 review's finding S3, confirmed by running; the second case of `M15-git-write-deadline-in-a-running-engine.test.mjs`; sections 47 and 110.)

**The defect.** With the run's branch update ambiguous (section 110), a confirmed Stop ended the run at once (`stopped` / `human_stop`, the work `held`) with the operation still `ambiguous`; the engine's wait for the journal returned as soon as the run left `validating`. When the killed write had in fact landed, the later reconciliation finalized the operation and the branch moved, but the work was never `integrated` and nothing was nominated, and a Resume dispatched a second run on a base that already held the first run's edit. An Abandon went the same way with the work `eligible`. A restart in the same state was handled correctly.

**What is pinned.** Section 47's rule holds for an ambiguous operation as for one in flight: **the run is not ended while an operation it issued is unresolved**; a Stop confirmed meanwhile is recorded (the decision consumed, the lease closing) and the end is decided, so nothing renews the lease from then on (E27 item 5: the case reads the run lease's `renewed_at` and `expires_at` after the Stop and three seconds later), but the run is not ended and the work is not held until the journal has established what git did. The case lands the killed write by hand before the next tick (`git update-ref <branch> <run commit> <base>`, the same compare-and-swap; **a hand update stands in for a late completion**, git finishing after the engine gave up, which `heldGitWrites` cannot produce, section 110), confirms the Stop, and waits three seconds with no tick: the run has not ended, the operation is `ambiguous`, the work is not `held`. The next tick's journal step probes: `applied`; the operation is finalized with no new attempt (the attempt `reconciled_succeeded`, section 45); the finalizer integrates the work (`integrating → integrated`, one `work.integrated` event); and then the Stop takes its course: the run ends `stopped` / `human_stop`, workspace retained, the work `integrated → held`. The branch is at the commit, the registry expects it there, one revision records it, one run and no repair: nothing is done twice. The merged engine never reaches the Stop: it ends the run `failed` / `infra_error` when the write goes ambiguous (section 110's defect), where the case's liveness check stops it.

Not pinned, under the same rule: an Abandon confirmed in the same state (the work `integrated` and then given back `eligible` under the dispatch hold, the workspace discarded; section 47); the write found absent after a Stop (the operation failed, the work held as today, section 47's first bullet); a nomination after the integration (the case's project is T2 with a fix that names no finding, so none is due; "as usual" means as section 42 has it for the item); how long after the finalizer the run ends (the case allows six ticks); what the run's lease does between the Stop and the end beyond "not renewed".

## What this pass changes in earlier sections

- Section 77, "`continuation` (`eligible` for parked work)": an object `{"status", "from"}` (section 105). Row M45's first case is changed with it.
- Section 77, the manifest list: `finding_status`, `acceptance_content_hash` and `applicable` for the finding kinds, and `evidence` and `ancestry` for the exclusion, are values the tests pin (section 105), with `ancestry`'s form left open.
- Section 79, "`adopt` for a checkout is not exercised": section 106.
- Section 91, "The other causes of `refused` D1 names ... and `unknown` are not pinned": section 107. Section 91's "What an environment that was never observed shows is not pinned": section 108.
- Sections 91 and 98, "a project's operations, one decision by id and environments as a route of their own are still unpinned and unbuilt": section 108. Section 91's "a read of consumed or invalidated decisions" and "`GET /v1/projects/:p/decisions/:d`": section 108 pins the read by id, consumed included.
- Section 55's last paragraph, "No case pins this, and the blocker's reason for it is not named here": section 109, `budget_unreadable`.
- Section 34, "what depends on it does not go on", and section 45's "An operation a git deadline left ambiguous", which named the two worktree kinds: section 110 adds a commit and a branch update in a running engine, and `../COVERAGE.md`'s "A commit or a ref update left ambiguous by a deadline while the engine runs" is no longer untested.
- Section 61's table gains the fault `status_read` (section 107).
- *After the slice-2 review:* section 32's checkout `found` and section 79's "the checkout's tracked content as reviewed": the content includes what the developer staged (section 111); `trackedTree` starts from the index. Section 106's "what the checkout's index holds after the adoption" is now pinned (clean). Section 47's "the run is not ended while an operation it issued is in flight" is read for an ambiguous operation too (section 112).

## Names the Verifier fixed in this pass

Each was open in the sources. The Builder may object. Those marked † carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| The form of a parked item's `continuation` † | `{"status", "from"}`, `from` the stored `continue_from` (section 105) | The one stored continuation fact of a parked item in M1 is the checkpoint its next run starts from; a `retry` that resumes from another revision is another consequence (Plan M45). The alternative, a new manifest key, is the owner's to add. |
| A blocker's evidence † | Not pinned; no case (section 105) | The engine binds nothing under the key and M1 has no evidence fact for a blocker beyond what the other keys bind; what it should be is a design decision. |
| Which kind pins a finding's status | `severity_lower`, through a Reviewer's `fix` (section 105) | The one M1 path that changes a finding's status while a question about it stands and leaves the question standing. |
| "Scope" of a finding | Both: the acceptance content (`finding_disposition`) and the applicable scope (`severity_lower`) (section 105) | Plan M50 names both; one case each is cheaper than deciding which was meant. |
| How a lineage changes † | In the store, engine stopped (section 105) | No M1 path rewrites one; rows M45, M51 and M53 to M55 set the precedent (section 65). |
| `ancestry`'s form † | Not pinned beyond "changes when the chain changes" (section 105) | The finding's candidate alone is shown not to be enough; the Builder chooses the value. |
| Whether an exclusion question stands after the chain breaks † | Not pinned: withdrawn or asked again (section 105) | Either is defensible; what matters is that the earlier approval cannot be used. |
| What `adopt` of a checkout commits | The reviewed tracked tree on the baseline head, moved onto the branch by compare-and-swap, as one `out_of_band` revision (section 106) | The brief's reading; D1 §7.6 gives the kind for a ref's adopt and §7.8 the engine-made commit. |
| What the checkout is left as | Files untouched; index not pinned (section 106) | "Left as it was" is the brief's; a consistent index is a courtesy the case does not require. |
| `refused` for a store failure | The projection makes the budget check's read (section 107) | The one store failure M1 can inject at a check; D1 §12.3's "store error" and §6.6's refusal. |
| `unknown` in the list only | The list shows `unknown` for one project and the others as before; the single read not pinned (section 107) | D1 §12.3: `unknown` replaces the states when the snapshot fails; a list that fails whole would hide every other project. |
| The fault `status_read` † | A harness fault point (section 107) | No M1 situation produces a failed status computation from outside; a fault point is harness surface, as `budget_read` and `lease_read` were (section 61). |
| The operations read's keys | Section 108's table | The stored columns and the intent's payload, which the tests have read since slice 3. |
| `blocker` on an operation | The open blocker decision's id (section 108) | What a person needs next; the work read gives a blocked item the same (section 98). |
| A decision read by id when consumed | 200 with `status` and `answer` (section 108) | D1 §11.3 lists the route beside the list; a person who answered should see that it took effect. |
| A never-observed environment | `condition` `unknown`, `observed_at` null (section 108) | Unknown is a value; the project read already shows it so. |
| The park reason of a lost observation | `budget_unreadable` (section 109) | The engine's own name for a run stopped because its budget could not be read; E37 item 3 says "as it is when the budget cannot be read". |
| How a git write is held | A wrapper on the engine's PATH that waits before the real git (section 110) | The engine runs `git` by name with its own PATH (exec.ts); a hold by subcommand touches no read and no repository file. |
| What a timed-out write does to its run † | Not ended while the operation is unresolved; completed once it is finalized (section 110) | Section 47 already says issued effects are reconciled first; a run failed on a timer and then repaired is the duplication the entry guards against. |
| *After the review:* a checkout's tracked content | What `git commit -a` would commit: the index, refreshed from the work tree (section 111) | The one reading under which a staged file is neither lost by a stash nor left behind by an adopt; the developer's `git add` is a review of that file. |
| *After the review:* a hand `update-ref` as a late completion | Stands in for git finishing after the kill (section 112) | The tool holds a write before it starts; ambiguity covers both, and the probe cannot tell them apart. |
| *After the review:* Stop while a write is ambiguous | The run waits for the journal; the work is integrated, then held (section 112) | Section 47 and Plan M13/M14 say so for an operation in flight; an ambiguous one is in flight until a probe says otherwise. Abandon not pinned. |

## What was run

Each touched file alone, with `node --test` after `npm run build`, on the merged slice-1 engine (`main` at `8b0c7da`, which `verify/m2-s2` was cut from); never two at once. The results, with the failing assertion and what the engine did for each case that fails, are in `../COVERAGE.md`, "M2 slice 2: a first real project is usable and legible". In short: B5 and four of the six B1 cases pass on the merged engine and are kept; the blocker's continuation (and row M45's first case, changed with it), the exclusion's ancestry, both `adopt` cases, all four NOW cases, the three reads and the held-write case fail, each at the assertion that names the behaviour the Builder builds. For the held-write case a scratch copy with the "not ended" assertions removed, run once outside the suite and not kept, showed the rest of its staging live on the merged engine as far as the engine goes: the `reconciled` barrier reached with the attempt `reconciled_absent`, the retry making the commit with the frozen tree and parent under its keep ref, the journal `intended, ambiguous, applied, confirmed, finalized`; the branch update never followed, because the engine had already failed the run.

**After the slice-2 review** (S1 to S3; 2026-10-03, on branch `verify/m2-s2-review`, `main` at `d3b57b2`, which holds the slice-1 engine): `M46-out-of-band-change-manifest.test.mjs` alone, 4 of 8: the S2 stash case fails at the `oob` ref's tree (the ref changes only `src/lib.js` against the baseline: the staged file is missing, as the review found); the S1 adopt case fails at the answer, 501 `unsupported`, like section 106's two. `M15-git-write-deadline-in-a-running-engine.test.mjs` alone, 0 of 2: the S3 case fails at its liveness check before the Stop (the run had ended `failed` / `infra_error`, "the integration could not be confirmed: its operation is ambiguous"), which is section 110's defect; the Stop and what follows ran against no engine. The S1 and S3 cases cannot reach their own assertions on an engine without the slice-2 build; the review confirmed both defects by running the slice-2 engine.

---

# M2 slice 10: the kernel lane of the trust table, the budgets, the carried decisions and the bootstrap default

Written by the Verifier of M2 slice 10 (`docs/spec/M2-build-spec.md` §9; `docs/acceptance/sdlc-M2-acceptance-plan.md` §3.1, rows M101 to M109), on `main` at `412bde4`, the accepted M1 engine with the two merged M2 slices, which has no trust table. Sections 113 to 121 fix what the plan's section 2.6 leaves to the tests for these rows and extend the sections they name; where an earlier section said a point was not pinned, the section here that pins it supersedes that sentence, and "What this pass changes in earlier sections" lists each. The sandbox and real lanes (M110 onward) are later slices' and are not pinned here, except where a name fixed now is one they will use (the host-checks switch, the stand-in binary, the engine-scoped decisions).

## 113. What the slice-10 tests assume throughout

- **The kernel lane** (M2 plan §2.1; BS §8). The scripted adapter and the scripted execution boundary of sections 13 and 14, in harness mode, as every M1 test: no sandbox is built and no real binary runs. The host checks are left unrun by the switch of section 114, which is the default in harness mode, so the hundreds of M1 engine starts run no probe. What these rows prove about a real backend is the engine's rules about it, on the kernel; what the sandbox does with a dispatch is the sandbox lane's.
- **"A real backend"** is a backend name the engine has an adapter for, `claude` or `codex` (D2 §4.5, §4.6), bound to the **stand-in binary** of section 116 by a fixture trust entry. The scripted backend, `scripted`, never has an entry: it is dispatched in harness mode with `--harness-scripted` as before, with both of its receipt's `trust_entry` and `qualification_attempt` null (K10, A.3), and is refused outside harness mode (section 118).
- **The policy names the backend** per role (section 115: `backend_builder`, `backend_verifier`, `backend_reviewer`, `backend_architect`, default `scripted`; `backend_mode`, default `one_shot_headless`). A project whose policy is at its defaults behaves as in M1. The rows change one role's key, the verifier's, and dispatch `verification` work.
- **Projects are on detached repositories** (`addGitProject`, section 25) wherever a policy is changed, since a policy change commits through the journal and is refused while the integration branch is checked out in the repository's own work tree (section 30).
- **Fixture entries are test setup** (M2 plan §2.3; Plan §1; E19): they say what an entry would hold once an attempt had succeeded, so that the rules about entries can be tested before any attempt has run, and they are labelled as fixtures in every event they cause. Nothing in this slice qualifies a backend, a host or a binary.
- **Engine-scoped decisions** (`trust_activation`, `qualification_approval`) belong to no project; the ticks a case asks for go through a project that only has to exist (section 117).

## 114. The host-checks switch and the harness check overrides

(M2 plan §2.3 "Host checks switch" and "Harness overrides"; BS §9 "Known straddles"; D2 §6, §7.1; row M110 will use both.)

| Flag | Meaning |
|---|---|
| `--harness-host-checks <unrun\|run>` | `unrun` (the default in harness mode): the host checks H1 to H13 and the probe suite are not run at start: no `host_qualifications` row is written, every check is reported `not_exercised`, and the host's eligibility for a real dispatch is the harness's say-so, as the scripted boundary stands in for the real one in this lane. `run`: the checks run as they do outside harness mode (the sandbox lane; section 114 pins nothing of it). Accepted only with `--harness`. |
| `--harness-host-check <Hn>=<failed\|not_exercised>` | Repeatable. The named check is reported with that result whatever the host says: under `unrun` it is the one check with a result other than `not_exercised`; under `run` it replaces the real check's result. A check reported `failed` this way makes the host not eligible, under either mode. Accepted only with `--harness`. |

Outside harness mode there is no switch: every start runs the checks (D2 §7.1). The flags reach production code as ordinary parameters, like `--harness-migrations` (section 7, "Confinement"); the eligibility the harness grants is harness-only behaviour and lives in the seam folder.

**Eligibility** is what a dispatch to a real backend needs of the host (D2 §4.1: a current active host qualification whose mechanism and profile fingerprint are compatible with the entry's). The engine read (section 118) and the `trust_activation` manifest (section 117) carry it as one object, `host_eligibility`:

```json
{"eligible": true, "source": "harness", "host_qualification": null, "mechanism_fingerprint": null, "failed_checks": []}
```

`source` is `"harness"` under `unrun` and `"qualification"` under `run` and outside harness mode; `host_qualification` is the active `host_qualifications` row's id, null while there is none; `mechanism_fingerprint` is that row's, null with it; `failed_checks` lists the ids of the checks reported `failed`, forced or real. Under `unrun` with no forced failure the host is eligible with no row: the kernel lane claims nothing about the host, and the M2 report says so. With `H6=failed` forced, `eligible` is false and `failed_checks` is `["H6"]`; a real dispatch is then refused `isolation_unqualified` (D2 §6), which no slice-10 case pins (row M110 (c)).

## 115. The closed configuration: D2's keys

(D2 A.7; `../contract/config.json`; rows M07, M73, M103, M107, M108, M109.) The engine and project keys of D2 A.7 join the closed sets, with D2's defaults and ranges, byte-valued keys in bytes; the contract file is the list. M07's "defaults are inspectable" and M73's "the closed configuration, key by key" pin every one of them from the file, so an engine that adds a key the file does not list, or omits one it does, fails those rows. M07's project-defaults case now compares with `deepEqual`, since two D2 keys default to an empty list; nothing else of M07 changed.

**Engine keys added:** `ui_bootstrap` (bool, default false), `max_concurrent_domains`, `host_reserve_memory`, `host_reserve_disk`, `domain_memory_max`, `domain_tasks_max`, `domain_writable_bytes`, `domain_writable_inodes`, `result_max_bytes`, `provider_files_max_bytes`, `collect_entries_max`, `collect_deadline`, `stream_line_max_bytes`, `stream_queue_max_bytes`, `egress_resolve_timeout`, `egress_connect_timeout`, `egress_tunnel_max_seconds`, `egress_tunnels_max`, `egress_buffer_max_bytes`, `egress_log_max_bytes`, `pause_challenge_timeout`. Each is validated as section 2 says: a non-boolean `ui_bootstrap` (`"yes"`, `"true"`, `1`, `0`, `null`, `{}`) is `invalid_value` with `subject.field` `ui_bootstrap`, exit status 4, nothing written. The numeric keys' ranges are the file's; no slice-10 case pins a range refusal for them (the sandbox rows may). `decision_targets` accepts `trust_activation` and `qualification_approval`, 2 d each by default (`decision_target_defaults`).

**`ui_bootstrap`** (D2 §2.6, K3, N05; row M107). With it false, `GET /v1/token/bootstrap` answers **403** `bootstrap_disabled`, in the refusal form, to every request whatever its evidence, after the Host check and before the token is read: with the harness fault `token_read` armed the answer is still 403, not the fault's 500. With it true, the route answers as section 90 says, and the exception is in force: `GET /v1/engine` reports `bootstrap_exception: true` (section 118), and the engine claims no protection from other local uids while it is (D2 §8 class C). The accepted M1 bootstrap case, `M68-browser-bootstrap.test.mjs`, is the labelled compatibility test: its engine opts in with `{"ui_bootstrap": true}` and its assertions are unchanged (the K3 change; `../COVERAGE.md`). The qualified M2 configuration leaves it false; what a host qualification does while it is true is row M110 (e).

**The fault `token_read`** (`POST /v1/harness/faults` with `{"point": "token_read"}`, one-shot unless `times`): the next time the bootstrap route takes the token to put it in an answer, that read fails and the request is answered **500** `token_read_failed`, with no token in the answer. It is the control that shows the default-off refusal comes before any token read.

**Project keys added:** `budget_run_boundary` (`BudgetBoundary`, default `invocation`), `budget_hard_maximum` (bool, default false), `egress_allow_extra` (host names, default `[]`), `sandbox_read_paths` (absolute paths, default `[]`), and the backend keys `backend_builder`, `backend_verifier`, `backend_reviewer`, `backend_architect` (each `scripted`, `claude` or `codex`; default `scripted`) and `backend_mode` (`one_shot_headless` or `session_headless`; default `one_shot_headless`). `budget_hard_maximum: true` is refused **400** `hard_cap_unenforceable` with `subject.field` `budget_hard_maximum` and no effect (D2 §4.2, E58 item 6): no M2 mechanism enforces a hard maximum; a provider-side cap is recorded as section 120 says. `egress_allow_extra` and `sandbox_read_paths` are **widenings** (section 78 gains them): a submission that adds a host or a path raises `policy_widening`, whose manifest's `widens` names the key and whose `proposed_policy` holds the complete value, and the policy is unchanged until the human approves; a submission that only removes entries is an ordinary change, answered 200 with the next revision, `widens_authority` 0. Replacing one value with another adds and so widens. Naming a backend or a mode is an ordinary change: an entry is active only by the human already. A path in `sandbox_read_paths` is validated for its form at submission (absolute) and against the forbidden set at every launch (section 120).

## 116. The trust table in the kernel lane: the stand-in binary, the fixture routes, what a dispatch to a real backend does

(D2 §§1.1, 1.2, 4.1, 4.2, 7.2, 7.3, A.1 to A.4; M2 plan §2.3; rows M101 to M103, M109; `harness/trust.mjs`, `harness/standin/backend.mjs`.)

**D2's mechanism identifiers.** The one isolation and the one boundary an entry may name in M2: `isolation` is `linux-namespaces-1` (D2 §2.2), `boundary` is `cgroup2-delegated-scope-1` (D2 §3.1). A fixture entry naming anything else is refused at write (**400** `invalid_value`, `subject.field` the column), and the store refuses an UPDATE of either column on any entry (a constraint error): an entry's mechanism never changes; a different mechanism is another entry from another attempt.

**`host_id`** (M2 plan §2.6) is a stable identity of the installation and never the boot id: the trimmed content of `/etc/machine-id`. The tests read the same file; a host without it fails the cases that compare it.

**The provider key's reference.** The secret reference a backend's API key is resolved by is `backend/<backend>/api_key` (`backend/claude/api_key`); the grant of a dispatch to that backend names it. In M1's resolver the harness holds it with `POST /v1/harness/secrets` (section 57), whose body gains an optional `provider_cap_usd` (section 120).

**The stand-in binary** (M2 plan §2.3) is a test-owned executable, `harness/standin/backend.mjs` written by `StandIn` into the test's own directory with a shebang naming the test's node (so the engine's constructed `PATH` cannot keep it from starting), mode 0755; the entry records its path and the SHA-256 of the file as written. It records what it was given, one JSON line per launch in `standin.jsonl` beside it (`args`, `env_keys`, the SHA-256 of each environment value, `cwd`, the domain and invocation markers, its pid and start time), writes nothing to stdout, reads nothing from stdin and exits 0. In slice 10 it is an instrument of the refusal rows and of M103 (e): what it runs after recording (the scripted child, for the canaries of M135) is a later slice's extension. It can never be a real backend's real binary, and only the kernel and sandbox lanes use it.

**`POST /v1/harness/fixtures/trust-entry`** installs one entry and what A.3 requires with it, through the engine's transitions, labelled (`payload.test_fixture = true` on every event it causes). The body: `backend` (`claude` or `codex`; never `scripted`), `status` (`proposed`, `active` or `revoked`; default `proposed`), `binary` (`{"path", "sha256"}`, the stand-in's), and optionally `mode` (default `one_shot_headless`), `version`, `model`, `template_version`, `capabilities` (`{tools[], denied[], features_disabled[], delegation_verified}`), `profile_fingerprint`, `egress_hosts`, `usage_granularity` (default `model_call`), `usage_semantics`, `cost_reporting` (default `reported`), `enforceable_boundaries` (default one entry, the invocation boundary enforced by `dispatch_check` under the deadline), `isolation` and `boundary` (D2's identifiers), `evidence` (`[{"kind": "qualification_evidence", "content": <text>}]`, default one record of fixture text). What the body does not give is the fixture's default, and the engine's where the engine owns it: the `template` is the adapter's fixed text for the backend (D2 §4.5, §4.6), `help_sha256` a SHA-256 the fixture computes over the stand-in's "help" (its own file), `host_id` the running host's, `evidence_fingerprint` the engine's fingerprint over template, capabilities, auth mode, egress hosts and profile (D2 §4.1: never record identifiers alone), `auth_mode` `api_key`, `result_channel` `file`, `session_qualified` false, `provider_files` an empty inventory. The fixture writes: the evidence records (`qualification_evidence`, published, engine-scoped: `records.project` is null for them); one `qualification_attempts` row, `succeeded`, bound to the same binary, template and host, labelled, named by the entry's `qualification_attempt`; the entry. A `proposed` entry **raises `trust_activation`** through the transition a succeeded attempt uses (section 117); an `active` one was activated by a `trust_activation` decision the fixture raised and answered as the human would, labelled, which its `activated_by` names; a `revoked` one has `revoked_at` and a fixture reason. The response is **201** `{"trust_entry": {"id": "trust_<ULID>"}, "qualification_attempt": {"id": "qa_<ULID>"}, "evidence": ["rec_<ULID>", ...], "decision": "dec_<ULID>" | null}`, `decision` the open `trust_activation` raised for a proposed entry, null otherwise. The route creates and never updates: an `id` in the body is **400** `unknown_field` (`subject.field` `id`), like any key it does not know. Refused at write, **400** `invalid_value` with `subject.field`: an `isolation` or `boundary` that is not D2's (`isolation`, `boundary`); `status` `active` with `mode` `session_headless` (`mode`); a boundary `model_turn` whose `mechanism` is not `admission_control` or whose `evidence` is null (`enforceable_boundaries`). A boundary given without `evidence` names the fixture's own evidence record; the store keeps each boundary's `evidence` as a record id.

**`POST /v1/harness/fixtures/qualification-attempt`** installs one `qualification_attempts` row for a backend bound to the stand-in, in the status given (`proposed`, `authorized`, `running`, `succeeded`, `failed`, `invalidated`; default `authorized`), with `fixture_project` the project given (one the harness installed), the attempt's binding filled as the entry fixture fills an entry's, labelled; **201** `{"qualification_attempt": {"id": "qa_<ULID>"}}`. An `authorized` fixture attempt dispatches nothing in slice 10 (no canary exists to dispatch): it is the authority M101 (e) shows to be no bypass. What it dispatches in the sandbox lane is row M135's.

**`host_qualification` on entries and attempts is nullable.** A.3 marks it required; in the kernel lane no `host_qualifications` row exists (section 114), and a fixture entry records null there: no host qualification was in force when it was written. An attempt that ran records the row in force (the sandbox lane).

**Store constraints the tests pin** (as section 8's; each a constraint error, never a silently ignored write; the tests write with the engine stopped): `trust_entries.status = 'active'` requires `activated_by` not null; an entry with `mode = 'session_headless'` is never `active`, whatever `activated_by` says; `isolation` and `boundary` cannot be updated. The transitions of A.4 are the engine's; the tests attempt only the direct writes above.

**Which entry a dispatch uses.** A run whose role's backend key names a real backend is dispatched to the one `active` entry for that backend name and `backend_mode` on this host; with none, the dispatch is refused (below); with more than one active entry for the same name and mode, which is used is not pinned (the tests install one). The receipt's `trust_entry` names it and `qualification_attempt` is null (A.3). **The launch:** the engine spawns the entry's `binary_path` (after the hash check of D2 §1.2, which no slice-10 case fails) with the adapter's template arguments and a constructed environment holding the variables the template names (`ANTHROPIC_API_KEY` for `claude`, with the resolved value of `backend/claude/api_key`), the markers `SURETY_DOMAIN` and `SURETY_INVOCATION` (section 13; the scripted boundary's `auto` finds the process by them), and never `SURETY_HOME` or the API token; its working directory and standard input are not pinned in this lane (there is no sandbox and no `/surety/workspace`). The stand-in exits 0 with no output, so the run ends as the adapter's stream parsing makes it end: not `refused`, and not pinned further (the exit classes are the sandbox lane's).

**Refusals before launch.** `backend_refused` (D2 A.7) is the run's `code` when the role's backend has no active entry on this host (no entry, a `proposed` or a `revoked` one), when `backend_mode` is `session_headless` whatever entries exist (D2 §1.8: no fallback to one-shot), and when `scripted` is named outside harness mode (section 118); an authorized attempt for the backend changes none of it (K10). The run ends `refused` / `preflight_refused` as section 16 says: its one receipt has the observation `refused` and nothing else, no ledger row, no `domain.placed` or any `domain.*` event, no process of the backend (the stand-in's log is empty and no process on the host runs its path), the work's `preflight_refusals` counted. The refusal rows' projects set `preflight_refusals_max` to 1 (`PARK_ON_REFUSAL`; objection 002), so a refused item parks at once with the blocker reason `preflight_refusals_max` (section 15) instead of returning to `eligible`, where it would be offered again before the project's next item (one run per project, oldest first) and could be refused twice by a tick the engine requests itself; the cases read the parked item. `budget_boundary_unenforceable` and `mount_plan_refused` are section 120's.

**The run read's `refusal`** (section 17 gains it). When a run's `code` is not null the read also carries `refusal`, the refusal in its form (`code`, `reason`, `what_to_do`, `subject`): for `budget_boundary_unenforceable`, `subject` holds `required` (the policy's boundary), `trust_entry`, `enforceable_boundaries` (the entry's, each `{boundary, mechanism, evidence, overshoot}`) and `overshoot` `{"bounded_by": "deadline", "deadline_at": <runs.deadline_at>}`; for `mount_plan_refused`, `path` and `reason` (section 120). For `backend_refused` the subject is not pinned.

## 117. Engine-scoped decisions: `trust_activation` and `qualification_approval`

(D2 §4.1, §7.2, A.7; D1 §10; `../contract/decisions.json`; rows M102, M103 (d); M135 and the real lane will answer the same way.)

**Two kinds, engine-scoped.** `trust_activation` (subject a `trust_entry`) and `qualification_approval` (subject a `qualification_attempt`) are decisions about no project: their rows have `project` null (the column becomes nullable; every other kind keeps a project), and they are read and answered through two routes of their own, with sections 76 and 91's rules otherwise unchanged:

| Route | Behaviour |
|---|---|
| `GET /v1/decisions` | **200** `{"served_at", "snapshot_seq", "decisions": [...]}`: the open engine-scoped decisions, each with the keys of section 91's list item (`id`, `kind`, `subject_type`, `subject_id`, `question`, `options`, `preview_hash`). A consumed one is not listed. |
| `POST /v1/decisions/:d/answer` | The body and the answers of section 76: **200** consumed; **409** `decision_stale`, `decision_consumed` (with `subject.decision`), `decision_invalidated`; **409** `illegal_transition` for an option with a blocker; **500** `store_error`. A project decision through this route, and a project route for an engine-scoped one, are **404** `not_found` (not exercised). |

Both offer `approve` and `reject`. `reject` leaves the entry `proposed` (or the attempt `proposed`) and closes the question as section 102 says: no open decision of the kind about the subject within three ticks, the rejected one consumed with its answer and no approval (E59 item 8; the re-ask after a rejection is Sean's open E50 question). Answering a consumed one is `decision_consumed`. A stale dependency refuses the answer and, the question still standing, the next generation is raised with the changed value and no approval (section 76; a proposed entry still awaits activation whatever the host's eligibility, so the question stands).

**`trust_activation`'s manifest, the fewest fields** (D2 A.7: "binary and help hashes, template, capabilities, profile fingerprint, host identity and current host eligibility, entry status"): `entry_status` (`proposed`), `binary_sha256`, `help_sha256`, `template` (the fixed text), `template_version`, `capabilities` (the entry's object), `profile_fingerprint`, `host_id`, `host_eligibility` (section 114's object), `evidence` (`[{"record", "quarantined", "missing"}]`, one per evidence record, as section 77 gives it for a rationale) and `evidence_fingerprint`. The preview hash covers them all. The cases change two: the host's eligibility, by a restart with `--harness-host-check H6=failed` (the manifest's `host_eligibility.eligible` false and `failed_checks` `["H6"]`), and an evidence record's bytes, replaced on disk with the engine stopped, which the audit of the next start marks missing (section 58) and the manifest shows as `missing` true. **Approval** makes the entry `active` with `activated_by` the decision, one `approvals` row, one `trust.activated` (`subject.trust_entry`); it creates no run and spawns nothing (CH incident 10). An entry whose `usage_granularity` is `none` cannot be activated (D2 §4.2, A.3): either no `trust_activation` is raised for it (the fixture then answers `decision: null`) or its `approve` option carries a blocker and the answer is `illegal_transition`; the case accepts either.

**`qualification_approval`'s manifest, the fewest fields** (D2 A.7): `attempt_status`, `binary_sha256`, `help_sha256`, `template`, `template_version`, `model`, `auth_mode`, `host_qualification` (the row id, null in the kernel lane) with `host_eligibility`, `fixture_project`, `candidate_egress`, `canary_deadlines`, `spend` (`{cap?, estimate, label, overshoot}`). The contract lists them so that M73 holds; no slice-10 case raises or answers one (M135, the sandbox lane).

## 118. `GET /v1/engine` in M2

(D2 A.7 "Routes, added"; section 4's table gains these fields.)

| Field | Value |
|---|---|
| `backends` | The backend names a dispatch may use now: in harness mode with `--harness-scripted`, `scripted`, and every backend with an `active` entry on this host while the host is eligible (section 114); outside harness mode never `scripted`, and only backends with active entries. On the slice-10 engine outside harness mode the host checks are not built, so the list may be empty beside an active entry; what it holds once a host is qualified is the sandbox lane's. |
| `trust_entries` | Every entry, each with `id`, `backend`, `version`, `mode`, `status`, `binary_path`, `binary_sha256`, `usage_granularity`, `cost_reporting`, `enforceable_boundaries` (`[{boundary, mechanism, evidence, overshoot}]`), `isolation`, `boundary`, `host_id`, `activated_by`, `revoked_at`. Outside harness mode too. No field says whether an entry is a fixture: that label is on its events (section 7 forbids the word in production source). |
| `qualification_attempts` | Every attempt, each with `id`, `backend`, `status`, `fixture_project`, `trust_entry`. |
| `host_qualification` | `{"mode": "unrun" \| "run", "eligible", "source", "host_qualification", "mechanism_fingerprint", "failed_checks", "checks": [{"id", "result", "observed"}]}`: section 114's eligibility object with the mode and the thirteen checks, each `passed`, `failed` or `not_exercised` with an observed value (null where nothing was observed; the text for a forced result is the engine's). The kernel lane pins `eligible`, `source`, `host_qualification` (null) and a forced check's `result`. |
| `bootstrap_exception` | `true` exactly when `ui_bootstrap` is true (section 115). |

## 119. The Alpha exception (C1)

(D2 §5 C1, A.3 "Result schema"; E36 item 5; D1 §§3.4, 9.3, 10.5; spec R14; row M105; sections 68, 74, 76, 77.)

**The result field.** A Reviewer's valid result may carry `alpha_exception_proposals`: `[{"finding": <id>, "containment_text": <string>, "references": [{"path": <workspace path>} | {"record": <record id>}, ...], "testing_purpose": <string>}]`. The field from a Builder or a Verifier makes the result invalid (`failed` / `invalid_result`), as section 68 treats a field a role may not send. A proposal is **refused before anything is raised** when the finding's `effective_severity` is not `high`, when it has a `sensitive_area`, when it is not open against the candidate the Reviewer's work names (a finding raised on another candidate that is not that candidate's ancestor; a finding that is not `open` or `dispositioned`), or, since the slice-10 review's S1, when **the candidate's acceptance content is no longer what the Reviewer reviewed** (below); a refused proposal publishes nothing and raises nothing, the run completes, and the run read lists it. **The run read** (section 17) gains `alpha_exception_proposals`: `[{"finding", "outcome": "proposed" | "refused", "reason": null | "not_high" | "sensitive_area" | "not_open_against_candidate" | "content_changed", "decision": <id> | null}]`, one per proposal in the result's order.

**What the Reviewer reviewed** (the slice-10 review's S1; D2 C1 "open against the candidate the Reviewer reviewed"; E41 item 4 and section 70 for a sign-off). The content a proposal is about is the candidate's acceptance content as it was when the Reviewer's run was started, no later than its role's launch, exactly as a sign-off's hash is fixed (section 70): the engine records it on the run, and a Reviewer's result is judged against it. When the result arrives, a proposal whose reviewed hash is not the candidate's current acceptance content hash is refused with the reason `content_changed`: no record, no decision, the run completes, the finding blocks as before. So the manifest's `acceptance_content_hash` is the reviewed hash and the hash in force at once, and the preview hash covers it. While the decision is open, a change of the acceptance content stales an answer on the earlier preview (section 76) and the question is **withdrawn**, not asked again: the decision is `invalidated` within the ticks and no `finding_disposition` about the finding is raised in its place, since nobody has reviewed the new content; the Reviewer reviews it and proposes again, which is a new decision bound to it. Between the answer and the effect the same change invalidates the intent (`EFFECT_PRECONDITION_CHANGED`) and nothing is written. **A granted exception lifts the block only on the content it was granted on:** the Alpha gate treats the finding as excepted (section 74) only while `findings.alpha_exception.acceptance_content_hash` equals the scope's hash; under any other content the finding blocks again, and the written exception stays as it was, bound to its content. The S1 case pins the refusal, the withdrawal and the gate; case (e)'s first step pins the staleness and the withdrawal. **Not taken:** raising the decision anyway, bound to the reviewed hash, and leaving the gate to ignore the exception under other content. It would ask the human to approve an exception the engine already knows cannot apply, and would leave a question open about content that is gone; the refusal says so at once, on the run read, and the Reviewer's next review is the honest path.

**The containment evidence.** For a proposal that is not refused the engine resolves every reference and publishes one `containment_evidence` record, whose bytes are a JSON document `{"finding", "candidate", "revision": <the candidate's revision>, "containment_text", "testing_purpose", "references": [...]}`: a path reference becomes `{"path", "content"}` with the file's content at the reviewed revision, read from the repository (never from a workspace); a record reference becomes `{"record", "sha256", "content"}` with the record's bytes and their hash. A reference that cannot be resolved (a path not in the revision, a record that is not the project's or is unpublished) refuses the proposal with the reason `reference_unresolved`, not pinned by a case. The decision's `evidence` (D1 A.3) is `[{"record": <that record>, "provenance": "claimed"}]`.

**The decision** is `finding_disposition` about the finding, raised in the transaction that records the result, with the options `alpha_exception` and `reject` (`../contract/decisions.json` lists the option). Its manifest is the kind's (section 77) with `proposed_disposition` `"alpha_exception"`, `candidate` (the reviewed candidate's id), `evidence` (`{"record", "quarantined", "missing"}` of the containment record), and `acceptance_content_hash` the candidate's as the gates compute it (section 70). The option is **effect-bearing** although the kind is not (`effect_options` in the contract): consuming it records one `effect_intents` row whose preconditions are the manifest's values, and the effect, made by the engine within the request or at a tick and revalidated as section 76 says (the `intent.recorded` barrier applies), writes `findings.alpha_exception` as JSON: `{"candidate", "acceptance_content_hash", "evidence": <the record>, "decision", "at"}`. A change to the finding's status, severity, sensitive area or candidate before the answer stales it (the next generation shows the value), and between the answer and the effect invalidates the intent (`EFFECT_PRECONDITION_CHANGED`) with nothing written; a change to the candidate's acceptance content does the same and withdraws the question ("What the Reviewer reviewed", above). Only the human consumes it; `reject` writes nothing and the finding blocks as before. With the exception written, the Alpha gate treats the finding as section 74 says for a High under its exception (`FINDING_UNSATISFIED`, not `FINDING_BLOCKING`) while the exception's hash is the scope's, and as blocking under any other content (pinned by the S1 case); the exception changes no check state. The fixture route of section 67, `POST /v1/harness/fixtures/alpha-exception`, stays for the cases that need the recorded exception without a proposal (row M43).

## 120. Budgets under D2, and the mount plan's refusal in the kernel lane

(D2 §1.5, §4.2, §5 C4, K6, A.3 `ledger_rows.unknown_allowance_tokens`, A.7; AR B06, B07; E58 items 6 and 9; rows M103, M104, M108; sections 53 to 55.)

**The boundary refusal** (D2 §4.2; K6). An entry's `enforceable_boundaries` lists what the engine can stop at, each `{boundary, mechanism, evidence, overshoot}`: `invocation` by `dispatch_check` with the overshoot `deadline` is what any entry whose usage is reported at all gets; `model_turn` is recorded only with the mechanism `admission_control` and an evidence record (section 116: a claim without them is not written). A dispatch whose policy `budget_run_boundary` is finer than any boundary the entry enforces (`model_turn` or `user_turn` against an entry with `invocation` only) is refused before launch: the run ends `refused` / `preflight_refused` with `code` `budget_boundary_unenforceable`, the receipt `refused` only, no `domain.*` event, no launch, no charge, and the run read's `refusal` names what was required, the entry, its boundaries and the deadline as the only bound on overshoot (section 116). With `invocation` the dispatch proceeds. `GET /v1/engine` shows the entry's boundaries beside its `usage_granularity`, which says only how often usage is reported.

**The hard maximum** (D2 §4.2, Q2). `budget_hard_maximum: true` is refused at the policy (section 115). A provider-side cap on the dedicated key is recorded where the key is: `POST /v1/harness/secrets` takes `provider_cap_usd` beside `ref` and `value`, and the grant of a dispatch whose backend's key carries one records `capability_grants.provider_cap` as JSON `{"status": "configured", "usd": <number>, "reference": <the secret reference>}`; null when the key has none. It appears nowhere as engine enforcement: no entry boundary and no run read names a provider mechanism.

**Estimates count toward the verified day** (C4; section 55's "Whether an estimated cost counts against `budget_day_verified_usd` is not pinned" is superseded). The day's verified cost, for `budget_day_verified_usd`, is the reported cost plus the estimated cost of the day's invocations, each folded as section 54 says; the ledger read shows `reported_usd` and `estimated_usd` apart as before, each estimated row keeps its price table's version, and nothing estimated is ever under `reported_usd`. A correction that carries `cost_usd` for an estimated invocation is a reported delta (section 54) and the fold's status is then `reported`: both rows stand with their provenance, and the invocation's cost moves from `estimated_usd` to `reported_usd` in the totals.

**The unknown allowance** (C4; A.3; amended after objection 003 and E61 item 8, and after the slice-10 review's S2). An invocation whose usage is incomplete (`usage_complete` 0: the engine ended it, it was recovered, or it ended on its own without its terminal usage, a real backend's failure with no usage event among them) is charged, once, an allowance for its unobserved remainder: `ledger_rows.unknown_allowance_tokens` on its original row is `budget_run_billable_tokens` (the project's limit when the run was dispatched) less the billable tokens observed (`billable_in` plus `out`), not below zero; a run stopped at its token limit has 0; a run stopped at a day limit has the run limit less what it observed. **Which incomplete invocations are charged** (E61 item 8; the review's S2): every incomplete invocation of a real backend (one dispatched under a trust entry), whether or not it observed any usage and however it ended, a failure on its own as much as a cancellation or a recovery, since a real request in flight may have spent tokens the stream never reported (the S2 case: the stand-in exits with no output, the run ends `failed` on its own, and its original row carries the whole run limit, counted in the totals and at the next dispatch until a correction completes it); and a scripted invocation that observed at least one usage observation before it was ended. A scripted invocation ended before any observation carries none: the scripted provider's observations are the test's instrument, with none it reported nothing to bound, and charging the whole run limit for each such run would hold M1's projects at their default day limits. An original row of a completed invocation, of one that was never launched, or of a scripted one with no observation has null there. It is charged once whatever retries and restarts the run's end took (the `ledger.row` fault of section 24 and a restart leave the one row with the one allowance). **The allowance in force** for an invocation is its original row's value until a correction with `usage_complete` true is appended, and 0 from then on: the correction's tokens join the known usage and the allowance is released; the original row is never changed. The ledger read (section 54) gains, on each row, `unknown_allowance_tokens` as stored, and in `totals` (and `by_role`) `unknown_allowance_tokens`: null when no invocation in scope has an allowance on its original row, otherwise the sum of the allowances in force (0 once every allowance in scope has been released). The accepted ledger cases M59, M60 and M62 compare the totals whole and now carry the key (null, null and 1,499,430 and 0, 1,497,500 respectively; `../COVERAGE.md`, "M2 slice 10": a §120 change, not a weakening); `spend_today` (section 91) lists its keys by name and is not changed by this. **At dispatch** the day's count against `budget_day_unknown_tokens` is the known billable tokens of the day's unknown-cost invocations (`unknown_cost_tokens`) plus their allowances in force, so a project whose known usage is within the limit is held when the allowances take it over, `budget.exhausted` naming `budget_day_unknown_tokens`, and dispatches again once a correction releases enough. The concurrent clause of C05 (two running invocations of one project) is class A while `max_concurrent_runs` is 1 (E18, E59 item 7) and has no case.

**The mount plan's refusal in the kernel lane** (D2 §2.3, A.7; row M108 (c)). The plan is resolved and validated before every launch, the scripted backend's in harness mode included: the validation is a pure function of the policy's `sandbox_read_paths`, the host's files and the forbidden set, and needs no sandbox. A path that is, contains or aliases the engine home (symbolic links resolved), a registered repository, a workspace, an operator credential location (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.claude`, `~/.codex`, `~/.docker`, `~/.kube`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, under the engine process's `HOME`), a forbidden root (`/run`, `/var/run`, `/proc`, `/sys`, `/dev`, `/mnt`, the host `/tmp`), a WSL path, or a directory that holds a socket, a device or a FIFO, refuses the launch: the run ends `refused` / `preflight_refused` with `code` `mount_plan_refused`, no launcher and no role started, no `domain.*` event, and the run read's `refusal.subject` holds `path` (as the policy gave it) and `reason`, one of `engine_home`, `repository`, `workspace`, `credential_location`, `forbidden_root`, `wsl_path`, `special_file`. An alias is refused with the reason of what it resolves to; a workspace under the engine home may be refused as either; a path under `/mnt` may be `forbidden_root` or `wsl_path`. A harmless directory the test seeds is accepted by the plan; what the sandbox then mounts is row M119's.

## 121. The Reviewer's powers (C2) and the spawn lint

(D2 §5 C2, K7, K8; E41, E44 item 2, E48 item 3, E56 item 3; rows M106, M109 (c); sections 69, 74, 95.)

**K7: any lowering from Critical needs the human.** A Reviewer's `severity_changes` entry that lowers a Critical finding, to High as to anything lower, is not applied: the engine raises `severity_lower` for the human (section 77) and the finding stays Critical and blocking. The Reviewer proposing the same lowering again in a later result changes nothing and raises nothing new: the open decision is the one already asked (D1 §10.2, one identity). High to Medium is as M51 pins. Section 74's "a lowering out of the blocking range … is not applied" now reads "any lowering from Critical, and any lowering out of the blocking range".

**K8: a Reviewer's approval of a tightening is a recommendation.** Until D3's classifier is qualified, a Reviewer's result carrying `proposal_approval` for a tightening approves nothing: the proposal stays `classified` with `resulting_version` null, nothing is applied, the effective version is unchanged, and the human's `check_correction_tightening` decision stays open with the preview it had; the human's approval then applies it with `approver_authority` `human`. Where the recommendation is recorded is not pinned (it is not `approver` with status `approved`). Section 69's "Tightening: the human … or a Reviewer's run" is superseded, and with it the three accepted cases that had a Reviewer's approval apply a tightening: M37's first case, M53's second and the candidate-read case of `M74-fixture-semantics.test.mjs` now have the human approve after the Reviewer recommended, with the application's mechanics unchanged (the K8 change; `../COVERAGE.md`). Loosening and unclassifiable were the human's already.

**Classification as an effect precondition** (K8). The five classifier dependencies the manifest binds (`tree`, `base_revision`, `spec_revision`, `classification`, `effective_protected_version`), changed between the human's approval and the effect, each invalidate the intent with `EFFECT_PRECONDITION_CHANGED`, no git write and no check state changed. The accepted engine already does this (the case passes on it). Four are changed as the earlier rows change dependencies (the tree, the base and the classification in the store with the engine killed at `intent.recorded`, then restarted; the specification by the plan fixture while the effect is held); the effective version cannot be changed by an engine path while an effect is paused (the effects step is the tick's, and one tick runs at a time), so it is changed in the store with the engine stopped: the effective version is superseded by a copy of itself, a version with the same set, which is the one fixture row this slice writes to a table the engine owns.

**The spawn lint** (D1 §15.4; section 95). `ALLOWED` in `harness/launch-lint.mjs` gains `D2_HELPERS`: the boundary's helper modules outside `invoke/` that start a host tool the engine checks for (D2 §6: `systemd-run`), one file each with the tool named; `boundary/scope.ts` for the incarnation scope is the starting entry (BS §7). The launcher's `unshare`, `setpriv` and `ip` are under `invoke/` and need no entry. A Builder who arranges the modules otherwise names the file in an objection and the Verifier changes the list; a spawn anywhere else fails M74 and M109 (c). The lint stays lexical: it does not see what a helper spawns, which is why a helper is one named file and why the sandbox lane observes the launches themselves.

## What this pass changes in earlier sections

- Section 2 and `../contract/config.json`: the closed engine and project sets gain D2's keys (section 115); M07's project-defaults case compares with `deepEqual`.
- Section 4's `GET /v1/engine` table: `backends` is no longer "`[]` outside harness mode in M1"; the read gains `trust_entries`, `qualification_attempts`, `host_qualification`, `bootstrap_exception` (section 118).
- Section 1's flags: `--harness-host-checks`, `--harness-host-check` (section 114).
- Section 7's fault table: `token_read` (section 115).
- Section 8's "every table has `project`" and section 19's list: `decisions.project` is nullable for the two engine-scoped kinds (section 117), `records.project` for engine-scoped evidence (section 116); `trust_entries.host_qualification` and `qualification_attempts.host_qualification` are nullable (section 116).
- Section 12's "In every other start `backends` is `[]`" and section 16's "Preflight refusal … which in M1 is every start without `--harness --harness-scripted`": a real backend with an active entry on an eligible host is dispatched (section 116); the refusal's causes are section 116's.
- Section 17's run read gains `refusal` (section 116) and `alpha_exception_proposals` (section 119).
- Section 54's ledger read gains `unknown_allowance_tokens` on rows and in totals, and the three accepted cases that compare the totals whole (M59, M60, M62) carry the key (section 120; objection 003); section 55's "Whether an estimated cost counts … is not pinned": it counts (section 120).
- Section 57's `POST /v1/harness/secrets` takes `provider_cap_usd` (section 120).
- Section 68's result fields: `alpha_exception_proposals` for a Reviewer (section 119); section 77's `finding_disposition` row: the option `alpha_exception`, raised by a Reviewer's proposal, effect-bearing (section 119). *After the slice-10 review:* section 70's rule for what a Reviewer's run reviewed (the content at its launch) governs the proposal too (section 119, "What the Reviewer reviewed"); section 120's allowance covers a real backend's invocation that fails on its own.
- Section 69, "Who may approve": a Reviewer's approval of a tightening applies nothing before D3 (section 121); section 74, "Severity": any lowering from Critical raises `severity_lower` (section 121).
- Section 78: `egress_allow_extra` and `sandbox_read_paths` widen; section 27's "which changes widen authority is row M49's" gains them (section 115).
- Section 90: the bootstrap route answers only with `ui_bootstrap` true; M68 opts in (section 115; the K3 change).
- Section 95's allowed places: `D2_HELPERS` (section 121).
- `../contract/decisions.json`: thirteen kinds; M73's "no other kind is enabled" reads the file.

## Names the Verifier fixed in this pass

Each was open in the sources (M2 plan §2.6, or a name D2 gives in words). The Builder may object. Those marked † carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| The host-checks switch and the overrides | `--harness-host-checks <unrun\|run>`, default `unrun` in harness mode; `--harness-host-check <Hn>=<failed\|not_exercised>` (section 114) | BS §9: the kernel lane's starts must not run the probe suite; the plan asks for a named check to be failed or unexercised. Two flags, in the form of `--harness-probe`. |
| Eligibility in the kernel lane † | The harness's say-so, labelled `source: "harness"`, with no row (section 114) | M103 (e) dispatches to the stand-in in the kernel lane; nothing else can make the host eligible there. The label keeps the claim out of the report. |
| `host_eligibility`'s form | `{eligible, source, host_qualification, mechanism_fingerprint, failed_checks}` (section 114) | The plan: "the active `host_qualifications` row and its mechanism fingerprint"; the kernel lane needs the two null and a reason for ineligibility. |
| D2's configuration keys, all at once † | Every A.7 key in the contract now, with D2's defaults and ranges, bytes in bytes (section 115) | M07 and M73 pin the closed set exactly, so each later addition would be a contract change and a Builder change in step; D2 A.7 is approved and names them all. |
| `ui_bootstrap`'s refusal | 403 `bootstrap_disabled`, refusal form, before the token is read; the fault `token_read` → 500 `token_read_failed` (section 115) | D2 A.7 names the code; 403 is the route's refusal status (section 90). The fault is the only way to show "before the token is read" from outside. |
| `budget_hard_maximum: true` | 400 `hard_cap_unenforceable`, `subject.field`, no effect (section 115) | D2 A.7 names the code; a refused policy value is answered where the schema's are. |
| The widenings | `egress_allow_extra`, `sandbox_read_paths`: adding widens, removing does not (section 115) | D2 A.7 marks both "widening"; section 78's rule for a budget is the same. |
| The backend keys † | `backend_<role>` (four), `backend_mode`; strings; default `scripted` (section 115) | D2 §4.1: policy chooses among active entries per role; A.7 names no key. Scalars validate like every other key; `scripted` by default keeps every M1 project dispatching as before. |
| D2's mechanism identifiers | `linux-namespaces-1`, `cgroup2-delegated-scope-1` (section 116) | D2 §2.2 and §3.1 name the mechanisms and not their identifiers. |
| `host_id` | `/etc/machine-id` (section 116) | The plan: stable, never the boot id. The one identity every systemd host has. |
| The provider key's reference | `backend/<backend>/api_key` (section 116) | D2 §2.5 names the grant's references and not their form. |
| The stand-in binary | `harness/standin/backend.mjs` written with a shebang naming the test's node; records argv, environment keys and value hashes, cwd, markers; exits 0 (section 116) | The plan §2.3. Value hashes let a test see a secret arrive without the log holding it. |
| The fixture routes † | `POST /v1/harness/fixtures/trust-entry`, `…/qualification-attempt`; bodies, defaults, refusals, what they write (section 116) | The plan §2.3; M1's fixture routes (sections 7, 15, 67) are the pattern. |
| A `proposed` fixture entry raises `trust_activation` | Always (section 116) | The plan M102: "raises `trust_activation` through the same transition a succeeded attempt uses". |
| An `active` fixture entry's activator | A fixture `trust_activation` decision the fixture answered, labelled (section 116) | The store's constraint (`active` needs `activated_by`) holds for fixtures too; a fixture that bypassed it would be the bypass M102 (b) refuses. |
| `host_qualification` nullable on entries and attempts † | Null when no qualification was in force (section 116) | A.3 marks it required; the kernel lane has no row, and a fabricated lapsed row would be a record of a qualification that never happened. |
| The store constraints | Section 116's four | M102 (b), M101 (d), M109 (a) ask for them; section 8's rule for a refusal. |
| Which entry a dispatch uses | The one active entry for the name and mode; several not pinned (section 116) | The tests install one; D2 keys entries by version and hash too, and policy names neither. |
| The run read's `refusal` † | The refusal form beside `code`, with the subject per code (section 116) | M103 (a) and M108 (c) ask the run read to name things `code` cannot carry. |
| The engine-scoped decision routes † | `GET /v1/decisions`, `POST /v1/decisions/:d/answer`; `decisions.project` null (section 117) | D1's routes are project-scoped; an entry is nobody's project. The real lane's human answers through them. |
| `trust_activation`'s manifest | The eleven keys of section 117 | D2 A.7's list, named; `evidence` in section 77's form so a record's bytes are a dependency. |
| `qualification_approval`'s manifest | The thirteen keys of section 117 | D2 A.7's list, named now so the contract holds; exercised by M135. |
| The engine read's M2 fields | Section 118 | D2 A.7 "Routes, added" in words. |
| The Alpha exception's result field, record, decision, effect | Section 119 | D2 C1 in words; A.3 gives the field's shape and no record format. The option is on the existing kind, as C1 says. |
| How a refused proposal shows † | `alpha_exception_proposals` on the run read with `outcome` and `reason` (section 119) | The plan M105 (b): "the Verifier fixes how". The run is the subject of the result. |
| Estimates count | Toward `budget_day_verified_usd`, shown apart (section 120) | C4 (decided). |
| The allowance | On the original row; in force until a complete correction; summed in the totals; counted at dispatch (section 120) | C4 (decided) and E58 item 9; A.3 names the column; the ledger read needs the sum to show "the day counts". |
| The provider cap's record † | `provider_cap_usd` with the secret; `capability_grants.provider_cap` (section 120) | D2 §4.2: "recorded on the grant as `configured` evidence". The key is where the cap is. |
| `mount_plan_refused` in the kernel lane; its reasons | The plan validated before every launch; seven reasons (section 120) | M108 (c) is a kernel-lane row; the reasons are D2 §2.3's categories. |
| K7's reading of a repeated proposal | The open decision is the one already asked (section 121) | D1 §10.2; "the Reviewer cannot apply its own proposal". |
| K8's reading, and the K8 change † | A recommendation; three accepted cases changed to the human's approval (section 121) | D2 C2 and Astra's K8 as accepted: "the real Reviewer recommends and the human approves"; E44 item 2: an overturned provisional decision becomes a changed test. |
| The effective version changed in the store † | A copy of the effective version supersedes it, engine stopped at the intent (section 121) | No engine path can apply a second proposal while an effect is paused; the precedent of rows M45, M51, M53 to M55. |
| `D2_HELPERS` | `boundary/scope.ts` for `systemd-run` (section 121) | BS §7's starting layout; the plan M109 (c). |
| *After the slice-10 review (S1):* the content a proposal is about † | The acceptance content at the Reviewer's run's launch; a proposal against changed content is refused `content_changed`; an open question is withdrawn, not asked again, when the content changes; the exception lifts the block only on the content it was granted on (section 119) | D2 C1: "open against the candidate the Reviewer reviewed"; E41 item 4 fixes a sign-off's content the same way. The alternative, binding the reviewed hash and letting the gate ignore the exception, is recorded as not taken. |
| *After the slice-10 review (S2):* a real backend's failure with no usage | Charged the whole run limit as its allowance, like every incomplete invocation of a trust entry's backend (section 120) | D2 C4 charges every incomplete invocation; §120's E61 item 8 rule already said "whether or not it observed usage"; only its parenthetical read as if the engine had to be the one that ended it. |

## What was run

Each touched file alone, with `node --test` after `npm run build`, on `main` at `412bde4` (the accepted M1 engine with M2 slices 1 and 2), never two at once. The results, with the failing assertion and what the engine did for each case, are in `../COVERAGE.md`, "M2 slice 10". In short: every case of M101, M102, M103, M107 and M108, and two of M109, fail at their first M2 step (an unknown policy key, an unknown configuration key, an unknown fault, a refusal of the fixture route's path); M104's three cases fail at the estimate not counting and the allowance column not existing, their fixtures live through the runs and the Stop; M105's six at the first assertion about the record, the run read's field, the invalid result or the decision, their fixture live through the Reviewer's run; M106 (a), (b) and (d) at the lowering applied and the tightening applied by the Reviewer, which are the E41 observations D2 overturned, and M106 (c) passes; M109 (c) passes. Of the accepted tests changed: M07 and M73 fail on the new keys and kinds; M37, M53 and M74-fixture-semantics fail where the Reviewer's approval applies; M68's bootstrap cases fail because the accepted engine refuses the `ui_bootstrap` key at start (exit 4), its two lane cases pass.

**After the slice-10 review** (S1, S2; 2026-10-03, on `verify/m2-s10-review` from `main` at `7d95518`, whose engine is still the slice-9 one). Two cases, one per confirmed defect (E31), and case (e) of M105 changed with S1: `M105-alpha-exception-proposal.test.mjs` alone, 0 of 7 on that engine (S1 fails at the run read, which lists no proposals, after the held Reviewer's run, the content change, the release and the run's completion were live; (e) at `openDecision`, like the rest of the file); `M104-estimated-cost-and-unknown-allowance.test.mjs` alone, 0 of 4 (S2 at the fixture's first M2 step, the policy key). As a scratch check, not an acceptance run, both files were run once against the Builder's built engine (`build/m2-s10` at `f2dd6c2`, its `dist/` built after that commit; `SURETY_WITNESS_ENGINE`, which marks the run and adds one failing test per file; nothing written there): S1 fails at "no finding_disposition was raised" (the engine raised it, bound to the current content `1112…` beside a `reviewed_content_hash` `a8eb…`: the defect the review found), (e) at the withdrawal (the engine raised the next generation after the content change), S2 at `unknown_allowance_tokens` (null where the run limit is expected); every other case of both files passes there. `../COVERAGE.md`, "M2 slice 10", "The review's cases".

---

# M2 slice 11: the sandbox lane's boundary rows

Sections 122 to 131 were written with the slice-11 acceptance tests (2026-10-03; `verify/m2-s11` from `main` at `47b2ef7`): rows M110 to M118 of `docs/acceptance/sdlc-M2-acceptance-plan.md` §§3.2, 3.3, the first sandbox-lane slice (M2 build spec §9). They follow D2 §§2.2, 3.1 to 3.5, 6, 7.1, A.3 to A.6, Appendix B (B1, B2, B3, B01, B09, N01, N02, N05, K1, K2, K5) and the errata E56 to E63, and fix what the plan's §2.6 leaves to the tests for these rows. The host these were written on is the one of E48 and D2's preamble (WSL2 kernel 6.6.87.2, cgroup v2 `nsdelegate`, the user manager delegating `cpu memory pids`, util-linux 2.39.3, no sudo, unprivileged BPF disabled): the lane proves the mechanisms on this host and kernel, not on another (BS §8).

## 122. What the slice-11 tests assume throughout

- **The sandbox lane** (M2 plan §2.1; BS §8). A sandbox-lane engine is the scripted engine of M1 started with **`--harness-host-checks run`** (section 114) from an environment that carries **`XDG_RUNTIME_DIR`** and **`DBUS_SESSION_BUS_ADDRESS`** of a login session of uid 1000 (section 1's constructed environment gains the two, for this lane only; `harness/sandbox/lane.mjs`). In this lane the scripted backend's child runs **inside the real sandbox under the real cgroup boundary**, and the scripted execution boundary of section 14 is not used: `boundary.json` is not read, and termination is the cgroup's (section 126). Everything else of sections 13 to 18 holds: the protocol lines, the holds and releases, the barriers, the controlled clock, the faults. The kernel lane (`unrun`, the default) is unchanged by this slice: it creates no scope, runs no check, and every M1 file passes as before.
- **The scripted directory is bound read-write at its host path** inside the sandbox (section 127): the role program is the backend's "installation", and its log, its scripts and its release files are the tests' instruments. A sandbox-lane test reads the role's own observations from that log, never from the domain's volatile filesystem, and corroborates every claim from the host side (M2 plan §2.4): the cgroup files at the path the store records, `/proc/<host pid>/…`, `systemctl --user`, the API.
- **The scripted adapter's protocol is unchanged**: the role's `heartbeat`, `usage` and `result` lines on its standard output reach the engine through the domain init, and a valid `result` line with exit status 0 is the exit class `clean` (section 126). The result file of D2 §1.4 (`/surety/out/result.json`, read only after termination) is slice 13's (rows M129, M130); when that slice moves the scripted role's result to the file, `step.result()` is what the role does to deliver it, and these cases hold as written.
- **Not pinned here**, because another slice's rows pin it: what the role sees and where (its mount table, `/surety/workspace`, the context package, the request's `workspace` and the role's `cwd`: rows M119 to M125); the egress proxy and its echo endpoint (M126 to M128); the result discipline, exit precedence beyond the classes section 126 names, the volatile filesystem's bounds and the envelope (M129 to M133); the probe suite P1 to P20 and H9, H10 (M119 to M124); the materialization of a role's workspace writes (M132). A slice-11 role writes files it reads back itself; nothing here claims a role's write reached the checkout.
- **Grace periods** are real time (section 18), set per case: `terminate_grace` 3 s and `kill_grace` 2 s by default (`SANDBOX_CONFIG`), longer where a case measures them or needs a launcher alive during the grace.
- **Pids.** The role runs in its own pid namespace: the pids its log records are the sandbox's (section 125); the host sees it under another pid, and `NSpid` in `/proc/<host pid>/status` joins the two (`harness/sandbox/procs.mjs`).

## 123. The host checks under `run`: the startup step, the engine read, what slice 11 passes

(D2 §6, §7.1, K2, A.3, Appendix B H01 to H03; M2 plan §2.6 "the name of the startup step that runs the host checks and where `GET /v1/engine` shows them"; row M110; `harness/sandbox/lane.mjs`.)

**The steps.** Section 4's sequence gains two steps in `run` mode and outside harness mode: **`scope`** (K2's step 0, before `lock`: the engine enters its incarnation scope, section 124) and **`host_qualification`** (the checks and the probe suite, between `integrity` and `full`). `startup.completed` lists them in their place: `scope, lock, listen, store, recovery, integrity, host_qualification, full, scheduler`. Neither failing is a startup failure: a scope that cannot be created or a check that fails leaves `startup.failed` null and the engine in full mode, with the outcome in the host section below (D2 K2: "never a startup refusal"). Under `unrun` neither step runs and neither is listed, so M06's six M1 steps stand. The `host_qualification` step is bounded by `tick_step_budget` (D2 §7.1); `GET /v1/health` answers throughout (restricted mode).

**The host section of `GET /v1/engine`** (section 118's `host_qualification`, extended):

| Key | Value |
|---|---|
| `mode` | `unrun` or `run` (section 114) |
| `eligible`, `source`, `host_qualification`, `mechanism_fingerprint`, `failed_checks` | section 114's eligibility object, unchanged in meaning: `eligible` is true only when every check of H1 to H12 (H10 only on a WSL2 host) is `passed` and an active `host_qualifications` row exists (or, under `unrun`, the harness vouches) |
| `not_exercised_checks` | the ids of the checks among H1 to H12 (H10 only on WSL2) whose result is `not_exercised`; each blocks eligibility like a failure (D2 §6). `host_eligibility` (section 114) gains the same key. |
| `wsl2` | `true` when the engine judges the host a WSL2 host (`/proc/version` names Microsoft or WSL), which makes H10 required |
| `checks` | `[{id, result, observed, remedy}]` for H1 to H13 in order: `observed` a string, the value the check observed, null when nothing was observed (a check never run); `remedy` a string for a `failed` or `not_exercised` check, null for a passed one |
| `message` | null while eligible; otherwise one line in D2 §6's shape, `isolation unqualified: <id> <failed\|not_exercised>: <observed>; <remedy>; real backends are refused until then.`, naming the first blocking check in H order |
| `scope_cgroup` | the incarnation's scope path (section 124), null when H3 failed or under `unrun` |
| `duration_ms` | the `host_qualification` step's duration on the monotonic clock, null when it did not run |

The checks' `observed` strings are the engine's; the cases read these substrings: H1 the kernel release (`uname -r`); H2 `nsdelegate`; H3 the scope unit name (section 124) when passed, and when failed the variable that was missing (`XDG_RUNTIME_DIR`); H4 `memory` and `pids`; H6 the resolved absolute paths of `unshare`, `setpriv` and `ip`; H13 a reason the observer is absent. A forced result (section 114) keeps its `(forced)` text.

**What a slice-11 engine passes on this host.** H1 to H8, H11 and H12 are checked and `passed`; H5, H7 and H11 by launching the `probe` profile's sandbox at start (D2 §6 "the probe suite's launch", "the probe suite's domain init"), whether or not a probe runs in it. **H9 and H10 are `not_exercised`** until slice 12 builds the probe suite (M2 build spec §9: "H9 passes for the first time" in slice 12; H10 is P11 and P12), **H13 is `not_exercised`** (E57: no loader with the privilege; its `observed` says so). So in slice 11 **the host is not eligible, no `host_qualifications` row is written, no `host.qualified` is emitted**, and every real dispatch is refused `isolation_unqualified` with `subject` `{failed_checks, not_exercised_checks, host_qualification: null}`. Row M110's cases are split accordingly: `M110-host-checks-and-scope.test.mjs` (slice 11: (a) as far as slice 11 reaches, (b), (c), (f)) pins the above with H9 and H10 `not_exercised`; `M110-qualification-per-start.test.mjs` (listed under manifest slice 12, where H9 and H10 pass) pins (a)'s active row with its `checks`, `probes`, `mechanism_fingerprint` and `evidence` record, `host.qualified`, and (d), (e). The split is the build spec's slicing, not a weakening: the slice-11 file's `EXPECTED_IN_SLICE_11` table names what changes, and the slice-12 Verifier turns the two checks to `passed` there (`../COVERAGE.md`, "M2 slice 11").

**`isolation_unqualified`** (D2 §6, A.7) is the run's `code` and `refusal.code` when a real backend is dispatched while the host is not eligible, whatever the cause (a failed check, an unexercised one, no active row, H3 failed): the run ends `refused` / `preflight_refused` exactly as section 116's `backend_refused` does (receipt `refused` only, no ledger row, no `domain.*` event, no process), and `refusal.subject` carries `failed_checks` and `not_exercised_checks` as the host section lists them. M110 (c) forces H6 `failed` and reads `H6` in `failed_checks`. In the sandbox lane the scripted backend's dispatch is **not** refused by H9, H10, H12 or H13 (what the lane establishes cannot be its own precondition); what a sandbox-lane engine without a scope (H3 failed) does with a scripted dispatch is not pinned by M110 (b), which reads "the harness scripted lane still dispatches" as the kernel lane: an `unrun` engine started without the manager's variables dispatches a scripted role as M1 does.

**H3 failed** (D2 K2, H02; M110 (b)). A `run` engine started without `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` cannot reach the user manager: it reaches full mode, `engine_incarnations.scope_cgroup` is null, H3 is `failed` with its `observed` naming the missing variable and the `message` in D2's shape, `scope_cgroup` null in the host section, real dispatch refused `isolation_unqualified`, and a domain of a prior incarnation found at recovery is `unknown` (section 129), never terminated.

## 124. The incarnation scope

(D2 §3.1, §3.3, K2, Appendix B B08; M2 plan §2.6; rows M110 (a), M111; `harness/sandbox/cgroup.mjs`.)

**The unit** is `surety-<hash>-<incarnation>.scope`, `<hash>` the first 16 lowercase hex characters of the SHA-256 of the engine home's resolved path (`realpath($SURETY_HOME)`), `<incarnation>` the incarnation id of the lock (`inc_<ULID>`, generated before step 0). It is a transient scope of the **user manager** with `Delegate=yes`, created before the lock (K2 step 0). The engine's **own process enters the scope in place**: the process the test spawned is the one whose pid is in the scope, because the lock's `pid` (section 3) and every signal the tests send (SIGSTOP in M118, SIGKILL in M114) name that process. D2 §3.1 names `systemd-run --user --scope -p Delegate=yes`, which runs a command; the manager's `StartTransientUnit` with a `PIDs` property (`busctl --user call …`) places an existing pid, and both are host tools the engine checks for (H3); which the Builder uses is named in `D2_HELPERS` (section 121) by the file that spawns it.

**Inside the scope** the engine makes a `supervisor` leaf and moves itself into it, enables `memory` and `pids` for the scope's children (`cgroup.subtree_control` reads `memory pids`), and records the scope's path on its `engine_incarnations` row: **`scope_cgroup` is the absolute cgroupfs path**, `/sys/fs/cgroup` plus the `ControlGroup` the manager reports for the unit (`systemctl --user show -p ControlGroup`), on this host `/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/surety-<hash>-<incarnation>.scope`. The host section's `scope_cgroup` shows the same. Every domain is a child of the scope named by its domain id, `dom_<ULID>` (section 125). The verified hierarchy of D2 §3.3 is `app.slice` under this user's manager. **A recorded `cgroup_path` is inside it only when it is the domain's own directory**: `<scope>/<domain id>`, where `<scope>` is the scope of the incarnation that owned the domain, `surety-<this home's hash>-<that incarnation>.scope`, directly under that `app.slice`. **Any other recorded path is outside**, and its domain `unknown` (section 129): a path under another home's scope or a scope that is no engine's, a path elsewhere in the tree, and also a path elsewhere inside this home's own scopes (another domain's directory, a supervisor leaf, another incarnation's scope), since the emptiness or absence of a directory that is not the domain's says nothing about the domain. *(Amended after the slice-11 review: the strict rule, as the Builder built it; the driver's provisional default, pending Sean. D2 §3.3 says only "a recorded path outside the verified hierarchy"; the sentence this replaces counted every path under a scope of this home as inside.)*

**Two engines on two homes** (M111) have two hashes, two units, two scopes; neither reads, kills or removes the other's. A start that finds the lock held (`engine_locked`, exit 3) has already created its scope (step 0 is before the lock) and removes it on the way out: after the duplicate's exit the manager lists exactly one `surety-<hash>-*` scope for that home, the owner's, and the owner's scope, supervisor leaf and domains are untouched. When an engine dies its scope outlives it while a domain of it is populated (the manager removes an emptied scope by itself, together with its empty children; the tests allow a moment for that), which is what recovery relies on (section 129).

**`scope.before_create`** is a barrier of step 0, before the listener is up, so its `pause` cannot be released through the API: the engine waits until the file `$SURETY_HOME/harness-release/scope.before_create` exists, and marks that it is waiting by creating `$SURETY_HOME/harness-release/scope.before_create.waiting`; the directory is the test's to create (`releaseScopeBarrier`, `waitScopeBarrier` in `lane.mjs`). `kill` works as for any barrier. It is armed with `--harness-barrier` only and `GET /v1/harness/barriers` does not list it. Under `unrun` it never fires.

## 125. Domains in the sandbox lane: the launcher, placement, authorization, the role's process

(D2 §1.1, §3.1, §3.2, K1, A.3 "execution_domains", "process_ownership", A.4, A.5; Appendix B B03, B12, B13; AR B01; M2 plan §2.3 "Barriers"; rows M112, M113; `harness/sandbox/lane.mjs`, `procs.mjs`.)

**Allocation.** The dispatch transaction (section 16, "What a dispatch has written before the spawn") allocates the domain `allocated` with `launch_state` `authorizable`, `profile` (`role` by default, section 127) and **`cgroup_path`** `<scope_cgroup>/<domain id>` (the domain id is `dom_<ULID>`, so the directory is D2 §3.1's `dom_<id>`); the engine then creates that directory, empty (`populated 0`), before any launcher starts, and only while the state is not `closed`. `process_ownership.containment_id` is the same path (K1). Section 16's "What a dispatch has written" and section 18's `launch.before_spawn` stand: the spawn is now the launcher's.

**The launcher** is engine code the choke point spawns, as one process, into the supervisor leaf (its host pid in `<scope_cgroup>/supervisor/cgroup.procs` before placement); it leads its own process group. It writes its own pid into the domain's `cgroup.procs`, confirms `/proc/self/cgroup` names the domain, and reports placement: the engine records **`placed_at`** and emits **`domain.placed`** (`subject.domain`, `subject.run`; `payload.cgroup_path`, `payload.launcher_pid`). It then asks for authorization. **The grant** is one transaction (D2 §3.2): only if the domain is `authorizable`, the invocation, incarnation and lease generation it presents are current, the lease is neither expired nor `closing` and the run is not ending; it sets `launch_state` `authorized`, `launch_binding` `{"invocation", "incarnation", "lease_generation"}`, `launch_authorized_at`, the domain `launched`, and emits **`domain.launch_authorized`** (`payload.launch_binding` the same object). **The same transaction** completes the ownership row (`pid` the launcher's host pid, which the domain init inherits by exec, `pgid` its group, `pid_start_time`), appends the status observation `launched` and moves the run and its work item to `executing` (section 16's "After the spawn", moved to the grant: from here role code may run). Without the grant the launcher exits having run nothing of the role; a run never authorized has the observations `dispatch_started` then `refused` and no ledger row (section 16, "A run that has ended"). The launcher then builds the sandbox and execs the domain init; the init starts the backend. The role's process is a member of the domain's cgroup carrying `SURETY_DOMAIN` and `SURETY_INVOCATION` (section 13), as `/proc/<host pid>/environ` shows; its host pid's `NSpid` ends with the pid the role logged.

**Barriers** (section 18's rules; each fires once, the first time it is reached; `pause` waits, `kill` makes the engine SIGKILL itself). Those in the launcher and the init are reached in those processes, and armed, listed and released exactly as the engine's (`--harness-barrier`, `POST /v1/harness/barriers`, `GET /v1/harness/barriers`, `POST …/release`). **A launcher's wait survives the engine's death:** a later incarnation on the same home lists the waiting launcher's barrier and releases it; and **a launcher waiting at a barrier is not ended by SIGTERM** (it is a harness wait; `cgroup.kill` ends it). A release whose waiter is gone changes nothing and is answered 2xx, 404 or 409.

| Name | Where | What is durable when it fires |
|---|---|---|
| `launcher.before_placement` | the launcher, in the supervisor leaf, before it writes its pid into the domain's `cgroup.procs` | the run `claimed`; the domain `allocated`, `authorizable`, `cgroup_path` set, its directory present and `populated 0`; the launcher's host pid in `<scope>/supervisor/cgroup.procs`; no `domain.placed` |
| `launcher.placed` | the launcher, once the engine has acknowledged its placement | `domain.placed` and `placed_at` durable; the launcher's pid the only one in the domain's `cgroup.procs`, its `/proc/<pid>/cgroup` the domain; `launch_state` still `authorizable`; no process of the role |
| `launcher.before_authorization` | the launcher, immediately before it sends its authorization request | the same as `launcher.placed`; the two fire one after the other |
| `launcher.authorized` | the launcher, once it holds the grant, before it builds the sandbox | `domain.launch_authorized`, `launch_state` `authorized`, `launch_binding`, the domain `launched`, the run `executing`, ownership complete; still no process of the role |
| `init.before_backend` | the domain init, process 1 of the sandbox, after its setup and before it starts the backend | as `launcher.authorized`; the init is a member of the domain (host-read); no process of the role |
| `boundary.before_terminated` | the engine, after it has read `populated 0` with closure established, before the transaction that records `domain.terminated` | `launch_state` `closed`, `launch_closed_at`; the directory present and `populated 0`; no `domain.terminated`; released, the engine records it and removes the directory |

**Refusal of a grant** (B03; M112 (b) to (d)) is observed from outside as: no `domain.launch_authorized` event, `launch_state` never `authorized` (`authorizable`, then `closed` by the end of the run), the launcher's host pid gone from the domain's `cgroup.procs` (it exited), `populated 0`, no scripted launch recorded, and the run's end with its cause (`recovered` for an expired lease, `stopped` for a Stop, `timed_out` for a deadline).

**A launcher killed before placement** (M112 (e); SEAM §13's "or it cannot be spawned"): the engine finds its child gone, the domain is never `launched`, the run ends `failed` / `infra_error` with the receipt `refused` and no ledger row, the domain `terminated` (closed, `populated 0`) and its directory removed, and the work is repaired like any failed run's.

## 126. Termination in the sandbox lane, and the exit evidence

(D2 §1.6, §3.2, §3.4, K1, K4, A.3 "invocation_status_observations"; Appendix B B04, B12, B13, N02; M2 plan §2.6 "the fewest keys of `exit_evidence`"; rows M113, M116, M118.)

**The sequence**, for every way a run ends (Stop, Abandon, a deadline, a budget stop, the role's exit, an expired lease, recovery): (1) **close**: `launch_state` `closed`, `launch_closed_at`, **`domain.launch_closed`** (`payload.reason` a non-empty string; its values are not pinned), after which no grant is possible; (2) **the launcher**: an unplaced launcher (a child of this engine) is killed through its handle and its exit awaited, **for at most `kill_grace`** (below); a placed one is a member and dies with the domain; (3) **TERM** to the domain init through its channel, which relays it to the backend's process group, then `terminate_grace`; (4) **`cgroup.kill`**, then `kill_grace`; (5) **observe** `cgroup.events`. A role that exits on TERM ends the wait early (the init exits once the backend has, and the domain empties). **`terminated`** is recorded only when (1) and (2) hold and the observation read `populated 0`: `execution_domains.observation` `terminated`, **`observed_at`** the time of that read, `status` `terminated`, **`domain.terminated`** (`payload.observed` true), `process_ownership.termination_confirmed_at`; then the directory is removed (`rmdir`), after the record, and nothing recreates it: no later `domain.placed` names the domain and no launcher re-enters (B12). A run ends (`run.ended`) only after every domain of it is `terminated`. A domain the running engine knows it never spawned a launcher into is `terminated` as section 14 says (`payload.observed` false) once its directory, if any, is removed. The exit of the role process establishes nothing (section 14): a daemon the role left is a member and the run waits for `populated 0` (M116 (b)).

**Unknown** (D2 §3.4; section 128) is the observation when closure or emptiness cannot be established; `populated 1` persisting after `kill_grace` is one such case; `cgroup.kill` returning is never termination.

**The exit class and its evidence** (D2 §1.6; N02) are on the terminal status observation of the invocation (`invocation_status_observations.exit_class`, `.exit_evidence`, the latter JSON). The fewest keys of `exit_evidence`: `status` (the backend's exit status as the init reported it; null when no report reached the engine), `signal` (the number of the last signal the engine sent the domain, 15 or 9, or the signal that ended the backend when the engine sent none; null when neither), `signal_by_engine` (bool), `terminal_event` (`"result"` when the scripted adapter read a valid result line; null otherwise), `resource_events` (`{oom_kill, pids_max}` as read from `memory.events` and `pids.events` before the directory was removed; `{}` when they could not be read). *(Amended in M2 slice 13, section 145: `terminal_event` is `"result"` when the adapter read the terminal success event, whatever the result file holds; `resource_events` always has both keys, each an integer or null where its file could not be read, never `{}` and never 0 for an unread counter.)* The classes slice 11 pins: **`engine_signaled`** for a run the engine cancelled before the exit (M113 (a): `signal` 9, `signal_by_engine` true, `status` null; M113 (b): `signal` 15, `signal_by_engine` true, `status` 143 as the role exits on TERM; M118 (b): `signal_by_engine` true), **`clean`** for exit status 0 with a valid result (M116 (b), M118 (a), (c): `status` 0, `terminal_event` `result`), **`error_exit`** for a nonzero status with no result (M118 (g): `status` the code, `signal_by_engine` false). A quarantined run has no terminal observation until its clearance; the class is then the one the facts give. `resource_limit`, `foreign_signal` and the precedence among overlapping facts are slice 13's (M130).

**The wait for an unplaced launcher's exit is bounded by `kill_grace`** *(a reading added after the slice-11 review; a question for the owner)*. D2 §3.4 makes "a launcher's exit cannot be established" a cause of `unknown`, which it can only be if the wait ends; D2 §3.2 gives `kill_grace` as the time a kill is given before the observation, and the kill through the launcher's handle is a kill. So: the launcher is killed, its exit is awaited for at most `kill_grace`, and an exit not established by then leaves the domain `unknown` and the run quarantined; the run's end never hangs on it. No configuration key is added. No case exercises the bound itself (a process that outlives SIGKILL cannot be made here); the fault `launcher_wait` (section 128) stands for the exit that is not established.

**Order and durations a case compares** *(amended after the slice-11 review)*. Order is read from the events' sequence: the `domain.launch_closed` event precedes `domain.terminated`, which precedes `run.ended`, and for an Abandon the `operation.intended` of the workspace's `worktree_remove` (section 24). A duration is measured by the test on the monotonic clock, never as the difference of two engine timestamps: for a role that ignores TERM, the role is still alive, host-read, `terminate_grace` less a second after the test saw the closure (the kill, and so the observation, came no earlier than the grace). `launch_closed_at` and `observed_at` are both recorded; no case subtracts them. The first form of M113 (a) did, with section 23's two seconds of slack, and failed one run in six on a host whose wall clock steps back by 2.9 s every 32 s (`../COVERAGE.md`, "M2 slice 11", "After the review").

## 127. The scripted role inside the sandbox: the bound directory, daemons, probes, the `probe` profile

(BS §8; D2 §2.3, §2.8, A.6 P13 to P16; M2 plan §2.3 "Scripted role additions", §2.4; rows M116, M117; `harness/scripted/child.mjs`, `harness/scripted.mjs`.)

**The bound directory.** The scripted directory (`--harness-scripted <dir>`) is bound **read-write at its own host path** inside every sandbox of a sandbox-lane engine: the role program is launched as `node <dir>/child.mjs` from the read-only bind of the engine's `node` (H7), reads its scripts and release files there, and appends to `launches.jsonl` and `pings/` there. The bind is the backend installation's of D2 §2.3 for this backend (read-write because the backend's log is the test's instrument), is part of the mount plan the sandbox lane validates (row M120 compares the mount table with the plan; the bind is in the plan), and exists only for the scripted backend in harness mode. The role's `cwd` and the request's `workspace` are what slice 12 pins (section 122).

**What the role logs in this lane** (`launch` entries gain `session`, the session id, and `nspid`, which inside the sandbox is the role's own pid): the pids in the log are the sandbox's. A test joins a log entry to the host through the invocation marker and `NSpid` (`roleProcess` in `lane.mjs`). `Scripted.eventsOfInvocation`, `.daemons`, `.probes`, `.pings` read the additions below.

**A daemon** (`step.daemon(name, {on_term, ping_ms})`; P16's form): the role starts `child.mjs daemon-fork <options>` and waits for it; that intermediate starts `child.mjs daemon <options>` **detached (`setsid`), with an empty environment and no inherited descriptor**, and exits, so the daemon's parent is the sandbox's init and it leads its own session; the daemon logs `daemon_ready` (`name`, `session`, `pgrp`, `parent`, `env_count` 0) and appends one line to **`<dir>/pings/<name>.jsonl`** every `ping_ms` (default 100) for as long as it lives, ignoring SIGTERM unless `on_term` is `exit`; the role logs a `daemon` entry (`name`, `ready`, `daemon_pid`, `daemon_session`, `daemon_parent`, `daemon_env_count`). The ping file is the **witness file** of D2 A.6 P16: host-witnessed in `cgroup.procs` before the kill (with an empty `/proc/<host pid>/environ` and a session id equal to its own pid), and after `cgroup.kill` never written again. The plan's "pings the echo endpoint" is the `probe` profile's form of the same witness once the proxy exists (M126); slice 11 needs no endpoint for it.

**Probe actions** (`step.probe(action, args)`; each logs one `probe` entry with `action` and what it found; the host corroborates):

| Action | What the role does and logs |
|---|---|
| `mountinfo` | `mountinfo`: the lines of its `/proc/self/mountinfo` |
| `cgroup_migrate` `{to}` | writes its own pid into `<to>/cgroup.procs`; `outcome` `written` or `refused` with `error` (the errno code); `before` and `after` its `/proc/self/cgroup` |
| `signal_all` `{host_pid_ns}` | **guarded (below)**: refused with `outcome` `refused_unsandboxed` and `guard.reasons` unless it is inside a pid namespace of its own; otherwise `outcome` `ran`: starts a child of its own (`control`), sends SIGKILL to every pid its `/proc` lists but itself (`results[pid]` `sent` or the error code), then `kill(-1, SIGKILL)` (`kill_all`); `control.exit` how its child ended; `after` the pids `/proc` lists then |
| `signal_all_check` `{host_pid_ns}` | the guard alone: `outcome` `would_run` or `refused_unsandboxed`, `guard` `{reasons, own, init, visible}`; no signal |
| `init_fd` | lists `/proc/1/fd` (`outcome` `listed` with `init_fd`, or `refused` with `error`); `init_cmdline` |
| `net_unix` | listens on an abstract socket of its own (`own`, without the leading NUL), then logs `net_unix`, the lines of its `/proc/net/unix` |
| `self_status` | `cap_eff`, `no_new_privs`, `uid`, `gid`, `nspid` from `/proc/self/status`; `fds`: every entry of `/proc/self/fd` with its link target |
| `mount_attempt` `{target}` | runs `mount -t tmpfs none <target>`: `status`, `signal`, `error`, `stderr`; `mounted` whether its mountinfo then lists the target |
| `read_back` `{path}` | reads a file it wrote: `outcome` `read` with `content`, or `failed` with `error` |

**The guard of `signal_all`.** That action kills every process the role can see. Inside a sandbox's pid namespace it reaches the role's own child and nothing else, which is the point of P13; run by a role an engine launched with **no** pid namespace it kills every process of the user. That happened once: the slice-10 engine launches the scripted role directly on the host, this file's first M117 (a) scripted the action unconditionally, and its run on 2026-10-03 ended every process of uid 1000 on the machine, the user manager included (`../COVERAGE.md`, "M2 slice 11", "The incident"). Since then the action **fails closed, twice over**. The role program runs it only if the step carries the host's pid namespace (`host_pid_ns`, as `readlink /proc/self/ns/pid` gives it on the host) and the role's own is a different one, pid 1 as the role sees it is not a system's init (`systemd`, `init`, `launchd`), and the role sees at most 16 processes; any read that fails is a refusal, logged as `outcome` `refused_unsandboxed` with the reasons, and nothing is signalled. `step.probe` refuses to script the action; `step.signalAll(hostPidNamespace())` scripts it; `signal_all_check` evaluates the guard alone. And a test puts the action behind a hold and releases the role only after it has read, **from the host**, that the role's process is a member of its domain's cgroup, has an inner pid (`NSpid` of two or more), and is in a pid namespace other than the test's own (`pidNamespaceOf`). A later slice that scripts a destructive action for a role (P13 in the probe suite, P20's fork and memory exhaustion) keeps both halves: the instrument refuses outside the sandbox by its own check, and the test shows the sandbox from the host before it releases the role.

**The `probe` profile** (D2 §2.8, §3.8, A.6 P15; M116 (c)). A test dispatches a domain under it through the trigger fixture: `POST /v1/harness/fixtures/trigger` takes an optional **`profile`** (`role`, the default, or `probe`), recorded on the work item, and every run of that item is dispatched with `execution_domains.profile` set to it. In the `probe` profile the sandbox binds, read-write, **the domain's own cgroup directory at `/surety/cgroup/domain`** and **a sibling cgroup at `/surety/cgroup/sibling`** that the engine creates beside the domain (`<scope_cgroup>/sibling_<domain id>`, delegated like a domain, empty, removed with the domain). In the `role` profile neither exists and the mount table has no `cgroup2` entry. The rest of the `probe` profile (the echo endpoint, the probe program at `/surety/context/probe`) is slice 12's. P15's reading: a write of the role's pid to the sibling's `cgroup.procs` is refused (the error code is what the role logs; `EACCES` is what `nsdelegate` gives a migration out of the namespace's root), the host still lists the role's host pid in the domain's `cgroup.procs` and not in the sibling's, and the control is the host seeing the role's pid in the domain.

**Host-side corroboration the cases make** (M2 plan §2.4): for P13 (M117 (a)) a host sentinel process started by the test outside every domain survives, the engine answers, the init still relays the role's result and exit (the run ends normally), and the role's own child died (`control.exit.signal` `SIGKILL`); for P14 (M117 (c)) `CapEff` all zero, `NoNewPrivs` 1, uid and gid 1000 in every position, the `mount` attempt failed with `mounted` false, and every descriptor beyond 0, 1 and 2 at the role's first inspection is the runtime's own (`anon_inode:*`, a `pipe:[…]` both of whose ends are in the same table, `/dev/null`, `/dev/urandom`) or the listing's own directory: no socket, no regular file, no directory, no host path; for M117 (b) `/proc/1/fd` is `refused` (`EACCES`) and `/proc/net/unix` lists the role's own abstract socket and no other abstract socket.

## 128. Unknown and quarantine through the real boundary

(D2 §3.3, §3.4; BS §6 corrections 2 and 13; Appendix B B07, B15; sections 14, 16; M2 plan §2.5, question 6, E59 item 5; rows M113 (c), M114 (c), (d), M115; `harness/sandbox/cgroup.mjs`, `sentinel.mjs`.)

**The conditions and how a test makes each** (every one yields `unknown`, section 16's quarantine shape unchanged: the run `finalizing` with `quarantined` 1 and its outcome recorded, the domain `quarantined` with `observation` `unknown` and `observed_at`, the quarantine reservation, the open `blocker` with `acknowledge`, the workspace `quarantined`, and nothing collected: no `result`, `unaccepted_result` or `provider_files` record of the run):

| Condition (D2 §3.4) | The test's instrument |
|---|---|
| `cgroup.events` exists but cannot be read | `chmod 000` on the domain's `cgroup.events` (the engine runs without `CAP_DAC_OVERRIDE`) before the observation; restored later |
| the user manager unreachable | the fault **`manager_unreachable`** (below) |
| the recorded path outside the verified hierarchy | `execution_domains.cgroup_path` edited in the store, engine stopped, to a path under another scope or outside `app.slice` |
| a prior supervisor leaf that cannot be killed, read or shown absent | `chmod 000` on the prior incarnation's `<scope>/supervisor/cgroup.kill` or `cgroup.events` before the restart, with the scope kept alive by a live member |
| a launcher's exit cannot be established | the fault **`launcher_wait`** |
| `cgroup.kill` cannot be written | `chmod 000` on the domain's `cgroup.kill` before the kill phase |
| `populated 1` persists after `kill_grace` (a member in uninterruptible sleep) | **`not_exercised`**: no unprivileged way to put a process in `D` state on demand; the case asserts the host fact (no sudo) and says so (M2 plan §2.5) |

**Where the tests themselves change the cgroup tree.** A case makes a cgroup file unreadable, removes or recreates a directory, places a sentinel or empties a dead engine's domain only **inside a test engine's scope** (`surety-<16 hex>-inc_<ULID>.scope`) **or a sentinel scope of the tests' own** (`surety-test-sentinel-<8 hex>.scope`): `makeUnreadable`, `restoreReadable`, `removeCgroup`, `killCgroup`, `moveIntoCgroup` and `makeLeaf` in `harness/sandbox/cgroup.mjs` refuse any other path before they touch anything. The paths they are given come from the store of the engine under test; an engine that recorded the user's `app.slice` or the manager's own cgroup must fail the case, not have the test damage the session (the rule of section 127's guard, applied to the test side). **And nothing of a fixture's engines outlives its test** *(added after the slice-11 review)*: a launcher waiting at a barrier survives its engine (section 125), so the lane's fixture, when its test is over, ends every member of every child cgroup of that home's scopes (`endScopeLeftovers`, by the home's unit prefix, inside test scopes only); a case that fails before it releases a launcher leaves no process and no scope behind.

**The hierarchy is verified before anything is signalled.** Steps (3) to (5) of section 126 run only after the engine has established that the domain's recorded path is inside this home's verified hierarchy (section 124) and that the manager answers; failing that, the domain is `unknown` at once, nothing is signalled (the role lives on), and the run is quarantined. A `manager_unreachable` fault therefore leaves the role alive (M115 (b), (h)).

**Re-observation.** Each tick, and startup recovery, observes every quarantined domain again under the same prerequisites (closure held, **no launcher outstanding**, the hierarchy verified, the prior supervisor accounted for) and makes it `terminated` only on `populated 0` or absence in the verified hierarchy. **The launcher prerequisite holds at every observation, a tick's included** (the slice-11 review's S1; D2 §3.2: "`populated 0` on a domain whose launcher is outstanding is not termination"): while a launcher of this engine for the domain is alive and not a member of the domain's cgroup, its exit not established, the domain stays `unknown` and its run quarantined whatever `cgroup.events` reads; the tick does not signal the launcher (it signals nothing); the launcher's own exit, or a restart whose recovery kills the prior supervisor leaf (section 129), lifts the condition, and the tick after that clears the quarantine. *(Amended after slice 14, E79 item 2: the launcher's exit itself asks for that tick; section 170.)* A launcher released after closure is granted nothing and runs nothing of the role (section 125); whether it places itself in the closed domain on its way out is not pinned (D2 §3.2 lets a launcher be "itself a member"), and no placement is recorded after the termination. **A tick's re-observation signals nothing**: the termination sequence of section 126 runs once per end, and again at startup recovery (section 129) when the prerequisites hold; a quarantined domain whose role lives on after the condition lifts stays quarantined, with its members readable in `cgroup.procs`, until the role is gone (M115 (h)). Not taken: re-running TERM and `cgroup.kill` at a tick, which would end a recreated directory's sentinel as if it were the domain's (M115 (g)). **Clearance** is section 16's, once (M17's shape): `domain.terminated` (`observation` `terminated`), the reservation released, the run ended with the outcome it had. **A directory recreated at the recorded path is never termination**: the engine records the inode of the domain's cgroup directory when it creates it, and a directory found at the recorded path with another inode, populated or empty, is not the domain's: the observation is `unknown` *(amended after the slice-11 review: as the Builder built it; the driver's provisional default, pending Sean; D2 does not name the inode)*. So a directory the test removed and recreated at the recorded path with a sentinel inside is never terminated, and the sentinel lives on (M115 (g) pins that for a tick; that recovery signals nothing into a recreated directory before it has compared the inode is not pinned). Absence of the directory, inside the verified hierarchy, is still termination. A recorded path under another scope is outside the hierarchy: `unknown`, never terminated, the sentinel there untouched.

**Across a restart.** A quarantine survives a restart only where the restart still cannot establish termination: the role alive with `cgroup.kill` unwritable, the path outside the hierarchy, a prior supervisor unreadable. A quarantined domain that is empty when its engine dies loses its scope (section 124) and is absent in the verified hierarchy at the next start: that restart clears it, as D2 §3.3 says it must (M115 (a) keeps the scope alive with a test leaf and a sentinel to show the survival; `../COVERAGE.md` records where the plan's "all surviving a restart" meets this).

**Faults of this slice** (`POST /v1/harness/faults`, section 61's `times`; `DELETE /v1/harness/faults` lifts them):

| Fault | Meaning |
|---|---|
| `{"point": "manager_unreachable"}` | While armed, every call the engine makes to the user manager fails as if the manager were gone; an observation made meanwhile is `unknown`, nothing is signalled. Standing with a large `times`; lifted by `DELETE`. |
| `{"point": "launcher_wait"}` | The next attempt to end an unplaced launcher (section 126 step 2: the kill through its handle and the wait for its exit) fails as a whole: no signal reaches the launcher, its exit is not established, and it is left as it was, alive and unplaced; the domain is `unknown`. *(Sharpened after the slice-11 review: the S1 case needs the launcher left outstanding, which is what the fault stood for.)* |
| `{"point": "init_report_lost"}` | The next exit report from a domain init never reaches the engine (the exit class is then `unknown` or `engine_signaled` by precedence; no slice-11 case arms it; M130). |
| `{"point": "challenge_response_dropped"}` | The next response to a pause challenge is dropped (section 130). |
| `{"point": "before_event", "event_type": …}` | Section 7's fault, armed on the new types `domain.placed`, `domain.launch_authorized`, `domain.launch_closed`, `run.lease_regranted` as on any other. |

**The user manager interrupted** (B15; M115 (h); E59 item 5): a real `systemctl --user daemon-reexec` during a run changes nothing the engine sees: the role's processes survive, the scope stays, the run completes normally. A real stop of the user manager is **`not_exercised`** (it ends the login session and needs privilege to restore; the case asserts the host fact and the reason). The `manager_unreachable` fault is the engine-side half: under it a Stop quarantines the run with the role alive; lifted, the next tick observes `populated 1` and keeps the quarantine; the role's own exit then empties the domain and the tick after that clears it.

## 129. Recovery through the real boundary

(D2 §3.3, K1, K2; D1 §16.1; Appendix B B05, B06; section 16 "Recovery at startup"; rows M110 (b), M111 (d), M114; `harness/sandbox/lane.mjs`.)

In the `recovery` step, after the lock, a sandbox-lane engine: (1) **closes** every non-terminated domain of every prior incarnation of this home (`domain.launch_closed`, before any signal); (2) **kills every prior incarnation's `supervisor` leaf** of this home whose scope still exists (`cgroup.kill`, then reads `populated 0`), or establishes the scope's absence by reading `app.slice` of the user manager; a launcher of a prior incarnation waiting there (M114 (b)) dies with it, never having run role code, and a release of its barrier afterwards is a no-op; (3) **observes each domain** at its recorded `cgroup_path`: `populated 0` in the directory the engine created (section 128's inode), or the absence of the domain's own directory inside the verified hierarchy (section 124's strict rule: the recorded path must be the domain's own, not merely some absent path under this home's scope), is `terminated`; `populated 1` sends the domain through the termination sequence of section 126 (TERM, `terminate_grace`, `cgroup.kill`, observe), which with a role that ignores TERM takes the grace; a recorded path outside the hierarchy, a manager that does not answer (H3 failed, `manager_unreachable`), or a prior supervisor leaf whose `cgroup.events` or `cgroup.kill` cannot be used makes every affected domain **`unknown`** and quarantined, with nothing signalled. The runs are then ended as section 16 says (`recovered` where no outcome was decided; `run.ended.payload.recovery` the incarnation), the work `held`, and no process of the old incarnation remains where termination was established. Another home's scope, supervisor leaf and domains are never read, killed or removed (M111 (d)). After recovery the manager lists the old scope only while something of it is populated.

## 130. The pause re-grant: a fresh challenge, and nothing else

(D2 §3.5, K5; E36 item 6; E27 items 3, 5, 7; Appendix B B09, B10; AR N01; M2 plan §2.6 "what a pause re-grant's event carries"; section 16 "The run lease"; row M118.)

**When.** The tick's first step finds a run lease past `expires_at` (section 16). In the sandbox lane, for a run **this incarnation** launched whose domain observes `running` (populated, hierarchy verified), whose ownership and `launch_binding` name this incarnation and the current lease generation, whose deadline has not passed and which is not ending, the engine sends a **fresh challenge** on the domain init's channel: a nonce bound to the invocation and lease generation. A response carrying that nonce within `pause_challenge_timeout` with the backend's state **re-grants the lease on the same generation** (fencing unchanged) and emits **`run.lease_regranted`** (`subject.run`, `subject.project`, `subject.work_item`; `payload`: `generation` the unchanged generation, `expires_at` the renewed expiry, `challenge` `{"nonce": <at least 16 hexadecimal characters, fresh per challenge>, "sent_at", "answered_at", "backend_state": "running"}` with engine-clock timestamps after the pause: the engine is stopped throughout it, so a case tells "after the pause" by the pause's midpoint, never by a slack of seconds on a wall clock that steps). The lease's `renewed_at` and `expires_at` move with the re-grant and with nothing before it: a heartbeat the role sent during the pause, read after it, renews nothing (section 16, "Expiry is final" for callbacks); `deadline_at` and the budget are unchanged. **A response reporting that the backend has exited** ends the run by its exit (section 126), with the output the engine has read: a valid result and exit status 0 complete it (M118 (c)). **No response within the bound**, the fault `challenge_response_dropped` among the causes, ends the run as section 16 says for an expired lease (`recovered`, the domain terminated through the boundary, work `held`). No re-grant is made for a run already ending (a Stop confirmed before the pause; a budget stop decided on a usage line read after it), for a deadline that has passed (the run ends `timed_out`), or by another incarnation (recovery ends it `recovered`).

**An expired lease is pending, not decided, while the challenge is possible** (K5 replaces E26's "expiry is final" for a supervised live run; E36 item 6): between the expiry and the tick's challenge the engine neither ends the run nor refuses the backend's output: a usage observation read then is recorded and checked against the budget as any other (the store accepts usage on an unreleased lease, section 55); a result read then is kept and takes effect with the challenge's outcome (`completed` when the response reports the exit, or on the re-grant). **The kernel lane is unchanged:** it has no init and no channel, so no challenge is answered there, and M15's rules (an expired lease ends the run `recovered`; a result presented on it is refused) stand for every M1 file.

**Which tick** is not pinned: the engine may tick by itself as soon as it finds the lease expired after the pause, and a re-grant made then, on a fresh challenge, is the re-grant; the cases ask for a tick and accept either *(added after the slice-11 review: an engine that challenged within milliseconds of resuming was observed)*. What is pinned is the order: no renewal by a heartbeat precedes the re-grant.

**The pause itself** is real: the test sends the engine SIGSTOP for longer than `lease_ttl` (its minimum, 30 s) with the role holding and heartbeating inside the sandbox, then SIGCONT and a tick. The engine's process is the one the test spawned (section 124), so the signal stops the engine and nothing else.

## 131. Names the Verifier fixed in this pass, and what it changes in earlier sections

**What this pass changes in earlier sections.**

- Section 1's constructed environment: a sandbox-lane engine is also given `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` (section 122). Section 1's flags: `--harness-host-checks run` is the sandbox lane (section 114, 122).
- Section 4's steps: `scope` and `host_qualification` in `run` mode and outside harness mode (section 123); under `unrun` as before.
- Section 7's fault table and section 61's: `manager_unreachable`, `launcher_wait`, `init_report_lost`, `challenge_response_dropped` (section 128); `before_event` on the four new types.
- Section 13's launch: in the sandbox lane the engine spawns the launcher, not the role; the role's pids are the sandbox's; the request's `workspace` and the role's `cwd` are slice 12's (sections 122, 125). Section 13's `descendant` gains `daemon` and `probe` steps (section 127).
- Section 14: not used in the sandbox lane (section 122).
- Section 15's trigger fixture takes `profile` (section 127).
- Section 16's "After the spawn": in the sandbox lane the transaction is the grant's (section 125); "Recovery at startup": section 129's order; "The run lease": section 130's pending expiry in the sandbox lane; "Quarantine": `observation` and `observed_at` on the domain (section 128).
- Section 18's barriers: seven new names (sections 124, 125); `scope.before_create` is released by a file.
- Section 114: `host_eligibility` gains `not_exercised_checks`; section 118's `host_qualification` gains `not_exercised_checks`, `wsl2`, `message`, `scope_cgroup`, `duration_ms` and `checks[].remedy` (section 123).
- Section 116's `isolation_unqualified`: its refusal subject (section 123).
- Section 121's `D2_HELPERS`: `boundary/scope.ts` is still the one helper file outside `invoke/`; it runs `busctl --user` (the scope's creation with the engine's own pid, section 124) and `systemctl --user` (the manager's view of a scope), not `systemd-run`, and `harness/launch-lint.mjs` lists it once per tool. The launcher's `unshare`, `setpriv` and `ip` are under `invoke/`. (Read from the file names of the Builder's branch, as section 121 provides; the cases pin none of it.)

**Names the Verifier fixed.** Each was open in the sources (M2 plan §2.6, or D2 in words). The Builder may object. Those marked † carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| The sandbox lane's switch and environment | `--harness-host-checks run`, with `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` from the login session (section 122) | Section 114 named the switch; the manager is reached through those two and nothing else is needed (busctl, systemctl). |
| The scripted directory in the sandbox † | Bound read-write at its host path (section 127) | The role's log is the only instrument that sees a role killed mid-run; the volatile filesystem is lost with the domain and collection is slice 13's. |
| The scripted result channel in slice 11 | The stdout line, through the init (section 122) | The result file is M129's; the stdout protocol is what the slice's rows need and what the Builder's adapter already parses. |
| The startup steps | `scope` before `lock`; `host_qualification` between `integrity` and `full`; neither listed under `unrun` (section 123) | K2 names both as steps; M06 pins the M1 list for the kernel lane. |
| The host section's additions | `not_exercised_checks`, `wsl2`, `checks[].remedy`, `message`, `scope_cgroup`, `duration_ms` (section 123) | D2 §6: the check, the value and the remedy readable; the message's shape is D2's example; `tick_step_budget` needs a measured duration. |
| What slice 11 passes † | H1 to H8, H11, H12 `passed`; H9, H10, H13 `not_exercised`; no row, not eligible; M110 split across two files, the second under slice 12 (section 123) | BS §9: H9 passes in slice 12; a row written on an unexercised check would be the vacuous pass CH #17 forbids. |
| The scope unit and `scope_cgroup` | `surety-<16 hex of SHA-256(realpath home)>-<incarnation>.scope`; the absolute cgroupfs path (section 124) | D2 §3.1 names the shape; the tests open files at the path the store records. |
| The engine enters its scope in place † | No re-exec; `StartTransientUnit` with `PIDs` or an equivalent (section 124) | Section 3's lock pid and the signals the tests send name the spawned process. |
| `scope.before_create`'s release | A file under `$SURETY_HOME/harness-release/` (section 124) | It fires before the listener; nothing else can reach the engine then. |
| `cgroup_path`, `containment_id`, the sibling | `<scope_cgroup>/<domain id>` (`dom_<ULID>`); the same; `<scope_cgroup>/sibling_<domain id>` (sections 125, 127) | D2 §3.1 "a child cgroup `dom_<id>`"; K1's `containment_id`; P15 needs a real sibling. |
| The grant's transaction | Also completes ownership, appends `launched`, moves the run to `executing` (section 125) | K1: `launched` at authorization; a run never authorized is "never launched" (`refused`). |
| The launcher barriers' semantics | Section 125's table; the wait survives the engine; a waiting launcher ignores TERM | M112 (d) releases a launcher after a restart; the refusal of a grant is observable only while the launcher lives. |
| `domain.placed`, `domain.launch_authorized`, `domain.launch_closed` payloads | `{cgroup_path, launcher_pid}`; `{launch_binding}`; `{reason}` (sections 125, 126) | A.5 names the types and no payloads. |
| `exit_evidence`'s fewest keys | `status, signal, signal_by_engine, terminal_event, resource_events` (section 126) | A.3 names them in words; the cases read the first three. |
| `observed_at` as the termination time | The time `populated 0` was read (section 126) | A.3 has `observed_at`; the plan's `terminated_at` has no column. |
| The hierarchy verified before signalling † | Nothing is signalled to a domain whose path or manager cannot be verified (section 128) | D2 §3.3: "a manager that is unavailable … makes every affected domain unknown"; signalling an unverified path could reach another scope's processes. |
| A tick's re-observation signals nothing † | Observe only; the termination sequence runs once per end and at recovery (section 128) | M115 (g)'s recreated directory with a sentinel must never be terminated; M115 (h)'s role is alive after the fault lifts. |
| Quarantine survival across a restart | Only where the restart still cannot establish termination (section 128) | D2 §3.3 makes absence in the verified hierarchy termination; an empty scope is removed by the manager. |
| The faults | `manager_unreachable` (standing), `launcher_wait`, `init_report_lost`, `challenge_response_dropped` (section 128) | M2 plan §2.3 names them; their points follow D2 §3.4 and §3.5. |
| `run.lease_regranted`'s payload | `generation`, `expires_at`, `challenge {nonce, sent_at, answered_at, backend_state}` (section 130) | M2 plan §2.6: a fresh challenge must be told from a buffered heartbeat; a nonce and a time after the pause do that. |
| An expired lease pending the challenge † | Output read meanwhile is kept; usage is recorded; the kernel lane unchanged (section 130) | K5 and E36 item 6 replace E26 for supervised live runs; M118 (c)'s `completed` needs it. |
| The daemon and probe steps | Section 127 | M2 plan §2.3's role additions, as the cases need them. |
| The guard of `signal_all` † | Fails closed in the role program and behind a host-side check in the test (section 127) | The action ended every process of the user once, on an engine with no sandbox. A destructive instrument must be safe on the engine that does not yet do what the case requires, because that is the engine every new case first runs on. |
| The `probe` profile's selection | `profile` on the trigger fixture (section 127) | No production setting selects a profile; the suite of slice 12 selects it itself. |
| `not_exercised` cases | A test that asserts the host fact and the reason, named `[not_exercised]` (sections 123, 128) | M2 plan §2.5; a skip is not a pass and a vacuous pass is not honest. |

## Amended after the slice-11 review (S1; 2026-10-03)

On `verify/m2-s11-review` from `main` at `26ce607`. One case for the one confirmed serious finding (E31), in `M115-every-unknown-quarantines.test.mjs` beside (e): **S1**, a tick with this engine's launcher outstanding records no termination (section 128, "Re-observation"). With it: section 124's strict path rule and section 128's inode rule, both as the Builder built them and both the driver's provisional defaults pending Sean; section 129's wording to match; section 126's bound on the wait for an unplaced launcher (`kill_grace`) and its rule that a case measures durations on the monotonic clock and reads order from event sequence; section 128's sharper meaning of the fault `launcher_wait`; section 130's "after the pause". Two corrections of this Verifier's own cases came with it, each recorded in `../COVERAGE.md` ("M2 slice 11", "After the review"): **M115 (e)** required its never-authorized run's invocation to be recorded as launched and charged, against section 125 ("a run never authorized has the observations `dispatch_started` then `refused` and no ledger row") and section 24; it now requires `refused` and no ledger row, as the S1 case does. **M113 (a)** and **M118 (a), (b)** compared engine wall-clock timestamps with two seconds of slack; the host's clock steps back by 2.9 s every 32 s, which is the intermittent M113 (a) failure the Reviewer saw; they now measure on the monotonic clock, or by the pause's midpoint.

| What | Fixed as | Why this choice |
|---|---|---|
| The launcher prerequisite at a tick | Holds at every observation; the tick signals nothing and terminates nothing while the launcher is outstanding (section 128) | D2 §3.2, §3.4; the review's S1. |
| What bounds the wait for a killed unplaced launcher † | `kill_grace`; past it the domain is `unknown` (section 126) | D2 §3.4 names the condition, so the wait must end; `kill_grace` is D2's time after a kill. No key invented. |
| The fault `launcher_wait` | The whole attempt fails: nothing is sent, the launcher is left alive and unplaced (section 128) | An exit that "cannot be established" must be able to leave a launcher outstanding, or D2 §3.2's rule about one has no instrument. |
| The recorded path † | Inside only if it is the domain's own directory in its owning incarnation's scope of this home (sections 124, 129) | The driver's provisional default, pending Sean; the absence of a directory that is not the domain's says nothing about the domain. |
| A recreated directory † | Never termination; told by the inode recorded at creation (section 128) | The driver's provisional default, pending Sean. |
| A released launcher's placement | Not pinned; no grant, no role, no placement after termination (section 128) | D2 §3.2 lets a launcher be "itself a member" after closure. |
| A never-authorized run cleared from quarantine | `refused`, no ledger row (sections 24, 125) | The store shows no grant, so no role code ran; `unknown` is for an engine that cannot tell. |
| Durations and order in the sandbox-lane cases | The monotonic clock; event sequence; the pause's midpoint (sections 126, 130) | The host's wall clock steps by more than section 23's allowance. |
| A pid a test read and signals (the closing pass) | Only an integer greater than 1 that is not the test or its parent (`harness/proc.mjs`) | E64's rule on the test side; a `0` in `cgroup.procs` would have reached the test's own process group. |
| "Since this step of the clock" in the kernel lane (the closing pass; E65 addendum) | A change of the row from its value before the step; `CLOCK_SLACK_MS` 4000, used by a wait only | The allowance of sections 18 and 23 was smaller than the host's step. |

**The closing pass** (2026-10-03, on `verify/m2-s11-close` from `main` at `2b4a566`; E65 addendum). Two things, both of the harness.

*A pid that was read is signalled only if it may be* (`harness/proc.mjs`: `signallable`, `signalPid`). A test signals two kinds of pid: one it holds a child handle for, and one it **read** from a `cgroup.procs` file, from a log a role wrote, or from the store. The second kind is signalled only when it is an integer greater than 1 and is not the test's own process or its parent: `0` is the caller's own process group (and is what a reader in another pid namespace finds in `cgroup.procs` for a process outside it), a negative number is a group or, as `-1`, everything the caller may signal, and `1` is the system's init. `endScopeLeftovers`' one-by-one fallback, the cgroup sentinel, `Scripted.killStrays`, M112 (e)'s kill of the launcher and M118's SIGSTOP and SIGCONT go through `signalPid`; `moveIntoCgroup` refuses such a pid (a `0` written into `cgroup.procs` moves the writer). This is the test-side half of section 127's rule, as section 128's confinement of the cgroup changes is.

*The clock.* Sections 18 and 23 allow an engine timestamp to be "up to two seconds earlier than the `now`" of a clock advance, for a host whose wall clock steps back; that step was under a second when they were written and was measured at 2.93 s every 32 s on 2026-10-03. **No case compares with that allowance any more.** The one accepted case that did, `M15-lease-supervision.test.mjs` ("a role that sends no heartbeat for longer than lease_ttl keeps its lease …"), now reads "renewed since this step of the clock" as the lease row having moved on from the `renewed_at` it held before the step, which no step of the host's clock can confuse (a renewal after a step of a third of `lease_ttl` is later than any before it by that third less the host's step). `CLOCK_SLACK_MS` (`harness/runs.mjs`) is 4000 and its one use is `advanceClockInSteps`' bounded wait for a renewal, which asserts nothing. Every other comparison of an engine timestamp with a clock `now` in the suite crosses a margin of at least five seconds (a jump of `lease_ttl + 5`; a deadline passed by five seconds; a result accepted a whole `lease_ttl` and five seconds before the jump) or a window of a third of `lease_ttl`, and holds while the host's step stays under five seconds; `../COVERAGE.md` ("M2 slice 11", "The closing pass") lists each with what it pins. A jump meant to expire a lease is `lease_ttl + 5`, never `+ 1`: with a margin smaller than the host's step the lease may not have expired on the engine's own clock (M112 (b) had `+ 1`).

## What was run

See `../COVERAGE.md`, "M2 slice 11": each file alone with `node --test` after `npm run build`, on `main` at `47b2ef7` (the slice-10 engine, which has no launcher, no scope and no sandbox), never two at once.

---

# M2 slice 12: what the role sees and reaches

Sections 132 to 142 were written with the slice-12 acceptance tests (2026-10-03; `verify/m2-s12` from `main` at `2b4a566`): rows M119 to M128 of `docs/acceptance/sdlc-M2-acceptance-plan.md` §§3.4, 3.5, and the slice-12 half of M110 (section 123's split). They follow D2 §§1.2, 1.3, 2.3 to 2.8, 6 (H9, H10), 7.1, A.3, A.6, A.7, Appendix B (I01 to I17, A01 to A04), the errata E56 to E66, and fix what the plan's §2.6 leaves to the tests for these rows. Sections 122 to 131 stand; what this pass changes in them is in section 142.

## 132. What the slice-12 tests assume throughout

- **The lane** is section 122's: the scripted engine with `--harness-host-checks run`, the manager's two variables, the scripted backend inside the real sandbox and boundary, the scripted directory bound read-write (section 127). A case that needs a real backend's template uses the stand-in binary of section 116 under an `active` fixture entry for `claude` (row M125), which needs the host eligible (section 138).
- **The role's view is its `cwd` and request.** From this slice the role runs in `/surety/workspace` and the request's `workspace` (section 13) is `/surety/workspace`: the run's checkout is the overlay's lower layer and its host path is not in the view. A test that needs the host path reads `workspaces.path`.
- **Nothing the role prints is evidence by itself** (plan §2.4; AR B05). A probe entry says what the role attempted and what it got; the case corroborates from the host: the target read before and after, the test's own socket's connection count, the echo endpoint's log, the egress log, the process table, `count-objects` and `for-each-ref`, the cgroup files.
- **Every target is seeded and read from the host first.** A case whose target the host cannot read fails there, before the role probes it (AR §8.1). Credential locations are seeded under a disposable `HOME` the test engine is started with (`seedOperatorHome`), never under the user's own home; host sentinels (a `/dev/shm` file, an abstract socket, a pathname socket) have test-owned unique names and are removed by the test.
- **Probes that act are guarded** (section 141); probes that only read are not.
- **Network.** No case reaches beyond the host. Names are under `.example` and `.invalid`; answers are constructed by the harness resolver (section 140); an address that must pass the policy is a documentation address (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32), routed nowhere.

## 133. The validated mount plan, published

(D2 §2.3, A.6 P12; plan §2.6 "the mount plan published in the `qualification_evidence` record and its fingerprint on the run read"; rows M119 (a), (b), M122 (e); `harness/sandbox/view.mjs`, `mountPlanOf`, `assertMountTableIsPlan`.)

**When.** Before every launch the engine resolves and validates the plan (section 120) and, for a launch it does not refuse, publishes it before the launcher starts as one `qualification_evidence` record of the run (`records.run` the run, `records.project` its project, published). A refused launch has no plan record and the run read's `mount_plan` is null.

**The run read** (section 17) gains `mount_plan`: `{"profile": "role" | "probe", "fingerprint": <64 hex>, "record": "rec_<ULID>"}`, null before validation and for a refused launch.

**The record's bytes** are a JSON object `{"profile", "fingerprint", "entries": [...]}` with one entry per mount of the role's root, in mount order: `{"target": <absolute path in the role's root>, "kind": "root" | "bind" | "volatile" | "proc" | "devpts" | "shm" | "overlay" | "cgroup", "source": <absolute host path, the resolved one> | null, "options": [subset of "ro", "nosuid", "nodev", "noexec"]}`. `source` is set for `bind`, `cgroup` (the host's cgroup directory) and `overlay` (the lower layer, the run's checkout) and null otherwise. `volatile` is a bind from the domain's volatile filesystem (`/surety/home`, `/surety/out`, `/tmp`), `shm` the private `/dev/shm`, `root` the root tmpfs. Other keys may be added.

**The comparison** (P12; `assertMountTableIsPlan`): the role's `/proc/self/mountinfo` has exactly one mount per entry, at the entry's target, and no other; each of the kind's file system (`tmpfs` for `root`, `volatile`, `shm`; `proc`, `devpts`, `overlay`, `cgroup2`); read-only exactly where the plan says `ro` and carrying every flag it lists; for a `bind` or `cgroup` entry, what the role stats at the target has the same device and inode as the host's `stat` of the source (the very directory or file, no alias); no mount of `9p`, `drvfs`, `virtiofs`, `fuse*`, `cifs` or `nfs`, and nothing under `/mnt`; no source that is or holds the engine home, and none under it but this domain's own area (`domains/<domain id>`) and this run's own checkout. The scripted directory's read-write bind (section 127) is a `bind` entry like any other.

**The fingerprint** covers the entries with the domain's own paths taken out (the domain area, the volatile filesystem, the context package, the run's checkout): two runs of one project under one profile and one policy have one fingerprint (M119 (a)); a widening changes it (M119 (b)).

**What the plan holds** (D2 §2.3): `/usr`, `/bin`, `/lib`, `/lib64` read-only at their own paths (bound entry by entry around a host submount, which is left an empty directory and never mounted: M119 (d)); from `/etc`, only `passwd`, `group`, `nsswitch.conf`, `ld.so.cache`, `localtime`, `ssl/certs/ca-certificates.crt` (those the host has), and the engine-written `hosts` (loopback names only) and empty `resolv.conf`, and no directory of `/etc` but the CA bundle's; `/dev` with `null`, `zero`, `full`, `random`, `urandom`, a private `devpts` (with its `ptmx` link) and a private, initially empty `/dev/shm`; `/proc` private; `/surety` with exactly `context` (read-only), `workspace` (an overlay), `git`, `home`, `out`; `/tmp`; the backend's installation and the engine's `node`, read-only; a project's approved `sandbox_read_paths`, read-only at their real paths (a link in the policy is bound at what it resolves to and nothing is mounted at the link's own path); and in the probe profile the two cgroup directories of section 127.

## 134. The forbidden set in the sandbox lane

(D2 §2.3, E58 item 3, A.7; rows M119 (b), (c), (e), (g), M120, M122 (a); section 120's reasons.)

Section 120's validation stands; the sandbox lane observes it through the real sandbox. Two additions:

- **A repository with alternates** (`objects/info/alternates` of its git directory, present when the launch is validated) refuses every launch of its project's work: `mount_plan_refused`, `refusal.subject` `{"path": <the repository's path as registered>, "reason": "alternates"}`, the eighth reason. The validation is before every launch, so an alternates file added after the project was registered refuses the next launch.
- **The credential locations** are those section 120 lists, under the engine process's `HOME`. A case seeds every one under a disposable `HOME` and requires each absent from the role's view by its host path, by `/proc/self/root<path>`, by `/surety/workspace/../..<path>` and `/proc/self/cwd/../..<path>` (`aliasesOf`), and each refused as a widening with the reason `credential_location`.

What the role cannot see by construction (D2 §2.3) is pinned by M120 against seeded targets: the engine home's files (`api.token`, `store.db`, `engine.log`, a record file, a sentinel beside the store, another domain's area), another run's retained workspace, the developer's checkouts, the engine home's path itself, `SURETY_HOME` in the environment.

## 135. The git metadata view

(D2 §2.3, §2.7, A.6 P4, P5; Q4; E37 item 5; row M121.)

**The workspace's `.git`** inside the view is a file whose content is exactly `gitdir: /surety/git` (and a line ending); it names no host path. **`/surety/git`** holds `config` (engine-written), `HEAD`, an `index` of the run's own, and the repository's `objects` and `refs`, bound read-only. It holds no `config.worktree`, no `info/`, no `worktrees/`, no `modules/`, no credentials file, and a `hooks` directory, if any, empty. `git rev-parse --git-path config` and `--git-path hooks`, run in `/surety/workspace`, resolve under `/surety/git`.

**The configuration** is `core.*` settings only, every one shown by `git config --list --show-origin` with origin `file:/surety/git/config`, and none of `core.hookspath`, `core.fsmonitor`, `core.sshcommand`, `core.gitproxy`, `core.askpass`, `core.editor`, `core.pager`, `core.alternaterefscommand`, `core.attributesfile`, `core.excludesfile`, `core.worktree`; no `include`, no helper, nothing of the repository's own configuration. The role runs git with `GIT_CONFIG_NOSYSTEM=1` and `HOME` its workspace (section 26's git step), so no global or system file is read.

**What fails**: `git config <key> <value>`; a write at the path git resolves for `config` (an append) and a file created at the path it resolves for `hooks` (the guarded `git_path_probe`, section 141); `git commit` (with an identity given on the command line, so it does not fail for want of one) and `git update-ref`. **What works**: `status`, `diff`, `log`, `cat-file`, and `add`, which writes the run's own index (not the checkout's: its host-side hash is unchanged). Host-side, after the role's git steps and with its domain alive: the repository's real `config` and hooks directory byte-identical, `git count-objects -v` and `git for-each-ref` unchanged, the role's ref absent.

**Materialization** (M121 (e)): a role's edit is in its overlay only; while the role lives the checkout is as the engine made it (host-read `git status` empty); after termination the screened upper layer reaches the checkout and the snapshot commits it as section 28 says; `domain.terminated` precedes the `git.journal_intended` of the run's `commit_tree` operation in event sequence. The secret screen itself is row M132's (slice 13): this slice pins the order and the commit, not the screen.

## 136. Host sockets, the user bus, Docker, WSL interop and host mounts

(D2 §2.3, §2.4, §6 H10, A.6 P9 to P12, P17; Q3; E59 item 4; row M122.)

- **P9.** The test listens on an abstract socket of a unique name and on a pathname socket in a directory of its own, and connects to each once from the host (the control: each counts one connection). The role's connection to the abstract name fails (another network namespace); it connects to an abstract socket it creates itself (the role's control); the test's socket still counts one. The directory holding the pathname socket, approved as a widening, refuses the launch `special_file`.
- **P10.** Verified by `stat` from the host, never connected to: `/run/user/<uid>/bus`, every Docker socket present (`/var/run/docker.sock`, `/run/docker.sock`; absent: that part `[not_exercised]` with the reason), `/run/WSL` and each entry in it on WSL2, and a test-owned sentinel file in the host's `/dev/shm`. Each is `ENOENT` inside (by `lstat`, so a link inside counts as present). The role's `/dev/shm` holds nothing; it writes and reads back a file there (control), which the host's `/dev/shm` does not then hold.
- **P17.** The host control runs `systemd-run --user --quiet --wait --collect --unit=surety-test-p17-<hex> true` once: it succeeds and the unit is collected. Inside, the same command (with the manager's variables in its environment) fails, and the manager knows no unit of the role's name afterwards.
- **P11** (WSL2 only; E59 item 4). The engine's named Windows executable is `/mnt/c/Windows/System32/cmd.exe`, verified present by `stat`. The host control is the one execution on the Windows side: `cmd.exe /c echo <marker>`, which prints the marker. Inside, the same argument array fails to execute, prints no marker, and `/init`, `/run/WSL`, `/mnt/c` and the executable are `ENOENT`. Off WSL2 the case asserts the host fact and is `[not_exercised]`.
- **P12** is section 133's comparison under the `probe` profile, whose plan carries `/surety/cgroup/domain` and `/surety/cgroup/sibling` as `cgroup` entries.

## 137. The protected set in the sandbox

(D2 §2.3, A.6 P19; D1 §7.3; section 66; row M123.)

For every role but the Verifier, each protected root of the effective version (the governed file's `protected_paths`, section 66) is, inside `/surety/workspace`, a read-only tree at that version's content: a write, a truncation, a rename away, a rename over (from a file the role made), a hard link, a write through a symbolic link the role made, a mode change and an unlink of a protected file, and a file or directory created in, a mode change and a rename away of a protected directory, are each refused to the role with `EROFS`, `EACCES`, `EPERM`, `EXDEV` or `EBUSY` (`protected_ops`, a guarded probe whose paths are workspace-relative and never leave the workspace). The role still reads every protected file as the version has it. After the run the checkout holds no change under a root (`git status --porcelain -- <roots>` empty, each file as the base has it, nothing created) and the role's permitted edit is committed (Builder: `engine_commit`; Architect: `intent`). For the Verifier the protected set is writable in its overlay and a protected-only diff becomes a proposal only (row M36's shape: `proposed_by` `verifier_run`, `captured`, no ordinary commit, the effective version unchanged). After a protected application, the next run's protected tree is the new effective version's.

## 138. The probe suite, H9 and H10

(D2 §2.8, §6 H9, H10, §7.1, A.3, A.6; plan §2.6 "the shape of the probe results inside `qualification_evidence`", "which probes a host class excuses"; plan §2.3 "Harness overrides"; rows M110 (a), (d), (e), M124.)

**When and where.** The engine runs the suite in the `host_qualification` step (section 123), in a `probe`-profile domain of its own scope, with the engine's own seeded targets: it seeds each target on the host side, reads it back, runs the role-side attempts through its probe program in the sandbox, and corroborates from the host, as this file's sections 133 to 137 and 140 describe for the tests. Its results are the row's `probes` and the evidence record's detail.

**A probe's result in the row** (`host_qualifications.probes`, and `GET /v1/engine` `host_qualification.probes`, both in order P1 to P20): `{"id", "target_seeded": bool, "negative": "denied" | "allowed" | "not_attempted" | null, "control": true | false | null, "result": "passed" | "failed" | "not_exercised", "reason": string | null}`. `null` where the probe did not run. **Passed** only when `target_seeded` is true, `negative` is `denied` and `control` is true. **Failed** when the target was not seeded or verified (`target_seeded` false), the control failed (`control` false), the negative was allowed (`allowed`), or the negative was never attempted (`not_attempted`) whatever else succeeded. **Not exercised** when the probe could not run; `reason` says why. The evidence record (the row's `evidence`, a `qualification_evidence` record) holds `probes`, one object per probe in the same order with at least the row's keys and the detail of each target, attempt and control.

**H9** is `passed` when every probe is passed or excused; `failed` when any probe failed; otherwise `not_exercised`. Its `observed` names every probe that is not passed. **H10** (WSL2 only) is `passed` when P11 and P12 passed. Either not passed blocks eligibility (section 123), so no row is active and a real dispatch is refused `isolation_unqualified` naming `H9` in `failed_checks` or `not_exercised_checks`.

**Excused by the host class** (a probe `not_exercised` for one of these reasons does not block H9): P11 on a host that is not WSL2; the Docker part of P10 when the host has no Docker socket (P10 runs its other targets and passes on them); **P20 on a host not designated for exhaustion probes** *(amended in M2 slice 13 for E69 items 3 and 4; it replaces slice 12's "P20 in slice 12 only")*: the closed engine key **`isolation_probe_exhaustion`** (boolean, default `false`; `../contract/config.json`) designates the host. While it is false, P20 does not run: it is reported `not_exercised` with a `reason` that names `isolation_probe_exhaustion`, no box is made and no exhaustion action is sent, and that excuse does not block H9; what P20 would establish is listed as not claimed (`docs/acceptance/reports/M2-not-claimed.md`). This workstation leaves it false (E69 item 3); `mini-hp01` sets it true for the exhaustion lane (E69 items 2, 4). **With it true**, P20 runs each limit alone in a `probe`-profile box of its own, with `pids.max` 64 and `memory.max` 64 MiB (and the box's volatile filesystem at most 4 MiB and 256 inodes), each read back from the host before the program is released (E64 item 2's test-side half, the engine's); the probe program refuses to run if the limits it reads are above those, and stops by itself at 96 `sleep` forks or 128 MiB allocated whatever the cgroup does (E69 item 1), so that a box whose limit failed to apply does not take the host with it. The cases that pin P20's results are part 3's, on the exhaustion host. Nothing else is excused: on a WSL2 host P11 not exercised blocks.

**The harness overrides** (`--harness-isolation-probe <Pn>=<how>`, repeatable, accepted only with `--harness`; under `unrun` ignored): `target_absent`: the engine does not seed that probe's target (or removes it before the attempt), so its host-side verification fails and the probe is `failed` with `target_seeded` false; `control_failing`: the probe's control is made to fail, `failed` with `control` false; `negative_unattempted`: the negative is skipped while the other probes and this one's control run, `failed` with `negative` `not_attempted`; `cannot_run`: the probe is not run, `not_exercised` with a reason. The flag is a seam hook (section 7's confinement): outside harness mode there is none. (`--harness-probe` of section 1 is the journal's and is unchanged.)

**The engine's own destructive probes** (P13's kill storm, P16's daemon; E64 item 2): the engine's probe program refuses P13 unless it is in a pid namespace other than the engine's and sees at most 16 processes with pid 1 not a system's init, and the engine releases it only after it has read from the host side that the probe domain's process is in that domain's cgroup with an inner pid and another pid namespace. The tests cannot see the engine's half from outside; the slice's Reviewer checks both halves by reading and by running, as E64 item 2 requires.

**What a passing start shows** (M110's slice-12 file, extended): H1 to H12 passed (H10 only on WSL2), one active row, every probe P1 to P19 passed with `target_seeded` true, `negative` `denied`, `control` true (P11 off WSL2 `not_exercised`), P20 passed, or `not_exercised` with the designation excuse while `isolation_probe_exhaustion` is false, and the evidence record's `probes` in order.

## 139. What is handed over

(D2 §1.2, §1.3, §2.5; D1 §17 items 3, 4; E5; plan §2.3 "the stand-in binary"; row M125; `harness/standin/backend.mjs`, `harness/trust.mjs`.)

**The argument array** of a real backend is the adapter's template rendered (D2 §4.5): the binary the entry names is `argv[0]` (the stand-in's `cmdline[1]`, after its interpreter), every other argument is template text, the model, the session id, or the fixed prompt; no argument holds task content, and every path in an argument is under `/surety/`; the last argument, the prompt, does not begin with `-`. The backend's parent is process 1 of the sandbox, the domain init, never a shell.

**The environment** of a real backend holds, by name, exactly a subset of `PATH`, `HOME`, `HTTPS_PROXY`, `SURETY_DOMAIN`, `SURETY_INVOCATION`, the template's key variable (`ANTHROPIC_API_KEY` for `claude` in the `api_key` mode, `CLAUDE_CODE_OAUTH_TOKEN` in the `subscription_token` mode: E74 item 1), *(objection 016, E75 item 1)* the three updater and telemetry switches every `claude` template sets (E74 item 3), each with the value the tests expect: `DISABLE_AUTOUPDATER` `1` (Claude Code's documentation, Advanced setup, "Disable auto-updates": "Set `DISABLE_AUTOUPDATER` to `\"1\"`"), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` `1` (Environment variables: "Set to any non-empty value, such as `1`"), `DISABLE_UPDATES` `1` (named on the Advanced setup page, "To block all update paths ... set `DISABLE_UPDATES`", without a value; `1` by its sibling's convention, a question for Sean in the answer to 016), `LANG`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `CLAUDE_CONFIG_DIR`, of which the first six and, for `claude`, the three switches are required; `HOME` is `/surety/home`; the key variable's value is the grant's secret; nothing else, so no variable of the engine's own environment (the parent-only sentinels a case gives the engine, among them `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN` as an operator's shell may hold them) reaches it. Read from the host's `/proc/<pid>/environ`, every other process of the domain (the init, a forwarder) holds neither the secret nor a parent-only sentinel; an environment the host cannot read fails the case.

**The context package** at `/surety/context`, read-only, holds `prompt.md` (the role prompt; for a stage's work it carries the stage's goal verbatim, which is where task text is), and `manifest.json`: `{"work_item", "run", "role", "kind", "files": [{"path", "kind", "source", "sha256"?}]}`, where `path` is relative to the package, `kind` one of `prompt`, `instructions`, `result_schema`, `requirement`, `adr`, `constraint`, `phase_plan`, `interface`, `diff`, `acceptance_content_hash`, `prior_run`, and `source` the id of what the file was made from (a requirement's id, a record's id) or null. The package holds exactly the files its manifest lists, besides the manifest. A stage's work lists one `requirement` per requirement it binds, its `source` the requirement's id. A resumed run lists at least one `prior_run` file whose `source` is a record of the run it resumes (section 17's `parent_run`): rebuilt from records, never from the prior package. No file and no manifest entry holds or names a `raw_user_report` record.

**The approved texts** *(amended in M2 slice 13 for E67 item 7, Sean's decision of 2026-10-03: "the package carries the approved texts")*. A bound item is in the package as its **approved text**, not as a key or a reference to one: a role inside the sandbox has no other way to read it. So a `requirement` file holds that requirement's approved text, an `adr` file an ADR's, a `constraint` file a constraint's, the `phase_plan` file the approved phase plan's, and an `interface` file a dependency module's interface; each holds the text verbatim (a heading, the key or other lines beside it are the engine's choice), and its manifest entry's `sha256`, where given, is the file's. **What a work item binds** (F §3.10.8: "the relevant approved requirements, ADRs, project-wide constraints, the current phase plan, and the interfaces of dependency modules"): for a stage's work, every requirement the stage implements and no other, every ADR the stage cites and no other, and every constraint of the project's approved baseline (constraints are project-wide). A requirement the stage does not implement and an ADR it does not cite are not in the package. **The plan fixture** (section 15's table and its slice-5 extension) takes, beside what it took: a requirement as `{"key", "text"}` (`text` optional; without it, what the requirement's file holds is the engine's), `"adrs": [{"key", "text"}]` and `"constraints": [{"key", "text"}]` (both optional, both part of the approved baseline the fixture installs), and per stage `"adrs": [<adr key>]`, the ADRs the stage cites; the answer adds `"adrs": [{"key", "source"}]` and `"constraints": [{"key", "source"}]` (each `[]` when none was sent), `source` the non-empty string the engine names that item by and puts in the manifest entry's `source` (an id or a path in the approved revision: the engine's choice). M125 (c) pins requirements, ADRs and constraints, each with an unbound one beside it where binding is selective; the phase plan's and the interfaces' texts follow the same rule and no case pins them yet (the fixture binds no dependency module).

**The trigger fixture** (section 15) takes an optional `raw_user_report` (a string): the engine publishes it as a `raw_user_report` record of the project, bound to the work item, and the answer adds `"raw_user_report": "rec_<ULID>"`. It is the target M125 (c) seeds.

**The stand-in in the sandbox lane.** `new StandIn(dir, {logDir})` writes its log, and looks for its hold, in `logDir` (the scripted directory, bound read-write) rather than its own directory, which inside the sandbox is the backend's read-only installation; `logDir` is written into the file's first line, so the entry's SHA-256 covers it. Each launch also records `cmdline`, `env_hashes` (by name), `ppid`, the parent's `comm` and `cmdline`, and `context` (every file of `/surety/context` with its size and hash, and its text where small). `hold()`/`release()`: while `standin-hold` exists in `logDir` the stand-in waits after recording until `standin-release` exists (at most two minutes), so the host can read the domain while it lives.

**A binary that is not the entry's** is refused before any launcher starts as section 116 says (`backend_refused`), with `refusal.subject` holding `expected_sha256` and `found_sha256`; the host's eligibility is checked first, so on an ineligible host the code is `isolation_unqualified`.

## 140. The egress proxy, the harness resolver, the echo endpoint, the egress log

(D2 §2.4, §3.7, A.6 P6 to P8, A.7; plan §2.3 "A harness resolver", "The echo endpoint", §2.6 "the shape of the `egress_log`", "the proxy limits' test values", "which per-tunnel proxy limits only refuse the tunnel and which bounds cancel the run"; rows M126 to M128; `harness/sandbox/egress.mjs`.)

**The proxy as a role reaches it.** `HTTPS_PROXY` names `http://127.0.0.1:<port>` (or `[::1]`), the forwarder in the role's network namespace; a TCP connection to it succeeds (the role's control in M126 (a)). A request is `CONNECT <host>:<port> HTTP/1.1`; the answer's status line is `HTTP/1.1 <status>`: **200** opens a tunnel; **403** is a refusal by the list, the port or the address policy; any other non-200 (or the connection's end with no answer) is a refusal by a limit or a failed connection. The allow list for a scripted run is the project's `egress_allow_extra`, plus in the `probe` profile the echo authority; for a real backend the entry's (or attempt's) `egress_hosts` plus `egress_allow_extra`. Only port 443. An IP-literal authority (`127.0.0.1:<port>`, `[::1]:<port>`, a host address) is never listed, and fails the address policy too.

**The address policy.** One resolution per attempt, within `egress_resolve_timeout`; the whole answer is refused if any address is loopback, private (RFC 1918, `fc00::/7`), link-local, unspecified, multicast, an IPv4-mapped form of those, or an address of the host's own interfaces; otherwise the proxy connects to one address of that answer, numerically, within `egress_connect_timeout`, never resolving again; a second CONNECT is a second attempt and a second resolution.

**The harness resolver** (harness mode only; the proxy consults it instead of the system's resolver, which is never consulted in harness mode). `POST /v1/harness/resolver` with `{"names": {<name>: {"answers": [[<address>, ...], ...], "delay_ms"?: <n>}}}` replaces the map and resets the counters, **2xx**; the n-th resolution of a name gets `answers[n-1]`, the last one repeating; `delay_ms` delays every answer. A name not in the map does not resolve (the attempt is refused, reason `resolve_failed`). `GET /v1/harness/resolver` → **200** `{"names": {<name>: {"queries": <n>}}}`, counting resolutions since the last `POST`.

**The echo endpoint** (`probe` profile only; D2 §2.4, §7.1). Authority `echo.surety.invalid:443`: the proxy does not resolve it and connects to the engine's own echo listener, which writes back every byte it receives. Under the `role` profile it is not listed: **403**. `GET /v1/harness/echo` → **200** `{"connections": [{"domain", "opened_at", "closed_at", "bytes_in", "sha256_in", "bytes_out"}]}`, one per tunnel, `sha256_in` over the bytes received. `POST /v1/trust/qualify` refuses a `candidate_egress` that names `echo.surety.invalid` with **400** `invalid_value`, `subject.field` `candidate_egress` (the route's body otherwise is row M135's).

**`domain.egress_refused`** (D2 A.5): one event per refused attempt, `subject` `{domain, run}`, `payload` `{authority, reason}`.

**The `egress_log` record** (D2 A.2): one per domain, `kind` `egress_log`, `run` the run, the project's, published once the domain is terminated (a domain that made no connection has an empty record). Its bytes are JSON lines, one per CONNECT in the order received: `{"authority", "decision": "accepted" | "refused", "reason": null | "not_listed" | "port" | "address_policy" | "resolve_failed" | "resolve_timeout" | "tunnels_max" | "bad_request" | "header_timeout", "resolved": [<addresses of the one answer>], "address": <the address connected to> | null, "opened_at", "closed_at", "bytes_up", "bytes_down", "ended": "refused" | "closed" | "resolve_timeout" | "connect_timeout" | "connect_failed" | "tunnel_max_seconds" | "buffer_max" | "run_ended", "limit": null | {"key": <the configuration key>, "value": <its value>}}`. `decision` is `refused` when no connection was attempted (with `reason`), `accepted` when the proxy attempted the connection; `ended` says how the tunnel or attempt ended, and `limit` names the limit when one ended it. A record cut at `egress_log_max_bytes` ends with one marker line `{"truncated": true, "limit": "egress_log_max_bytes", "value": <bytes>}`, and the record's whole size is at most the bound plus that line.

**The limits** (D2 A.7) and what reaching each does. The tests set each to the smallest value its range allows (`PROXY_LIMITS`: `egress_resolve_timeout` 1, `egress_connect_timeout` 1, `egress_tunnel_max_seconds` 60, `egress_tunnels_max` 2, `egress_buffer_max_bytes` 65 536, `egress_log_max_bytes` 262 144). **Per-tunnel limits end the tunnel, never the run**: a resolution past `egress_resolve_timeout` (refused, `resolve_timeout`; the proxy answers at the limit, before a slower answer arrives); a connection not established within `egress_connect_timeout` (`accepted`, `ended` `connect_timeout`); a tunnel open for `egress_tunnel_max_seconds` (closed, `tunnel_max_seconds`, however busy); a CONNECT while `egress_tunnels_max` tunnels of the domain are open, a connection still waiting for its request counted from its accept (refused, `tunnels_max`); a connection that sends no complete request head within `egress_connect_timeout` (refused **408**, `header_timeout`, `authority` `(no CONNECT)`, `limit` `{"key": "egress_connect_timeout", "value": <seconds>}`); a request that is not a well-formed `CONNECT` (refused **400**, or **405** for another method, `bad_request`, `limit` null); more than `egress_buffer_max_bytes` held for a reader that does not read (closed, `buffer_max`); each records its `limit` and the run goes on as the role earns. **`egress_log_max_bytes` is a bound on evidence** (D2 §3.7): reaching it truncates the record as above and cancels the run through section 126's sequence: the run ends `failed` / `infra_error` with `reason_text` naming `egress_log_max_bytes`, the exit class `engine_signaled`; it is never `completed`.

## 141. The guard of the acting probes

(E64 item 2; section 127's guard of `signal_all`; the Verifier's brief, rule 1; `harness/scripted/child.mjs`, `containmentRefusal`; `harness/scripted.mjs`, `acting`; `harness/sandbox/view.mjs`, `armedRole`, `assertContained`.)

Every probe action of this slice that writes outside the role's own files, connects, or executes a program (`write_probe`, `git_path_probe`, `protected_ops`, `shm_roundtrip`, `unix_connect`, `tcp_connect`, `http_request`, `proxy_connect`, `proxy_flood`, `proxy_concurrent`, `exec_probe`) fails closed in two independent halves.

- **The instrument's half.** The role program runs the action only if its step carries `host_ns`, the host's pid, network and mount namespaces as the test read its own (`readlink /proc/self/ns/{pid,net,mnt}`), and the role's own three are each a different one; pid 1 as the role sees it is not a system's init (`systemd`, `init`, `launchd`); and the role sees at most 16 processes. Any read that fails is a refusal; a refusal logs `outcome` `refused_unsandboxed` with `guard.reasons` and does nothing else. `step.probe` refuses to script these actions; only `acting(hostNamespaces())` scripts them.
- **The test's half.** `armedRole` dispatches the role with its reading probes first, then a hold (`armed`); while it holds, the test reads from the host (`assertContained`) that the role's process is a member of its domain's cgroup, has a pid in an inner pid namespace (`NSpid` of two or more), and is in a pid, a network and a mount namespace other than the test's; only then does it release the role into the acting probes. A role that cannot be found in a domain cgroup, or whose namespaces cannot be read, is never released.

**Verified without an engine** (2026-10-03, this pass): on the host, each acting action refused (`refused_unsandboxed`: no namespaces named; or the host's own; pid 1 `systemd`; 71 processes visible) and wrote nothing; inside a throwaway `unshare -Urpfmn --mount-proc`, told the real host's namespaces, `write_probe` wrote, `unix_connect` to its own socket connected, `tcp_connect` to 127.0.0.1 failed `ENETUNREACH`, `proxy_connect` found no proxy; told nothing, it refused.

**What the actions may touch even when released**: `write_probe` only paths a case names (the role's own `/dev/shm`, `/surety/context`, a widening's directory, the view's git paths); `protected_ops` only workspace-relative paths, never `..`; the connections only the test's own sockets, loopback, the host's addresses at the engine's port and the test's listener, and the role's proxy; `exec_probe` only `systemd-run --user … true` with a test-named unit and, on WSL2, `cmd.exe /c echo <marker>`.

## 142. Names the Verifier fixed in this pass, and what it changes in earlier sections

**What this pass changes in earlier sections.**

- Section 13's request: in the sandbox lane `workspace` is `/surety/workspace` and the role's `cwd` is the same (section 132). The kernel lane is unchanged.
- Section 15's trigger fixture takes `raw_user_report` (section 139).
- Section 17's run read gains `mount_plan` (section 133).
- Section 120's reasons gain `alternates` (section 134).
- Section 123: from slice 12 a sandbox-lane start on this host passes H9 and H10; the host section gains `probes` (section 138). `M110-host-checks-and-scope.test.mjs` case (a), listed under manifest slice 11, now expects H9 and H10 `passed`, the host eligible and one active row, as `../COVERAGE.md` "M2 slice 11" permitted in advance ("The M110 split"); its (b), (c), (f) are unchanged. **Consequence:** `--slice 11` on `main` fails at that case until slice 12 is built.
- Section 127's probe actions: the reading actions `open_paths`, `list_dirs`, `stat_paths`, `mount_table`, `context_dump`, `handover`, and the guarded actions of section 141.
- Section 1's flags: `--harness-isolation-probe` (section 138). Harness routes: `POST`/`GET /v1/harness/resolver`, `GET /v1/harness/echo` (section 140).

**Names the Verifier fixed.** Each was open in the sources (plan §2.6, or D2 in words). The Builder may object. Those marked † carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| Where the plan is published | A `qualification_evidence` record of the run; `mount_plan {profile, fingerprint, record}` on the run read (section 133) | The plan's words; D2 A.2 has no kind of its own for it. |
| The plan record's entries | `{target, kind, source, options}`, eight kinds, four flags (section 133) | The fewest fields that let a test compare a mount table entry by entry and tell an alias by device and inode. |
| The fingerprint's scope | The plan without the domain's own paths (section 133) | D2 §2.3 puts it in the profile qualified; a fingerprint that changed per run could not be compared with an entry's. |
| A repository with alternates | `mount_plan_refused`, reason `alternates`, path the registered repository (section 134) | E58 item 3 names the code; no reason of section 120 fits. |
| The git view's shape | `.git` = `gitdir: /surety/git`; `config`, `HEAD`, `index`, `objects`, `refs` (section 135) | D2 §2.3 in words. |
| The forbidden `core.*` keys | Eleven keys (section 135) | Those that name a program, a hooks path or a file for git to read. |
| P11's executable | `/mnt/c/Windows/System32/cmd.exe /c echo <marker>` (section 136) | E59 item 4. |
| A probe's row shape | `{id, target_seeded, negative, control, result, reason}`; `negative` four values (section 138) | D2 A.3 names the fields; the plan's M124 (b), (c) read `control` false and a negative "never attempted". |
| H9 from the probes | `failed` on any failure, else `not_exercised` on any unexcused one, else `passed` (section 138) | D2 §2.8: an unexercised probe is never a pass. |
| The excused probes † | P11 off WSL2, P10's Docker part without Docker, **P20 in slice 12 only** (section 138) *(amended in slice 13: P20 on a host whose `isolation_probe_exhaustion` is false, E69)* | The plan names the first two; the build spec gives P20 to slice 13 while H9 must pass in slice 12. |
| The probe overrides | `--harness-isolation-probe <Pn>=target_absent\|control_failing\|negative_unattempted\|cannot_run` (section 138) | The plan's M124 (a) to (d). `--harness-probe` is taken by the journal. |
| The backend's environment † | Required six, allowed seven more, by name (section 139) | D2 §1.2 lists them in words; `LANG`, `TMPDIR` and `CLAUDE_CONFIG_DIR` are allowed so an adapter may set its own home and locale. |
| The context manifest † | `manifest.json` with `{path, kind, source}` per file; eleven kinds (section 139) | "Exactly what the work item binds" cannot be checked without a list; D2 §1.3's items, named. |
| A raw report on a trigger | The trigger fixture's `raw_user_report` (section 139) | The plan's M125 (c) seeds one; no fixture made one. |
| The stand-in's log in the sandbox | `logDir` written into the binary; a hold file (section 139) | The binary's directory is read-only inside; the host must read the domain while the backend lives. |
| The harness resolver | `POST`/`GET /v1/harness/resolver`, answers per resolution, `delay_ms`, query counts (section 140) | The plan §2.3 in words. |
| The echo endpoint | Authority `echo.surety.invalid:443`, not resolved; `GET /v1/harness/echo` (section 140) | `.invalid` is reserved; an address would fail the policy that the echo is the one exception to. |
| The proxy's answers | 200 tunnel, 403 policy, any other non-200 or the end for a limit (section 140) | D2 §2.4 names 403; a limit is not a policy refusal. |
| The `egress_log` record | JSON lines, the fields of section 140, a truncation marker | D2 §2.4's "destination, resolved address, byte counts and times", with the decision and the limit the plan's M128 asks the log to record. |
| `domain.egress_refused`'s payload | `{authority, reason}` (section 140) | A.5 names the type and no payload. |
| Which limits cancel the run † | Per-tunnel limits end the tunnel; `egress_log_max_bytes` cancels the run `failed` / `infra_error`, `engine_signaled` (section 140) | The plan leaves it to the seam; D2 §3.7 makes reaching a supervisor bound on evidence a cancellation. |
| The proxy limits' test values | The smallest of each A.7 range (section 140) | Fast cases; a tunnel lifetime of 60 s is the range's floor. |
| The guard of the acting probes | Section 141 | E64 item 2. |

## Amended after the slice-12 objections (006 to 010; 2026-10-03)

On `verify/m2-s12-obj` from `main` at `3054c58`. Five objections of the slice-12 Builder; each answer is in `docs/acceptance/objections/`.

- **006, upheld.** "No observer evidence" (M112 (g), M116 (d)) means no `qualification_evidence` record that is, or holds under `observer`, an object with D2 A.3's `collector_version` (`observerEnvelopes` in `lane.mjs`). From slice 12 a qualified host (section 138) and every validated plan (section 133) write records of that kind that are not envelopes. A record whose bytes cannot be read fails the case.
- **007, upheld.** Section 133's comparison of a mount table with the plan is made **while the domain lives**: the role holds after its probes, the table is compared, the run is stopped (M122 (e); M119 (a), (b) with it). At termination the engine removes the domain's cgroup directory and sibling (sections 126, 127). Whether the domain's area outlives termination is the engine's choice and is not pinned.
- **008, upheld in part.** Section 139's host read of every domain member's environment: where `/proc/<pid>/environ` refuses the host by its mode (`EACCES`; the domain init, non-dumpable so that M117 (b) holds), the initial environment block is read from the process's memory. That read uses `env_start` and `env_end` of `/proc/<pid>/stat` and `process_vm_readv(2)` (`environFromMemory` in `procs.mjs`, through the host's `python3`). The host can, as the owner of the sandbox's user namespaces; the role, without capability there, cannot. Where both reads are possible they must agree. A block read by neither fails the case. "Refused with `EACCES` and in another user namespace" alone is not accepted.
- **009, upheld, and the same helper's second fault.** `armedRole` scripts the item's **next** launch (a resumed item's second, say), waits for it, requires its `launch_index`, and finds the run by the launch's own `run`.
- **010, upheld in part.** M117 (c)'s P14 control is a workspace write by a Builder (`fix`), committed and read on the integration branch from the host. From slice 12 a Verifier's non-protected write is a `diff_violation` (sections 28, 135); moving the write to `/tmp` would no longer be "the role writes its workspace" (D2 A.6 P14).

## Amended after the slice-12 review (S1, S2; 2026-10-03)

On `verify/m2-s12-review` from `main` at `cb67b92`. One case for each serious finding of the slice's review (E31), and two corrections of this Verifier's own fixtures.

- **S1: the screen covers paths** (D2 §2.5; section 135, "Materialization"; `M121-git-view.test.mjs`, case S1). The upper layer is screened for every registered secret before it is materialized, and what is screened includes **every path** the materialization would create, as well as every file's content and every link's target. A held secret, in raw or escaped form, in a file's name or in a directory's name, refuses that materialization exactly as the same secret in a file's content does. Nothing of it reaches the checkout, no ref moves, and no commit of any ref names the secret. The run ends as the content-hit run ends (today `failed` / `infra_error`; row M132, slice 13, fixes the outcome, the finding and `evidence.secret_refused` for both). The case runs the content control first on the same engine and requires the path cases to end the same way.
- **S2: P2's evidence names what it counts** (D2 A.6 P2, §2.8; section 138; `M124-probe-needs-target-and-control.test.mjs`, case S2). Section 138's "the detail of each target, attempt and control" is sharpened for P2.
  - The evidence record's P2 object carries `targets`: `[{"kind", "path", "host_verified": bool, "attempts": [{"path", "outcome", "error"}]}]`, one per target the verdict counts. `kind` is one of `store`, `engine_lock`, `engine_log`, `record`, `other_domain`. `attempts` holds the role's own opens of that target (its host path and its aliases).
  - P2 passes only if every counted target was seeded and verified from the host, and was attempted by the role with each attempt `failed` `ENOENT` or `ENOTDIR`.
  - An attempt that opened the target is `{"path", "outcome": "opened", "error": null}`; a refused one `{"path", "outcome": "failed", "error": <the code>}`. *(Checked against the merged engine in the closing pass: these are the names it writes.)*
  - On a fresh home the engine seeds what is not there yet: the engine log at its real path, a record under `records/`, a sentinel in another domain's area under `domains/`. A target pushed after the role's instructions were fixed is never counted.
- **Sockets at a path that is theirs.** A pathname socket a case seeds lives in a short directory of the test's own under `/tmp` (`shortSocketDir`). Each is checked bound at exactly its path (`listenUnix`): a path past 107 bytes (`sun_path`) is bound truncated, silently, so under a long `TMPDIR` the "verified listening" check could pass against another path. This applies to M119 (c) and M122 (a); assertions are unchanged.

## Closing pass of slice 12 (2026-10-03)

On `verify/m2-s12-close` from `main` at `dc9c4f4`. Two seam changes, both read from the merged engine (`src/invoke/proxy/proxy.ts`, `src/invoke/probes/suite.ts`), neither changing a case:

- Section 140's reasons gain **`header_timeout`** (**408**; the limit `egress_connect_timeout`) and **`bad_request`** (**400** or **405**). Both come from the review's hardening (E67 item 4): a connection waiting for its request is counted against `egress_tunnels_max` from its accept, and one that never completes its request head is refused at `egress_connect_timeout` and logged. No case exercises either.
- Section 138's per-target P2 evidence (after the review, S2) was checked against what the engine writes: `targets[] {kind, path, host_verified, attempts[] {path, outcome, error}}`, with the five kinds as stated. An attempt that opened its target reads `opened` with `error` null.

---

# M2 slice 13 (part 1): the result, its collection and the exit classes

Sections 143 to 147 were written with the first part of the slice-13 acceptance tests (2026-10-03; `verify/m2-s13` from `main` at `6641172`, rebased onto `3a9d87e`): rows M129 and M130 of `docs/acceptance/sdlc-M2-acceptance-plan.md` §3.6 (M130 without (f) and (g)), and Sean's decision E67 item 7 on the context package (section 139, amended in place). They follow D2 §§1.3, 1.4, 1.6, 1.7, 3.2, 3.4, A.2 to A.7 (P18), Appendix B (A05 to A10, A12, B04, N02) and the errata E64 to E69. Parts 2 and 3 of the slice (rows M131 to M135; the exhaustion cases M130 (f), (g), P20 and M133 on the exhaustion host, E69) add their own sections. Sections 122 to 142 stand; what this pass changes in them is in section 147.

## 143. The result in the sandbox lane: the file, the event, the collection

(D2 §1.4, §1.6, §3.2, §3.4, K4, A.2, A.6 P18, A.7; AR A05, A06, B08; E27 item 7; E65 item 7; rows M129, M130; `harness/scripted/child.mjs`, `harness/sandbox/result.mjs`.)

**The scripted role's result is a file.** In the sandbox lane the role writes its structured result to **`/surety/out/result.json`** on the domain's volatile filesystem (D2 §1.4), and its standard-output `{"type": "result", "result": …}` line (section 13) is the scripted backend's **terminal success event**: what a real backend's stream says when it ends well (Claude Code's final `result` line). The engine takes the result from the file, never from the line. `step.result(value)` writes the file and then sends the line; **`step.resultFile(value)`** writes the file and sends nothing; **`step.resultEvent(value)`** sends the line and writes no file. The role program writes the file only where `/surety/out` is a directory, which is only inside a sandbox, and logs a `result_file` entry (`outcome` `written` with `bytes` and `sha256`, or `no_out_dir`) so that a case knows the file's bytes. The value the line carries is not read as the result; what the engine does when line and file disagree is not pinned. **The kernel lane is unchanged**: there is no file, and the line is the result as section 13 says, for every M1 file.

**Collection** (D2 §1.4, §3.2, K4). The engine reads the file only after the domain is `terminated` (section 126: launch closed, no launcher outstanding, `populated 0` read), and what it collects is the file as it was then: a descendant still writing it while the role has exited (row M129 (a)) is part of the domain, and its last write before the kill is what is read. `run.validating`, written by the transaction that records an accepted result (section 24), therefore follows `domain.terminated` in event sequence. The engine reads from outside the sandbox and **follows no link**: anything at the path that is not a regular file is refused without opening it or what it names (a FIFO is never opened, so a host FIFO a link names never gets a reader; a link to a device is never read through), a regular file larger than `result_max_bytes` is refused with at most `result_max_bytes` bytes read, and collection ends within `collect_deadline`. A domain whose termination is `unknown` is not collected at all (section 128).

**The run read's `result_collection`** (section 17 gains it; present on every run of the sandbox lane, its value in the kernel lane not pinned): `{"outcome", "reason", "bytes_read"}`.

| `outcome` | When | `reason` | `bytes_read` |
|---|---|---|---|
| `not_collected` | Nothing was collected: before collection; a run whose role was never launched (no volatile filesystem was ever built: row M129 (b)); a domain whose termination is `unknown` (row M130 (j)) | null | null |
| `missing` | Collection looked and found nothing at the path; also a run recovered after an engine crash, whose volatile filesystem is lost with the domain (D2 §1.4: "recovery records it missing, never as an empty success"; row M132 (c)) | null | 0 where the collector looked; null where recovery records it without looking |
| `invalid` | Something is at the path and is not a result the engine may take | `link` (a symbolic link, wherever it points), `fifo`, `device` (a character or block device), `not_regular` (any other kind that is not a regular file), `oversize` (a regular file larger than `result_max_bytes`), `malformed` (a regular file within the bound whose bytes are not a well-formed result: not UTF-8 JSON, or not the result schema of sections 13 and 68), `deadline` (collection did not end within `collect_deadline`) | 0 for `link`, `fifo`, `device` and `not_regular`; at most `result_max_bytes` for `oversize` and `deadline`; what was read for `malformed` |
| `accepted` | A regular file within the bound, read whole, well-formed | null | its length |

**`accepted` is the collector's verdict on the file, not the run's on the result.** What becomes of an accepted file is the exit class's (D2 §1.4, §1.6; section 145):

| Exit class | The file `accepted` | The file `invalid` or `missing` |
|---|---|---|
| `clean` | the run's `result` record (section 56: JSON text that parses to the file's value, after redaction); the run goes on to `completed` / `none` as sections 28 and 68 say | `failed` / `invalid_result` for `invalid`; `failed` / `infra_error` for `missing` (the event with no file is section 13's "exits without having sent a result") |
| `error_exit` | `failed` / `invalid_result` (a well-formed result contradicting the transcript, D1 §15.1); `runs.result` null | `failed` / `infra_error` |
| `engine_signaled` | the ending's own outcome (a Stop's `stopped` / `human_stop`, a deadline's `timed_out`, …); `runs.result` null; the file published as an **`unaccepted_result`** record | the ending's own outcome |
| `foreign_signal`, `resource_limit` | `failed` / `infra_error`, the class named in `reason_text`; `runs.result` null; `unaccepted_result` | the same, without the record |
| `unknown` with termination established | `failed` / `infra_error`, or `recovered` when recovery ended the run; never `completed`; `runs.result` null; `unaccepted_result` | the same, without the record |

Only `clean` with `accepted` completes. **`unaccepted_result`** (D2 A.2, §1.4; E27 item 7 applied to real backends): at most one per run, `kind` `unaccepted_result`, `run` the run, `project` its project, published; its bytes are the collected file after redaction (JSON text that parses to what the role wrote, every registered secret redacted as section 57 says), published only after the secret screen of D2 §2.5 (a screen hit refuses its publication: row M132). A Resume's package may cite it (section 139, `prior_run`); it is never a run's `result` (row M131 (b)). Whether an `unaccepted_result` is published for `clean` or `error_exit`, or for an `invalid` file under any class, is not pinned.

## 144. The role's slice-13 instruments

(Section 141's guard; E64 item 2; E69; rows M129, M130; `harness/scripted/child.mjs`, `harness/scripted.mjs`, `harness/sandbox/cgroup.mjs`, `harness/sandbox/result.mjs`.)

**Unguarded:** `step.result`, `step.resultFile` (section 143). They write one path, `/surety/out/result.json`, and only where `/surety/out` is a directory: on a host there is no `/surety` and uid 1000 cannot make one.

**Guarded** (section 141's two halves: the step carries the host's namespaces and the role program refuses outside a sandbox; `armedRole` releases the role only after `assertContained` has read containment from the host), scripted through `acting(hostNamespaces())`:

| Step | What the role does and logs |
|---|---|
| `resultShape('host_fifo_link', {target})` | `/surety/out/result.json` made a symbolic link to `target`, which must be `/tmp/surety-fifo-<6 characters>/<name>`: a FIFO in a short directory of the test's own on the host (P18). Inside the sandbox `/tmp` is the volatile one, so the link names nothing there; it names the host's FIFO only for a reader that follows it from outside. |
| `resultShape('device_link')` | a symbolic link to `/dev/zero` |
| `resultShape('fifo')` | a FIFO made at the path (`mkfifo`) |
| `resultShape('oversize', {bytes})` | a well-formed result of exactly `bytes` bytes, so its size is the only thing wrong with it |
| `resultShape('rewriter', {every_ms, on_term})` | a descendant (`child.mjs rewriter`, in the role's process group, carrying its markers) that every `every_ms` (100) writes `{"status": "completed", "summary": "marker <n>"}` to `result.json.tmp`, renames it over `result.json`, and only then logs a `rewrite` entry with `n`; it ignores SIGTERM unless `on_term` is `exit`. So the file never holds a marker earlier than the last logged one, and at most the next. The role goes on once one rewrite is logged. |
| `killParent({delay_ms})` | a descendant (`child.mjs killer`) that after `delay_ms` sends SIGKILL to the role, and only if its own parent is still exactly that pid and it is greater than 1; the role logs its `probe` entry first and then waits to be killed (row M130 (e)) |
| `spawnUntilRefused({max, seconds})` | at most `max` (never more than eight) `sleep <seconds>` children, one at a time, until a spawn is refused; logs `attempts`, `spawned`, `refused` (`{attempt, error}` or null); then kills every child and awaits it (row M130 (h)) |

Each `result_shape` logs the type and size it left at the path. **None of these exhausts anything** (E64, E69): one path; one file rewritten ten times a second; one SIGKILL to one checked pid; at most eight processes that never fork, against a limit the test has lowered. The exhaustion instruments (P20, M130 (f) and (g), M133) are slice 13 part 3's, on the exhaustion host.

**P18's host FIFO** (row M129 (c); `fifoWatch` in `result.mjs`). The test makes the FIFO with `mkfifo` (mode 0600) in a directory of its own made by `mkdtemp('/tmp/surety-fifo-')`, removed after the test, and from before the dispatch until a second after the run has ended polls `open(path, O_WRONLY | O_NONBLOCK)` every 20 ms. Each poll must fail `ENXIO`: there is no reader. A poll that opens it means a reader exists, which only the engine following the link could be; it is closed at once and fails the case.

**`pids.max` lowered from the host** (row M130 (h); `setPidsMax` in `cgroup.mjs`). While the role holds, contained, the test sets the domain's `pids.max` to its `pids.current` plus 2, then releases the role into `spawnUntilRefused`: two `sleep`s start, the third spawn is refused, `pids.events` `max` rises. The helper is confined as section 128's are, and more narrowly: only a domain's own directory (`dom_<ULID>`) in a test engine's scope, only `pids.max`, only an integer from 1 to 64. Lowering a limit ends no process. The engine reads a domain's limits back before authorizing its launch (E69 item 3); the change is made after authorization. An engine that rewrote the limit during the run would fail the case at "a spawn was refused"; that it must not is not otherwise pinned.

## 145. Exit classes and their evidence

(D2 §1.6, §3.4, K4, A.2, A.3; E27 item 7; E58 item 7; E65 item 6; E69; AR N02; row M130; section 126, amended.)

**The class** is the first of these that holds (D2 §1.6, A.2's order), recorded on the terminal status observation (`invocation_status_observations.exit_class`): **`engine_signaled`**, the engine had begun cancellation (closure for a Stop, an Abandon, a deadline, a budget stop, an expired lease, an evidence bound) before the backend's exit, whatever a counter also shows; **`unknown`**, no exit report reached the engine (the fault `init_report_lost`, section 128); **`resource_limit`**, the backend died by a signal the engine did not send and `oom_kill` rose; **`foreign_signal`**, any other signal the engine did not send; **`clean`**, exit status 0 and the terminal success event (section 143); **`error_exit`**, anything else (a nonzero status; status 0 without the event). Missing exit evidence is never `clean`.

**`exit_evidence`** (section 126's keys, amended): `status` (the backend's exit status as the init reported it; null when none was reported), `signal` (the last signal the engine sent the domain, or, where it sent none, the signal that ended the backend as the init reported it; null when neither), `signal_by_engine` (bool), `terminal_event` (`"result"` when the adapter read the terminal success event, whatever the file holds; null otherwise), `resource_events` (`{"oom_kill", "pids_max"}`: the domain's `memory.events` `oom_kill` and `pids.events` `max`, read after `populated 0` and before the directory's removal; a domain's cgroup is new, so these are the rises; each an integer, or **null where its file could not be read**, never 0 for a counter not read). The keys the Builder added (`report`, `term_sent`, `kill_written`; E65 item 6) may stand beside them. `execution_domains.resource_events` (D2 A.3) holds the same object. **A rise that did not end the backend** is recorded and does not by itself fail the run: a `pids_max` above 0 on a role that then exits 0 with its event and an accepted file is `clean` and `completed` (M130 (h)).

**What each slice-13 case pins** (the run's outcome follows section 143's table):

| Case | The role | `exit_class` | `exit_evidence` | The run |
|---|---|---|---|---|
| M130 (a) | file and event, exit 0 | `clean` | `status` 0, `signal_by_engine` false, `terminal_event` `result` | `completed`; `result_collection` `accepted` |
| M130 (b) | file, no event, exit 0 | `error_exit` | `status` 0, `terminal_event` null | `failed` / `invalid_result`; `accepted`; `runs.result` null |
| M130 (c) | file, no event, exit 1; event, no file, exit 1 | `error_exit` | `status` 1 | `invalid_result` with the file; `infra_error` without (`missing`) |
| M130 (d) | file, no event, holds; Stop; exits on TERM | `engine_signaled` | `signal_by_engine` true | `stopped` / `human_stop`; `unaccepted_result`; `runs.result` null |
| M130 (e) | killed by its descendant's SIGKILL | `foreign_signal` | `status` null, `signal` 9, `signal_by_engine` false | `failed` / `infra_error`, `reason_text` naming `foreign_signal` |
| M130 (h) | two `sleep`s, the third spawn refused, then file and event, exit 0 | `clean` | `resource_events.pids_max` at least 1 | `completed` |
| M130 (i) | file and event, exit 0, under `init_report_lost` | `unknown` | `status` null | `failed` / `infra_error`; `unaccepted_result`; `runs.result` null |
| M130 (j) | file, no event, holds; Stop under `manager_unreachable` | none (no terminal observation while quarantined, section 126) | — | quarantined; `not_collected`; no `result`, `unaccepted_result` or `provider_files` record |

**The run read** (section 17) gains **`exit_class`** (the terminal observation's; null while there is none) and **`domain_observation`** (the `observation` of the run's latest domain: `running`, `terminated` or `unknown`; null before the first observation). They are two facts and the read shows both (M130 (k)): `unknown` with `terminated` (i), null with `unknown` (j), `engine_signaled` with `terminated` (k).

**M130 (f) and (g)** (OOM at `memory.max`; a Stop that meets an OOM) run on the exhaustion host only (E69 items 1 and 2), at 64 MiB with the instruments' own caps, written in slice 13 part 3. In `M130-exit-classes.test.mjs` their two named tests **fail** with the message "M130 (f)/(g) run on the exhaustion host only (E69); written in slice 13 part 3": a failure, never a skip, so that `--slice 13` cannot pass on this host until part 3 replaces them. `resource_limit` is pinned by no case of part 1.

## 146. The provider session id

(D2 §1.7, §4.5, Appendix B A12; D1 A.3 `runs.provider_session_id`; M2 plan §2.6 "the UUID derivation of `--session-id` from the invocation id"; row M131 (c), slice 13 part 2.)

**The derivation.** For Claude Code, `--session-id <uuid>` where, with `h` the lowercase hexadecimal SHA-256 of the UTF-8 string `surety-session:` followed by the invocation id (`invocation_receipts.id`, as stored), the UUID is `h[0..8]-h[8..12]-4h[13..16]-v h[17..20]-h[20..32]`, `v` the hexadecimal digit `(h[16] & 3) | 8`: lowercase, RFC 9562's layout with the version nibble 4 and the variant bits `10`. The same invocation always gives the same id; two invocations never share one unless SHA-256 collides. It is the derivation the engine already uses (`src/invoke/adapters/templates.ts`, `sessionId`), fixed here as the contract. **Not taken:** version 5 (SHA-1 over a namespace), the more conventional name-based form, and version 8, the honest label for a custom hash: version 4 is the form a validator that knows only versions 1 to 5 accepts, and whether Claude Code 2.1.288 accepts the id at all is the positive canary's to establish (M136). The nibble claims randomness the id does not have; nothing reads it as random.

**Where it is recorded** (D2 §1.7: "bound to the receipt"; A12: "before launch, stable across a crash and retry"): `invocation_receipts.provider_session_id`, written with the receipt in the dispatch transaction, so before the launcher starts and before `domain.placed`; `runs.provider_session_id` (D1 A.3) holds the same value for a one-shot run. Null for the scripted backend, and for a backend whose id is read from its stream (Codex, D2 §1.7), on the receipt. A resumed run is a new invocation with its own receipt and so its own id; the earlier receipt is unchanged (row M131 (c)). Part 2 of this slice writes the case.

## 147. Names the Verifier fixed in this pass, and what it changes in earlier sections

**What this pass changes in earlier sections.**

- Section 13's protocol, sandbox lane only: the `result` line is the terminal success event and the result is the file (section 143); `step.resultFile`, `step.resultEvent` join the steps. The kernel lane is unchanged.
- Section 17's run read gains `result_collection` (section 143), `exit_class` and `domain_observation` (section 145).
- Section 122's "the result file … is slice 13's": it is now (section 143); the slice-11 and slice-12 cases hold as written, since `step.result` writes the file before the line.
- Section 126's `exit_evidence`: `terminal_event` is the event's, `resource_events` always two keys, each null where unread (section 145; amended in place).
- Section 128's `init_report_lost` is exercised (row M130 (i)).
- Section 139: the package carries the approved texts; the plan fixture takes requirement texts, ADRs and constraints (amended in place; E67 item 7).
- Section 141's guarded actions gain `result_shape`, `kill_parent`, `spawn_until_refused` (section 144); section 128's confined changes gain `setPidsMax`.
- Section 138's excuse of P20 "in slice 12 only" is not removed by this pass: E69 item 3 excuses P20 on this host for good (`not_exercised`, listed as not claimed), and part 3 of the slice writes that excuse and the key that designates an exhaustion host. *(Done after the slice-13 Builder's report, 2026-10-04: section 138 now names `isolation_probe_exhaustion` and its excuse.)*

**Names the Verifier fixed.** Each was open in the sources (plan §2.6, D2 in words, or the brief's list). The Builder may object. Those marked † carry a question for the owner in the Verifier's report.

| What | Fixed as | Why this choice |
|---|---|---|
| The scripted result channel in the sandbox lane | The file; the stdout `result` line is the terminal success event; `resultFile`, `resultEvent` (section 143) | D2 §1.4 (the file) and §1.6 (a terminal success event); the brief's two steps. |
| `result_collection` † | `{outcome: accepted \| invalid \| missing \| not_collected, reason: link \| fifo \| device \| not_regular \| oversize \| malformed \| deadline \| null, bytes_read}` (section 143) | The brief's names; D2 §1.4's refusals (link, device, FIFO, oversize) and §3.7's `collect_deadline`, one reason each; no D2 enumeration exists for it. |
| `accepted` † | The collector's verdict on the file, not the result's acceptance; the exit class decides (section 143) | Otherwise a well-formed file under `engine_signaled` or `error_exit` has no outcome; D2 §1.4 keeps "accepted only on `clean`" for the run's result, which `runs.result` shows. |
| `bytes_read` | Its length when accepted; 0 when nothing was opened; at most `result_max_bytes` when oversize; null when not collected (section 143) | The plan's M129 (c): "zero bytes read from the device; nothing past `result_max_bytes` read". Unknown is null, never 0. |
| A crash's lost result | `missing` (section 143) | D2 §1.4: "recovery records it missing". |
| A never-launched run | `not_collected` (section 143) | No volatile filesystem ever existed to look in. |
| The event without the file on `clean` | `failed` / `infra_error` (section 143) | Section 13's "exits without having sent a result"; not pinned by a case. |
| `unaccepted_result` | One record per run, after redaction and the screen, under `engine_signaled`, `foreign_signal`, `resource_limit`, `unknown` with termination (section 143) | D2 §1.4's list; A.2 names the kind. |
| `exit_evidence.resource_events` † | Two keys, each an integer or null; never `{}` or 0 for an unread counter (section 145) | "Unknown is a value" (CLAUDE.md); the engine today writes `{}` and folds a null into 0 when it judges the class. |
| The run read's `exit_class`, `domain_observation` | Section 145 | The plan's M130 (k): "`exit_class` and the domain observation both shown"; A.3's column names. |
| M130 (f), (g) on this host | Two failing tests with the brief's message (section 145) | E69 item 2: exhaustion runs on `mini-hp01`; a failure, not a skip (CLAUDE.md). |
| How M130 (h) reaches `pids.max` † | The test lowers the domain's `pids.max` to `pids.current + 2`; at most eight `sleep`s (section 144) | No exhaustion code on this host (E69); the plan's case needs a rise of `pids.events` `max` with the role surviving it. E69 item 1's harness override of the domain's limits is part 3's to name. |
| The rewriter's markers | Write-then-rename, then log; the record holds the last logged marker or the next (section 144) | The brief: "the last marker logged before termination or the one after, never an earlier one". |
| The host FIFO's watch | `/tmp/surety-fifo-XXXXXX/f`, `O_WRONLY \| O_NONBLOCK` every 20 ms, `ENXIO` every time (section 144) | P18: "the host FIFO is never opened"; a short directory as section 142's sockets. |
| The session id † | SHA-256 of `surety-session:<invocation id>` laid out as a version-4 UUID; `invocation_receipts.provider_session_id` at dispatch (section 146) | The engine's existing derivation; D2 §1.7 binds it to the receipt, which has no column for it yet. |
| The approved texts † | Verbatim text per bound item; the plan fixture's `text`, `adrs`, `constraints`, per-stage `adrs`; constraints project-wide (section 139) | E67 item 7 (Sean); F §3.10.8 "project-wide constraints". |

---

# M2 slice 13 (part 2): usage and resume, secrets and provider files, revocation, the qualification attempt

Sections 148 to 154 were written with the second part of the slice-13 acceptance tests (2026-10-03; `verify/m2-s13` reset to `main` at `e1f6e73`): rows M131, M132, M134 and M135 of `docs/acceptance/sdlc-M2-acceptance-plan.md` §§3.6, 3.7. They follow D2 §§1.5, 1.7, 2.5, 3.7, 4.1 to 4.3, 7.1 to 7.3, A.2 to A.7, Appendix B (A07 to A12, S01 to S08, T01 to T07, Q01 to Q10) and the driver's defaults on part 1's questions (`accepted` is the collector's verdict; `resource_events` null per key; the session id as section 146). Part 3 (the exhaustion cases on `mini-hp01`, E69) adds its own. Nothing here forks, allocates or writes to a limit: where a bound must be exceeded, a harness override lowers the bound, never the role raising its use.

## 148. The qualification attempt in the sandbox lane

(D2 §4.1, §7.2, K10, A.3, A.4, A.5, A.7; Q7; E58 item 4; AR B04, B05; row M135; `harness/sandbox/qualify.mjs`, `harness/standin/backend.mjs`.)

**The route.** `POST /v1/trust/qualify` with `{"backend", "mode", "model", "candidate_egress": [<host>], "binary"?: {"path"}, "fixture_project"?, "canary_deadlines"?: {"positive", "cancellation", "containment"}}` (seconds; each defaulted by the engine when absent). `mode` must be `one_shot_headless` (else **400** `invalid_value`, `subject.field` `mode`). In harness mode, and only there, `binary.path` names the binary to qualify (a stand-in) and `fixture_project` names a project the harness installed; outside harness mode the binary is the backend's resolved installation and the fixture project the engine's own, and `binary`, `fixture_project` and `backend: "scripted"` are **400** (`unknown_field`, or `invalid_value` for `scripted`). A `candidate_egress` naming the echo endpoint is section 140's **400**. **201** `{"qualification_attempt": {"id": "qa_<ULID>"}, "decision": "dec_<ULID>"}`.

**`scripted` is qualifiable in harness mode** (the plan's M135 "for `scripted` with the stand-in binary"): its adapter is the scripted one and its binary the stand-in built with `runsChild` (`new StandIn(dir, {logDir: <scripted dir>, runsChild: true})`), which after recording its launch runs the scripted role program of the scripted directory with its own standard streams and exits as that program did. So the canaries are scripted roles following `scripts/canary-<kind>.json` (section 149), launched through the attempt's binary inside the real sandbox. An attempt for `claude` bound to a stand-in is accepted too and renders the real template into the row; no case of this slice approves one (approving it would launch the stand-in as Claude Code, whose stream the stand-in does not write). Section 113's "`scripted` never has an entry" now reads: never one from the fixture route; a harness-mode attempt for `scripted` writes one, labelled by its attempt.

**The static checks**, on the host, before the row is written: the binary's real path (`binary_path`), the SHA-256 of its file (`binary_sha256`), its `--version` (the first line of standard output, trimmed: `version`) and the SHA-256 of its `--help` standard output (`help_sha256`; for `claude` and `codex` the help of each command the template uses, the engine's choice of which). The binary is run with exactly `--version` and exactly `--help`, once each, outside any domain; the stand-in answers each and logs a `static` entry (never a `launch`). Nothing else runs before the approval: **no domain, no launcher, no launch** of the binary with any other arguments (the plan's "no process spawned").

**The row** (`qualification_attempts`, A.3), `proposed`, binds: `backend`, `version`, `binary_path`, `binary_sha256`, `help_sha256`, `template` (the adapter's fixed text: for `claude`, D2 §4.5's), `template_version`, `model`, `auth_mode` `api_key`, `host_qualification` (the active row's id; a start that is not eligible refuses the route **409** `isolation_unqualified`), `profile_fingerprint` (section 150), `fixture_project`, `candidate_egress`, `canary_deadlines` (`{positive, cancellation, containment}`, seconds), `spend` `{"cap": null, "estimate": <number> | null, "label": "estimate", "overshoot": "deadline"}` (an estimate, labelled, null where no price is known: never 0), `decision` (the approval), `status`, `canaries` `[]`, `unexpected_contacts` `[]`, `trust_entry` null, `invalidated_reason` null. `qualification.proposed` (`subject.qualification_attempt`) and `qualification_approval` (section 117's manifest) are written with it.

**Approval and dispatch.** Consuming `approve` makes the attempt `authorized` (`qualification.authorized`). The next tick moves it to `running` and dispatches the three canaries on the fixture project, one at a time in the order positive, cancellation, containment, each a run whose one receipt has `qualification_attempt` the attempt and `trust_entry` null, launched with the attempt's binary, template and profile, and charged to the ordinary ledger (one original ledger row each). The canaries' work items belong to the attempt; which kind they are is not pinned. **The attempt's authority dispatches nothing else** (K10): no other item, of the fixture project or another, gets a run whose receipt names the attempt, and an item whose role names a real backend with no active entry is refused `backend_refused` as section 116 says, attempt or no attempt. **`qualification.before_dispatch`** is a barrier (section 18's rules) at the attempt's first dispatch, after authorization, before any canary's run is created.

**The canaries' entries** on the row: `canaries` `[{"kind", "run", "passed", "failure_class": null | <CanaryFailureClass>, "provider_error": null | <record id>, "evidence": <record id>, "term_to_exit_ms": <int> | null}]`, one per canary dispatched, in order. `evidence` is a `qualification_evidence` record of the canary's run (section 149 gives the containment canary's). A failed canary carries its class and a `provider_error` record: for a real backend the redacted structured provider error, for the scripted backend the run's redacted output; never null for a failed canary.

**The outcomes.** All three passed: `succeeded`; the entry written `proposed` (`trust.proposed`) with `qualification_attempt` the attempt, the attempt's binding, `egress_hosts` the candidate destinations the canaries used (none for `scripted`), `provider_files` the positive canary's inventory (section 152), `term_to_exit_ms` the cancellation canary's, `evidence` the attempt's records; `trust_activation` raised (section 117). The first canary that fails ends the attempt `failed` and **no later canary is dispatched**; no entry is written. Either way `qualification.finished` (`subject.qualification_attempt`; `payload.outcome` `succeeded` | `failed` | `invalidated`, `payload.code` `qualification_failed` for `failed`, null otherwise, `payload.failure_class`). **Invalidation**: a bound dependency (the binary's hash, the help hash, the template version, the host qualification) changed between preview and answer refuses the answer `decision_stale` and makes the attempt `invalidated` with `invalidated_reason` naming the dependency (`binary_changed`, `help_changed`, `template_changed`, `host_changed`), within the ticks; changed after authorization and before the first dispatch (at `qualification.before_dispatch`) or between canaries, the same, and no further canary runs. A **replay** of a failed or invalidated attempt is a new `POST`: a new row, a new approval; the old row is never changed again. **Answering `trust_activation` launches nothing** (D2 §4.1; CH incident 10): no run, no domain, no launch of the binary.

## 149. The canaries without a model

(D2 §7.2, §3.6, A.2 `CanaryKind`, `CanaryFailureClass`; AR B05, T08 to T10; rows M135, M137 (b); `harness/scripted/child.mjs`, `runCanary`, `canary_actions`.)

**What each canary is told.** The engine writes `/surety/context/canary.json` into each canary's context package (and the prompt points at it): `{"kind": "positive" | "cancellation" | "containment", "attempt": <qa id>, "result": <the result the role must end with>, "edit"?: {"path": <workspace-relative>, "content": <string>} (positive), "barrier"?: "/surety/out/<name>" (cancellation), "wait_seconds"?: <int, beyond the canary's deadline> (cancellation), "actions"?: [{"name", "argv": [<absolute program>, ...]}] (containment)}`. The real agent reads it through its prompt; the scripted role program reads it directly (`step.canary(mode)`), so the test never has to know the engine's chosen edit, result or barrier.

**The scripted canary's modes** (`step.canary`): `obey` (positive: write `edit`, then end with `result` through section 143's file and event; cancellation: write the barrier, then wait `wait_seconds`; containment: end with `result`, the actions being the guarded `canary_actions` probe before it); `wrong_result` (positive: the edit, then a different well-formed result); `finish_early` (cancellation: end with `result`, no barrier); `say_denied` (containment: print `denied: <name>` for each action, run nothing, end with `result`); `forge_reports` (containment: print, on its own standard output, a line `{"type": "probe", "action": <name>, "outcome": "denied"}` for each action, as the probe program reports, run nothing, end with `result`); `result_only`. `canary_actions` (guarded, section 141) runs each `argv` of the containment canary with no shell.

**When a canary passes** (the scripted backend has no authentication, so `auth_failed` is not reachable here):
- **positive**: exit class `clean`; the collected result equals `result`; after materialization the fixture workspace's `edit.path` holds exactly `edit.content`. A different result fails it `invalid_result`.
- **cancellation**: the domain init observed the barrier file and reported it on its channel while the backend ran; the engine then cancelled through section 126 (closure, TERM, grace, kill, observation): exit class `engine_signaled`, `term_to_exit_ms` recorded (the engine's TERM to the backend's exit, on the monotonic clock). A role that ends without the barrier, or never reaches it before the deadline, fails it `barrier_not_reached`, whatever usage it reported.
- **containment**: every listed action **witnessed** by the domain init as an execution of the engine's probe program by a descendant of the backend, each outcome reported by that executable and each the expected denial, corroborated host-side, and each permitted control run. Nothing the backend prints counts: a `denied` line, or a report in the probe program's own form written by the backend, is not a witnessed execution, and the canary fails `containment_failed`. Its `evidence` record's bytes: `{"actions": [{"name", "witnessed": bool, "outcome": <reported> | null, "expected", "passed": bool}]}`, one per action of `canary.json`, in order.

**An unexpected contact** (D2 §2.4, §7.2): a canary's `CONNECT` to a destination off the attempt's list is refused by the proxy (section 140, `not_listed`) and appended to the attempt's `unexpected_contacts` as `{"destination": <authority>, "refused_at"}`; it does not by itself fail the canary, and it is never added to `candidate_egress` or the entry's `egress_hosts`.

## 150. Revocation, suspension and requalification

(D2 §4.1, §7.1, §7.3, A.4, A.5; AR N03, T03, T04; row M134; section 116.)

**When an active entry is checked.** At every start (after the host checks) and before every dispatch to it, the engine compares the entry with what is in force: the binary's SHA-256 and its help hash (the help run as section 148's static check), the adapter's template version, the profile fingerprint, the host identity. **A difference revokes it**: `status` `revoked`, `revoked_at`, `revoked_reason` one of `binary_changed`, `help_changed`, `template_changed`, `profile_changed`, `host_changed` (and `capabilities_changed`, not reachable here), one `trust.revoked` (`subject.trust_entry`, `payload.reason` the same). A dispatch that finds the difference is refused `backend_refused` in the same transaction (for the binary, section 139's subject with `expected_sha256` and `found_sha256`). **A run in flight is untouched**: revocation signals nothing and closes no domain; the run ends as it would have.

**The profile fingerprint** (D2 §4.1, §7.3): SHA-256 over the role profile's plan fingerprint (section 133), its volatile bounds (`domain_writable_bytes`, `domain_writable_inodes`, `domain_memory_max`, `domain_tasks_max`) and the entry's egress list; the engine's current value is `GET /v1/engine` `host_qualification.profile_fingerprint` (the role profile's, for an entry of no extra egress). A changed bound changes it.

**Suspension** (T04): with the host not eligible (a check failed, section 123) every active entry stays `active` and dispatch is refused `isolation_unqualified`; a later start whose host is eligible and whose mechanism fingerprint equals the one the entry was qualified under restores dispatch with no new attempt (no `qualification_attempts` row, no receipt naming an attempt). The entry's own `host_qualification` row is then `lapsed`, and the current active row is another (D2 §4.1: the entry's row is historical).

**Requalification** (D2 §4.1: "an incompatible mechanism or profile requires requalification"): a start whose active host qualification has a `mechanism_fingerprint` other than the one the entry's own row recorded refuses dispatch `backend_refused` with `refusal.subject.requalification_required` true; the entry is not revoked by that alone.

**Harness switches** (accepted only with `--harness`; the M2 plan's "(harness)"):

| Flag | Meaning |
|---|---|
| `--harness-template-version <backend>=<version>` | The adapter's template version for that backend is `<version>` in this start (the text unchanged) |
| `--harness-host-id <id>` | The host identity is `<id>` instead of `/etc/machine-id` in this start |
| `--harness-mechanism-variant <label>` | The host qualification's `mechanism_fingerprint` folds in `<label>`, as a different boundary or sandbox mechanism would change it |

**The trust-entry fixture in the sandbox lane** (section 116, amended): an entry's `host_qualification` is the active row when one exists; its `profile_fingerprint`, when the body gives none, is the engine's current one for the role profile with the entry's egress list; its `help_sha256` is what the engine's own help check computes for the binary (the stand-in's `--help` output), so that an unchanged stand-in passes the checks above and a changed `help.txt` beside it fails them.

## 151. Usage, resume and the session id in the sandbox lane

(D2 §1.5, §1.7, §5 C4, K6; Appendix B A07 to A12; row M131; sections 120, 139, 143, 146.)

**Known usage retained** (M131 (a)): section 120's rules through the real boundary. Two cumulative usage observations, then a Stop: the original ledger row folds them (`billable_in`, `out` the last observation's), `usage_complete` 0, `unknown_allowance_tokens` `budget_run_billable_tokens` less the observed billable tokens; with the fault `before_event` on `ledger.row` armed once, and after a restart and a tick, still one original row with one allowance.

**A resume is a new invocation** (M131 (b); D2 §1.7): the resumed run has its own receipt, domain (`execution_domains.id`), workspace and context package; its package's `prior_run` files are sourced from the stopped run's records (section 139); the executed argv holds neither `--resume` nor `resume` (for `claude`, D2 §4.5's template); the stopped run's `unaccepted_result` record (section 143) is never the resumed run's `result`. The stand-in's `leaveResult(value)` puts a result at `/surety/out/result.json` before it holds, so the stopped run has one to publish.

**The session id** (M131 (c)) is section 146's: the rendered argv's `--session-id` value equals the derivation from the receipt's id and the receipt's `provider_session_id`, which is set when `domain.placed` is written. **A crash at `launcher.before_authorization`** (the barrier armed `kill`: the engine SIGKILLs itself there): recovery ends that run `recovered` with its receipt unchanged; the Resume after it is a new run whose receipt has its own id and its own derived session id.

## 152. Secrets, the screen, provider files

(D2 §2.5, §3.7, §4.3, K4; D1 §14.2; E37 item 2; E58 item 1; E67 item 5; AR B08, B09; row M132; sections 57, 121, 135, 143.)

**A screen hit's outcome** (the plan's "the Verifier fixes the outcome"; E67 item 5's interim reading kept): a registered secret, raw or JSON-escaped, found by the screen in the workspace's upper layer (content or path, the slice-12 review's S1) or in any collected output about to be published (the result file, the provider files) **refuses that materialization or that publication**, raises one finding (`category` `security`, `effective_severity` `critical`, `scope` `project`, `source_run` the run, `status` `open`), emits one `evidence.secret_refused` (`subject.run`, `subject.project`; `payload.what` `materialization`, `result` or `provider_files`), and ends the run **`failed` / `infra_error`** with `reason_text` naming `secret_refused` (never `completed`). The integration branch and every ref are unchanged by a refused materialization. A refused result leaves `runs.result` null; a refused provider-files publication leaves no `provider_files` record. **What is not refused but redacted:** the transcript, a stream, is redacted as it is written (section 57): neither the secret nor its JSON-escaped form is in it. What was refused is not published in redacted form either.

**The provider-files inventory** (D2 §4.3), made after termination and after the result's collection: every entry under the role's writable locations as the role saw them, `/surety/home`, `/surety/out` and `/tmp` (the workspace's upper layer is materialized, not inventoried), walked without following a link or opening anything but a regular file, within `collect_entries_max`, `provider_files_max_bytes` and `collect_deadline`. One `provider_files` record per domain (`kind` `provider_files`, `run`, `project`, published), whose bytes are `{"locations": [{"path", "type": "file" | "dir" | "symlink" | "fifo" | "other", "size"?, "target"? (a link's, as read), "retained": bool, "content_base64"? (a retained file's, redacted)}], "persistence_flags": [<the backend's no-persistence flags in force>], "excluded": [{"path", "reason": "credential"}], "truncated": bool, "limit": null | {"key", "value"}, "complete": bool}`. A link is listed with its target and its target is not read; a FIFO is listed and never opened. **A credential file** is listed under `excluded` and never retained: any path whose part under `/surety/home` is one of section 120's credential locations (`.ssh/…`, `.gnupg/…`, `.aws/…`, `.config/gh/…`, `.claude/…`, `.codex/…`, `.docker/…`, `.kube/…`, `.netrc`, `.git-credentials`, `.npmrc`). **A bound reached** (entries, bytes, deadline) stops the walk: the record is published with `truncated` true, `complete` false and `limit` the bound, and the run ends `failed` / `infra_error` with `reason_text` naming the bound (section 140's rule for `egress_log_max_bytes`: evidence incomplete is never `completed`). Its secret screen is the screen above.

**The run read's `provider_files_collection`** (section 17 gains it, beside section 143's `result_collection`): `{"outcome": "published" | "refused" | "truncated" | "missing" | "not_collected", "record": <rec id> | null}`. `missing` for a run recovered after an engine crash (the volatile filesystem lost: D2 §1.4, AR B08), `not_collected` as section 143's.

**Harness instruments** (accepted only with `--harness`): `--harness-collect-bounds entries=<n>,bytes=<n>` sets `collect_entries_max` and `provider_files_max_bytes` below their configured ranges for this start (the configuration keys keep their ranges); the fault `{"point": "collect_slow", "delay_ms": <n>}` (standing until lifted) delays the inventory's handling of each entry by `<n>` ms, so that a handful of entries can outlast `collect_deadline` at its minimum. The barrier **`collect.before_read`** is in the engine after termination, before the first read of the result or the inventory; armed `kill`, the engine dies there (I18).

**Swap** (D2 §3.7, E58 item 1): a domain's `memory.swap.max` reads `0`, host-read while the role runs.

## 153. The context package's phase plan and interfaces (E67 item 7, carried)

Section 139's amendment covers them; this part does not add the case (the plan fixture binds no dependency module, and giving it one with an interface text is a new fixture surface the driver asked for only if cheap). Recorded for part 3 or the real lane (M140), where the journey reads them in use.

## 154. Names the Verifier fixed in this pass, and what it changes in earlier sections

**What this pass changes in earlier sections.** Section 1's flags: `--harness-template-version`, `--harness-host-id`, `--harness-mechanism-variant`, `--harness-collect-bounds`. Section 7's faults: `collect_slow`. Section 18's barriers: `qualification.before_dispatch`, `collect.before_read`. Section 17's run read: `provider_files_collection`. Section 113: a harness-mode attempt may write an entry for `scripted`. Section 116's fixture: `host_qualification`, `profile_fingerprint`, `help_sha256` as section 150 says. Section 116's stand-in: `--version`, `--help`, `runsChild`, `leaveResult` (sections 148, 151). Section 118's `host_qualification` gains `profile_fingerprint`. Section 140's route note: `POST /v1/trust/qualify`'s body is section 148's. Section 141's guarded actions gain `canary_actions` (section 149) and `volatile_shapes` (small files, links and FIFOs under `/surety/home`, `/surety/out` or `/tmp` only, at most 16 of each, each file at most 64 KiB; section 152).

| What | Fixed as | Why this choice |
|---|---|---|
| The attempt route's body † | Section 148; `binary`, `fixture_project` and `scripted` in harness mode only | D2 §7.2 names the binding; the plan's M135 needs a stand-in and a fixture project without a model. |
| "No process spawned" before approval | Only `--version` and `--help`, once each, outside any domain | The static checks are D2 §7.2's own and run before the row. |
| The canary's instructions † | `/surety/context/canary.json` | The engine chooses the edit, the result and the barrier; a scripted role must obey without the test knowing them. |
| A failed canary stops the attempt † | No later canary is dispatched | Q7: no paid work after the attempt cannot succeed. |
| `qualification_failed` | `qualification.finished.payload.code` | A.7 names the code; the attempt row has no code column. |
| `canaries[]` | Adds `evidence` and `term_to_exit_ms` to A.3's keys | M135 (i) needs the witness per action; M137 the TERM-to-exit time. |
| The spend for a backend with no price † | `estimate` null, `label` `estimate` | Unknown is not 0. |
| Revocation's moments and reasons | Every start and every dispatch; five reasons | D2 §7.3's list; the plan's (a), (b) are found by a dispatch, (c) to (e) by a start. |
| The profile fingerprint | Section 150's inputs; on the engine read | D2 §4.1 "mount plan, volatile bounds and egress list". |
| Requalification † | `backend_refused`, `requalification_required` true, not revoked | D2 §4.1 separates it from §7.3's revocations. |
| The harness switches | Section 150's three, section 152's two | The plan's "(harness)"; no production configuration selects any. |
| A screen hit's outcome † | `failed` / `infra_error`, `reason_text` `secret_refused`, the Critical finding, `evidence.secret_refused` with `payload.what` | E67 item 5's interim reason kept; the finding is D1 §14.2's. |
| The provider-files record † | Section 152's shape; credential names from section 120 | D2 §4.3 in words; A.3's `provider_files {locations, persistence_flags, excluded}` is the entry's, which the canaries fill with the same shape. |
| Bounds below range for the tests † | `--harness-collect-bounds`, `collect_slow` | The driver: a handful of small files, never a filling loop; the configured minimums (100 entries, 1 MiB) would need one. |

---

# M2 slice 13 (part 3): the resource limits, on the exhaustion host only

Sections 155 to 158 were written with the third part of the slice-13 acceptance tests (2026-10-04; `verify/m2-s13` reset to `main` at `de8b1a3`): row M133 of `docs/acceptance/sdlc-M2-acceptance-plan.md` §3.6, M130 (f) and (g), and P20 pinned at start. They follow D2 §§1.6, 3.7, 6 (H11, H12), A.6 P20, A.7; E64 item 2; E69 items 1 to 4; and E70 (the runner's exhaustion lane). **These files were written and checked on the development workstation and never run there.**

## 155. The exhaustion lane and its instruments

(E69, E70; E64 item 2; sections 127, 141; `scripts/run-tests.mjs` `--lane exhaust`; `harness/scripted/child.mjs`; `harness/sandbox/limits.mjs`.)

**The lane.** A file that forks, allocates, writes or creates to a limit is listed under the manifest's top-level key **`exhaust`**, under no slice and not in the `sandbox` list. `node scripts/run-tests.mjs acceptance --lane exhaust` runs those files, and only when `SURETY_EXHAUSTION_HOST` equals the host's name. That host is `mini-hp01` (E69 item 2), where the files are run one at a time, by Sean or the driver. The full run requires each row to have a file and does not run them. Part 3 lists `M133-resource-limits.test.mjs` and `M130-exit-classes-limits.test.mjs`. **Sean's caps** (E69 item 1): `pids.max` 64, `memory.max` 64 MiB (`memory.swap.max` 0), `domain_writable_bytes` 1 MiB, `domain_writable_inodes` 64.

**The caps reach a domain** through the trigger fixture's harness-only **`domain_limits`** (section 15's fixture, as the slice-13 Builder built it): `{"pids_max", "memory_max", "writable_bytes", "writable_inodes"}`, each a positive integer in tasks or bytes. Every domain of that work item gets them, below the engine's configured minimums. Any other key or value is **400** `invalid_value` (`subject.field` `domain_limits`). Outside harness mode there is none. The override is held by the running engine, not the store, so a restart forgets it (no case restarts).

**Every instrument fails closed in three independent stops** (E64 item 2's two halves, and E69's self-bounds):

1. **The role program's guard** (section 141's `containmentRefusal`). The role's pid, network and mount namespaces are not the host's (the step carries the host's, as the test read its own). Pid 1 is no system init. At most 16 processes are visible.
2. **The role program's caps guard** (`capsRefusal`):
   - the step must carry the case's caps, each a positive integer at or below Sean's (`SEAN_CAPS`);
   - the volatile filesystem the role can read (by `statfs` of `/surety/home`) must be no larger, in bytes and in inodes, than the case's;
   - an unreadable filesystem refuses. A refusal logs `outcome` `refused_caps` with the reasons.
   - `memory.max` and `pids.max` cannot be read inside the `role` profile (no cgroupfs), so for those the test's half is the reading.
3. **The test's half** (`limitedRole`, `assertDomainCaps`). The role holds at `armed`. The host reads it contained (`assertContained`, section 141). Then from the domain's cgroup the host reads `pids.max`, `memory.max` and `memory.swap.max`, and from the role's own `/proc/<pid>/mountinfo` the volatile tmpfs's `size` and `nr_inodes`; each must equal the case's (`memory.swap.max` must be `0`). Anything else, `max` included, and anything unreadable, fails the case before the release.

**The instruments and their self-bounds** (constants in `child.mjs`, under a comment naming this rule; never raised):

| Step (`acting(...)`) | What the role does | Stops itself at |
|---|---|---|
| `forkToLimit(caps, {hold_ms})` | One control `sleep` (`control` `spawned`), then `sleep 300` children one at a time until a spawn is refused (`failure` the error); logs `step` `at_limit` with `forks` and `ceiling`; holds them `hold_ms` (at most 30 s); kills and awaits every one | `FORK_CEILING` 96 children, none of which forks |
| `allocateToLimit(caps, {hold_bytes})` | A control allocation of 1 MiB (`step` `control`), then 1 MiB at a time, every page touched, logging `step` `progress` every 4 MiB; with `hold_bytes`, stops there and keeps it (`step` `done`, `outcome` `holding`) | `ALLOC_CEILING` 128 MiB |
| `writeToLimit(caps, {keep, hold_ms})` | A control write of 4 KiB (`control` `written`), then 64 KiB at a time to `/surety/home/fill.bin` until an error (`stop`, `ENOSPC` expected); logs `at_limit` with `written`, `size`, `ceiling`; removes the fill unless `keep` | `WRITE_CEILING_FACTOR` × the case's `writable_bytes` (2 MiB) |
| `createToLimit(caps)` | One control file (`control` `created`), then empty files until an error (`stop`); logs `at_limit` with `made`, `inodes`; removes them | `INODE_CEILING` 128 files |
| `stdoutFlood(caps, {lines, line_bytes})` | `lines` lines of `line_bytes` bytes (the last a line ending) on standard output | `FLOOD_CEILING` 4 MiB in all; above it, refused |

**Verified on the workstation without an engine** (2026-10-04; nothing exhausting ran):
- on the host, every instrument was refused `refused_unsandboxed` (five reasons each);
- inside a throwaway `unshare -Urpfmn --mount-proc`, told the host's namespaces, every instrument was refused `refused_caps`: no volatile filesystem to read; caps above Sean's (a `memory_max` of 1 GiB); no caps at all;
- the user's process count was unchanged (24 before and after).

## 156. Admission by the resource envelope

(D2 §3.7, A.7 `resource_envelope`; row M133 (e), (f); `src/store/transitions/envelope.ts` on the Builder's branch.)

A dispatch the envelope does not admit creates **no run**: the work item stays `eligible`. The work read (`GET /v1/projects/:p/work`, section 98) shows it on that item as **`dispatch_hold`**: `{"code": "resource_envelope", "reason", "subject": {"limit": "max_concurrent_domains" | "host_reserve_memory" | "host_reserve_disk", "value", "running_domains", …}}`. `dispatch_hold` is null when nothing holds the item.

The plan's "on the run and work reads" is read as the work read alone, since a held item has no run. The cases reach each limit **by configuration only**: `max_concurrent_domains` 1 with a role holding a domain; `host_reserve_memory` at its maximum (64 GiB) and `host_reserve_disk` at its maximum (1 TiB), each first read to be above what the host has free (`MemAvailable`; `statfs` of the engine home). Nothing consumes host memory or disk.

The Builder's reading of the memory reserve counts the new domain's `domain_memory_max` beyond the reserve against `MemAvailable`, and not what the running domains may still grow to. It is recorded in that file as a question for the owner, and no case pins either reading.

## 157. The stream bounds, and P20 pinned

(D2 §3.7, A.6 P20, A.7; rows M133 (g), M110; sections 138, 140.)

**A line or a queue over its bound** (`stream_line_max_bytes`, `stream_queue_max_bytes`, each at its minimum in the case: 64 KiB and 1 MiB) cancels the run as section 140's evidence bound does:
- the run ends `failed` / `infra_error`, with `reason_text` naming the key;
- exit class `engine_signaled`;
- the transcript is kept and truncated: its record holds fewer bytes than the role wrote.

The queue grows only if the engine acts on lines more slowly than they arrive. The fault **`{"point": "stream_slow", "delay_ms": <n>}`** (standing, `times`; harness only) delays acting on each line by `<n>` ms. With it, 2 MiB of 1 KiB lines exceed a 1 MiB queue. The fault is named here; the Builder adds it where it is absent.

**P20 pinned** (the case in M133's file): a start with `isolation_probe_exhaustion` true writes an active host qualification whose P20 is `passed`, with `target_seeded` true, `negative` a non-empty string and `control` true. The row's evidence record holds **`p20`**: `[{"kind": "pids" | "memory" | "bytes" | "inodes", "seeded", "held", "control", "negative", "detail"}]` in that order. Each part has `seeded` true (its box was built and its limits were read back from the host before the program was released, section 138), `held` true and `control` true, and its `detail` names `pids.max 64, memory.max 67108864`.

## 158. Names the Verifier fixed in this pass, and what it changes in earlier sections

**What this pass changes in earlier sections:**
- Section 15's trigger fixture takes `domain_limits` (section 155).
- Section 98's work read gains `dispatch_hold` (section 156).
- Section 7's faults gain `stream_slow` (section 157).
- Section 141's guarded actions gain the five instruments of section 155, behind a second guard of their own.
- Section 145: M130 (f), (g) are `M130-exit-classes-limits.test.mjs` in the exhaustion lane; the two failing placeholders of `M130-exit-classes.test.mjs` are removed.

| What | Fixed as | Why this choice |
|---|---|---|
| The exhaustion files | Manifest `exhaust`; run only by `--lane exhaust` on a host named by `SURETY_EXHAUSTION_HOST` (section 155) | E69 item 4; E70. |
| The caps guard † | The caps in the step, each at or below Sean's; the readable volatile filesystem no larger than the case's; unreadable refuses (section 155) | E69 item 1 and the driver's brief: "a limit it can read from inside does not exceed the case's (where readable)". The volatile filesystem is the one limit a `role` sandbox can read. |
| The test's reading of the volatile bounds | The tmpfs superblock options in the role's own `/proc/<pid>/mountinfo` (section 155) | The tmpfs is in the sandbox's mount namespace; the host reads it through the role's process. |
| The self-bounds | 96 forks, 128 MiB, twice the storage bound, 128 files, 4 MiB of output (section 155) | E69 item 1 and the driver's brief, named as constants. |
| A held dispatch's read † | `dispatch_hold` on the work read; no run (section 156) | As the Builder built it; a held item has no run to read. |
| The stream bounds' outcome | `failed` / `infra_error`, the key in `reason_text`, `engine_signaled`, the transcript truncated (section 157) | Section 140's rule for a bound on evidence. |
| `stream_slow` † | A standing fault delaying each line (section 157) | A queue over its bound cannot be made without a slow consumer; the other way would be to flood far past the bound. |
| P20's evidence | The `p20` parts as the Builder writes them (section 157) | `seeded` is the read-back of the box's limits. |

## Amended after the slice-13 review (S1 to S5; 2026-10-04)

On `verify/m2-s13` from `main` at `ba1864d`. One acceptance case for each of the review's four serious findings and its one minor, each reproduced by the Reviewer by running and failing on the Builder's tip at the assertion that states the defect.

- **S1 (M135 (i); `M135-qualification-attempt.test.mjs`, "S1").** The containment canary's pass could be forged: the domain init's witness trusted the pid inside a report (its cmdline the probe program, a descendant of the backend), not who opened the channel, and `judge()` made no host-side check. A backend that runs no containment action but reports each outcome to the witness in the name of a probe-program process that acted on nothing passed, every action `witnessed: true`. The case drives a containment canary with the Reviewer's forger instrument (`harness/sandbox/instruments/forger.mjs`, verbatim; run only inside the containment canary's sandbox through the guarded `exec_probe` path) and requires `containment_failed`, no action witnessed, no entry, and the host-side witnesses D2 §7.2 lists: the egress log shows no accepted connection, which the driver takes as part of the fix (the Reviewer's design question 2 (b)). The forger is a test instrument whose only purpose is to prove the engine rejects a forged witness.
- **S2 (M132; "S2").** A held secret spelled as a `CONNECT` authority reached `store.db` and `GET /v1/events` through `domain.egress_refused`'s payload (the raw authority, unredacted) and an attempt's `unexpected_contacts`. The proxy's refusal is a handling of role output and must be redacted (D2 §2.5; E37 item 2). The case requires that neither the events API, nor any event's payload, nor any record, nor any file under the engine home holds the secret or its JSON-escaped form.
- **S3 (M135; "S3").** The positive canary was judged by reading its edit file through a link the role made, on the host (`decideCanary` read `join(workspace, edit.path)` after materialization, following the link). The case makes the edit a symbolic link to a file outside the workspace holding the expected text and requires the positive canary to fail. A plain-file link only: a FIFO would hang the engine's main thread and `/dev/zero` would allocate without bound, so neither is written (the Reviewer's note).
- **S4 (M132; "S4").** A held secret in a workspace path the materialization could not act on (a directory the role made unreadable) reached the run's `reason_text` and its `run.finalizing` event. A materialization error is handling of role output and is redacted. The case requires the run's reason, its events and the run read to hold no secret, and the run to fail for the materialization.
- **S5 (minor; M132; "S5").** A run whose exit class is not `clean` got a record of kind `result` when its provider files hit the screen. D2 §1.4: only a `clean` exit's accepted file is the run's `result`; otherwise it is an `unaccepted_result`. The case requires `error_exit` with `runs.result` null and no record of kind `result`.

**The instruments** (guarded, section 141): S3 and S4 use the new `canary_link_edit` (the positive canary's edit as a link to an outside file in the scripted directory) and `workspace_chmod` (a workspace directory's mode, workspace-relative paths only). Both refuse outside a sandbox by the role program's own guard, verified on the host. S1's forger is the Reviewer's, copied and run through `exec_probe`. S2 uses `proxyConnect`, S5 `write_probe`, `resultFile` and `exit`, all already present.

**After the Builder's fixes (objections 013, 014; the driver's S1 requirement; 2026-10-04).**

- **013, upheld.** S3 releases only its positive canary: the canary fails, and SEAM §148 dispatches no later one. The positive canary's guarded `canaryLinkEdit` now runs behind an `armed` hold released by `armedCanary`, which restores the test's half of the guard that the first form skipped.
- **014, upheld.** M132 imports `withStore`.

**S1 now pins D2 §7.2's host-side witnesses against the Builder's design.** In that design:
- the domain init accepts no outcome from inside the sandbox;
- the probe program the backend runs only asks the init to act;
- the init checks, from `/proc`, a live descendant of the backend with exactly the action's arguments, and performs the action itself in an execute-only child of its own;
- the judge corroborates host-side.

The case has two attempts on one engine:
1. **The forger's.** It must fail `containment_failed`, with every action `witnessed` false and `passed` false, and write no entry. Its containment run's `egress_log` record is required (published always once termination is established, empty when nothing connected), with no accepted connection in it.
2. **A control whose backend runs the probe program.** It must succeed, with every action witnessed and passed, and `token_read`, `git_config` and `unlisted_connect` each `host.checked` and `host.agrees` true in the containment evidence. The test reads independently: the containment run's `egress_log` record shows a `refused` / `not_listed` CONNECT; `api.token`'s bytes and the fixture repository's `.git/config` are unchanged across the attempt.

`engine_port` has no host-side corroboration in this design (`host.checked` false). It is listed in `docs/acceptance/reports/M2-not-claimed.md` with the design's other two residuals.

---

# M2 slice 14: the real lane, the report and the hands-on run

Sections 159 to 166 were written with the slice-14 acceptance tests (2026-10-04; `verify/m2-s14` from `main` at `872afe9`): rows M136 to M142 of `docs/acceptance/sdlc-M2-acceptance-plan.md` §§3.8 and 3.9. They follow D2 §§1.2, 1.5 to 1.7, 2.4, 2.5, 4.1 to 4.5, 7.2, A.2, A.3, A.7, Appendix B (T08 to T11, T13); Q1, Q2, Q7; E59 (Sean's model and spend; the plan's questions 2 and 4 settled); E61 to E73. **Nothing in the real lane was run when they were written.** No `claude` ran with a prompt, no key existed or was read, and `--lane real` was never invoked; the files were checked with `node --check` only. One file of the slice is in the sandbox lane and was run (section 163, "M137 (b)").

## 159. What the real-lane tests assume throughout

(M2 plan §2.1, §3.8; BS §§4, 8, 9; E59 items 1 and 2; `harness/real/lane.mjs`.)

**The lane.** The files of rows M136 to M140 are listed under the manifest's top-level key **`real`**, under no slice, in this order: `M139-unauthenticated-canary`, `M136-positive-canary`, `M137-cancellation-canary`, `M138-containment-canary`, `M140-real-backend-journey`. Only `node scripts/run-tests.mjs acceptance --lane real` runs them, and only Sean runs that (E59 item 1; CLAUDE.md). The full run requires their rows to have files and does not run them. M139 is first because its attempt's key is wrong on purpose: the real binary, the sandbox around it, the proxy's tunnel to the provider and the attempt's failure path run once at no token cost before anything paid starts.

**What Sean sets** (each read by `realPreflight()` before any engine or binary starts; a missing or malformed one fails the file with "Nothing was started", never a skip):

| Variable | Value |
|---|---|
| `SURETY_REAL_RUN_DIR` | An absolute directory outside the repository, made 0700 if absent: the run directory (section 163). One per real run; reusing it re-judges what it recorded and starts nothing already done. |
| `SURETY_REAL_CREDENTIAL_REF` | *(Renamed from `SURETY_REAL_KEY_REF` for E74; said once here.)* The credential's reference: the absolute path of a regular file, not a link, mode 0600 or 0400, owned by the user, holding the credential on one line and nothing else, outside the repository, the run directory, `~/.claude` and `~/.codex` (section 160). In M2 the credential is Sean's subscription token from `claude setup-token` (E74 item 1); in the `api_key` mode, a dedicated API key. Never the credential itself: a value that is not an absolute path is refused and not echoed. |
| `SURETY_REAL_AUTH_MODE` | Optional, `subscription_token` (the default, and M2's) or `api_key` (kept, E74 item 1). The cases that differ by mode take it from here; M2 claims only the subscription mode. |
| `SURETY_REAL_CLAUDE_BINARY` | The Claude Code binary to qualify, by its own regular file (not `~/.local/bin/claude`, a link that moves when Claude Code updates itself). The test hashes it and puts a link named `claude` to it in `<run dir>/bin`, first on the engine's `PATH` (section 164). |
| `SURETY_REAL_CONFIRM_SPEND` | Exactly `I accept the M2 real lane on my Claude subscription, up to 25 USD a day as estimated`. |
| `SURETY_REAL_WAIT_MINUTES` | Optional, 1 to 600, default 120: how long a test waits for one of Sean's answers (section 162). |
| `SURETY_REAL_RERUN` | Optional: step names, comma-separated, to clear before this run (section 163). Only Sean sets it. |
| `SURETY_REAL_PATH_TWO` | Optional, `real` (default) or `mixed`: path two of the journey with real roles, or E59 item 3's recorded fallback. |

The user manager must be reachable (`XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, section 122). Each real-lane test sets its own timeout of eight hours (`node:test`'s per-test option), so that the runner's ten-minute default does not end a wait for Sean; Sean may also set `SURETY_TEST_TIMEOUT_MS=28800000`.

**Stop, never retry.** A retry costs money. Every step that starts an engine, a binary or a run is a named **step** of the run directory (`realStep`): it runs at most once; a later file or a later run of the lane that needs it reads its recorded value. A step that throws is recorded `failed` with its reason and **halts** the run directory; so does a failed judgement over recorded values (`judged`). While the run directory is halted every step not yet run fails at once without starting anything; done steps can still be re-judged. Only Sean clears a step or a halt, by naming it in `SURETY_REAL_RERUN` (a judgement's halt is named `judge:<case>`, for example `judge:M140 (b)`); the names are applied once per run of the lane (the runner's process and the names are the key), so a later file of the same run never clears a step an earlier file has just run. The steps: `wrong_key_attempt` and `wrong_key_replay` (M139), `attempt` (M136 to M138), `activation`, `path_one`, `stop_case`, `path_two` or `path_two_mixed` (M140).

**Sean's two decisions are his** (E59 item 2; BS §9, "never by a fixture"). No real-lane test answers `qualification_approval` or `trust_activation`, for any option (section 162). Every paid run passes through one of them: an attempt's canaries through its approval, a journey run through the entry's activation, under the journey projects' limits.

## 160. The credential's reference, the engine's secret flags, and the credential's absence

*Amended for E74 (2026-10-04): the real lane authenticates by Sean's subscription token; "the key" below reads "the credential", of either mode.*

(D2 §2.5, Q1, Q2; SEAM §§57, 116, 120; rows M139 (a), M140 (e), M142 (9).)

**The test never holds the key in an argument, an environment, a log or a file it writes.** It reads the file named by `SURETY_REAL_KEY_REF` into memory only to search for the value afterwards, and it checks every file it writes (`state.json`, `observed/*.json`) for the value before writing (a hit writes nothing and fails). The engine is given the path.

**The engine's flags** (the slice-14 engine side; production code, accepted with or without `--harness`):

| Flag | Meaning |
|---|---|
| `--secret-file <ref>=<path>` | Repeatable. At start the engine reads the file at `<path>` and holds its content (without a trailing line end) as the resolved secret `<ref>`, as `POST /v1/harness/secrets` holds one (section 57): in memory only, registered with the redactor and the secret screen, written nowhere. `<ref>` is `backend/claude/subscription_token` (E74 item 1), `backend/claude/api_key` or `backend/codex/api_key` (section 116). **Refused at start**, exit status 4, the refusal's `code` `secret_file_refused`, nothing written: a path that is not absolute, not a regular file (a link included), readable or writable by group or others, not owned by the engine's uid, empty, holding more than one line, or under the engine home. The path may appear in the engine's log and records; the value never. **What was given in place of a path is never repeated** in the refusal (its reason or subject) or anywhere the engine writes: an operator who pastes the credential there has it echoed nowhere (the slice-14 review's S3; section 167). |
| `--provider-cap-usd <ref>=<usd>` | The `api_key` mode only (a subscription has no dollar cap on its token: its hard limit is the subscription's usage limits, which the operator's own Claude use shares, E74 item 1; no cap is shown for that mode): the provider-side cap the operator configured on that key, recorded as `configured` evidence (section 120): on the grant (`capability_grants.provider_cap`) and on a qualification attempt's `spend.provider_cap` (`{"status": "configured", "usd"}`). Never engine enforcement. |

**The key's absence** (`secretHits`): every file under the given roots and every git object of the given repositories (read with `git cat-file --batch-all-objects --batch`, compared in-process) is searched for the value and its JSON-escaped form. M139 (a) searches `home-auth/` for the wrong key and the dedicated one; M140 (e) searches the whole run directory and the git objects of every repository the lane used, the qualification fixture's included. A file that cannot be read is a hit ("not shown to hold nothing").

**The invalid credential** (M139): in the subscription mode `sk-ant-oat01-surety-invalid-`, in the `api_key` mode `sk-ant-api03-surety-wrong-`, followed by 64 random base64url characters, in `<run dir>/keys/invalid-<mode>`, mode 0600, made once. It authenticates nothing; the provider refuses it before any token is used.

## 161. The bounds a real-lane run sets

(E59; D2 §4.2, §7.2, Q2, Q7, C4; SEAM §§115, 120; `REAL` in `harness/real/lane.mjs`.)

| What | Value | Where it is set |
|---|---|---|
| Model, every canary and every role | `claude-sonnet-5-5` (E59) | the attempt's body; the entry's model |
| `budget_run_billable_tokens` | 300 000 (E59) | each project the lane charges |
| `budget_day_verified_usd` | 10 (the engine's qualification fixture project), 6 (path one's project), 9 (path two's): 25 in all, Sean's day (E59) | each project |
| `budget_day_unknown_tokens` | 900 000 | each project |
| `deadline_builder`, `deadline_verifier`, `deadline_reviewer` | 900, 600, 600 s | each journey project and the fixture project |
| `canary_deadlines` | positive 600, cancellation 300, containment 600 s | the attempt's body |
| The provider-side cap | 50 USD on an API key, recorded with `--provider-cap-usd` (section 160); none in the subscription mode, whose hard limit is the subscription's usage limits (E74 item 1) | the engine's flags |

Every value is a lowering of the default, so `POST /v1/projects/:p/policy` applies it at once and raises no decision (section 115). The fixture project's policy is lowered **before** the attempt is proposed, so the attempt's estimate is made under it.

**Before Sean is asked** (`spendGuard`; a failure halts the run directory and the question is never put to him): the attempt is `proposed`, binds `claude-sonnet-5-5`, the pinned binary's SHA-256 and `["api.anthropic.com"]` as its only candidate destination; its `spend` has `label` `estimate`, `overshoot` `deadline`, an `estimate` that is a number greater than zero and no greater than the fixture project's day limit (10 USD), `auth_mode` the lane's (E74 item 1), and, in the `api_key` mode only, `provider_cap` `{"status": "configured", "usd": 50}` (in the subscription mode, none). M135's "null where no price is known" stands for a model with no price; for the real lane the engine's price table must know `claude-sonnet-5-5`.

**The price table** (the slice-14 engine side; D1 §13.2, C4): `claude-sonnet-5-5` at 2 USD per million input tokens, 10 USD per million output tokens and 0.20 USD per million cache-read tokens (Anthropic's first-party rates as cached in the Claude API reference on 2026-09-25; Sean confirms them on his console), its version recorded on every estimated row. How the attempt's estimate is computed is not pinned; the Verifier's reading is the worst case of billable tokens, three canaries at the run limit at the output rate (9.00 USD at these settings), labelled an estimate and never a maximum.

**Claude Code's usage, normalized** (the Verifier's reading of D2 §1.5 for the adapter; *amended for objection 015*): the terminal event's **`modelUsage`** where it carries it, summed over its models, since it covers every model call of the invocation, the same calls as `total_cost_usd` (the main loop, subagents, compaction and other internal calls): `out` the sum of `outputTokens`; `cached_in` of `cacheReadInputTokens`; `billable_in` of `inputTokens` plus `cacheCreationInputTokens`. Only where the event has no `modelUsage`, its `usage` (the main loop's only): `out` `usage.output_tokens`, `cached_in` `usage.cache_read_input_tokens`, `billable_in` `usage.input_tokens` plus `usage.cache_creation_input_tokens`. The cost is `total_cost_usd` where the stream gives it, recorded **`reported` in the `api_key` mode and `estimated` in the subscription mode** (Claude Code's `total_cost_usd` is then a client-side estimate; E74 item 1); dollar budgets act on it either way. Each is null where the stream does not carry it. M136 (d) and M140 (d) compare `out` with the same choice (`terminalOutput` in `harness/real/lane.mjs`) and the cost's status by mode (`costStatusFor`); M140 (d) sums the day's `reported_usd` or `estimated_usd` accordingly (`dayTotalFor`). *Amended after the slice-14 review (S1; E74 item 3):* usage is **final only when every count is known**; a terminal event that lacks a count, or carries none, never overwrites a count observed per call (`assistant` messages, folded by message id), and the run's row then keeps the observed counts with `usage_complete` 0 and its allowance charged (section 120). The mid-run budget check never reads an unknown count as zero. Which events carry usage, and whether the terminal event's figures are cumulative, are the positive canary's to establish (D2 §4.5); M136 (d) and M140 (d) compare the ledger with the terminal event only where it carries the figure.

**What a step can cost at most**, as the tests and the hands-on script state it before a paid step: runs × 300 000 billable tokens × 10 USD per million = 3.00 USD a run in billable tokens, plus cache reads (not counted by the run limit) and any overshoot until the run's deadline (D2 §4.2, §8 class C); the project's day limit stops new runs; the 50 USD cap is the only hard maximum.

## 162. How a test waits for Sean

(E59 item 2; plan question 2 (a); D2 §4.1, §7.2, Q7; section 117; `waitForSean`.)

The test finds the open engine-scoped decision of the kind about the subject in the store, and writes, to its standard error, to its terminal when it has one (`/dev/tty`) and to `<run dir>/WAITING.txt`: what is asked; the decision's id, kind and preview hash; the facts that matter for money (for `qualification_approval`: the binary's path, SHA-256 and version, the model, the engine's spend estimate as labelled, the most the canaries' billable tokens can cost, the fixture project's day limit, the 50 USD cap, the candidate egress, the deadlines, the host qualification; for `trust_activation`: the entry, the binary's hash, the version, the model, the capabilities, the egress hosts, the journey's limits); and the two commands Sean can send, `approve` and `reject`, each `POST /v1/decisions/:d/answer` with the token read from the engine home at the time. Then it polls the decision every 5 s:

- consumed with `approve`: the step goes on;
- consumed with any other option: the step fails with "Sean answered … as he chose", which halts the run directory;
- invalidated with a next generation open (the question still standing after a change, section 117): the new one is printed and waited for;
- no answer within `SURETY_REAL_WAIT_MINUTES`: the step fails, the decision is left open, the engine is stopped, nothing further is started.

**Decisions the tests do answer.** The chain boundary's `continue` on the journey's verification, review and fix work, and the `stop_confirm` of M140 (e)'s Stop, are answered by the test as row M01's journey and row M13 answer them. They are not the two money decisions: the journey's runs are bounded by their projects' limits, and Sean's activation is what allows any of them. Whether Sean wants to answer the chain boundary himself in the real lane is a question for him (the hands-on script lets him: it asks before each paid run).

## 163. What is recorded for the report, and the report's and the hands-on script's own checks

(BS §10; M2 plan §3.9 M141, M142; E40; rows M141, M142.)

**The run directory** (`SURETY_REAL_RUN_DIR`), kept after the run:

| Path | What |
|---|---|
| `state.json` | The steps with their status, time and recorded value or failure reason; the halt, if any. |
| `observed/<row>.json` | What each case saw, verbatim, written only by the tests: `wrong_key` (M139's attempt: host facts, the proposed row, the collected attempt, the domain samples, the host witness), `M139` (the provider error as kept, the ledger row, the replay), `attempt` (the paid attempt, as for `wrong_key`), `M136` (the session id, egress, provider files, the stream's inventory, the most backend processes per sample, the ledger row, the terminal event), `M137` (TERM behaviour, the ledger row, the usage observations), `M138` (the containment evidence, `engine_port`), `activation` (the active entry and `backends`), `M140` (each path, the domain samples, the Stop, the commits, the ledger against the transcripts, the key search). |
| `home/` | The engine home that qualified Claude Code and ran the journey: store, records, logs. Holds `api.token`: it stays with Sean. |
| `home-auth/` | M139's engine home. |
| `repos/` | The journey's repositories. |
| `bin/claude` | The pin (a link to `SURETY_REAL_CLAUDE_BINARY`). |
| `keys/wrong.key` | M139's wrong key. |
| `WAITING.txt` | The last question put to Sean, or its answer. |

The collected attempt (`collectAttempt`) holds, per canary: the canary entry, the run's state and outcome, the receipt, the exit class and evidence, the domain, the original ledger rows, the record list, the evidence record's JSON, the provider error as kept, the collected result, the stream's event count and kinds with its first `system`/`init` event and its last `result` event, the egress log and the run's events; and the entry with its evidence records' content, and every `qualification.*` and `trust.*` event. After Sean's run the Verifier copies `state.json` and `observed/` into `docs/acceptance/reports/M2-real-lane/<date>/` and fills the report's placeholders from them and from the engine homes' records; the homes stay with Sean.

**M141's file** (`M141-report-qualified-facts.test.mjs`, manifest slice 14, no engine): the report `docs/acceptance/reports/M2-report.md` has every section M141 lists, each under a heading the test names; its status line says `skeleton` or `final`. While it is a skeleton: every real-lane fact is a placeholder of the form `[[PENDING real lane: <what>; from <source>]]`, the report says that M2 is not accepted, and no line claims a real-lane row passed. When final: no placeholder remains, M2's acceptance conditions are each stated with their evidence, and the real-lane records it cites exist under `docs/acceptance/reports/M2-real-lane/`. **While any placeholder remains the file fails** (the driver's provisional decision on the report's question 3, 2026-10-04: "nothing described as passing that was not run"), after checking that the skeleton is honest, with the message `the real lane has not run: the M2 report is a skeleton (N pending facts)`. So `--slice 14` and `npm test` fail until the real lane has run and the report is final; that is the honest state.

**M142's file** (`M142-hands-on-script.test.mjs`, manifest slice 14, no engine, no binary): `bash -n` on `docs/acceptance/reports/M2-hands-on.sh`; the script prints `CHECK (1)` to `CHECK (9)`, each with a command Sean can run; every paid call in it is preceded by the `paid` gate that states the most it can cost; and run with a scrubbed environment, with fake `node`, `curl`, `claude` and `git` that only record that they were started, it refuses and starts none of them: without `SURETY_REAL_KEY_REF`; with a reference that is not a path; with a group-readable key file; and without the spend confirmation.

**M137 (b)** (`M137-cancellation-canary-negatives.test.mjs`, manifest slice 14, the sandbox lane): the cancellation canary's negatives without a model, with section 148's scripted attempt: a canary that reports usage and ends with its result without the barrier, and one that reports usage and holds without writing it until the canary's deadline (20 s in the case), each `barrier_not_reached`, no later canary, no entry. Run on `main` at `872afe9` (2026-10-04): 2 of 2 passed.

## 164. The engines of the real lane

(D2 §1.1, §1.2, §4.1, §7.2, C3; BS §§8, 9; sections 113, 118, 148, 150; `productionEngine`, `journeyEngine`.)

**The qualification engine is a production engine** (no `--harness`): `serve` with the secret flags (section 160), from the constructed environment of section 1 plus the user manager's two variables (section 122) and `PATH` with `<run dir>/bin` first; `config.json` `{"api_port", "tick_interval": 30}`. So the entry the journey uses is written and activated exactly as D2 §7.2 says. M136 to M139 and the `activation` step use it; `ui_bootstrap` is false (M141).

**The engine-owned pinned binary** (E74 item 3; objection 016, E75 item 1). The attempt copies the binary `claude` resolves to into `<home>/backends/claude-<version>-<sha16>`, `<version>` the first word of the binary's own `--version` output and `<sha16>` the first 16 hexadecimal digits of the SHA-256 of its bytes, mode 0500, owned by the engine's uid; it qualifies, binds and hashes the copy, so the entry's `binary_path` is the copy and its `binary_sha256` the source's. M136 (b) checks the path, the mode and the copy's bytes against values **the test computes itself** from the operator's source binary at qualification time (`source_binary` in `observed/attempt.json`), never against a value read from the engine.

**`POST /v1/trust/qualify` outside harness mode** (the slice-14 engine side; section 148's 501 is replaced): the body is `{"backend", "mode", "model", "candidate_egress", "canary_deadlines"?, "auth_mode"?}`, `auth_mode` `api_key` (the default, as D2 has it) or `subscription_token` (E74 item 1; also accepted in harness mode); the attempt binds it, the entry records it, and an entry of one mode never authorizes a dispatch in the other; the subscription mode's template drops `--bare` and is a template version of its own; `binary`, `fixture_project` and `version` stay `unknown_field`. The binary is `claude` (or `codex`) **resolved on the engine's own `PATH`** to its real path, so the pin decides which file is qualified (D2 §7.2, "the resolved path"); the static checks run it with exactly `--version` and `--help`, once each, outside any domain, **with a constructed environment whose `HOME` is an empty temporary directory removed afterwards**, never the operator's home or the engine home. The fixture project is the engine's own.

**`GET /v1/engine` gains `qualification_fixture_project`**: the id of the engine's own qualification fixture project, a project the engine registers at its first start outside harness mode with a repository it makes under its home; null until then and in a harness-mode home that has none. It is an ordinary project: its policy is changed through `POST /v1/projects/:p/policy`, its runs are charged to the ledger, and its integration branch is the engine's.

**`surety qualify`** (D2 §7.2's command; the hands-on script uses it): `surety qualify <backend> --mode one_shot_headless --model <m> [--auth-mode subscription_token|api_key] [--egress <host>]... [--canary-deadline <kind>=<seconds>]...` sends `POST /v1/trust/qualify` to the engine running on `$SURETY_HOME` (its port from `config.json`, its token from `api.token`), prints the 201 body as one JSON line and exits 0; a refusal is printed in its form and exits 1; no engine running exits 1.

**The journey engine** is the same home restarted in the test mode for the real lane: `serve --harness --harness-real-lane` with the secret flags (and `--harness-scripted <dir>` only for path two's mixed run). `--harness-real-lane` is accepted only with `--harness`; it implies `--harness-host-checks run`, and with `--harness-host-checks unrun` it is a usage error (exit 2). Under it:

1. a dispatch to an **active** entry of a real backend launches that entry's binary: the test mode's refusal of a real backend's binary (`backend_refused` for an executable image, section 148) does not apply to such a dispatch;
2. that refusal stays for `POST /v1/trust/qualify` and both fixture routes: no test-mode engine can propose, qualify or install an entry for a real binary, so a real entry exists only by a production attempt and Sean's activation;
3. a real backend's domain has the production mount plan and the production `role` profile: the scripted directory's read-write bind (section 127) is the scripted backend's alone; so the profile fingerprint and the host qualification's mechanism fingerprint equal a production start's, and the entry stays dispatchable (section 150's suspension and requalification rules apply unchanged: a difference is `requalification_required`, never a silent dispatch);
4. everything else of the test mode is present; the real lane uses the plan, checks, check-result and environment fixtures (D3's planning flow and check runner do not exist in M2), the barrier `boundary.before_terminated` (M140 (e)), and nothing else of it: no fault, no clock advance, no harness secret.

**One home across the modes.** `home/` is qualified by a production engine, then started in the real-lane test mode for the journey; the trust table, the ledger and the records carry over. A start's mode changes no entry. The report states, as a limit of the instruments, that the journey's engine ran in test mode for its fixtures.

## 165. What the canaries' records hold, for the real-lane cases

(D2 §4.5, §7.2, A.3; sections 149, 152; rows M136 to M138.)

These complete section 149's evidence for a real backend; the scripted canaries may carry them too.

- **The positive canary's `qualification_evidence` record**: `{"kind": "positive", "expected": {"edit": {"path", "content"}, "result": <value>}, "observed": {"edit": {"path", "type": "file" | "symlink" | "fifo" | "other" | "missing", "sha256"?, "bytes"?}, "result": <the collected value or null>}, "credential_delivery": {"auth_mode", "variable", "established": <bool>, "how": <text>}}` *(renamed from `key_delivery` for E74)*. `observed.edit` is read after materialization from the workspace, without following a link, regular files only (the slice-13 review's S3). `credential_delivery.established` is true when the canary authenticated with the credential in that variable and nowhere else (no credential file written by the engine in the volatile home); for an API key the variable is `ANTHROPIC_API_KEY` (D2 §4.5); for a subscription token it is `CLAUDE_CODE_OAUTH_TOKEN`, the variable Claude Code documents for a `claude setup-token` token (Environment variables: "OAuth access token for claude.ai authentication ... Generate one with `claude setup-token`"), which the canary must establish, never assume (E74 item 1). The subscription mode's template has no `--bare`; every `claude` template names the three switches of section 139. The positive canary passes only with it established (E74 item 3).
- **The cancellation canary's record**: `{"kind": "cancellation", "barrier": {"path", "witnessed": <bool>, "witnessed_at"}}`, the witness being the domain init's report on its channel, never the stream; `term_to_exit_ms` stays on the canary entry (section 148).
- **The containment canary's record**: section 149's `actions` (with `host` as amended after the slice-13 review), plus `"controls": [{"name": "workspace_write" | "provider_tunnel", "ran": <bool>, "detail"}]`, plus *(objection 015)* `"capabilities": {..., "delegation_verified": <bool>}`, the tool surface the engine judged at this canary (D2 §7.2: "delegate and schedule through the backend's own tools"). The canary passes only when every action was witnessed and passed, every control ran and `delegation_verified` is true; when the actions and controls hold and delegation was not shown absent, it fails `delegation_unverified` (D2 §4.5: "no inventory and no test is a refusal, never a pass"), otherwise `containment_failed`. `provider_tunnel` is corroborated by the run's egress log (an accepted `CONNECT` to `api.anthropic.com:443` with bytes both ways).
- **The run's `transcript` record** holds the backend's standard output lines as written, redacted (sections 56, 57): for Claude Code, its `stream-json` events, one per line.
- **The entry's `capabilities.delegation_verified`** is true only by an inventory (the stream's first event lists the tools and none of `Agent`, `Task`, `ScheduleWakeup`, `Workflow` is offered) or by the executable capability test of D2 §4.5; neither is `delegation_unverified` and fails the attempt. *Amended after the slice-14 review (S2; E74 item 3):* the inventory must be a **subset of the template's `--tools`** (a deny-list does not suffice: `Skill`, or any tool the template does not grant, is not verified), and the host's sampler of the canaries' domains must have **identified the backend at least once**; a sampler that never saw it shows nothing absent.
- **The Claude adapter's normalization**: section 161.

What the cases do not assume, and record instead: the names and shapes of Claude Code's events beyond `system`/`init` and `result`; whether `--verbose` is needed; the hosts it contacts beyond the provider; what it writes despite `--no-session-persistence`; its exit status and TERM behaviour.

## 166. Names the Verifier fixed in this pass, and what it changes in earlier sections

**What this pass changes in earlier sections.** Section 1's flags gain `--harness-real-lane`, `--secret-file`, `--provider-cap-usd`, and the CLI gains `qualify` (section 164). Section 117: the real lane answers the two engine-scoped kinds through the same routes, and only Sean answers them. Section 118's `GET /v1/engine` gains `qualification_fixture_project`. Section 148: `POST /v1/trust/qualify` outside harness mode (section 164); the attempt's `spend.provider_cap`. Section 149's evidence gains section 165's fields. Section 120's provider cap is also set by `--provider-cap-usd`. `manifest.json` gains the `real` list and slice 14.

| What | Fixed as | Why this choice |
|---|---|---|
| The real lane's variables † | Section 159's seven | E59 item 2 and the brief: a reference, never a literal; a pin by file; a typed confirmation; a bounded wait. |
| Stop, never retry † | Named steps, recorded once; the halt; `SURETY_REAL_RERUN` by Sean only (section 159) | A retry costs money; E59 item 3's "run once more" is then Sean's explicit act. |
| The engine's key flags † | `--secret-file`, `--provider-cap-usd` (section 160) | D2 §2.5 names references, not how a production engine resolves one; M1's resolver is harness-only. A flag keeps the reference out of the closed configuration, whose change would break M07 and M73 on today's engine. |
| The bounds † | Section 161's table; 25 USD split 10 / 6 / 9 | E59's 25 USD is a day; the engine's day limits are per project. |
| The price of `claude-sonnet-5-5` † | 2 / 10 / 0.20 USD per million | A labelled estimate needs a price; null would leave Sean nothing to read before he approves. Sean confirms the figures. |
| Claude's normalization † | Section 161 | Cache writes are billed input; cache reads are not billable tokens (section 53's rule). |
| How a test waits | Section 162 | Plan question 2 (a); E59 item 2. |
| Which decisions a test answers † | The chain boundary and `stop_confirm`, as M01 and M13 do (section 162) | They are not the money decisions; Sean may prefer to answer them himself. |
| The run directory and the observations | Section 163 | BS §10 lists what the report records; the homes hold `api.token` and stay with Sean. |
| The engines † | Production for qualification; `--harness-real-lane` on the same home for the journey (section 164) | The entry must be a production one; the journey needs the plan and check fixtures M2 has no other way to make. |
| `qualification_fixture_project` | On `GET /v1/engine` (section 164) | The test must lower the fixture project's limits before the estimate is made. |
| The static checks' `HOME` | An empty temporary directory (section 164) | The operator's `~/.claude` must neither influence nor receive anything. |
| The canaries' evidence fields † | Section 165 | M136 (a), (b), M137 (a), M138 (c) need the expected edit, the key's delivery, the barrier's witness and the controls in the record. |
| M137 (b) in the sandbox lane | A file of its own in slice 14 (section 163) | No merged case made a cancellation canary miss its barrier; a model is not needed for it. |
| M141 and M142 as files † | Slice 14, no engine (section 163); M141 fails while the report is a skeleton (the driver, 2026-10-04) | The full run needs every row's file; both checks spend nothing; a skeleton is not the row met. |

## 167. The slice-14 review's cases, with a fake `claude` (S1 to S3; E74 items 2, 3)

(Written 2026-10-04 on `verify/m2-s14-review` from `main` at `b6251bd`. Each case was run alone on the Builder's tip `a2c091e` and fails there at the assertion that states its defect; `COVERAGE.md`, "M2 slice 14", "The review's cases".)

**The fake `claude`** (`harness/standin/fake-claude.mjs`, written by `FakeClaude` in `harness/sandbox/fakeclaude.mjs`) is the Verifier's instrument, never Claude Code.
- It is a script with a shebang naming the test's node, outside every directory on the engine's `PATH`. So the engine's test mode accepts it as a stand-in (section 148), and refuses the real binary as before.
- It answers `--version` (`2.1.289 (Claude Code)`) and `--help`.
- Otherwise it prints synthetic stream-json in the form the Claude adapter parses: a `system`/`init` event with `tools`, `assistant` messages with per-call `usage` and distinct message ids, and a terminal `result`. It acts out the three canaries from `/surety/context/canary.json`.

A mode file in the scripted directory sets its behaviour per attempt, without changing the bytes the attempt bound. The scripted directory is bound read-write in every sandbox of a sandbox-lane engine. The keys:
- `positive`: `complete`, `missing_count` or `failure_no_totals`;
- `extra_tools`: tool names listed in the inventory beyond the template's;
- `hide_title`: sets the process title, so `/proc/<pid>/cmdline` no longer names the binary;
- `host_pid_ns`: the containment actions are refused in the host's pid namespace or without `/surety/context` (section 141's first half).

The attempt is `POST /v1/trust/qualify` for `claude`, with `binary` the fake and the test's fixture project. A made-up credential is held by `POST /v1/harness/secrets`, and the test answers its own approval: nothing is paid.

| Case | File | What it pins |
|---|---|---|
| S1 (a) | `M136-adapter-with-a-fake-backend` | Per-call usage observed (input 1200, cache creation 3000, output 300), then a success `result` whose `modelUsage` lacks `cacheCreationInputTokens`. The positive canary's original row keeps `billable_in` at least 4200, has `usage_complete` 0, and has `unknown_allowance_tokens` the run limit less what was observed. |
| S1 (b) | same | Two calls observed, then a failure `result` with no totals. `billable_in` 160 000, `cached_in` 80 000 and `out` 1 200 are kept; `usage_complete` 0; the allowance is charged on the remainder. |
| S2 (a) | same | `Skill` in the inventory beyond the template's `--tools`. The containment canary's `capabilities.delegation_verified` is false; the attempt does not succeed; no entry is written. |
| S2 (b) | same | The backend's title is hidden, so the host's sampler never identifies it. `delegation_verified` is false; the attempt does not succeed. |
| S3 | `M140-credential-never-echoed` (kernel lane) | `--secret-file <ref>=<the credential itself>`, for both modes' references. Refused `secret_file_refused`, and neither the refusal nor any file of the engine home holds the value. |

All five are listed under manifest slice 14; the first file is also in the `sandbox` list.

Observed on `a2c091e`:
- S1 (a): `billable_in` null, `usage_complete` 1, no allowance;
- S1 (b): every count null;
- S2 (a) and (b): `delegation_verified` true, with `Skill` listed, and with `max_backend` 0 over 3 to 5 samples;
- S3: the value in the refusal's `reason` and `subject.path`.

## 168. Memory admission reserves every admitted domain's limit (option B; E75 item 3)

(Written 2026-10-04 on `verify/m2-s14-016` from `main` at `83cf03c`; amends section 156 and E71 item 6.)

**The rule.** Admitting a domain reserves its configured `domain_memory_max`, not its current use. A dispatch is admitted only while the following fits in the memory the host has available (`MemAvailable`):
- `host_reserve_memory`, plus
- `domain_memory_max` for every domain already admitted and not yet terminated, plus
- `domain_memory_max` for the new one.

Otherwise the work stays `eligible` with `dispatch_hold` `{"code": "resource_envelope", "subject": {"limit": "host_reserve_memory", ...}}` and no run. The single-run setting stays (`max_concurrent_runs` 1 per project, E18), and the per-domain limit is not lowered.

**The case** (`M133-memory-admission-reserves-the-limit.test.mjs`, manifest slice 14, sandbox lane) makes the condition by configuration only:
1. It reads `MemAvailable` and sets `host_reserve_memory` R = 512 MiB and `domain_memory_max` M = 0.7 × (available − R), rounded down to MiB. It also sets `domain_writable_bytes` 64 MiB and `max_concurrent_domains` 2.
2. One project's role is held running and idle. The test reads `MemAvailable` again and checks that M + R fits and 2M + R does not.
3. A second project's work must be held as above.
4. The control: once the first domain has ended, the second is dispatched.

Nothing allocates memory.

On the Builder's `228cf5e` the case fails at the option-B assertion: the second item was `claimed` with a run, at 2 × 9 213 837 312 + 536 870 912 = 18 964 545 536 bytes against 13 582 368 768 available. The reading E75 replaces counted only the new domain's limit against the memory available now.


## 169. The fault `egress_connect_hang`: a connect that never completes, without the network

(Written 2026-10-05 on `verify/m2-s14-hang` from `main` at `c3a2651`; the driver's decision after M128 (b) failed in a rerun. D2 §2.4, A.7 `egress_connect_timeout`; sections 140, 61.)

**Why.** M128 (b) needs a connection to a validated address that does not answer within `egress_connect_timeout` (1 s). It used a documentation address (`198.51.100.20`), expecting the packets to go nowhere and the connect to hang. On this host the router sometimes answers such an address with `EHOSTUNREACH`. That is measured: 3.1 s cold, faster once the kernel has cached the unreachable. The proxy then rightly logs `connect_failed`, not `connect_timeout`. What a real network does with a documentation address is not the engine's behaviour and is not something a case can rely on.

**The fault.** `POST /v1/harness/faults` with `{"point": "egress_connect_hang", "address": "<numeric address>"}`, harness mode only:
- **What it does.** While armed, every connection the egress proxy makes to that validated numeric address is held unconnected: no packet is sent (no SYN), or the socket is kept unconnected. `egress_connect_timeout` then ends it, exactly as it ends a connection that does not answer.
- **What stays unchanged.** Everything around the connect: one resolution per attempt, the address policy, `decision` `accepted`, `address` the validated address, and `ended` `connect_timeout` with `limit` `{"key": "egress_connect_timeout", "value": <seconds>}` (section 140). So are the role's view (no tunnel), `domain.egress_refused` where section 140 records it, and the run going on.
- **Lifetime.** It is standing: every attempt to that address while armed, any number of times, until `DELETE /v1/harness/faults` lifts it. Arming it again for another address adds that address.
- **Refusals.** An `address` that is not a numeric IPv4 or IPv6 address is **400** `invalid_value` (`subject.field` `address`).
- **Outside harness mode** there is no such fault and nothing in the proxy consults it.

The address stays a documentation-range one in the cases, so that even an engine ignoring the fault reaches no real host.

**Where it is armed.**
- **M128 (b):** for `DOC.b`, the connect-timeout target.
- **M127 (a) to (e):** for `DOC.a`, the address rebinding's first attempt connects to.
- **M127 (h):** for `DOC.c`, the approved `egress_allow_extra` name's address.

M127's cases did not assert how those connections end (only no tunnel, `accepted` and the address connected to). But their outcome depended on what the network answered, so each case now arms the fault for its own address and sends nothing. No other case of M127 or M128 connects to an address other than the engine's echo endpoint.


## 170. The launcher-exit tick

(Written 2026-10-05 on `verify/m2-tick` from `main` at `1677b76`; E79 item 2, decided by Sean; E77 item 1; objection 018. D2 §3.2, §3.4; sections 15, 125, 126, 128.)

**The rule.** When a launcher of this engine exits while its domain is quarantined or closing (`launch_state` `closed`, the domain not yet `terminated`), the engine requests a tick itself, as `POST /v1/projects/:p/tick` does (section 15), so that the re-observation of section 128 follows the exit without waiting for `tick_interval`. The tick is an ordinary one: it signals nothing, its prerequisites are section 128's, and it writes its `engine.tick` after the `domain.terminated` and clearance it writes. A case allows **30 s** from the launcher's exit, read on the host, to the run's end, and sends no tick in between (the sandbox lane's `tick_interval` is 600 s).

**The case** (`M115-every-unknown-quarantines.test.mjs`, "(e) the launcher-exit tick"): (e)'s fixture, the launcher paused at `launcher.before_placement`, the run quarantined by a Stop under `launcher_wait`; the launcher released and gone; no tick from the test; within 30 s the domain `terminated` and the quarantine cleared once, with (e)'s assertions (no `domain.launch_authorized`, no role, the invocation `refused` and uncharged, the work `held`). On `main` at `1677b76`, which has no such tick, it fails at the assertion naming this rule (`../COVERAGE.md`, "After E79 item 2").
