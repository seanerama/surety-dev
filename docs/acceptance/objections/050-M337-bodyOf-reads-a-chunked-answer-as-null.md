# 050: M337's `bodyOf` cannot read the fixture service's chunked answer, so "(b) answered by the service" and "(e) the first generation's start marker" read null

Row: M337
Test: packages/engine/test/acceptance/M337-the-operator-relay.test.mjs, cases "(b), (d), (h) opened: …" (assertion "(b) answered by the service") and "(e) a redeploy while open: …" (assertion "the first generation's start marker"); the file's helper `bodyOf`
Filed by: Builder, slice 28, 2026-10-11

## Claim

The fixture service answers with `res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))` (harness/deploy/fixture-service.cjs, lines 165 and 166), with no Content-Length. To an HTTP/1.1 request Node therefore answers `Transfer-Encoding: chunked`. The relay carries the bytes unchanged. On build/m4-s28, a copy of the case printed the exchange through the relay:

```
HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n…Connection: close\r\nTransfer-Encoding: chunked\r\n\r\na2\r\n{"ok":true,"mark":"97f60dee5c6f",…}\r\n0\r\n\r\n
```

The mark is the environment's. `bodyOf` parses everything after the header block as JSON, `a2\r\n{…}\r\n0\r\n\r\n`, which fails, so it returns null. The service did answer through the relay, and the store recorded the relay open on 127.0.0.1 and the configured port.

`bodyOf` should decode a chunked body: when the headers name `Transfer-Encoding: chunked`, join the chunks before parsing. Alternatively, the requests could be HTTP/1.0, which Node answers without chunking.

## Sources

- RFC 9112 §7.1 (chunked transfer coding): the message body of a chunked answer is a sequence of size-prefixed chunks, not the payload itself.
- The relay "does not inspect content" and carries the application's bytes unchanged (D4 §5.2), so the framing is the service's.
