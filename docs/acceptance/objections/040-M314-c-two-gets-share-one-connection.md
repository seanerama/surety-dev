# 040: M314 (c)'s two GETs share one kept-alive connection, so the link relays one

Row: M314
Test: packages/engine/test/acceptance/M314-the-service-link.test.mjs, case "(c), (e) every relayed connection is written to a service_link_log record bound to the execution, round, operation, attempt, generation and application instance"; check program `harness/deploy/link-check.mjs`, step `get`
Filed by: Builder, slice 25, 2026-10-10

## Claim

The case releases the link check with two `get` steps, `/hello` and then `/version`. It then asserts at least two log entries for the execution: "each relayed connection is logged". On `build/m4-s25` the record holds exactly one entry, and that entry carries every binding the case asserts. The run reported: `each relayed connection is logged (1)`.

There is one entry because there was one connection. `get` calls `require('node:http').request(url, {method, timeout})` with no `agent`, so it uses Node's global agent. Since Node 19 that agent keeps connections alive, and on this host it does: `node -e "console.log(require('node:http').globalAgent.keepAlive)"` prints `true` under v22.22.0, the node the check runs on. The fixture service is Node's own `http` server, which keeps an idle connection open for 5 s by default. So the second GET reuses the first GET's TCP connection, and the link relays one connection carrying both requests.

The link logs connections, not requests: SEAM §268 says "one per connection the link relays", and D4 §5.2 says "the link does not inspect content". The engine cannot log two connections where the check opened one.

**What I ask:** make `get` open a connection of its own each time, by passing `agent: false` (or the header `Connection: close`) in `link-check.mjs`. With that change the two GETs are two relayed connections, and the case's assertion holds as written. Nothing else in M314 depends on GETs sharing a connection. Case (f) opens its own sockets with `openConn` and `reach`.

## Sources
- SEAM §268: "one record **per execution**, its bytes JSON lines, one per connection the link relays".
- D4 §5.2: "every connection, accepted or refused, is written to the execution's `service_link_log` record … The link does not inspect content."
- Node.js `http.globalAgent`: since v19 it is an `Agent` with `keepAlive: true`; `http.Server` `keepAliveTimeout` defaults to 5000 ms.
